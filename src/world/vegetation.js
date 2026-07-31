/**
 * Vegetation — reeds, grass, lilies and underwater weed.
 *
 * Everything here is instanced and everything moves in ONE coherent wind field.
 *
 * ── the wind ──────────────────────────────────────────────────────────────
 * `vegWind(worldXZ, phase)` exists twice, once in GLSL (WIND_GLSL, shared with
 * trees.js) and once on the CPU (`vegetation.wind(pos, out)`), with the same
 * constants, so a leaf, a reed and a dragonfly can all agree about which way
 * the gust is blowing. Gusts are *travelling fronts*: a low-frequency wave
 * moving along the wind direction multiplies a faster ripple, so the reed bed
 * ripples across rather than shimmering uniformly.
 *
 * ── the fields ────────────────────────────────────────────────────────────
 * Reeds, submerged weed and grass are scrolled in slabs of river arc-length
 * around the player instead of instancing the whole 2 km valley. Each slab's
 * contents are generated from a seed derived from its *index*, so the world is
 * deterministic: swim away and back and the same reeds are there. Instances
 * shrink to nothing before the band edge (a distance fade in the vertex
 * shader), so nothing ever pops in.
 *
 * ── the look ──────────────────────────────────────────────────────────────
 * Blades are tapered, curved, per-instance coloured and lean downwind. They are
 * TRANSLUCENT: a back-light term drives glow through the blade when the sun is
 * behind it, weighted toward the tips, which is what makes a low sun through a
 * reed bed read as light rather than as geometry.
 *
 * Public API (on `ctx.vegetation`):
 *   vegetation.wind(worldPos, out) -> Vector3     shared wind, world space
 *   vegetation.windPhase                          scalar, advances with time
 *   vegetation.windDir                            Vector3 (unit, horizontal)
 *   vegetation.windStrength                       0..~1.4
 *   vegetation.group                              Object3D holding everything
 *   vegetation.trees                              the Trees instance (or null)
 *   vegetation.reedHeightAt(s, u)                 approx reed top above ground
 */

import * as THREE from 'three';
import { Noise, makeRandom } from '../core/noise.js';
import { Trees } from './trees.js';

const clamp = THREE.MathUtils.clamp;
const smoothstep = THREE.MathUtils.smoothstep;
const lerp = THREE.MathUtils.lerp;

/** Layer for things we deliberately keep out of the planar water reflection. */
export const NO_REFLECT_LAYER = 11;

// The shoreline profile is sampled across |u| ∈ [LUT_A0, LUT_A0 + LUT_SPAN],
// i.e. from a couple of metres of open water to a few metres up the beach.
const LUT_A0 = 0.86;
const LUT_SPAN = 0.48;

// ── shared wind ────────────────────────────────────────────────────────────

export const WIND_DECL = /* glsl */ `
uniform vec2  uWindDir;
uniform float uWindPhase;
uniform float uWindStrength;
uniform vec3  uCamPos;
`;

export const WIND_GLSL = /* glsl */ `
// Coherent gusts: a slow front travelling along uWindDir modulates a faster
// ripple, plus a weaker cross component so the field never looks like it is
// sliding in one axis. Matches Vegetation.wind() on the CPU.
vec2 vegWind(vec2 p, float phase) {
  float a = dot(p, uWindDir);
  float b = dot(p, vec2(-uWindDir.y, uWindDir.x));
  float front = 0.5 + 0.5 * sin(a * 0.020 - phase * 0.29 + b * 0.007);
  float gust  = 0.30 + 1.05 * front * front;
  float w = sin(a * 0.62 - phase * 2.05) * 0.55
          + sin(a * 0.21 + b * 0.15 - phase * 1.13) * 0.45;
  float cr = sin(b * 0.34 - phase * 1.61) * 0.30;
  vec2 perp = vec2(-uWindDir.y, uWindDir.x);
  return (uWindDir * w + perp * cr) * gust * uWindStrength;
}
`;

// ── geometry builders ──────────────────────────────────────────────────────

/**
 * A tapered, curved blade of unit height lying along +Y, arcing toward +Z.
 * Optionally carries a seed head at the tip, flagged so the shader can collapse
 * it per instance.
 */
