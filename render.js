const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const path = require('path');

(async () => {
  const WIDTH = 1080;
  const HEIGHT = 1920;
  const FPS = 60;
  const DURATION_SEC = 43.7;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      `--window-size=${WIDTH},${HEIGHT}`
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });

  const fileUrl = 'file://' + path.resolve(__dirname, 'index.html');
  await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 60000 });

  // Start FFmpeg encoding piped PNG frames at 60fps
  const ffmpeg = spawn('ffmpeg', [
    '-y',
    '-f', 'image2pipe',
    '-vcodec', 'png',
    '-r', String(FPS),
    '-i', '-',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-r', String(FPS),
    'output.mp4'
  ], { stdio: ['pipe', 'inherit', 'inherit'] });

  const client = await page.target().createCDPSession();
  let latestFrameBuf = null;

  client.on('Page.screencastFrame', async ({ data, sessionId }) => {
    latestFrameBuf = Buffer.from(data, 'base64');
    try {
      await client.send('Page.screencastFrameAck', { sessionId });
    } catch (e) {}
  });

  await client.send('Page.startScreencast', {
    format: 'png',
    quality: 100,
    maxWidth: WIDTH,
    maxHeight: HEIGHT,
    everyNthFrame: 1
  });

  // Wait until first frame arrives so stream starts cleanly
  while (!latestFrameBuf) {
    await new Promise(r => setTimeout(r, 10));
  }

  const totalFrames = Math.ceil(DURATION_SEC * FPS);
  const frameIntervalMs = 1000 / FPS;
  const startTime = performance.now();

  for (let i = 0; i < totalFrames; i++) {
    const targetTime = startTime + i * frameIntervalMs;
    const now = performance.now();
    if (targetTime > now) {
      await new Promise(r => setTimeout(r, targetTime - now));
    }
    if (latestFrameBuf) {
      const ok = ffmpeg.stdin.write(latestFrameBuf);
      if (!ok) {
        await new Promise(r => ffmpeg.stdin.once('drain', r));
      }
    }
  }

  await client.send('Page.stopScreencast');
  ffmpeg.stdin.end();

  await new Promise((resolve, reject) => {
    ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error('FFmpeg exited ' + code)));
  });

  await browser.close();
  console.log('Successfully rendered output.mp4 (' + DURATION_SEC + 's @ 60fps)');
})();
