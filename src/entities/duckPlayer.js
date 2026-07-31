/**
 * duckPlayer.js — the player duck: buoyant physics, swimming, diving, walking.
 *
 * The feel brief: the duck must have *weight*. It floats rather than hovers,
 * it is carried by the current, it arcs into turns instead of pivoting, and it
 * never stops instantly. Underwater it becomes a proper 3D swimmer with a
 * breath meter; on the bank it waddles.
 *
 * Everything below runs allocation-free after init(): all scratch vectors are
 * instance fields, and every cross-system read is guarded so the duck behaves
 * sanely when water / river / particles are missing.
 *
 * Coordinate notes
 *   * the duck model faces +Z, up is +Y, and its local y = 0 is the floating
 *     waterline (see duck.js), so object.position.y == water surface height
 *     puts the waterline exactly where it belongs.
 *   * yaw is measured so that forward = (sin yaw, 0, cos yaw).
 *   * pitch > 0 is nose-up; roll < 0 banks to the duck's right.
 */

import * as THREE from 'three';
import { createDuck } from './duck.js';
import { settings, WATER_LEVEL } from '../core/settings.js';

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const smoothstep = THREE.MathUtils.smoothstep;

/** Spring scale length of the buoyancy restoring force, in metres. */
const DRAFT = 0.40;
/** Fraction of DRAFT submerged at rest — buoyancy * this == gravity. */
const EQ = settings.gravity / settings.buoyancy;
/** Vertical drag while in the water. */
const VERT_DRAG = 4.2;
/** Body clearance when standing on the ground. */
const LAND_LIFT = 0.085;

/**
 * Fraction of the river's current that acts on the player, 0..1. Ambient drift
 * is lovely right up until it stops you steering; every other system still uses
 * the full flow field.
 */
const CURRENT_AUTHORITY = 0.5;
/** Depth (m) at which the duck counts as submerged / stops counting. */
const SUB_ENTER = 0.20;
const SUB_EXIT = 0.09;

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Critically damped smoothing (Game Programming Gems 4), allocation free. */
const _damp = { p: 0, v: 0 };
function damp1(cur, tgt, vel, omega, dt) {
  const x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - tgt;
  const temp = (vel + omega * change) * dt;
  _damp.v = (vel - omega * temp) * e;
  _damp.p = tgt + (change + temp) * e;
  return _damp;
}

/** A visible stand-in used only if duck.js is still a stub. */
function makeProxyDuck() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xe8c15a, roughness: 0.7 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.16, 18, 12), mat);
  body.scale.set(1.0, 0.85, 1.55);
  body.position.set(0, 0.02, -0.02);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.16, 10), mat);
  neck.position.set(0, 0.14, 0.13);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.075, 14, 10), mat);
  head.position.set(0, 0.23, 0.17);
  const bill = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.025, 0.09), mat);
  bill.position.set(0, 0.215, 0.24);
  for (const m of [body, neck, head, bill]) { m.castShadow = true; g.add(m); }
  return {
    object: g,
    proxy: true,
    bones: { head },
    update() {},
    setPose() {},
    headPosition(out = new THREE.Vector3()) {
      return head.getWorldPosition(out);
    },
    billPosition(out = new THREE.Vector3()) {
      return bill.getWorldPosition(out);
    },
    dispose() {
      g.traverse((o) => { o.geometry?.dispose?.(); });
      mat.dispose();
    },
  };
}

/**
 * Installs a callback that fires as soon as main.js publishes window.__duck,
 * so the capture harness gets forceDive()/cinematic without main.js knowing
 * about us. (main.js is off limits, and it assigns __duck after every system
 * has booted.)
 */
function whenDuckHandle(fn) {
  if (typeof window === 'undefined') return;
  if (window.__duck) { fn(window.__duck); return; }
  let store;
  try {
    Object.defineProperty(window, '__duck', {
      configurable: true,
      enumerable: true,
      get() { return store; },
      set(v) {
        store = v;
        try { if (v) fn(v); } catch (err) { console.warn('[player] handle hook', err); }
      },
    });
  } catch (err) {
    console.warn('[player] could not hook window.__duck', err);
  }
}

