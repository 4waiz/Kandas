// A tiny multi-layer perceptron, trained with Adam, written from scratch so the
// whole "learn the player" loop runs in the browser with no dependencies.
//
// Output heads: 9-way softmax for movement (idle + 8 directions), then two
// sigmoids: dash and shoot.

import { rand, gauss } from './rng.js';

export const N_MOVE = 9;
export const N_OUT = N_MOVE + 2;
const DASH = N_MOVE;
const SHOOT = N_MOVE + 1;
const W_DASH = 0.6;
const W_SHOOT = 0.3;

export const sigmoid = (x) => 1 / (1 + Math.exp(-x));

export class MLP {
  constructor(sizes) {
    this.sizes = sizes.slice();
    this.W = [];
    this.b = [];
    for (let l = 0; l < sizes.length - 1; l++) {
      const nin = sizes[l];
      const nout = sizes[l + 1];
      const lim = Math.sqrt(6 / (nin + nout)); // Xavier/Glorot uniform
      const w = new Float32Array(nin * nout);
      for (let i = 0; i < w.length; i++) w[i] = (rand() * 2 - 1) * lim;
      this.W.push(w);
      this.b.push(new Float32Array(nout));
    }
    // Per-layer activations; acts[0] is the input. Read by the brain visualiser.
    this.acts = sizes.map((n) => new Float32Array(n));
  }

  get layers() {
    return this.W.length;
  }

  get paramCount() {
    let n = 0;
    for (let l = 0; l < this.W.length; l++) n += this.W[l].length + this.b[l].length;
    return n;
  }

  forward(x) {
    const L = this.W.length;
    this.acts[0].set(x);
    for (let l = 0; l < L; l++) {
      const nin = this.sizes[l];
      const nout = this.sizes[l + 1];
      const a = this.acts[l];
      const z = this.acts[l + 1];
      const W = this.W[l];
      const b = this.b[l];
      const hidden = l < L - 1;
      for (let o = 0; o < nout; o++) {
        let s = b[o];
        const row = o * nin;
        for (let i = 0; i < nin; i++) s += W[row + i] * a[i];
        z[o] = hidden ? Math.tanh(s) : s;
      }
    }
    return this.acts[L];
  }

  copyFrom(other) {
    for (let l = 0; l < this.W.length; l++) {
      this.W[l].set(other.W[l]);
      this.b[l].set(other.b[l]);
    }
    return this;
  }

  clone() {
    return new MLP(this.sizes).copyFrom(this);
  }
}

// Softmax over the movement logits with a temperature.
export function moveProbs(out, temp = 1, into = new Float32Array(N_MOVE)) {
  let m = -Infinity;
  for (let k = 0; k < N_MOVE; k++) m = Math.max(m, out[k] / temp);
  let sum = 0;
  for (let k = 0; k < N_MOVE; k++) {
    const e = Math.exp(out[k] / temp - m);
    into[k] = e;
    sum += e;
  }
  for (let k = 0; k < N_MOVE; k++) into[k] /= sum;
  return into;
}

export function argmaxMove(out) {
  let best = 0;
  for (let k = 1; k < N_MOVE; k++) if (out[k] > out[best]) best = k;
  return best;
}

// ---------------------------------------------------------------------------
// Training

export class Trainer {
  // data: { X: Float32Array(n*dim), move: Uint8Array, dash: Uint8Array, shoot: Uint8Array, n, dim }
  constructor(net, data, opts = {}) {
    this.net = net;
    this.data = data;
    this.lr = opts.lr ?? 0.006;
    this.batch = opts.batch ?? 32;
    this.epochs = opts.epochs ?? 40;
    this.wd = opts.weightDecay ?? 4e-4;
    this.dropFeatures = opts.dropFeatures ?? [];
    this.dropP = opts.dropP ?? 0.3;
    this.noise = opts.noise ?? 0.01;

    const idx = shuffled(data.n);
    const nVal = data.n >= 80 ? Math.floor(data.n * 0.15) : 0;
    this.valIdx = idx.slice(0, nVal);
    this.trainIdx = idx.slice(nVal);
    this.stepsPerEpoch = Math.max(1, Math.ceil(this.trainIdx.length / this.batch));
    this.totalSteps = this.stepsPerEpoch * this.epochs;

    const z = (arr) => arr.map((a) => new Float32Array(a.length));
    this.gW = z(net.W);
    this.gb = z(net.b);
    this.mW = z(net.W);
    this.vW = z(net.W);
    this.mb = z(net.b);
    this.vb = z(net.b);
    this.delta = net.sizes.map((n) => new Float32Array(n));
    this.x = new Float32Array(data.dim);
    this.p = new Float32Array(N_MOVE);

    this.t = 0;
    this.step = 0;
    this.cursor = 0;
    this.epoch = 0;
    this.lossHistory = [];
    this.epochLoss = 0;
    this.epochCount = 0;
    this.best = null;
    this.bestVal = Infinity;
    this.valAcc = 0;
    this.trainAcc = 0;
    this.done = this.trainIdx.length === 0;
    this.computeMs = 0;
  }

