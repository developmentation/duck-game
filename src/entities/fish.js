// Fish schools — the reason to dive.
//
// Four species, four silhouettes, one draw call each. Everything expensive is
// in the vertex shader: the body is a rigid mesh that a travelling sine bends
// as it is drawn, so a shoal of forty minnows costs the same as one minnow
// plus forty instance transforms.
//
// The simulation is a boids flock expressed in the WATER'S frame rather than
// the world's. That single choice buys most of the behaviour for free: a fish
// that wants a small forward velocity relative to the water, in a river that is
// pushing it downstream, automatically turns to face upstream and hovers on the
// spot — which is exactly what real river fish do all day.
//
// Population streams: shoals are placed along the whole river at build time but
// only those near the player hold slots in the instance buffers. Everything
// else sleeps at zero cost.
//
// Exposed on ctx.fish:
//   fish.count                               simulated fish right now
//   fish.population                          total fish the river holds
//   fish.tryCatch(position, radius)          → descriptor | null
//   fish.nearest(position, maxDist)          → descriptor | null
//   fish.setSpawnRate(x)                     0..2 density multiplier
//   fish.startle(position, radius, strength) scatter a neighbourhood
//   fish.speciesInfo                         [{ key, name, color, length }]
//
// Emits: FISH_CAUGHT, FISH_ESCAPED, BUBBLES, SPLASH (surface rises), SFX.
// Listens: DIVE, SPLASH (strong ones only).

import * as THREE from 'three';
import { makeRandom } from '../core/noise.js';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// species
// ---------------------------------------------------------------------------
//
// `profile` is [t, halfWidth, halfHeight, centreY] in fractions of the body
// length, t running 0 (snout) → 1 (tail base). It is the silhouette; get it
// right and the fish reads at 20 m as a shape rather than a smear.

const SPECIES_DEFS = [
  {
    key: 'minnow',
    name: 'Silver minnow',
    length: 0.085,
    rings: 10,
    radial: 7,
    section: 0.86,
    bellyFlat: 0.0,
    profile: [
      [0.00, 0.010, 0.014, 0.000],
      [0.08, 0.036, 0.052, 0.006],
      [0.18, 0.050, 0.080, 0.009],
      [0.32, 0.053, 0.086, 0.007],
      [0.48, 0.046, 0.076, 0.002],
      [0.64, 0.034, 0.058, -0.003],
      [0.78, 0.022, 0.038, -0.006],
      [0.90, 0.013, 0.022, -0.008],
      [1.00, 0.008, 0.013, -0.008],
    ],
    dorsal: { t0: 0.44, t1: 0.66, h: [0.0, 0.055, 0.062, 0.030], seg: 3 },
    anal: { t0: 0.66, t1: 0.82, h: [0.0, 0.034, 0.026], seg: 2 },
    caudal: { len: 0.26, lobe: 0.105, fork: 0.55 },
    pectoral: { t: 0.24, y: -0.020, len: 0.070, drop: 0.030, sweep: 0.045 },
    pelvic: { t: 0.50, y: -0.052, len: 0.040, drop: 0.022, sweep: 0.028 },
    back: 0x35513f,
    flank: 0xcfd9dc,
    belly: 0xf6f2e6,
    mark: 0x2c4550,
    fin: 0xd9cdb4,
    eye: { z: 0.375, y: 0.020, r: 0.026, iris: 0xd9b34a },
    gill: { z: 0.30, slant: 0.10, w: 0.012 },
    pattern: [0.0, 0.0, 6.0, 0.0], // barFreq, barAmt, mottleScale, mottleAmt
    line: 0.9,
    irid: 0.7,
    gloss: 0.9,
    shoalSize: [16, 34],
    cap: 300,
    cruise: 0.30,
    burstSpeed: 1.9,
    turn: 4.2,
    depthBand: [0.25, 1.1],
    uBand: [0.0, 0.62],
    sep: 0.16,
    perceive: 0.85,
    wSep: 1.55,
    wAli: 0.95,
    wCoh: 0.62,
    wariness: 0.42,
    beat: 3.4,
    waveAmp: 0.085,
    waveK: 4.2,
    waveStart: 0.16,
    rises: 1.0,
    solitary: false,
    viewRange: 30,
  },
  {
    key: 'perch',
    name: 'River perch',
    length: 0.235,
    rings: 11,
    radial: 8,
    section: 0.9,
    bellyFlat: 0.05,
    profile: [
      [0.00, 0.013, 0.019, 0.000],
      [0.08, 0.042, 0.068, 0.004],
      [0.18, 0.057, 0.103, 0.010],
      [0.32, 0.061, 0.116, 0.014],
      [0.46, 0.055, 0.104, 0.010],
      [0.60, 0.043, 0.081, 0.004],
      [0.74, 0.028, 0.052, 0.000],
      [0.88, 0.016, 0.030, -0.002],
      [1.00, 0.010, 0.017, -0.002],
    ],
    dorsal: { t0: 0.30, t1: 0.72, h: [0.0, 0.070, 0.058, 0.020, 0.048, 0.040, 0.0], seg: 6 },
    anal: { t0: 0.68, t1: 0.84, h: [0.0, 0.046, 0.030], seg: 2 },
    caudal: { len: 0.22, lobe: 0.115, fork: 0.42 },
    pectoral: { t: 0.26, y: -0.010, len: 0.085, drop: 0.040, sweep: 0.055 },
    pelvic: { t: 0.42, y: -0.078, len: 0.055, drop: 0.032, sweep: 0.034 },
    back: 0x2f4326,
    flank: 0x9a8b3c,
    belly: 0xe8dcb6,
    mark: 0x24341f,
    fin: 0xc4622a,
    eye: { z: 0.372, y: 0.026, r: 0.030, iris: 0xe0a13a },
    gill: { z: 0.285, slant: 0.12, w: 0.016 },
    pattern: [5.2, 0.72, 9.0, 0.16],
    line: 0.6,
    irid: 0.32,
    gloss: 0.8,
    shoalSize: [4, 9],
    cap: 80,
    cruise: 0.26,
    burstSpeed: 2.4,
    turn: 3.2,
    depthBand: [0.8, 2.6],
    uBand: [0.32, 0.86],
    sep: 0.42,
    perceive: 2.0,
    wSep: 1.5,
    wAli: 0.55,
    wCoh: 0.38,
    wariness: 0.6,
    beat: 2.3,
    waveAmp: 0.062,
    waveK: 3.4,
    waveStart: 0.24,
    rises: 0.45,
    solitary: false,
    viewRange: 46,
  },
  {
    key: 'pike',
    name: 'Pike',
    length: 0.78,
    rings: 12,
    radial: 8,
    section: 0.95,
    bellyFlat: 0.08,
    profile: [
      [0.00, 0.008, 0.010, 0.000],
      [0.07, 0.022, 0.028, -0.002],
      [0.16, 0.033, 0.046, 0.000],
      [0.30, 0.039, 0.056, 0.002],
      [0.45, 0.040, 0.058, 0.002],
      [0.60, 0.037, 0.055, 0.000],
      [0.74, 0.030, 0.045, -0.002],
      [0.88, 0.018, 0.028, -0.004],
      [1.00, 0.010, 0.015, -0.004],
    ],
    dorsal: { t0: 0.70, t1: 0.88, h: [0.0, 0.052, 0.044, 0.012], seg: 3 },
    anal: { t0: 0.74, t1: 0.90, h: [0.0, 0.042, 0.014], seg: 2 },
    caudal: { len: 0.20, lobe: 0.090, fork: 0.35 },
    pectoral: { t: 0.22, y: -0.018, len: 0.060, drop: 0.028, sweep: 0.040 },
    pelvic: { t: 0.58, y: -0.046, len: 0.048, drop: 0.026, sweep: 0.030 },
    back: 0x25341f,
    flank: 0x4d6236,
    belly: 0xd8cea4,
    mark: 0xbfc98a,
    fin: 0x8a6f3a,
    eye: { z: 0.400, y: 0.020, r: 0.020, iris: 0xc9a233 },
    gill: { z: 0.325, slant: 0.10, w: 0.014 },
    pattern: [3.1, 0.30, 14.0, 0.42],
    line: 0.5,
    irid: 0.18,
    gloss: 0.62,
    shoalSize: [1, 1],
    cap: 8,
    cruise: 0.16,
    burstSpeed: 3.6,
    turn: 2.2,
    depthBand: [0.7, 2.2],
    uBand: [0.5, 0.9],
    sep: 1.6,
    perceive: 3.0,
    wSep: 2.0,
    wAli: 0.0,
    wCoh: 0.0,
    wariness: 0.88,
    beat: 1.35,
    waveAmp: 0.05,
    waveK: 2.6,
    waveStart: 0.32,
    rises: 0.0,
    solitary: true,
    viewRange: 70,
  },
  {
    key: 'loach',
    name: 'Stone loach',
    length: 0.125,
    rings: 11,
    radial: 7,
    section: 0.8,
    bellyFlat: 0.42,
    profile: [
      [0.00, 0.009, 0.011, 0.000],
      [0.08, 0.026, 0.028, 0.000],
      [0.18, 0.033, 0.036, 0.001],
      [0.32, 0.034, 0.037, 0.001],
      [0.46, 0.032, 0.035, 0.000],
      [0.60, 0.028, 0.031, 0.000],
      [0.74, 0.022, 0.026, 0.000],
      [0.88, 0.014, 0.018, 0.000],
      [1.00, 0.008, 0.011, 0.000],
    ],
    dorsal: { t0: 0.50, t1: 0.68, h: [0.0, 0.030, 0.026, 0.010], seg: 3 },
    anal: { t0: 0.74, t1: 0.86, h: [0.0, 0.024, 0.010], seg: 2 },
    caudal: { len: 0.17, lobe: 0.062, fork: 0.14 },
    pectoral: { t: 0.24, y: -0.026, len: 0.062, drop: 0.014, sweep: 0.040 },
    pelvic: { t: 0.52, y: -0.030, len: 0.044, drop: 0.010, sweep: 0.026 },
    back: 0x4b3b26,
    flank: 0x8a7248,
    belly: 0xd7c39a,
    mark: 0x33281a,
    fin: 0x9d8353,
    eye: { z: 0.380, y: 0.014, r: 0.016, iris: 0x8f7b3f },
    gill: { z: 0.300, slant: 0.06, w: 0.010 },
    pattern: [0.0, 0.0, 26.0, 0.62],
    line: 0.25,
    irid: 0.08,
    gloss: 0.45,
    shoalSize: [3, 7],
    cap: 60,
    cruise: 0.14,
    burstSpeed: 1.5,
    turn: 3.6,
    depthBand: [99, 99], // bed-hugging, handled specially
    uBand: [0.15, 0.8],
    sep: 0.28,
    perceive: 1.1,
    wSep: 1.4,
    wAli: 0.35,
    wCoh: 0.3,
    wariness: 0.3,
    beat: 2.6,
    waveAmp: 0.115,
    waveK: 5.4,
    waveStart: 0.10,
    rises: 0.0,
    solitary: false,
    bedHugger: true,
    viewRange: 26,
  },
];

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

