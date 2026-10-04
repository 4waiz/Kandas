// Studio intro card: the KS mark + "MADE BY TEAM KANBAN", rendered frame by frame
// (animation is a pure function of time) for the start of the trailer.
//
//   node video/capture-intro.cjs <outDir> [seconds=2]

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || 'intro');
const secs = Number(process.argv[3] || 2);
const fonts = fs.readFileSync(path.join(root, 'assets/fonts.css'), 'utf8');
const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(root, 'assets/ks-logo-light.png')).toString('base64');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${fonts}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1280px;height:720px;background:#0E0B14;overflow:hidden}
.stage{position:relative;width:1280px;height:720px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px}
.stage::after{content:"";position:absolute;inset:0;opacity:.06;mix-blend-mode:screen;pointer-events:none;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='p'><feTurbulence type='fractalNoise' baseFrequency='0.045 0.05' numOctaves='4' seed='7' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.96  0 0 0 0 0.95  0 0 0 0 0.91  0 0 0 0.9 0'/></filter><rect width='100%' height='100%' filter='url(%23p)'/></svg>");background-size:240px 240px}
.logo{height:250px;width:auto;display:block}
.made{font-family:'Shadows Into Light Two',cursive;text-transform:uppercase;letter-spacing:6px;font-size:24px;color:#F5F1E8}
.team{font-family:'Caveat Brush',cursive;text-transform:uppercase;font-size:84px;line-height:.9;color:#F5F1E8;letter-spacing:1px}
.hl{position:relative;display:inline-block;color:#0E0B14}
.hl>span{position:relative;z-index:2}
.hl i{position:absolute;left:-3%;top:52%;width:106%;height:1.02em;transform:translateY(-50%) rotate(-1.2deg);background:#00E0FF;z-index:1;
  clip-path:polygon(0% 28%,4% 8%,52% 4%,99% 9%,100% 70%,97% 92%,46% 96%,2% 90%);transform-origin:left center}
.dot{position:absolute;width:8px;height:8px;border-radius:50%}
</style></head><body><div class="stage">
<span class="dot" style="background:#FF4D9E;left:300px;top:150px"></span>
<span class="dot" style="background:#B8FF3D;left:980px;top:210px"></span>
<span class="dot" style="background:#FFE34D;left:250px;top:560px"></span>
<span class="dot" style="background:#7B5BFF;left:1010px;top:540px"></span>
<img class="logo" src="${logo}" alt="">
<div class="made">MADE BY</div>
<div class="team">TEAM <span class="hl"><i></i><span>KANBAN</span></span></div>
</div><script>
const ease = (t) => 1 - Math.pow(1 - t, 3);
const back = (t) => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const clamp = (v) => Math.max(0, Math.min(1, v));
const logo = document.querySelector('.logo'), made = document.querySelector('.made'), team = document.querySelector('.team');
const swipe = document.querySelector('.hl i'), word = document.querySelector('.hl'), dots = [...document.querySelectorAll('.dot')];
window.seek = (ms) => {
  const t = ms / 1000;
  const a = clamp(t / 0.55);
  logo.style.transform = 'scale(' + (0.6 + 0.4 * back(a)) + ') rotate(' + ((1 - ease(a)) * -6) + 'deg)';
  logo.style.opacity = clamp(t / 0.25);
  const b = clamp((t - 0.35) / 0.35);
  made.style.opacity = b; made.style.transform = 'translateY(' + (1 - ease(b)) * 14 + 'px)';
  const c = clamp((t - 0.5) / 0.4);
  team.style.opacity = c; team.style.transform = 'translateY(' + (1 - ease(c)) * 22 + 'px)';
  const d = clamp((t - 0.85) / 0.3);
  swipe.style.transform = 'translateY(-50%) rotate(-1.2deg) scaleX(' + ease(d) + ')';
  word.style.color = d > 0.55 ? '#0E0B14' : '#F5F1E8';
  dots.forEach((el, i) => { el.style.opacity = clamp((t - 0.2 - i * 0.08) / 0.3); el.style.transform = 'translateY(' + Math.sin(t * 1.5 + i) * 4 + 'px)'; });
};
window.seek(0);
</script></body></html>`;

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  const n = Math.round(secs * 30);
  for (let i = 0; i < n; i++) {
    await page.evaluate((ms) => window.seek(ms), (i / 30) * 1000);
    await page.screenshot({ path: path.join(out, String(i).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: 93 });
  }
  await browser.close();
  console.log(`intro: ${n} frames -> ${out}`);
})();
