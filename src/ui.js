// DOM overlay in the Kanban Studios sketch-brutalist style: marker headlines with
// a highlighter swipe, wobbly ink boxes with a hard offset shadow, label-face
// eyebrows. Screens, HUD, nameplates, toasts, the training read-out and the
// "what the AI thinks of you" profile card.

import { LINKS, PLAYER } from './config.js';
import { TRAITS } from './brain.js';
import logoUrl from '../assets/ks-logo-light-sm.png';

const NS = 'http://www.w3.org/2000/svg';
const AST = `<svg class="ast" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 1.5V10.5"/><path d="M1.8 3.4 10.2 8.6"/><path d="M10.2 3.4 1.8 8.6"/></svg>`;
const ARROW = `<svg class="sk-arrow" viewBox="0 0 28 14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7.5C9 6.6 16 7.4 25 6.8"/><path d="M19 2.2 25.4 6.9 19.4 12"/></svg>`;
const CREDIT = `<a class="credit" href="${LINKS.team}" target="_blank" rel="noopener">${AST}<span>TEAM KANBAN</span><span class="by">by Awaiz Ahmed</span></a>`;

function lcg(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// Hand-drawn double-stroke rectangle (roughjs-like: bowed, jittered, two passes).
export function sketchBorder(el, seed = 1, stroke = 'currentColor', width = 2.6) {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  if (!w || !h) return;
  let svg = el.querySelector(':scope > svg.edge');
  if (!svg) {
    svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'edge');
    svg.setAttribute('aria-hidden', 'true');
    el.prepend(svg);
  }
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const rng = lcg(seed * 7919 + w * 31 + h);
  const seg = (x0, y0, x1, y1) => {
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const j = () => (rng() - 0.5) * Math.min(4.5, 1.2 + len * 0.004) * 1.6;
    const bow = (rng() - 0.5) * Math.min(7, len * 0.014) * 1.4;
    const nx = -(y1 - y0) / len;
    const ny = (x1 - x0) / len;
    const mx = (x0 + x1) / 2 + nx * bow;
    const my = (y0 + y1) / 2 + ny * bow;
    const f = (v) => v.toFixed(1);
    return `M${f(x0 + j())} ${f(y0 + j())}Q${f(mx + j())} ${f(my + j())} ${f(x1 + j())} ${f(y1 + j())}`;
  };
  const p = 3;
  const pts = [[p, p], [w - p, p], [w - p, h - p], [p, h - p]];
  let d = '';
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < 4; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % 4];
      d += seg(a[0], a[1], b[0], b[1]);
    }
  }
  svg.innerHTML = `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

const TEMPLATE = `
<div class="hud">
  <div class="hud-tl">
    <div class="label round-label"></div>
    <div class="marker score">0</div>
  </div>
  <div class="hud-top">
    <div class="rec sketchbox"><span class="rec-dot"></span><span class="label">REC</span><span class="marker rec-time">25</span><span class="hand rec-n">0 decisions</span></div>
    <div class="predict sketchbox">
      <div class="predict-row"><span class="label">${AST}PREDICTABILITY</span><span class="marker pct">0%</span></div>
      <div class="bar"><i></i></div>
      <div class="hand hint">break your habits</div>
    </div>
  </div>
  <div class="hud-bl">
    <div class="hp"></div>
    <div class="dash"><span class="label">DASH</span><div class="dash-bar"><i></i></div></div>
  </div>
  <div class="hud-br sketchbox">
    <div class="label brain-label">LIVE BRAIN</div>
    <canvas class="minibrain" width="260" height="150"></canvas>
  </div>
  <button class="pause-btn label" type="button" aria-label="Pause">II</button>
</div>
<div class="plates"></div>
<div class="toasts"></div>
<div class="banner"><div class="marker big"></div><div class="label sub"></div></div>
<div class="caption"><div class="cap-box sketchbox rot-a"><div class="label cap-eyebrow"></div><div class="marker cap-text"></div></div></div>