function sampleProfile(profile, t) {
  const n = profile.length;
  if (t <= profile[0][0]) return profile[0];
  if (t >= profile[n - 1][0]) return profile[n - 1];
  for (let i = 0; i < n - 1; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    if (t <= b[0]) {
      let k = (t - a[0]) / (b[0] - a[0]);
      k = k * k * (3 - 2 * k); // smooth, so the silhouette has no corners
      return [
        t,
        a[1] + (b[1] - a[1]) * k,
        a[2] + (b[2] - a[2]) * k,
        a[3] + (b[3] - a[3]) * k,
      ];
    }
  }
  return profile[n - 1];
}

/**
 * Build one species' mesh: fusiform body of rings, dorsal and anal fins, a
 * forked caudal, and paired pectoral and pelvic fins. Snout sits at +z, the
 * tail runs to −z, all in metres.
 */
function buildFishGeometry(def) {
  const L = def.length;
  const half = L * 0.5;
  const pos = [];
  const feat = []; // (part, edge) — part 0 body, 1 median fin, 2 paired fin
  const idx = [];
  const P = def.profile;
  const e = def.section;
  const flat = def.bellyFlat;

  const push = (x, y, z, part, edge) => {
    pos.push(x, y, z);
    feat.push(part, edge);
    return pos.length / 3 - 1;
  };

  // ── body ────────────────────────────────────────────────────────────────
  const R = def.rings;
  const C = def.radial;
  const ringStart = [];
  for (let i = 0; i < R; i++) {
    // Bunch rings toward the head where the shape changes fastest.
    const t = Math.pow(i / (R - 1), 1.12);
    const sp = sampleProfile(P, t);
    const w = sp[1];
    const h = sp[2];
    const cy = sp[3];
    const z = half - t * L;
    ringStart.push(pos.length / 3);
    for (let j = 0; j < C; j++) {
      const a = (j / C) * TAU;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const x = Math.sign(ca) * Math.pow(Math.abs(ca), e) * w * L;
      let yy = Math.sign(sa) * Math.pow(Math.abs(sa), e) * h * L;
      if (sa < 0) yy *= 1 - flat * 0.55;
      push(x, cy * L + yy, z, 0, 0);
    }
  }
  for (let i = 0; i < R - 1; i++) {
    const a = ringStart[i];
    const b = ringStart[i + 1];
    for (let j = 0; j < C; j++) {
      const j2 = (j + 1) % C;
      idx.push(a + j, b + j, a + j2);
      idx.push(a + j2, b + j, b + j2);
    }
  }
  // snout cap
  {
    const tip = push(0, sampleProfile(P, 0)[3] * L, half + L * 0.012, 0, 0);
    const a = ringStart[0];
    for (let j = 0; j < C; j++) idx.push(tip, a + j, a + ((j + 1) % C));
  }
  // tail-base cap
  {
    const last = sampleProfile(P, 1);
    const capV = push(0, last[3] * L, half - L, 0, 0);
    const a = ringStart[R - 1];
    for (let j = 0; j < C; j++) idx.push(capV, a + ((j + 1) % C), a + j);
  }

  // ── median fins (dorsal, anal) ──────────────────────────────────────────
  const medianFin = (spec, sign) => {
    if (!spec) return;
    const seg = spec.seg;
    let prevRoot = -1;
    let prevTip = -1;
    for (let i = 0; i <= seg; i++) {
      const k = i / seg;
      const t = spec.t0 + (spec.t1 - spec.t0) * k;
      const smp = sampleProfile(P, t);
      const h = smp[2];
      const cy = smp[3];
      const z = half - t * L;
      const surf = cy * L + sign * h * L * (sign < 0 ? 1 - flat * 0.55 : 1);
      const hi = spec.h[Math.min(spec.h.length - 1, Math.round(k * (spec.h.length - 1)))] * L;
      const root = push(0, surf - sign * L * 0.004, z, 1, 0);
      const tip = push(0, surf + sign * hi, z - hi * 0.35, 1, 1);
      if (i > 0) {
        idx.push(prevRoot, prevTip, root);
        idx.push(root, prevTip, tip);
      }
      prevRoot = root;
      prevTip = tip;
    }
  };
  medianFin(def.dorsal, 1);
  medianFin(def.anal, -1);

  // ── caudal fin, forked ──────────────────────────────────────────────────
  {
    const cd = def.caudal;
    const last = sampleProfile(P, 1);
    const baseY = last[3] * L;
    const z0 = half - L;
    const len = cd.len * L;
    const lobe = cd.lobe * L;
    const notch = len * (1 - cd.fork * 0.62);
    const c = push(0, baseY, z0, 1, 0);
    const outline = [
      [z0 - len * 0.55, baseY + lobe * 0.55],
      [z0 - len, baseY + lobe],
      [z0 - notch, baseY + lobe * 0.12],
      [z0 - len, baseY - lobe],
      [z0 - len * 0.55, baseY - lobe * 0.55],
    ];
    const ids = outline.map((p, i) => push(0, p[1], p[0], 1, i === 2 ? 0.55 : 1.0));
    for (let i = 0; i < ids.length - 1; i++) idx.push(c, ids[i], ids[i + 1]);
  }

  // ── paired fins ─────────────────────────────────────────────────────────
  const pairedFin = (spec) => {
    if (!spec) return;
    const smp = sampleProfile(P, spec.t);
    const w = smp[1];
    const cy = smp[3];
    const z = half - spec.t * L;
    for (const s of [1, -1]) {
      const rx = s * w * L * 0.86;
      const ry = cy * L + spec.y * L;
      const a = push(rx, ry, z + L * 0.012, 2, 0);
      const b = push(rx, ry, z - L * 0.020, 2, 0);
      const c = push(rx + s * spec.len * L, ry - spec.drop * L, z - spec.sweep * L, 2, 1);
      const d = push(
        rx + s * spec.len * L * 0.72,
        ry - spec.drop * L * 1.5,
        z - spec.sweep * L * 1.75,
        2,
        1,
      );
      if (s > 0) {
        idx.push(a, c, b);
        idx.push(b, c, d);
      } else {
        idx.push(a, b, c);
        idx.push(b, d, c);
      }
    }
  };
  pairedFin(def.pectoral);
  pairedFin(def.pelvic);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aFeat', new THREE.Float32BufferAttribute(feat, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), L);
  g.userData.triangles = idx.length / 3;
  return g;
}

