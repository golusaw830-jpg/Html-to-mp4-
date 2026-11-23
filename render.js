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

// Universal All-Rounder Mythology BGM (96 BPM steady temple pulse + Raag Bhupali harmonic bed)
function generateBuiltinBgm(mood, durationSec, outWav) {
  const dur = Math.ceil(durationSec + 2);
  execSync(
    `ffmpeg -y ` +
    `-f lavfi -i "sine=f=110.00:d=${dur}:r=44100" ` +
    `-f lavfi -i "sine=f=164.81:d=${dur}:r=44100" ` +
    `-f lavfi -i "sine=f=220.00:d=${dur}:r=44100" ` +
    `-f lavfi -i "sine=f=277.18:d=${dur}:r=44100" ` +
    `-f lavfi -i "sine=f=329.63:d=${dur}:r=44100" ` +
    `-filter_complex "` +
      `[0:a][1:a][2:a]amix=inputs=3:weights=0.50 0.30 0.20,lowpass=f=340[bed];` +
      `[3:a]tremolo=f=1.6:d=0.65,bandpass=f=280:width_type=h:w=180,volume=0.32[pulse1];` +
      `[4:a]tremolo=f=0.8:d=0.75,bandpass=f=330:width_type=h:w=160,volume=0.22[pulse2];` +
      `[bed][pulse1][pulse2]amix=inputs=3:weights=0.62 0.23 0.15,afade=t=in:st=0:d=1.2,afade=t=out:st=${Math.max(0, dur - 1.8)}:d=1.8` +
    `" "${outWav}"`,
    { stdio: 'ignore' }
  );
}

// Synthesize subtle, official-grade studio SFX using FFmpeg
function generateBuiltinSfx(type, outWav) {
  if (type === 'whoosh') {
    execSync(
      `ffmpeg -y -f lavfi -i "anoisesrc=d=0.45:c=pink:r=44100:a=0.35" ` +
      `-af "bandpass=f=750:width_type=h:w=600,afade=t=in:st=0:d=0.18,afade=t=out:st=0.22:d=0.23" "${outWav}"`,
      { stdio: 'ignore' }
    );
  } else if (type === 'boom') {
    execSync(
      `ffmpeg -y -f lavfi -i "sine=f=68:d=1.1:r=44100" ` +
      `-af "lowpass=f=140,afade=t=in:st=0:d=0.03,afade=t=out:st=0.15:d=0.95,volume=0.85" "${outWav}"`,
      { stdio: 'ignore' }
    );
  } else if (type === 'bell') {
    execSync(
      `ffmpeg -y -f lavfi -i "sine=f=880:d=1.6:r=44100" -f lavfi -i "sine=f=1320:d=1.6:r=44100" ` +
      `-filter_complex "[0:a][1:a]amix=inputs=2:weights=0.7 0.3,afade=t=in:st=0:d=0.02,afade=t=out:st=0.12:d=1.48,volume=0.45" "${outWav}"`,
      { stdio: 'ignore' }
    );
  } else {
    execSync(
      `ffmpeg -y -f lavfi -i "anoisesrc=d=1.4:c=brown:r=44100:a=0.45" ` +
      `-af "lowpass=f=160,afade=t=in:st=0:d=0.25,afade=t=out:st=0.5:d=0.9" "${outWav}"`,
      { stdio: 'ignore' }
    );
  }
}

