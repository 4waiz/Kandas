/**
 * SELF PLAY — procedural audio engine (WebAudio only: no samples, no dependencies).
 *
 * Every sound is a plain function `(ctx, dest, when, ...args)`, so one code path drives both the
 * realtime AudioContext and the OfflineAudioContext used for trailer renders.
 *
 *   music voices → session buses ─┬→ musicIn → duck LP → duck gain → −6 dB ─┐
 *                                 ├→ ping-pong delay ─↗                     ├→ bus → limiter → volume → soft clip → out
 *                                 └→ reverb ──────────↗                     │
 *   sfx voices → per-voice gain (cap / steal) → sfx ────────────────────────┘
 *                                    └→ short echo ↗
 *
 * Usage: `const audio = new AudioEngine()` at load, `audio.init()` on every click/keydown (the first one
 * creates the AudioContext). Earlier calls are silent no-ops; startMusic/intensity/duck state is remembered.
 */

// ─── timing & tuning ────────────────────────────────────────────────────────
const BPM = 112;
const STEP = 60 / BPM / 4; // one 16th note (s)
const BAR = 16; // steps per bar
const LOOP = 128; // 8-bar loop
const AHEAD = 0.12; // realtime schedule-ahead (s)
const TICK_MS = 25; // realtime scheduler period
const MAX_VOICES = 28; // concurrent sfx voices
const SFX_LEAD = 0.01; // realtime sfx start offset so attack ramps never begin in the past

const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (v != null && Number.isFinite(+v) ? +v : d);
const toLevel = (l) => clamp(Math.round(num(l, 0)), 0, 3);
const quiet = (p) => p && p.catch && p.catch(() => {});
const create = (C, opts, legacyArgs) => {
  try { return new C(opts); } catch { return new C(...legacyArgs); } // options bag, else older WebKit signatures
};
let warnings = 0;
const warn = (e) => warnings++ < 5 && console.warn('[audio]', e);

// ─── harmony: i–VI–III–VII in A minor (Am F C G), two bars per chord ────────
const CHORDS = [
  { bass: 33, pad: [57, 60, 64, 69] },
  { bass: 29, pad: [57, 60, 65, 69] },
  { bass: 36, pad: [55, 60, 64, 67] },
  { bass: 31, pad: [55, 59, 62, 67] },
];
const PENTA = [0, 3, 5, 7, 10];
const ARP_SLOW = [0, -1, -1, 2, -1, -1, 3, -1, 1, -1, -1, 2, -1, -1, 4, -1]; // 3-3-2 feel (intensity 0-1)
const ARP_FAST = [0, 2, 3, 1, 2, 4, 3, 2]; // straight 16ths (intensity 2+)
const PUMP = [0.4, 0.7, 1, 0.8]; // sidechain-style 16th velocities
const LEAD = []; // sparse: LEAD[step] = [midi, length in steps]
[
  [0, 76, 6], [6, 74, 2], [8, 72, 4], [12, 74, 4], [16, 76, 12],
  [32, 77, 6], [38, 76, 2], [40, 72, 8], [48, 69, 12],
  [64, 79, 6], [70, 76, 2], [72, 72, 4], [76, 76, 4], [80, 79, 12],
  [96, 71, 6], [102, 74, 2], [104, 79, 8], [112, 74, 4], [116, 76, 10],
].forEach(([s, m, l]) => (LEAD[s] = [m, l]));