// ---------------------------------------------------------------------------
// shaders
// ---------------------------------------------------------------------------

const VERT = /* glsl */ `
attribute vec2 aFeat;      // x: 0 body 1 median fin 2 paired fin, y: root→tip
attribute vec3 aPos;
attribute vec3 aOrient;    // yaw, pitch, roll
attribute vec4 aAnim;      // phase, beatFreq, beatAmp, scale
attribute float aVar;

uniform float uTime;
uniform float uLen;
uniform float uHalf;
uniform float uWaveK;
uniform float uWaveAmp;
uniform float uWaveStart;

varying vec3 vLocal;
varying vec3 vN;
varying vec3 vWorld;
varying vec2 vFeat;
varying float vVar;

void main() {
  vec3 p = position;
  vec3 n = normal;

  // paired fins scull independently of the body wave
  if (aFeat.x > 1.5) {
    float w = uTime * (3.1 + aAnim.y * 2.2) + aAnim.x * 1.7;
    p.y += sin(w) * aFeat.y * uLen * 0.030;
    p.z += cos(w) * aFeat.y * uLen * 0.014;
  }

  // travelling wave down the body axis; amplitude grows toward the tail so the
  // caudal fin (whose a > 1) sweeps hardest.
  float a = (uHalf - p.z) / uLen;
  float t = max(a - uWaveStart, 0.0) / max(1e-3, 1.0 - uWaveStart);
  float amp = uWaveAmp * uLen * pow(max(t, 0.0), 1.7) * aAnim.z;
  float ph = uWaveK * a - uTime * aAnim.y * ${TAU.toFixed(6)} + aAnim.x;
  float lat = sin(ph) * amp;
  float dl = -cos(ph) * amp * uWaveK / uLen;   // d(lateral)/dz
  float th = atan(dl);
  float c = cos(th), s = sin(th);

  vec3 dp = vec3(p.x * c + lat, p.y, p.z - p.x * s);
  vec3 dn = vec3(n.x * c + n.z * s, n.y, -n.x * s + n.z * c);

  dp *= aAnim.w;

  float cy = cos(aOrient.x), sy = sin(aOrient.x);
  float cp = cos(aOrient.y), sp = sin(aOrient.y);
  float cr = cos(aOrient.z), sr = sin(aOrient.z);
  mat3 my = mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy);
  mat3 mx = mat3(1.0, 0.0, 0.0, 0.0, cp, sp, 0.0, -sp, cp);
  mat3 mz = mat3(cr, sr, 0.0, -sr, cr, 0.0, 0.0, 0.0, 1.0);
  mat3 R = my * mx * mz;

  vec4 wp = modelMatrix * vec4(aPos + R * dp, 1.0);
  vWorld = wp.xyz;
  vN = normalize(mat3(modelMatrix) * (R * dn));
  vLocal = p;
  vFeat = aFeat;
  vVar = aVar;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform vec3 uBack, uFlankC, uBelly, uMark, uFinC, uIris;
uniform vec4 uPat;        // barFreq, barAmt, mottleScale, mottleAmt
uniform vec3 uEye;        // z, y, radius (fractions of length)
uniform vec3 uGill;       // z (metres), slant, width (fraction of length)
uniform float uLine, uIrid, uGloss;
uniform float uLen, uHalf, uHalfW, uHalfH;

uniform vec3 uSunDir, uSunColor, uAmbient;
uniform float uSunVis;
uniform vec3 uCamPos;
uniform float uWaterLevel;
uniform vec3 uAbsorb, uWaterFill;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uCaustic;
uniform float uTime;

varying vec3 vLocal;
varying vec3 vN;
varying vec3 vWorld;
varying vec2 vFeat;
varying float vVar;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(uCamPos - vWorld);

  float up = clamp(vLocal.y / uHalfH, -1.0, 1.0);
  float flank = clamp(abs(vLocal.x) / uHalfW, 0.0, 1.0);
  float along = (uHalf - vLocal.z) / uLen;

  // counter-shading: dark back, luminous flank, pale belly
  vec3 col = mix(uBelly, uFlankC, smoothstep(-0.70, -0.05, up));
  col = mix(col, uBack, smoothstep(-0.06, 0.58, up));
  col *= 1.0 + (vVar - 0.5) * 0.20;

  // vertical barring (perch, faint on pike)
  float bar = sin(along * uPat.x * ${TAU.toFixed(6)} + vVar * 4.0);
  float barM = smoothstep(0.10, 0.85, bar) * uPat.y * smoothstep(-0.55, 0.30, up);
  col = mix(col, uMark, barM);

  // mottling (loach, pike)
  float m = vnoise(vec2(along * uPat.z, (up * 0.5 + 0.5) * uPat.z * 0.45 + vVar * 17.0));
  col = mix(col, uMark, smoothstep(0.52, 0.86, m) * uPat.w);

  // lateral line
  col *= 1.0 - 0.22 * uLine * (1.0 - smoothstep(0.0, 0.07, abs(up - 0.05)))
              * smoothstep(0.3, 0.7, flank) * step(0.12, along);

  // gill plate: a crease, dark behind, catching light in front
  float gd = (vLocal.z - uGill.x) + up * uGill.y * uLen;
  float gill = (1.0 - smoothstep(0.0, uGill.z * uLen, abs(gd))) * smoothstep(0.25, 0.6, flank);
  col *= 1.0 - gill * 0.20 * step(0.0, gd);
  float gillLit = gill * step(gd, 0.0);

  // fins: warmer, ray-striped, translucent at the tips
  if (vFeat.x > 0.5) {
    float rays = 0.5 + 0.5 * sin(along * 130.0 + vLocal.y * 240.0);
    vec3 fc = uFinC * (0.82 + 0.34 * rays);
    col = mix(col, fc, 0.72);
    col = mix(col, uWaterFill * 1.4, vFeat.y * 0.42);
  }

  // eye with a catchlight
  vec2 ep = vec2(vLocal.z - uEye.x * uLen, vLocal.y - uEye.y * uLen) / (uEye.z * uLen);
  float ed = length(ep);
  float eyeM = (1.0 - smoothstep(0.82, 1.02, ed)) * smoothstep(0.20, 0.5, flank)
             * step(vFeat.x, 0.5);
  vec3 eyeCol = mix(vec3(0.015, 0.014, 0.018), uIris, smoothstep(0.30, 0.66, ed));
  col = mix(col, eyeCol, eyeM);
  float spark = (1.0 - smoothstep(0.14, 0.30, length(ep - vec2(0.28, 0.30)))) * eyeM;

  // iridescent flank sheen
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  vec3 irid = 0.5 + 0.5 * cos(${TAU.toFixed(6)} * (vec3(0.0, 0.30, 0.58) + fres * 1.25 + vVar * 0.8 + along * 0.35));
  col = mix(col, col * 0.45 + irid * 0.7, uIrid * flank * (0.28 + 0.72 * fres) * step(vFeat.x, 0.5));

  // lighting: wrapped sun + sky ambient, plus a hard mirror lobe for the flash
  vec3 L = normalize(uSunDir);
  float ndl = dot(N, L);
  float wrap = clamp((ndl + 0.38) / 1.38, 0.0, 1.0);
  vec3 H = normalize(L + V);
  float nh = max(dot(N, H), 0.0);
  float spec = pow(nh, 46.0) * uGloss;
  float flash = pow(nh, 220.0) * uGloss * flank * 2.2;
  vec3 amb = uAmbient * (0.5 + 0.5 * (N.y * 0.5 + 0.5));
  vec3 lit = col * (uSunColor * wrap * uSunVis + amb);
  lit += uSunColor * (spec * (0.35 + flank * 0.9) + flash) * uSunVis * (0.4 + 0.6 * flank);
  lit += uSunColor * gillLit * 0.25 * uSunVis;

  // caustic banding crawling over the back
  float dw = max(0.0, uWaterLevel - vWorld.y);
  vec2 cp = vWorld.xz * 0.85 + vec2(uTime * 0.10, uTime * 0.07);
  float ca = abs(sin(cp.x * 1.7 + sin(cp.y * 1.3 + uTime * 0.4)))
           + abs(sin(cp.y * 1.9 + sin(cp.x * 1.1 - uTime * 0.3)));
  ca = pow(max(0.0, 1.0 - ca * 0.52), 3.0);
  lit += uSunColor * ca * uCaustic * max(0.0, N.y) * exp(-dw * 0.30) * uSunVis;

  // water absorption along the light path + in-scattered water colour
  float travel = dw + distance(uCamPos, vWorld) * 0.7;
  vec3 tr = exp(-uAbsorb * travel);
  lit = lit * tr + uWaterFill * (1.0 - tr) * (0.35 + 0.65 * uSunVis);

  lit += spark * uSunColor * 1.9;

  // scene fog, matching whatever the sky/underwater system has set
  float fd = length(uCamPos - vWorld);
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * fd * fd);
  lit = mix(lit, uFogColor, clamp(fog, 0.0, 1.0));

  gl_FragColor = vec4(lit, 1.0);
}
`;

