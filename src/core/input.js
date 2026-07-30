// Keyboard, mouse, gamepad and touch folded into one intent struct that the
// duck controller reads. No system should touch DOM events directly.

import * as THREE from 'three';

const KEY_MAP = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
  Space: 'dive',
  KeyQ: 'quack',
  KeyE: 'interact',
  KeyF: 'flap',
  KeyC: 'call',
  KeyH: 'help',
  KeyP: 'pause', Escape: 'pause',
  Tab: 'map',
};

export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.keys = Object.create(null);
    this.pressed = Object.create(null); // edge-triggered, cleared each frame
    this.released = Object.create(null);

    // Analogue intents, all normalised.
    this.move = new THREE.Vector2(); // x = strafe, y = forward
    this.look = new THREE.Vector2(); // accumulated look delta this frame
    this.zoom = 0;
    this.pointerLocked = false;
    this.touchActive = false;

    this._bind();
  }

  _bind() {
    const stopIfGame = (e) => {
      if (KEY_MAP[e.code]) e.preventDefault();
    };

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const a = KEY_MAP[e.code];
      if (!a) return;
      stopIfGame(e);
      if (!this.keys[a]) this.pressed[a] = true;
      this.keys[a] = true;
    });

    window.addEventListener('keyup', (e) => {
      const a = KEY_MAP[e.code];
      if (!a) return;
      stopIfGame(e);
      this.keys[a] = false;
      this.released[a] = true;
    });

    window.addEventListener('blur', () => {
      for (const k in this.keys) this.keys[k] = false;
    });

    this.dom.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') {
        this.touchActive = true;
        this._touchStart(e);
        return;
      }
      if (e.button === 0 && !this.pointerLocked) {
        this.dom.requestPointerLock?.();
      }
      this.pressed[e.button === 2 ? 'aim' : 'primary'] = true;
      this.keys[e.button === 2 ? 'aim' : 'primary'] = true;
    });

    this.dom.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') {
        this._touchEnd(e);
        return;
      }
      const a = e.button === 2 ? 'aim' : 'primary';
      this.keys[a] = false;
      this.released[a] = true;
    });

    this.dom.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') {
        this._touchMove(e);
        return;
      }
      if (this.pointerLocked) {
        this.look.x += e.movementX;
        this.look.y += e.movementY;
      } else if (this.keys.primary) {
        this.look.x += e.movementX;
        this.look.y += e.movementY;
      }
    });

    this.dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom += Math.sign(e.deltaY) * 0.5;
    }, { passive: false });

    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.dom;
    });

    // Touch: left half is a virtual stick, right half swipes the camera.
    this._sticks = new Map();
  }

  _touchStart(e) {
    const left = e.clientX < window.innerWidth * 0.5;
    this._sticks.set(e.pointerId, {
      left, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY,
      t: performance.now(),
    });
    if (!left) this.keys.primary = true;
  }

  _touchMove(e) {
    const s = this._sticks.get(e.pointerId);
    if (!s) return;
    if (s.left) {
      const r = 90;
      this.move.x = THREE.MathUtils.clamp((e.clientX - s.ox) / r, -1, 1);
      this.move.y = THREE.MathUtils.clamp(-(e.clientY - s.oy) / r, -1, 1);
    } else {
      this.look.x += e.clientX - s.x;
      this.look.y += e.clientY - s.y;
    }
    s.x = e.clientX;
    s.y = e.clientY;
  }

  _touchEnd(e) {
    const s = this._sticks.get(e.pointerId);
    if (s) {
      if (s.left) this.move.set(0, 0);
      else {
        // A quick tap on the right half means dive.
        const dt = performance.now() - s.t;
        const moved = Math.hypot(e.clientX - s.ox, e.clientY - s.oy);
        if (dt < 260 && moved < 18) this.pressed.dive = true;
        this.keys.primary = false;
      }
      this._sticks.delete(e.pointerId);
    }
  }

  _pollGamepad() {
    const pads = navigator.getGamepads?.();
    if (!pads) return;
    for (const pad of pads) {
      if (!pad) continue;
      const dz = (v) => (Math.abs(v) < 0.16 ? 0 : v);
      const lx = dz(pad.axes[0] || 0);
      const ly = dz(pad.axes[1] || 0);
      if (lx || ly) {
        this.move.x = lx;
        this.move.y = -ly;
      }
      this.look.x += dz(pad.axes[2] || 0) * 12;
      this.look.y += dz(pad.axes[3] || 0) * 12;
      const btn = (i) => !!pad.buttons[i]?.pressed;
      const set = (a, v) => {
        if (v && !this.keys[a]) this.pressed[a] = true;
        if (!v && this.keys[a]) this.released[a] = true;
        this.keys[a] = v || this.keys[a] === undefined ? v : this.keys[a] || v;
        this.keys[a] = v;
      };
      set('dive', btn(0));
      set('quack', btn(2));
      set('interact', btn(3));
      set('sprint', btn(1) || btn(10));
      set('call', btn(4));
    }
  }

  /** Call once per frame, before systems update. */
  update() {
    // Keyboard overrides the virtual stick when a key is actually held.
    const kx = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
    const ky = (this.keys.forward ? 1 : 0) - (this.keys.back ? 1 : 0);
    if (kx || ky) {
      const len = Math.hypot(kx, ky) || 1;
      this.move.set(kx / len, ky / len);
    } else if (!this.touchActive) {
      this.move.set(0, 0);
    }
    this._pollGamepad();
  }

  /** Call at the very end of a frame. */
  endFrame() {
    for (const k in this.pressed) this.pressed[k] = false;
    for (const k in this.released) this.released[k] = false;
    this.look.set(0, 0);
    this.zoom = 0;
  }

  justPressed(action) { return !!this.pressed[action]; }
  isDown(action) { return !!this.keys[action]; }
}
