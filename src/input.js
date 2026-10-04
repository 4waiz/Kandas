// Unified controls: keyboard + mouse, twin-stick touch, and gamepad all write into
// one "pad" ({ moveX, moveZ, aimX, aimZ, fire, dash }). The autopilot writes the
// same shape, so the game never cares who is playing.

import * as THREE from 'three';

const KEYS_UP = ['KeyW', 'ArrowUp', 'KeyZ'];
const KEYS_DOWN = ['KeyS', 'ArrowDown'];
const KEYS_LEFT = ['KeyA', 'ArrowLeft', 'KeyQ'];
const KEYS_RIGHT = ['KeyD', 'ArrowRight'];

export function newPad() {
  return { moveX: 0, moveZ: 0, aimX: 0, aimZ: -1, aimDist: 8, fire: false, dash: false };
}

export class Input {
  constructor(canvas, overlay) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouse = { x: 0, y: 0, inside: false, left: false };
    this.ndc = new THREE.Vector2();
    this.ray = new THREE.Raycaster();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.6);
    this.hit = new THREE.Vector3();
    this.pad = newPad();
    this.dashQueued = false;
    this.mode = 'mouse'; // 'mouse' | 'touch' | 'gamepad'
    this.listeners = {};
    this.touch = new TouchSticks(overlay, this);

    addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (!this.keys.has(e.code)) {
        if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.dashQueued = true;
        this.emit('key', e.code);
      }
      this.keys.add(e.code);
      this.mode = this.mode === 'touch' ? 'touch' : 'mouse';
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => {
      this.keys.clear();
      this.mouse.left = false;
    });
    addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.mouse.inside = true;
      this.mode = 'mouse';
    });
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      if (e.button === 0) this.mouse.left = true;
      if (e.button === 2) this.dashQueued = true;
    });
    addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') return;
      if (e.button === 0) this.mouse.left = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  on(name, fn) {
    (this.listeners[name] ||= []).push(fn);
  }

  emit(name, arg) {
    for (const fn of this.listeners[name] || []) fn(arg);
  }

  // Refresh the pad. `origin` is the player's world position (for aim direction).
  update(camera, origin) {
    const p = this.pad;
    let mx = 0;
    let mz = 0;
    const k = this.keys;
    if (KEYS_LEFT.some((c) => k.has(c))) mx -= 1;
    if (KEYS_RIGHT.some((c) => k.has(c))) mx += 1;
    if (KEYS_UP.some((c) => k.has(c))) mz -= 1;
    if (KEYS_DOWN.some((c) => k.has(c))) mz += 1;
    const len = Math.hypot(mx, mz);
    if (len > 0) {
      mx /= len;
      mz /= len;
    }
    let fire = this.mouse.left;
    let dash = this.dashQueued;
    this.dashQueued = false;

    // Mouse aim: ray through the cursor onto the plane at body height.
    if (this.mode === 'mouse' && this.mouse.inside) {
      const r = this.canvas.getBoundingClientRect();
      this.ndc.set(((this.mouse.x - r.left) / r.width) * 2 - 1, -((this.mouse.y - r.top) / r.height) * 2 + 1);
      this.ray.setFromCamera(this.ndc, camera);
      if (this.ray.ray.intersectPlane(this.plane, this.hit)) {
        const ax = this.hit.x - origin.x;
        const az = this.hit.z - origin.z;
        const d = Math.hypot(ax, az);
        if (d > 0.05) {
          p.aimX = ax / d;
          p.aimZ = az / d;
          p.aimDist = d;
        }
      }
    }

    // Touch sticks.
    const t = this.touch;
    if (t.active) {
      this.mode = 'touch';
      if (t.move.on) {
        mx = t.move.x;
        mz = t.move.y;
      }
      if (t.aim.on && Math.hypot(t.aim.x, t.aim.y) > 0.25) {
        const d = Math.hypot(t.aim.x, t.aim.y);
        p.aimX = t.aim.x / d;
        p.aimZ = t.aim.y / d;
        p.aimDist = 8;
        fire = true;
      }
      if (t.consumeDash()) dash = true;
    }

    // Gamepad (first connected).
    const gp = navigator.getGamepads ? Array.from(navigator.getGamepads()).find((g) => g && g.connected) : null;
    if (gp) {
      const dz = (v) => (Math.abs(v) < 0.18 ? 0 : v);
      const lx = dz(gp.axes[0] || 0);
      const ly = dz(gp.axes[1] || 0);
      const rx = dz(gp.axes[2] || 0);
      const ry = dz(gp.axes[3] || 0);
      if (lx || ly || rx || ry) this.mode = 'gamepad';
      if (this.mode === 'gamepad') {
        if (lx || ly) {
          mx = lx;
          mz = ly;
        }
        const rl = Math.hypot(rx, ry);
        if (rl > 0.3) {
          p.aimX = rx / rl;
          p.aimZ = ry / rl;
          p.aimDist = 8;
          fire = true;
        }
        const pressed = (i) => gp.buttons[i] && gp.buttons[i].pressed;
        if (pressed(7)) fire = true;
        const dashBtn = pressed(0) || pressed(5) || pressed(4);
        if (dashBtn && !this.gpDash) dash = true;
        this.gpDash = dashBtn;
        if (pressed(9) && !this.gpStart) this.emit('key', 'Escape');
        this.gpStart = pressed(9);
        if (pressed(0) && !this.gpA) this.emit('key', 'GamepadA');
        this.gpA = pressed(0);
      }
    }

    const ml = Math.hypot(mx, mz);
    if (ml > 1) {
      mx /= ml;
      mz /= ml;
    }
    p.moveX = mx;
    p.moveZ = mz;
    p.fire = fire;
    p.dash = dash;
    return p;
  }
}

