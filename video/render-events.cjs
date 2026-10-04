// Render an arbitrary { duration, events } JSON through the game's AudioEngine
// (offline) to a WAV. Used by brag_cut.py.
//
//   node video/render-events.cjs <events.json> <out.wav>

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8766';
const { duration, events } = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const out = path.resolve(process.argv[3]);

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  await page.goto(`${BASE}/index.html?capture`);
  await page.waitForFunction('window.__AudioEngine', null, { timeout: 60000 });
  const b64 = await page.evaluate(async ({ events, duration }) => {
    const wav = await new window.__AudioEngine().renderOfflineWav({ duration, sampleRate: 48000, events });
    const bytes = new Uint8Array(wav);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, { events, duration });
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log('wrote', out);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