<section class="screen scr-title">
  <img class="ks-logo" src="${logoUrl}" alt="Kanban Studios">
  <div class="title-wrap">
    <div class="label eyebrow">${AST}CAMBRIDGE × ARCADE AI HACKATHON 2026</div>
    <h1 class="marker title">SELF <span class="hl"><span>PLAY</span></span></h1>
    <p class="hand tagline">The final boss is a neural network <b>trained on you</b>.</p>
    <div class="duel sketchbox rot-b" hidden>
      <div class="label">${AST}INCOMING CHALLENGE</div>
      <div class="marker duel-name"></div>
      <div class="hand duel-meta"></div>
      <button class="btn filled" data-act="duel" type="button">Accept duel ${ARROW}</button>
    </div>
    <div class="btn-row">
      <button class="btn filled" data-act="play" type="button">Start calibration ${ARROW}</button>
      <button class="btn" data-act="how" type="button">How it works</button>
    </div>
    <div class="label controls"><span class="kb">WASD move · MOUSE aim · CLICK shoot · SPACE dash · ESC pause</span><span class="tc">LEFT THUMB move · RIGHT THUMB aim + fire · DASH button</span></div>
  </div>
  <div class="title-foot">
    <div class="label best">BEST <span>0</span></div>
    <button class="label sound" data-act="mute" type="button">SOUND ON</button>
  </div>
  ${CREDIT}
</section>

<section class="screen scr-how">
  <img class="ks-logo" src="${logoUrl}" alt="">
  <div class="how-wrap">
    <div class="label">${AST}HOW IT WORKS</div>
    <h2 class="marker">You are the <span class="hl pink"><span>training data.</span></span></h2>
    <div class="steps">
      <div class="step sketchbox rot-a"><div class="label">* 01 · PLAY</div><p class="hand">For 25 seconds the game records <b>15 of your decisions every second</b> — where you are, where the threats are, what you do about it.</p></div>
      <div class="step sketchbox rot-b"><div class="label">* 02 · TRAIN</div><p class="hand">A small neural network (<b>1,283 weights</b>) trains on that data <b>right here in your browser</b>. No servers, nothing uploaded.</p></div>
      <div class="step sketchbox rot-c"><div class="label">* 03 · FIGHT YOURSELF</div><p class="hand">Your <b>Echo</b> moves, dodges and shoots like you — and uses the same model to <b>predict your next move</b>. Be unpredictable.</p></div>
    </div>
    <p class="hand how-more">Every round, another generation of you joins the fight. Lose, and you can send your Echo to a friend as a link — the weights fit in the URL.</p>
    <button class="btn filled" data-act="back" type="button">Got it ${ARROW}</button>
  </div>
  ${CREDIT}
</section>

<section class="screen scr-train">
  <div class="train-card sketchbox">
    <div class="train-head"><span class="label">${AST}<span class="train-eyebrow">NEURAL NETWORK</span></span><span class="label train-epoch"></span></div>
    <div class="marker train-title">TRAINING ECHO-01</div>
    <canvas class="loss" width="520" height="120"></canvas>
    <div class="train-stats hand"></div>
  </div>
</section>

<section class="screen scr-profile">
  <div class="profile-card sketchbox rot-a">
    <div class="label">${AST}THE AI THINKS YOU ARE</div>
    <h2 class="marker arch"></h2>
    <p class="hand arch-blurb"></p>
    <div class="profile-body">
      <div class="radar"></div>
      <ul class="marks insights"></ul>
    </div>
    <div class="profile-foot">
      <span class="label model-meta"></span>
      <button class="btn filled" data-act="continue" type="button">Fight your Echo ${ARROW}</button>
    </div>
  </div>
</section>

<section class="screen scr-over">
  <img class="ks-logo" src="${logoUrl}" alt="">
  <div class="over-wrap">
    <div class="label over-eyebrow">${AST}GAME OVER</div>
    <h2 class="marker over-title"></h2>
    <div class="over-stats"></div>
    <div class="share sketchbox rot-b">
      <div class="label">${AST}SEND YOUR ECHO TO A FRIEND</div>
      <p class="hand share-copy">Your trained clone fits in a link. They fight <b>you</b> — no server, no install.</p>
      <div class="share-row">
        <input class="name-in hand" maxlength="14" placeholder="sign it (your name)" spellcheck="false">
        <button class="btn filled" data-act="share" type="button">Copy challenge link</button>
      </div>
      <input class="share-out hand" readonly hidden>
    </div>
    <div class="btn-row">
      <button class="btn filled" data-act="retry" type="button">Play again ${ARROW}</button>
      <button class="btn" data-act="menu" type="button">Menu</button>
    </div>
  </div>
  ${CREDIT}
</section>