(async () => {
  const WIDTH = 1080;
  const HEIGHT = 1920;
  const FPS = 60;
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

  const customBgmFile = fs
    .readdirSync(__dirname)
    .find((f) => /^bgm\.(mp3|wav|m4a|ogg|aac)$/i.test(f));

  let customDurations = null;
  if (fs.existsSync(path.join(__dirname, 'durations.json'))) {
    customDurations = JSON.parse(fs.readFileSync(path.join(__dirname, 'durations.json'), 'utf8'));
  }

  let captionsData = null;
  if (fs.existsSync(path.join(__dirname, 'captions.json'))) {
    captionsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'captions.json'), 'utf8'));
    console.log(`Loaded captions.json (${captionsData.length} segments).`);
  }

  let sfxList = null;
  let bgmMood = 'universal';
  if (fs.existsSync(path.join(__dirname, 'sfx.json'))) {
    const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, 'sfx.json'), 'utf8'));
    if (Array.isArray(parsed)) {
      sfxList = parsed;
    } else if (parsed && typeof parsed === 'object') {
      sfxList = parsed.cues || [];
      if (parsed.bgmMood) bgmMood = parsed.bgmMood;
    }
    console.log(`Loaded sfx.json (${sfxList.length} cues, mood: ${bgmMood}).`);
  }

  let totalAudioSec = null;
  if (fullAudioFile) {
    totalAudioSec = getAudioDuration(path.join(__dirname, fullAudioFile));
  }

  const N = sceneFiles.length;
  const sceneDurations = sceneFiles.map((_, i) => {
    if (Array.isArray(customDurations) && customDurations[i]) {
      return Number(customDurations[i]);
    }
    if (totalAudioSec) {
      const computed = (totalAudioSec + (N - 1) * TRANSITION_SEC) / N;
      return Math.max(1.5, Number(computed.toFixed(3)));
    }
    return DEFAULT_CLIP_SEC;
  });

  const sceneGlobalStarts = [];
  let timelineCursor = 0;
  for (let i = 0; i < N; i++) {
    sceneGlobalStarts.push(timelineCursor);
    timelineCursor += sceneDurations[i] - TRANSITION_SEC;
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', `--window-size=${WIDTH},${HEIGHT}`]
  });

  const clipOutputs = [];

  for (let idx = 0; idx < N; idx++) {
    const sceneFile = sceneFiles[idx];
    const clipSec = sceneDurations[idx];
    const sceneStartGlobal = sceneGlobalStarts[idx];
    const clipMp4 = `temp_clip_${idx + 1}.mp4`;
    console.log(`[${idx + 1}/${N}] Rendering ${sceneFile} (${clipSec}s, starts at ${sceneStartGlobal.toFixed(2)}s)...`);

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

        /* Style 2: Royal Temple Pill Box Overlay */
        #royal-caption-wrap {
          position: fixed;
          left: 50%;
          bottom: 330px;
          transform: translateX(-50%);
          z-index: 999999;
          display: none;
          flex-direction: column;
          align-items: center;
          width: 900px;
          pointer-events: none;
        }
        .temple-trim {
          width: 72%;
          height: 10px;
          border-top: 2.5px solid #ffd56b;
          border-bottom: 1.5px solid #c98a1e;
          background: repeating-linear-gradient(
            90deg,
            transparent 0px,
            transparent 6px,
            rgba(255, 213, 107, 0.75) 6px,
            rgba(255, 213, 107, 0.75) 10px
          );
          box-shadow: 0 0 12px rgba(255, 196, 54, 0.6);
        }
        .temple-pill {
          background: linear-gradient(180deg, rgba(44, 10, 12, 0.90) 0%, rgba(16, 4, 6, 0.94) 100%);
          border: 3px solid #e6b44c;
          border-radius: 999px;
          padding: 20px 46px;
          box-shadow: 0 14px 36px rgba(0, 0, 0, 0.85), inset 0 0 22px rgba(255, 166, 0, 0.22);
          text-align: center;
          font-family: 'Noto Sans Devanagari', 'Noto Serif Devanagari', sans-serif;
          font-size: 50px;
          font-weight: 800;
          line-height: 1.3;
          letter-spacing: 0.5px;
        }
        .cap-word {
          display: inline-block;
          margin: 0 8px;
          color: #fff6e0;
          text-shadow: 0 3px 8px rgba(0, 0, 0, 0.95);
        }
        .cap-word.active {
          color: #ffcc33;
          transform: scale(1.12);
          text-shadow: 0 0 18px rgba(255, 153, 0, 0.95), 0 0 34px rgba(255, 85, 0, 0.75), 0 3px 6px #000;
        }
      `
    });

    if (captionsData) {
      await page.evaluate((caps) => {
        window.__CAPTIONS = caps;
        const wrap = document.createElement('div');
        wrap.id = 'royal-caption-wrap';
        wrap.innerHTML = `
          <div class="temple-trim"></div>
          <div class="temple-pill" id="royal-caption-text"></div>
          <div class="temple-trim"></div>
        `;
        document.body.appendChild(wrap);

        window.__updateCaption = function (globalSec) {
          const seg = window.__CAPTIONS.find((c) => globalSec >= c.start && globalSec <= c.end);
          if (!seg) {
            wrap.style.display = 'none';
            return;
          }
          wrap.style.display = 'flex';
          const words = seg.text.trim().split(/\s+/);
          const progress = Math.min(0.999, Math.max(0, (globalSec - seg.start) / Math.max(0.1, seg.end - seg.start)));
          const activeIdx = Math.floor(progress * words.length);
          const box = document.getElementById('royal-caption-text');
          box.innerHTML = words
            .map((w, i) => `<span class="cap-word${i === activeIdx ? ' active' : ''}">${w}</span>`)
            .join('');
        };
      }, captionsData);
    }

    const ffmpeg = spawn('ffmpeg', [
      '-y', '-f', 'image2pipe', '-vcodec', 'png', '-r', String(FPS), '-i', '-',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), clipMp4
    ], { stdio: ['pipe', 'inherit', 'inherit'] });

    const totalFrames = Math.round(clipSec * FPS);
    const simStepMs = (DEFAULT_CLIP_SEC * 1000) / totalFrames;

    for (let f = 0; f < totalFrames; f++) {
      const localSec = f / FPS;
      const globalSec = sceneStartGlobal + localSec;
      await page.evaluate((ms, gSec, hasCaps) => {
        window.__advanceClock(ms);
        if (hasCaps && window.__updateCaption) window.__updateCaption(gSec);
      }, f === 0 ? 0 : simStepMs, globalSec, Boolean(captionsData));

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
    let currentTimeline = sceneDurations[0];

    for (let i = 1; i < clipOutputs.length; i++) {
      const outLabel = i === clipOutputs.length - 1 ? '[vout]' : `[v${i}]`;
      const offset = Math.max(0, currentTimeline - TRANSITION_SEC).toFixed(3);
      const tType = transitionTypes[(i - 1) % transitionTypes.length];
      filters.push(`${prevLabel}[${i}:v]xfade=transition=${tType}:duration=${TRANSITION_SEC}:offset=${offset}${outLabel}`);
      prevLabel = outLabel;
      currentTimeline = Number(offset) + sceneDurations[i];
    }

    await runFFmpeg([
      '-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[vout]',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), mergedVideo
    ]);

    clipOutputs.forEach((c) => { if (fs.existsSync(c)) fs.unlinkSync(c); });
  }

  // Mix Voiceover + Balanced SFX + Auto-Ducked Universal Mythology BGM
  if (fullAudioFile) {
    const tempFilesToClean = [];
    let activeBgmPath = customBgmFile || null;

    if (!activeBgmPath && bgmMood !== 'none') {
      activeBgmPath = 'temp_builtin_bgm.wav';
      generateBuiltinBgm(bgmMood, totalAudioSec || 60, activeBgmPath);
      tempFilesToClean.push(activeBgmPath);
    }

    const hasSfx = Array.isArray(sfxList) && sfxList.length > 0;
    const audioInputs = ['-i', fullAudioFile];
    const filterChains = ['[0:a]aresample=44100,aformat=channel_layouts=stereo,volume=1.0[vo]'];
    const mixLabels = ['[vo]'];
    let nextIdx = 1;

    if (activeBgmPath) {
      if (customBgmFile) {
        audioInputs.push('-stream_loop', '-1', '-i', activeBgmPath);
      } else {
        audioInputs.push('-i', activeBgmPath);
      }
      filterChains.push(
        `[${nextIdx}:a]aresample=44100,aformat=channel_layouts=stereo,volume=0.22[bgm_raw];` +
        `[bgm_raw][vo]sidechaincompress=threshold=0.03:ratio=6:attack=40:release=350[bgm]`
      );
      mixLabels.push('[bgm]');
      nextIdx++;
    }

    if (hasSfx) {
      const generatedCache = {};
      for (let i = 0; i < sfxList.length; i++) {
        const cue = sfxList[i];
        const type = cue.type || 'whoosh';
        const customPath = path.join(__dirname, 'sfx', `${type}.mp3`);
        let sfxPath = null;

        if (fs.existsSync(customPath)) {
          sfxPath = customPath;
        } else {
          if (!generatedCache[type]) {
            const wavPath = `temp_sfx_${type}.wav`;
            generateBuiltinSfx(type, wavPath);
            generatedCache[type] = wavPath;
            tempFilesToClean.push(wavPath);
          }
          sfxPath = generatedCache[type];
        }

        audioInputs.push('-i', sfxPath);
        const delayMs = Math.max(0, Math.round((Number(cue.time) || 0) * 1000));
        const vol = Math.min(0.45, Math.max(0.10, Number(cue.volume) || 0.28));
        const lbl = `[sfx${i}]`;
        filterChains.push(
          `[${nextIdx}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${vol},adelay=${delayMs}|${delayMs}${lbl}`
        );
        mixLabels.push(lbl);
        nextIdx++;
      }
    }

    filterChains.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:normalize=0[aout]`);
    const finalAudioTrack = 'temp_mixed_master_audio.wav';
    tempFilesToClean.push(finalAudioTrack);

    await runFFmpeg([
      '-y',
      ...audioInputs,
      '-filter_complex', filterChains.join(';'),
      '-map', '[aout]',
      '-c:a', 'pcm_s16le',
      finalAudioTrack
    ]);

    await runFFmpeg([
      '-y', '-i', mergedVideo, '-i', finalAudioTrack,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', 'final_video_with_audio.mp4'
    ]);

    fs.unlinkSync(mergedVideo);
    tempFilesToClean.forEach((f) => { if (fs.existsSync(f)) fs.unlinkSync(f); });
  } else {
    fs.renameSync(mergedVideo, 'final_video_with_audio.mp4');
  }

  console.log('DONE! final_video_with_audio.mp4 is ready!');
})();
e';
            return;
          }
          wrap.style.display = 'flex';
          const words = seg.text.trim().split(/\s+/);
          const progress = Math.min(0.999, Math.max(0, (globalSec - seg.start) / Math.max(0.1, seg.end - seg.start)));
          const activeIdx = Math.floor(progress * words.length);
          const box = document.getElementById('royal-caption-text');
          box.innerHTML = words
            .map((w, i) => `<span class="cap-word${i === activeIdx ? ' active' : ''}">${w}</span>`)
            .join('');
        };
      }, captionsData);
    }

    const ffmpeg = spawn('ffmpeg', [
      '-y', '-f', 'image2pipe', '-vcodec', 'png', '-r', String(FPS), '-i', '-',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), clipMp4
    ], { stdio: ['pipe', 'inherit', 'inherit'] });

    const totalFrames = Math.round(clipSec * FPS);
    const simStepMs = (DEFAULT_CLIP_SEC * 1000) / totalFrames;

    for (let f = 0; f < totalFrames; f++) {
      const localSec = f / FPS;
      const globalSec = sceneStartGlobal + localSec;
      await page.evaluate((ms, gSec, hasCaps) => {
        window.__advanceClock(ms);
        if (hasCaps && window.__updateCaption) window.__updateCaption(gSec);
      }, f === 0 ? 0 : simStepMs, globalSec, Boolean(captionsData));

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
    let currentTimeline = sceneDurations[0];

    for (let i = 1; i < clipOutputs.length; i++) {
      const outLabel = i === clipOutputs.length - 1 ? '[vout]' : `[v${i}]`;
      const offset = Math.max(0, currentTimeline - TRANSITION_SEC).toFixed(3);
      const tType = transitionTypes[(i - 1) % transitionTypes.length];
      filters.push(`${prevLabel}[${i}:v]xfade=transition=${tType}:duration=${TRANSITION_SEC}:offset=${offset}${outLabel}`);
      prevLabel = outLabel;
      currentTimeline = Number(offset) + sceneDurations[i];
    }

    await runFFmpeg([
      '-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[vout]',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), mergedVideo
    ]);

    clipOutputs.forEach((c) => { if (fs.existsSync(c)) fs.unlinkSync(c); });
  }

  // Mix Voiceover + Balanced SFX + Optional Auto-Ducked BGM
  if (fullAudioFile) {
    let finalAudioTrack = fullAudioFile;
    const tempFilesToClean = [];

    const hasSfx = Array.isArray(sfxList) && sfxList.length > 0;
    if (hasSfx || bgmFile) {
      console.log('Mixing balanced studio audio (Voiceover + SFX/BGM)...');
      const audioInputs = ['-i', fullAudioFile];
      const filterChains = ['[0:a]aresample=44100,aformat=channel_layouts=stereo,volume=1.0[vo]'];
      const mixLabels = ['[vo]'];
      let nextIdx = 1;

      if (bgmFile) {
        audioInputs.push('-stream_loop', '-1', '-i', bgmFile);
        // Subtle 22% bed that automatically ducks to ~10% whenever voiceover speaks
        filterChains.push(
          `[${nextIdx}:a]aresample=44100,aformat=channel_layouts=stereo,volume=0.22[bgm_raw];` +
          `[bgm_raw][vo]sidechaincompress=threshold=0.03:ratio=6:attack=40:release=350[bgm]`
        );
        mixLabels.push('[bgm]');
        nextIdx++;
      }

      if (hasSfx) {
        const generatedCache = {};
        for (let i = 0; i < sfxList.length; i++) {
          const cue = sfxList[i];
          const type = cue.type || 'whoosh';
          const customPath = path.join(__dirname, 'sfx', `${type}.mp3`);
          let sfxPath = null;

          if (fs.existsSync(customPath)) {
            sfxPath = customPath;
          } else {
            if (!generatedCache[type]) {
              const wavPath = `temp_sfx_${type}.wav`;
              generateBuiltinSfx(type, wavPath);
              generatedCache[type] = wavPath;
              tempFilesToClean.push(wavPath);
            }
            sfxPath = generatedCache[type];
          }

          audioInputs.push('-i', sfxPath);
          const delayMs = Math.max(0, Math.round((Number(cue.time) || 0) * 1000));
          // Keep SFX subtly balanced (default 0.28, capped at 0.45 so voiceover stays crisp)
          const vol = Math.min(0.45, Math.max(0.10, Number(cue.volume) || 0.28));
          const lbl = `[sfx${i}]`;
          filterChains.push(
            `[${nextIdx}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${vol},adelay=${delayMs}|${delayMs}${lbl}`
          );
          mixLabels.push(lbl);
          nextIdx++;
        }
      }

      filterChains.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:normalize=0[aout]`);
      finalAudioTrack = 'temp_mixed_master_audio.wav';
      tempFilesToClean.push(finalAudioTrack);

      await runFFmpeg([
        '-y',
        ...audioInputs,
        '-filter_complex', filterChains.join(';'),
        '-map', '[aout]',
        '-c:a', 'pcm_s16le',
        finalAudioTrack
      ]);
    }

    await runFFmpeg([
      '-y', '-i', mergedVideo, '-i', finalAudioTrack,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', 'final_video_with_audio.mp4'
    ]);

    fs.unlinkSync(mergedVideo);
    tempFilesToClean.forEach((f) => { if (fs.existsSync(f)) fs.unlinkSync(f); });
  } else {
    fs.renameSync(mergedVideo, 'final_video_with_audio.mp4');
  }

  console.log('DONE! final_video_with_audio.mp4 is ready!');
})();
