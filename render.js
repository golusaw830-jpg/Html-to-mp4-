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
      `--window-size=${WIDTH},${HEIGHT}`
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });

  // Inject virtual clock into main page AND every dynamically created iframe
  await page.evaluateOnNewDocument(() => {
    function installVirtualClock(win) {
      if (!win || win.__vcInstalled) return;
      win.__vcInstalled = true;

      let virtualNow = 0;
      let nextTimerId = 1;
      const timers = new Map();
      const rafCallbacks = new Map();

      win.__advanceClock = function (ms) {
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

      win.performance.now = () => virtualNow;
      win.Date.now = () => 1700000000000 + virtualNow;

      win.setTimeout = (fn, delay = 0, ...args) => {
        const id = nextTimerId++;
        timers.set(id, {
          fn: typeof fn === 'function' ? () => fn(...args) : () => win.eval(fn),
          time: virtualNow + Math.max(0, Number(delay) || 0),
          interval: null
        });
        return id;
      };
      win.clearTimeout = (id) => timers.delete(id);

      win.setInterval = (fn, delay = 0, ...args) => {
        const id = nextTimerId++;
        const step = Math.max(1, Number(delay) || 1);
        timers.set(id, {
          fn: typeof fn === 'function' ? () => fn(...args) : () => win.eval(fn),
          time: virtualNow + step,
          interval: step
        });
        return id;
      };
      win.clearInterval = (id) => timers.delete(id);

      win.requestAnimationFrame = (cb) => {
        const id = nextTimerId++;
        rafCallbacks.set(id, cb);
        return id;
      };
      win.cancelAnimationFrame = (id) => rafCallbacks.delete(id);
    }

    installVirtualClock(window);

    // Hook appendChild so every srcdoc iframe gets the virtual clock immediately on load
    const origAppend = Element.prototype.appendChild;
    Element.prototype.appendChild = function (node) {
      const res = origAppend.call(this, node);
      if (node && node.tagName === 'IFRAME') {
        node.addEventListener('load', () => {
          try { installVirtualClock(node.contentWindow); } catch (e) {}
        });
      }
      return res;
    };

    window.__advanceAll = function (ms) {
      window.__advanceClock(ms);
      document.querySelectorAll('iframe').forEach((fr) => {
        try {
          if (fr.contentWindow) {
            if (!fr.contentWindow.__vcInstalled) installVirtualClock(fr.contentWindow);
            fr.contentWindow.__advanceClock(ms);
          }
        } catch (e) {}
      });
    };
  });

  const fileUrl = 'file://' + path.resolve(__dirname, 'index.html');
  await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 60000 });

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

  const totalFrames = Math.ceil(DURATION_SEC * FPS);
  const dtMs = 1000 / FPS;

  for (let i = 0; i < totalFrames; i++) {
    await page.evaluate((ms) => window.__advanceAll(ms), i === 0 ? 0 : dtMs);
    const frameBuf = await page.screenshot({ type: 'png' });
    const ok = ffmpeg.stdin.write(frameBuf);
    if (!ok) {
      await new Promise((r) => ffmpeg.stdin.once('drain', r));
    }
  }

  ffmpeg.stdin.end();
  await new Promise((resolve, reject) => {
    ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error('FFmpeg exited ' + code))));
  });

  await browser.close();
  console.log('Successfully rendered full animated 43.7s @ 60fps output.mp4');
})();
    
