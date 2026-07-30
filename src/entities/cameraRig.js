/**
 * cameraRig.js — the third person camera.
 *
 * This is the only system allowed to write ctx.camera.position / .quaternion.
 * (Note: main.js overwrites `ctx.camera` with *this rig* once it boots, so the
 * real PerspectiveCamera is always taken from `ctx.engine.camera`. The rig
 * proxies `.position` / `.quaternion` / `.fov` so anything that still reaches
 * for `ctx.camera.position` gets sensible numbers.)
 *
 * Design
 *   * everything is critically damped — position, aim, distance, FOV — so the
 *     camera never snaps and never oscillates.
 *   * the duck is framed slightly below centre with the river leading away
 *     into the top two thirds of the frame.
 *   * at speed the rig drifts back, leads the duck's motion and widens the FOV
 *     a couple of degrees; at rest it dollies in and breathes.
 *   * two rigs — above water and below — cross-faded by the duck's depth, with
 *     a hard rule that the eye is never within a few centimetres of the water
 *     plane, so the surface always reads as a surface when you punch through it.
 */

import * as THREE from 'three';
import { WATER_LEVEL } from '../core/settings.js';
import { noise } from '../core/noise.js';

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const smoothstep = THREE.MathUtils.smoothstep;

/* Critically damped smoothing, allocation free. */
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

function dampV3(cur, tgt, vel, omega, dt) {
  let r = damp1(cur.x, tgt.x, vel.x, omega, dt); cur.x = r.p; vel.x = r.v;
  r = damp1(cur.y, tgt.y, vel.y, omega, dt); cur.y = r.p; vel.y = r.v;
  r = damp1(cur.z, tgt.z, vel.z, omega, dt); cur.z = r.p; vel.z = r.v;
}

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/* Tuning ------------------------------------------------------------------ */
const DIST_MIN = 1.9;
const DIST_MAX = 15.0;
const DIST_DEFAULT = 3.25;
const PITCH_DEFAULT = -0.200;
/** Over-the-shoulder lateral offset, metres — classic third person framing. */
const SHOULDER = 0.28;
/**
 * How far above the pivot the rig aims, as a fraction of the boom length.
 * This is what drops the duck below frame centre and lets the river lead away
 * into the top two thirds. Tuned against the hero shot.
 */
const AIM_UP = 0.090;
const PITCH_MIN = -1.15;
const PITCH_MAX = 0.62;
const LOOK_SENS = 0.0032;
/** Never let the eye sit inside this band around the water plane. */
const SURFACE_GAP = 0.085;

export class CameraRig {
  constructor(ctx) {
    this.ctx = ctx;
    this.isCameraRig = true;

    this.camera = ctx.engine?.camera || ctx.camera;
    this.target = null;          // Object3D the rig is following
    this.underwater = false;
    this.focusDistance = DIST_DEFAULT;

    /* orbit state */
    this.yaw = 0;
    this.pitch = PITCH_DEFAULT;
    this.zoom = DIST_DEFAULT;    // user distance, before speed/underwater terms
    this._dist = DIST_DEFAULT;
    this._distV = 0;
    this._pitchV = 0;

    /* damped rig state */
    this._pos = new THREE.Vector3(0, 3, -8);
    this._posV = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._aimV = new THREE.Vector3();
    this._fov = ctx.settings?.fov ?? 55;
    this._fovV = 0;

    /* shake */
    this._shake = 0;
    this._shakeDecay = 3.0;
    this._shakeSeed = 11.3;

    /* idle */
    this._idle = 0;
    this._t = 0;
    this._subBlend = 0;

    /* scratch */
    this._v0 = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._pivot = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._aimTarget = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._lastTarget = new THREE.Vector3();
    this._probe = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._qShake = new THREE.Quaternion();
    this._eShake = new THREE.Euler();
    this._coord = { s: 0, u: 0, distance: 0 };
    this._offs = [];
    this._first = true;
  }

