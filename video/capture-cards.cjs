#!/usr/bin/env node
/*
 * Render the SELF PLAY title/pitch cards (cards.html) to JPEG frame sequences for the video.
 *
 *   NODE_PATH=/opt/node22/lib/node_modules node capture-cards.cjs [outdir] [--only=hook,end] [--frames=0,15,90]
 *
 * Output: <outdir>/<cardId>/00000.jpg, 00001.jpg, ... at 30 fps, 1920x1080 (1280x720 CSS px at
 * deviceScaleFactor 1.5), JPEG quality 92, plus <outdir>/manifest.json. Each frame is
 * seek(frame * 1000 / 30) on the card, so the output is reproducible run to run.
 *   --only=ids     render just these cards
 *   --frames=list  spot-check: render only these frame indices (keeps any other frames on disk)
 * Uses the preinstalled Chromium; do not run `playwright install`.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

const FPS = 30;
const DEFAULT_OUT = '/tmp/claude-0/-home-user-Kandas/406072a8-5582-5e50-bf54-eabe4c1b7340/scratchpad/cards/frames';
const HTML = path.join(__dirname, 'cards.html');

function parseArgs(argv) {
  const args = { outdir: DEFAULT_OUT, only: null, frames: null };
  for (const a of argv) {
    if (a.startsWith('--only=')) args.only = a.slice(7).split(',').filter(Boolean);
    else if (a.startsWith('--frames=')) args.frames = a.slice(9).split(',').filter(Boolean).map(Number);
    else if (a.startsWith('--')) throw new Error('unknown option ' + a);
    else args.outdir = path.resolve(a);
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
    const page = await context.newPage();
    page.setDefaultTimeout(180000); // a busy machine (parallel renders) can stall a screenshot well past 30s
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(pathToFileURL(HTML).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.cardsReady);

    let cards = await page.evaluate(() => window.cardList());
    if (args.only) {
      const unknown = args.only.filter((id) => !cards.some((c) => c.id === id));
      if (unknown.length) throw new Error('unknown card id(s): ' + unknown.join(', '));
      cards = cards.filter((c) => args.only.includes(c.id));
    }

    fs.mkdirSync(args.outdir, { recursive: true });
    const manifest = [];
    for (const card of cards) {
      const total = Math.round((card.dur * FPS) / 1000);
      const dir = path.join(args.outdir, card.id);
      fs.mkdirSync(dir, { recursive: true });
      if (!args.frames) {
        // drop stale frames from an earlier, longer render so the sequence length is exact
        for (const f of fs.readdirSync(dir)) if (/^\d{5}\.jpg$/.test(f)) fs.unlinkSync(path.join(dir, f));
      }
      await page.evaluate((id) => window.showCard(id), card.id);
      await page.evaluate(() => document.fonts.ready);

      const list = args.frames ? args.frames.filter((i) => i >= 0 && i < total) : [...Array(total).keys()];
      const t0 = Date.now();
      for (const i of list) {
        for (let attempt = 1; ; attempt++) {
          try {
            // state is a pure function of time, so a retry just seeks again and re-shoots
            await page.evaluate((ms) => window.seek(ms), (i * 1000) / FPS);
            await page.screenshot({
              path: path.join(dir, String(i).padStart(5, '0') + '.jpg'),
              type: 'jpeg',
              quality: 92,
              clip: { x: 0, y: 0, width: 1280, height: 720 },
            });
            break;
          } catch (e) {
            if (attempt >= 3) throw e;
            console.warn(`${card.id} frame ${i}: ${e.message.split('\n')[0]} (retry ${attempt})`);
          }
        }
      }
      manifest.push({ id: card.id, durationMs: card.dur, fps: FPS, frames: total, dir });
      console.log(`${card.id.padEnd(6)} ${String(list.length).padStart(4)} frame(s)  ${card.dur} ms @ ${FPS} fps  ` +
        `${((Date.now() - t0) / 1000).toFixed(1)}s  -> ${dir}`);
    }
    if (!args.frames && !args.only) {
      fs.writeFileSync(path.join(args.outdir, 'manifest.json'), JSON.stringify({ width: 1920, height: 1080, cards: manifest }, null, 2));
    }
    if (errors.length) {
      console.error('page errors:\n  ' + errors.join('\n  '));
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