export class DuckPlayer {
  constructor(ctx) {
    this.ctx = ctx;
    const THREEns = ctx.THREE || THREE;
    this.THREE = THREEns;

    /* ---- public contract ---- */
    this.object = new THREE.Group();
    this.object.name = 'player';
    this.position = this.object.position;
    this.velocity = new THREE.Vector3();
    this.submerged = false;
    this.depthBelow = 0;
    this.breath = 1;
    this.riverCoord = { s: 0, u: 0, distance: 0 };
    this.state = 'float';
    this.speed = 0;
    this.wetness = 0;

    /* ---- extras other systems find useful ---- */
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.stamina = 1;
    this.grounded = false;
    this.airborne = false;
    this.waterHeight = ctx.WATER_LEVEL ?? WATER_LEVEL;
    this.bedHeight = -1;
    this.duck = null;

    /* ---- internal state ---- */
    this._yawVel = 0;
    this._pitchTarget = 0;
    this._pitchVel = 0;
    this._pose = 'auto';
    this._wavePitch = 0; this._wavePitchV = 0;
    this._waveRoll = 0; this._waveRollV = 0;
    this._bankRoll = 0; this._bankRollV = 0;
    this._buoyScale = 1;
    this._paddlePhase = 0;
    this._stepPhase = 0;
    this._wakeAcc = 0;
    this._bubbleAcc = 0;
    this._forcedDepth = -1;
    this._forcedTimer = 0;
    this._diveHold = 0;
    this._gasping = false;
    this._subTimer = 0;
    this._flapCool = 0;
    this._justTeleported = 0;
    this._prevWaterY = 0;
    this._preenT = 0;
    this._dabbleT = 0;

    /* ---- scratch (no per-frame allocation) ---- */
    this._v0 = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._fwd = new THREE.Vector3(0, 0, 1);
    this._right = new THREE.Vector3(1, 0, 0);
    this._camFwd = new THREE.Vector3(0, 0, 1);
    this._camRight = new THREE.Vector3(1, 0, 0);
    this._camDir = new THREE.Vector3(0, 0, 1);
    this._flow = new THREE.Vector3();
    this._normal = new THREE.Vector3(0, 1, 0);
    this._accel = new THREE.Vector3();
    this._head = new THREE.Vector3();
    this._bill = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._scratchCoord = { s: 0, u: 0, distance: 0 };
    this._eventPos = new THREE.Vector3();
    this._duckParams = {
      speed: 0, paddle: 0, turn: 0, submerged: 0, look: null,
      flap: false, quack: 0, wetness: 0, dabble: 0, alert: 0,
    };
  }

  async init() {
    const ctx = this.ctx;
    try {
      this.duck = createDuck({ variant: 'drake', scale: 1.0, seed: 7, castShadow: true });
      if (!this.duck?.object || this.duck.object.children.length === 0) throw new Error('empty duck');
    } catch (err) {
      console.warn('[player] duck.js unavailable, using proxy:', err.message);
      this.duck = makeProxyDuck();
    }
    this.object.add(this.duck.object);
    ctx.scene.add(this.object);

    // Start in the calm water a little way downstream, facing the current.
    const startS = 120;
    this.teleportRiver(startS, 0);

    this._offs = [];
    // The screenshot harness pokes these; main.js does not forward them.
    whenDuckHandle((h) => {
      h.player = this;
      if (!h.forceDive) h.forceDive = (d) => this.forceDive(d);
      if (!h.surface) h.surface = () => this.surface(true);
      if (!h.teleport) h.teleport = (s, u = 0) => this.teleportRiver(s, u);
      if (h.cinematic === undefined) h.cinematic = false;
      if (!h.rig) h.rig = this.ctx.camera?.isCameraRig ? this.ctx.camera : undefined;
    });
  }

  /* ───────────────────────────── public API ──────────────────────────────── */

  headPosition(out = this._head) {
    if (this.duck?.headPosition) return this.duck.headPosition(out);
    return out.copy(this.position).addScaledVector(this._fwd, 0.2).setY(this.position.y + 0.24);
  }

  billPosition(out = this._bill) {
    if (this.duck?.billPosition) return this.duck.billPosition(out);
    return this.headPosition(out).addScaledVector(this._fwd, 0.08);
  }

  forward(out = this._v0) {
    const cp = Math.cos(this.pitch);
    return out.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
  }

  /** Drop the duck at river coords (s, u). Used by the capture harness. */
  teleportRiver(s, u = 0) {
    const river = this.ctx.river;
    if (!river) return;
    const sc = clamp(s, 4, river.length - 4);
    river.toWorld(sc, clamp(u, -3, 3), 0, this.position);
    const wy = this._sampleWater(this.position.x, this.position.z);
    const bed = river.bedHeight(sc, u);
    this.position.y = Math.max(wy, bed + LAND_LIFT);
    river.tangent(sc, this._v1);
    this.yaw = Math.atan2(this._v1.x, this._v1.z);
    this.velocity.set(0, 0, 0);
    this._yawVel = 0;
    this.pitch = 0;
    this.roll = 0;
    this._wavePitch = this._waveRoll = this._bankRoll = 0;
    this._wavePitchV = this._waveRollV = this._bankRollV = 0;
    this._forcedDepth = -1;
    this._forcedTimer = 0;
    this.breath = 1;
    this.depthBelow = 0;
    this.submerged = false;
    this._gasping = false;
    this.state = 'float';
    this._justTeleported = 1;
    this._applyTransform();
    this.object.updateMatrixWorld(true);
    river.toRiver(this.position, this.riverCoord);
    this.ctx.camera?.snap?.();
  }

  /**
   * Force the duck under to a given depth and hold it there (the capture
   * harness uses this for the dive and waterline shots). Any player input
   * releases the hold.
   */
  forceDive(depth = 2.0) {
    const d = Math.max(0.15, depth);
    this._forcedDepth = d;
    this._forcedTimer = 600;
    const wy = this._sampleWater(this.position.x, this.position.z);
    this.waterHeight = wy;
    // Snap, then hold with the spring. The capture harness settles in wall
    // clock time and the software renderer runs the simulation an order of
    // magnitude slower than real time, so "swim down over two seconds" would
    // never arrive. Gameplay dives use the physics path, not this one.
    const bed = this.ctx.river
      ? this.ctx.river.bedHeight(this.riverCoord.s, this.riverCoord.u) : wy - d - 1;
    this.position.y = Math.max(wy - d, bed + 0.30);
    this.velocity.set(0, 0, 0);
    this.pitch = -0.18;
    this.depthBelow = Math.max(0, wy - this.position.y);
    this.wetness = 1;
    if (!this.submerged) this._enterSubmerged(true);
    this._applyTransform();
    this.ctx.camera?.snap?.();
  }