  async init() {
    const ctx = this.ctx;
    this.camera = ctx.engine?.camera || ctx.camera;
    this._fov = ctx.settings?.fov ?? 55;
    this.camera.fov = this._fov;
    this.camera.updateProjectionMatrix();
    this.camera.isUnderwater = false;

    this._offs.push(ctx.events?.on?.(ctx.EVENTS.SHAKE, (p) => {
      const s = clamp(p?.strength ?? 0.3, 0, 2);
      this._shake = Math.max(this._shake, s);
      this._shakeDecay = 1 / Math.max(0.12, p?.duration ?? 0.4);
    }));
    // A dive or a belly flop shakes the frame a little all by itself.
    this._offs.push(ctx.events?.on?.(ctx.EVENTS.SPLASH, (p) => {
      const s = clamp((p?.strength ?? 0.3) * 0.28, 0, 0.45);
      if (s > this._shake) { this._shake = s; this._shakeDecay = 3.4; }
    }));

    const t = this._resolveTarget();
    if (t) {
      t.getWorldPosition(this._lastTarget);
      this._snapTo(this._lastTarget);
    }
  }

  /* ────────────────────────── public API ─────────────────────────────────── */

  /** Borrow the camera: minigames and cutscenes point it at their own object. */
  setTarget(object3D) {
    this.target = object3D || null;
    this._first = true;
    return this;
  }

  /** Frame the rig instantly on its target (used after a teleport / forceDive). */
  snap() { this._first = true; this._snapSub = true; }

  get position() { return this.camera.position; }
  get quaternion() { return this.camera.quaternion; }
  get matrixWorld() { return this.camera.matrixWorld; }
  get isUnderwater() { return this.underwater; }
  get fov() { return this.camera.fov; }
  get near() { return this.camera.near; }
  get far() { return this.camera.far; }

  /* ──────────────────────────── update ───────────────────────────────────── */