<section class="screen scr-pause">
  <div class="pause-card sketchbox rot-a">
    <h2 class="marker">PAUSED</h2>
    <div class="btn-col">
      <button class="btn filled" data-act="resume" type="button">Resume ${ARROW}</button>
      <button class="btn" data-act="retry" type="button">Restart</button>
      <button class="btn" data-act="menu" type="button">Menu</button>
      <button class="label sound" data-act="mute" type="button">SOUND ON</button>
    </div>
  </div>
  ${CREDIT}
</section>
`;

export class UI {
  constructor(root, game) {
    this.root = root;
    this.game = game;
    root.innerHTML = TEMPLATE;
    const $ = (s) => root.querySelector(s);
    this.$ = $;
    this.el = {
      hud: $('.hud'),
      roundLabel: $('.round-label'),
      score: $('.score'),
      rec: $('.rec'),
      recTime: $('.rec-time'),
      recN: $('.rec-n'),
      predict: $('.predict'),
      pct: $('.predict .pct'),
      bar: $('.predict .bar i'),
      hint: $('.predict .hint'),
      hp: $('.hp'),
      dashBar: $('.dash-bar i'),
      brainBox: $('.hud-br'),
      brainLabel: $('.brain-label'),
      minibrain: $('.minibrain'),
      plates: $('.plates'),
      toasts: $('.toasts'),
      banner: $('.banner'),
      bannerBig: $('.banner .big'),
      bannerSub: $('.banner .sub'),
      loss: $('.loss'),
      trainTitle: $('.train-title'),
      trainEyebrow: $('.train-eyebrow'),
      trainEpoch: $('.train-epoch'),
      trainStats: $('.train-stats'),
    };
    this.screens = {};
    for (const s of root.querySelectorAll('.screen')) this.screens[s.className.match(/scr-(\w+)/)[1]] = s;
    for (let i = 0; i < PLAYER.hp; i++) {
      const pip = document.createElement('i');
      this.el.hp.appendChild(pip);
    }
    this.plates = new Map();
    this.bannerT = 0;
    this.toastList = [];
    this.hudMode = 'none';
    this.score = 0;
    this.shownScore = 0;

    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      game.audio.init();
      game.audio.uiClick();
      game.onAction(b.dataset.act, b);
    });
    root.addEventListener('pointerover', (e) => {
      const b = e.target.closest('.btn');
      if (b && b !== this.hovered) game.audio.uiHover();
      this.hovered = b;
    });
    $('.pause-btn').addEventListener('click', () => game.onAction('pause'));
    addEventListener('resize', () => this.redrawSketches());
  }

  // ---- screens ---------------------------------------------------------------

  show(name) {
    for (const [k, s] of Object.entries(this.screens)) s.classList.toggle('on', k === name);
    this.current = name;
    this.root.dataset.screen = name || '';
    requestAnimationFrame(() => this.redrawSketches());
  }

  redrawSketches() {
    let i = 1;
    for (const el of this.root.querySelectorAll('.sketchbox, .btn')) {
      if (el.offsetParent !== null) sketchBorder(el, i, el.classList.contains('filled') ? 'var(--bg)' : 'currentColor', el.classList.contains('btn') ? 2.4 : 2.8);
      i++;
    }
  }

  showTitle(best, duel) {
    this.$('.best span').textContent = best.toLocaleString();
    const d = this.$('.duel');
    if (duel) {
      d.hidden = false;
      this.$('.duel-name').textContent = `${duel.name}'s ECHO`;
      this.$('.duel-meta').innerHTML = `${duel.archetype.name} · gen ${duel.gen} · trained on ${duel.samples.toLocaleString()} decisions`;
    } else d.hidden = true;
    this.setHud('none');
    this.show('title');
  }

  setSound(muted) {
    for (const b of this.root.querySelectorAll('.sound')) b.textContent = muted ? 'SOUND OFF' : 'SOUND ON';
  }

  // ---- HUD -------------------------------------------------------------------

  setHud(mode) {
    this.hudMode = mode;
    this.root.dataset.hud = mode;
    document.body.dataset.hud = mode;
    requestAnimationFrame(() => this.redrawSketches());
  }

  updateHud(g, dt) {
    if (this.hudMode === 'none') return;
    const e = this.el;
    this.shownScore += (g.score - this.shownScore) * Math.min(1, dt * 10);
    if (Math.abs(g.score - this.shownScore) < 1) this.shownScore = g.score;
    e.score.textContent = Math.round(this.shownScore).toLocaleString();
    e.roundLabel.textContent = g.roundLabel();

    if (this.hudMode === 'calibrate') {
      e.recTime.textContent = Math.max(0, Math.ceil(g.calibrationLeft));
      e.recN.textContent = `${g.recorder.total.toLocaleString()} decisions`;
    } else if (this.hudMode === 'combat') {
      const v = g.predict.value;
      e.pct.textContent = `${Math.round(v * 100)}%`;
      e.bar.style.width = `${v * 100}%`;
      e.bar.style.background = v > 0.6 ? 'var(--acc-pink)' : v > 0.4 ? 'var(--acc-sun)' : 'var(--acc-electric)';
      e.hint.textContent = g.predict.n < 10 ? 'reading you…' : v > 0.6 ? "it's reading you — break your habits" : v > 0.4 ? 'keep it messy' : "it can't read you";
    }

    const pips = e.hp.children;
    for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('on', i < g.player.hp);
    const dk = 1 - Math.max(0, g.player.dashCd) / PLAYER.dashCooldown;
    e.dashBar.style.width = `${Math.min(1, dk) * 100}%`;

    this.updatePlates(g);
    if (this.hudMode === 'combat') this.drawMiniBrain(g);
  }

  updatePlates(g) {
    const seen = new Set();
    const w = innerWidth;
    const h = innerHeight;
    for (const ec of g.echoes) {
      if (!ec.alive) continue;
      seen.add(ec);
      let p = this.plates.get(ec);
      if (!p) {
        p = document.createElement('div');
        p.className = 'plate';
        p.innerHTML = `<span class="label"></span><div class="pbar"><i></i></div>`;
        p.style.setProperty('--c', `#${ec.color.toString(16).padStart(6, '0')}`);
        p.querySelector('.label').textContent = ec.name;
        this.el.plates.appendChild(p);
        this.plates.set(ec, p);
      }
      const v = g.project(ec.x, 2.3, ec.z);
      p.style.transform = `translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px) translate(-50%, -100%)`;
      p.style.opacity = ec.spawnT < 1 ? ec.spawnT : 1;
      p.querySelector('i').style.width = `${(ec.hp / ec.maxHp) * 100}%`;
    }
    for (const [ec, p] of this.plates) {
      if (!seen.has(ec)) {
        p.remove();
        this.plates.delete(ec);
      }
    }
  }

  clearPlates() {
    for (const p of this.plates.values()) p.remove();
    this.plates.clear();
  }

  drawMiniBrain(g) {
    const net = g.focusEchoNet();
    const cv = this.el.minibrain;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!net) return;
    this.el.brainLabel.textContent = `${g.focusEchoName()} · LIVE BRAIN`;
    const sizes = net.sizes;
    const W = cv.width;
    const H = cv.height;
    const pos = sizes.map((n, l) => {
      const x = 14 + (l / (sizes.length - 1)) * (W - 28);
      return Array.from({ length: n }, (_, i) => [x, 10 + (n === 1 ? 0.5 : i / (n - 1)) * (H - 20)]);
    });
    ctx.lineWidth = 1;
    for (let l = 0; l < sizes.length - 1; l++) {
      const a = net.acts[l];
      const Wl = net.W[l];
      const nin = sizes[l];
      for (let o = 0; o < sizes[l + 1]; o++) {
        for (let i = 0; i < nin; i++) {
          const w = Wl[o * nin + i];
          const v = Math.min(1, Math.abs(w * a[i]) * 1.4);
          if (v < 0.06) continue;
          ctx.strokeStyle = w * a[i] >= 0 ? `rgba(0,224,255,${v * 0.8})` : `rgba(255,77,158,${v * 0.8})`;
          ctx.beginPath();
          ctx.moveTo(pos[l][i][0], pos[l][i][1]);
          ctx.lineTo(pos[l + 1][o][0], pos[l + 1][o][1]);
          ctx.stroke();
        }
      }
    }
    for (let l = 0; l < sizes.length; l++) {
      const a = net.acts[l];
      for (let i = 0; i < sizes[l]; i++) {
        const v = l === sizes.length - 1 ? Math.tanh(a[i] * 0.5) : Math.max(-1, Math.min(1, a[i]));
        ctx.fillStyle = v >= 0 ? `rgba(0,224,255,${0.25 + Math.abs(v) * 0.75})` : `rgba(255,77,158,${0.25 + Math.abs(v) * 0.75})`;
        ctx.beginPath();
        ctx.arc(pos[l][i][0], pos[l][i][1], 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ---- feedback --------------------------------------------------------------

  banner(big, sub = '', color = 'var(--fg)', dur = 1.6) {
    const e = this.el;
    e.bannerBig.innerHTML = big;
    e.bannerSub.textContent = sub;
    e.banner.style.setProperty('--c', color);
    e.banner.classList.remove('on');
    void e.banner.offsetWidth;
    e.banner.classList.add('on');
    this.bannerT = dur;
  }

  toast(html, color = 'var(--acc-electric)') {
    const t = document.createElement('div');
    t.className = 'toast label';
    t.style.setProperty('--c', color);
    t.innerHTML = html;
    this.el.toasts.appendChild(t);
    this.toastList.push({ el: t, t: 2.2 });
    while (this.toastList.length > 4) this.toastList.shift().el.remove();
  }

  // Timers run on game time (not setTimeout) so the trailer capture stays in sync.
  tick(dt) {
    if (this.bannerT > 0) {
      this.bannerT -= dt;
      if (this.bannerT <= 0) this.el.banner.classList.remove('on');
    }
    for (const t of this.toastList) t.t -= dt;
    while (this.toastList.length && this.toastList[0].t <= 0) this.toastList.shift().el.remove();
  }

  // Trailer captions (lower third). Only the capture director uses these.
  caption(eyebrow, html, where = 'left') {
    const c = this.$('.caption');
    if (!html) {
      c.classList.remove('on');
      return;
    }
    c.classList.toggle('top', where === 'top');
    c.classList.toggle('right', where === 'right');
    c.querySelector('.cap-eyebrow').innerHTML = `${AST}${eyebrow}`;
    c.querySelector('.cap-text').innerHTML = html;
    c.classList.remove('on');
    void c.offsetWidth;
    c.classList.add('on');
    requestAnimationFrame(() => sketchBorder(c.querySelector('.cap-box'), 99, 'currentColor', 2.8));
  }

  // ---- training read-out --------------------------------------------------------

  showTraining(name, round) {
    this.el.trainTitle.innerHTML = `TRAINING <span class="hl"><span>${name}</span></span>`;
    this.el.trainEyebrow.textContent = round === 1 ? 'NEURAL NETWORK · FIRST GENERATION' : `NEURAL NETWORK · GENERATION ${round}`;
    this.show('train');
  }

  updateTraining(tr, samples, done) {
    const e = this.el;
    e.trainEpoch.textContent = `EPOCH ${Math.min(tr.epoch, tr.epochs)}/${tr.epochs}`;
    const acc = Math.round((tr.valAcc || 0) * 100);
    e.trainStats.innerHTML = done
      ? `<b>${samples.toLocaleString()}</b> of your decisions · <b>${tr.net.paramCount.toLocaleString()}</b> weights · trained in <b>${Math.max(1, Math.round(tr.computeMs))} ms</b> · predicts you <b class="pink">${acc}%</b> of the time`
      : `<b>${samples.toLocaleString()}</b> of your decisions → <b>${tr.net.paramCount.toLocaleString()}</b> weights · match so far <b>${acc}%</b>`;
    this.drawLoss(tr.lossHistory, tr.epochs);
  }

  drawLoss(hist, epochs) {
    const cv = this.el.loss;
    const g = cv.getContext('2d');
    const W = cv.width;
    const H = cv.height;
    g.clearRect(0, 0, W, H);
    g.strokeStyle = 'rgba(245,241,232,0.55)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(10, 8);
    g.lineTo(9, H - 12);
    g.lineTo(W - 6, H - 11);
    g.stroke();
    g.fillStyle = 'rgba(245,241,232,0.6)';
    g.font = '15px "Shadows Into Light Two", cursive';
    g.fillText('LOSS', 16, 18);
    if (hist.length < 1) return;
    const max = Math.max(...hist) * 1.05;
    const min = Math.min(...hist) * 0.9;
    const rng = lcg(hist.length);
    g.strokeStyle = '#00E0FF';
    g.lineWidth = 3.2;
    g.lineJoin = g.lineCap = 'round';
    g.shadowColor = '#00E0FF';
    g.shadowBlur = 8;
    g.beginPath();
    hist.forEach((v, i) => {
      const x = 12 + (i / Math.max(1, epochs - 1)) * (W - 24);
      const y = 10 + (1 - (v - min) / Math.max(1e-6, max - min)) * (H - 26) + (rng() - 0.5) * 1.5;
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.stroke();
    g.shadowBlur = 0;
  }

  // ---- profile card -------------------------------------------------------------

  showProfile(profile, model) {
    const $ = this.$;
    const words = profile.archetype.name.split(' ');
    const last = words.pop();
    $('.arch').innerHTML = `${words.join(' ')} <span class="hl"><span>${last}</span></span>`;
    $('.arch-blurb').textContent = profile.archetype.blurb;
    $('.insights').innerHTML = profile.insights.map((t) => `<li>${t}</li>`).join('');
    $('.radar').innerHTML = radarSVG(profile.traits);
    $('.model-meta').textContent = `${model.label} · ${model.samples.toLocaleString()} DECISIONS · MATCH ${Math.round(model.acc * 100)}%`;
    this.show('profile');
  }

  // ---- game over ----------------------------------------------------------------

  showOver(r) {
    const $ = this.$;
    $('.over-eyebrow').innerHTML = `${AST}${r.eyebrow}`;
    $('.over-title').innerHTML = r.title;
    $('.over-stats').innerHTML = r.stats
      .map(([k, v]) => `<div class="stat"><div class="marker n">${v}</div><div class="label">${k}</div></div>`)
      .join('');
    $('.share').hidden = !r.canShare;
    $('.share-out').hidden = true;
    if (r.echo) $('.share-copy').innerHTML = `Your ${r.echo} fits in a link. They fight <b>you</b> — no server, no install.`;
    this.setHud('none');
    this.clearPlates();
    this.show('over');
  }

  showShareLink(url, copied) {
    const out = this.$('.share-out');
    out.hidden = false;
    out.value = url;
    out.select?.();
    this.toast(copied ? 'LINK COPIED — SEND IT' : 'COPY THE LINK BELOW', 'var(--acc-acid)');
    requestAnimationFrame(() => this.redrawSketches());
  }

  shareName() {
    return this.$('.name-in').value.trim().toUpperCase();
  }
}

// Six-axis playstyle radar in hand-drawn ink.
function radarSVG(traits) {
  const S = 240;
  const cx = S / 2;
  const cy = S / 2 + 4;
  const R = 78;
  const rng = lcg(42);
  const ang = (i) => -Math.PI / 2 + (i * Math.PI * 2) / TRAITS.length;
  const pt = (i, r) => [cx + Math.cos(ang(i)) * r + (rng() - 0.5) * 1.6, cy + Math.sin(ang(i)) * r + (rng() - 0.5) * 1.6];
  let grid = '';
  for (const f of [0.34, 0.67, 1]) {
    const ps = TRAITS.map((_, i) => pt(i, R * f));
    grid += `<path d="M${ps.map((p) => p.map((v) => v.toFixed(1)).join(' ')).join('L')}Z" fill="none" stroke="rgba(245,241,232,${f === 1 ? 0.5 : 0.18})" stroke-width="${f === 1 ? 2 : 1.4}"/>`;
  }
  let axes = '';
  let labels = '';
  TRAITS.forEach((t, i) => {
    const [x, y] = pt(i, R);
    axes += `<path d="M${cx} ${cy}L${x.toFixed(1)} ${y.toFixed(1)}" stroke="rgba(245,241,232,0.18)" stroke-width="1.2"/>`;
    const [lx, ly] = pt(i, R + 22);
    labels += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle">${t}</text>`;
  });
  const vals = TRAITS.map((t, i) => pt(i, R * (0.08 + 0.92 * (traits[t] ?? 0))));
  const poly = `M${vals.map((p) => p.map((v) => v.toFixed(1)).join(' ')).join('L')}Z`;
  const dots = vals.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.6" fill="#FF4D9E"/>`).join('');
  return `<svg viewBox="0 0 ${S} ${S}" class="radar-svg">${grid}${axes}<path d="${poly}" fill="rgba(0,224,255,0.22)" stroke="#00E0FF" stroke-width="3" stroke-linejoin="round"/>${dots}<g class="rl">${labels}</g></svg>`;
}