// ---------------------------------------------------------------------------
// Twin-stick touch controls (left half = move, right half = aim + auto-fire).

class TouchSticks {
  constructor(overlay, input) {
    this.input = input;
    this.active = false;
    this.move = { on: false, id: -1, ox: 0, oy: 0, x: 0, y: 0 };
    this.aim = { on: false, id: -1, ox: 0, oy: 0, x: 0, y: 0 };
    this.dashFlag = false;
    this.root = document.createElement('div');
    this.root.className = 'touch-ui';
    this.root.innerHTML = `
      <div class="stick" data-s="move"><div class="knob"></div></div>
      <div class="stick" data-s="aim"><div class="knob"></div></div>
      <button class="dash-btn" type="button">DASH</button>`;
    overlay.appendChild(this.root);
    this.els = {
      move: this.root.querySelector('[data-s=move]'),
      aim: this.root.querySelector('[data-s=aim]'),
    };
    this.root.querySelector('.dash-btn').addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.dashFlag = true;
    });

    const target = input.canvas;
    const R = 56;
    const start = (e) => {
      this.enable();
      for (const t of e.changedTouches) {
        const s = t.clientX < innerWidth / 2 ? this.move : this.aim;
        if (s.on) continue;
        s.on = true;
        s.id = t.identifier;
        s.ox = t.clientX;
        s.oy = t.clientY;
        s.x = s.y = 0;
        this.place(s === this.move ? 'move' : 'aim', s);
      }
      e.preventDefault();
    };
    const moveH = (e) => {
      for (const t of e.changedTouches) {
        for (const [name, s] of [['move', this.move], ['aim', this.aim]]) {
          if (s.on && s.id === t.identifier) {
            let dx = (t.clientX - s.ox) / R;
            let dy = (t.clientY - s.oy) / R;
            const l = Math.hypot(dx, dy);
            if (l > 1) {
              dx /= l;
              dy /= l;
            }
            s.x = dx;
            s.y = dy;
            this.place(name, s);
          }
        }
      }
      e.preventDefault();
    };
    const end = (e) => {
      for (const t of e.changedTouches) {
        for (const [name, s] of [['move', this.move], ['aim', this.aim]]) {
          if (s.on && s.id === t.identifier) {
            s.on = false;
            s.x = s.y = 0;
            this.els[name].classList.remove('on');
          }
        }
      }
    };
    target.addEventListener('touchstart', start, { passive: false });
    target.addEventListener('touchmove', moveH, { passive: false });
    target.addEventListener('touchend', end);
    target.addEventListener('touchcancel', end);
  }

  enable() {
    if (this.active) return;
    this.active = true;
    document.body.classList.add('touch');
  }

  place(name, s) {
    const el = this.els[name];
    el.classList.add('on');
    el.style.left = `${s.ox}px`;
    el.style.top = `${s.oy}px`;
    el.firstElementChild.style.transform = `translate(${s.x * 40}px, ${s.y * 40}px)`;
  }

  consumeDash() {
    const d = this.dashFlag;
    this.dashFlag = false;
    return d;
  }
}
