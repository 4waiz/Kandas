// Actors: the player, Echo clones (driven by a trained network), drones, bullets.
// Everything lives on the XZ plane; meshes are dark "ink" bodies with cream
// outlines and neon accents that feed the bloom pass.

import * as THREE from 'three';
import { ARENA_R, PLAYER, ECHO, BIT, BYTE, C, SAMPLE_HZ, echoColor } from './config.js';
import { rand, range, gauss, chance } from './rng.js';
import { Frame, extractFeatures, decide, newDecision, classDir, expectedLocalDir, DIM } from './brain.js';

const INK = new THREE.Color(0xf5f1e8);
const neon = (hex, k = 2.4) => new THREE.Color(hex).multiplyScalar(k);

// ---------------------------------------------------------------------------
// Shared geometry / materials

let G = null;
function shared() {
  if (G) return G;
  const grad = new THREE.DataTexture(new Uint8Array([70, 140, 255]), 3, 1, THREE.RedFormat);
  grad.minFilter = grad.magFilter = THREE.NearestFilter;
  grad.needsUpdate = true;
  G = {
    grad,
    body: new THREE.CylinderGeometry(0.5, 0.6, 0.55, 6),
    head: new THREE.CylinderGeometry(0.3, 0.42, 0.32, 6),
    visor: new THREE.BoxGeometry(0.42, 0.1, 0.12),
    gun: new THREE.BoxGeometry(0.12, 0.12, 0.55),
    ring: new THREE.TorusGeometry(0.72, 0.045, 6, 36),
    shadow: new THREE.CircleGeometry(0.85, 24),
    tetra: new THREE.TetrahedronGeometry(0.62, 0),
    octa: new THREE.OctahedronGeometry(0.8, 0),
    core: new THREE.IcosahedronGeometry(0.22, 1),
    bulletP: new THREE.CapsuleGeometry(0.09, 0.55, 2, 6),
    bulletE: new THREE.IcosahedronGeometry(0.24, 1),
    bodyMat: new THREE.MeshToonMaterial({ color: 0xece4d2, gradientMap: grad }),
    outlineMat: new THREE.MeshBasicMaterial({ color: 0x0e0b14, side: THREE.BackSide }),
    shadowMat: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }),
  };
  G.bulletP.rotateX(Math.PI / 2);
  return G;
}

function outlined(geo, mat, outlineMat, s = 1.12) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, mat));
  const o = new THREE.Mesh(geo, outlineMat);
  o.scale.setScalar(s);
  g.add(o);
  return g;
}

// The pilot: hex body, turret head with a visor and gun, neon base ring.
function buildPilot(accent, hologram) {
  const S = shared();
  const root = new THREE.Group();
  const shadow = new THREE.Mesh(S.shadow, S.shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.03;
  shadow.scale.setScalar(1.25);
  root.add(shadow);

  const tilt = new THREE.Group();
  tilt.scale.setScalar(1.3);
  root.add(tilt);
  const accentMat = new THREE.MeshBasicMaterial({ color: neon(accent), toneMapped: false });
  let bodyMat = S.bodyMat;
  let outlineMat = S.outlineMat;
  if (hologram) {
    bodyMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(accent).multiplyScalar(0.22), transparent: true, opacity: 0.9 });
    outlineMat = new THREE.MeshBasicMaterial({ color: neon(accent, 1.3), side: THREE.BackSide, toneMapped: false });
  }
  const body = outlined(S.body, bodyMat, outlineMat);
  body.position.y = 0.42;
  tilt.add(body);

  const ring = new THREE.Mesh(S.ring, accentMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.22;
  tilt.add(ring);

  const turret = new THREE.Group();
  turret.position.y = 0.86;
  tilt.add(turret);
  const head = outlined(S.head, bodyMat, outlineMat, 1.14);
  turret.add(head);
  const visor = new THREE.Mesh(S.visor, accentMat);
  visor.position.set(0, 0.04, 0.33);
  turret.add(visor);
  const gun = outlined(S.gun, bodyMat, outlineMat, 1.25);
  gun.position.set(0.28, -0.12, 0.42);
  turret.add(gun);
  const tip = new THREE.Mesh(S.core, accentMat);
  tip.scale.setScalar(0.45);
  tip.position.set(0.28, -0.12, 0.72);
  turret.add(tip);

  root.userData = { tilt, turret, ring, accentMat, bodyMat, outlineMat, shadow };
  return root;
}

