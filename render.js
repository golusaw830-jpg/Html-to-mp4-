const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const FPS = 30;
const FRAME_MS = 1000 / FPS;
const WIDTH = 1080;
const HEIGHT = 1920;
const CONCURRENCY = 2;

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: 'inherit' });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}`));
    });
  });
}

(async () => {
  const sceneFiles = fs
    .readdirSync('.')
    .filter((f) => /^scene\d+\.html$/i.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));

  if (sceneFiles.length === 0) throw new Error('No scene*.html files found!');

  const durations = fs.existsSync('durations.json')
    ? JSON.parse(fs.readFileSync('durations.json', 'utf8'))
    : [];

  const sceneDurations = sceneFiles.map((_, idx) => Number(durations[idx]) || 4.5);
  const totalDuration = sceneDurations.reduce((a, b) => a + b, 0);

  const startTimes = [];
  let acc = 0;
  for (const d of sceneDurations) {
    startTimes.push(acc);
    acc += d;
  }

  console.log(`Rendering ${sceneFiles.length} scenes with True Virtual Time (${totalDuration.toFixed(2)}s @ ${FPS} FPS):`, sceneFiles);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const renderScene = async (i) => {
    const file = sceneFiles[i];
    const dur = sceneDurations[i];
    const totalFrames = Math.round(dur * FPS);
    const elapsedBefore = startTimes[i];
    const outPart = `part_${i + 1}.mp4`;

    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
    const client = await page.createCDPSession();

    console.log(`[${i + 1}/${sceneFiles.length}] Starting ${file} (${dur}s, ${totalFrames} frames)...`);
    await page.goto('file://' + path.resolve(file), { waitUntil: 'domcontentloaded', timeout: 60000 });

    await page.evaluate(() => {
      const barWrap = document.createElement('div');
      barWrap.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:10px;background:rgba(255,255,255,0.15);z-index:999999;';
      const barFill = document.createElement('div');
      barFill.id = '__master_progress_bar__';
      barFill.style.cssText = 'height:100%;width:0%;background:linear-gradient(90deg,#f59e0b,#ffcf5c);';
      barWrap.appendChild(barFill);
      document.body.appendChild(barWrap);
    });

    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-loglevel', 'error',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-r', String(FPS),
      '-i', '-',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'fast',
      '-crf', '23',
      outPart
    ], { stdio: ['pipe', 'ignore', 'inherit'] });

    ffmpeg.stdin.on('error', () => {});

    const advanceVirtualTime = (ms) => new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        client.off('Emulation.virtualTimeBudgetExpired', finish);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 2000);
      client.on('Emulation.virtualTimeBudgetExpired', finish);
      client.send('Emulation.setVirtualTimePolicy', {
        policy: 'advance',
        budget: ms
      }).catch(finish);
    });

    // Freeze browser clock immediately at start of scene
    await advanceVirtualTime(1);

    for (let f = 0; f < totalFrames; f++) {
      const pct = Math.min(100, ((elapsedBefore + f / FPS) / totalDuration) * 100);

      await page.evaluate((p) => {
        const bar = document.getElementById('__master_progress_bar__');
        if (bar) bar.style.width = p + '%';
      }, pct);

      const { data } = await client.send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
      const frameBuffer = Buffer.from(data, 'base64');
      if (!ffmpeg.stdin.write(frameBuffer)) {
        await new Promise((res) => ffmpeg.stdin.once('drain', res));
      }

      // Advance CSS + SVG + JS timers by exact 1 frame (33.33ms) and pause again
      await advanceVirtualTime(FRAME_MS);
    }

    ffmpeg.stdin.end();
    await new Promise((resolve, reject) => {
      ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg part ${i + 1} failed (code ${code})`))));
    });

    await client.detach();
    await page.close();
    console.log(`[${i + 1}/${sceneFiles.length}] Finished ${file}!`);
  };

  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, sceneFiles.length) }, async () => {
    while (nextIdx < sceneFiles.length) {
      const idx = nextIdx++;
      await renderScene(idx);
    }
  });
  await Promise.all(workers);
  await browser.close();

  const partFiles = sceneFiles.map((_, idx) => `part_${idx + 1}.mp4`);
  fs.writeFileSync('concat_list.txt', partFiles.map((f) => `file '${f}'`).join('\n'));

  const mergedVideo = 'merged_silent.mp4';
  await runFFmpeg(['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'concat_list.txt', '-c', 'copy', mergedVideo]);

  partFiles.forEach((f) => { if (fs.existsSync(f)) fs.unlinkSync(f); });
  if (fs.existsSync('concat_list.txt')) fs.unlinkSync('concat_list.txt');

  const audioFile = fs.readdirSync('.').find((f) => /^audio\.(mp3|wav|m4a|aac|ogg)$/i.test(f));
  if (audioFile) {
    console.log(`Merging ${audioFile}...`);
    await runFFmpeg([
      '-y',
      '-loglevel', 'error',
      '-i', mergedVideo,
      '-i', audioFile,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-shortest',
      'final_video_with_audio.mp4'
    ]);
    fs.unlinkSync(mergedVideo);
  } else {
    fs.renameSync(mergedVideo, 'final_video_with_audio.mp4');
  }

  console.log('DONE! final_video_with_audio.mp4 is ready!');
})();