  update(dt, elapsed) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 1 / 20);
    this._t += dt;
    const ctx = this.ctx;
    const cam = this.camera;
    if (!cam) return;
    if (ctx.settings?.freeCam) return;

    const player = ctx.player;
    const targetObj = this._resolveTarget();
    const cinematic = !!(typeof window !== 'undefined' && window.__duck?.cinematic);

    /* ── where are we looking at ──────────────────────────────────────── */
    if (targetObj) targetObj.getWorldPosition(this._v0);
    else if (ctx.river) ctx.river.toWorld(120, 0, 0, this._v0);
    else this._v0.set(0, 0, 0);

    const jumped = this._v0.distanceTo(this._lastTarget) > 6.0;
    this._lastTarget.copy(this._v0);

    /* ── look input ───────────────────────────────────────────────────── */
    const input = ctx.input;
    let lookX = 0, lookY = 0, wheel = 0;
    if (input) {
      lookX = input.look?.x ?? 0;
      lookY = input.look?.y ?? 0;
      wheel = input.zoom ?? 0;
    }
    const looking = Math.abs(lookX) + Math.abs(lookY) > 0.4;
    if (looking) {
      this.yaw = wrapAngle(this.yaw - lookX * LOOK_SENS);
      this.pitch = clamp(this.pitch - lookY * LOOK_SENS, PITCH_MIN, PITCH_MAX);
      this._idle = 0;
    }
    if (wheel) this.zoom = clamp(this.zoom + wheel * 0.55, DIST_MIN, DIST_MAX);

    const speed = player?.speed ?? 0;
    const moving = speed > 0.5 || (input?.move && (Math.abs(input.move.x) + Math.abs(input.move.y)) > 0.05);
    this._idle = moving || looking ? 0 : this._idle + dt;

    /* ── underwater blend ─────────────────────────────────────────────── */
    const depth = player?.depthBelow ?? 0;
    const wantUnder = depth > 0.22;
    const subTarget = wantUnder ? 1 : 0;
    if (this._snapSub) { this._subBlend = subTarget; this._snapSub = false; }
    else this._subBlend += (subTarget - this._subBlend) * (1 - Math.exp(-6.5 * dt));
    const sub = this._subBlend;

    /* ── auto-align behind the duck ───────────────────────────────────── */
    if (cinematic) {
      this.yaw = wrapAngle(this.yaw + dt * 0.115);
      this.pitch = lerp(this.pitch, -0.165, 1 - Math.exp(-1.5 * dt));
    } else if (player && !looking) {
      // Follow the duck's heading. Faster when it is actually going somewhere,
      // but never zero: a parked duck should still end up nicely framed.
      const rate = lerp(1.15, 3.4, clamp(speed / 4.5, 0, 1));
      const d = wrapAngle((player.yaw ?? 0) - this.yaw);
      this.yaw = wrapAngle(this.yaw + d * (1 - Math.exp(-rate * dt)));
      // Pitch drifts back to the house angle, a touch lower when submerged.
      // Underwater the rig sinks a touch below the duck and tips UP, so the duck
      // is read as a silhouette against the bright underside of the surface.
      const restPitch = lerp(PITCH_DEFAULT, 0.135, sub);
      this.pitch = lerp(this.pitch, restPitch, 1 - Math.exp(-0.9 * dt));
    }

    /* ── idle drift so no frame is ever dead still ────────────────────── */
    const idleAmt = smoothstep(this._idle, 0.6, 3.0);
    const driftYaw = noise.noise2(this._t * 0.07, 3.1) * (0.030 + idleAmt * 0.075);
    const driftPitch = noise.noise2(this._t * 0.055, 17.4) * (0.012 + idleAmt * 0.030);
    const yaw = this.yaw + driftYaw;
    const pitch = clamp(this.pitch + driftPitch, PITCH_MIN, PITCH_MAX);

    /* ── distance ─────────────────────────────────────────────────────── */
    let distTarget = cinematic ? 5.2 : this.zoom;
    // Drift back at speed, dolly in when slow.
    distTarget += clamp(speed, 0, 8) * 0.24 - (1 - clamp(speed / 2.2, 0, 1)) * 0.32;
    distTarget = lerp(distTarget, distTarget * 0.40 + 0.55, sub); // closer underwater
    distTarget = clamp(distTarget, DIST_MIN * 0.8, DIST_MAX);
    if (this._first) { this._dist = distTarget; this._distV = 0; }
    let r = damp1(this._dist, distTarget, this._distV, lerp(3.4, 2.0, sub), dt);
    this._dist = r.p; this._distV = r.v;
    const dist = this._dist;

    /* ── pivot: the point the rig orbits ──────────────────────────────── */
    const pivot = this._pivot.copy(this._v0);
    pivot.y += lerp(0.34, 0.12, sub);
    // Over the shoulder: pushes the duck a little left of centre and opens the
    // river up on the other side of the frame.
    const shoulder = SHOULDER * (1 - sub * 0.6) * (cinematic ? 0 : 1);
    pivot.x += Math.cos(yaw) * shoulder;
    pivot.z += -Math.sin(yaw) * shoulder;
    // Lead the motion so the duck sits into the frame rather than dragging it.
    if (player?.velocity) {
      const lead = cinematic ? 0 : lerp(0.14, 0.09, sub);
      pivot.x += clamp(player.velocity.x, -9, 9) * lead;
      pivot.z += clamp(player.velocity.z, -9, 9) * lead;
      pivot.y += clamp(player.velocity.y, -4, 4) * lead * 0.5;
    }

    /* ── desired eye position ─────────────────────────────────────────── */
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    this._dir.set(Math.sin(yaw) * cp, sp, Math.cos(yaw) * cp);
    const desired = this._desired.copy(pivot).addScaledVector(this._dir, -dist);
    // A gentle breathing bob, always present.
    const bob = 0.035 + idleAmt * 0.055;
    desired.y += Math.sin(this._t * 0.62) * bob + noise.noise2(this._t * 0.19, 41.2) * bob * 0.8;
    desired.x += noise.noise2(this._t * 0.16, 8.7) * bob * 1.2;

    /* ── terrain / bank collision ─────────────────────────────────────── */
    this._resolveCollision(pivot, desired, sub, cinematic);

    /* ── damp toward it ───────────────────────────────────────────────── */
    if (this._first || jumped) {
      this._pos.copy(desired);
      this._posV.set(0, 0, 0);
      this._aim.copy(pivot);
      this._aimV.set(0, 0, 0);
      if (player) this.yaw = player.yaw ?? this.yaw;
      this._first = false;
    } else {
      dampV3(this._pos, desired, this._posV, lerp(7.6, 4.0, sub), dt);
    }

    /* ── the water plane is sacred: never sit inside it ───────────────── */
    const surfY = this._waterAt(this._pos.x, this._pos.z);
    if (sub > 0.5) {
      // Underwater: hang below the meniscus, deeper as the duck goes deeper,
      // but always clear of the bed.
      const want = surfY - clamp(0.16 + depth * 0.42, 0.16, 1.5);
      this._pos.y = Math.min(this._pos.y, want);
      const bed = this.ctx.river ? this.ctx.river.groundAt(this._pos, this._coord) : -6;
      this._pos.y = Math.max(this._pos.y, bed + 0.30);
      if (this._pos.y > surfY - SURFACE_GAP) this._pos.y = surfY - SURFACE_GAP;
    } else if (this._pos.y < surfY + SURFACE_GAP) {
      this._pos.y = surfY + SURFACE_GAP;
    }

    /* ── aim: the duck sits below centre, the river leads the frame ───── */
    const aimT = this._aimTarget.copy(pivot);
    aimT.y += lerp(AIM_UP, 0.05, sub) * dist;
    if (cinematic) aimT.y = pivot.y + 0.075 * dist;
    dampV3(this._aim, aimT, this._aimV, lerp(9.5, 5.5, sub), dt);

    /* ── FOV: subtle speed widening ───────────────────────────────────── */
    const baseFov = ctx.settings?.fov ?? 55;
    let fovTarget = baseFov + clamp(speed / 7.8, 0, 1) * 7.0;
    fovTarget = lerp(fovTarget, baseFov + 5.5, sub);
    if (cinematic) fovTarget = baseFov - 5.0;
    r = damp1(this._fov, fovTarget, this._fovV, 2.6, dt);
    this._fov = r.p; this._fovV = r.v;
    if (Math.abs(cam.fov - this._fov) > 0.008) {
      cam.fov = this._fov;
      cam.updateProjectionMatrix();
    }

    /* ── shake ────────────────────────────────────────────────────────── */
    let shx = 0, shy = 0, shz = 0, roll = 0;
    if (this._shake > 0.0005) {
      this._shake = Math.max(0, this._shake - this._shakeDecay * dt * this._shake - 0.02 * dt);
      const s = this._shake;
      const t = this._t * 22;
      shx = noise.noise2(t, this._shakeSeed) * s * 0.16;
      shy = noise.noise2(t, this._shakeSeed + 5) * s * 0.16;
      shz = noise.noise2(t, this._shakeSeed + 9) * s * 0.10;
      roll = noise.noise2(t * 0.7, this._shakeSeed + 13) * s * 0.035;
    }

    /* ── commit ───────────────────────────────────────────────────────── */
    cam.position.set(this._pos.x + shx, this._pos.y + shy, this._pos.z + shz);
    this._m.lookAt(cam.position, this._aim, this._up);
    cam.quaternion.setFromRotationMatrix(this._m);
    // A whisper of roll into hard turns keeps it feeling hand-held, not rigged.
    const bank = clamp(-(player?._yawVel ?? 0) * 0.018, -0.05, 0.05) * clamp(speed / 3, 0, 1);
    if (bank || roll) {
      this._eShake.set(0, 0, bank + roll, 'XYZ');
      cam.quaternion.multiply(this._qShake.setFromEuler(this._eShake));
    }
    cam.updateMatrixWorld(true);

    /* ── publish ──────────────────────────────────────────────────────── */
    const eyeSurf = this._waterAt(cam.position.x, cam.position.z);
    this.underwater = cam.position.y < eyeSurf;
    cam.isUnderwater = this.underwater;
    this.focusDistance = Math.max(0.4, cam.position.distanceTo(this._v0));
    this.eyeDepth = Math.max(0, eyeSurf - cam.position.y);
  }

  /* ────────────────────────── internals ──────────────────────────────────── */

  _resolveTarget() {
    if (this.target) return this.target;
    const p = this.ctx.player;
    return p?.object ?? null;
  }

  _waterAt(x, z) {
    const w = this.ctx.water;
    if (w?.heightAt) {
      const y = w.heightAt(x, z);
      if (Number.isFinite(y)) return y;
    }
    return this.ctx.WATER_LEVEL ?? WATER_LEVEL;
  }

  /**
   * Keep the eye out of the ground.
   *
   * Order matters for how it *feels*: crushing the boom shoves the camera into
   * the duck's tail feathers, which is the ugliest failure mode there is. So
   * the rig climbs first — riding up over the bank and looking down at the
   * duck, which is the shot you actually want — and only shortens the boom
   * when even a three metre climb will not clear the ridge.
   */
  _resolveCollision(pivot, desired, sub, cinematic = false) {
    const river = this.ctx.river;
    if (!river) return;
    const clear = lerp(0.55, 0.35, sub);
    const probe = this._probe;
    const steps = 6;

    // 1. How much must the eye climb so the whole sight line clears the bank?
    let lift = 0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      probe.lerpVectors(pivot, desired, t);
      const pen = river.groundAt(probe, this._coord) + clear - probe.y;
      // Raising the eye by L raises the sample at t by L*t.
      if (pen > 0) lift = Math.max(lift, pen / t);
    }
    const maxLift = cinematic ? 6.0 : lerp(3.0, 1.2, sub);
    if (lift > 0) desired.y += Math.min(lift, maxLift);

    // 2. Still buried? Now, and only now, pull the boom in.
    if (lift > maxLift) {
      let shrink = 1;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        probe.lerpVectors(pivot, desired, t);
        if (probe.y < river.groundAt(probe, this._coord) + clear) {
          shrink = Math.min(shrink, Math.max(0.5, t - 1 / steps));
        }
      }
      if (shrink < 1) desired.lerpVectors(pivot, desired, shrink);
    }

    // 3. Never end up inside the ground itself.
    const g = river.groundAt(desired, this._coord) + clear;
    if (desired.y < g) desired.y = g;
    // 4. And never dip under the surface when we are meant to be above it.
    if (sub < 0.5) {
      const surf = this._waterAt(desired.x, desired.z);
      if (desired.y < surf + SURFACE_GAP) desired.y = surf + SURFACE_GAP;
    }
  }

  _snapTo(targetPos) {
    const player = this.ctx.player;
    this.yaw = player?.yaw ?? 0;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this._dir.set(Math.sin(this.yaw) * cp, sp, Math.cos(this.yaw) * cp);
    this._pos.copy(targetPos).addScaledVector(this._dir, -this._dist);
    this._pos.y += 0.5;
    this._aim.copy(targetPos);
    this._posV.set(0, 0, 0);
    this._aimV.set(0, 0, 0);
    this.camera.position.copy(this._pos);
    this._m.lookAt(this._pos, this._aim, this._up);
    this.camera.quaternion.setFromRotationMatrix(this._m);
    this.camera.updateMatrixWorld(true);
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
  }
}