function clampToArena(a, r) {
  const d = Math.hypot(a.x, a.z);
  const max = ARENA_R - r;
  if (d > max) {
    const nx = a.x / d;
    const nz = a.z / d;
    a.x = nx * max;
    a.z = nz * max;
    const vn = a.vx * nx + a.vz * nz;
    if (vn > 0) {
      a.vx -= vn * nx;
      a.vz -= vn * nz;
    }
    return true;
  }
  return false;
}

function steer(a, tx, tz, speed, sharp, dt) {
  const k = 1 - Math.exp(-sharp * dt);
  a.vx += (tx * speed - a.vx) * k;
  a.vz += (tz * speed - a.vz) * k;
}

function poseMesh(a, dt, bob = 0) {
  const m = a.mesh;
  const u = m.userData;
  m.position.set(a.x, bob, a.z);
  u.turret.rotation.y = Math.atan2(a.aimX, a.aimZ);
  // Lean into the movement a little.
  const lx = THREE.MathUtils.clamp(a.vx / 30, -0.25, 0.25);
  const lz = THREE.MathUtils.clamp(a.vz / 30, -0.25, 0.25);
  u.tilt.rotation.z += (-lx - u.tilt.rotation.z) * Math.min(1, dt * 10);
  u.tilt.rotation.x += (lz - u.tilt.rotation.x) * Math.min(1, dt * 10);
  u.ring.rotation.z += dt * 2;
}

// ---------------------------------------------------------------------------

export class Player {
  constructor(scene) {
    this.mesh = buildPilot(C.electric, false);
    scene.add(this.mesh);
    this.radius = PLAYER.radius;
    this.reset();
  }

  reset() {
    this.x = 0;
    this.z = 7;
    this.vx = this.vz = 0;
    this.aimX = 0;
    this.aimZ = -1;
    this.hp = PLAYER.hp;
    this.alive = true;
    this.fireCd = 0;
    this.dashT = 0;
    this.dashCd = 0;
    this.dashX = 0;
    this.dashZ = 0;
    this.invuln = 0;
    this.moveX = this.moveZ = 0; // current input (unit or 0)
    this.prevMoveX = this.prevMoveZ = 0; // input at the previous sample tick
    this.dashedSinceSample = false;
    this.firing = false;
    this.shots = 0;
    this.hits = 0;
    this.mesh.visible = true;
    this.mesh.scale.setScalar(1);
  }