// ---------------------------------------------------------------------------

export class FishSchools {
  constructor(ctx) {
    this.ctx = ctx;
    this.river = ctx.river;
    this.rand = makeRandom(0x1c7fa11);
    this.group = new THREE.Group();
    this.group.name = 'fish';

    this.species = [];
    this.shoals = [];
    this.activeShoals = [];
    this.spawnRate = 1;
    this.population = 0;
    this._time = 0;
    this._frame = 0;
    this._scanTimer = 0;
    this._riseCooldown = 1.5;
    this._emitting = false;

    // scratch — nothing in update() allocates
    this._v = new THREE.Vector3();
    this._flow = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._rc = { s: 0, u: 0, distance: 0 };
    this._rc2 = { s: 0, u: 0, distance: 0 };
    this._playerPos = new THREE.Vector3(0, -999, 0);
    this._playerSpeed = 0;
    this._playerSub = false;
    this._eventPos = new THREE.Vector3();
    this._sunDir = new THREE.Vector3(0.3, 0.8, 0.4);
    this._offs = [];
  }

  // ── boot ────────────────────────────────────────────────────────────────

  async init() {
    const ctx = this.ctx;
    const tier = ctx.settings?.quality ?? {};
    const scale = THREE.MathUtils.clamp((tier.fishCount ?? 72) / 72, 0.3, 1.2);
    this.renderRange = 62;
    this.activeRange = 88;

    for (const def of SPECIES_DEFS) {
      const cap = Math.max(2, Math.round(def.cap * scale));
      this.species.push(this._buildSpecies(def, cap));
    }
    this._placeShoals();

    ctx.scene.add(this.group);

    const ev = ctx.events;
    const E = ctx.EVENTS;
    this._offs.push(
      ev.on(E.DIVE, (p) => {
        if (p?.position) this.startle(p.position, 7.0, 0.85);
      }),
    );
    this._offs.push(
      ev.on(E.SPLASH, (p) => {
        if (this._emitting || !p?.position) return;
        const s = p.strength ?? 0.5;
        if (s < 0.45) return;
        this.startle(p.position, 3.0 + s * 4.0, Math.min(1, s * 0.8));
      }),
    );

    this.speciesInfo = this.species.map((sp) => ({
      key: sp.def.key,
      name: sp.def.name,
      color: `#${new THREE.Color().copy(sp.uniforms.uFlankC.value).getHexString()}`,
      length: sp.def.length,
    }));
    this.triangleCost = this.species.reduce(
      (a, sp) => a + sp.geo.userData.triangles * sp.cap,
      0,
    );
  }

  _buildSpecies(def, cap) {
    const geo = buildFishGeometry(def);
    const inst = new THREE.InstancedBufferGeometry();
    inst.index = geo.index;
    inst.attributes.position = geo.attributes.position;
    inst.attributes.normal = geo.attributes.normal;
    inst.attributes.aFeat = geo.attributes.aFeat;
    inst.instanceCount = 0;

    const aPos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const aOrient = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const aAnim = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    const aVar = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    for (const a of [aPos, aOrient, aAnim, aVar]) a.setUsage(THREE.DynamicDrawUsage);
    inst.setAttribute('aPos', aPos);
    inst.setAttribute('aOrient', aOrient);
    inst.setAttribute('aAnim', aAnim);
    inst.setAttribute('aVar', aVar);
    inst.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    let maxW = 0.001;
    let maxH = 0.001;
    for (const p of def.profile) {
      maxW = Math.max(maxW, p[1]);
      maxH = Math.max(maxH, p[2]);
    }

    const uniforms = {
      uTime: { value: 0 },
      uLen: { value: def.length },
      uHalf: { value: def.length * 0.5 },
      uHalfW: { value: maxW * def.length },
      uHalfH: { value: maxH * def.length },
      uWaveK: { value: def.waveK },
      uWaveAmp: { value: def.waveAmp },
      uWaveStart: { value: def.waveStart },
      uBack: { value: new THREE.Color(def.back) },
      uFlankC: { value: new THREE.Color(def.flank) },
      uBelly: { value: new THREE.Color(def.belly) },
      uMark: { value: new THREE.Color(def.mark) },
      uFinC: { value: new THREE.Color(def.fin) },
      uIris: { value: new THREE.Color(def.eye.iris) },
      uPat: { value: new THREE.Vector4(...def.pattern) },
      uEye: { value: new THREE.Vector3(def.eye.z, def.eye.y, def.eye.r) },
      uGill: { value: new THREE.Vector3(def.gill.z * def.length, def.gill.slant, def.gill.w) },
      uLine: { value: def.line },
      uIrid: { value: def.irid },
      uGloss: { value: def.gloss },
      uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.4) },
      uSunColor: { value: new THREE.Color(1.0, 0.94, 0.82) },
      uAmbient: { value: new THREE.Color(0.28, 0.36, 0.42) },
      uSunVis: { value: 1 },
      uCamPos: { value: new THREE.Vector3() },
      uWaterLevel: { value: this.ctx.WATER_LEVEL ?? 0 },
      uAbsorb: { value: new THREE.Vector3(0.38, 0.145, 0.105) },
      uWaterFill: { value: new THREE.Color(0.055, 0.145, 0.145) },
      uFogColor: { value: new THREE.Color(0.62, 0.72, 0.78) },
      uFogDensity: { value: 0.0024 },
      uCaustic: { value: 0.55 },
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(inst, mat);
    mesh.name = `fish-${def.key}`;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.visible = false;
    this.group.add(mesh);

