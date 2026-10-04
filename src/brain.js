// Everything that turns gameplay into training data and back into behaviour.
//
// The world is described from the point of view of whoever is acting, in a frame
// anchored on the line to their target: +z = "towards target", +x = "to my right".
// Expressing state and actions in that frame makes the learned style rotation
// invariant — "strafes right around whoever it fights", not "likes the east wall".

import { ARENA_R, SAMPLE_HZ } from './config.js';
import { MLP, Trainer, N_MOVE, N_OUT, moveProbs, argmaxMove, sigmoid } from './nn.js';

export const DIM = 16;
export const HIDDEN = [24, 24];
export const PREV_MOVE = [12, 13];
export const FEATURE_GROUPS = [
  { name: 'TARGET', from: 0, to: 3 },
  { name: 'ARENA', from: 4, to: 6 },
  { name: 'THREAT', from: 7, to: 11 },
  { name: 'HABIT', from: 12, to: 15 },
];
export const OUTPUT_NAMES = ['IDLE', 'FWD', 'FWD-R', 'RIGHT', 'BACK-R', 'BACK', 'BACK-L', 'LEFT', 'FWD-L', 'DASH', 'SHOOT'];

export function newNet() {
  return new MLP([DIM, ...HIDDEN, N_OUT]);
}

// Local direction of movement class k (1..8); 0 is idle.
const DIRS = [[0, 0]];
for (let k = 0; k < 8; k++) {
  const a = (k * Math.PI) / 4;
  DIRS.push([Math.sin(a), Math.cos(a)]);
}
export const classDir = (k) => DIRS[k];

export function moveClassFromLocal(lx, lz) {
  if (Math.hypot(lx, lz) < 0.3) return 0;
  const a = Math.atan2(lx, lz);
  let k = Math.round(a / (Math.PI / 4));
  k = ((k % 8) + 8) % 8;
  return k + 1;
}

export class Frame {
  constructor() {
    this.fx = 0;
    this.fz = -1;
    this.rx = 1;
    this.rz = 0;
  }
  set(fx, fz) {
    this.fx = fx;
    this.fz = fz;
    this.rx = -fz;
    this.rz = fx;
  }
  toLocal(x, z, out) {
    out.x = x * this.rx + z * this.rz;
    out.z = x * this.fx + z * this.fz;
    return out;
  }
  toWorld(lx, lz, out) {
    out.x = lx * this.rx + lz * this.fx;
    out.z = lx * this.rz + lz * this.fz;
    return out;
  }
}

const L = { x: 0, z: 0 };

// Fill `out` (Float32Array(DIM)) with the actor's view of the world.
// self/target: { x, z, vx, vz }. threats: bullets aimed at self ({ x, z, vx, vz }).
// Returns the threat distance (or Infinity) so callers can log it.
export function extractFeatures(out, frame, self, target, threats, prevMoveX, prevMoveZ, dashReady, hpFrac) {
  let dx = target.x - self.x;
  let dz = target.z - self.z;
  let dist = Math.hypot(dx, dz);
  if (dist < 1e-4) {
    dx = 0;
    dz = -1;
    dist = 1e-4;
  }
  frame.set(dx / dist, dz / dist);

  out[0] = Math.min(dist / 20, 1.5);
  out[1] = 1 / (1 + dist / 3);
  frame.toLocal(target.vx, target.vz, L);
  out[2] = L.x / 10;
  out[3] = L.z / 10;
  frame.toLocal(-self.x, -self.z, L);
  out[4] = L.x / ARENA_R;
  out[5] = L.z / ARENA_R;
  out[6] = Math.hypot(self.x, self.z) / ARENA_R;

  let best = null;
  let bestD = 10;
  for (let i = 0; i < threats.length; i++) {
    const b = threats[i];
    const bx = b.x - self.x;
    const bz = b.z - self.z;
    const d = Math.hypot(bx, bz);
    if (d < bestD && b.vx * -bx + b.vz * -bz > 0) {
      best = b;
      bestD = d;
    }
  }
  if (best) {
    frame.toLocal(best.x - self.x, best.z - self.z, L);
    out[7] = L.x / 10;
    out[8] = L.z / 10;
    frame.toLocal(best.vx, best.vz, L);
    out[9] = L.x / 30;
    out[10] = L.z / 30;
    out[11] = 1 / (1 + bestD / 2);
  } else {
    out[7] = out[8] = out[9] = out[10] = out[11] = 0;
  }

  frame.toLocal(prevMoveX, prevMoveZ, L);
  out[12] = L.x;
  out[13] = L.z;
  out[14] = dashReady ? 1 : 0;
  out[15] = hpFrac;
  return best ? bestD : Infinity;
}

