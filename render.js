const puppeteer = require('puppeteer');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error('FFmpeg exited with code ' + code))));
    ff.on('error', reject);
  });
}

function getAudioDuration(audioPath) {
  const out = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
  ).toString().trim();
  return parseFloat(out);
}

(async () => {
  const WIDTH = 1080;
  const HEIGHT = 1920;
  const FPS = 30;
  const DEFAULT_CLIP_SEC = 5.0;
  const TRANSITION_SEC = 0.5;

  const sceneFiles = fs
    .readdirSync(__dirname)
    .filter((f) => /^scene\d+\.html$/i.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));

  if (sceneFiles.length === 0) {
    throw new Error('Koi bhi scene1.html, scene2.html... file nahi mili!');
  }

  const fullAudioFile = fs
    .readdirSync(__dirname)
    .find((f) => /^audio\.(mp3|wav|m4a|ogg|aac)$/i.test(f));

  let customDurations = null;
  if (fs.existsSync(path.join(__dirname, 'durations.json'))) {
    customDurations = JSON.parse(fs.readFileSync(path.join(__dirname, 'durations.json'), 'utf8'));
  }

  let totalAudioSec = null;
  if (fullAudioFile) {
    totalAudioSec = getAudioDuration(path.join(__dirname, fullAudioFile));
  }

  const N = sceneFiles.length;

  // sceneDurations = har scene ka AUDIO-timeline par time (overlap ke bina)
  const sceneDurations = sceneFiles.map((_, i) => {
    if (Array.isArray(customDurations) && customDurations[i]) {
      return Number(customDurations[i]);
    }
    if (totalAudioSec) {
      return Math.max(1.5, Number((totalAudioSec / N).toFixed(3)));
    }
    return DEFAULT_CLIP_SEC;
  });

  // Agar audio durations ke sum se lambi hai, to bacha hua time last scene ko do
  // (warna -shortest ya kam video se audio ka end kat jaata hai)
  if (totalAudioSec) {
    const sumExceptLast = sceneDurations.slice(0, -1).reduce((a, b) => a + b, 0);
    sceneDurations[N - 1] = Math.max(sceneDurations[N - 1], Number((totalAudioSec - sumExceptLast).toFixed(3)));
  }

  // Render length: har scene (last ko chhodkar) ke upar TRANSITION_SEC extra,
  // kyunki xfade me ye hissa agle scene ke saath overlap hota hai.
  // Isse scene i theek wahi shuru hota hai jahan audio me uska hissa shuru hota hai.
  const renderDurations = sceneDurations.map((d, i) => (i < N - 1 ? d + TRANSITION_SEC : d));

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', `--window-size=${WIDTH},${HEIGHT}`]
  });

  const clipOutputs = [];

  for (let idx = 0; idx < N; idx++) {
    const sceneFile = sceneFiles[idx];
    const clipSec = renderDurations[idx];
    const clipMp4 = `temp_clip_${idx + 1}.mp4`;
    console.log(`[${idx + 1}/${N}] Rendering ${sceneFile} (${clipSec}s)...`);

    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });

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

    await page.addStyleTag({
      content: `
        .controls-bar, .status-toast { display: none !important; }
        html, body { width: 1080px !important; height: 1920px !important; margin: 0 !important; padding: 0 !important; overflow: hidden !important; background: #000 !important; }
        .stage-wrapper { width: 1080px !important; height: 1920px !important; max-width: none !important; max-height: none !important; border-radius: 0 !important; box-shadow: none !important; }
      `
    });

    const ffmpeg = spawn('ffmpeg', [
      '-y', '-f', 'image2pipe', '-vcodec', 'png', '-r', String(FPS), '-i', '-',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), clipMp4
    ], { stdio: ['pipe', 'inherit', 'inherit'] });

    const totalFrames = Math.round(clipSec * FPS);
    const simStepMs = (DEFAULT_CLIP_SEC * 1000) / totalFrames;

    for (let f = 0; f < totalFrames; f++) {
      await page.evaluate((ms) => window.__advanceClock(ms), f === 0 ? 0 : simStepMs);
      const buf = await page.screenshot({ type: 'png' });
      const ok = ffmpeg.stdin.write(buf);
      if (!ok) await new Promise((r) => ffmpeg.stdin.once('drain', r));
    }

    ffmpeg.stdin.end();
    await new Promise((resolve, reject) => {
      ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Clip FFmpeg exited ' + code))));
    });
    await page.close();
    clipOutputs.push(clipMp4);
  }

  await browser.close();

  const mergedVideo = 'temp_merged_video.mp4';
  if (clipOutputs.length === 1) {
    fs.renameSync(clipOutputs[0], mergedVideo);
  } else {
    const inputs = [];
    clipOutputs.forEach((c) => inputs.push('-i', c));

    const transitionTypes = ['fade', 'wipeup', 'circleopen', 'fadeblack'];
    const filters = [];
    let prevLabel = '[0:v]';
    let boundary = 0; // audio-timeline par agle scene ki starting

    for (let i = 1; i < clipOutputs.length; i++) {
      const outLabel = i === clipOutputs.length - 1 ? '[vout]' : `[v${i}]`;
      boundary += sceneDurations[i - 1];
      const offset = boundary.toFixed(3);
      const tType = transitionTypes[(i - 1) % transitionTypes.length];
      filters.push(`${prevLabel}[${i}:v]xfade=transition=${tType}:duration=${TRANSITION_SEC}:offset=${offset}${outLabel}`);
      prevLabel = outLabel;
    }

    await runFFmpeg([
      '-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[vout]',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), mergedVideo
    ]);

    clipOutputs.forEach((c) => { if (fs.existsSync(c)) fs.unlinkSync(c); });
  }

  if (fullAudioFile) {
    await runFFmpeg([
      '-y', '-i', mergedVideo, '-i', fullAudioFile,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', 'final_video_with_audio.mp4'
    ]);
    fs.unlinkSync(mergedVideo);
  } else {
    fs.renameSync(mergedVideo, 'final_video_with_audio.mp4');
  }

  console.log('DONE! final_video_with_audio.mp4 is ready!');
})();
