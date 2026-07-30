/**
 * The water surface — the hero of the frame.
 *
 * Geometry
 *   A ribbon in RIVER coordinates that follows the camera: a fixed-topology
 *   grid of rows (stations along `s`) by columns (positions across `u`), where
 *   the row spacing grows with distance from the camera. That gives ~0.45 m
 *   tessellation under the duck and ~14 m out at the horizon for one draw call
 *   and ~16k triangles, with no chunk seams and nothing to pop.
 *
 *   Positions come from tables baked at init (centreline point, right vector,
 *   half width every 0.5 m; depth, flow direction and flow speed every 3 m per
 *   column), so a rebuild is pure interpolation and costs a fraction of a
 *   millisecond. The ribbon runs to |u| = 1.055, past the waterline, and sinks
 *   7 cm below the still level over the last few percent of u: the bed feathers
 *   to the still level there, so without the drop the two surfaces z-fight along
 *   the whole shore. With it, the visible waterline is the terrain's own
 *   silhouette — no gap, no stipple, and it follows every rock.
 *
 * Shading (see render/waterMaterial.js)
 *   Gerstner waves whose directions come from `river.flowAt`, so the swell
 *   always travels downstream; three flow-advected procedural normal layers;
 *   screen-space depth for the shallows glow; refraction with chromatic
 *   dispersion and Beer-Lambert absorption; a real planar reflection pass with
 *   an oblique near plane; Schlick fresnel; a sparkling sun glitter track; warm
 *   subsurface glow through back-lit crests; shoreline, streak and contact foam.
 *
 * Public API (CONTRACT.md)
 *   water.mesh water.level water.material
 *   water.heightAt(x, z)          surface Y, matches the shader
 *   water.normalAt(x, z, out?)    surface normal
 *   water.causticsTexture         for terrain / underwater to project
 *   water.addRipple(x, z, strength, radius)
 *   water.addWake(x, z, dirX, dirZ, strength, radius)   (extra)
 *   water.setUnderwater(bool)
 */

import * as THREE from 'three';
import {
  createWaterMaterial, makeWaterTextures, evalWaves, evalRipples,
  waterAmpJS, RIPPLE_SLOTS,
} from '../render/waterMaterial.js';

const U_MAX = 1.055;          // ribbon overlaps into the bank
const SKIRT_DROP = 0.07;      // metres the outer skirt sits below still water
const RIPPLE_LIFE = 2.6;      // seconds a ripple source stays live

function detectSoftware(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    return /swiftshader|softwarerasterizer|llvmpipe|basic render/i.test(name);
  } catch { return false; }
}