  get progress() {
    return Math.min(1, this.step / this.totalSteps);
  }

  // Run up to `maxSteps` minibatches. Returns true when training has finished.
  run(maxSteps = Infinity) {
    const t0 = performance.now();
    let n = 0;
    while (!this.done && n < maxSteps) {
      this.stepBatch();
      n++;
    }
    this.computeMs += performance.now() - t0;
    return this.done;
  }

  stepBatch() {
    const { net, data } = this;
    const L = net.layers;
    for (let l = 0; l < L; l++) {
      this.gW[l].fill(0);
      this.gb[l].fill(0);
    }
    let bs = 0;
    for (let k = 0; k < this.batch && this.cursor < this.trainIdx.length; k++, this.cursor++) {
      const i = this.trainIdx[this.cursor];
      this.loadSample(i, true);
      this.epochLoss += this.backprop(i);
      this.epochCount++;
      bs++;
    }
    if (bs > 0) this.adam(bs);
    this.step++;

    if (this.cursor >= this.trainIdx.length) {
      // End of epoch: log the loss, check validation, keep the best weights.
      this.lossHistory.push(this.epochLoss / Math.max(1, this.epochCount));
      this.epochLoss = 0;
      this.epochCount = 0;
      this.cursor = 0;
      shuffleInPlace(this.trainIdx);
      this.epoch++;
      const evalIdx = this.valIdx.length ? this.valIdx : this.trainIdx;
      const { loss, acc } = this.evaluate(evalIdx);
      this.valAcc = acc;
      if (loss < this.bestVal) {
        this.bestVal = loss;
        this.best = net.clone();
        this.bestAcc = acc;
      }
      if (this.epoch >= this.epochs) this.finish();
    }
  }

  loadSample(i, augment) {
    const { dim, X } = this.data;
    const x = this.x;
    for (let j = 0; j < dim; j++) x[j] = X[i * dim + j];
    if (!augment) return;
    // Input dropout on the "previous move" features stops the net from simply
    // copying its last action; small noise keeps it from memorising samples.
    if (this.dropFeatures.length && rand() < this.dropP) for (const j of this.dropFeatures) x[j] = 0;
    if (this.noise) for (let j = 0; j < dim; j++) x[j] += gauss() * this.noise;
  }

  backprop(i) {
    const { net, data, delta, p } = this;
    const L = net.layers;
    const out = net.forward(this.x);

    // Output-layer gradients.
    moveProbs(out, 1, p);
    const y = data.move[i];
    const dOut = delta[L];
    for (let k = 0; k < N_MOVE; k++) dOut[k] = p[k] - (k === y ? 1 : 0);
    let loss = -Math.log(p[y] + 1e-9);
    const sd = sigmoid(out[DASH]);
    const yd = data.dash[i];
    dOut[DASH] = (sd - yd) * W_DASH;
    loss -= W_DASH * (yd * Math.log(sd + 1e-9) + (1 - yd) * Math.log(1 - sd + 1e-9));
    const ss = sigmoid(out[SHOOT]);
    const ys = data.shoot[i];
    dOut[SHOOT] = (ss - ys) * W_SHOOT;
    loss -= W_SHOOT * (ys * Math.log(ss + 1e-9) + (1 - ys) * Math.log(1 - ss + 1e-9));

    // Backpropagate through the tanh layers.
    for (let l = L - 1; l >= 0; l--) {
      const nin = net.sizes[l];
      const nout = net.sizes[l + 1];
      const a = net.acts[l];
      const d = delta[l + 1];
      const W = net.W[l];
      const gW = this.gW[l];
      const gb = this.gb[l];
      for (let o = 0; o < nout; o++) {
        const g = d[o];
        if (g === 0) continue;
        const row = o * nin;
        for (let j = 0; j < nin; j++) gW[row + j] += g * a[j];
        gb[o] += g;
      }
      if (l > 0) {
        const dPrev = delta[l];
        for (let j = 0; j < nin; j++) {
          let s = 0;
          for (let o = 0; o < nout; o++) s += W[o * nin + j] * d[o];
          dPrev[j] = s * (1 - a[j] * a[j]);
        }
      }
    }
    return loss;
  }

