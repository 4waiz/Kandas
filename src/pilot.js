// Autopilot: a scripted "human-ish" player used for the title-screen attract mode
// and the trailer capture. It has a recognisable style on purpose (keeps ~8 m,
// orbits counter-clockwise most of the time, dashes away from close bullets) so
// you can watch its Echo inherit that style.

import { ARENA_R, PLAYER } from './config.js';
import { range, chance } from './rng.js';

export class Pilot {
  constructor(style = {}) {
    this.orbit = style.orbit ?? 1; // +1 = counter-clockwise on screen
    this.ccwBias = style.ccwBias ?? 0.78;
    this.near = style.near ?? 6.5;
    this.far = style.far ?? 10;
    this.switchT = range(3, 6);
    this.holdT = 0;
    this.keyX = 0;
    this.keyZ = 0;
    this.aimJitter = 0;
    this.pauseT = 0;
    this.styleDashT = range(1.5, 3);
    // Human-ish aim: partial lead and a slow sway, so it misses like a person.
    this.lead = style.lead ?? 0.5;
    this.sway = style.sway ?? 0.2;
  }

  update(dt, game, pad) {
    const p = game.player;
    pad.dash = false;
    pad.fire = false;
    if (!p.alive) {
      pad.moveX = pad.moveZ = 0;
      return;
    }

    // Pick a target: Echoes first, else the nearest drone.
    let target = null;
    let best = Infinity;
    for (const e of game.echoes) {
      if (!e.active) continue;
      const d = Math.hypot(e.x - p.x, e.z - p.z) * 0.6;
      if (d < best) {
        best = d;
        target = e;
      }
    }
    for (const d of game.drones) {
      if (!d.active) continue;
      const dd = Math.hypot(d.x - p.x, d.z - p.z);
      if (dd < best) {
        best = dd;
        target = d;
      }
    }

    this.switchT -= dt;
    if (this.switchT <= 0) {
      this.orbit = chance(this.ccwBias) ? 1 : -1;
      this.switchT = range(2.5, 6);
      if (chance(0.25)) this.pauseT = range(0.25, 0.6);
    }

    let mx = 0;
    let mz = 0;
    if (target) {
      const dx = target.x - p.x;
      const dz = target.z - p.z;
      const dist = Math.hypot(dx, dz) || 1;
      const fx = dx / dist;
      const fz = dz / dist;
      const rx = -fz;
      const rz = fx;
      const fwd = dist > this.far ? 0.85 : dist < this.near ? -0.9 : 0;
      const lat = target.kind === 'bit' && dist < 4 ? 0.5 * this.orbit : this.orbit;
      mx = rx * lat + fx * fwd;
      mz = rz * lat + fz * fwd;

      // Aim with lead, plus a little human wobble.
      this.aimJitter += (range(-this.sway, this.sway) * 2 - this.aimJitter) * Math.min(1, dt * 2.5);
      const t = (dist / PLAYER.bulletSpeed) * this.lead;
      let ax = target.x + (target.vx || 0) * t - p.x;
      let az = target.z + (target.vz || 0) * t - p.z;
      const al = Math.hypot(ax, az) || 1;
      ax /= al;
      az /= al;
      const c = Math.cos(this.aimJitter);
      const s = Math.sin(this.aimJitter);
      pad.aimX = ax * c - az * s;
      pad.aimZ = ax * s + az * c;
      pad.aimDist = dist;
      pad.fire = dist < 26;
    } else {
      mx = -p.x * 0.1;
      mz = -p.z * 0.1;
    }

    // Dodge: bullets whose closest approach is near us, soon.
    let dodgeX = 0;
    let dodgeZ = 0;
    let urgent = false;
    for (const b of game.bullets.enemyBullets) {
      const rx = p.x - b.x;
      const rz = p.z - b.z;
      const vv = b.vx * b.vx + b.vz * b.vz;
      const tca = (rx * b.vx + rz * b.vz) / vv;
      if (tca < 0 || tca > 0.75) continue;
      const cx = b.x + b.vx * tca - p.x;
      const cz = b.z + b.vz * tca - p.z;
      const miss = Math.hypot(cx, cz);
      if (miss > 1.5) continue;
      const w = (1.5 - miss) / 1.5;
      const ml = miss || 0.01;
      dodgeX -= (cx / ml) * w * 2.2;
      dodgeZ -= (cz / ml) * w * 2.2;
      if (tca < 0.22 && miss < 0.9) urgent = true;
    }
    for (const d of game.drones) {
      if (!d.active || d.kind !== 'bit') continue;
      const dd = Math.hypot(d.x - p.x, d.z - p.z);
      if (dd < 2.6) {
        dodgeX -= ((d.x - p.x) / dd) * (2.6 - dd);
        dodgeZ -= ((d.z - p.z) / dd) * (2.6 - dd);
        if (dd < 1.5) urgent = true;
      }
    }
    mx += dodgeX;
    mz += dodgeZ;

    // Stay off the wall.
    const r = Math.hypot(p.x, p.z);
    if (r > ARENA_R - 4) {
      const k = (r - (ARENA_R - 4)) * 0.55;
      mx -= (p.x / r) * k;
      mz -= (p.z / r) * k;
    }

    if (urgent && p.dashCd <= 0 && (dodgeX || dodgeZ)) {
      pad.dash = true;
    }
    // A habit: a sideways dash every few seconds while circling.
    this.styleDashT -= dt;
    if (this.styleDashT <= 0 && p.dashCd <= 0 && target) {
      pad.dash = true;
      this.styleDashT = range(1.8, 3.4);
    }

    // Quantise to 8 directions with a short hold, like a person on WASD.
    this.pauseT -= dt;
    this.holdT -= dt;
    if (this.holdT <= 0 || urgent) {
      const l = Math.hypot(mx, mz);
      if (l < 0.25 || this.pauseT > 0) {
        this.keyX = this.keyZ = 0;
      } else {
        const a = Math.round(Math.atan2(mz, mx) / (Math.PI / 4)) * (Math.PI / 4);
        this.keyX = Math.round(Math.cos(a));
        this.keyZ = Math.round(Math.sin(a));
      }
      this.holdT = range(0.09, 0.2);
    }
    const kl = Math.hypot(this.keyX, this.keyZ) || 1;
    pad.moveX = this.keyX / kl;
    pad.moveZ = this.keyZ / kl;
    if (!this.keyX && !this.keyZ) pad.moveX = pad.moveZ = 0;
  }
}
