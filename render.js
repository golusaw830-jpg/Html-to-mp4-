const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

(async () => {
  const WIDTH = 1080;
  const HEIGHT = 1920;
  const FPS = 60;
  const DURATION_SECONDS = 5;

  const totalFrames = Math.round(FPS * DURATION_SECONDS);
  const framesDir = path.join(__dirname, 'frames');
  if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });

  const filePath = `file://${path.join(__dirname, 'index.html')}`;
  await page.goto(filePath, { waitUntil: 'load' });

  for (let i = 0; i < totalFrames; i++) {
    const currentTime = i / FPS;
    await page.evaluate((t) => window.renderAtTime(t), currentTime);
    const framePath = path.join(framesDir, `frame_${String(i).padStart(4, '0')}.png`);
    await page.screenshot({ path: framePath });
  }

  await browser.close();

  execSync(
    `ffmpeg -y -framerate ${FPS} -i ${framesDir}/frame_%04d.png -c:v libx264 -pix_fmt yuv420p -crf 18 output.mp4`
  );
})();
