// SELF PLAY — the game loop and state machine.
//
//   title ─► calibrate (round 1: we record you) ─► train (a net learns you)
//     ─► profile ─► combat (fight your Echoes) ─► cleared ─► train ─► combat …
//                                     └─► dead ─► over (share your Echo)

import * as THREE from 'three';
import { ARENA_R, SAMPLE_HZ, CALIBRATION_TIME, MAX_ECHOES, PLAYER, SCORE, C } from './config.js';
import { seed, rand, range, chance } from './rng.js';
import { World, BRAIN_POS } from './world.js';
import { Particles, Rings, Shake } from './fx.js';
import { Player, Echo, Bit, Byte, Bullets, Ghost } from './entities.js';
import { Input, newPad } from './input.js';
import { UI } from './ui.js';
import { Pilot } from './pilot.js';
import { AudioEngine } from './audio.js';
import {
  Recorder,
  Frame,
  extractFeatures,
  moveClassFromLocal,
  makeTrainer,
  newNet,
  buildProfile,
  echoPersonality,
  Predictability,
  expectedLocalDir,
  DIM,
} from './brain.js';
import { moveProbs, argmaxMove } from './nn.js';
import { encodeEcho, echoLink, readHashEcho } from './share.js';

const pad2 = (n) => String(n).padStart(2, '0');
const L = { x: 0, z: 0 };
const IDLE_PAD = newPad();
IDLE_PAD.aimZ = -1;

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch (e) {
    return null;
  }
  return null;
}

