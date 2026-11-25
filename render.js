const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;
const CONCURRENCY = 3;

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

  console.log(`Fast Parallel Render (${CONCURRENCY}x) for ${sceneFiles.length} scenes (${totalDuration.toFixed(2)}s @ ${FPS} FPS):`, sceneFiles);

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

    // Lock JS requestAnimationFrame & performance.now to exact virtual frame time
    await page.evaluateOnNewDocument(() => {
      window.__virtualNow = 0;
      performance.now = () => window.__virtualNow;
      const rafQueue = [];
      window.requestAnimationFrame = (cb) => {
        rafQueue.push(cb);
        return rafQueue.length;
      };
      window.__stepFrame = (tMs, pct) => {
        window.__virtualNow = tMs;
        // 1. Step JS requestAnimationFrame callbacks
        const cbs = rafQueue.splice(0, rafQueue.length);
        for (const cb of cbs) {
          try { cb(tMs); } catch (e) {}
        }
        // 2. Lock all CSS / Web Animations to exact tMs
        document.getAnimations({ subtree: true }).forEach((anim) => {
          try {
            anim.pause();
            anim.currentTime = tMs;
          } catch (e) {}
        });
        // 3. Lock all SVG SMIL (<animate> / <animateTransform>) to exact seconds
        document.querySelectorAll('svg').forEach((svg) => {
          try {
            if (typeof svg.pauseAnimations === 'function') {
              svg.pauseAnimations();
              svg.setCurrentTime(tMs / 1000);
            }
          } catch (e) {}
        });
        // 4. Update top progress bar
        const bar = document.getElementById('__master_progress_bar__');
        if (bar) bar.style.width = pct + '%';
      };
    });

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
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-r', String(FPS),
      '-i', '-',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast',
      '-crf', '18',
      outPart
    ], { stdio: ['pipe', 'ignore', 'inherit'] });

    for (let f = 0; f < totalFrames; f++) {
      const sceneTimeMs = (f / FPS) * 1000;
      const pct = Math.min(100, ((elapsedBefore + f / FPS) / totalDuration) * 100);

      await page.evaluate((tMs, p) => window.__stepFrame(tMs, p), sceneTimeMs, pct);

      const frameBuffer = await page.screenshot({ type: 'jpeg', quality: 92 });
      if (!ffmpeg.stdin.write(frameBuffer)) {
        await new Promise((res) => ffmpeg.stdin.once('drain', res));
      }
    }

    ffmpeg.stdin.end();
    await new Promise((resolve, reject) => {
      ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg part ${i + 1} failed`))));
    });

    await page.close();
    console.log(`[${i + 1}/${sceneFiles.length}] Finished ${file}!`);
  };

  // Run 3 scenes in parallel at a time
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
  await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', 'concat_list.txt', '-c', 'copy', mergedVideo]);

  partFiles.forEach((f) => { if (fs.existsSync(f)) fs.unlinkSync(f); });
  if (fs.existsSync('concat_list.txt')) fs.unlinkSync('concat_list.txt');

  const audioFile = fs.readdirSync('.').find((f) => /^audio\.(mp3|wav|m4a|aac|ogg)$/i.test(f));
  if (audioFile) {
    console.log(`Merging ${audioFile}...`);
    await runFFmpeg([
      '-y',
      '-i', mergedVideo,
      '-i', audioFile,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      'final_video_with_audio.mp4'
    ]);
    fs.unlinkSync(mergedVideo);
  } else {
    fs.renameSync(mergedVideo, 'final_video_with_audio.mp4');
  }

  console.log('DONE! final_video_with_audio.mp4 is ready!');
})();