// ---------------------------------------------------------------------------
// Recorder: a growing log of (state, action) pairs plus a little raw telemetry
// for the playstyle profile.

export class Recorder {
  constructor(cap = 6000) {
    this.cap = cap;
    this.X = new Float32Array(cap * DIM);
    this.move = new Uint8Array(cap);
    this.dash = new Uint8Array(cap);
    this.shoot = new Uint8Array(cap);
    this.round = new Uint8Array(cap);
    this.dist = new Float32Array(cap);
    this.threat = new Float32Array(cap);
    this.n = 0;
    this.total = 0; // lifetime count, including any samples dropped from the buffer
  }

  clear() {
    this.n = 0;
    this.total = 0;
  }

  add(features, move, dash, shoot, round, dist, threatDist) {
    if (this.n === this.cap) this.dropOldest(Math.floor(this.cap / 4));
    const i = this.n++;
    this.X.set(features, i * DIM);
    this.move[i] = move;
    this.dash[i] = dash ? 1 : 0;
    this.shoot[i] = shoot ? 1 : 0;
    this.round[i] = round;
    this.dist[i] = dist;
    this.threat[i] = threatDist;
    this.total++;
  }

  dropOldest(k) {
    this.X.copyWithin(0, k * DIM, this.n * DIM);
    for (const a of [this.move, this.dash, this.shoot, this.round, this.dist, this.threat]) a.copyWithin(0, k, this.n);
    this.n -= k;
  }

  dataset() {
    return { X: this.X, move: this.move, dash: this.dash, shoot: this.shoot, n: this.n, dim: DIM };
  }
}

// Build a trainer for a fresh network on everything recorded so far.
export function makeTrainer(recorder, epochs = 36) {
  const net = newNet();
  const trainer = new Trainer(net, recorder.dataset(), {
    epochs,
    lr: 0.007,
    batch: 32,
    dropFeatures: PREV_MOVE,
    dropP: 0.3,
  });
  return trainer;
}

// ---------------------------------------------------------------------------
// Policy: run the net and sample an action. `out` receives { move, dash, shoot, probs, confidence }.

export function decide(net, features, temperature, rng, out) {
  const o = net.forward(features);
  const probs = moveProbs(o, temperature, out.probs);
  let r = rng();
  let k = 0;
  for (; k < N_MOVE - 1; k++) {
    r -= probs[k];
    if (r <= 0) break;
  }
  out.move = k;
  out.dashP = sigmoid(o[N_MOVE]);
  out.shootP = sigmoid(o[N_MOVE + 1]);
  out.argmax = argmaxMove(o);
  return out;
}

export function newDecision() {
  return { move: 0, dashP: 0, shootP: 0, argmax: 0, probs: new Float32Array(N_MOVE) };
}

// Expected local velocity direction under the predicted distribution.
export function expectedLocalDir(probs, out) {
  let x = 0;
  let z = 0;
  for (let k = 1; k < N_MOVE; k++) {
    x += probs[k] * DIRS[k][0];
    z += probs[k] * DIRS[k][1];
  }
  out.x = x;
  out.z = z;
  return out;
}

// ---------------------------------------------------------------------------
// Rolling "how predictable are you right now" meter.

export class Predictability {
  constructor(win = 45) {
    this.buf = new Uint8Array(win);
    this.i = 0;
    this.n = 0;
    this.sum = 0;
    this.allHits = 0;
    this.allN = 0;
  }
  reset() {
    this.buf.fill(0);
    this.i = this.n = this.sum = 0;
  }
  push(hit) {
    const v = hit ? 1 : 0;
    if (this.n === this.buf.length) this.sum -= this.buf[this.i];
    else this.n++;
    this.buf[this.i] = v;
    this.sum += v;
    this.i = (this.i + 1) % this.buf.length;
    this.allHits += v;
    this.allN++;
  }
  get value() {
    return this.n ? this.sum / this.n : 0;
  }
  get overall() {
    return this.allN ? this.allHits / this.allN : 0;
  }
}

// ---------------------------------------------------------------------------
// Playstyle profile — the "what the AI thinks of you" card.