function buildBlade({
  segments = 5,
  width = 0.055,
  curve = 0.22,
  taper = 0.72,
  head = false,
  headWidth = 0.036,
  headStart = 0.76,
  baseColor,
  midColor,
  tipColor,
}) {
  const pos = [];
  const nrm = [];
  const col = [];
  const idx = [];
  const flag = []; // 1 = seed head vertex

  const cBase = new THREE.Color(baseColor);
  const cMid = new THREE.Color(midColor);
  const cTip = new THREE.Color(tipColor);
  const c = new THREE.Color();

  const rows = segments + 1;
  for (let i = 0; i < rows; i++) {
    const t = i / segments;
    // widest just above the sheath, then a long taper to a point
    const w = width * Math.pow(1 - t, taper) * (0.62 + 0.38 * smoothstep(t, 0, 0.14));
    const z = curve * t * t;
    // colour ramp: cool at the base (in shadow / in water) → warm at the tip
    if (t < 0.5) c.copy(cBase).lerp(cMid, t * 2);
    else c.copy(cMid).lerp(cTip, (t - 0.5) * 2);
    // the blade is a shallow V in cross-section: side normals splay outward so
    // the blade shades like a curved surface instead of a flat card
    const ny = 0.30 + t * 0.25;
    for (let k = 0; k < 2; k++) {
      const sx = k === 0 ? -1 : 1;
      pos.push(sx * w, t, z);
      const n = new THREE.Vector3(sx * 0.45, ny, -1).normalize();
      nrm.push(n.x, n.y, n.z);
      col.push(c.r, c.g, c.b);
      flag.push(0);
    }
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2, b = a + 1, d = a + 2, e = a + 3;
    idx.push(a, d, b, b, d, e);
  }

  if (head) {
    // Two crossed, tapered quads read as a soft catkin from every angle.
    const base = pos.length / 3;
    const cH = new THREE.Color(tipColor);
    for (let q = 0; q < 2; q++) {
      const ang = q * Math.PI * 0.5 + 0.4;
      const dx = Math.cos(ang), dz = Math.sin(ang);
      for (let r = 0; r < 2; r++) {
        const t = r === 0 ? headStart : 1.0;
        const w = headWidth * (r === 0 ? 0.55 : 0.16);
        const z = curve * t * t;
        for (let k = 0; k < 2; k++) {
          const sx = k === 0 ? -1 : 1;
          pos.push(dx * sx * w, t, z + dz * sx * w);
          nrm.push(dx * sx * 0.5, 0.55, -0.6);
          col.push(cH.r * 1.18, cH.g * 1.12, cH.b * 0.9);
          flag.push(1);
        }
      }
      const a = base + q * 4;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aHead', new THREE.Float32BufferAttribute(flag, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** A lily pad: a notched disc with a slight dome, plus an optional flower. */
function buildLilyGeometry() {
  const pos = [], nrm = [], col = [], idx = [], flag = [];
  const padA = new THREE.Color(0x3e6b47);
  const padB = new THREE.Color(0x6f8a3f);
  const rim = new THREE.Color(0x8c9448);
  // centre
  pos.push(0, 0.012, 0); nrm.push(0, 1, 0); col.push(padA.r, padA.g, padA.b); flag.push(0);
  const segs = 11;
  const span = Math.PI * 2 * 0.92; // notch
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const a = -span * 0.5 + span * t;
    const r = 1 + Math.sin(t * 9.0) * 0.035;
    const edge = i === 0 || i === segs;
    const c = edge ? rim : padB;
    pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    nrm.push(Math.cos(a) * 0.14, 0.99, Math.sin(a) * 0.14);
    col.push(c.r, c.g, c.b);
    flag.push(0);
  }
  for (let i = 0; i < segs; i++) idx.push(0, i + 1, i + 2);

  // flower: three crossed petal quads, collapsed per-instance when unused
  const base = pos.length / 3;
  const petal = new THREE.Color(0xf3e2e6);
  const heart = new THREE.Color(0xe8c063);
  for (let q = 0; q < 3; q++) {
    const ang = (q / 3) * Math.PI;
    const dx = Math.cos(ang), dz = Math.sin(ang);
    const w = 0.30, h = 0.36;
    const v = [
      [-dx * w, 0.02, -dz * w, heart],
      [dx * w, 0.02, dz * w, heart],
      [-dx * w * 0.65, h, -dz * w * 0.65, petal],
      [dx * w * 0.65, h, dz * w * 0.65, petal],
    ];
    for (const [x, y, z, c] of v) {
      pos.push(x, y, z);
      nrm.push(dz * 0.4, 0.9, -dx * 0.4);
      col.push(c.r, c.g, c.b);
      flag.push(1);
    }
    const a = base + q * 4;
    idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aHead', new THREE.Float32BufferAttribute(flag, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// ── a scrolling band of instances ──────────────────────────────────────────

/**
 * Keeps `slabCount` slabs of river arc-length populated around the player.
 * A slab's instances live in a fixed slice of the InstancedMesh, so re-seeding
 * one slab never touches another's data.
 */
class SlabField {
  constructor(mesh, attrs, slabCount, perSlab, slabLen, fill) {
    this.mesh = mesh;
    this.attrs = attrs;
    this.slabCount = slabCount;
    this.perSlab = perSlab;
    this.slabLen = slabLen;
    this.fill = fill;
    this.slabAt = new Int32Array(slabCount).fill(0x7fffffff);
    this._dirty = false;
  }

  update(centerS, budget) {
    const half = this.slabCount >> 1;
    const c = Math.floor(centerS / this.slabLen);
    let built = 0;
    for (let k = -half; k < this.slabCount - half; k++) {
      const idx = c + k;
      const slot = ((idx % this.slabCount) + this.slabCount) % this.slabCount;
      if (this.slabAt[slot] === idx) continue;
      this.slabAt[slot] = idx;
      this.fill(idx, slot * this.perSlab, this.perSlab);
      this._dirty = true;
      if (++built >= budget) break;
    }
    if (this._dirty) {
      this._dirty = false;
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
      for (const a of this.attrs) a.needsUpdate = true;
    }
  }
}

// ── the system ─────────────────────────────────────────────────────────────

export class Vegetation {
  constructor(ctx) {
    this.ctx = ctx;
    this.river = ctx.river;
    this.noise = new Noise(48271);
    this.group = new THREE.Group();
    this.group.name = 'vegetation';
    this.trees = null;

    this.windDir = new THREE.Vector3(0.79, 0, 0.61).normalize();
    this.windPhase = 0;
    this.windStrength = 1.0;

    // hoisted scratch — update() must not allocate
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._p2 = new THREE.Vector3();
    this._sc = new THREE.Vector3();
    this._col = new THREE.Color();
    this._col2 = new THREE.Color();
    this._camPos = new THREE.Vector3();
    this._rc = { s: 0, u: 0, distance: 0 };
    this._lutA = new Float32Array(24);
    this._lutB = new Float32Array(24);
    this._lutKey = [-1e9, -1e9];
    this._lastBandS = -1e9;
    this._geoms = [];
    this._mats = [];
    this._lilyCursor = 0;
    this._sunV = new THREE.Vector3();

    this.uniforms = {
      uWindDir: { value: new THREE.Vector2(this.windDir.x, this.windDir.z) },
      uWindPhase: { value: 0 },
      uWindStrength: { value: 1 },
      uCamPos: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 0.9, 0.72) },
      uSkyColor: { value: new THREE.Color(0.35, 0.5, 0.66) },
    };
  }

  // ── CPU mirror of the GLSL wind ──────────────────────────────────────────

  /** Shared wind at a world position. Writes and returns `out` (Vector3). */
  wind(worldPos, out = this._p2) {
    const dx = this.windDir.x, dz = this.windDir.z;
    const p = this.windPhase;
    const a = worldPos.x * dx + worldPos.z * dz;
    const b = worldPos.x * -dz + worldPos.z * dx;
    const front = 0.5 + 0.5 * Math.sin(a * 0.02 - p * 0.29 + b * 0.007);
    const gust = 0.3 + 1.05 * front * front;
    const w =
      Math.sin(a * 0.62 - p * 2.05) * 0.55 +
      Math.sin(a * 0.21 + b * 0.15 - p * 1.13) * 0.45;
    const cr = Math.sin(b * 0.34 - p * 1.61) * 0.3;
    const s = gust * this.windStrength;
    return out.set((dx * w - dz * cr) * s, 0, (dz * w + dx * cr) * s);
  }

  // ── init ─────────────────────────────────────────────────────────────────

  async init() {
    const q = this.ctx.settings?.quality ?? {};
    // main.js replaces ctx.camera with the camera *rig* once that system boots,
    // so hold the real PerspectiveCamera from the engine.
    this.camera = this.ctx.engine?.camera || this.ctx.camera;
    this.reedCount = Math.max(400, q.reedCount ?? 5200);
    this.grassCount = Math.max(1000, q.grassCount ?? 18000);

    this._buildReeds();
    this._buildGrass();
    this._buildLilies();

    this.ctx.scene.add(this.group);

    // Trees are a big enough job to live in their own file.
    try {
      this.trees = new Trees(this.ctx, {
        windDecl: WIND_DECL,
        windGlsl: WIND_GLSL,
        uniforms: this.uniforms,
        noise: this.noise,
        noReflectLayer: NO_REFLECT_LAYER,
      });
      await this.trees.init();
    } catch (err) {
      console.warn('[vegetation] trees failed:', err.message);
      this.trees = null;
    }

    // Grass is 38k blades of sub-pixel detail in the reflection; skipping it
    // there buys back a whole pass worth of triangles and nobody can tell.
    this.camera?.layers?.enable(NO_REFLECT_LAYER);
    const reflCam = this.ctx.water?._reflCam;
    if (reflCam?.layers) reflCam.layers.disable(NO_REFLECT_LAYER);

    // First fill: everything, no budget.
    this._syncBands(true);
  }

  // ── materials ────────────────────────────────────────────────────────────

  /**
   * One shader for every blade-like plant: instanced, wind-bent, distance
   * faded, and translucent when back-lit.
   */
  _plantMaterial({ bend, fadeStart, fadeEnd, trans, transPow = 3.0, side = THREE.DoubleSide }) {
    const mat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      vertexColors: true,
      side,
      transparent: false,
    });
    const extra = {
      uBend: { value: bend },
      uFadeStart: { value: fadeStart },
      uFadeEnd: { value: fadeEnd },
      uTrans: { value: trans },
      uTransPow: { value: transPow },
    };
    mat.userData.extra = extra;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms, extra);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
${WIND_DECL}
uniform float uBend;
uniform float uFadeStart;
uniform float uFadeEnd;
attribute float aHead;
attribute vec4 aVeg;    // phase, flex, flags(1=head 2=submerged), transMask
attribute vec2 aFlow;   // local current, for submerged weed
varying float vTrans;
varying float vTip;
${WIND_GLSL}`
        )
        .replace(
          '#include <begin_vertex>',
          `vec3 transformed = vec3( position );
  float headOn = step(1.5, mod(aVeg.z, 4.0));
  float submerged = step(3.5, aVeg.z);
  if (aHead > 0.5 && headOn < 0.5) transformed = vec3(0.0, 1.0, 0.0);
  vec3 iOrigin = instanceMatrix[3].xyz;
  vec3 c0 = instanceMatrix[0].xyz, c1 = instanceMatrix[1].xyz, c2 = instanceMatrix[2].xyz;
  float s0 = dot(c0,c0), s1 = dot(c1,c1), s2 = dot(c2,c2);
  float dcam = distance(iOrigin, uCamPos);
  float fadeEnd = mix(uFadeEnd, uFadeEnd * 0.42, submerged);
  float fadeStart = mix(uFadeStart, uFadeStart * 0.42, submerged);
  float fade = 1.0 - smoothstep(fadeStart, fadeEnd, dcam);
  transformed *= fade;
  float t = clamp(position.y, 0.0, 1.0);
  vec2 w = vegWind(iOrigin.xz, uWindPhase + aVeg.x * 6.2831);
  vec2 drift = aFlow * (0.55 + 0.45 * sin(uWindPhase * 0.85 + aVeg.x * 6.2831));
  w = mix(w, drift, submerged);
  float bend = pow(t, 1.65) * uBend * aVeg.y * fade;
  vec3 d = vec3(w.x, 0.0, w.y) * bend;
  d.y -= length(w) * bend * 0.22 * t;
  transformed += vec3(dot(d,c0)/max(s0,1e-6), dot(d,c1)/max(s1,1e-6), dot(d,c2)/max(s2,1e-6));
  vTip = t;
  vTrans = aVeg.w * mix(0.22, 1.0, t) * (1.0 - submerged * 0.75);`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform float uTrans;
uniform float uTransPow;
varying float vTrans;
varying float vTip;`
        )
        .replace(
          '#include <opaque_fragment>',
          `{
    vec3 L = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
    vec3 V = normalize(vViewPosition);
    float back = max(0.0, dot(-V, L));
    float glow = pow(back, uTransPow) * uTrans * vTrans;
    outgoingLight += glow * uSunColor * (diffuseColor.rgb * 1.35 + 0.16);
    // a whisper of sky bounce keeps the shadowed side coloured, never black
    outgoingLight += uSkyColor * diffuseColor.rgb * 0.10 * vTip;
  }
  #include <opaque_fragment>`
        );
      mat.userData.shader = shader;
    };
    mat.customProgramCacheKey = () => `veg-plant-${bend}-${fadeEnd}-${trans}`;
    this._mats.push(mat);
    return mat;
  }

  // ── reeds + submerged weed ───────────────────────────────────────────────

  _buildReeds() {
    const geo = buildBlade({
      segments: 5,
      width: 0.072,
      curve: 0.26,
      taper: 0.66,
      head: true,
      headWidth: 0.05,
      baseColor: 0x2f4a38,
      midColor: 0x5f7536,
      tipColor: 0xb2a457,
    });
    this._geoms.push(geo);

    const weedCount = Math.round(this.reedCount * 0.16);
    const total = this.reedCount + weedCount;
    this.reedTotal = total;
    this.weedCount = weedCount;

    const mat = this._plantMaterial({
      bend: 0.30,
      fadeStart: 108,
      fadeEnd: 148,
      trans: 1.55,
      transPow: 2.6,
    });
    this.reedMaterial = mat;

    const mesh = new THREE.InstancedMesh(geo, mat, total);
    mesh.name = 'reeds';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    const aVeg = new THREE.InstancedBufferAttribute(new Float32Array(total * 4), 4);
    const aFlow = new THREE.InstancedBufferAttribute(new Float32Array(total * 2), 2);
    aVeg.setUsage(THREE.DynamicDrawUsage);
    aFlow.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aVeg', aVeg);
    geo.setAttribute('aFlow', aFlow);
    this.reedMesh = mesh;
    this._reedVeg = aVeg;
    this._reedFlow = aFlow;
    this.group.add(mesh);

    const slabCount = 22;
    const slabLen = 15;
    this.reedField = new SlabField(
      mesh, [aVeg, aFlow], slabCount,
      Math.floor(total / slabCount), slabLen,
      (idx, base, n) => this._fillReedSlab(idx, base, n)
    );
  }

  /**
   * Elevation profile across the shore for one bank at arc length `s`.
   * Cached per (s bucket, side) because it costs a fistful of noise calls and
   * every plant in a clump wants the same answer.
   */
  _shoreLUT(s, side) {
    const sq = Math.round(s / 5) * 5; // one profile per 5 m of bank per side
    const slot = side < 0 ? 0 : 1;
    const lut = slot === 0 ? this._lutA : this._lutB;
    if (this._lutKey[slot] === sq) return lut;
    this._lutKey[slot] = sq;
    const river = this.river;
    for (let i = 0; i < lut.length; i++) {
      const a = LUT_A0 + (i / (lut.length - 1)) * LUT_SPAN;
      lut[i] = river.bedHeight(sq, side * a);
    }
    return lut;
  }

  /** Inverse of the LUT: |u| whose ground elevation is closest to `y`. */
  _uForElevation(lut, y) {
    const n = lut.length;
    if (y <= lut[0]) return LUT_A0;
    for (let i = 1; i < n; i++) {
      if (lut[i] >= y) {
        const d = lut[i] - lut[i - 1];
        const k = d > 1e-5 ? (y - lut[i - 1]) / d : 0;
        return LUT_A0 + ((i - 1 + k) / (n - 1)) * LUT_SPAN;
      }
    }
    return LUT_A0 + LUT_SPAN;
  }

  _fillReedSlab(slabIndex, base, n) {
    const river = this.river;
    const noise = this.noise;
    const rng = makeRandom((slabIndex * 2654435761) ^ 0x9e3779b9);
    const s0 = slabIndex * this.reedField.slabLen;
    const len = this.reedField.slabLen;
    const m = this._m, q = this._q, e = this._e, p = this._p, sc = this._sc;
    const col = this._col;
    const veg = this._reedVeg.array;
    const flow = this._reedFlow.array;
    const mesh = this.reedMesh;
    const submergedShare = this.weedCount / this.reedTotal;

    const green = this._col2;
    let i = base;
    const end = base + n;
    const inRange = s0 > -len && s0 < river.length + len;

    // Reeds are placed as drifts: pick a clump anchor, then scatter blades
    // around it sharing one shoreline lookup.
    let guard = 0;
    while (i < end && guard++ < 4000) {
      if (!inRange) break;
      const s = s0 + rng() * len;
      if (s < 1 || s > river.length - 1) break;
      const side = rng() < 0.5 ? -1 : 1;
      const submerged = rng() < submergedShare;

      // Where the drifts are: low-frequency noise along the bank.
      const drift = noise.fbm2(s * 0.045, side * 21.7, 3);
      const density = smoothstep(drift, -0.34, 0.30);
      if (!submerged && rng() > 0.16 + density * 0.92) continue;

      const lut = this._shoreLUT(s, side);
      // Target elevation: reeds straddle the waterline, weed sits under it.
      const ty = submerged
        ? -lerp(0.45, 1.9, Math.min(1, rng() * rng() + 0.05))
        : lerp(-1.05, 0.85, Math.pow(rng(), 0.9));
      const a = this._uForElevation(lut, ty);
      const u = side * a;
      const groundY = river.bedHeight(s, u);
      if (groundY < (submerged ? -2.6 : -1.5)) continue;

      const clumpSize = submerged ? 2 + ((rng() * 3) | 0) : 6 + ((rng() * 10) | 0);
      const clumpR = submerged ? 0.55 : 0.34 + rng() * 0.55;
      const cW = river.halfWidth(s);
      // one clump-wide colour so drifts read as drifts, not as noise
      const dry = smoothstep(noise.fbm2(s * 0.02, side * 8.3 + 3.1, 2), -0.1, 0.5);
      const baseTint = 0.86 + rng() * 0.28;

      for (let k = 0; k < clumpSize && i < end; k++) {
        const ds = (rng() - 0.5) * clumpR * 2;
        const du = (rng() - 0.5) * clumpR * 0.9 / cW;
        const ss = s + ds;
        const uu = u + du;
        river.toWorld(ss, uu, 0, p);
        const gy = river.bedHeight(ss, uu);
        p.y = gy - 0.05;

        let h, flex, headOn, transMask;
        if (submerged) {
          h = 0.55 + rng() * 1.15;
          h = Math.min(h, Math.max(0.25, -gy - 0.12));
          flex = 1.5 + rng() * 0.8;
          headOn = 0;
          transMask = 0.4;
        } else {
          const tall = rng();
          h = lerp(0.75, 2.35, tall * tall * 0.7 + rng() * 0.3);
          // reeds standing in water are the tall ones
          if (gy < -0.2) h = Math.max(h, 1.25);
          flex = 0.75 + rng() * 0.6;
          headOn = rng() < 0.42 ? 1 : 0;
          transMask = 1.0;
        }

        const lean = submerged ? 0.05 : 0.06 + rng() * 0.16;
        const yaw = rng() * Math.PI * 2;
        e.set(lean * (rng() - 0.5) * 2, yaw, lean * (rng() - 0.5) * 2, 'YXZ');
        q.setFromEuler(e);
        const wide = (0.95 + rng() * 0.7) * (submerged ? 1.6 : 1);
        sc.set(wide, h, wide);
        m.compose(p, q, sc);
        mesh.setMatrixAt(i, m);

        if (submerged) {
          col.setRGB(0.16, 0.30, 0.24).multiplyScalar(0.75 + rng() * 0.5);
        } else {
          // teal-green to honeyed ochre, biased by the dry-band noise
          green
            .setRGB(0.52, 0.72, 0.42)
            .lerp(this._sunTintTarget(), clamp(dry + (rng() - 0.5) * 0.4, 0, 1));
          col.copy(green).multiplyScalar(baseTint * (0.88 + rng() * 0.24));
        }
        mesh.setColorAt(i, col);

        const o4 = i * 4;
        veg[o4] = rng();
        veg[o4 + 1] = flex;
        veg[o4 + 2] = (submerged ? 4 : 0) + (headOn ? 2 : 0);
        veg[o4 + 3] = transMask;
        const o2 = i * 2;
        if (submerged) {
          river.flowAt(ss, uu, this._p2);
          flow[o2] = this._p2.x * 0.22;
          flow[o2 + 1] = this._p2.z * 0.22;
        } else {
          flow[o2] = 0;
          flow[o2 + 1] = 0;
        }
        i++;
      }
    }
    // park unused slots
    m.makeScale(0, 0, 0);
    for (; i < end; i++) mesh.setMatrixAt(i, m);
  }

  _sunTintTarget() {
    return this.__dryCol || (this.__dryCol = new THREE.Color(1.02, 0.86, 0.42));
  }

  // ── bank grass ───────────────────────────────────────────────────────────

  _buildGrass() {
    const geo = buildBlade({
      segments: 3,
      width: 0.044,
      curve: 0.32,
      taper: 0.74,
      head: false,
      baseColor: 0x2e4530,
      midColor: 0x5e7436,
      tipColor: 0x9aa050,
    });
    this._geoms.push(geo);

    const total = this.grassCount;
    const mat = this._plantMaterial({
      bend: 0.34,
      fadeStart: 44,
      fadeEnd: 68,
      trans: 1.35,
      transPow: 2.4,
    });
    this.grassMaterial = mat;

    const mesh = new THREE.InstancedMesh(geo, mat, total);
    mesh.name = 'grass';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.layers.set(NO_REFLECT_LAYER);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    const aVeg = new THREE.InstancedBufferAttribute(new Float32Array(total * 4), 4);
    const aFlow = new THREE.InstancedBufferAttribute(new Float32Array(total * 2), 2);
    aVeg.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aVeg', aVeg);
    geo.setAttribute('aFlow', aFlow);
    this.grassMesh = mesh;
    this._grassVeg = aVeg;
    this.group.add(mesh);

    const slabCount = 14;
    this.grassField = new SlabField(
      mesh, [aVeg], slabCount,
      Math.floor(total / slabCount), 10,
      (idx, base, n) => this._fillGrassSlab(idx, base, n)
    );
  }

  _fillGrassSlab(slabIndex, base, n) {
    const river = this.river;
    const noise = this.noise;
    const rng = makeRandom((slabIndex * 40503 + 917) ^ 0x2545f491);
    const len = this.grassField.slabLen;
    const s0 = slabIndex * len;
    const m = this._m, q = this._q, e = this._e, p = this._p, sc = this._sc;
    const col = this._col, tmp = this._col2;
    const veg = this._grassVeg.array;
    const mesh = this.grassMesh;

    const COOL = new THREE.Color(0x44603a);
    const WARM = new THREE.Color(0x7b8b3f);
    const DRY = new THREE.Color(0x9a8340);

    let i = base;
    const end = base + n;
    const inRange = s0 > -len && s0 < river.length + len;
    let guard = 0;
    while (i < end && guard++ < 3000) {
      if (!inRange) break;
      const s = s0 + rng() * len;
      if (s < 1 || s > river.length - 1) break;
      const side = rng() < 0.5 ? -1 : 1;
      // denser near the water, thinning inland
      const r = rng();
      const inland = 0.7 + Math.pow(r, 1.9) * 27;
      const hw = river.halfWidth(s);
      const u = side * (1 + inland / hw);

      // patchiness: bare earth where the noise dips
      const patch = noise.fbm2(s * 0.09, (side * inland) * 0.09 + 51.3, 4);
      const cover = smoothstep(patch, -0.30, 0.22);
      if (rng() > cover * 0.95 + 0.05) continue;

      const y0 = river.bankHeight(s, u);
      if (y0 < 0.10) continue;
      // local slope along the inland axis so a clump sits flat on the ground
      const du = 0.9 / hw;
      const slope = (river.bankHeight(s, u + side * du) - y0) / 0.9;
      if (Math.abs(slope) > 1.35) continue; // no grass on cliffs

      const clumpN = 5 + ((rng() * 7) | 0);
      const clumpR = 0.24 + rng() * 0.32;
      const shade = 0.82 + rng() * 0.36;
      const dryness = clamp(
        smoothstep(inland, 3, 26) * 0.75 +
        noise.fbm2(s * 0.012, side * 3.7, 2) * 0.4 + 0.15, 0, 1);
      tmp.copy(COOL).lerp(WARM, clamp(0.35 + (rng() - 0.5) * 0.5 + cover * 0.4, 0, 1));
      tmp.lerp(DRY, dryness * 0.7);

      for (let k = 0; k < clumpN && i < end; k++) {
        const dInl = (rng() - 0.5) * clumpR * 2;
        const ds = (rng() - 0.5) * clumpR * 2;
        const uu = u + (side * dInl) / hw;
        river.toWorld(s + ds, uu, 0, p);
        p.y = y0 + slope * dInl - 0.03;

        const h = lerp(0.22, 0.78, Math.pow(rng(), 1.3)) * (1 - dryness * 0.18);
        const yaw = rng() * Math.PI * 2;
        e.set((rng() - 0.5) * 0.5, yaw, (rng() - 0.5) * 0.5, 'YXZ');
        q.setFromEuler(e);
        const wide = 0.75 + rng() * 0.7;
        sc.set(wide, h, wide);
        m.compose(p, q, sc);
        mesh.setMatrixAt(i, m);

        col.copy(tmp).multiplyScalar(shade * (0.86 + rng() * 0.3));
        mesh.setColorAt(i, col);

        const o4 = i * 4;
        veg[o4] = rng();
        veg[o4 + 1] = 1.1 + rng() * 0.7;
        veg[o4 + 2] = 0;
        veg[o4 + 3] = 0.85;
        i++;
      }
    }
    m.makeScale(0, 0, 0);
    for (; i < end; i++) mesh.setMatrixAt(i, m);
  }

  // ── lily pads and floating weed (static, in the pools) ───────────────────

  _buildLilies() {
    const geo = buildLilyGeometry();
    this._geoms.push(geo);
    const river = this.river;
    const rng = makeRandom(77123);
    const pools = river.pools || [];
    const perPool = 46;
    const total = Math.max(1, pools.length * perPool);

    const mat = this._plantMaterial({
      bend: 0.04,
      fadeStart: 90,
      fadeEnd: 130,
      trans: 0.85,
      transPow: 3.2,
      side: THREE.DoubleSide,
    });
    this.lilyMaterial = mat;

    const mesh = new THREE.InstancedMesh(geo, mat, total);
    mesh.name = 'lilies';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.layers.set(NO_REFLECT_LAYER);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3);
    const aVeg = new THREE.InstancedBufferAttribute(new Float32Array(total * 4), 4);
    const aFlow = new THREE.InstancedBufferAttribute(new Float32Array(total * 2), 2);
    geo.setAttribute('aVeg', aVeg);
    geo.setAttribute('aFlow', aFlow);
    this.lilyMesh = mesh;
    this.group.add(mesh);

    const m = this._m, q = this._q, e = this._e, p = this._p, sc = this._sc;
    const col = this._col;
    const pads = [];
    let i = 0;
    for (const pool of pools) {
      // Rafts of pads hug the slack water on one side of the pool.
      const side = rng() < 0.5 ? -1 : 1;
      for (let k = 0; k < perPool && i < total; k++) {
        const s = pool.s + (rng() - 0.5) * pool.radius * 2.4;
        if (s < 2 || s > river.length - 2) continue;
        const weedy = rng() < 0.34;
        const a = weedy ? 0.62 + rng() * 0.33 : 0.5 + rng() * 0.42;
        const u = side * a;
        const d = river.depth(s, u);
        if (d < 0.35 || d > 3.2) continue;
        river.toWorld(s, u, 0, p);
        const size = weedy ? 0.10 + rng() * 0.10 : 0.34 + rng() * 0.42;
        const flower = !weedy && rng() < 0.16 ? 2 : 0;
        e.set(0, rng() * Math.PI * 2, 0, 'YXZ');
        q.setFromEuler(e);
        sc.set(size, size * 1.15, size);
        m.compose(p, q, sc);
        mesh.setMatrixAt(i, m);
        if (weedy) col.setRGB(0.36, 0.55, 0.24).multiplyScalar(0.8 + rng() * 0.5);
        else col.setRGB(0.72, 0.86, 0.6).multiplyScalar(0.72 + rng() * 0.45);
        mesh.setColorAt(i, col);
        const o4 = i * 4;
        aVeg.array[o4] = rng();
        aVeg.array[o4 + 1] = 0.4;
        aVeg.array[o4 + 2] = flower;
        aVeg.array[o4 + 3] = 0.9;
        pads.push({ x: p.x, z: p.z, y: 0, size, rot: e.y, phase: rng() * 6.283 });
        i++;
      }
    }
    m.makeScale(0, 0, 0);
    for (; i < total; i++) mesh.setMatrixAt(i, m);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    this.lilyPads = pads;
  }

  /** Approximate reed canopy height above the ground at a river coordinate. */
  reedHeightAt(s, u) {
    const a = Math.abs(u);
    if (a < 0.9 || a > 1.2) return 0;
    const d = smoothstep(this.noise.fbm2(s * 0.045, Math.sign(u) * 21.7, 3), -0.34, 0.3);
    return d * 1.8;
  }

  // ── per frame ────────────────────────────────────────────────────────────

  _syncBands(full) {
    const player = this.ctx.player;
    let s = 0;
    if (player?.riverCoord) s = player.riverCoord.s;
    else if (this.camera) s = this.river.toRiver(this.camera.position, this._rc).s;
    // A teleport (or the very first fill) rebuilds every slab at once; ordinary
    // swimming only ever re-seeds a slab or two per frame.
    const jumped = Math.abs(s - this._lastBandS) > 120;
    this._lastBandS = s;
    const budget = full || jumped ? 1e9 : 2;
    this.reedField.update(s, budget);
    this.grassField.update(s, budget);
  }

  update(dt, elapsed) {
    // wind: a slow breathing strength on top of the travelling gusts
    this.windStrength = 0.72 + 0.42 * (0.5 + 0.5 * Math.sin(elapsed * 0.11 + 1.7));
    this.windPhase += dt * (0.9 + this.windStrength * 0.35);

    const u = this.uniforms;
    u.uWindPhase.value = this.windPhase;
    u.uWindStrength.value = this.windStrength;
    const cam = this.camera;
    if (cam) {
      this._camPos.setFromMatrixPosition(cam.matrixWorld);
      u.uCamPos.value.copy(this._camPos);
    }
    const sky = this.ctx.sky;
    if (sky) {
      if (sky.sunDirection) u.uSunDir.value.copy(sky.sunDirection);
      if (sky.sunColor) u.uSunColor.value.copy(sky.sunColor);
      if (sky.ambientColor) u.uSkyColor.value.copy(sky.ambientColor);
    }

    this._syncBands(false);
    this._bobLilies();
    if (this.trees) this.trees.update(dt, elapsed);
  }

  /** Lily pads ride the real water surface, a slice per frame. */
  _bobLilies() {
    const water = this.ctx.water;
    const pads = this.lilyPads;
    if (!water?.heightAt || !pads || !pads.length) return;
    const mesh = this.lilyMesh;
    const m = this._m, q = this._q, e = this._e, p = this._p, sc = this._sc;
    const n = pads.length;
    const slice = Math.min(n, 40);
    const cx = this._camPos.x, cz = this._camPos.z;
    let touched = 0;
    for (let k = 0; k < slice; k++) {
      const i = (this._lilyCursor + k) % n;
      const pad = pads[i];
      const dx = pad.x - cx, dz = pad.z - cz;
      if (dx * dx + dz * dz > 140 * 140) continue;
      const h = water.heightAt(pad.x, pad.z);
      let nx = 0, nz = 0;
      if (water.normalAt) {
        const nv = water.normalAt(pad.x, pad.z, this._p2);
        nx = nv.x; nz = nv.z;
      }
      p.set(pad.x, h + 0.012, pad.z);
      e.set(-nz * 0.85, pad.rot, nx * 0.85, 'YXZ');
      q.setFromEuler(e);
      sc.set(pad.size, pad.size * 1.15, pad.size);
      m.compose(p, q, sc);
      mesh.setMatrixAt(i, m);
      touched++;
    }
    this._lilyCursor = (this._lilyCursor + slice) % n;
    if (touched) mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    if (this.trees) this.trees.dispose?.();
    this.group.removeFromParent();
    for (const g of this._geoms) g.dispose();
    for (const m of this._mats) m.dispose();
    this._geoms.length = 0;
    this._mats.length = 0;
  }
}