  update(dt, pad, game) {
    if (!this.alive) return;
    this.dashCd -= dt;
    this.invuln -= dt;
    this.fireCd -= dt;

    let mx = pad.moveX;
    let mz = pad.moveZ;
    const ml = Math.hypot(mx, mz);
    if (ml > 1e-3) {
      this.moveX = mx / Math.max(1, ml);
      this.moveZ = mz / Math.max(1, ml);
    } else {
      this.moveX = this.moveZ = 0;
    }
    this.aimX = pad.aimX;
    this.aimZ = pad.aimZ;

    if (pad.dash && this.dashCd <= 0) {
      let dx = this.moveX;
      let dz = this.moveZ;
      if (Math.hypot(dx, dz) < 0.2) {
        dx = this.aimX;
        dz = this.aimZ;
      }
      const l = Math.hypot(dx, dz) || 1;
      this.dashX = dx / l;
      this.dashZ = dz / l;
      this.dashT = PLAYER.dashTime;
      this.dashCd = PLAYER.dashCooldown;
      this.invuln = Math.max(this.invuln, PLAYER.dashTime + 0.1);
      this.dashedSinceSample = true;
      game.onDash(this, C.electric);
    }

    if (this.dashT > 0) {
      this.dashT -= dt;
      this.vx = this.dashX * PLAYER.dashSpeed;
      this.vz = this.dashZ * PLAYER.dashSpeed;
    } else {
      steer(this, this.moveX, this.moveZ, PLAYER.speed, PLAYER.friction, dt);
    }
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    clampToArena(this, this.radius);

    this.firing = pad.fire;
    if (pad.fire && this.fireCd <= 0) {
      this.fireCd = 1 / PLAYER.fireRate;
      const spread = (rand() - 0.5) * 0.04;
      const ax = this.aimX * Math.cos(spread) - this.aimZ * Math.sin(spread);
      const az = this.aimX * Math.sin(spread) + this.aimZ * Math.cos(spread);
      game.bullets.spawn('player', this.x + ax * 0.9, this.z + az * 0.9, ax, az, PLAYER.bulletSpeed, PLAYER.bulletLife, C.electric, 1, 0);
      this.shots++;
      game.audio.shoot();
    }

    poseMesh(this, dt);
    // Blink while invulnerable after a hit.
    const blink = this.invuln > 0 && this.dashT <= 0 && Math.floor(this.invuln * 16) % 2 === 0;
    this.mesh.userData.tilt.visible = !blink;
  }
}

// ---------------------------------------------------------------------------
// The Echo: a clone whose every decision comes from a network trained on you.

const tmpL = { x: 0, z: 0 };
const tmpW = { x: 0, z: 0 };

export class Echo {
  constructor(scene, model, x, z) {
    this.model = model;
    this.net = model.net;
    this.gen = model.gen;
    this.color = echoColor(this.gen);
    this.mesh = buildPilot(this.color, true);
    this.mesh.scale.setScalar(0.001);
    scene.add(this.mesh);
    this.radius = ECHO.radius;
    this.x = x;
    this.z = z;
    this.vx = this.vz = 0;
    this.aimX = 0;
    this.aimZ = 1;
    const m = model.personality?.mods || {};
    this.speed = ECHO.speed * (m.speed ?? 1);
    this.fireRate = ECHO.fireRate * (m.fireRate ?? 1);
    this.dashCooldown = ECHO.dashCooldown * (m.dashCooldown ?? 1);
    this.dashProb = m.dashProb ?? 1;
    this.aimNoise = ECHO.aimNoise * (m.aimNoise ?? 1);
    this.bulletSpeed = ECHO.bulletSpeed * (m.bulletSpeed ?? 1);
    this.temperature = m.temperature ?? ECHO.temperature;
    this.maxHp = Math.round((model.hp ?? ECHO.baseHp + (this.gen - 1) * ECHO.hpPerGen) * (m.hp ?? 1));
    this.hp = this.maxHp;
    this.alive = true;
    this.spawnT = 0;
    this.thinkT = rand() / SAMPLE_HZ;
    this.features = new Float32Array(DIM);
    this.frame = new Frame();
    this.decision = newDecision();
    this.wantX = this.wantZ = 0;
    this.prevX = this.prevZ = 0;
    this.shootIntent = false;
    this.fireCd = 0.6 + rand() * 0.6;
    this.dashT = 0;
    this.dashCd = 0.8;
    this.dashX = this.dashZ = 0;
    this.flash = 0;
    this.glitchT = 0;
    this.name = model.label || `ECHO-${String(this.gen).padStart(2, '0')}`;
    this.title = model.personality ? `GEN ${this.gen} · ${model.personality.name}` : this.name;
  }

  get active() {
    return this.alive && this.spawnT >= 1;
  }

  get dodging() {
    return this.dashT > 0;
  }