export const ARCHETYPES = [
  { id: 'berserker', name: 'THE BERSERKER', blurb: 'Closes the gap. Always. Your Echo will come straight for you.' },
  { id: 'phantom', name: 'THE PHANTOM', blurb: 'Dash-happy and hard to pin down. So is the thing you just taught.' },
  { id: 'orbiter', name: 'THE ORBITER', blurb: 'Circles its prey like a moon. Your Echo learned which way.' },
  { id: 'sniper', name: 'THE SNIPER', blurb: 'Keeps its distance and makes the shots count.' },
  { id: 'turret', name: 'THE TURRET', blurb: 'Plants its feet and lets the bullets do the walking.' },
  { id: 'wildcard', name: 'THE WILDCARD', blurb: 'Chaos on purpose. The network is struggling. Good.' },
];

export const TRAITS = ['AGGRESSION', 'MOBILITY', 'EVASION', 'ACCURACY', 'ORBIT', 'CHAOS'];

const RIGHTISH = new Set([2, 3, 4]); // local right = counter-clockwise around the target on screen
const LEFTISH = new Set([6, 7, 8]);
const TOWARD = new Set([1, 2, 8]);
const AWAY = new Set([4, 5, 6]);

export function buildProfile(rec, shots, hits) {
  const n = rec.n;
  if (n < 10) return null;
  const counts = new Float32Array(N_MOVE);
  let right = 0;
  let left = 0;
  let toward = 0;
  let away = 0;
  let dashes = 0;
  let shooting = 0;
  let switches = 0;
  const dashThreats = [];
  const dists = [];
  for (let i = 0; i < n; i++) {
    const m = rec.move[i];
    counts[m]++;
    if (RIGHTISH.has(m)) right++;
    if (LEFTISH.has(m)) left++;
    if (TOWARD.has(m)) toward++;
    if (AWAY.has(m)) away++;
    if (rec.dash[i]) {
      dashes++;
      if (Number.isFinite(rec.threat[i])) dashThreats.push(rec.threat[i]);
    }
    if (rec.shoot[i]) shooting++;
    if (i > 0 && rec.round[i] === rec.round[i - 1] && m !== rec.move[i - 1]) switches++;
    dists.push(rec.dist[i]);
  }
  dists.sort((a, b) => a - b);
  const medianDist = dists[Math.floor(n / 2)];
  const seconds = n / SAMPLE_HZ;
  const idleFrac = counts[0] / n;
  const lateral = right + left;
  const ccw = lateral > 0 ? right / lateral : 0.5;
  let entropy = 0;
  for (let k = 0; k < N_MOVE; k++) {
    const p = counts[k] / n;
    if (p > 0) entropy -= p * Math.log(p);
  }
  entropy /= Math.log(N_MOVE);
  const switchRate = switches / Math.max(1, n - 1);
  const dashRate = dashes / seconds;
  const accuracy = shots > 0 ? hits / shots : 0;

  const clamp = (v) => Math.max(0, Math.min(1, v));
  const traits = {
    AGGRESSION: clamp(((15 - medianDist) / 11) * 0.65 + ((toward - away) / n) * 0.7 + 0.15),
    MOBILITY: clamp((1 - idleFrac) * 1.05),
    EVASION: clamp(dashRate / 0.75),
    ACCURACY: clamp(accuracy * 1.6),
    ORBIT: clamp(Math.abs(ccw - 0.5) * 2.4 * Math.min(1, (lateral / n) * 2.2)),
    CHAOS: clamp(entropy * 0.55 + switchRate * 1.4),
  };

  const scores = {
    berserker: traits.AGGRESSION * 1.05,
    phantom: traits.EVASION,
    orbiter: traits.ORBIT * 1.08,
    sniper: traits.ACCURACY * 0.6 + (1 - traits.AGGRESSION) * 0.45,
    turret: (1 - traits.MOBILITY) * 1.2,
    wildcard: traits.CHAOS * 0.95,
  };
  let archetype = ARCHETYPES[0];
  for (const a of ARCHETYPES) if (scores[a.id] > scores[archetype.id]) archetype = a;

  // Insights: concrete, numeric observations ranked by how distinctive they are.
  const insights = [];
  const pct = (v) => Math.round(v * 100);
  if (lateral / n > 0.15) {
    const dir = ccw >= 0.5 ? 'counter-clockwise' : 'clockwise';
    const share = ccw >= 0.5 ? ccw : 1 - ccw;
    insights.push({ w: Math.abs(ccw - 0.5) * 2 + 0.2, text: `You circle <b>${dir}</b> ${pct(share)}% of the time.` });
  }
  insights.push({ w: 0.55, text: `You like to fight from <b>~${Math.round(medianDist)} m</b> away.` });
  if (dashes >= 2) {
    const every = seconds / dashes;
    let t = `You dash about every <b>${every.toFixed(1)} s</b>`;
    if (dashThreats.length >= 2) {
      dashThreats.sort((a, b) => a - b);
      t += ` — mostly when a bullet is <b>${dashThreats[Math.floor(dashThreats.length / 2)].toFixed(1)} m</b> away`;
    }
    insights.push({ w: 0.5 + Math.min(0.5, dashRate), text: t + '.' });
  } else {
    insights.push({ w: 0.6, text: `You almost never dash. Your Echo won't either.` });
  }
  if (idleFrac > 0.08) insights.push({ w: idleFrac * 2, text: `You stand still <b>${pct(idleFrac)}%</b> of the time.` });
  if (shots > 20) insights.push({ w: Math.abs(accuracy - 0.35) * 1.5, text: `Your shots land <b>${pct(accuracy)}%</b> of the time.` });
  insights.push({ w: 0.4 + Math.abs(toward - away) / n, text: toward > away ? `You push forward more than you retreat.` : `You back off more than you push.` });
  insights.sort((a, b) => b.w - a.w);

  return {
    archetype,
    traits,
    insights: insights.slice(0, 3).map((i) => i.text),
    stats: { samples: rec.total, seconds, medianDist, ccw, dashRate, accuracy, idleFrac, entropy },
  };
}