export class Game {
  constructor({ capture = false } = {}) {
    this.capture = capture;
    if (capture) seed(7);
    this.app = document.getElementById('app');
    this.world = new World(this.app);
    const scene = this.world.scene;
    this.scene = scene;
    this.particles = new Particles(scene);
    this.rings = new Rings(scene);
    this.shake = new Shake();
    this.bullets = new Bullets(scene);
    this.player = new Player(scene);
    this.ghost = new Ghost(scene);
    this.audio = new AudioEngine();
    this.input = new Input(this.world.renderer.domElement, this.app);
    this.ui = new UI(document.getElementById('ui'), this);
    this.pilot = new Pilot();
    this.pad = newPad();

    this.echoes = [];
    this.drones = [];
    this.recorder = new Recorder();
    this.models = [];
    this.latest = null;
    this.profile = null;
    this.predict = new Predictability();
    this.prediction = { x: 0, z: 0, vx: 0, vz: 0, confidence: 0 };
    this.feat = new Float32Array(DIM);
    this.frame = new Frame();
    this.probs = new Float32Array(9);
    this.v3 = new THREE.Vector3();
    this.rig = 'title';

    this.state = 'title';
    this.stateT = 0;
    this.time = 0;
    this.round = 0;
    this.score = 0;
    this.kills = 0;
    this.paused = false;
    this.timeScale = 1;
    this.hitStop = 0;
    this.autopilot = true;
    this.mode = 'story';
    this.aimError = 0.12;
    this.sampleT = 0;
    this.spawnT = 0;
    this.byteT = 0;
    this.roundHits = 0;
    this.roundN = 0;
    this.duel = readHashEcho();
    this.best = Number(store('selfplay.best')) || 0;
    this.audio.setMuted(store('selfplay.muted') === '1');
    this.ui.setSound(this.audio.muted);

    this.titleNet = newNet();
    this.world.brain.setNet(this.titleNet);

    this.input.on('key', (code) => this.onKey(code));
    const unlock = () => {
      this.audio.init();
      if (this.state === 'title') {
        this.audio.startMusic();
        this.audio.setIntensity(0);
      }
    };
    addEventListener('pointerdown', unlock);
    addEventListener('keydown', unlock);
    addEventListener('touchstart', unlock, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.inGameplay() && !this.paused) this.togglePause();
    });
    // A challenge link pasted into an open tab only changes the hash.
    addEventListener('hashchange', () => {
      const duel = readHashEcho();
      if (!duel) return;
      this.duel = duel;
      if (this.state === 'title' || this.state === 'over') this.toTitle();
    });

    this.toTitle();
    this.last = performance.now();
    this.frameTimes = [];
    if (!capture) requestAnimationFrame((t) => this.loop(t));
  }

  // ---------------------------------------------------------------------------
  // Loop

  loop(now) {
    requestAnimationFrame((t) => this.loop(t));
    const dt = Math.min(0.05, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    this.tickSplash(now);
    // Substep slow frames so fast bullets can't tunnel through targets.
    const n = Math.ceil(dt / (1 / 60) - 0.01);
    for (let i = 0; i < n; i++) this.step(dt / n, i === n - 1);
    this.autoQuality(dt);
  }

  step(dt, render = true) {
    const pad = this.autopilot ? this.pad : this.input.update(this.world.camera, this.player);
    if (this.autopilot) this.pilot.update(dt, this, this.pad);
    if (!this.paused) {
      let sdt = dt * this.timeScale;
      if (this.hitStop > 0) {
        this.hitStop -= dt;
        sdt *= 0.1;
      }
      this.update(sdt, pad, dt);
    }
    this.updateCamera(dt);
    this.world.updateFx(dt);
    this.ui.updateHud(this, dt);
    this.ui.tick(dt);
    if (render) this.world.render();
  }

  // Advance the simulation without rendering (tests, and jump cuts in the trailer).
  advance(seconds, dt = 1 / 60) {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) this.step(dt, false);
  }

  // Studio splash ("made by Team Kanban"): starts on the second rendered frame.
  tickSplash(now) {
    if (this.splashDone) return;
    const el = document.querySelector('.splash');
    this.splashFrames = (this.splashFrames || 0) + 1;
    if (!el) {
      this.splashDone = true;
    } else if (this.splashFrames === 2) {
      el.classList.add('play');
      this.splashAt = now;
    } else if (this.splashAt && now - this.splashAt > 2200) {
      el.classList.add('gone');
      this.splashDone = true;
      setTimeout(() => el.remove(), 700);
    }
  }

  autoQuality(dt) {
    if (this.capture) return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 150) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes.length = 0;
    if (avg > 0.026 && this.world.quality > 0) this.world.setQuality(this.world.quality - 1);
  }

  update(dt, pad, realDt) {
    this.time += dt;
    this.stateT += dt;
    switch (this.state) {
      case 'title':
        this.updateAttract(dt, pad);
        break;
      case 'calibrate':
        this.updateCalibrate(dt, pad);
        break;
      case 'train':
        this.updateTrain(dt, realDt);
        break;
      case 'combat':
        this.updateCombat(dt, pad);
        break;
      case 'cleared':
        this.updateCleared(dt, pad);
        break;
      case 'dead':
        this.updateDead(dt, realDt);
        break;
      default:
        this.simulate(dt, IDLE_PAD, false);
    }
    this.bullets.render();
    this.particles.update(dt);
    this.rings.update(dt);
    this.world.dots.update(dt, this.time);
    this.world.brain.update(dt);
  }

  // Core simulation shared by every playable state.
  simulate(dt, pad, record) {
    this.player.update(dt, pad, this);
    for (const e of this.echoes) e.update(dt, this);
    for (const d of this.drones) d.update(dt, this);
    this.bullets.update(dt);
    this.collide();
    this.cleanup();
    if (record) {
      this.sampleT -= dt;
      while (this.sampleT <= 0) {
        this.sampleTick();
        this.sampleT += 1 / SAMPLE_HZ;
      }
    }
    const show = record && !!this.predictor() && this.state === 'combat' && this.prediction.confidence > 0;
    this.ghost.update(dt, this.player.x, this.player.z, this.prediction.x, this.prediction.z, show && this.player.alive);
  }

  // ---------------------------------------------------------------------------
  // Recording + prediction (15 Hz)

  focusTarget() {
    const p = this.player;
    let best = null;
    let bestScore = Infinity;
    const consider = (a) => {
      if (!a.active) return;
      const dx = a.x - p.x;
      const dz = a.z - p.z;
      const d = Math.hypot(dx, dz) || 1;
      const cos = (dx * p.aimX + dz * p.aimZ) / d;
      const score = (1 - cos) * 6 + d * 0.06;
      if (score < bestScore) {
        bestScore = score;
        best = a;
      }
    };
    this.echoes.forEach(consider);
    this.drones.forEach(consider);
    return best;
  }

  predictor() {
    return this.mode === 'duel' ? this.duelModel?.net : this.latest?.net;
  }

  sampleTick() {
    const p = this.player;
    if (!p.alive) return;
    const target = this.focusTarget();
    if (!target) {
      p.prevMoveX = p.moveX;
      p.prevMoveZ = p.moveZ;
      p.dashedSinceSample = false;
      return;
    }
    const threatDist = extractFeatures(this.feat, this.frame, p, target, this.bullets.enemyBullets, p.prevMoveX, p.prevMoveZ, p.dashCd <= 0, p.hp / PLAYER.hp);
    this.frame.toLocal(p.moveX, p.moveZ, L);
    const cls = moveClassFromLocal(L.x, L.z);
    const dist = Math.hypot(target.x - p.x, target.z - p.z);

    // Before learning from this move, check whether the model saw it coming.
    const net = this.predictor();
    if (net) {
      const out = net.forward(this.feat);
      const hit = argmaxMove(out) === cls;
      this.predict.push(hit);
      this.roundHits += hit ? 1 : 0;
      this.roundN++;
      moveProbs(out, 1, this.probs);
      expectedLocalDir(this.probs, L);
      const conf = Math.max(...this.probs);
      this.frame.toWorld(L.x, L.z, L);
      this.prediction.vx = L.x * PLAYER.speed;
      this.prediction.vz = L.z * PLAYER.speed;
      this.prediction.x = p.x + this.prediction.vx * 0.5;
      this.prediction.z = p.z + this.prediction.vz * 0.5;
      this.prediction.confidence = conf;
      if (hit && this.predict.value > 0.6) this.audio.predictBlip();
    }

    this.recorder.add(this.feat, cls, p.dashedSinceSample, p.firing, this.round, dist, threatDist);
    this.world.dots.add(p.x, p.z, this.time);
    p.prevMoveX = p.moveX;
    p.prevMoveZ = p.moveZ;
    p.dashedSinceSample = false;
  }

  // ---------------------------------------------------------------------------
  // States

  toTitle() {
    this.resetArena();
    this.state = 'title';
    this.stateT = 0;
    this.autopilot = true;
    this.paused = false;
    this.mode = 'story';
    this.rig = 'title';
    this.round = 0;
    this.world.brain.setNet(this.latest?.net || this.titleNet);
    this.world.brain.level = 0.85;
    this.ui.showTitle(this.best, this.duel);
    this.audio.setDuck(0);
    this.audio.setIntensity(0);
  }

  resetArena() {
    for (const e of this.echoes) {
      this.scene.remove(e.mesh);
      e.dispose();
    }
    for (const d of this.drones) this.scene.remove(d.mesh);
    this.echoes = [];
    this.drones = [];
    this.bullets.clear();
    this.particles.clear();
    this.rings.clear();
    this.world.dots.clear();
    this.player.reset();
    this.timeScale = 1;
    this.hitStop = 0;
    this.ui.clearPlates();
  }

  startRun(mode = 'story') {
    if (mode === 'duel' && !this.duel) mode = 'story';
    seed(this.capture ? 20261004 : (Math.random() * 4294967296) >>> 0);
    this.resetArena();
    this.mode = mode;
    this.autopilot = this.capture;
    this.pilot = new Pilot();
    this.recorder.clear();
    this.lastFocus = null;
    this.roundEchoes = 0;
    this.models = [];
    this.latest = null;
    this.profile = null;
    this.duelModel = null;
    this.predict = new Predictability();
    this.score = 0;
    this.kills = 0;
    this.round = 1;
    this.sampleT = 0;
    this.spawnT = 0.4;
    this.byteT = 6;
    this.paused = false;
    this.ui.show(null);
    this.audio.startMusic();
    this.audio.setDuck(0);
    this.audio.roundStart();

    if (mode === 'duel' && this.duel) {
      const d = this.duel;
      this.duelModel = { net: d.net, gen: d.gen, acc: d.match, samples: d.samples, label: `${d.name}'S ECHO`, hp: 26 };
      this.state = 'combat';
      this.stateT = 0;
      this.rig = 'play';
      this.roundHits = this.roundN = 0;
      this.spawnEcho(this.duelModel, 0);
      this.ui.setHud('combat');
      this.ui.banner(`<span class="hl pink"><span>DUEL</span></span>`, `${d.name}'s Echo · ${d.archetype.name}`, 'var(--acc-pink)', 2.2);
      this.audio.setIntensity(2);
      this.audio.echoSpawn();
      return;
    }
    this.state = 'calibrate';
    this.stateT = 0;
    this.rig = 'play';
    this.world.brain.level = 0.35;
    this.ui.setHud('calibrate');
    this.ui.banner(`ROUND 1 · <span class="hl"><span>CALIBRATION</span></span>`, 'Just play. The AI is watching.', 'var(--fg)', 2.4);
    this.audio.setIntensity(1);
  }

  get calibrationLeft() {
    return CALIBRATION_TIME - this.stateT;
  }

  roundLabel() {
    if (this.mode === 'duel') return `DUEL · ${this.duelModel?.label || ''}`;
    if (this.state === 'calibrate') return 'ROUND 1 · CALIBRATION';
    const n = this.roundEchoes || this.echoes.length;
    return `ROUND ${this.round} · ${n === 1 ? (this.models.at(-1)?.label ?? 'ECHO') : `${n} ECHOES`}`;
  }

  updateAttract(dt, pad) {
    // The autopilot plays against a few drones behind the menu; it can't die.
    this.player.invuln = 1;
    this.player.hp = PLAYER.hp;
    this.spawnT -= dt;
    if (this.spawnT <= 0 && this.drones.length < 4) {
      this.spawnDrone(chance(0.25) ? 'byte' : 'bit');
      this.spawnT = range(0.8, 2);
    }
    this.simulate(dt, pad, false);
    // The floating brain "watches" the demo player: feed it what the player sees.
    this.sampleT -= dt;
    if (this.sampleT <= 0) {
      this.sampleT = 1 / SAMPLE_HZ;
      const p = this.player;
      const t = this.focusTarget();
      if (t) {
        extractFeatures(this.feat, this.frame, p, t, this.bullets.enemyBullets, p.prevMoveX, p.prevMoveZ, p.dashCd <= 0, 1);
        this.world.brain.net.forward(this.feat);
        p.prevMoveX = p.moveX;
        p.prevMoveZ = p.moveZ;
      }
    }
  }

  updateCalibrate(dt, pad) {
    const t = this.stateT;
    this.spawnT -= dt;
    const target = Math.min(8, 4 + Math.floor(t / 4));
    if (this.spawnT <= 0 && this.drones.length < target) {
      const bytes = this.drones.filter((d) => d.kind === 'byte').length;
      this.spawnDrone(t > 4 && bytes < 2 && chance(0.3) ? 'byte' : 'bit');
      this.spawnT = this.drones.length < 2 ? 0.15 : range(0.35, 0.8);
    }
    this.simulate(dt, pad, true);
    if (this.calibrationLeft <= 0 && this.player.alive) this.startTraining();
  }

  updateCombat(dt, pad) {
    this.spawnT -= dt;
    const bits = this.drones.filter((d) => d.kind === 'bit').length;
    if (this.spawnT <= 0) {
      if (bits < 1 + Math.floor(this.round / 2)) this.spawnDrone('bit');
      this.spawnT = range(3.5, 5.5);
    }
    if (this.round >= 3 || this.mode === 'duel') {
      this.byteT -= dt;
      if (this.byteT <= 0) {
        if (this.drones.filter((d) => d.kind === 'byte').length < 2) this.spawnDrone('byte');
        this.byteT = range(8, 12);
      }
    }
    this.simulate(dt, pad, true);
    if (this.player.alive && this.stateT > 1 && this.echoes.length === 0) {
      if (this.mode === 'duel') this.finishDuel(true);
      else this.roundCleared();
    }
  }

  roundCleared() {
    this.state = 'cleared';
    this.stateT = 0;
    const acc = this.roundN ? this.roundHits / this.roundN : 0.5;
    const bonus = Math.round((1 - acc) * SCORE.unpredictBonus);
    this.score += SCORE.roundClear + bonus;
    for (const d of this.drones) this.killDrone(d, true);
    this.player.hp = Math.min(PLAYER.hp, this.player.hp + 2);
    this.ui.banner(`ROUND <span class="hl"><span>CLEAR</span></span>`, `It predicted you ${Math.round(acc * 100)}% of the time`, 'var(--fg)', 1.8);
    this.ui.toast(`UNPREDICTABILITY BONUS +${bonus}`, 'var(--acc-acid)');
    this.audio.roundClear();
  }

  updateCleared(dt, pad) {
    this.simulate(dt, pad, false);
    if (this.stateT > 1.7) this.startTraining();
  }

  // ---------------------------------------------------------------------------
  // Training interlude

  startTraining() {
    this.state = 'train';
    this.stateT = 0;
    for (const d of this.drones) this.killDrone(d, false);
    this.bullets.clear();
    this.trainer = null;
    this.trained = false;
    this.ui.setHud('none');
    this.ui.clearPlates();
    if (this.round === 1) {
      this.ui.banner(`CALIBRATION <span class="hl"><span>COMPLETE</span></span>`, `${this.recorder.total.toLocaleString()} decisions recorded`, 'var(--fg)', 1.3);
    }
    this.audio.setDuck(0.6);
  }

  updateTrain(dt, realDt) {
    const t = this.stateT;
    this.simulate(dt, IDLE_PAD, false);
    const first = this.models.length === 0;
    const anim = first ? 1.7 : 1.2;
    if (!this.trainer && t > (first ? 0.9 : 0.3)) {
      const gen = this.models.length + 1;
      this.trainer = makeTrainer(this.recorder, first ? 36 : 24);
      this.world.brain.setNet(this.trainer.net);
      this.world.brain.level = 0.6;
      this.world.dots.fly(this.world.brain);
      this.rig = 'brain';
      this.trainStart = t;
      this.tickT = 0;
      this.ui.showTraining(`ECHO-${pad2(gen)}`, gen);
    }
    const tr = this.trainer;
    if (tr && !tr.done) {
      const k = Math.min(1, Math.max(0, (t - this.trainStart - 0.45) / anim));
      const want = Math.ceil(k * tr.totalSteps);
      if (want > tr.step) tr.run(want - tr.step);
      const rec = this.recorder;
      if (rec.n) {
        const i = Math.floor(rand() * rec.n);
        tr.net.forward(rec.X.subarray(i * DIM, (i + 1) * DIM));
      }
      this.tickT -= dt;
      if (this.tickT <= 0 && k > 0) {
        this.audio.trainTick(k);
        this.tickT = 0.07;
      }
      this.ui.updateTraining(tr, rec.total, false);
      if (tr.done) this.onTrained();
    }
    if (this.trained && t > this.trainedAt + 1.25) {
      if (this.round === 1 && this.mode === 'story' && this.profile) {
        this.state = 'profile';
        this.stateT = 0;
        this.rig = 'overview';
        this.ui.showProfile(this.profile, this.latest);
        this.audio.setDuck(0.3);
      } else {
        this.beginRound(this.round + 1);
      }
    }
  }

  onTrained() {
    const tr = this.trainer;
    const gen = this.models.length + 1;
    const model = { net: tr.net, gen, acc: tr.valAcc, samples: this.recorder.total, label: `ECHO-${pad2(gen)}`, computeMs: tr.computeMs };
    this.profile = buildProfile(this.recorder, this.player.shots, this.player.hits);
    model.personality = echoPersonality(this.profile, this.models.map((m) => m.personality?.id));
    this.models.push(model);
    this.latest = model;
    const acc = this.player.shots ? this.player.hits / this.player.shots : 0.3;
    this.aimError = Math.min(0.2, Math.max(0.02, 0.24 - acc * 0.32));
    this.trained = true;
    this.trainedAt = this.stateT;
    this.world.brain.pulse = 1;
    this.audio.trainDone();
    this.ui.updateTraining(tr, this.recorder.total, true);
  }

  continueFromProfile() {
    if (this.state !== 'profile') return;
    this.beginRound(2);
  }

  beginRound(r) {
    this.round = r;
    this.state = 'combat';
    this.stateT = 0;
    this.rig = 'play';
    this.ui.show(null);
    this.ui.setHud('combat');
    this.predict.reset();
    this.roundHits = this.roundN = 0;
    this.spawnT = 2.5;
    this.byteT = 4;
    const gens = this.models.slice(-MAX_ECHOES);
    gens.forEach((m, i) => this.spawnEcho(m, i, gens.length));
    this.roundEchoes = gens.length;
    const newest = gens[gens.length - 1];
    const P = newest.personality;
    const sub = P ? `GEN ${newest.gen} — ${P.name} ${P.line}.` : newest.label;
    this.ui.banner(`ROUND ${r} · <span class="hl pink"><span>FIGHT YOURSELF</span></span>`, sub, 'var(--fg)', 2.6);
    this.audio.setDuck(0);
    this.audio.setIntensity(r >= 4 ? 3 : 2);
    this.audio.roundStart();
    this.audio.echoSpawn();
    this.world.fx.glitch = 1;
  }

  spawnEcho(model, i, n = 1) {
    const p = this.player;
    const away = Math.atan2(-p.z, -p.x) + (n > 1 ? (i - (n - 1) / 2) * 0.9 : 0);
    let x = Math.cos(away) * 12;
    let z = Math.sin(away) * 12;
    if (Math.hypot(x - p.x, z - p.z) < 9) {
      x = -p.x * 0.8;
      z = -p.z * 0.8 - 6;
    }
    const e = new Echo(this.scene, model, x, z);
    this.echoes.push(e);
    this.rings.spawn(x, z, e.color, 4, 0.4, 0.9);
    this.rings.spawn(x, z, e.color, 0.2, 2.5, 0.7);
    for (let k = 0; k < 40; k++) {
      this.particles.spawn(x + range(-0.5, 0.5), range(1, 7), z + range(-0.5, 0.5), 0, range(-9, -4), 0, range(0.3, 0.8), range(0.6, 1.4), new THREE.Color(e.color).multiplyScalar(2.5), 0.5, 0);
    }
  }

  finishDuel(won) {
    this.state = 'over';
    this.stateT = 0;
    this.trainSync();
    if (won) this.score += 1500;
    this.showOver(won ? 'duel-won' : 'duel-lost');
  }

  // Train immediately (used when the run ends before an interlude could).
  trainSync() {
    if (this.recorder.n < 20) return;
    const last = this.latest;
    if (last && last.samples === this.recorder.total) return;
    const tr = makeTrainer(this.recorder, 30);
    tr.run(Infinity);
    const gen = this.models.length + 1;
    this.profile = buildProfile(this.recorder, this.player.shots, this.player.hits);
    const personality = echoPersonality(this.profile, this.models.map((m) => m.personality?.id));
    this.latest = { net: tr.net, gen, acc: tr.valAcc, samples: this.recorder.total, label: `ECHO-${pad2(gen)}`, personality };
    this.models.push(this.latest);
  }

  // ---------------------------------------------------------------------------
  // Death + game over

  die() {
    const p = this.player;
    p.alive = false;
    p.mesh.visible = false;
    this.state = 'dead';
    this.stateT = 0;
    this.deadReal = 0;
    this.timeScale = 0.3;
    this.rig = 'death';
    this.explode(p.x, p.z, C.electric, 1.2);
    this.world.fx.glitch = 1.4;
    this.world.fx.aberration = 1.5;
    this.audio.death();
    this.audio.setDuck(1);
    this.ghost.update(0.016, p.x, p.z, p.x, p.z, false);
  }

  updateDead(dt, realDt) {
    this.deadReal += realDt;
    for (const e of this.echoes) e.update(dt, this);
    for (const d of this.drones) d.update(dt, this);
    this.bullets.update(dt);
    if (this.deadReal > 2) {
      this.timeScale = 1;
      this.state = 'over';
      this.stateT = 0;
      if (this.mode === 'duel') this.finishDuel(false);
      else {
        this.trainSync();
        this.showOver('lost');
      }
    }
  }

  showOver(kind) {
    this.rig = 'overview';
    if (this.score > this.best) {
      this.best = this.score;
      store('selfplay.best', String(this.best));
    }
    const pct = Math.round(this.predict.overall * 100);
    const d = this.duel;
    const titles = {
      lost: this.round <= 1 ? `THE DRONES GOT YOU. <span class="hl"><span>RECALIBRATE.</span></span>` : `YOU LOST TO <span class="hl pink"><span>YOURSELF.</span></span>`,
      'duel-won': `YOU BEAT <span class="hl"><span>${d?.name}'S</span></span> BRAIN.`,
      'duel-lost': `${d?.name}'S ECHO <span class="hl pink"><span>WINS.</span></span>`,
    };
    const stats = [
      ['SCORE', this.score.toLocaleString()],
      [this.mode === 'duel' ? 'MODE' : 'ROUND', this.mode === 'duel' ? 'DUEL' : this.round],
      ['ECHOES DELETED', this.kills],
      ['PREDICTABILITY', this.predict.allN ? `${pct}%` : '—'],
      ['DECISIONS', this.recorder.total.toLocaleString()],
    ];
    this.ui.showOver({
      eyebrow: kind === 'duel-won' ? 'DUEL WON' : kind === 'duel-lost' ? 'DUEL LOST' : 'GAME OVER',
      title: titles[kind],
      stats,
      canShare: !!this.latest,
      echo: this.latest ? `${this.latest.label} (<b class="pink">${this.profile?.archetype.name ?? 'UNKNOWN'}</b>)` : null,
    });
    this.audio.setIntensity(0);
    this.audio.setDuck(0.4);
  }

  shareLink() {
    if (!this.latest) return;
    const prof = this.profile;
    const code = encodeEcho({
      name: this.ui.shareName() || 'ANON',
      gen: this.latest.gen,
      samples: this.recorder.total,
      match: this.latest.acc || 0,
      archetypeId: prof?.archetype.id,
      traits: prof?.traits,
      net: this.latest.net,
    });
    const url = echoLink(code);
    const done = (ok) => this.ui.showShareLink(url, ok);
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(() => done(true), () => done(false));
    else done(false);
  }

  // ---------------------------------------------------------------------------
  // Combat helpers

  spawnDrone(kind) {
    const p = this.player;
    let x = 0;
    let z = 0;
    for (let tries = 0; tries < 12; tries++) {
      const a = rand() * Math.PI * 2;
      const r = range(ARENA_R - 6, ARENA_R - 1.5);
      x = Math.cos(a) * r;
      z = Math.sin(a) * r;
      if (Math.hypot(x - p.x, z - p.z) > 9) break;
    }
    const d = kind === 'byte' ? new Byte(this.scene, x, z) : new Bit(this.scene, x, z);
    this.drones.push(d);
    this.rings.spawn(x, z, d.color, 2.2, 0.5, 0.7, 0.8);
  }

  collide() {
    const p = this.player;
    const hit = (b, a) => Math.hypot(b.x - a.x, b.z - a.z) < b.radius + a.radius;
    for (const b of this.bullets.list) {
      if (b.dead) continue;
      if (b.owner === 'player') {
        for (const e of this.echoes) {
          if (e.active && !e.dodging && hit(b, e)) {
            b.dead = true;
            this.hitEcho(e, b);
            break;
          }
        }
        if (b.dead) continue;
        for (const d of this.drones) {
          if (d.active && hit(b, d)) {
            b.dead = true;
            this.hitDrone(d, b);
            break;
          }
        }
      } else if (p.alive && hit(b, p) && p.invuln <= 0) {
        b.dead = true;
        this.hurtPlayer(b.vx, b.vz, b.color);
      }
    }
    if (!p.alive) return;
    for (const d of this.drones) {
      if (!d.active || d.kind !== 'bit') continue;
      if (Math.hypot(d.x - p.x, d.z - p.z) < d.radius + p.radius) {
        if (p.dashT > 0) this.killDrone(d, true);
        else if (p.invuln <= 0) {
          this.killDrone(d, false);
          this.hurtPlayer(d.vx, d.vz, d.color);
        }
      }
    }
    for (const e of this.echoes) {
      if (!e.active) continue;
      const dx = e.x - p.x;
      const dz = e.z - p.z;
      const d = Math.hypot(dx, dz);
      const min = e.radius + p.radius;
      if (d < min && d > 1e-3) {
        const push = (min - d) / 2;
        e.x += (dx / d) * push;
        e.z += (dz / d) * push;
        p.x -= (dx / d) * push;
        p.z -= (dz / d) * push;
      }
    }
  }

  hitEcho(e, b) {
    e.hurt(1);
    this.player.hits++;
    e.vx += b.vx * 0.03;
    e.vz += b.vz * 0.03;
    this.particles.spray(b.x, 0.6, b.z, -b.vx, -b.vz, e.color, 6, 9);
    this.audio.enemyHit();
    if (!e.alive) {
      const pts = SCORE.echoBase * e.gen;
      this.score += pts;
      this.kills++;
      this.explode(e.x, e.z, e.color, 1);
      this.hitStop = 0.14;
      this.ui.toast(`${e.name} DELETED +${pts}`, `#${e.color.toString(16).padStart(6, '0')}`);
    }
  }

  hitDrone(d, b) {
    d.hurt(1);
    this.player.hits++;
    this.particles.spray(b.x, 0.6, b.z, -b.vx, -b.vz, d.color, 4, 7);
    this.audio.enemyHit();
    if (!d.alive) this.killDrone(d, true);
  }

  killDrone(d, scored) {
    d.alive = false;
    this.particles.burst(d.x, 0.6, d.z, d.color, 16, 7, 0.5, 1);
    this.rings.spawn(d.x, d.z, d.color, 0.3, 2.2, 0.35, 0.8);
    this.audio.explode(0.22);
    this.shake.add(0.12);
    if (scored) this.score += d.score;
  }

  explode(x, z, color, size) {
    this.particles.burst(x, 0.7, z, color, Math.round(70 * size), 13 * size, 0.9, 1.5);
    this.particles.burst(x, 0.7, z, C.ink, Math.round(20 * size), 9 * size, 0.6, 1, 1.2);
    this.rings.spawn(x, z, color, 0.5, 7 * size, 0.6);
    this.rings.spawn(x, z, C.ink, 0.3, 4 * size, 0.45, 0.6);
    this.shake.add(0.55 * size);
    this.world.fx.aberration = Math.max(this.world.fx.aberration, 0.8 * size);
    this.world.fx.flash = 0.6 * size;
    this.audio.explode(Math.min(1, size));
  }

  hurtPlayer(vx, vz, color) {
    const p = this.player;
    p.hp -= 1;
    p.invuln = PLAYER.hurtIframes;
    this.shake.add(0.5);
    this.world.fx.aberration = 1.2;
    this.world.fx.glitch = 0.5;
    this.particles.spray(p.x, 0.7, p.z, vx, vz, color, 14, 10, 1.2);
    this.audio.playerHurt();
    if (p.hp <= 0) this.die();
  }

  onDash(actor, color) {
    this.particles.spray(actor.x, 0.4, actor.z, -actor.dashX, -actor.dashZ, color, 10, 6, 0.6, 0.3, 0.9);
    this.rings.spawn(actor.x, actor.z, color, 0.4, 1.6, 0.3, 0.7);
    this.audio.dash();
  }

  cleanup() {
    const alive = (a) => {
      if (a.alive) return true;
      this.scene.remove(a.mesh);
      a.dispose?.();
      return false;
    };
    this.echoes = this.echoes.filter(alive);
    this.drones = this.drones.filter(alive);
  }

  // ---------------------------------------------------------------------------
  // Camera, input, misc

  updateCamera(dt) {
    const p = this.player;
    const tall = this.world.aspect < 1;
    const pos = this.v3a || (this.v3a = new THREE.Vector3());
    const look = this.v3b || (this.v3b = new THREE.Vector3());
    let sharp = 4;
    switch (this.rig) {
      case 'play': {
        const cx = p.x * 0.8 + p.aimX * 1.6;
        const cz = p.z * 0.8 + p.aimZ * 1.6;
        pos.set(cx, tall ? 33 : 22, cz + (tall ? 17 : 13.5));
        look.set(cx, 0, cz - 1);
        sharp = 5;
        break;
      }
      case 'title': {
        const a = Math.sin(this.time * 0.07) * 0.3 - 0.12;
        pos.set(Math.sin(a) * 28 - (tall ? 0 : 6), tall ? 20 : 11, Math.cos(a) * 28 + 2);
        look.set(tall ? 0 : -10, 8.6, -13);
        sharp = 2;
        break;
      }
      case 'brain':
        pos.set(BRAIN_POS.x, BRAIN_POS.y - 0.6, BRAIN_POS.z + (tall ? 30 : 19.5));
        look.copy(BRAIN_POS);
        sharp = 2.6;
        break;
      case 'overview':
        pos.set(0, tall ? 44 : 31, tall ? 26 : 21);
        look.set(0, 0, 1);
        sharp = 2.4;
        break;
      case 'death':
        pos.set(p.x, 11, p.z + 8.5);
        look.set(p.x, 0, p.z);
        sharp = 3;
        break;
    }
    this.world.updateCamera(dt, pos, look, sharp, this.shake.update(dt));
  }

  project(x, y, z) {
    return this.v3.set(x, y, z).project(this.world.camera);
  }

  focusEcho() {
    let best = null;
    let bd = Infinity;
    for (const e of this.echoes) {
      if (!e.alive) continue;
      const d = Math.hypot(e.x - this.player.x, e.z - this.player.z);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  focusEchoNet() {
    const e = this.focusEcho();
    if (e) this.lastFocus = e;
    return this.lastFocus?.net || null;
  }

  focusEchoName() {
    return this.lastFocus?.name || 'ECHO';
  }

  inGameplay() {
    return ['calibrate', 'combat', 'cleared', 'train', 'dead'].includes(this.state);
  }

  togglePause() {
    if (!this.inGameplay() || this.state === 'dead') return;
    this.paused = !this.paused;
    this.ui.show(this.paused ? 'pause' : this.state === 'train' ? 'train' : null);
    this.audio.setDuck(this.paused ? 1 : this.state === 'train' ? 0.6 : 0);
  }

  toggleMute() {
    const m = this.audio.toggleMute();
    store('selfplay.muted', m ? '1' : '0');
    this.ui.setSound(m);
  }

  onKey(code) {
    if (code === 'Escape' || code === 'KeyP') this.togglePause();
    else if (code === 'KeyM') this.toggleMute();
    else if (code === 'Space' || code === 'Enter' || code === 'GamepadA') {
      if (this.state === 'profile') this.continueFromProfile();
      else if (this.state === 'title' && code === 'Enter') this.startRun('story');
      else if (this.state === 'over' && code === 'Enter') this.startRun(this.mode);
    }
  }

  onAction(act) {
    switch (act) {
      case 'play':
        this.startRun('story');
        break;
      case 'duel':
        this.startRun('duel');
        break;
      case 'how':
        this.ui.show('how');
        break;
      case 'back':
      case 'menu':
        if (this.paused) this.paused = false;
        this.toTitle();
        break;
      case 'continue':
        this.continueFromProfile();
        break;
      case 'retry':
        this.paused = false;
        this.startRun(this.mode === 'duel' && this.duel ? 'duel' : 'story');
        break;
      case 'resume':
      case 'pause':
        this.togglePause();
        break;
      case 'mute':
        this.toggleMute();
        break;
      case 'share':
        this.shareLink();
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Boot: wait for the hand-drawn fonts (they're painted into canvas textures).

async function boot() {
  const capture = /[?&]capture\b/.test(location.search);
  try {
    await Promise.all([
      document.fonts.load('64px "Shadows Into Light Two"'),
      document.fonts.load('64px "Caveat Brush"'),
      document.fonts.load('20px "Architects Daughter"'),
    ]);
  } catch (e) {
    /* fonts are a nicety */
  }
  const game = new Game({ capture });
  window.__selfplay = game;
  if (capture) setupCapture(game);
  document.body.classList.add('ready');
}

// Trailer capture: the director (video/capture-game.cjs) steps the game frame by
// frame. SFX calls are logged against video time and rendered offline later;
// CSS animations are driven from video time so every frame is reproducible.
function setupCapture(game) {
  document.body.classList.add('capture');
  const log = (window.__audioEvents = []);
  window.__vt = 0;
  window.__logAudio = false;
  window.__AudioEngine = AudioEngine;
  const audio = game.audio;
  const music = new Set(['init', 'startMusic', 'stopMusic', 'setIntensity', 'setDuck', 'setMuted', 'toggleMute', 'setMasterVolume', 'renderOfflineWav']);
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(audio))) {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(audio), name);
    if (name === 'constructor' || !desc || typeof desc.value !== 'function') continue;
    audio[name] = (...args) => {
      if (!music.has(name) && window.__logAudio) log.push({ t: window.__vt, name, args });
      return name === 'toggleMute' ? false : undefined;
    };
  }
  const born = new WeakMap();
  window.__syncAnimations = (vt) => {
    for (const a of document.getAnimations()) {
      if (!born.has(a)) born.set(a, vt);
      a.pause();
      a.currentTime = Math.max(0, (vt - born.get(a)) * 1000);
    }
  };
}

boot();
