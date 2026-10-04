// Particles (one instanced mesh), expanding rings, and camera trauma.

import * as THREE from 'three';
import { rand, range } from './rng.js';

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const tmpE = new THREE.Euler();
const tmpC = new THREE.Color();

export class Particles {
  constructor(scene, max = 1600) {
    this.max = max;
    const geo = new THREE.OctahedronGeometry(0.11, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, tmpC.set(0xffffff));
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    const f = () => new Float32Array(max);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.life = f(); this.maxLife = f(); this.size = f(); this.spin = f();
    this.r = f(); this.g = f(); this.b = f(); this.drag = f(); this.grav = f();
    this.n = 0;
  }

  spawn(x, y, z, vx, vy, vz, life, size, color, drag = 2.5, grav = 0) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = this.maxLife[i] = life;
    this.size[i] = size;
    this.spin[i] = rand() * 10;
    tmpC.set(color);
    this.r[i] = tmpC.r; this.g[i] = tmpC.g; this.b[i] = tmpC.b;
    this.drag[i] = drag;
    this.grav[i] = grav;
  }

  // Radial burst on the ground plane with a little vertical pop.
  burst(x, y, z, color, count, speed = 8, life = 0.6, size = 1, boost = 2.2) {
    const c = new THREE.Color(color).multiplyScalar(boost);
    for (let k = 0; k < count; k++) {
      const a = rand() * Math.PI * 2;
      const s = speed * (0.35 + rand() * 0.75);
      this.spawn(x, y, z, Math.cos(a) * s, range(1, 5) * (speed / 8), Math.sin(a) * s, life * range(0.6, 1.2), size * range(0.6, 1.4), c, 3, -9);
    }
  }

  // Directional spray (e.g. sparks off a hit, opposite the bullet).
  spray(x, y, z, dx, dz, color, count, speed = 10, spread = 0.9, life = 0.35, size = 0.8) {
    const base = Math.atan2(dz, dx);
    const c = new THREE.Color(color).multiplyScalar(2);
    for (let k = 0; k < count; k++) {
      const a = base + (rand() - 0.5) * spread * 2;
      const s = speed * (0.4 + rand() * 0.8);
      this.spawn(x, y, z, Math.cos(a) * s, range(0.5, 3), Math.sin(a) * s, life * range(0.6, 1.3), size * range(0.6, 1.3), c, 4, -6);
    }
  }

  update(dt) {
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.n--;
        if (i !== this.n) this.copy(this.n, i);
        continue;
      }
      const d = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= d; this.vy[i] = this.vy[i] * d + this.grav[i] * dt; this.vz[i] *= d;
      this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
      if (this.py[i] < 0.05) {
        this.py[i] = 0.05;
        this.vy[i] *= -0.4;
      }
      i++;
    }
    const m = this.mesh;
    for (let j = 0; j < this.n; j++) {
      const t = this.life[j] / this.maxLife[j];
      const s = this.size[j] * (0.35 + 0.65 * t);
      tmpS.set(s, s, s);
      tmpE.set(this.spin[j] + t * 6, this.spin[j] * 0.5, 0);
      tmpQ.setFromEuler(tmpE);
      tmpP.set(this.px[j], this.py[j], this.pz[j]);
      tmpM.compose(tmpP, tmpQ, tmpS);
      m.setMatrixAt(j, tmpM);
      const f = Math.min(1, t * 1.6);
      m.setColorAt(j, tmpC.setRGB(this.r[j] * f, this.g[j] * f, this.b[j] * f));
    }
    m.count = this.n;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  copy(from, to) {
    for (const a of [this.px, this.py, this.pz, this.vx, this.vy, this.vz, this.life, this.maxLife, this.size, this.spin, this.r, this.g, this.b, this.drag, this.grav]) a[to] = a[from];
  }

  clear() {
    this.n = 0;
    this.mesh.count = 0;
  }
}

// Flat expanding rings for shockwaves and spawn telegraphs.
export class Rings {
  constructor(scene, max = 24) {
    this.pool = [];
    const geo = new THREE.RingGeometry(0.86, 1, 48);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < max; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 2;
      scene.add(mesh);
      this.pool.push({ mesh, t: 0, dur: 1, r0: 0, r1: 1, color: new THREE.Color(), active: false, alpha: 1 });
    }
  }

  spawn(x, z, color, r0, r1, dur, alpha = 1, y = 0.06) {
    const ring = this.pool.find((r) => !r.active) || this.pool[0];
    ring.active = true;
    ring.t = 0;
    ring.dur = dur;
    ring.r0 = r0;
    ring.r1 = r1;
    ring.alpha = alpha;
    ring.color.set(color).multiplyScalar(2);
    ring.mesh.position.set(x, y, z);
    ring.mesh.visible = true;
    return ring;
  }

  update(dt) {
    for (const r of this.pool) {
      if (!r.active) continue;
      r.t += dt;
      const k = Math.min(1, r.t / r.dur);
      const e = 1 - Math.pow(1 - k, 3);
      const s = r.r0 + (r.r1 - r.r0) * e;
      r.mesh.scale.set(s, 1, s);
      r.mesh.material.color.copy(r.color).multiplyScalar((1 - k) * r.alpha);
      if (k >= 1) {
        r.active = false;
        r.mesh.visible = false;
      }
    }
  }

  clear() {
    for (const r of this.pool) {
      r.active = false;
      r.mesh.visible = false;
    }
  }
}

// Camera trauma: shake grows with trauma², decays linearly.
export class Shake {
  constructor() {
    this.trauma = 0;
    this.t = 0;
    this.offset = new THREE.Vector3();
  }
  add(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }
  update(dt) {
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const s = this.trauma * this.trauma;
    const n = (seed) => Math.sin(this.t * 53.1 + seed) * Math.cos(this.t * 31.7 + seed * 2.3);
    this.offset.set(n(1.3) * s * 1.1, n(4.1) * s * 0.6, n(7.7) * s * 1.1);
    return this.offset;
  }
}