function smoothstep01(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

export class Water {
  constructor(ctx) {
    this.ctx = ctx;
    this.river = ctx.river;
    this.level = ctx.WATER_LEVEL ?? 0;
    this.underwater = false;
    this.mesh = null;
    this.material = null;
    this.causticsTexture = null;

    // hoisted scratch — update() and heightAt() never allocate
    this._v0 = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._flowV = new THREE.Vector3();
    this._coord = { s: 0, u: 0, distance: 0 };
    this._wave = { dx: 0, dy: 0, dz: 0, nx: 0, ny: 1, nz: 0 };
    this._wave2 = { dx: 0, dy: 0, dz: 0, nx: 0, ny: 1, nz: 0 };
    this._rip = { h: 0, foam: 0 };
    this._normal = new THREE.Vector3(0, 1, 0);

    // reflection scratch
    this._reflPos = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._reflNormal = new THREE.Vector3(0, 1, 0);
    this._view = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();
    this._rot = new THREE.Matrix4();
    this._reflPlane = new THREE.Plane();
    this._clipPlane = new THREE.Vector4();
    this._q = new THREE.Vector4();

    // ripple ring buffer
    this._ripples = [];
    for (let i = 0; i < RIPPLE_SLOTS; i++) {
      this._ripples.push({
        x: 0, z: 0, age: 0, strength: 0, speed: 1, kind: 0, dirx: 0, dirz: 1,
      });
    }
    this._ripCursor = 0;
    this._wakeTrack = new Map();
    this._wakeKeys = [];
    this._elapsed = 0;

    this._smpDepth = 0;
    this._smpSpeed = 0;
    this._smpFdx = 0;
    this._smpFdz = 1;
    this._smpAmp = 0;
    this._smpRipMask = 1;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // boot
  // ─────────────────────────────────────────────────────────────────────────

  async init() {
    const ctx = this.ctx;
    const q = ctx.settings?.quality ?? {};
    // ctx.camera is replaced by the camera *rig* system once it boots, so the
    // engine is the only reliable handle on the real PerspectiveCamera.
    this.camera = ctx.engine?.camera || ctx.camera;
    this.renderer = ctx.renderer;
    this._software = detectSoftware(this.renderer);
    const aniso = ctx.engine?.maxAnisotropy ?? 4;

    const seg = q.waterSegments ?? 144;
    // Row spacing: dense under the camera, growing linearly outward.
    this._rowNear = seg >= 190 ? 0.45 : seg >= 130 ? 0.7 : 1.0;
    this._rowGrow = seg >= 190 ? 0.052 : seg >= 130 ? 0.07 : 0.1;
    this._sBack = seg >= 130 ? 240 : 170;
    this._sFwd = seg >= 130 ? 620 : 420;

    this.textures = makeWaterTextures({
      size: this._software ? 192 : 256,
      anisotropy: aniso,
      seed: 7717,
    });
    this.causticsTexture = this.textures.caustics;

    this.material = createWaterMaterial({
      level: this.level,
      anisotropy: aniso,
      textures: this.textures,
    });
    this._u = this.material.userData.uniforms;

    this._buildColumns();
    this._buildTables();
    this._buildGeometry();

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'WaterSurface';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;   // first of the transparents, under the reeds
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
    ctx.scene.add(this.mesh);

    this._initTargets();
    this._bindEvents();
    this._rebuild(true);
    this._syncLighting();
  }

  _bindEvents() {
    const { events, EVENTS } = this.ctx;
    if (!events || !EVENTS) return;
    this._offs = [
      events.on(EVENTS.SPLASH, (p) => {
        const pos = p?.position;
        if (!pos) return;
        const s = Math.min(3.0, Math.max(0.2, p.strength ?? 1));
        // a splash is two rings: a fast sharp one and a slower fat one
        this.addRipple(pos.x, pos.z, 0.09 + s * 0.09, 2.4 + s * 1.7);
        this.addRipple(pos.x, pos.z, 0.05 + s * 0.05, 1.0 + s * 0.5);
      }),
      events.on(EVENTS.RIPPLE, (p) => {
        const pos = p?.position;
        if (!pos) return;
        this.addRipple(pos.x, pos.z, (p.strength ?? 0.5) * 0.09, p.radius ?? 1.6);
      }),
      events.on(EVENTS.DIVE, (p) => {
        const pos = p?.position;
        if (pos) this.addRipple(pos.x, pos.z, 0.16, 3.0);
      }),
      events.on(EVENTS.SURFACE, (p) => {
        const pos = p?.position;
        if (pos) this.addRipple(pos.x, pos.z, 0.13, 2.4);
      }),
    ];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // geometry
  // ─────────────────────────────────────────────────────────────────────────

  /** Column table across the channel: denser near the banks for the foam band. */
  _buildColumns() {
    const half = [];
    for (let a = 0; a < 0.775; a += 0.055) half.push(a);
    for (let a = 0.78; a < 0.985; a += 0.022) half.push(a);
    half.push(0.995, 1.0, 1.018, 1.036, U_MAX);
    const cols = [];
    for (let i = half.length - 1; i >= 1; i--) cols.push(-half[i]);
    for (let i = 0; i < half.length; i++) cols.push(half[i]);
    this._cols = Float32Array.from(cols);
    this._nCols = cols.length;
  }

  /** Row offsets from the camera station, in metres, snapped to the table grid. */
  _buildRowOffsets() {
    const step = (o) => Math.min(15, this._rowNear + this._rowGrow * Math.abs(o));
    const fwd = [];
    let o = 0;
    while (o < this._sFwd) { fwd.push(o); o += step(o); }
    const back = [];
    o = 0;
    while (o > -this._sBack) { o -= step(o); back.push(o); }
    const all = back.reverse().concat(fwd);
    // snap to the 0.5 m station table so rows land on exact samples
    this._rows = Float32Array.from(all.map((v) => Math.round(v * 2) / 2));
    this._nRows = this._rows.length;
  }

  /**
   * Bake everything the ribbon needs so a rebuild is table lookups only.
   *   station table : centre + right + halfWidth every 0.5 m
   *   cross table   : depth, flow direction, flow speed every 3 m per column
   * Both extend past the ends of the river with linear extrapolation so the
   * ribbon is never squashed when the player is near either end.
   */
  _buildTables() {
    const river = this.river;
    this._buildRowOffsets();

    this._s0 = -(this._sBack + 60);
    this._s1 = river.length + this._sFwd + 60;

    // ---- station table ---------------------------------------------------
    this._stStep = 0.5;
    const stN = Math.ceil((this._s1 - this._s0) / this._stStep) + 1;
    this._stN = stN;
    this._stCx = new Float32Array(stN);
    this._stCz = new Float32Array(stN);
    this._stRx = new Float32Array(stN);
    this._stRz = new Float32Array(stN);
    this._stHw = new Float32Array(stN);
    const p = this._v0, r = this._v1, t = this._v2;
    for (let i = 0; i < stN; i++) {
      const s = this._s0 + i * this._stStep;
      const sc = Math.min(river.length, Math.max(0, s));
      river.point(sc, p);
      river.right(sc, r);
      if (s !== sc) {
        river.tangent(sc, t);
        const over = s - sc;
        p.x += t.x * over;
        p.z += t.z * over;
      }
      this._stCx[i] = p.x;
      this._stCz[i] = p.z;
      this._stRx[i] = r.x;
      this._stRz[i] = r.z;
      this._stHw[i] = river.halfWidth(sc);
    }

    // ---- cross table -----------------------------------------------------
    this._cxStep = 3.0;
    const cxN = Math.ceil((this._s1 - this._s0) / this._cxStep) + 1;
    this._cxN = cxN;
    const C = this._nCols;
    this._cDepth = new Float32Array(cxN * C);
    this._cFdx = new Float32Array(cxN * C);
    this._cFdz = new Float32Array(cxN * C);
    this._cSpeed = new Float32Array(cxN * C);
    const flow = this._flowV;
    for (let i = 0; i < cxN; i++) {
      const s = this._s0 + i * this._cxStep;
      const sc = Math.min(river.length, Math.max(0, s));
      const base = i * C;
      for (let j = 0; j < C; j++) {
        const uc = Math.min(1, Math.max(-1, this._cols[j]));
        river.flowAt(sc, uc, flow);
        const sp = Math.hypot(flow.x, flow.z);
        this._cDepth[base + j] = river.depth(sc, uc);
        this._cSpeed[base + j] = sp;
        if (sp > 1e-5) {
          this._cFdx[base + j] = flow.x / sp;
          this._cFdz[base + j] = flow.z / sp;
        } else {
          this._cFdx[base + j] = 0;
          this._cFdz[base + j] = 1;
        }
      }
    }
  }

  _buildGeometry() {
    const R = this._nRows, C = this._nCols;
    const n = R * C;
    this.geometry = new THREE.BufferGeometry();
    this._pos = new Float32Array(n * 3);
    this._aSU = new Float32Array(n * 3);
    this._aFlow = new Float32Array(n * 3);
    this._aDepth = new Float32Array(n);
    const idx = new Uint32Array((R - 1) * (C - 1) * 6);
    let k = 0;
    for (let i = 0; i < R - 1; i++) {
      for (let j = 0; j < C - 1; j++) {
        // Wound so the front face points UP: +u runs toward river-right, which
        // is -x when the flow is +z, so the naive order would face the bed and
        // gl_FrontFacing would pick the underwater branch for every fragment.
        const a = i * C + j, b = a + 1, c = a + C, d = c + 1;
        idx[k++] = a; idx[k++] = b; idx[k++] = c;
        idx[k++] = b; idx[k++] = d; idx[k++] = c;
      }
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this._pos, 3));
    this.geometry.setAttribute('aSU', new THREE.BufferAttribute(this._aSU, 3));
    this.geometry.setAttribute('aFlow', new THREE.BufferAttribute(this._aFlow, 3));
    this.geometry.setAttribute('aDepth', new THREE.BufferAttribute(this._aDepth, 1));
    this.geometry.setIndex(new THREE.BufferAttribute(idx, 1));
    // The ribbon is rebuilt around the camera every time it moves, so a static
    // bound is meaningless: never cull it.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.triangles = (R - 1) * (C - 1) * 2;
  }

  /** Re-place the ribbon around the camera's river station. */
  _rebuild(force = false) {
    const cam = this.camera;
    if (!cam) return;
    this._v0.copy(cam.position);
    this.river.toRiver(this._v0, this._coord);
    const camS = Math.round(this._coord.s * 2) / 2;
    if (!force && Math.abs(camS - (this._lastS ?? 1e9)) < 0.49) return;
    this._lastS = camS;

    const R = this._nRows, C = this._nCols;
    const pos = this._pos, aSU = this._aSU, aFlow = this._aFlow, aDepth = this._aDepth;
    const cols = this._cols;
    const stInv = 1 / this._stStep;
    const cxInv = 1 / this._cxStep;
    const stMax = this._stN - 1;
    const cxMax = this._cxN - 1;

    for (let i = 0; i < R; i++) {
      const s = camS + this._rows[i];
      // station table (rows and camS are both multiples of 0.5, so this is exact)
      let si = Math.round((s - this._s0) * stInv);
      if (si < 0) si = 0; else if (si > stMax) si = stMax;
      const cx = this._stCx[si], cz = this._stCz[si];
      const rx = this._stRx[si], rz = this._stRz[si];
      const hw = this._stHw[si];

      // cross table, interpolated along s
      let cf = (s - this._s0) * cxInv;
      if (cf < 0) cf = 0; else if (cf > cxMax) cf = cxMax;
      const ci = Math.min(cxMax, Math.floor(cf));
      const cj = Math.min(cxMax, ci + 1);
      const ct = cf - ci;
      const b0 = ci * C, b1 = cj * C;

      const rowBase = i * C;
      for (let j = 0; j < C; j++) {
        const u = cols[j];
        const o = rowBase + j;
        const off = u * hw;
        const au = Math.abs(u);
        // Sink the outer skirt so it is always safely under the beach: the bed
        // feathers to the still level over the last 6% of u, which would otherwise
        // z-fight the terrain along the whole shoreline.
        let skirt = 0;
        if (au > 0.955) {
          const t = smoothstep01((au - 0.955) / 0.045);
          skirt = -SKIRT_DROP * t;
        }
        pos[o * 3] = cx + rx * off;
        pos[o * 3 + 1] = this.level + skirt;
        pos[o * 3 + 2] = cz + rz * off;
        aSU[o * 3] = s;
        aSU[o * 3 + 1] = u;
        // metres back from the waterline; negative once we are over the beach
        aSU[o * 3 + 2] = (1 - au) * hw;
        const d0 = this._cDepth[b0 + j], d1 = this._cDepth[b1 + j];
        aDepth[o] = d0 + (d1 - d0) * ct;
        const fx0 = this._cFdx[b0 + j], fx1 = this._cFdx[b1 + j];
        const fz0 = this._cFdz[b0 + j], fz1 = this._cFdz[b1 + j];
        const sp0 = this._cSpeed[b0 + j], sp1 = this._cSpeed[b1 + j];
        const fx = fx0 + (fx1 - fx0) * ct;
        const fz = fz0 + (fz1 - fz0) * ct;
        const fl = Math.hypot(fx, fz) || 1;
        aFlow[o * 3] = fx / fl;
        aFlow[o * 3 + 1] = fz / fl;
        aFlow[o * 3 + 2] = sp0 + (sp1 - sp0) * ct;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aSU.needsUpdate = true;
    this.geometry.attributes.aFlow.needsUpdate = true;
    this.geometry.attributes.aDepth.needsUpdate = true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // render targets: scene colour + depth for refraction, planar reflection
  // ─────────────────────────────────────────────────────────────────────────

  _initTargets() {
    const q = this.ctx.settings?.quality ?? {};
    // Software rasterisers (the capture harness) pay per pixel with no
    // parallelism, so the two extra scene passes get cut hard there. On real
    // hardware they run at the quality tier's reflection size.
    this._refrScale = this._software ? 0.3 : 0.55;
    this._reflSize = Math.min(1024, q.reflection ?? 512);
    if (this._software) this._reflSize = Math.min(288, this._reflSize);
    this._reflCam = new THREE.PerspectiveCamera();
    this._reflMatrix = new THREE.Matrix4();

    const w = this.ctx.engine?.width ?? 1600;
    const h = this.ctx.engine?.height ?? 900;
    const dpr = this.ctx.engine?._dpr ?? 1;
    this._makeReflRT(w, h);
    this._makeSceneRT(w, h, dpr);
  }

  /** Reflection target: keeps the viewport aspect so nothing is squashed. */
  _makeReflRT(w, h) {
    const rw = this._reflSize;
    const rh = Math.max(64, Math.round((this._reflSize * h) / Math.max(1, w)));
    if (this._reflRT) {
      if (this._reflRT.width === rw && this._reflRT.height === rh) return;
      this._reflRT.dispose();
    }
    const rt = new THREE.WebGLRenderTarget(rw, rh, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this._reflRT = rt;
    this._u.uReflection.value = rt.texture;
  }

  _makeSceneRT(w, h, dpr) {
    const sw = Math.max(64, Math.round(w * dpr * this._refrScale));
    const sh = Math.max(64, Math.round(h * dpr * this._refrScale));
    if (this._sceneRT) {
      if (this._sceneRT.width === sw && this._sceneRT.height === sh) return;
      this._sceneRT.depthTexture?.dispose();
      this._sceneRT.dispose();
    }
    const rt = new THREE.WebGLRenderTarget(sw, sh, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    const dt = new THREE.DepthTexture(sw, sh);
    dt.type = THREE.UnsignedIntType;
    dt.minFilter = THREE.NearestFilter;
    dt.magFilter = THREE.NearestFilter;
    rt.depthTexture = dt;
    this._sceneRT = rt;
    this._u.uSceneColor.value = rt.texture;
    this._u.uSceneDepth.value = dt;
  }

  resize(w, h, dpr) {
    this._makeSceneRT(w, h, dpr);
    this._makeReflRT(w, h);
  }

  /** Everything behind the water, at reduced resolution, plus its depth. */
  _renderSceneBehind() {
    const r = this.renderer;
    const cam = this.camera;
    if (!cam || !this._sceneRT) return;
    const prevTarget = r.getRenderTarget();
    const prevShadow = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    this.mesh.visible = false;
    r.setRenderTarget(this._sceneRT);
    r.clear(true, true, false);
    try {
      r.render(this.ctx.scene, cam);
    } catch (e) {
      if (!this._warned) { this._warned = true; console.warn('[water] scene pass failed', e); }
    }
    this.mesh.visible = true;
    r.setRenderTarget(prevTarget);
    r.shadowMap.autoUpdate = prevShadow;
  }

  /**
   * Planar reflection with the classic oblique near plane (Lengyel) so nothing
   * below the surface is ever reflected — without that, grazing rays reflect the
   * river bed and the whole distance goes to mud.
   */
  _renderReflection() {
    const r = this.renderer;
    const cam = this.camera;
    if (!cam || !this._reflRT) return;
    const rc = this._reflCam;
    const n = this._reflNormal.set(0, 1, 0);
    const mp = this._reflPos.set(0, this.level, 0);
    this._camPos.setFromMatrixPosition(cam.matrixWorld);

    const view = this._view.subVectors(mp, this._camPos);
    if (view.dot(n) > 0) { this._u.uReflMix.value = 0; return; }
    view.reflect(n).negate().add(mp);

    this._rot.extractRotation(cam.matrixWorld);
    const look = this._lookAt.set(0, 0, -1).applyMatrix4(this._rot).add(this._camPos);
    const target = this._target.subVectors(mp, look).reflect(n).negate().add(mp);

    rc.position.copy(view);
    rc.up.set(0, 1, 0).applyMatrix4(this._rot).reflect(n).negate();
    rc.lookAt(target);
    rc.near = cam.near;
    rc.far = cam.far;
    rc.fov = cam.fov;
    rc.aspect = cam.aspect;
    rc.updateMatrixWorld();
    rc.projectionMatrix.copy(cam.projectionMatrix);

    // The texture matrix uses the unmodified projection; the oblique clip below
    // only rewrites the z row, which xy/w never sees.
    this._reflMatrix.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0
    );
    this._reflMatrix.multiply(rc.projectionMatrix);
    this._reflMatrix.multiply(rc.matrixWorldInverse);
    this._u.uReflMatrix.value.copy(this._reflMatrix);

    this._reflPlane.setFromNormalAndCoplanarPoint(n, mp);
    this._reflPlane.applyMatrix4(rc.matrixWorldInverse);
    const cp = this._clipPlane.set(
      this._reflPlane.normal.x, this._reflPlane.normal.y,
      this._reflPlane.normal.z, this._reflPlane.constant
    );
    const pm = rc.projectionMatrix;
    const q = this._q;
    q.x = (Math.sign(cp.x) + pm.elements[8]) / pm.elements[0];
    q.y = (Math.sign(cp.y) + pm.elements[9]) / pm.elements[5];
    q.z = -1.0;
    q.w = (1.0 + pm.elements[10]) / pm.elements[14];
    cp.multiplyScalar(2.0 / cp.dot(q));
    pm.elements[2] = cp.x;
    pm.elements[6] = cp.y;
    pm.elements[10] = cp.z + 1.0 - 0.004;
    pm.elements[14] = cp.w;

    const prevTarget = r.getRenderTarget();
    const prevShadow = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    this.mesh.visible = false;
    r.setRenderTarget(this._reflRT);
    r.clear(true, true, false);
    try {
      r.render(this.ctx.scene, rc);
      this._u.uReflMix.value = 1.0;
    } catch (e) {
      this._u.uReflMix.value = 0.0;
      if (!this._warned2) { this._warned2 = true; console.warn('[water] reflection pass failed', e); }
    }
    this.mesh.visible = true;
    r.setRenderTarget(prevTarget);
    r.shadowMap.autoUpdate = prevShadow;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // per frame
  // ─────────────────────────────────────────────────────────────────────────

  update(dt, elapsed) {
    this._elapsed = elapsed;
    const u = this._u;
    if (!u || !this.camera) return;

    this._ageRipples(dt);
    this._autoWakes(dt);
    this._rebuild(false);

    u.uTime.value = elapsed;
    u.uCamPos.value.copy(this.camera.position);
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
    this._syncLighting();
    this._writeRippleUniforms();

    // is the camera under the surface?
    const cp = this.camera.position;
    const surf = this.heightAt(cp.x, cp.z);
    const under = cp.y < surf - 0.015;
    if (under !== this.underwater) this.setUnderwater(under);

    this._renderSceneBehind();
    if (!this.underwater) this._renderReflection();
    else u.uReflMix.value = 0.0;

    // Software rasterisers (only the capture harness) rasterise far slower than
    // the animation loop submits, so with three scene passes the GL queue grows
    // without bound and the compositor never gets a finished frame — screenshots
    // then time out for every system, not just this one. One sync per frame
    // pins the loop to the real draw rate. Never runs on a GPU.
    if (this._software) {
      try { this.renderer.getContext().finish(); } catch (e) { /* ignore */ }
    }
  }

  _syncLighting() {
    const u = this._u;
    const sky = this.ctx.sky;
    if (sky?.sunDirection) u.uSunDir.value.copy(sky.sunDirection);
    if (sky?.sunColor) u.uSunColor.value.copy(sky.sunColor);
    if (sky?.sunIntensity !== undefined) {
      u.uSunPower.value = Math.max(0.2, sky.sunIntensity * 0.95);
    }
    if (sky?.horizonColor) u.uSkyHorizon.value.copy(sky.horizonColor);
    if (sky?.zenithColor) u.uSkyZenith.value.copy(sky.zenithColor);
    const fog = this.ctx.scene?.fog;
    if (sky?.fogColor) u.uFogColor.value.copy(sky.fogColor);
    else if (fog?.color) u.uFogColor.value.copy(fog.color);
    if (fog && fog.density !== undefined) u.uFogDensity.value = fog.density;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ripples and wakes
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * A ripple ring. `strength` is a wave amplitude in metres (0.05 is a duck
   * paddling, 0.25 a belly flop); `radius` is roughly how far the ring travels.
   */
  addRipple(x, z, strength = 0.08, radius = 2.0, kind = 0, dirx = 0, dirz = 1) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const str = Math.min(0.45, Math.max(0.004, strength));
    const slot = this._claimSlot(str);
    if (!slot) return null;
    slot.x = x;
    slot.z = z;
    slot.age = 0;
    slot.strength = str;
    slot.speed = Math.max(0.55, (radius / RIPPLE_LIFE) * 1.6);
    slot.kind = kind;
    const dl = Math.hypot(dirx, dirz) || 1;
    slot.dirx = dirx / dl;
    slot.dirz = dirz / dl;
    return slot;
  }

  /** A moving source: rings biased into the Kelvin V behind the swimmer. */
  addWake(x, z, dirx, dirz, strength = 0.05, radius = 2.4) {
    return this.addRipple(x, z, strength, radius, 1, dirx, dirz);
  }

  _claimSlot(strength) {
    const list = this._ripples;
    for (let i = 0; i < list.length; i++) {
      const k = (this._ripCursor + i) % list.length;
      if (list[k].strength <= 0) {
        this._ripCursor = (k + 1) % list.length;
        return list[k];
      }
    }
    // Otherwise recycle the most spent ring, but never steal from a livelier one.
    let worst = null, worstScore = Infinity;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const score = r.strength * Math.exp(-1.5 * r.age);
      if (score < worstScore) { worstScore = score; worst = r; }
    }
    return worst && worstScore < strength ? worst : null;
  }

  _ageRipples(dt) {
    const list = this._ripples;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (r.strength <= 0) continue;
      r.age += dt;
      if (r.age > RIPPLE_LIFE) r.strength = 0;
    }
  }

  /**
   * Pack the live sources into the front of the uniform array and publish the
   * count, so the shader's per-fragment loop exits immediately when the river is
   * calm instead of walking all 24 slots.
   */
  _writeRippleUniforms() {
    const A = this._u.uRipA.value;
    const B = this._u.uRipB.value;
    const list = this._ripples;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (r.strength <= 0) continue;
      A[n].set(r.x, r.z, r.age, r.strength);
      B[n].set(r.speed, r.kind, r.dirx, r.dirz);
      n++;
    }
    this._u.uRipCount.value = n;
  }

  /**
   * Anything that moves on the surface leaves a wake, whether or not its own
   * system remembers to ask. Cheap insurance that the river is never dead.
   */
  _autoWakes(dt) {
    const player = this.ctx.player;
    if (player && !player.submerged) {
      this._emitWake('player', player.object ?? player, 1.0, dt);
    }
    const family = this.ctx.family;
    const flock = family?.ducklings ?? family?.members ?? family?.list;
    if (Array.isArray(flock)) {
      // Keys are pre-built: `d${i}` inside the loop would allocate a string per
      // duckling per frame.
      const keys = this._wakeKeys;
      while (keys.length < flock.length) keys.push(`d${keys.length}`);
      for (let i = 0; i < flock.length; i++) {
        this._emitWake(keys[i], flock[i]?.object ?? flock[i], 0.6, dt);
      }
    }
  }

  _emitWake(key, obj, scale, dt) {
    if (!obj) return;
    const p = obj.position || obj;
    if (!p || !Number.isFinite(p.x)) return;
    const t = this._wakeTrack.get(key);
    if (!t) { this._wakeTrack.set(key, { x: p.x, z: p.z, acc: 0 }); return; }
    const dx = p.x - t.x, dz = p.z - t.z;
    const d = Math.hypot(dx, dz);
    t.x = p.x; t.z = p.z;
    if (d < 1e-5) return;
    t.acc += d;
    if (t.acc < 0.5) return;      // one ring every half metre travelled
    t.acc = 0;
    const sp = d / Math.max(dt, 1e-3);
    if (sp < 0.25) return;
    const str = Math.min(0.075, 0.014 + sp * 0.011) * scale;
    this.addWake(p.x, p.z, dx / d, dz / d, str, 1.5 + sp * 0.5);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CPU surface queries — must agree with the shader
  // ─────────────────────────────────────────────────────────────────────────

  _sample(x, z) {
    const river = this.river;
    const c = this._coord;
    this._v0.set(x, this.level, z);
    river.toRiver(this._v0, c);
    const uc = Math.min(1, Math.max(-1, c.u));
    const depth = river.depth(c.s, uc);
    river.flowAt(c.s, uc, this._flowV);
    const sp = Math.hypot(this._flowV.x, this._flowV.z);
    this._smpDepth = depth;
    this._smpSpeed = sp;
    if (sp > 1e-5) {
      this._smpFdx = this._flowV.x / sp;
      this._smpFdz = this._flowV.z / sp;
    } else {
      this._smpFdx = 0;
      this._smpFdz = 1;
    }
    this._smpAmp = waterAmpJS(depth, c.u, sp);
    this._smpRipMask = 1 - smoothstep01((Math.abs(c.u) - 0.72) / 0.28);
    return c;
  }

  /**
   * Surface height at a world position, waves and live ripples included.
   * Mirrors the vertex shader — one fixed-point iteration undoes the Gerstner
   * horizontal displacement, so this lands within a few mm of what is drawn.
   */
  heightAt(x, z) {
    this._sample(x, z);
    const t = this._elapsed;
    const w = evalWaves(x, z, t, this._smpFdx, this._smpFdz, this._smpSpeed,
      this._smpAmp, this._wave);
    const w2 = evalWaves(x - w.dx, z - w.dz, t, this._smpFdx, this._smpFdz,
      this._smpSpeed, this._smpAmp, this._wave2);
    evalRipples(this._ripples, x, z, this._rip);
    return this.level + w2.dy + this._rip.h * this._smpRipMask;
  }

  /** Surface normal at a world position — for buoyant orientation. */
  normalAt(x, z, out = this._normal) {
    this._sample(x, z);
    const t = this._elapsed;
    const w = evalWaves(x, z, t, this._smpFdx, this._smpFdz, this._smpSpeed,
      this._smpAmp, this._wave);
    const w2 = evalWaves(x - w.dx, z - w.dz, t, this._smpFdx, this._smpFdz,
      this._smpSpeed, this._smpAmp, this._wave2);
    out.set(w2.nx, w2.ny, w2.nz);
    // ripple slope by central difference on the ring field
    const e = 0.12;
    const r = this._rip;
    evalRipples(this._ripples, x + e, z, r); const hx1 = r.h;
    evalRipples(this._ripples, x - e, z, r); const hx0 = r.h;
    evalRipples(this._ripples, x, z + e, r); const hz1 = r.h;
    evalRipples(this._ripples, x, z - e, r); const hz0 = r.h;
    const m = this._smpRipMask / (2 * e);
    out.x -= (hx1 - hx0) * m;
    out.z -= (hz1 - hz0) * m;
    return out.normalize();
  }

  /** Still-water depth under a world position, metres (0 past the bank). */
  depthAt(x, z) {
    this._sample(x, z);
    return this._smpDepth;
  }

  /**
   * Visualise one channel of the shader instead of the shaded surface.
   * 0 off, 1 foam mask, 2 water thickness, 3 metres from the bank, 4 fresnel,
   * 5 surface normal. Used from the capture harness while tuning.
   */
  debug(mode = 0) {
    if (this._u) this._u.uDebug.value = mode;
  }

  /** Flip the surface to its underside look. */
  setUnderwater(flag) {
    this.underwater = !!flag;
    if (this._u) this._u.uUnderwater.value = this.underwater ? 1 : 0;
  }

  dispose() {
    for (const off of this._offs ?? []) off?.();
    if (this.mesh) this.ctx.scene.remove(this.mesh);
    this.geometry?.dispose();
    this.material?.dispose();
    this.textures?.waveA?.dispose();
    this.textures?.waveB?.dispose();
    this.textures?.caustics?.dispose();
    this._reflRT?.dispose();
    this._sceneRT?.depthTexture?.dispose();
    this._sceneRT?.dispose();
  }
}