// ---------------------------------------------------------------------------
// Echo personalities: each generation takes one trait from your recorded data,
// and the trait tunes how that Echo plays (multipliers on the ECHO defaults).

export const PERSONALITIES = {
  strafer: {
    name: 'THE STRAFER',
    mods: { speed: 1.1, temperature: 0.7 },
    line: (p) => `learned that you circle ${p.stats.ccw >= 0.5 ? 'counter-clockwise' : 'clockwise'}`,
  },
  dasher: {
    name: 'THE DASHER',
    mods: { dashCooldown: 0.6, dashProb: 1.8 },
    line: (p) => `learned that you dash every ${(1 / Math.max(0.05, p.stats.dashRate)).toFixed(1)} s`,
  },
  sniper: {
    name: 'THE SNIPER',
    mods: { aimNoise: 0.45, bulletSpeed: 1.25, fireRate: 0.85 },
    line: (p) => `learned that you land ${Math.round(p.stats.accuracy * 100)}% of your shots`,
  },
  brawler: {
    name: 'THE BRAWLER',
    mods: { speed: 1.15, hp: 1.2 },
    line: (p) => `learned that you fight from ~${Math.round(p.stats.medianDist)} m`,
  },
  turret: {
    name: 'THE TURRET',
    mods: { fireRate: 1.4, speed: 0.85 },
    line: (p) => `learned that you stand still ${Math.round(p.stats.idleFrac * 100)}% of the time`,
  },
  wildcard: {
    name: 'THE WILDCARD',
    mods: { temperature: 1.1 },
    line: () => "learned that you're hard to read",
  },
};

// Strongest trait wins; a trait already given to an earlier generation is
// skipped if another one is nearly as strong, so generations feel different.
export function echoPersonality(profile, used = []) {
  if (!profile) return { id: 'copycat', name: 'THE COPYCAT', line: 'learned your every move', mods: {} };
  const t = profile.traits;
  const score = {
    strafer: t.ORBIT * 1.05,
    dasher: t.EVASION,
    sniper: t.ACCURACY * 0.95,
    brawler: t.AGGRESSION * 0.9,
    turret: (1 - t.MOBILITY) * 1.1,
    wildcard: t.CHAOS * 0.85,
  };
  const ranked = Object.keys(score).sort((a, b) => score[b] - score[a]);
  let pick = ranked[0];
  if (used.includes(pick)) {
    const alt = ranked.find((k) => !used.includes(k) && score[k] >= score[ranked[0]] * 0.6);
    if (alt) pick = alt;
  }
  const P = PERSONALITIES[pick];
  return { id: pick, name: P.name, line: P.line(profile), mods: P.mods };
}
