// Headless smoke test: boots index.html, lets the autopilot play calibration,
// training, several Echo rounds and a share-link duel, and fails on any page error.
//
//   npm run build && npx http-server -p 8766 -c-1 . &  node tools/smoke.cjs

const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8766';
const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(`${BASE}/index.html?capture`);
  await page.waitForFunction('window.__selfplay', null, { timeout: 60000 });

  const run = await page.evaluate(() => {
    const g = window.__selfplay;
    g.startRun('story');
    g.advance(26);
    const afterCalibration = { state: g.state, samples: g.recorder.n };
    g.advance(4.5);
    const trained = { state: g.state, models: g.models.length, acc: g.latest?.acc, archetype: g.profile?.archetype.name };
    g.continueFromProfile();
    for (let i = 0; i < 30 && g.round < 4 && g.state !== 'over'; i++) g.advance(3);
    return { afterCalibration, trained, round: g.round, state: g.state, kills: g.kills };
  });
  console.log(JSON.stringify(run, null, 1));
  if (run.afterCalibration.state !== 'train') fail('calibration did not end in training');
  if (run.afterCalibration.samples < 150) fail('too few samples recorded');
  if (run.trained.state !== 'profile' || run.trained.models !== 1) fail('first Echo was not trained');
  if (run.kills < 1) fail('no Echo was ever defeated');

  // Share link round-trip: encode the latest Echo, reload with it, accept the duel.
  const link = await page.evaluate(async () => {
    const g = window.__selfplay;
    g.player.hp = 1;
    g.player.invuln = 0;
    g.hurtPlayer(0, 1, 0xffffff);
    g.advance(2.5);
    document.querySelector('.name-in').value = 'SMOKE';
    g.shareLink();
    await new Promise((r) => setTimeout(r, 300));
    return document.querySelector('.share-out').value;
  });
  if (!/#echo=[A-Za-z0-9_-]{500,}$/.test(link)) fail('share link missing or malformed: ' + link.slice(0, 80));
  // Same tab: only the hash changes, so the open game must pick it up.
  await page.evaluate((code) => { location.hash = `echo=${code}`; }, link.split('#echo=')[1]);
  await page.waitForFunction(() => !document.querySelector('.duel').hidden, null, { timeout: 5000 }).catch(() => fail('hash-change challenge link ignored'));
  // Fresh tab: a full load with the link.
  await page.close();
  const page2 = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page2.on('pageerror', (e) => errors.push(e.message));
  await page2.goto(`${BASE}/index.html?capture#echo=${link.split('#echo=')[1]}`);
  await page2.waitForFunction('window.__selfplay', null, { timeout: 60000 });
  const duel = await page2.evaluate(() => {
    const g = window.__selfplay;
    const invite = !document.querySelector('.duel').hidden && document.querySelector('.duel-name').textContent;
    g.onAction('duel');
    g.advance(5);
    return { invite, mode: g.mode, echoes: g.echoes.length, state: g.state };
  });
  console.log(JSON.stringify(duel));
  if (duel.invite !== "SMOKE's ECHO" || duel.mode !== 'duel') fail('duel link did not round-trip');

  await browser.close();
  if (errors.length) fail('page errors:\n' + errors.join('\n'));
  console.log('PASS');
})();