  think(game) {
    const p = game.player;
    extractFeatures(this.features, this.frame, this, p, game.bullets.playerBullets, this.prevX, this.prevZ, this.dashCd <= 0, this.hp / this.maxHp);
    const d = decide(this.net, this.features, this.temperature, rand, this.decision);
    if (d.move === 0) {
      this.wantX = this.wantZ = 0;
    } else {
      const [lx, lz] = classDir(d.move);
      this.frame.toWorld(lx, lz, tmpW);
      this.wantX = tmpW.x;
      this.wantZ = tmpW.z;
    }
    this.prevX = this.wantX;
    this.prevZ = this.wantZ;

    if (this.dashCd <= 0 && rand() < Math.min(0.6, d.dashP * 1.15 * this.dashProb)) {
      let dx = this.wantX;
      let dz = this.wantZ;
      if (Math.hypot(dx, dz) < 0.2) {
        dx = this.frame.rx;
        dz = this.frame.rz;
      }
      this.dashX = dx;
      this.dashZ = dz;
      this.dashT = ECHO.dashTime;
      this.dashCd = this.dashCooldown;
      game.onDash(this, this.color);
    }
    this.shootIntent = rand() < Math.max(ECHO.minFireProb, d.shootP);
  }

  update(dt, game) {
    if (!this.alive) return;
    if (this.spawnT < 1) {
      this.spawnT = Math.min(1, this.spawnT + dt / 0.9);
      const s = this.spawnT;
      this.mesh.scale.set(s * (1 + Math.sin(s * 40) * 0.15 * (1 - s)), s, s);
      this.mesh.position.set(this.x, (1 - s) * 2.5, this.z);
      return;
    }
    this.dashCd -= dt;
    this.fireCd -= dt;
    this.thinkT -= dt;
    while (this.thinkT <= 0) {
      this.think(game);
      this.thinkT += 1 / SAMPLE_HZ;
    }

    if (this.dashT > 0) {
      this.dashT -= dt;
      this.vx = this.dashX * ECHO.dashSpeed;
      this.vz = this.dashZ * ECHO.dashSpeed;
    } else {
      steer(this, this.wantX, this.wantZ, this.speed, ECHO.friction, dt);
    }
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    clampToArena(this, this.radius);

    // Aim where the model thinks you are going to be.
    const p = game.player;
    const dist = Math.hypot(p.x - this.x, p.z - this.z);
    const lead = dist / this.bulletSpeed;
    const conf = game.prediction.confidence;
    const tx = p.x + game.prediction.vx * lead * conf;
    const tz = p.z + game.prediction.vz * lead * conf;
    let ax = tx - this.x;
    let az = tz - this.z;
    const al = Math.hypot(ax, az) || 1;
    ax /= al;
    az /= al;
    this.aimX += (ax - this.aimX) * Math.min(1, dt * 12);
    this.aimZ += (az - this.aimZ) * Math.min(1, dt * 12);
    const nl = Math.hypot(this.aimX, this.aimZ) || 1;
    this.aimX /= nl;
    this.aimZ /= nl;

    if (this.shootIntent && this.fireCd <= 0 && p.alive) {
      this.fireCd = 1 / this.fireRate;
      const n = gauss() * (this.aimNoise + game.aimError);
      const bx = this.aimX * Math.cos(n) - this.aimZ * Math.sin(n);
      const bz = this.aimX * Math.sin(n) + this.aimZ * Math.cos(n);
      game.bullets.spawn('enemy', this.x + bx * 0.9, this.z + bz * 0.9, bx, bz, this.bulletSpeed, ECHO.bulletLife, this.color, 1, this.gen, 'echo');
      game.audio.echoShoot();
    }

    poseMesh(this, dt, 0);
    // Holographic glitch: occasional horizontal slips + hit flash.
    this.glitchT -= dt;
    const u = this.mesh.userData;
    if (this.glitchT <= 0) {
      this.glitchT = range(0.08, 0.6);
      u.tilt.position.x = chance(0.3) ? range(-0.18, 0.18) : 0;
    }
    this.flash = Math.max(0, this.flash - dt * 6);
    u.bodyMat.color.set(this.color).multiplyScalar(0.22 + this.flash * 2.5);
    this.mesh.scale.setScalar(1);
  }

