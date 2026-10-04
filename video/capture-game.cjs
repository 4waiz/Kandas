// Trailer director: plays SELF PLAY deterministically (seeded, autopiloted, fixed
// 1/60 s steps) and screenshots the gameplay segments listed in timeline.json.
//
//   node video/capture-game.cjs <outDir> [segmentIds,comma,separated]
//
// Every job replays the whole script; segments it doesn't own are simulated
// without rendering, so several jobs can render different segments in parallel
// and still line up exactly. Needs the game served at $BASE (default
// http://127.0.0.1:8766). Writes <outDir>/<segment>/00000.jpg… and
// <outDir>/audio-<job>.json (SFX events stamped with video time).

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8766';
const SHARE_BASE = 'https://4waiz.github.io/self-play/';
const timeline = JSON.parse(fs.readFileSync(path.join(__dirname, 'timeline.json'), 'utf8'));
const FPS = timeline.fps;
const seg = Object.fromEntries(timeline.segments.map((s) => [s.id, s]));
const outDir = path.resolve(process.argv[2] || 'frames');
const only = process.argv[3] ? new Set(process.argv[3].split(',')) : null;
const jobName = process.argv[3] ? process.argv[3].replace(/,/g, '+') : 'all';

const HL = (t, pink) => `<span class="hl${pink ? ' pink' : ''}"><span>${t}</span></span>`;

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const audio = [];
  let page;

  async function open(hash = '') {
    if (page) {
      audio.push(...(await page.evaluate(() => window.__audioEvents)));
      await page.close();
    }
    page = await context.newPage();
    page.on('pageerror', (e) => console.error('pageerror:', e.message));
    await page.goto(`${BASE}/index.html?capture${hash}`);
    await page.waitForFunction('window.__selfplay', null, { timeout: 60000 });
    await page.evaluate((b) => (window.__shareBase = b), SHARE_BASE);
  }

  const game = (fn, arg) => page.evaluate(fn, arg);
  const skip = (s) => game((s) => { window.__logAudio = false; window.__selfplay.advance(s); }, s);
  async function skipUntil(cond, max = 120) {
    for (let t = 0; t < max; t += 0.1) {
      if (await game(cond)) return;
      await skip(0.1);
    }
    throw new Error('skipUntil timed out: ' + cond);
  }

  // Capture (or, for segments this job doesn't own, just simulate) one segment.
  // cues: [[localTime, fn(page) | {caption:[eyebrow, html]}], ...]
  async function capture(id, cues = []) {
    const s = seg[id];
    const n = Math.round(s.dur * FPS);
    const mine = !only || only.has(id);
    const dir = path.join(outDir, id);
    if (mine) fs.mkdirSync(dir, { recursive: true });
    const pending = cues.slice().sort((a, b) => a[0] - b[0]);
    const t0 = Date.now();
    for (let i = 0; i < n; i++) {
      const local = i / FPS;
      while (pending.length && pending[0][0] <= local + 1e-6) {
        const [, cue] = pending.shift();
        if (typeof cue === 'function') await cue();
        else if (cue.caption && mine) await game((c) => window.__selfplay.ui.caption(c[0], c[1], c[2]), cue.caption);
        else if (cue.clear && mine) await game(() => window.__selfplay.ui.caption(null, null));
      }
      const vt = s.start + local;
      await game(([vt, render, log]) => {
        window.__vt = vt;
        window.__logAudio = log;
        const g = window.__selfplay;
        g.step(1 / 60, false);
        g.step(1 / 60, render);
        if (render) window.__syncAnimations(vt);
      }, [vt, mine, mine]);
      if (mine) await page.screenshot({ path: path.join(dir, String(i).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: 93 });
      if (mine && i % 30 === 29) console.log(`[${jobName}] ${id} ${i + 1}/${n}  ${((Date.now() - t0) / (i + 1)).toFixed(0)} ms/frame`);
    }
    if (mine) await game(() => window.__selfplay.ui.caption(null, null));
  }

  // --------------------------------------------------------------------------
  // The story.
  await open();
  await game(() => window.__selfplay.startRun('story'));
  await skip(1.4);

  await capture('calib', [
    [0.3, { caption: ['ROUND 1 · CALIBRATION', `Just ${HL('play.')}<br>It records 15 decisions a second.`] }],
    [6.0, { caption: ['EVERY DOT IS A DECISION', `You are the ${HL('training data.', true)}`] }],
  ]);

  await skipUntil(() => window.__selfplay.state === 'train');
  await capture('train', [
    [1.0, { caption: ['ON-DEVICE · NO SERVERS', `A neural net learns ${HL('you')}<br>in milliseconds.`, 'top'] }],
    [4.2, { clear: true }],
  ]);

  await game(() => window.__selfplay.continueFromProfile());
  await capture('echo1', [
    [0.4, { caption: ['ROUND 2', `Then it ${HL('becomes you.', true)}`] }],
    [5.0, { caption: ['SAME MODEL, TWO JOBS', `It plays like you — and ${HL('predicts')}<br>your next move.`] }],
    [10.2, { caption: ['THE TWIST', `To win, ${HL('break your habits.', true)}`] }],
  ]);

  // Keep the pilot alive off-camera so the multi-Echo round always happens.
  await game(() => { window.__selfplay.player.hp = 6; });
  await skipUntil(() => { const g = window.__selfplay; g.player.invuln = Math.max(g.player.invuln, 0.5); return g.state === 'combat' && g.round >= 4; }, 240);
  await skip(0.5);
  await capture('multi', [
    [0.4, { caption: [`ROUND 4`, `Every round, ${HL('another generation')}<br>of you joins.`] }],
  ]);

  await game(() => { const g = window.__selfplay; g.player.invuln = 0; g.player.hp = 1; g.hurtPlayer(0, -1, 0xff4d9e); });
  await capture('over', [
    [0.2, { caption: ['GAME OVER?', `Send your clone to a ${HL('friend.', true)}`] }],
    [1.9, { clear: true }],
    [2.7, async () => { await page.fill('.name-in', 'AWAIZ'); }],
    [3.6, async () => { await game(() => window.__selfplay.onAction('share')); }],
  ]);

  // The friend's side: open the challenge link, accept the duel.
  const link = await game(() => document.querySelector('.share-out').value);
  const code = link.split('#echo=')[1];
  console.log(`[${jobName}] share link: ${link.length} chars`);
  await open(`#echo=${code}`);
  await skip(1.2);
  await capture('duel', [
    [0.2, { caption: ['THE LINK IS THE OPPONENT', `Your friend fights ${HL('your brain.')}`, 'right'] }],
    [3.0, async () => { await game(() => window.__selfplay.onAction('duel')); }],
    [5.2, { caption: ['ASYNC PVP · ZERO BACKEND', `~1 KB of weights.<br>${HL('Infinite', true)} rivals.`] }],
  ]);

  audio.push(...(await page.evaluate(() => window.__audioEvents)));
  fs.mkdirSync(outDir, { recursive: true });
  const mineAudio = audio.filter((e) => {
    const s = timeline.segments.find((x) => e.t >= x.start - 1e-6 && e.t < x.start + x.dur);
    return s && (!only || only.has(s.id));
  });
  fs.writeFileSync(path.join(outDir, `audio-${jobName}.json`), JSON.stringify(mineAudio));
  fs.writeFileSync(path.join(outDir, `link-${jobName}.txt`), link);
  console.log(`[${jobName}] done · ${mineAudio.length} audio events`);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