  /** Cancel a dive and head for the surface. */
  surface(immediate = false) {
    this._forcedDepth = -1;
    this._forcedTimer = 0;
    this._diveHold = 0;
    if (immediate) {
      this.position.y = this.waterHeight;
      this.velocity.y = 0;
    } else {
      this.velocity.y = Math.max(this.velocity.y, 1.6);
    }
  }

  /* ──────────────────────────────── update ───────────────────────────────── */

  update(dt, elapsed) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 1 / 20);
    const ctx = this.ctx;
    const river = ctx.river;
    const input = ctx.input;
    const pos = this.position;

    /* ── environment sampling ─────────────────────────────────────────── */
    const waterY = this._sampleWater(pos.x, pos.z);
    this.waterHeight = waterY;
    if (river) river.toRiver(pos, this.riverCoord);
    const rc = this.riverCoord;
    const bedY = river ? river.bedHeight(rc.s, rc.u) : -4;
    this.bedHeight = bedY;
    const localDepth = Math.max(0, waterY - bedY); // water column depth here
    const overWater = localDepth > 0.24;

    this.depthBelow = Math.max(0, waterY - pos.y);
    const depth = this.depthBelow;

    /* ── input intents ────────────────────────────────────────────────── */
    let mx = 0, my = 0, sprint = false, diveHeld = false;
    let divePressed = false, flapPressed = false, quackPressed = false;
    let interactPressed = false;
    if (input) {
      mx = input.move?.x ?? 0;
      my = input.move?.y ?? 0;
      sprint = input.isDown?.('sprint') ?? false;
      diveHeld = input.isDown?.('dive') ?? false;
      divePressed = input.justPressed?.('dive') ?? false;
      flapPressed = input.justPressed?.('flap') ?? false;
      quackPressed = input.justPressed?.('quack') ?? false;
      interactPressed = input.justPressed?.('interact') ?? false;
    }
    const inputMag = Math.min(1, Math.hypot(mx, my));
    const hasInput = inputMag > 0.02 || divePressed || flapPressed;
    if (hasInput && this._forcedTimer > 0) {
      // Player took over from the capture harness.
      this._forcedDepth = -1;
      this._forcedTimer = 0;
    }
    if (this._forcedTimer > 0) this._forcedTimer -= dt;
    else if (this._forcedDepth > 0) this._forcedDepth = -1;

    /* ── camera basis for camera-relative movement ────────────────────── */
    this._cameraBasis();
    const dirX = this._camRight.x * mx + this._camFwd.x * my;
    const dirZ = this._camRight.z * mx + this._camFwd.z * my;
    const dirLen = Math.hypot(dirX, dirZ);

    /* ── state selection ──────────────────────────────────────────────── */
    const wantSubmerged = depth > (this.submerged ? SUB_EXIT : SUB_ENTER);
    if (wantSubmerged !== this.submerged) this._enterSubmerged(wantSubmerged);
    if (this.submerged) this._subTimer += dt; else this._subTimer = 0;

    const grounded = pos.y <= bedY + LAND_LIFT + 0.02 && !overWater;
    const wasGrounded = this.grounded;
    this.grounded = grounded && !this.airborne;

    /* ── breath ───────────────────────────────────────────────────────── */
    const breathSecs = Math.max(4, ctx.settings?.breathSeconds ?? 16);
    if (this.submerged && this._forcedDepth < 0) {
      this.breath = Math.max(0, this.breath - dt / breathSecs);
      if (this.breath <= 0 && !this._gasping) {
        this._gasping = true;
        ctx.events?.emit(ctx.EVENTS.TOAST, { text: 'Out of breath!', icon: '💨', duration: 1.6 });
      }
    } else {
      if (this.breath < 1) this.breath = Math.min(1, this.breath + dt * (this._gasping ? 0.55 : 0.34));
      if (this.breath > 0.35) this._gasping = false;
    }

    /* ── stamina (sprint) ─────────────────────────────────────────────── */
    const sprinting = sprint && inputMag > 0.1 && this.stamina > 0.02 && !this.grounded;
    this.stamina = clamp(
      this.stamina + (sprinting ? -dt / 6.5 : dt / 4.0), 0, 1
    );

    /* ── forces ───────────────────────────────────────────────────────── */
    const a = this._accel.set(0, 0, 0);
    const vel = this.velocity;

    // Current. Only where there is actually water to be carried by.
    if (river && overWater) {
      river.flowAt(rc.s, rc.u, this._flow);
      // A floating duck only presents its draft to the current; a submerged one
      // gets the lot. Near the bed the water barely moves.
      // Playtest: at full strength the current simply took the duck away.
      const bite = (this.submerged ? 1 - clamp((depth - 0.4) / 3.0, 0, 0.5) : 0.62)
        * CURRENT_AUTHORITY;
      this._flow.multiplyScalar(bite);
    } else {
      this._flow.set(0, 0, 0);
    }

    if (this.airborne) {
      this._updateAir(dt, a, dirX, dirZ, dirLen, waterY, bedY, overWater);
    } else if (this.grounded && !this.submerged) {
      this._updateLand(dt, a, dirX, dirZ, dirLen, inputMag, bedY);
    } else if (this.submerged) {
      this._updateUnderwater(dt, a, dirX, dirZ, dirLen, inputMag, sprinting,
        diveHeld, divePressed, waterY, bedY, depth);
    } else {
      this._updateSurface(dt, a, dirX, dirZ, dirLen, inputMag, sprinting,
        divePressed, waterY, localDepth, depth);
    }

    /* ── flap / hop ───────────────────────────────────────────────────── */
    this._flapCool = Math.max(0, this._flapCool - dt);
    if (flapPressed && this._flapCool <= 0) this._doFlap();

    /* ── soft world bounds ────────────────────────────────────────────── */
    if (river) {
      const margin = 16;
      if (rc.s < margin) {
        river.tangent(rc.s, this._v1);
        a.addScaledVector(this._v1, (margin - rc.s) * 0.55);
      } else if (rc.s > river.length - margin) {
        river.tangent(rc.s, this._v1);
        a.addScaledVector(this._v1, -(rc.s - (river.length - margin)) * 0.55);
      }
      const uMax = 3.4;
      if (Math.abs(rc.u) > uMax) {
        river.right(rc.s, this._v1);
        a.addScaledVector(this._v1, -Math.sign(rc.u) * (Math.abs(rc.u) - uMax) * 6.0);
      }
    }

    /* ── integrate ────────────────────────────────────────────────────── */
    vel.addScaledVector(a, dt);
    // Terminal safety so a bad frame can never launch the duck out of the world.
    const vmax = 22;
    if (vel.lengthSq() > vmax * vmax) vel.setLength(vmax);
    pos.addScaledVector(vel, dt);

    /* ── collisions ───────────────────────────────────────────────────── */
    const floorY = bedY + (overWater ? 0.10 : LAND_LIFT);
    if (pos.y < floorY) {
      pos.y = floorY;
      if (vel.y < 0) vel.y *= -0.12;
      // Scrub along the bed.
      vel.x *= 0.88; vel.z *= 0.88;
      if (this.airborne && !overWater) this.airborne = false;
    }
    if (!overWater && pos.y <= bedY + LAND_LIFT + 0.01 && !wasGrounded && !this.airborne) {
      this.grounded = true;
    }

    this.speed = Math.hypot(vel.x, vel.z);
    this.depthBelow = Math.max(0, waterY - pos.y);

    /* ── orientation ──────────────────────────────────────────────────── */
    this._updateOrientation(dt, waterY, overWater);

    /* ── state name ───────────────────────────────────────────────────── */
    this.state = this._deriveState();

    /* ── wetness ──────────────────────────────────────────────────────── */
    if (this.submerged) this.wetness = 1;
    else if (this.depthBelow > 0.02 && overWater) {
      this.wetness = Math.max(this.wetness, 0.55);
      this.wetness = Math.min(1, this.wetness + dt * 0.05);
    } else {
      this.wetness = Math.max(0, this.wetness - dt / 20);
    }

    /* ── surface effects ──────────────────────────────────────────────── */
    this._emitWake(dt, waterY, overWater);
    this._emitBubbles(dt);
    if (quackPressed) this._quack();
    if (interactPressed) this._interact(localDepth, overWater);
    // Timed grooming poses run themselves down.
    if (this._preenT > 0) this._preenT = Math.max(0, this._preenT - dt);
    if (this._dabbleT > 0) this._dabbleT = Math.max(0, this._dabbleT - dt);

    /* ── drive the model ──────────────────────────────────────────────── */
    this._applyTransform();
    this._animateDuck(dt);
    this._justTeleported = Math.max(0, this._justTeleported - dt);
    this._prevWaterY = waterY;
  }

  /* ─────────────────────────────── modes ─────────────────────────────────── */

  _updateSurface(dt, a, dirX, dirZ, dirLen, inputMag, sprinting, divePressed,
    waterY, localDepth, depth) {
    const settingsRef = this.ctx.settings ?? settings;
    const vel = this.velocity;
    const pos = this.position;

    /* steering: real angular momentum, the duck arcs */
    if (dirLen > 0.02) {
      const targetYaw = Math.atan2(dirX, dirZ);
      this._steer(dt, targetYaw, 2.9 - clamp(this.speed / 7, 0, 1.3));
    } else {
      this._yawVel *= Math.exp(-3.2 * dt);
      this.yaw += this._yawVel * dt;
    }

    /* thrust */
    this.forward(this._fwd);
    const align = dirLen > 0.02
      ? clamp((this._fwd.x * dirX + this._fwd.z * dirZ) / dirLen, -1, 1) : 0;
    const throttle = inputMag * Math.max(0.18, align);
    const target = sprinting ? (settingsRef.sprintSpeed ?? 7.8) : (settingsRef.swimSpeed ?? 4.6);
    const drag = (settingsRef.waterDrag ?? 3.4) * 0.78;
    a.x += this._fwd.x * target * drag * throttle;
    a.z += this._fwd.z * target * drag * throttle;

    /* drag relative to the moving water — the current is a real force */
    a.x -= (vel.x - this._flow.x) * drag;
    a.z -= (vel.z - this._flow.z) * drag;

    /* buoyancy */
    if (this._forcedDepth > 0) {
      this._holdDepth(a, waterY);
    } else {
      const dive = divePressed || (this.ctx.input?.isDown?.('dive') ?? false);
      if (dive && localDepth > 0.85) {
        // Kick under: a real push, not a teleport.
        a.y -= 26;
        if (divePressed) {
          vel.y -= 2.6;
          a.x += this._fwd.x * 6; a.z += this._fwd.z * 6;
        }
        this._buoyScale = lerp(this._buoyScale, 0.42, 1 - Math.exp(-6 * dt));
      } else {
        this._buoyScale = lerp(this._buoyScale, 1, 1 - Math.exp(-4 * dt));
      }
      this._buoyantY(a, waterY, localDepth, dt);
    }
  }

  _updateUnderwater(dt, a, dirX, dirZ, dirLen, inputMag, sprinting, diveHeld,
    divePressed, waterY, bedY, depth) {
    const settingsRef = this.ctx.settings ?? settings;
    const vel = this.velocity;

    /* 3D heading: yaw from the stick, pitch from the camera */
    if (dirLen > 0.02) {
      const targetYaw = Math.atan2(dirX, dirZ);
      this._steer(dt, targetYaw, 2.2);
    } else {
      this._yawVel *= Math.exp(-2.4 * dt);
      this.yaw += this._yawVel * dt;
    }

    const camPitch = Math.asin(clamp(this._camDir.y, -1, 1));
    let pitchTarget = 0;
    if (inputMag > 0.05) pitchTarget = clamp(camPitch, -1.15, 1.05);
    if (diveHeld) pitchTarget = Math.min(pitchTarget - 0.55, -0.35);
    if (this._gasping || this.breath <= 0) pitchTarget = Math.max(pitchTarget, 0.55);
    if (this._forcedDepth > 0) pitchTarget = clamp(pitchTarget, -0.25, 0.15);
    this._pitchTarget = pitchTarget;
    const st = damp1(this.pitch, pitchTarget, this._pitchVel || 0, 4.6, dt);
    this.pitch = st.p; this._pitchVel = st.v;

    /* thrust along the 3D forward */
    this.forward(this._fwd);
    const target = (sprinting ? (settingsRef.sprintSpeed ?? 7.8) * 0.72
      : (settingsRef.diveSpeed ?? 4.2));
    const drag = (settingsRef.waterDrag ?? 3.4) * 1.25;
    const align = dirLen > 0.02
      ? clamp((this._fwd.x * dirX + this._fwd.z * dirZ) / dirLen, -1, 1) : 0;
    let throttle = inputMag * Math.max(0.2, align);
    if (diveHeld) throttle = Math.max(throttle, 0.75);
    a.addScaledVector(this._fwd, target * drag * throttle);

    /* drag against the (slower) deep current */
    a.x -= (vel.x - this._flow.x) * drag;
    a.z -= (vel.z - this._flow.z) * drag;
    a.y -= vel.y * drag * 0.85;

    /* buoyancy: gentle lift, cancelled while actively swimming down */
    if (this._forcedDepth > 0) {
      this._holdDepth(a, waterY);
    } else {
      const out = this.breath <= 0.001;
      if (out) {
        // Lungs empty: the duck stops obeying and bolts for the light.
        this._forcedDepth = -1;
        a.y += 4.5;
        a.addScaledVector(this._fwd, 2.0);
      }
      const holdingDown = diveHeld && !out;
      this._buoyScale = lerp(this._buoyScale, holdingDown ? 0.30 : 1, 1 - Math.exp(-6 * dt));
      let lift = 4.6;
      if (holdingDown) lift = -3.4;
      // Near the surface hand back to the floating spring so breaching is smooth.
      const blend = 1 - smoothstep(depth, 0.10, 0.55);
      if (blend > 0.001) {
        const before = a.y;
        this._buoyantY(a, waterY, Math.max(0.4, waterY - bedY), dt);
        a.y = lerp(before + lift, a.y, blend);
      } else {
        a.y += lift;
      }
    }

    /* never scrape through the bed */
    const floor = bedY + 0.14;
    if (this.position.y < floor + 0.3) {
      a.y += (floor + 0.3 - this.position.y) * 22;
    }
  }

  /** Short hop / burst flap. Not flight — a beat or two and back down. */
  _updateAir(dt, a, dirX, dirZ, dirLen, waterY, bedY, overWater) {
    const ctx = this.ctx;
    const vel = this.velocity;
    const gliding = ctx.input?.isDown?.('flap') ?? false;
    a.y -= (ctx.settings?.gravity ?? 14) * (gliding ? 0.52 : 1);
    if (dirLen > 0.02) this._steer(dt, Math.atan2(dirX, dirZ), 1.9);
    this.forward(this._fwd);
    a.addScaledVector(this._fwd, gliding ? 4.2 : 1.1);
    const drag = ctx.settings?.airDrag ?? 0.25;
    a.addScaledVector(vel, -drag);

    const floor = overWater ? waterY : bedY + LAND_LIFT;
    if (this.position.y <= floor + 0.02 && vel.y < 0) {
      if (overWater) this._land(waterY);
      else { this.airborne = false; this.velocity.y *= 0.1; }
    }
  }

  _updateLand(dt, a, dirX, dirZ, dirLen, inputMag, bedY) {
    const g = this.ctx.settings?.gravity ?? 14;
    const vel = this.velocity;

    if (dirLen > 0.02) {
      const targetYaw = Math.atan2(dirX, dirZ);
      this._steer(dt, targetYaw, 3.4);
    } else {
      this._yawVel *= Math.exp(-6 * dt);
      this.yaw += this._yawVel * dt;
    }

    this.forward(this._fwd);
    const align = dirLen > 0.02
      ? clamp((this._fwd.x * dirX + this._fwd.z * dirZ) / dirLen, -1, 1) : 0;
    const throttle = inputMag * Math.max(0, align);
    const walk = 2.15;
    const drag = 7.0;
    a.x += this._fwd.x * walk * drag * throttle;
    a.z += this._fwd.z * walk * drag * throttle;
    a.x -= vel.x * drag;
    a.z -= vel.z * drag;

    // Ground support: a stiff spring rather than a hard snap, so slopes read.
    const rest = bedY + LAND_LIFT;
    if (this.position.y < rest) {
      a.y += (rest - this.position.y) * 220 - vel.y * 16;
    } else {
      a.y -= g;
    }

    // Comic waddle: side to side sway locked to the step cycle.
    this._stepPhase += dt * (2.6 + this.speed * 2.2);
    this.pitch = lerp(this.pitch, 0.14 + Math.sin(this._stepPhase * 2) * 0.03, 1 - Math.exp(-8 * dt));
  }

  /* ─────────────────────────────── helpers ───────────────────────────────── */

  _steer(dt, targetYaw, maxRate, deadband = 0.13) {
    let d = wrapAngle(targetYaw - this.yaw);
    // The steering target comes from the camera azimuth and the camera follows
    // the duck, so a residual error of a couple of degrees feeds itself and the
    // pair winds into a slow spin with forward held.
    if (Math.abs(d) < deadband) {
      this._yawVel *= Math.exp(-6 * dt);
      this.yaw = wrapAngle(this.yaw + this._yawVel * dt);
      return;
    }
    d -= Math.sign(d) * deadband;
    const stiff = 26, damp = 7.2;
    this._yawVel += (d * stiff - this._yawVel * damp) * dt;
    this._yawVel = clamp(this._yawVel, -maxRate, maxRate);
    this.yaw = wrapAngle(this.yaw + this._yawVel * dt);
  }

  _buoyantY(a, waterY, localDepth, dt) {
    const s = this.ctx.settings ?? settings;
    const buoy = s.buoyancy ?? 26;
    const g = s.gravity ?? 14;
    // Shallow water cannot hold the duck up.
    const support = clamp(localDepth / 0.30, 0, 1);
    const disp = (waterY - this.position.y) / DRAFT + EQ;
    const f = clamp(disp, 0, 1.15) * support * this._buoyScale;
    a.y += buoy * f - g;
    a.y -= this.velocity.y * VERT_DRAG * Math.min(1, f + 0.15);
  }

  _holdDepth(a, waterY) {
    const target = waterY - this._forcedDepth;
    a.y += (target - this.position.y) * 26 - this.velocity.y * 9.5;
    // Bleed off the horizontal drift so capture frames are steady.
    a.x -= this.velocity.x * 2.2;
    a.z -= this.velocity.z * 2.2;
    this.breath = Math.max(this.breath, 0.62);
  }

  _updateOrientation(dt, waterY, overWater) {
    const water = this.ctx.water;
    const surfaceWeight = overWater
      ? (1 - clamp((this.depthBelow - 0.15) / 0.6, 0, 1)) * (this.grounded ? 0 : 1)
      : 0;

    // Wave-following pitch and roll, damped so the duck rocks rather than snaps.
    let wpT = 0, wrT = 0;
    if (water?.normalAt && surfaceWeight > 0.001) {
      const n = water.normalAt(this.position.x, this.position.z, this._normal);
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      const fx = sy, fz = cy;      // forward
      const rx = cy, rz = -sy;     // right
      wpT = -Math.asin(clamp(n.x * fx + n.z * fz, -0.7, 0.7)) * surfaceWeight;
      wrT = -Math.asin(clamp(n.x * rx + n.z * rz, -0.7, 0.7)) * surfaceWeight;
    }
    let st = damp1(this._wavePitch, wpT, this._wavePitchV, 5.0, dt);
    this._wavePitch = st.p; this._wavePitchV = st.v;
    st = damp1(this._waveRoll, wrT, this._waveRollV, 4.4, dt);
    this._waveRoll = st.p; this._waveRollV = st.v;

    // Bank into turns.
    const bankT = clamp(-this._yawVel * (this.submerged ? 0.30 : 0.17), -0.55, 0.55)
      * clamp(this.speed / 2.2, 0.25, 1);
    st = damp1(this._bankRoll, bankT, this._bankRollV, 6.0, dt);
    this._bankRoll = st.p; this._bankRollV = st.v;

    // Waddle sway on land.
    const waddle = this.grounded && !this.submerged
      ? Math.sin(this._stepPhase) * 0.16 * clamp(this.speed / 1.4, 0.25, 1) : 0;

    this.roll = this._bankRoll + this._waveRoll + waddle;

    if (!this.submerged && !this.airborne) {
      // On the surface the pitch is the wave plus a little nose-up at speed.
      const swim = clamp(this.speed / 6, 0, 1) * 0.10;
      const targetP = this.grounded ? this.pitch : this._wavePitch + swim;
      this.pitch = lerp(this.pitch, targetP, 1 - Math.exp(-9 * dt));
    } else if (this.airborne) {
      this.pitch = lerp(this.pitch, clamp(this.velocity.y * 0.09, -0.5, 0.5), 1 - Math.exp(-6 * dt));
    }
  }

  _deriveState() {
    if (this.airborne) return 'fly';
    if (this.grounded && !this.submerged) return 'land';
    if (this.depthBelow > 0.75) return 'underwater';
    if (this.submerged) return 'dive';
    if (this.speed > 0.55) return 'swim';
    return 'float';
  }

  /**
   * The E key. It was mapped to 'interact' and read by nobody, so the key and
   * every on-screen prompt for it did nothing.
   *
   * Context decides the verb, which is how a one-button interact should behave:
   * up-end and dabble where the water is shallow enough to reach the bottom,
   * preen anywhere else on the surface. Underwater it does nothing — the duck
   * has its bill full.
   */
  _interact(localDepth, overWater) {
    if (this.submerged) return;
    const ctx = this.ctx;
    if (overWater && localDepth > 0.35 && localDepth < 1.15) {
      this._dabbleT = 2.6;
      ctx.events?.emit(ctx.EVENTS.TOAST, { text: 'Dabbling for weed', icon: '\u{1F343}', duration: 1.4 });
      ctx.events?.emit(ctx.EVENTS.SFX, { name: 'dabble', position: this.position.clone(), volume: 0.6 });
      ctx.water?.addRipple?.(this.position.x, this.position.z, 0.5, 0.9);
    } else {
      this._preenT = 3.0;
      this.wetness = Math.max(0, this.wetness - 0.45);
      ctx.events?.emit(ctx.EVENTS.TOAST, { text: 'Preening', icon: '\u{1FAB6}', duration: 1.4 });
      ctx.events?.emit(ctx.EVENTS.SFX, { name: 'preen', position: this.position.clone(), volume: 0.5 });
    }
  }

  _cameraBasis() {
    const cam = this.ctx.engine?.camera;
    if (!cam) return;
    const e = cam.matrixWorld.elements;
    // -Z column is the view direction.
    this._camDir.set(-e[8], -e[9], -e[10]).normalize();
    this._camFwd.set(-e[8], 0, -e[10]);
    if (this._camFwd.lengthSq() < 1e-6) this._camFwd.set(0, 0, 1);
    this._camFwd.normalize();
    // Right of forward is fwd x up = (-fwd.z, 0, fwd.x). The original was the
    // negation of that, i.e. LEFT, so A and D were swapped and every lateral
    // correction pushed the duck the wrong way.
    this._camRight.set(-this._camFwd.z, 0, this._camFwd.x);
  }

  _enterSubmerged(sub) {
    const ctx = this.ctx;
    this.submerged = sub;
    this._eventPos.copy(this.position);
    this._eventPos.y = this.waterHeight;
    if (sub) {
      ctx.events?.emit(ctx.EVENTS.DIVE, { position: this._eventPos.clone() });
      this._splash(Math.min(1.1, 0.35 + this.speed * 0.12), 1.7);
      ctx.events?.emit(ctx.EVENTS.SFX, { name: 'dive', position: this._eventPos.clone(), volume: 0.8 });
    } else {
      ctx.events?.emit(ctx.EVENTS.SURFACE, { position: this._eventPos.clone() });
      this._splash(Math.min(1.2, 0.3 + Math.abs(this.velocity.y) * 0.18), 2.1);
      ctx.events?.emit(ctx.EVENTS.SFX, { name: 'surface', position: this._eventPos.clone(), volume: 0.7 });
      ctx.events?.emit(ctx.EVENTS.BUBBLES, {
        position: this._eventPos.clone(), count: 14, spread: 0.35,
      });
    }
  }

  _splash(strength, radius) {
    const ctx = this.ctx;
    const p = this._eventPos;
    ctx.events?.emit(ctx.EVENTS.SPLASH, { position: p.clone(), strength });
    ctx.water?.addRipple?.(p.x, p.z, clamp(strength * 0.16, 0.02, 0.3), radius);
  }

  _land(waterY) {
    this.airborne = false;
    this._eventPos.copy(this.position);
    this._eventPos.y = waterY;
    this._splash(clamp(Math.abs(this.velocity.y) * 0.22, 0.3, 1.3), 3.0);
    this.ctx.events?.emit(this.ctx.EVENTS.SHAKE, { strength: 0.35, duration: 0.35 });
    this.velocity.y *= 0.25;
  }

  _doFlap() {
    const ctx = this.ctx;
    this._flapCool = 0.55;
    this.duck?.flap?.(3);
    if (this.submerged) {
      // Underwater a wingbeat is an upward kick.
      this.velocity.y += 3.4;
      this._forcedDepth = -1;
      ctx.events?.emit(ctx.EVENTS.BUBBLES, {
        position: this.billPosition(this._bill).clone(), count: 10, spread: 0.3,
      });
    } else {
      this.airborne = true;
      this.grounded = false;
      this.velocity.y = Math.max(this.velocity.y, 0) + 4.9;
      this.forward(this._v1);
      this.velocity.addScaledVector(this._v1, 2.4);
      this._eventPos.copy(this.position);
      this._eventPos.y = this.waterHeight;
      this._splash(0.85, 2.6);
      ctx.events?.emit(ctx.EVENTS.SFX, { name: 'wingbeat', position: this.position.clone(), volume: 0.6 });
    }
  }

  _quack() {
    const ctx = this.ctx;
    this.duck?.quack?.();
    this.headPosition(this._head);
    ctx.events?.emit(ctx.EVENTS.QUACK, { position: this._head.clone(), pitch: 1 });
    ctx.events?.emit(ctx.EVENTS.SFX, { name: 'quack', position: this._head.clone(), volume: 0.9 });
  }

  _emitWake(dt, waterY, overWater) {
    const water = this.ctx.water;
    if (!water || this.submerged || !overWater) return;
    // Paddle strokes: rings shed behind the feet, cadence rising with speed.
    this._paddlePhase += dt * (1.1 + this.speed * 0.55);
    this._wakeAcc += dt;
    const period = 1 / (1.4 + this.speed * 0.8);
    if (this._wakeAcc < period) return;
    this._wakeAcc = 0;
    const s = clamp(0.012 + this.speed * 0.014, 0.012, 0.12);
    this.forward(this._v1);
    const bx = this.position.x - this._v1.x * 0.16;
    const bz = this.position.z - this._v1.z * 0.16;
    if (water.addWake) water.addWake(bx, bz, this._v1.x, this._v1.z, s, 1.6 + this.speed * 0.5);
    else water.addRipple?.(bx, bz, s, 1.6 + this.speed * 0.5);
  }

  _emitBubbles(dt) {
    if (!this.submerged) return;
    this._bubbleAcc += dt;
    const rate = 0.22 + (1 - this.breath) * -0.12;
    if (this._bubbleAcc < Math.max(0.10, rate)) return;
    this._bubbleAcc = 0;
    this.billPosition(this._bill);
    this.ctx.events?.emit(this.ctx.EVENTS.BUBBLES, {
      position: this._bill.clone(),
      count: 2 + Math.round(this.speed * 0.6),
      spread: 0.10,
    });
  }

  _applyTransform() {
    this._euler.set(-this.pitch, this.yaw, this.roll, 'YXZ');
    this.object.quaternion.setFromEuler(this._euler);
  }

  _animateDuck(dt) {
    const duck = this.duck;
    if (!duck?.update) return;
    const p = this._duckParams;
    p.speed = this.speed;
    p.paddle = this.grounded
      ? clamp(this.speed / 1.6, 0, 1)
      : clamp(this.speed / 2.4, 0, 1) * (this.submerged ? 1 : 0.9)
        + (this.submerged ? 0.35 : 0);
    p.turn = clamp(this._yawVel / 2.4, -1, 1);
    // Strictly 0 or 1: duck.js reads `p.submerged ? 1 : …`, so *any* non-zero
    // fraction counts as a full dive, and the 0↔1 flicker as waves wash over a
    // floating duck fires its surfacing shake-and-flap several times a second.
    p.submerged = this.submerged ? 1 : 0;
    p.wetness = this.wetness;
    p.flap = false;
    // Ease in and out so the pose blends rather than snapping on.
    p.preen = this._preenT > 0 ? clamp(Math.min(this._preenT, 0.45) / 0.45, 0, 1) : 0;
    p.dabble = this._dabbleT > 0 ? clamp(Math.min(this._dabbleT, 0.4) / 0.4, 0, 1) : 0;
    p.alert = this.grounded ? 0.45 : 0;
    // Standing on the bank is a different silhouette: upright, neck out.
    const pose = this.grounded && !this.submerged ? 'stand'
      : (this.depthBelow > 0.75 ? 'underwater' : 'auto');
    if (pose !== this._pose) { this._pose = pose; duck.setPose?.(pose); }
    if (this.speed > 0.7 || this.submerged) {
      p.look = this.forward(this._look);
    } else {
      p.look = null;
    }
    try {
      duck.update(dt, p);
    } catch (err) {
      if (!this._duckErrored) {
        this._duckErrored = true;
        console.warn('[player] duck.update threw, animation disabled', err);
      }
    }
  }

  _sampleWater(x, z) {
    const w = this.ctx.water;
    if (w?.heightAt) {
      const y = w.heightAt(x, z);
      if (Number.isFinite(y)) return y;
    }
    return this.ctx.WATER_LEVEL ?? WATER_LEVEL;
  }

  dispose() {
    for (const off of this._offs ?? []) off?.();
    this.duck?.dispose?.();
    this.object.removeFromParent();
  }
}
