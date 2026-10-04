// Renders the trailer soundtrack offline with the game's own audio engine:
// the music cues from timeline.json plus every SFX the capture jobs logged,
// each stamped with its video time.
//
//   node video/render-audio.cjs <framesDir> <out.wav>

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8766';
const timeline = JSON.parse(fs.readFileSync(path.join(__dirname, 'timeline.json'), 'utf8'));
const framesDir = path.resolve(process.argv[2] || 'frames');
const out = path.resolve(process.argv[3] || 'soundtrack.wav');

(async () => {
  const sfx = [];
  for (const f of fs.readdirSync(framesDir)) {
    if (/^audio-.*\.json$/.test(f) && f !== 'audio-none.json') sfx.push(...JSON.parse(fs.readFileSync(path.join(framesDir, f), 'utf8')));
  }
  const events = [...timeline.music, ...sfx].sort((a, b) => a.t - b.t);
  console.log(`${timeline.music.length} music cues + ${sfx.length} sfx events`);

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  await page.goto(`${BASE}/index.html?capture`);
  await page.waitForFunction('window.__AudioEngine', null, { timeout: 60000 });
  const b64 = await page.evaluate(async ({ events, duration }) => {
    const engine = new window.__AudioEngine();
    const wav = await engine.renderOfflineWav({ duration, sampleRate: 48000, events });
    const bytes = new Uint8Array(wav);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, { events, duration: timeline.duration });
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log('wrote', out, (fs.statSync(out).size / 1e6).toFixed(1), 'MB');
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