  adam(bs) {
    const b1 = 0.9;
    const b2 = 0.999;
    const eps = 1e-8;
    this.t++;
    const c1 = 1 - Math.pow(b1, this.t);
    const c2 = 1 - Math.pow(b2, this.t);
    const lr = this.lr;
    const net = this.net;
    const upd = (P, G, M, V, decay) => {
      for (let i = 0; i < P.length; i++) {
        const g = G[i] / bs + decay * P[i];
        M[i] = b1 * M[i] + (1 - b1) * g;
        V[i] = b2 * V[i] + (1 - b2) * g * g;
        P[i] -= (lr * (M[i] / c1)) / (Math.sqrt(V[i] / c2) + eps);
      }
    };
    for (let l = 0; l < net.layers; l++) {
      upd(net.W[l], this.gW[l], this.mW[l], this.vW[l], this.wd);
      upd(net.b[l], this.gb[l], this.mb[l], this.vb[l], 0);
    }
  }

  evaluate(indices) {
    const { net, data } = this;
    let loss = 0;
    let correct = 0;
    for (const i of indices) {
      this.loadSample(i, false);
      const out = net.forward(this.x);
      moveProbs(out, 1, this.p);
      loss -= Math.log(this.p[data.move[i]] + 1e-9);
      if (argmaxMove(out) === data.move[i]) correct++;
    }
    const n = Math.max(1, indices.length);
    return { loss: loss / n, acc: correct / n };
  }

  finish() {
    if (this.best) this.net.copyFrom(this.best);
    this.valAcc = this.bestAcc ?? this.valAcc;
    this.done = true;
  }
}

function shuffled(n) {
  const a = Array.from({ length: n }, (_, i) => i);
  return shuffleInPlace(a);
}

function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

// ---------------------------------------------------------------------------
// Packing: quantise weights to `bits` per value (per-tensor scale) so a whole
// trained Echo fits in a URL.

export function packModel(net, bits = 6) {
  const header = [bits, net.sizes.length, ...net.sizes];
  const tensors = [];
  for (let l = 0; l < net.layers; l++) tensors.push(net.W[l], net.b[l]);
  const bw = new BitWriter();
  const scales = [];
  const qmax = (1 << (bits - 1)) - 1;
  for (const t of tensors) {
    let m = 0;
    for (let i = 0; i < t.length; i++) m = Math.max(m, Math.abs(t[i]));
    const scale = m > 0 ? m / qmax : 1;
    scales.push(scale);
    for (let i = 0; i < t.length; i++) {
      const q = Math.max(-qmax, Math.min(qmax, Math.round(t[i] / scale)));
      bw.write(q + qmax, bits);
    }
  }
  const body = bw.bytes();
  const out = new Uint8Array(header.length + scales.length * 4 + body.length);
  out.set(header, 0);
  const dv = new DataView(out.buffer);
  let o = header.length;
  for (const s of scales) {
    dv.setFloat32(o, s, true);
    o += 4;
  }
  out.set(body, o);
  return out;
}

export function unpackModel(bytes) {
  const bits = bytes[0];
  const nSizes = bytes[1];
  if (bits < 2 || bits > 8 || nSizes < 2 || nSizes > 6) throw new Error('bad model header');
  const sizes = Array.from(bytes.subarray(2, 2 + nSizes));
  const net = new MLP(sizes);
  const nTensors = (nSizes - 1) * 2;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 2 + nSizes;
  const scales = [];
  for (let i = 0; i < nTensors; i++) {
    scales.push(dv.getFloat32(o, true));
    o += 4;
  }
  const br = new BitReader(bytes.subarray(o));
  const qmax = (1 << (bits - 1)) - 1;
  let ti = 0;
  for (let l = 0; l < net.layers; l++) {
    for (const t of [net.W[l], net.b[l]]) {
      const s = scales[ti++];
      for (let i = 0; i < t.length; i++) t[i] = (br.read(bits) - qmax) * s;
    }
  }
  return net;
}

class BitWriter {
  constructor() {
    this.buf = [];
    this.acc = 0;
    this.n = 0;
  }
  write(v, bits) {
    for (let i = bits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((v >> i) & 1);
      if (++this.n === 8) {
        this.buf.push(this.acc);
        this.acc = 0;
        this.n = 0;
      }
    }
  }
  bytes() {
    const out = this.buf.slice();
    if (this.n > 0) out.push(this.acc << (8 - this.n));
    return Uint8Array.from(out);
  }
}

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }
  read(bits) {
    let v = 0;
    for (let i = 0; i < bits; i++) {
      const byte = this.bytes[this.pos >> 3] ?? 0;
      v = (v << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
}
