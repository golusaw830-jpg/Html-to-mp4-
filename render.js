const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;

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

  if (sceneFiles.length === 0) {
    throw new Error('No scene*.html files found!');
  }

  let durations = [];
  if (fs.existsSync('durations.json')) {
    durations = JSON.parse(fs.readFileSync('durations.json', 'utf8'));
  }

  const sceneDurations = sceneFiles.map((_, idx) => Number(durations[idx]) || 4.5);
  const totalDuration = sceneDurations.reduce((a, b) => a + b, 0);
  console.log('Scenes order:', sceneFiles);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });

  const partFiles = [];
  let elapsedBeforeScene = 0;

  for (let i = 0; i < sceneFiles.length; i++) {
    const file = sceneFiles[i];
    const dur = sceneDurations[i];
    const totalFrames = Math.round(dur * FPS);
    const outPart = `part_${i + 1}.mp4`;
    partFiles.push(outPart);

    console.log(`[${i + 1}/${sceneFiles.length}] Rendering ${file} (${dur}s)...`);

    const fileUrl = 'file://' + path.resolve(file);
    await page.goto(fileUrl, { waitUntil: 'networkidle0' });

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
      '-vcodec', 'png',
      '-r', String(FPS),
      '-i', '-',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'fast',
      '-crf', '18',
      outPart
    ], { stdio: ['pipe', 'ignore', 'inherit'] });

    for (let f = 0; f < totalFrames; f++) {
      const globalTime = elapsedBeforeScene + f / FPS;
      const pct = Math.min(100, (globalTime / totalDuration) * 100);

      await page.evaluate((p) => {
        const bar = document.getElementById('__master_progress_bar__');
        if (bar) bar.style.width = p + '%';
      }, pct);

      const frameBuffer = await page.screenshot({ type: 'png' });
      if (!ffmpeg.stdin.write(frameBuffer)) {
        await new Promise((res) => ffmpeg.stdin.once('drain', res));
      }
    }

    ffmpeg.stdin.end();
    await new Promise((resolve, reject) => {
      ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg part ${i + 1} failed`))));
    });

    elapsedBeforeScene += dur;
  }

  await browser.close();

  const concatList = partFiles.map((f) => `file '${f}'`).join('\n');
  fs.writeFileSync('concat_list.txt', concatList);

  const mergedVideo = 'merged_silent.mp4';
  await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', 'concat_list.txt', '-c', 'copy', mergedVideo]);

  partFiles.forEach((f) => { if (fs.existsSync(f)) fs.unlinkSync(f); });
  if (fs.existsSync('concat_list.txt')) fs.unlinkSync('concat_list.txt');

  const audioFile = fs
    .readdirSync('.')
    .find((f) => /^audio\.(mp3|wav|m4a|aac|ogg)$/i.test(f));

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
                     
