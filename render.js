const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

(async () => {
  const WIDTH = 1080;
  const HEIGHT = 1920;
  const FPS = 30;
  const DURATION_SECONDS = 5; // Video ki length (seconds mein)

  const totalFrames = FPS * DURATION_SECONDS;
  const framesDir = path.join(__dirname, 'frames');
  if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT });

  const filePath = `file://${path.join(__dirname, 'index.html')}`;
  await page.goto(filePath, { waitUntil: 'networkidle0' });

  console.log(`Rendering ${totalFrames} frames...`);

  for (let i = 0; i < totalFrames; i++) {
    const framePath = path.join(framesDir, `frame_${String(i).padStart(4, '0')}.png`);
    await page.screenshot({ path: framePath });
    await new Promise(r => setTimeout(r, 1000 / FPS));
  }

  await browser.close();

  console.log('Combining frames into MP4...');
  execSync(
    `ffmpeg -y -framerate ${FPS} -i ${framesDir}/frame_%04d.png -c:v libx264 -pix_fmt yuv420p output.mp4`
  );

  console.log('Done! output.mp4 created.');
})();
 
