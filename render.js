const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error('FFmpeg exited with code ' + code))));
    ff.on('error', reject);
  });
}

(async () => {
  const WIDTH = 1080;
  const HEIGHT = 1920;
  const FPS = 60;
  const CLIP_DURATION_SEC = 5.0;
  const TRANSITION_SEC = 0.7;

  // 1. Auto-detect scene1.html, scene2.html, ... in numeric order
  const sceneFiles = fs
    .readdirSync(__dirname)
    .filter((f) => /^scene\d+\.html$/i.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)[0], 10);
      const numB = parseInt(b.match(/\d+/)[0], 10);
      return numA - numB;
    });

  if (sceneFiles.length === 0) {
    throw new Error('Koi bhi scene1.html, scene2.html... file nahi mili!');
  }

  console.log(`Total ${sceneFiles.length} scenes mile:`, sceneFiles.join(', '));

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      `--window-size=${WIDTH},${HEIGHT}`
    ]
  });

  const clipOutputs = [];

  // 2. Render each scene HTML independently into a clean 5.0s 60fps MP4
  for (let idx = 0; idx < sceneFiles.length; idx++) {
    const sceneFile = sceneFiles[idx];
    const clipMp4 = `temp_clip_${idx + 1}.mp4`;
    console.log(`[${idx + 1}/${sceneFiles.length}] Rendering ${sceneFile} -> ${clipMp4}...`);

    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });

    // Install deterministic virtual clock BEFORE loading the scene
    await page.evaluateOnNewDocument(() => {
      let virtualNow = 0;
      let nextTimerId = 1;
      const timers = new Map();
      const rafCallbacks = new Map();

      window.__advanceClock = function (ms) {
        const target = virtualNow + ms;
        while (true) {
          let earliest = null;
          for (const [id, t] of timers.entries()) {
            if (t.time <= target && (!earliest || t.time < earliest.time)) {
              earliest = { id, ...t };
            }
          }
          if (!earliest) break;
          virtualNow = earliest.time;
          if (earliest.interval) {
            timers.set(earliest.id, { ...earliest, time: virtualNow + earliest.interval });
          } else {
            timers.delete(earliest.id);
          }
          try { earliest.fn(); } catch (e) {}
        }
        virtualNow = target;

        const currentRafs = Array.from(rafCallbacks.entries());
        rafCallbacks.clear();
        for (const [, cb] of currentRafs) {
          try { cb(virtualNow); } catch (e) {}
        }
      };

      performance.now = () => virtualNow;
      Date.now = () => 1700000000000 + virtualNow;

      window.setTimeout = (fn, delay = 0, ...args) => {
        const id = nextTimerId++;
        timers.set(id, {
          fn: typeof fn === 'function' ? () => fn(...args) : () => eval(fn),
          time: virtualNow + Math.max(0, Number(delay) || 0),
          interval: null
        });
        return id;
      };
      window.clearTimeout = (id) => timers.delete(id);

      window.setInterval = (fn, delay = 0, ...args) => {
        const id = nextTimerId++;
        const step = Math.max(1, Number(delay) || 1);
        timers.set(id, {
          fn: typeof fn === 'function' ? () => fn(...args) : () => eval(fn),
          time: virtualNow + step,
          interval: step
        });
        return id;
      };
      window.clearInterval = (id) => timers.delete(id);

      window.requestAnimationFrame = (cb) => {
        const id = nextTimerId++;
        rafCallbacks.set(id, cb);
        return id;
      };
      window.cancelAnimationFrame = (id) => rafCallbacks.delete(id);
    });

    const fileUrl = 'file://' + path.resolve(__dirname, sceneFile);
    await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 60000 });

    // Hide Replay/Download UI buttons & ensure full 1080x1920 stage fit
    await page.addStyleTag({
      content: `
        .controls-bar, .status-toast { display: none !important; }
        html, body { width: 1080px !important; height: 1920px !important; margin: 0 !important; padding: 0 !important; overflow: hidden !important; background: #000 !important; }
        .stage-wrapper { width: 1080px !important; height: 1920px !important; max-width: none !important; max-height: none !important; border-radius: 0 !important; box-shadow: none !important; }
      `
    });

    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-f', 'image2pipe',
      '-vcodec', 'png',
      '-r', String(FPS),
      '-i', '-',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-r', String(FPS),
      clipMp4
    ], { stdio: ['pipe', 'inherit', 'inherit'] });

    const totalFrames = Math.round(CLIP_DURATION_SEC * FPS);
    const dtMs = 1000 / FPS;

    for (let f = 0; f < totalFrames; f++) {
      await page.evaluate((ms) => window.__advanceClock(ms), f === 0 ? 0 : dtMs);
      const buf = await page.screenshot({ type: 'png' });
      const ok = ffmpeg.stdin.write(buf);
      if (!ok) {
        await new Promise((r) => ffmpeg.stdin.once('drain', r));
      }
    }

    ffmpeg.stdin.end();
    await new Promise((resolve, reject) => {
      ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Clip FFmpeg exited ' + code))));
    });

    await page.close();
    clipOutputs.push(clipMp4);
  }

  await browser.close();

  // 3. Merge all clips into one final output.mp4 with smooth 0.7s transitions
  console.log('Merging all clips into output.mp4...');
  if (clipOutputs.length === 1) {
    fs.renameSync(clipOutputs[0], 'output.mp4');
  } else {
    const inputs = [];
    clipOutputs.forEach((c) => inputs.push('-i', c));

    const transitionTypes = ['fade', 'wipeup', 'circleopen', 'fadeblack'];
    const step = CLIP_DURATION_SEC - TRANSITION_SEC; // 4.3s
    const filters = [];
    let prevLabel = '[0:v]';

    for (let i = 1; i < clipOutputs.length; i++) {
      const outLabel = i === clipOutputs.length - 1 ? '[vout]' : `[v${i}]`;
      const offset = (i * step).toFixed(3);
      const tType = transitionTypes[(i - 1) % transitionTypes.length];
      filters.push(`${prevLabel}[${i}:v]xfade=transition=${tType}:duration=${TRANSITION_SEC}:offset=${offset}${outLabel}`);
      prevLabel = outLabel;
    }

    await runFFmpeg([
      '-y',
      ...inputs,
      '-filter_complex', filters.join(';'),
      '-map', '[vout]',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-r', String(FPS),
      'output.mp4'
    ]);

    // Clean up temporary individual clip files
    clipOutputs.forEach((c) => {
      if (fs.existsSync(c)) fs.unlinkSync(c);
    });
  }

  console.log('Successfully created final merged output.mp4!');
})();