// ─── PRNG + waveshaper curves ───────────────────────────────────────────────
function mulberry32(a) {
  return () => {
    let t = (a = (a + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const curve = (fn, n = 4097) => Float32Array.from({ length: n }, (_, i) => fn((i / (n - 1)) * 2 - 1));
const CRUSH = curve((x) => Math.round(x * 6) / 6); // ~3.7-bit amplitude quantiser ("bitcrush")
const SOFT = curve((x) => {
  const a = Math.abs(x); // linear to 0.7, then a tanh knee that never exceeds 0.91 (≈ −0.8 dBFS)
  return a < 0.7 ? x : Math.sign(x) * (0.7 + 0.25 * Math.tanh((a - 0.7) / 0.25));
});

// ─── per-context rig: shared buses, effects, noise, seeded randomness ───────
const RIGS = new WeakMap();
const rig = (ctx) => RIGS.get(ctx);

function buildRig(ctx, seed) {
  const sr = ctx.sampleRate, R = { noise: ctx.createBuffer(1, Math.floor(sr * 2), sr) };
  R.mrand = seed == null ? Math.random : mulberry32(seed); // music
  R.srand = seed == null ? Math.random : mulberry32(seed + 1013); // sfx (separate stream)
  const nr = mulberry32(0x5e1f), nd = R.noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = nr() * 2 - 1;

  // master: bus → gentle limiter → volume → soft clip (safety net) → out
  const comp = ctx.createDynamicsCompressor(), clip = ctx.createWaveShaper();
  Object.entries({ threshold: -12, knee: 8, ratio: 4, attack: 0.004, release: 0.2 }).forEach(([k, v]) => (comp[k].value = v));
  clip.curve = SOFT;
  R.bus = gain(ctx, 1.15);
  R.master = gain(ctx, 0);
  R.bus.connect(comp).connect(R.master).connect(clip).connect(ctx.destination);

  // music: in → duck low-pass (moved via detune = log sweep) → duck gain → −6 dB → bus
  R.musicIn = gain(ctx, 1);
  R.duckLP = filt(ctx, 'lowpass', 20000, -3);
  R.duckG = gain(ctx, 1);
  R.musicIn.connect(R.duckLP).connect(R.duckG).connect(gain(ctx, 0.5)).connect(R.bus);

  // ping-pong dotted-8th delay
  const dl = ctx.createDelay(1), dr = ctx.createDelay(1), mix = ctx.createChannelMerger(2);
  dl.delayTime.value = dr.delayTime.value = STEP * 3;
  R.dlyIn = filt(ctx, 'highpass', 280, -3);
  R.dlyIn.connect(dl).connect(gain(ctx, 0.55)).connect(dr).connect(filt(ctx, 'lowpass', 2600, -3)).connect(gain(ctx, 0.55)).connect(dl);
  dl.connect(mix, 0, 0);
  dr.connect(mix, 0, 1);
  mix.connect(gain(ctx, 0.5)).connect(R.musicIn);

  // reverb from a synthetic stereo IR (fixed seed → realtime and offline match)
  const cv = ctx.createConvolver();
  cv.buffer = makeIR(ctx, 2.4);
  R.revIn = filt(ctx, 'highpass', 220, -3);
  R.revIn.connect(cv).connect(gain(ctx, 0.6)).connect(R.musicIn);

  // sfx bus + short feedback echo (sonar, stingers)
  const eLP = filt(ctx, 'lowpass', 2400, -3);
  (R.sfx = gain(ctx, 1)).connect(R.bus);
  (R.echo = ctx.createDelay(1)).delayTime.value = 0.21;
  R.echo.connect(eLP).connect(gain(ctx, 0.35)).connect(R.echo);
  eLP.connect(gain(ctx, 0.5)).connect(R.sfx);
  RIGS.set(ctx, R);
  return R;
}

function makeIR(ctx, secs) {
  const sr = ctx.sampleRate, n = Math.floor(sr * secs), ir = ctx.createBuffer(2, n, sr), rnd = mulberry32(0x1e57);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = Math.floor(sr * 0.012), lp = 0; i < n; i++) {
      const x = i / n;
      lp += (0.6 - 0.5 * x) * (rnd() * 2 - 1 - lp); // tail darkens over time
      d[i] = lp * (1 - x) ** 2.5;
    }
  }
  return ir;
}

// ─── node helpers ───────────────────────────────────────────────────────────
function gain(ctx, v) {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}
function filt(ctx, type, f, q) {
  const b = ctx.createBiquadFilter();
  b.type = type;
  try {
    for (const p of [b.frequency, b.detune, b.Q]) p.automationRate = 'k-rate'; // per-block coefficients: ~3x cheaper sweeps
  } catch {}
  b.frequency.value = f;
  b.Q.value = q ?? (type === 'bandpass' ? 1 : 0);
  return b;
}
function pan(ctx, p) {
  if (!ctx.createStereoPanner) return gain(ctx, 1);
  const s = ctx.createStereoPanner();
  s.pan.value = p;
  return s;
}
/** Oscillator into dest, running t..end. */
function osc(ctx, dest, type, f, t, end, det = 0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = f;
  o.detune.value = det;
  o.connect(dest);
  o.start(t);
  o.stop(end);
  return o;
}
/** Looping white noise into dest, running t..end (start offset derived from t: varied yet deterministic). */
function noise(ctx, dest, t, end) {
  const s = ctx.createBufferSource();
  s.buffer = rig(ctx).noise;
  s.loop = true;
  s.connect(dest);
  s.start(t, (t * 0.731) % 1.8);
  s.stop(end);
}
const slide = (param, from, to, t0, t1) => {
  param.setValueAtTime(from, t0);
  param.exponentialRampToValueAtTime(to, t1);
};
const crusher = (ctx) => Object.assign(ctx.createWaveShaper(), { curve: CRUSH });
const send = (ctx, node, amt) => node.connect(gain(ctx, amt)).connect(rig(ctx).echo);

/** Click-free envelope: 0 → peak (linear a) → hold → exponential decay d → exact 0. Returns end time. */
function env(param, t, peak, a, d, hold = 0) {
  const p = Math.max(peak, 1e-4), e = t + a + hold + d;
  param.value = 0; // silent before t as well: a source may start on the frame just before t
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(p, t + a);
  if (hold > 0) param.setValueAtTime(p, t + a + hold);
  param.exponentialRampToValueAtTime(p * 1e-3, e);
  param.linearRampToValueAtTime(0, e + 0.005);
  return e + 0.005;
}

/** Enveloped oscillator with optional exponential glide, low-pass and pan. Returns end time. */
function tone(ctx, dest, t, { type = 'sine', f, f1, glide = 0.05, a = 0.003, d = 0.15, hold = 0, peak = 0.2, lp, pn, det = 0 }) {
  const g = ctx.createGain(), end = env(g.gain, t, peak, a, d, hold), into = lp ? filt(ctx, 'lowpass', lp) : g;
  if (lp) into.connect(g);
  const o = osc(ctx, into, type, f, t, end, det);
  if (f1) slide(o.frequency, f, f1, t, t + glide);
  (pn ? g.connect(pan(ctx, pn)) : g).connect(dest);
  return end;
}

/** Enveloped band of noise with optional filter sweep. Returns end time. */
function hiss(ctx, dest, t, { type = 'bandpass', f, f1, sweep = 0.1, q, a = 0.002, d = 0.1, hold = 0, peak = 0.2, pn }) {
  const bf = filt(ctx, type, f, q), g = ctx.createGain(), end = env(g.gain, t, peak, a, d, hold);
  if (f1) slide(bf.frequency, f, f1, t, t + sweep);
  noise(ctx, bf, t, end);
  bf.connect(g);
  (pn ? g.connect(pan(ctx, pn)) : g).connect(dest);
  return end;
}

/** Detuned-saw chord through a sweeping low-pass. Returns end time. */
function stab(ctx, dest, t, notes, { peak = 0.05, a = 0.005, hold = 0, d = 0.4, cut = 2400, cut1 = 600, q = 3 } = {}) {
  const lp = filt(ctx, 'lowpass', cut, q), g = ctx.createGain(), end = env(g.gain, t, peak, a, d, hold);
  slide(lp.frequency, cut, cut1, t, end);
  lp.connect(g).connect(dest);
  for (const m of notes) for (const det of [-9, 9]) osc(ctx, lp, 'sawtooth', mtof(m), t, end, det);
  return end;
}

// ─── music voices ───────────────────────────────────────────────────────────
/** Airy pad: two detuned saw layers panned apart, slow filter LFO, long crossfading release. */
function pad(ctx, dest, t, notes, dur, cut, att, lvl) {
  const end = t + dur + 2, g = gain(ctx, 0), depth = gain(ctx, cut * 0.35);
  osc(ctx, depth, 'sine', 0.12, t, end); // filter LFO
  for (const s of [-1, 1]) {
    const lp = filt(ctx, 'lowpass', cut, 2);
    depth.connect(lp.frequency);
    for (const m of notes) osc(ctx, lp, 'sawtooth', mtof(m), t, end, s * 8);
    lp.connect(pan(ctx, s * 0.5)).connect(g);
  }
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(lvl, t + att);
  g.gain.setValueAtTime(lvl, t + Math.max(att, dur));
  g.gain.linearRampToValueAtTime(0, end);
  g.connect(dest);
  return t + dur;
}

function pluck(ctx, dest, t, m, v, cut, pn) {
  const lp = filt(ctx, 'lowpass', cut, 6), g = ctx.createGain(), end = env(g.gain, t, v, 0.003, 0.3);
  slide(lp.frequency, cut * 2.5, cut * 0.6, t, t + 0.2);
  osc(ctx, lp, 'sawtooth', mtof(m), t, end, -5);
  osc(ctx, lp, 'square', mtof(m), t, end, 6);
  lp.connect(g).connect(pan(ctx, pn)).connect(dest);
}

function bass(ctx, dest, t, m, v, len, cut) {
  const lp = filt(ctx, 'lowpass', cut, 5), sub = gain(ctx, 0.5), g = ctx.createGain();
  const end = env(g.gain, t, 0.12 * v, 0.005, 0.06, Math.max(0, len - 0.06));
  slide(lp.frequency, cut * (1 + 2.5 * v), cut * 0.6, t, t + len);
  osc(ctx, lp, 'sawtooth', mtof(m), t, end);
  osc(ctx, sub, 'sine', mtof(m - 12), t, end);
  lp.connect(g);
  sub.connect(g);
  g.connect(dest);
}

function kick(ctx, dest, t, v) {
  tone(ctx, dest, t, { f: 160, f1: 46, glide: 0.1, a: 0.003, d: 0.34, peak: v });
  hiss(ctx, dest, t, { f: 3000, q: 0.8, a: 0.001, d: 0.012, peak: v * 0.12 });
}

const hat = (ctx, dest, t, open, v) =>
  hiss(ctx, dest, t, { f: open ? 7200 : 8500, q: 0.9, a: 0.001, d: open ? 0.2 : 0.035, peak: v, pn: open ? -0.15 : 0.15 });

function clap(ctx, dest, t, v) {
  const bp = filt(ctx, 'bandpass', 1300, 0.9), g = gain(ctx, 0);
  g.gain.setValueAtTime(0, t);
  for (let i = 0; i < 3; i++) {
    const h = t + i * 0.011; // three fast re-hits, then the tail
    g.gain.linearRampToValueAtTime(v, h + 0.001);
    g.gain.exponentialRampToValueAtTime(v * 0.25, h + 0.01);
  }
  g.gain.linearRampToValueAtTime(v * 0.8, t + 0.035);
  g.gain.exponentialRampToValueAtTime(v * 1e-3, t + 0.26);
  g.gain.linearRampToValueAtTime(0, t + 0.265);
  noise(ctx, bp, t, t + 0.27);
  bp.connect(g).connect(dest);
  tone(ctx, dest, t, { type: 'triangle', f: 210, f1: 165, glide: 0.06, d: 0.08, peak: v * 0.35 });
}

function lead(ctx, dest, t, m, len) {
  const lp = filt(ctx, 'lowpass', 2300, 3), g = ctx.createGain(), depth = gain(ctx, 0);
  const end = env(g.gain, t, 0.06, 0.012, 0.22, Math.max(0, len - 0.04));
  depth.gain.setValueAtTime(0, t);
  depth.gain.linearRampToValueAtTime(9, t + 0.35); // delayed vibrato (cents)
  osc(ctx, depth, 'sine', 5.3, t, end);
  for (const [type, det] of [['square', 0], ['sawtooth', 8]]) depth.connect(osc(ctx, lp, type, mtof(m), t, end, det).detune);
  lp.connect(g).connect(dest);
}

/** 32nd-note bit-crushed stutters over the last beat of a phrase. */
function glitchFill(ctx, dest, t, rnd, ch) {
  const ws = crusher(ctx);
  ws.connect(filt(ctx, 'bandpass', 1600, 0.8)).connect(gain(ctx, 0.12)).connect(dest);
  for (let i = 0; i < 8; i++) {
    if (rnd() < 0.3) continue;
    const m = ch.pad[(rnd() * 4) | 0] + 12 * (1 + ((rnd() * 2) | 0));
    tone(ctx, ws, t + (i * STEP) / 2, { type: 'triangle', f: mtof(m), d: 0.05, peak: 0.9, det: (rnd() - 0.5) * 60 });
  }
}

// ─── sfx voices: (ctx, out, t, ...args) → end time ──────────────────────────
const VOICES = {
  shoot(ctx, out, t) {
    const r = rig(ctx).srand, k = 1 + (r() - 0.5) * 0.08;
    hiss(ctx, out, t, { f: 2000 * k, q: 0.9, a: 0.001, d: 0.02, peak: 0.03 });
    return tone(ctx, out, t, { type: 'triangle', f: 980 * k, f1: 360 * k, glide: 0.05, a: 0.002, d: 0.065, peak: 0.18, lp: 2800, pn: (r() - 0.5) * 0.3 });
  },
  echoShoot(ctx, out, t) {
    const k = (1 + (rig(ctx).srand() - 0.5) * 0.12) * 0.7, ws = crusher(ctx), pre = gain(ctx, 0.45), g = ctx.createGain();
    pre.connect(ws).connect(filt(ctx, 'lowpass', 1600, 2)).connect(g).connect(out);
    for (const det of [-30, 30]) {
      const o = osc(ctx, pre, 'sawtooth', 950 * k, t, t + 0.11, det);
      for (let i = 0; i < 4; i++) o.frequency.setValueAtTime(950 * k * 0.7 ** i, t + i * 0.018); // stair-stepped = "corrupted"
    }
    return env(g.gain, t, 0.12, 0.002, 0.09);
  },
  enemyShoot(ctx, out, t) {
    const k = 1 + (rig(ctx).srand() - 0.5) * 0.1, lp = filt(ctx, 'lowpass', 220, 9), g = ctx.createGain(), end = env(g.gain, t, 0.2, 0.004, 0.24);
    slide(osc(ctx, lp, 'sawtooth', 150 * k, t, end).frequency, 150 * k, 60 * k, t, t + 0.2);
    slide(lp.frequency, 220, 1500, t, t + 0.03); // resonant filter "bwomp"
    lp.frequency.exponentialRampToValueAtTime(150, t + 0.24);
    lp.connect(g).connect(out);
    tone(ctx, out, t, { f: 95 * k, f1: 48 * k, glide: 0.18, a: 0.004, d: 0.2, peak: 0.12 });
    return end;
  },
  enemyHit(ctx, out, t) {
    const k = 1 + (rig(ctx).srand() - 0.5) * 0.12;
    hiss(ctx, out, t, { type: 'highpass', f: 4000, a: 0.001, d: 0.014, peak: 0.06 });
    return tone(ctx, out, t, { type: 'square', f: 2000 * k, f1: 1400 * k, glide: 0.025, a: 0.001, d: 0.03, peak: 0.045, lp: 4200 });
  },
  playerHurt(ctx, out, t) {
    const r = rig(ctx).srand, ws = crusher(ctx), sq = gain(ctx, 0.6), chop = ctx.createGain(), g = ctx.createGain();
    const end = env(g.gain, t, 0.3, 0.002, 0.22, 0.04);
    tone(ctx, out, t, { f: 140, f1: 40, glide: 0.18, a: 0.003, d: 0.32, peak: 0.5 }); // low thud
    const o = osc(ctx, sq, 'square', 440, t, end); // bit-crushed noise + random square stabs, chopped
    noise(ctx, ws, t, end);
    sq.connect(ws).connect(filt(ctx, 'bandpass', 1500, 0.5)).connect(chop).connect(g).connect(out);
    chop.gain.setValueAtTime(1, t);
    for (let i = 0, lv = 1; i < 12; i++) {
      const tt = t + i * 0.022, nv = r() < 0.4 ? 0.15 : 1; // 22 ms glitch slices
      o.frequency.setValueAtTime(180 + r() * 1500, tt);
      if (i) {
        chop.gain.setValueAtTime(lv, tt - 0.0015);
        chop.gain.linearRampToValueAtTime(nv, tt);
      }
      lv = nv;
    }
    return Math.max(end, t + 0.33);
  },
  explode(ctx, out, t, size = 0.5) {
    const s = clamp(num(size, 0.5), 0, 1), r = rig(ctx).srand, dur = 0.22 + 1.5 * s, wide = s > 0.45;
    for (const pn of wide ? [-0.6, 0.6] : [0]) {
      hiss(ctx, out, t, { type: 'lowpass', f: 1500 + 5000 * s, f1: 90 + 60 * s, sweep: dur, q: 1, a: 0.003, d: dur, peak: (0.22 + 0.28 * s) * (wide ? 0.75 : 1), pn });
    }
    let end = tone(ctx, out, t, { f: 160 - 50 * s, f1: 38, glide: 0.07 + 0.25 * s, a: 0.002, d: 0.16 + 0.45 * s, peak: 0.3 + 0.3 * s });
    if (s > 0.5) {
      end = tone(ctx, out, t + 0.02, { f: 70, f1: 24, glide: 1.4 * s, a: 0.02, d: 1.5 * s, peak: 0.45 * s }); // sub drop
      for (let i = 0; i < 7; i++) {
        tone(ctx, out, t + 0.05 + r() * 0.6 * s, { type: 'square', f: 300 + r() * 1800, d: 0.04, peak: 0.03, lp: 3000, pn: (r() - 0.5) * 1.2 }); // debris
      }
    }
    return Math.max(end, t + dur + 0.01);
  },
  dash(ctx, out, t) {
    const k = 1 + (rig(ctx).srand() - 0.5) * 0.1, bp = filt(ctx, 'bandpass', 500, 1.6), g = ctx.createGain(), p = pan(ctx, 0);
    const end = env(g.gain, t, 0.26, 0.05, 0.22);
    slide(bp.frequency, 500 * k, 3200 * k, t, t + 0.12);
    bp.frequency.exponentialRampToValueAtTime(1100 * k, t + 0.28);
    if (p.pan) {
      p.pan.setValueAtTime(-0.35, t);
      p.pan.linearRampToValueAtTime(0.35, t + 0.28);
    }
    noise(ctx, bp, t, end);
    bp.connect(g).connect(p).connect(out);
    tone(ctx, out, t, { f: 170, f1: 85, glide: 0.2, a: 0.03, d: 0.2, peak: 0.06 });
    return end;
  },
  echoSpawn(ctx, out, t) {
    const r = rig(ctx).srand, ws = crusher(ctx), lp = filt(ctx, 'lowpass', 900, 4), g = gain(ctx, 0.16);
    slide(lp.frequency, 900, 5000, t, t + 1.05);
    ws.connect(lp).connect(g).connect(out);
    send(ctx, g, 0.3);
    [45, 52, 57, 60, 64, 69, 72, 76, 81, 84, 88, 93].forEach((m, i) => {
      // rising A-minor arpeggio, accelerating, with "corrupted" semitone slips and stutters
      const tt = t + 1 - (1 - i / 12) ** 1.7, slip = r() < 0.25 ? (r() < 0.5 ? 1 : -1) : 0;
      tone(ctx, ws, tt, { type: 'triangle', f: mtof(m + slip), d: 0.07, peak: 0.9, det: (r() - 0.5) * 40 });
      if (r() < 0.3) tone(ctx, ws, tt + 0.03, { type: 'triangle', f: mtof(m + 12), d: 0.03, peak: 0.6 });
    });
    hiss(ctx, out, t, { f: 300, f1: 6000, sweep: 1.05, q: 2, a: 0.95, d: 0.06, peak: 0.08 }); // riser
    tone(ctx, out, t + 1.05, { f: 90, f1: 45, glide: 0.15, d: 0.3, peak: 0.3 }); // lock-in thump
    stab(ctx, out, t + 1.05, [57, 64], { peak: 0.04, d: 0.3, cut: 3000, cut1: 800 });
    return t + 1.4;
  },
  trainTick(ctx, out, t, p = 0) {
    const i = Math.round(clamp(num(p, 0), 0, 1) * 10), f = mtof(69 + 12 * Math.floor(i / 5) + PENTA[i % 5]);
    if (rig(ctx).srand() < 0.35) tone(ctx, out, t + 0.025, { f: f * 2, d: 0.02, peak: 0.025 }); // packet echo
    return tone(ctx, out, t, { type: 'square', f, f1: f * 1.5, glide: 0.02, a: 0.001, d: 0.03, peak: 0.03, lp: 3500 });
  },
  trainDone(ctx, out, t) {
    [76, 81, 83, 88].forEach((m, i) => tone(ctx, out, t + i * 0.06, { type: 'triangle', f: mtof(m), d: 0.6, peak: 0.07 }));
    tone(ctx, out, t + 0.18, { f: 55, a: 0.02, d: 0.9, peak: 0.18 });
    send(ctx, out, 0.25);
    // Asus2 with an opening filter: neither happy nor sad, just "compiled"
    return stab(ctx, out, t + 0.18, [45, 52, 59, 64, 69], { peak: 0.035, a: 0.02, hold: 0.25, d: 0.75, cut: 700, cut1: 3000, q: 2 });
  },
  predictBlip(ctx, out, t) {
    send(ctx, out, 0.6);
    return tone(ctx, out, t, { f: 1320, f1: 1250, glide: 0.25, a: 0.002, d: 0.28, peak: 0.04 });
  },
  uiHover: (ctx, out, t) => tone(ctx, out, t, { f: 1750, a: 0.002, d: 0.035, peak: 0.035 }),
  uiClick(ctx, out, t) {
    tone(ctx, out, t, { type: 'triangle', f: 880, d: 0.05, peak: 0.1 });
    return tone(ctx, out, t + 0.035, { type: 'triangle', f: 1320, d: 0.07, peak: 0.08 });
  },
  roundStart(ctx, out, t) {
    const h = t + 0.72, lp = filt(ctx, 'lowpass', 500, 3), g = ctx.createGain();
    tone(ctx, out, t, { type: 'triangle', f: mtof(81), d: 0.12, peak: 0.08 }); // "ready" blip
    hiss(ctx, out, t, { f: 400, f1: 5000, sweep: 0.7, q: 1.5, a: 0.68, d: 0.04, peak: 0.1 }); // noise riser
    slide(lp.frequency, 500, 3000, t, h);
    lp.connect(g).connect(out);
    env(g.gain, t, 0.06, 0.66, 0.05);
    for (const m of [57, 64, 69]) slide(osc(ctx, lp, 'sawtooth', mtof(m - 12), t, h + 0.06).frequency, mtof(m - 12), mtof(m), t, h); // saws rise an octave
    tone(ctx, out, h, { f: 150, f1: 45, glide: 0.12, d: 0.4, peak: 0.45 });
    hiss(ctx, out, h, { f: 1800, q: 0.8, d: 0.25, peak: 0.12 });
    return stab(ctx, out, h, [57, 60, 64, 69], { peak: 0.04, d: 0.45, cut: 2600, cut1: 500 });
  },
  roundClear(ctx, out, t) {
    stab(ctx, out, t, [53, 57, 60, 65], { peak: 0.04, d: 0.16, cut: 2600, cut1: 900 }); // F
    stab(ctx, out, t + 0.14, [55, 59, 62, 67], { peak: 0.04, d: 0.16, cut: 2600, cut1: 900 }); // G
    [72, 76, 79, 84].forEach((m, i) => tone(ctx, out, t + 0.28 + i * 0.07, { type: 'triangle', f: mtof(m), d: 0.35, peak: 0.06 }));
    send(ctx, out, 0.2);
    return stab(ctx, out, t + 0.28, [48, 60, 64, 67, 72], { peak: 0.04, a: 0.01, hold: 0.2, d: 0.7, cut: 3200, cut1: 700 }); // C
  },
  death(ctx, out, t) {
    const r = rig(ctx).srand, pre = gain(ctx, 0.9), g = ctx.createGain(), end = env(g.gain, t, 0.09, 0.005, 0.5, 0.7);
    const o = osc(ctx, pre, 'triangle', 880, t, end); // stair-stepped, bit-crushed descent
    for (let i = 0; i < 18; i++) o.frequency.setValueAtTime(880 * 2 ** (-i / 4.5) * (1 + (r() - 0.5) * 0.12), t + i * 0.065);
    pre.connect(crusher(ctx)).connect(filt(ctx, 'lowpass', 2400, 2)).connect(g).connect(out);
    tone(ctx, out, t, { type: 'sawtooth', f: 220, f1: 28, glide: 1.3, a: 0.01, hold: 0.3, d: 1, peak: 0.12, lp: 900 }); // tape-stop dive
    stab(ctx, out, t + 0.1, [33, 45], { peak: 0.08, a: 0.35, hold: 0.5, d: 0.75, cut: 260, cut1: 110, q: 4 }); // low drone
    send(ctx, out, 0.2);
    return t + 1.75;
  },
};

// name → [min gap between triggers (s), priority]; a new voice may steal the oldest of equal or lower priority.
const RULES = {
  shoot: [0.045, 1], echoShoot: [0.045, 1], enemyShoot: [0.05, 1], enemyHit: [0.025, 1],
  playerHurt: [0.08, 3], explode: [0.04, 2], dash: [0.06, 2], echoSpawn: [0.3, 3],
  trainTick: [0.03, 1], trainDone: [0.3, 3], predictBlip: [0.4, 1], uiHover: [0.03, 1],
  uiClick: [0.03, 2], roundStart: [0.3, 3], roundClear: [0.3, 3], death: [0.5, 4],
};

// ─── core: sequencer + sfx dispatch for one context (realtime or offline) ───
class Core {
  constructor(ctx, seed) {
    Object.assign(this, { ctx, R: buildRig(ctx, seed), voices: [], last: {}, bus: null });
    // music state; `silent` (muted) keeps time without creating nodes
    Object.assign(this, { playing: false, silent: false, step: 0, t0: 0, level: 0, pending: 0, needPad: false, padEnd: 0 });
  }

  startMusic(t) {
    if (this.playing) return;
    const { ctx, R } = this;
    const mk = (rev, dly) => {
      const g = gain(ctx, 1); // per-session bus so stopMusic can fade everything (sends included)
      g.connect(R.musicIn);
      if (rev) g.connect(gain(ctx, rev)).connect(R.revIn);
      if (dly) g.connect(gain(ctx, dly)).connect(R.dlyIn);
      return g;
    };
    this.bus = { dry: mk(0, 0), room: mk(0.5, 0), echo: mk(0.3, 0.4) };
    Object.assign(this, { playing: true, step: 0, t0: t, level: this.pending, needPad: false, padEnd: 0 });
  }

  stopMusic(t) {
    if (!this.playing) return;
    this.playing = false;
    for (const k in this.bus) this.bus[k].gain.setTargetAtTime(0, t, 0.15);
    this.bus = null;
  }

  setIntensity(level) {
    this.pending = level; // lands on the next bar
    if (!this.playing) this.level = level;
  }

  setDuck(a, t) {
    this.R.duckLP.detune.setTargetAtTime(-7200 * a, t, 0.12); // 20 kHz → ~310 Hz as a log sweep, ~0.4 s
    this.R.duckG.gain.setTargetAtTime(1 - 0.6 * a, t, 0.12);
  }

  /** Schedule every step before `until`. `now` (realtime only) enables skip-ahead after stalls. */
  advance(until, now) {
    if (!this.playing) return;
    let t = this.t0 + this.step * STEP;
    if (now !== undefined && t < now) {
      this.step += Math.ceil((now - t) / STEP); // fell behind (hidden tab / long frame): skip, never burst
      this.needPad = true;
      t = this.t0 + this.step * STEP;
    }
    for (; t < until; t = this.t0 + ++this.step * STEP) this._play(this.step, t);
  }

  _play(step, t) {
    const s = step % LOOP, sb = s % BAR, bar = s >> 4, resync = this.needPad;
    if (sb === 0 || resync) this.level = this.pending;
    this.needPad = this.silent; // muted: keep time only, resync the pad once sound returns
    if (this.silent) return;
    const { ctx } = this, B = this.bus, L = this.level, ch = CHORDS[bar >> 1], rnd = this.R.mrand;

    // pad on every chord change, or right away after a resync if the previous one has ended
    if (s % 32 === 0 || (resync && t >= this.padEnd)) {
      this.padEnd = pad(ctx, B.room, t, ch.pad, (32 - (s % 32)) * STEP, [950, 1000, 1200, 1500][L], s % 32 ? 0.3 : 1.2, [0.05, 0.04, 0.034, 0.034][L]);
    }
    if (L === 0 && sb % 8 === 0) tone(ctx, B.dry, t, { type: 'triangle', f: mtof(ch.bass), a: 0.12, hold: 0.15, d: 0.8, peak: 0.1, lp: 240 }); // slow sub pulse
    const ai = L >= 2 ? ARP_FAST[sb % 8] : ARP_SLOW[sb];
    if (ai >= 0) {
      const m = ai < 4 ? ch.pad[ai] + 12 : ch.pad[ai - 3] + 24;
      pluck(ctx, B.echo, t, m, (sb % 4 ? 0.055 : 0.07) * [1.3, 1.1, 0.85, 0.85][L], [900, 1100, 2000, 2800][L], sb % 2 ? 0.25 : -0.25);
    }
    if (L < 2 && rnd() < 0.05) {
      tone(ctx, B.echo, t, { f: mtof(81 + PENTA[(rnd() * 5) | 0] + 12 * ((rnd() * 2) | 0)), a: 0.002, d: 0.05, peak: 0.018 }); // lab blips
    }
    if (L < 1) return;

    if (sb % 4 === 0) kick(ctx, B.dry, t, [0, 0.5, 0.7, 0.8][L]);
    if (L >= 2 || sb % 2 === 0) {
      const v = L >= 2 ? PUMP[sb % 4] : sb % 4 ? 1 : 0.45;
      bass(ctx, B.dry, t, ch.bass + 12 + (sb % 8 === 6 ? 12 : 0), v, (L >= 2 ? 0.85 : 1.7) * STEP, [0, 300, 420, 650][L]);
    }
    if (sb % 4 === 2) hat(ctx, B.dry, t, L >= 2, L >= 2 ? 0.05 : 0.045);
    else if (L === 3 || (L === 2 && sb % 4 === 0)) hat(ctx, B.dry, t, false, (sb % 2 ? 0.032 : 0.045) * (0.85 + 0.3 * rnd()));
    if (L < 2) return;

    if (sb === 4 || sb === 12) clap(ctx, B.room, t, 0.2);
    if (s % 64 === 0) hiss(ctx, B.room, t, { f: 6000, q: 0.5, a: 0.002, d: 1.3, peak: 0.035 }); // soft crash per phrase
    if (bar % 4 === 3 && sb === 12) glitchFill(ctx, B.echo, t, rnd, ch);
    if (L >= 3 && LEAD[s]) lead(ctx, B.echo, t, LEAD[s][0], LEAD[s][1] * STEP);
  }

  sfx(name, t, args = []) {
    const rule = RULES[name];
    if (!rule) return;
    const big = name === 'explode' && num(args[0], 0.5) >= 0.6, key = big ? 'boom' : name, prio = big ? 3 : rule[1];
    if (t - (this.last[key] ?? -1) < rule[0]) return; // rate limit
    const vs = this.voices.filter((v) => v.end > t);
    if (vs.length >= MAX_VOICES) {
      const i = vs.findIndex((v) => v.prio <= prio); // oldest stealable voice, else drop the new one
      if (i < 0) return void (this.voices = vs);
      vs[i].out.gain.setTargetAtTime(0, t, 0.006);
      vs.splice(i, 1);
    }
    const out = gain(this.ctx, 1);
    out.connect(this.R.sfx);
    vs.push({ end: VOICES[name](this.ctx, out, t, ...args), prio, out });
    this.voices = vs;
    this.last[key] = t;
  }

  dispatch(name, t, args) {
    if (name === 'startMusic') this.startMusic(t);
    else if (name === 'stopMusic') this.stopMusic(t);
    else if (name === 'setIntensity') this.setIntensity(toLevel(args[0]));
    else if (name === 'setDuck') this.setDuck(clamp(num(args[0], 0), 0, 1), t);
    else if (name === 'setMasterVolume') this.R.master.gain.setTargetAtTime(clamp(num(args[0], 0.8), 0, 1), t, 0.02);
    else this.sfx(name, t, args);
  }
}

// ─── public API ─────────────────────────────────────────────────────────────
export class AudioEngine {
  /** @param {{suspendWhenHidden?: boolean}} [opts] suspend the AudioContext while the tab is hidden (default true) */
  constructor(opts = {}) {
    Object.assign(this, { _ctx: null, _core: null, _muted: false, _vol: 0.8, _music: false, _level: 0, _duck: 0, _hidden: false });
    this._hideSuspend = opts.suspendWhenHidden !== false;
    this._onVis = () => {
      const ctx = this._ctx;
      if (!ctx || !this._hideSuspend) return;
      if (document.hidden && ctx.state === 'running') {
        this._hidden = true;
        quiet(ctx.suspend());
      } else if (!document.hidden && this._hidden) {
        this._hidden = false;
        quiet(ctx.resume());
      }
    };
  }

  /** Create/resume the AudioContext. Idempotent: call it from every click/keydown. */
  init() {
    try {
      const hasDoc = typeof document !== 'undefined';
      if (!this._ctx) {
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AC) return;
        const ctx = create(AC, { latencyHint: 'interactive' }, []), c = new Core(ctx), now = ctx.currentTime;
        Object.assign(this, { _ctx: ctx, _core: c });
        c.silent = this._muted;
        c.R.master.gain.setTargetAtTime(this._muted ? 0 : this._vol, now, 0.05);
        c.setIntensity(this._level);
        c.setDuck(this._duck, now);
        if (this._music) c.startMusic(now + 0.06);
        setInterval(() => this._tick(), TICK_MS);
        if (hasDoc) document.addEventListener('visibilitychange', this._onVis);
      }
      if (this._ctx.state !== 'running' && !(hasDoc && document.hidden)) quiet(this._ctx.resume());
    } catch (e) {
      warn(e);
    }
  }

  get ready() { return !!this._ctx && this._ctx.state === 'running'; }
  get muted() { return this._muted; }
  /** Mute ramps the master out; sfx become no-ops, the music keeps time silently. */
  setMuted(m) {
    this._muted = !!m;
    if (this._core) this._core.silent = this._muted;
    this._applyVolume();
  }
  toggleMute() { this.setMuted(!this._muted); return this._muted; }
  setMasterVolume(v) {
    this._vol = clamp(num(v, this._vol), 0, 1);
    this._applyVolume();
  }

  // ---- music ----
  startMusic() {
    this._music = true;
    this._run((c, now) => {
      if (c.playing) return;
      c.startMusic(now + 0.06);
      this._tick();
    });
  }
  stopMusic() {
    this._music = false;
    this._run((c, now) => c.stopMusic(now));
  }
  /** 0 menu · 1 calibration · 2 echo fight · 3 high intensity / multi-echo. Lands on the next bar. */
  setIntensity(level) {
    this._level = toLevel(level);
    this._run((c) => c.setIntensity(this._level));
  }
  /** 0..1 — 1 = heavily low-passed, quieter music (training interlude, pause). ~0.4 s ramp. */
  setDuck(amount) {
    this._duck = clamp(num(amount, 0), 0, 1);
    this._run((c, now) => c.setDuck(this._duck, now));
  }

  // ---- sfx (fire-and-forget; rate-limited and voice-capped inside) ----
  shoot() { this._sfx('shoot'); }
  echoShoot() { this._sfx('echoShoot'); }
  enemyShoot() { this._sfx('enemyShoot'); }
  enemyHit() { this._sfx('enemyHit'); }
  playerHurt() { this._sfx('playerHurt'); }
  explode(size = 0.5) { this._sfx('explode', [size]); }
  dash() { this._sfx('dash'); }
  echoSpawn() { this._sfx('echoSpawn'); }
  trainTick(p = 0) { this._sfx('trainTick', [p]); }
  trainDone() { this._sfx('trainDone'); }
  predictBlip() { this._sfx('predictBlip'); }
  uiHover() { this._sfx('uiHover'); }
  uiClick() { this._sfx('uiClick'); }
  roundStart() { this._sfx('roundStart'); }
  roundClear() { this._sfx('roundClear'); }
  death() { this._sfx('death'); }

  // ---- offline render (trailer) ----
  /**
   * Render music + sfx into a 16-bit stereo WAV (ArrayBuffer). `events`: [{ t, name, args }] where name is any sfx
   * method, 'startMusic', 'stopMusic', 'setIntensity' [level], 'setDuck' [amount] or 'setMasterVolume' [v].
   * Uses the current master volume (not mute). Deterministic per `seed`; resolves to null without OfflineAudioContext.
   */
  async renderOfflineWav({ duration, sampleRate = 48000, events = [], seed = 0x5e1f } = {}) {
    const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext, dur = num(duration, 0);
    if (!OAC || dur <= 0) return null;
    const length = Math.ceil(dur * sampleRate), ctx = create(OAC, { numberOfChannels: 2, length, sampleRate }, [2, length, sampleRate]);
    const core = new Core(ctx, seed >>> 0), evs = (events || []).filter((e) => e && Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
    core.R.master.gain.value = this._vol;
    let i = 0;
    const scheduleTo = (T) => {
      for (; i < evs.length && evs[i].t < T; i++) {
        const t = Math.max(0, evs[i].t);
        core.advance(t);
        core.dispatch(evs[i].name, t, [].concat(evs[i].args ?? []));
      }
      core.advance(T);
    };
    // Build the graph in 1 s chunks, always ≥1 s ahead of the render, so long renders stay light on memory.
    // Without offline suspend (e.g. Firefox) everything is simply scheduled up front.
    let first = dur;
    if (typeof ctx.suspend === 'function') {
      try {
        for (let s = 1; s < dur; s++) ctx.suspend(s).then(() => (scheduleTo(Math.min(dur, s + 2)), ctx.resume()));
        first = Math.min(dur, 2);
      } catch {} // on a partial failure the remainder is scheduled up front as well
    }
    scheduleTo(first);
    const buf = await new Promise((res, rej) => {
      ctx.oncomplete = (e) => res(e.renderedBuffer);
      const p = ctx.startRendering();
      if (p && p.then) p.then(res, rej);
    });
    return encodeWav(buf);
  }

  // ---- internals ----
  _run(fn) {
    try {
      if (this._core) fn(this._core, this._ctx.currentTime);
    } catch (e) {
      warn(e); // never let audio break the game
    }
  }
  _sfx(name, args) {
    if (!this._core || this._muted || this._ctx.state !== 'running') return;
    this._run((c, now) => c.sfx(name, now + SFX_LEAD, args));
  }
  _tick() {
    if (this._ctx && this._ctx.state === 'running') this._run((c, now) => c.advance(now + AHEAD, now));
  }
  _applyVolume() {
    this._run((c, now) => c.R.master.gain.setTargetAtTime(this._muted ? 0 : this._vol, now, 0.02));
  }
}

/** AudioBuffer (or anything with numberOfChannels/length/sampleRate/getChannelData) → 16-bit PCM WAV. */
export function encodeWav(buffer) {
  const ch = buffer.numberOfChannels, n = buffer.length, sr = buffer.sampleRate, bytes = n * ch * 2;
  const out = new ArrayBuffer(44 + bytes), v = new DataView(out);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + bytes, true);
  str(8, 'WAVEfmt ');
  [[16, 16, 4], [20, 1, 2], [22, ch, 2], [24, sr, 4], [28, sr * ch * 2, 4], [32, ch * 2, 2], [34, 16, 2]].forEach(([o, val, size]) =>
    size === 4 ? v.setUint32(o, val, true) : v.setUint16(o, val, true)); // fmt chunk: PCM, channels, rate, byte rate, align, bits
  str(36, 'data');
  v.setUint32(40, bytes, true);
  const data = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
  for (let i = 0, o = 44; i < n; i++) {
    for (let c = 0; c < ch; c++, o += 2) v.setInt16(o, Math.round((clamp(data[c][i], -1, 1) || 0) * 32767), true);
  }
  return out;
}