  hurt(dmg) {
    this.hp -= dmg;
    this.flash = 1;
    if (this.hp <= 0) this.alive = false;
  }

  // Holographic materials are per-Echo (they flash on hit); free them on removal.
  dispose() {
    const u = this.mesh.userData;
    for (const m of [u.accentMat, u.bodyMat, u.outlineMat]) m?.dispose();
  }
}

// ---------------------------------------------------------------------------
// Drones: Bits rush you, Bytes keep their distance and lob slow bolts.

// Drones are spawned constantly, so their geometry and materials are cached
// (one set per shape/colour) instead of allocated per drone.
const droneCache = new Map();
function droneParts(geo, color, coreBoost) {
  const key = `${geo.uuid}:${color}:${coreBoost}`;
  if (!droneCache.has(key)) {
    droneCache.set(key, {
      edges: new THREE.EdgesGeometry(geo),
      fill: new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(0.16) }),
      line: new THREE.LineBasicMaterial({ color: neon(color, 2.6), toneMapped: false }),
      core: new THREE.MeshBasicMaterial({ color: neon(color, coreBoost), toneMapped: false }),
    });
  }
  return droneCache.get(key);
}

function droneMesh(geo, color, coreBoost = 3) {
  const S = shared();
  const P = droneParts(geo, color, coreBoost);
  const g = new THREE.Group();
  g.scale.setScalar(1.35);
  const fill = new THREE.Mesh(geo, P.fill);
  g.add(fill);
  const edges = new THREE.LineSegments(P.edges, P.line);
  edges.scale.setScalar(1.02);
  g.add(edges);
  const core = new THREE.Mesh(S.core, P.core);
  core.scale.setScalar(0.6);
  g.add(core);
  const root = new THREE.Group();
  root.add(g);
  const shadow = new THREE.Mesh(S.shadow, S.shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.03;
  shadow.scale.setScalar(0.7);
  root.add(shadow);
  shadow.scale.setScalar(0.95);
  root.userData = { spin: g, core, fill };
  return root;
}

export class Bit {
  constructor(scene, x, z) {
    this.kind = 'bit';
    this.mesh = droneMesh(shared().tetra, C.orange);
    scene.add(this.mesh);
    this.x = x;
    this.z = z;
    this.vx = this.vz = 0;
    this.radius = BIT.radius;
    this.hp = BIT.hp;
    this.alive = true;
    this.spawnT = 0;
    this.speed = BIT.speed * range(0.9, 1.12);
    this.wobble = rand() * 10;
    this.score = BIT.score;
    this.color = C.orange;
  }
  get active() {
    return this.alive && this.spawnT >= 1;
  }
  update(dt, game) {
    this.spawnT = Math.min(1, this.spawnT + dt / 0.7);
    const u = this.mesh.userData;
    if (this.spawnT < 1) {
      this.mesh.position.set(this.x, 3 * (1 - this.spawnT), this.z);
      this.mesh.scale.setScalar(this.spawnT);
      return;
    }
    const p = game.player;
    let dx = p.x - this.x;
    let dz = p.z - this.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d;
    dz /= d;
    // Weave a little so they don't arrive in a perfect line.
    this.wobble += dt * 3;
    const w = Math.sin(this.wobble) * 0.45;
    let tx = dx - dz * w;
    let tz = dz + dx * w;
    // Separation from other drones.
    for (const o of game.drones) {
      if (o === this || !o.alive) continue;
      const ox = this.x - o.x;
      const oz = this.z - o.z;
      const od = Math.hypot(ox, oz);
      if (od < 1.6 && od > 0.01) {
        tx += (ox / od) * (1.6 - od);
        tz += (oz / od) * (1.6 - od);
      }
    }
    const tl = Math.hypot(tx, tz) || 1;
    steer(this, tx / tl, tz / tl, this.speed, 4, dt);
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    clampToArena(this, this.radius);
    this.mesh.position.set(this.x, 0.55 + Math.sin(this.wobble * 2) * 0.08, this.z);
    this.mesh.scale.setScalar(1);
    u.spin.rotation.y += dt * 4;
    u.spin.rotation.x += dt * 2.3;
  }
  hurt(dmg) {
    this.hp -= dmg;
    if (this.hp <= 0) this.alive = false;
  }
}

export class Byte {
  constructor(scene, x, z) {
    this.kind = 'byte';
    this.mesh = droneMesh(shared().octa, C.sun, 1.7);
    scene.add(this.mesh);
    this.x = x;
    this.z = z;
    this.vx = this.vz = 0;
    this.radius = BYTE.radius;
    this.hp = BYTE.hp;
    this.alive = true;
    this.spawnT = 0;
    this.fireT = range(1.2, BYTE.fireEvery);
    this.orbit = chance(0.5) ? 1 : -1;
    this.score = BYTE.score;
    this.color = C.sun;
    this.flash = 0;
  }
  get active() {
    return this.alive && this.spawnT >= 1;
  }
  update(dt, game) {
    this.spawnT = Math.min(1, this.spawnT + dt / 0.8);
    const u = this.mesh.userData;
    if (this.spawnT < 1) {
      this.mesh.position.set(this.x, 3 * (1 - this.spawnT), this.z);
      this.mesh.scale.setScalar(this.spawnT);
      return;
    }
    const p = game.player;
    let dx = p.x - this.x;
    let dz = p.z - this.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d;
    dz /= d;
    const radial = d > BYTE.keepAway + 2 ? 1 : d < BYTE.keepAway - 2 ? -1 : 0;
    const tx = dx * radial - dz * this.orbit * 0.7;
    const tz = dz * radial + dx * this.orbit * 0.7;
    const tl = Math.hypot(tx, tz) || 1;
    steer(this, tx / tl, tz / tl, BYTE.speed, 3, dt);
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    if (clampToArena(this, this.radius)) this.orbit *= -1;

    this.fireT -= dt;
    const charging = this.fireT < 0.55;
    if (this.fireT <= 0 && p.alive) {
      this.fireT = BYTE.fireEvery * range(0.85, 1.15);
      game.bullets.spawn('enemy', this.x + dx, this.z + dz, dx, dz, BYTE.bulletSpeed, 3, C.sun, 1, 0);
      game.audio.enemyShoot();
    }
    this.flash = Math.max(0, this.flash - dt * 6);
    u.core.scale.setScalar(charging ? 0.6 + (0.55 - this.fireT) * 1.6 : 0.6);
    this.mesh.position.set(this.x, 0.75, this.z);
    this.mesh.scale.setScalar(1);
    u.spin.rotation.y += dt * 1.4;
  }
  hurt(dmg) {
    this.hp -= dmg;
    this.flash = 1;
    if (this.hp <= 0) this.alive = false;
  }
}

// ---------------------------------------------------------------------------
// Bullets: a flat pool rendered through two instanced meshes.

const M4 = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const V = new THREE.Vector3();
const S1 = new THREE.Vector3(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);
const COL = new THREE.Color();

export class Bullets {
  constructor(scene, max = 400) {
    const S = shared();
    this.list = [];
    this.playerBullets = [];
    this.enemyBullets = [];
    this.meshP = new THREE.InstancedMesh(S.bulletP, new THREE.MeshBasicMaterial({ color: neon(C.electric, 3.2), toneMapped: false }), max);
    this.meshE = new THREE.InstancedMesh(S.bulletE, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), max);
    this.meshE.setColorAt(0, COL.set(0xffffff));
    for (const m of [this.meshP, this.meshE]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
    }
    this.max = max;
  }

  spawn(owner, x, z, dx, dz, speed, life, color, dmg, gen, src = owner) {
    if (this.list.length >= this.max) return;
    this.list.push({ owner, src, x, z, vx: dx * speed, vz: dz * speed, life, color, dmg, gen, radius: owner === 'player' ? 0.18 : 0.26, dead: false });
  }

  clear() {
    this.list.length = 0;
    this.playerBullets.length = 0;
    this.enemyBullets.length = 0;
  }

  update(dt) {
    const keep = [];
    this.playerBullets.length = 0;
    this.enemyBullets.length = 0;
    for (const b of this.list) {
      if (b.dead) continue;
      b.life -= dt;
      b.x += b.vx * dt;
      b.z += b.vz * dt;
      if (b.life <= 0 || Math.hypot(b.x, b.z) > ARENA_R + 3) continue;
      keep.push(b);
      (b.owner === 'player' ? this.playerBullets : this.enemyBullets).push(b);
    }
    this.list = keep;
  }

  render() {
    let np = 0;
    let ne = 0;
    for (const b of this.list) {
      V.set(b.x, 0.6, b.z);
      if (b.owner === 'player') {
        Q.setFromAxisAngle(UP, Math.atan2(b.vx, b.vz));
        M4.compose(V, Q, S1);
        this.meshP.setMatrixAt(np++, M4);
      } else {
        M4.makeTranslation(V.x, V.y, V.z);
        this.meshE.setMatrixAt(ne, M4);
        this.meshE.setColorAt(ne, COL.set(b.color).multiplyScalar(3));
        ne++;
      }
    }
    this.meshP.count = np;
    this.meshE.count = ne;
    this.meshP.instanceMatrix.needsUpdate = true;
    this.meshE.instanceMatrix.needsUpdate = true;
    if (this.meshE.instanceColor) this.meshE.instanceColor.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// The prediction ghost: where the model thinks you'll be in half a second.

export class Ghost {
  constructor(scene) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const g = cv.getContext('2d');
    g.strokeStyle = '#FF4D9E';
    g.lineWidth = 10;
    g.setLineDash([22, 16]);
    g.beginPath();
    g.arc(128, 128, 110, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(128, 70);
    g.lineTo(128, 186);
    g.moveTo(70, 128);
    g.lineTo(186, 128);
    g.stroke();
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 2.1), this.mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.renderOrder = 3;
    scene.add(this.mesh);

    const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]);
    this.lineMat = new THREE.LineDashedMaterial({ color: neon(C.pink, 1.6), dashSize: 0.35, gapSize: 0.25, transparent: true, toneMapped: false });
    this.line = new THREE.Line(lg, this.lineMat);
    scene.add(this.line);
    this.x = 0;
    this.z = 0;
    this.alpha = 0;
    this.spin = 0;
  }

  update(dt, px, pz, tx, tz, show) {
    const k = 1 - Math.exp(-dt * 12);
    this.x += (tx - this.x) * k;
    this.z += (tz - this.z) * k;
    this.alpha += ((show ? 1 : 0) - this.alpha) * Math.min(1, dt * 6);
    this.spin += dt * 1.5;
    this.mesh.position.set(this.x, 0.07, this.z);
    this.mesh.rotation.z = this.spin;
    this.mat.opacity = this.alpha * 0.9;
    this.mesh.visible = this.alpha > 0.02;
    const pos = this.line.geometry.attributes.position;
    pos.setXYZ(0, px, 0.1, pz);
    pos.setXYZ(1, this.x, 0.1, this.z);
    pos.needsUpdate = true;
    this.line.computeLineDistances();
    this.lineMat.opacity = this.alpha * 0.7;
    this.line.visible = this.mesh.visible;
  }
}