    const f32 = () => new Float32Array(cap);
    return {
      def,
      cap,
      mesh,
      geo,
      inst,
      mat,
      uniforms,
      aPos,
      aOrient,
      aAnim,
      aVar,
      px: f32(), py: f32(), pz: f32(),
      vx: f32(), vy: f32(), vz: f32(),
      yaw: f32(), pitch: f32(), roll: f32(), prevYaw: f32(),
      phase: f32(), scale: f32(), cvar: f32(),
      burst: f32(), bfx: f32(), bfz: f32(),
      beatT: f32(), beatAmp: f32(), beatF: f32(),
      bed: f32(), riseT: f32(), stateT: f32(),
      alive: new Uint8Array(cap),
      state: new Uint8Array(cap), // 0 cruise 1 flee 2 rise 3 caught
      shoal: new Int16Array(cap).fill(-1),
      free: Array.from({ length: cap }, (_, i) => cap - 1 - i),
      live: 0,
      drawn: 0,
    };
  }

  /**
   * Shoals are anchored to river stations. Pools get more and bigger ones,
   * scaled by the pool's own fishDensity, so diving in a pool is rewarded.
   */
  _placeShoals() {
    const river = this.river;
    const rnd = this.rand;
    const len = river.length;
    let id = 0;
    for (let s = 30; s < len - 30; s += 26 + rnd() * 16) {
      const pool = river.poolNear(s);
      const inPool = pool && Math.abs(pool.s - s) < pool.radius * 1.6;
      const dens = inPool ? pool.fishDensity : 0.55;
      const add = (spIdx, chance, sizeMul = 1) => {
        if (rnd() > chance * (0.55 + dens * 0.75)) return;
        const sp = this.species[spIdx];
        const d = sp.def;
        const size = Math.round(
          (d.shoalSize[0] + rnd() * (d.shoalSize[1] - d.shoalSize[0])) *
            sizeMul *
            (0.7 + dens * 0.5),
        );
        const side = rnd() < 0.5 ? -1 : 1;
        const u =
          d.uBand[0] === 0
            ? (rnd() - 0.5) * 2 * d.uBand[1]
            : side * (d.uBand[0] + rnd() * (d.uBand[1] - d.uBand[0]));
        const ss = THREE.MathUtils.clamp(s + (rnd() - 0.5) * 26, 12, len - 12);
        const centre = river.toWorld(ss, u, 0, new THREE.Vector3());
        this.shoals.push({
          id: id++,
          spIdx,
          s: ss,
          u,
          size: Math.max(1, size),
          radius: 0.8 + size * 0.11 + rnd() * 1.4,
          cx: centre.x,
          cz: centre.z,
          active: false,
          members: [],
          respawn: 0,
        });
      };
      add(0, 0.85, 1.0); // minnow
      if (inPool) add(0, 0.55, 0.85);
      add(1, 0.5); // perch
      add(3, 0.45); // loach
      add(2, 0.16); // pike
    }
    this.population = this.shoals.reduce((a, s) => a + s.size, 0);
  }

  // ── activation ──────────────────────────────────────────────────────────

  _rescan() {
    const cam = this._camPos;
    const act = this.activeShoals;
    act.length = 0;
    const r2 = this.activeRange * this.activeRange;
    for (const sh of this.shoals) {
      const dx = sh.cx - cam.x;
      const dz = sh.cz - cam.z;
      const near = dx * dx + dz * dz < r2;
      if (near && !sh.active) this._activate(sh);
      else if (!near && sh.active) this._deactivate(sh);
      if (sh.active) act.push(sh);
    }
  }

  _activate(sh) {
    const sp = this.species[sh.spIdx];
    const want = Math.round(sh.size * this.spawnRate);
    if (want < 1) {
      // spawn rate turned right down: hold the shoal open but empty
      sh.active = true;
      sh.members.length = 0;
      sh.respawn = 1e9;
      return;
    }
    const river = this.river;
    const rnd = this.rand;
    sh.active = true;
    sh.members.length = 0;
    const bedC = river.bedHeight(sh.s, sh.u);
    for (let n = 0; n < want; n++) {
      const i = sp.free.pop();
      if (i === undefined) break;
      const ang = rnd() * TAU;
      const rad = Math.sqrt(rnd()) * sh.radius;
      sp.px[i] = sh.cx + Math.cos(ang) * rad;
      sp.pz[i] = sh.cz + Math.sin(ang) * rad;
      sp.py[i] = this._preferredY(sp.def, sh.s, sh.u, bedC, rnd());
      sp.vx[i] = (rnd() - 0.5) * 0.2;
      sp.vy[i] = 0;
      sp.vz[i] = (rnd() - 0.5) * 0.2;
      sp.yaw[i] = rnd() * TAU;
      sp.prevYaw[i] = sp.yaw[i];
      sp.pitch[i] = 0;
      sp.roll[i] = 0;
      sp.phase[i] = rnd() * TAU;
      sp.scale[i] = 0.78 + rnd() * 0.5;
      sp.cvar[i] = rnd();
      sp.burst[i] = 0;
      sp.bfx[i] = 0;
      sp.bfz[i] = 1;
      sp.beatT[i] = rnd() * 2;
      sp.beatAmp[i] = 1;
      sp.beatF[i] = sp.def.beat;
      sp.bed[i] = bedC;
      sp.riseT[i] = 4 + rnd() * 18;
      sp.state[i] = 0;
      sp.stateT[i] = 0;
      sp.alive[i] = 1;
      sp.shoal[i] = sh.id;
      sp.live++;
      sh.members.push(i);
    }
  }

  _deactivate(sh) {
    const sp = this.species[sh.spIdx];
    for (const i of sh.members) {
      if (!sp.alive[i]) continue;
      sp.alive[i] = 0;
      sp.shoal[i] = -1;
      sp.free.push(i);
      sp.live--;
    }
    sh.members.length = 0;
    sh.active = false;
  }

  _preferredY(def, s, u, bedY, r) {
    const level = this.ctx.WATER_LEVEL ?? 0;
    if (def.bedHugger) return Math.min(bedY + 0.05 + r * 0.14, level - 0.12);
    const d0 = def.depthBand[0];
    const d1 = def.depthBand[1];
    let y = level - (d0 + r * (d1 - d0));
    const floor = bedY + 0.12;
    if (y < floor) y = floor + r * 0.1;
    return Math.min(y, level - 0.12);
  }

  // ── per frame ───────────────────────────────────────────────────────────

  update(dt, elapsed) {
    if (dt <= 0) return;
    const ctx = this.ctx;
    this._time = elapsed;
    this._frame++;
    const cam = ctx.engine?.camera ?? ctx.camera;
    if (cam?.isCamera) this._camPos.setFromMatrixPosition(cam.matrixWorld);

    const player = ctx.get?.('player');
    if (player?.position) {
      this._playerPos.copy(player.position);
      this._playerSpeed = player.speed ?? 0;
      this._playerSub = !!player.submerged;
    }

    this._scanTimer -= dt;
    if (this._scanTimer <= 0) {
      this._scanTimer = 0.35;
      this._rescan();
    }

    this._riseCooldown -= dt;

    for (let k = 0; k < this.activeShoals.length; k++) {
      this._simulateShoal(this.activeShoals[k], dt);
    }
    this._pack();
    this._updateUniforms(elapsed);
  }

  _simulateShoal(sh, dt) {
    const sp = this.species[sh.spIdx];
    const def = sp.def;
    const river = this.river;
    const level = this.ctx.WATER_LEVEL ?? 0;
    const members = sh.members;
    const m = members.length;
    if (!m) {
      sh.respawn -= dt;
      if (sh.respawn <= 0) {
        sh.respawn = 6;
        this._deactivate(sh);
        this._activate(sh);
      }
      return;
    }

    // one flow sample per shoal: the field is smooth at shoal scale
    river.flowAt(sh.s, sh.u, this._flow);
    const flowX = this._flow.x;
    const flowZ = this._flow.z;
    const fmag = Math.hypot(flowX, flowZ) || 1e-3;
    const fdx = flowX / fmag;
    const fdz = flowZ / fmag;
    river.right(sh.s, this._right);
    const rx = this._right.x;
    const rz = this._right.z;

    const sep2 = def.sep * def.sep;
    const per2 = def.perceive * def.perceive;
    const cruise = def.cruise;
    const px = sp.px, py = sp.py, pz = sp.pz;
    const vx = sp.vx, vy = sp.vy, vz = sp.vz;

    // Startle propagation runs on last frame's burst values, so a scare walks
    // outward through the shoal one neighbour per frame — visibly a wave.
    for (let k = 0; k < m; k++) {
      const i = members[k];
      if (!sp.alive[i] || sp.burst[i] < 0.35) continue;
      for (let k2 = 0; k2 < m; k2++) {
        const j = members[k2];
        if (j === i || !sp.alive[j]) continue;
        if (sp.burst[j] >= sp.burst[i] * 0.8) continue;
        const dx = px[j] - px[i];
        const dy = py[j] - py[i];
        const dz = pz[j] - pz[i];
        if (dx * dx + dy * dy + dz * dz > per2 * 1.6) continue;
        sp.burst[j] = Math.max(sp.burst[j], sp.burst[i] * 0.86);
        sp.bfx[j] = sp.bfx[i];
        sp.bfz[j] = sp.bfz[i];
        sp.state[j] = 1;
      }
    }

    const playerX = this._playerPos.x;
    const playerY = this._playerPos.y;
    const playerZ = this._playerPos.z;
    const charging = this._playerSpeed > 2.4;

    for (let k = 0; k < m; k++) {
      const i = members[k];
      if (!sp.alive[i]) continue;

      // caught fish thrash where they were taken, then vanish
      if (sp.state[i] === 3) {
        sp.stateT[i] -= dt;
        sp.roll[i] = Math.sin(this._time * 34 + sp.phase[i]) * 1.4;
        sp.beatAmp[i] = 2.4;
        sp.beatF[i] = def.beat * 3.6;
        py[i] += dt * 0.35;
        if (sp.stateT[i] <= 0) {
          this._despawn(sp, sh, i);
          k--;
        }
        continue;
      }

      // refresh the bed height on a stagger — it is the expensive query
      if (((this._frame + i) & 7) === 0) {
        this._v.set(px[i], 0, pz[i]);
        river.toRiver(this._v, this._rc2);
        sp.bed[i] = river.bedHeight(this._rc2.s, this._rc2.u);
      }

      this._v.set(px[i], 0, pz[i]);
      const rc = river.toRiver(this._v, this._rc);

      let ax = 0;
      let ay = 0;
      let az = 0;

      // --- flock ------------------------------------------------------------
      if (!def.solitary) {
        let sx = 0, sy = 0, sz = 0, sc = 0;
        let alx = 0, aly = 0, alz = 0, ac = 0;
        let cx = 0, cy = 0, cz = 0, cc = 0;
        for (let k2 = 0; k2 < m; k2++) {
          const j = members[k2];
          if (j === i || !sp.alive[j] || sp.state[j] === 3) continue;
          const dx = px[j] - px[i];
          const dy = py[j] - py[i];
          const dz = pz[j] - pz[i];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > per2 || d2 < 1e-8) continue;
          if (d2 < sep2) {
            const w = ((sep2 - d2) / sep2) / Math.sqrt(d2);
            sx -= dx * w; sy -= dy * w; sz -= dz * w; sc++;
          }
          alx += vx[j]; aly += vy[j]; alz += vz[j]; ac++;
          cx += dx; cy += dy; cz += dz; cc++;
        }
        if (sc) {
          ax += sx * def.wSep * 2.2;
          ay += sy * def.wSep * 1.4;
          az += sz * def.wSep * 2.2;
        }
        if (ac) {
          ax += (alx / ac - vx[i]) * def.wAli;
          ay += (aly / ac - vy[i]) * def.wAli * 0.6;
          az += (alz / ac - vz[i]) * def.wAli;
        }
        if (cc) {
          ax += (cx / cc) * def.wCoh;
          ay += (cy / cc) * def.wCoh * 0.7;
          az += (cz / cc) * def.wCoh;
        }
      }

      // --- hold station facing upstream, in the water's frame ---------------
      // The fish wants a small velocity relative to the water, pointing
      // upstream. Add the flow back and its world velocity is near zero.
      // Holding station means swimming upstream at exactly the speed of the
      // water, so the tail works hard while the fish goes nowhere. The gain is
      // compensated for the drag below, or the steady state falls short and
      // the whole shoal washes downstream.
      const wobble = Math.sin(this._time * 0.7 + sp.phase[i] * 3.1);
      const hold = fmag * (0.92 + sp.cvar[i] * 0.16);
      const comp = (5.0 + 1.6) / 5.0;
      const desiredRelX = (-fdx * hold + rx * wobble * cruise * 0.5) * comp;
      const desiredRelZ = (-fdz * hold + rz * wobble * cruise * 0.5) * comp;
      ax += (desiredRelX - (vx[i] - flowX)) * 5.0;
      az += (desiredRelZ - (vz[i] - flowZ)) * 5.0;

      // --- home spring: shoals hold their lie --------------------------------
      const hx = sh.cx - px[i];
      const hz = sh.cz - pz[i];
      const hd = Math.hypot(hx, hz);
      if (hd > sh.radius) {
        const w = Math.min(2.5, (hd - sh.radius) * 0.9);
        ax += (hx / hd) * w;
        az += (hz / hd) * w;
      }

      // --- channel + depth band ---------------------------------------------
      const au = Math.abs(rc.u);
      if (au > 0.86) {
        const push = (au - 0.86) * 9;
        ax -= Math.sign(rc.u) * rx * push;
        az -= Math.sign(rc.u) * rz * push;
      }
      const bedY = sp.bed[i];
      if (sp.state[i] === 2) {
        // rising to take something off the surface
        ay += (level - 0.045 - py[i]) * 5.0;
        sp.riseT[i] -= dt;
        if (py[i] > level - 0.075 || sp.riseT[i] < 0) this._completeRise(sp, i, level);
      } else {
        const targetY = this._preferredY(def, rc.s, rc.u, bedY, (sp.cvar[i] + 0.15) % 1);
        ay += (targetY - py[i]) * (def.bedHugger ? 4.5 : 1.9);
      }
      const floorY = bedY + (def.bedHugger ? 0.03 : 0.1);
      if (py[i] < floorY) ay += (floorY - py[i]) * 26;
      const ceilY = level - 0.06;
      if (py[i] > ceilY && sp.state[i] !== 2) ay += (ceilY - py[i]) * 30;

      // --- shelter: hold the species' preferred lane across the channel ------
      if (def.uBand[0] > 0) {
        const want = def.uBand[0] + (def.uBand[1] - def.uBand[0]) * 0.5;
        const side = rc.u >= 0 ? 1 : -1;
        const err = side * want - rc.u;
        ax += rx * err * 0.8;
        az += rz * err * 0.8;
      }

      // --- the duck ----------------------------------------------------------
      const ddx = px[i] - playerX;
      const ddy = py[i] - playerY;
      const ddz = pz[i] - playerZ;
      const dd2 = ddx * ddx + ddy * ddy + ddz * ddz;
      const scareR = charging ? 3.4 : 1.15;
      if (dd2 < scareR * scareR) {
        const dd = Math.sqrt(dd2) || 1e-3;
        const w = (scareR - dd) / scareR;
        ax += (ddx / dd) * w * 6.0;
        ay += (ddy / dd) * w * 3.0;
        az += (ddz / dd) * w * 6.0;
        if (charging && sp.burst[i] < w) {
          sp.burst[i] = Math.min(1, w * 1.2);
          sp.bfx[i] = ddx / dd;
          sp.bfz[i] = ddz / dd;
          sp.state[i] = 1;
        }
      }

      // --- burst -------------------------------------------------------------
      let relMax = Math.max(cruise * 1.7, fmag * 1.55);
      const bu = sp.burst[i];
      if (bu > 0.01) {
        ax += sp.bfx[i] * bu * 26;
        az += sp.bfz[i] * bu * 26;
        ay -= bu * 2.0; // fish flee downward as well as away
        relMax = def.burstSpeed * (0.5 + bu);
        sp.burst[i] = Math.max(0, bu - dt * (0.65 + bu * 0.5));
        if (sp.burst[i] <= 0.01 && sp.state[i] === 1) sp.state[i] = 0;
      }

      // --- integrate ---------------------------------------------------------
      vx[i] += ax * dt;
      vy[i] += ay * dt;
      vz[i] += az * dt;
      const drag = Math.exp(-dt * (1.6 + bu * 0.8));
      let rvx = (vx[i] - flowX) * drag;
      let rvy = vy[i] * drag;
      let rvz = (vz[i] - flowZ) * drag;
      const rspd = Math.hypot(rvx, rvy, rvz);
      if (rspd > relMax) {
        const kk = relMax / rspd;
        rvx *= kk; rvy *= kk; rvz *= kk;
      }
      vx[i] = rvx + flowX;
      vy[i] = rvy;
      vz[i] = rvz + flowZ;
      px[i] += vx[i] * dt;
      py[i] += vy[i] * dt;
      pz[i] += vz[i] * dt;

      // --- orientation: face through the WATER, not over the ground ----------
      const rs = Math.hypot(rvx, rvy, rvz);
      if (rs > 0.02) {
        const tYaw = Math.atan2(rvx, rvz);
        const tPitch = -Math.asin(THREE.MathUtils.clamp(rvy / rs, -1, 1));
        let dyaw = tYaw - sp.yaw[i];
        while (dyaw > Math.PI) dyaw -= TAU;
        while (dyaw < -Math.PI) dyaw += TAU;
        sp.yaw[i] += dyaw * Math.min(1, dt * def.turn * (1 + bu * 2));
        sp.pitch[i] += (tPitch - sp.pitch[i]) * Math.min(1, dt * 4);
      }
      let turnRate = sp.yaw[i] - sp.prevYaw[i];
      while (turnRate > Math.PI) turnRate -= TAU;
      while (turnRate < -Math.PI) turnRate += TAU;
      sp.prevYaw[i] = sp.yaw[i];
      const bank = THREE.MathUtils.clamp((turnRate / Math.max(dt, 1e-3)) * 0.2, -0.9, 0.9);
      sp.roll[i] += (bank - sp.roll[i]) * Math.min(1, dt * 6);

      // --- burst-and-glide + the occasional flank flash -----------------------
      sp.beatT[i] -= dt;
      if (sp.beatT[i] <= 0) {
        if (sp.beatAmp[i] > 0.7) {
          sp.beatAmp[i] = 0.16 + sp.cvar[i] * 0.14; // glide
          sp.beatT[i] = 0.35 + sp.cvar[i] * 0.7;
        } else {
          sp.beatAmp[i] = 0.85 + sp.cvar[i] * 0.4; // beat
          sp.beatT[i] = 0.5 + sp.cvar[i] * 0.9;
          // a flick of the flank rolls the silver into the sun
          if (this.rand() < 0.14) sp.roll[i] += (this.rand() - 0.5) * 1.6;
        }
      }
      sp.beatF[i] = def.beat * (0.45 + Math.min(2.6, (rs / Math.max(cruise, 0.05)) * 0.55) + bu * 1.6);
      if (bu > 0.05) sp.beatAmp[i] = Math.max(sp.beatAmp[i], 0.9 + bu * 1.1);

      // --- rises ---------------------------------------------------------------
      if (def.rises > 0 && sp.state[i] === 0) {
        sp.riseT[i] -= dt;
        if (sp.riseT[i] <= 0 && bu < 0.05) {
          const dcx = px[i] - this._camPos.x;
          const dcz = pz[i] - this._camPos.z;
          if (this._riseCooldown <= 0 && au < 0.9 && dcx * dcx + dcz * dcz < 1400) {
            sp.state[i] = 2;
            sp.riseT[i] = 2.2;
            this._riseCooldown = 1.1 + this.rand() * 2.4;
          } else {
            sp.riseT[i] = 5 + this.rand() * 14;
          }
        }
      }
    }
  }

  _completeRise(sp, i, level) {
    const def = sp.def;
    sp.state[i] = 0;
    sp.riseT[i] = 8 + this.rand() * 20;
    sp.vy[i] = -0.35;
    sp.beatAmp[i] = 1.6;
    if (sp.py[i] > level - 0.12) {
      const water = this.ctx.get?.('water');
      water?.addRipple?.(sp.px[i], sp.pz[i], 0.055 + def.length * 0.12, 0.7 + def.length * 3.0);
      this._eventPos.set(sp.px[i], level, sp.pz[i]);
      this._emitting = true;
      this.ctx.events.emit(this.ctx.EVENTS.SPLASH, {
        position: this._eventPos,
        strength: 0.16 + def.length * 0.3,
      });
      this.ctx.events.emit(this.ctx.EVENTS.SFX, {
        name: 'fish-rise',
        position: this._eventPos,
        volume: 0.35,
      });
      this._emitting = false;
    }
  }

  _despawn(sp, sh, i) {
    if (!sp.alive[i]) return;
    sp.alive[i] = 0;
    sp.shoal[i] = -1;
    sp.free.push(i);
    sp.live--;
    const k = sh.members.indexOf(i);
    if (k >= 0) sh.members.splice(k, 1);
  }

  // ── rendering ───────────────────────────────────────────────────────────

  _pack() {
    const camX = this._camPos.x;
    const camY = this._camPos.y;
    const camZ = this._camPos.z;
    for (const sp of this.species) {
      // Each species disappears at the range where it stops being a shape and
      // starts being a speck — a sub-pixel minnow is just aliasing noise.
      const far = Math.min(this.renderRange, sp.def.viewRange ?? this.renderRange);
      const far2 = far * far;
      const fadeStart = (far * 0.72) * (far * 0.72);
      const P = sp.aPos.array;
      const O = sp.aOrient.array;
      const A = sp.aAnim.array;
      const V = sp.aVar.array;
      let n = 0;
      for (let i = 0; i < sp.cap; i++) {
        if (!sp.alive[i]) continue;
        const dx = sp.px[i] - camX;
        const dy = sp.py[i] - camY;
        const dz = sp.pz[i] - camZ;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > far2) continue;
        const fade = d2 > fadeStart ? 1 - (d2 - fadeStart) / (far2 - fadeStart) : 1;
        const o3 = n * 3;
        P[o3] = sp.px[i];
        P[o3 + 1] = sp.py[i];
        P[o3 + 2] = sp.pz[i];
        O[o3] = sp.yaw[i];
        O[o3 + 1] = sp.pitch[i];
        O[o3 + 2] = sp.roll[i];
        const o4 = n * 4;
        A[o4] = sp.phase[i];
        A[o4 + 1] = sp.beatF[i];
        A[o4 + 2] = sp.beatAmp[i];
        A[o4 + 3] = sp.scale[i] * fade;
        V[n] = sp.cvar[i];
        n++;
      }
      sp.inst.instanceCount = n;
      sp.mesh.visible = n > 0;
      if (n > 0) {
        sp.aPos.needsUpdate = true;
        sp.aOrient.needsUpdate = true;
        sp.aAnim.needsUpdate = true;
        sp.aVar.needsUpdate = true;
      }
      sp.drawn = n;
    }
  }

  _updateUniforms(elapsed) {
    const ctx = this.ctx;
    const sky = ctx.get?.('sky');
    const fog = ctx.scene.fog;
    let sunVis = 1;
    if (sky?.sunDirection) {
      this._sunDir.copy(sky.sunDirection);
      sunVis = THREE.MathUtils.clamp(this._sunDir.y * 2.4 + 0.28, 0.14, 1.25);
    }
    for (const sp of this.species) {
      const u = sp.uniforms;
      u.uTime.value = elapsed;
      u.uCamPos.value.copy(this._camPos);
      u.uSunDir.value.copy(this._sunDir);
      if (sky?.sunColor) u.uSunColor.value.copy(sky.sunColor);
      if (sky?.ambientColor) u.uAmbient.value.copy(sky.ambientColor);
      u.uSunVis.value = sunVis;
      if (fog?.color) {
        u.uFogColor.value.copy(fog.color);
        u.uFogDensity.value = fog.density ?? 0.0024;
      } else {
        u.uFogDensity.value = 0.0;
      }
    }
  }

  // ── public API ──────────────────────────────────────────────────────────

  get count() {
    let n = 0;
    for (const sp of this.species) n += sp.live;
    return n;
  }

  get drawnCount() {
    let n = 0;
    for (const sp of this.species) n += sp.drawn;
    return n;
  }

  /** 0..2 multiplier on shoal sizes; re-seeds whatever is currently active. */
  setSpawnRate(x) {
    this.spawnRate = THREE.MathUtils.clamp(x, 0, 2);
    for (const sh of this.shoals) {
      if (!sh.active) continue;
      this._deactivate(sh);
      this._activate(sh);
    }
  }

  /** Scatter everything inside `radius`, carrying the flee direction outward. */
  startle(position, radius = 5, strength = 0.8) {
    const r2 = radius * radius;
    for (const sh of this.activeShoals) {
      const sp = this.species[sh.spIdx];
      for (const i of sh.members) {
        if (!sp.alive[i] || sp.state[i] === 3) continue;
        const dx = sp.px[i] - position.x;
        const dy = sp.py[i] - position.y;
        const dz = sp.pz[i] - position.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        const d = Math.sqrt(d2) || 1e-3;
        const w = (1 - d / radius) * strength * (0.7 + sp.def.wariness * 0.6);
        if (w <= sp.burst[i]) continue;
        sp.burst[i] = Math.min(1.2, w);
        sp.bfx[i] = dx / d;
        sp.bfz[i] = dz / d;
        sp.state[i] = 1;
        sp.beatAmp[i] = 2.0;
      }
    }
  }

  /** Nearest living fish to a point. Returns a descriptor or null. */
  nearest(position, maxDist = 6) {
    let bestSp = null;
    let bestI = -1;
    let bestD = maxDist * maxDist;
    for (const sh of this.activeShoals) {
      const sp = this.species[sh.spIdx];
      for (const i of sh.members) {
        if (!sp.alive[i] || sp.state[i] === 3) continue;
        const dx = sp.px[i] - position.x;
        const dy = sp.py[i] - position.y;
        const dz = sp.pz[i] - position.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD) {
          bestD = d2;
          bestSp = sp;
          bestI = i;
        }
      }
    }
    return bestSp ? this._describe(bestSp, bestI, Math.sqrt(bestD)) : null;
  }

  /**
   * Try to take a fish. Startled fish are far harder to hold: charge a shoal
   * and you get a faceful of bubbles, drift in and you get lunch.
   */
  tryCatch(position, radius = 0.45) {
    let bestSp = null;
    let bestSh = null;
    let bestI = -1;
    let bestD = radius * radius;
    for (const sh of this.activeShoals) {
      const sp = this.species[sh.spIdx];
      for (const i of sh.members) {
        if (!sp.alive[i] || sp.state[i] === 3) continue;
        const dx = sp.px[i] - position.x;
        const dy = sp.py[i] - position.y;
        const dz = sp.pz[i] - position.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD) {
          bestD = d2;
          bestSp = sp;
          bestSh = sh;
          bestI = i;
        }
      }
    }
    if (!bestSp) return null;

    const sp = bestSp;
    const i = bestI;
    const def = sp.def;
    const dist = Math.sqrt(bestD);
    const desc = this._describe(sp, i, dist);
    const alarmed = sp.burst[i] > 0.3 ? 0.55 : 0;
    const chance = THREE.MathUtils.clamp(
      0.92 - def.wariness * 0.45 - alarmed - (dist / radius) * 0.25,
      0.05,
      0.95,
    );
    const E = this.ctx.EVENTS;
    const ev = this.ctx.events;

    if (this.rand() > chance) {
      // a miss: it bolts and takes its neighbours with it
      this._eventPos.set(sp.px[i], sp.py[i], sp.pz[i]);
      this.startle(this._eventPos, 3.2, 1.0);
      ev.emit(E.FISH_ESCAPED, { fish: desc, position: desc.position, species: def.key });
      ev.emit(E.BUBBLES, { position: desc.position, count: 6, spread: 0.18 });
      ev.emit(E.SFX, { name: 'fish-escape', position: desc.position, volume: 0.4 });
      return null;
    }

    // caught: a brief thrash where it was taken, bubbles, then gone
    sp.state[i] = 3;
    sp.stateT[i] = 0.42;
    sp.burst[i] = 0;
    ev.emit(E.FISH_CAUGHT, { fish: desc, position: desc.position, species: def.key });
    ev.emit(E.BUBBLES, { position: desc.position, count: 16, spread: 0.3 });
    ev.emit(E.SFX, { name: 'fish-catch', position: desc.position, volume: 0.7 });
    this._eventPos.set(sp.px[i], sp.py[i], sp.pz[i]);
    this.startle(this._eventPos, 4.5, 0.9);
    if (bestSh.members.length <= 1) bestSh.respawn = 8;
    return desc;
  }

  _describe(sp, i, dist) {
    const def = sp.def;
    const len = def.length * sp.scale[i];
    return {
      species: def.key,
      name: def.name,
      length: +len.toFixed(3),
      weight: +(11.5 * len * len * len).toFixed(3),
      position: new THREE.Vector3(sp.px[i], sp.py[i], sp.pz[i]),
      distance: dist,
      startled: sp.burst[i] > 0.3,
      color: `#${new THREE.Color().copy(sp.uniforms.uFlankC.value).getHexString()}`,
    };
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    for (const sp of this.species) {
      this.group.remove(sp.mesh);
      sp.geo.dispose();
      sp.inst.dispose();
      sp.mat.dispose();
    }
    this.ctx.scene.remove(this.group);
    this.species.length = 0;
    this.shoals.length = 0;
    this.activeShoals.length = 0;
  }
}
