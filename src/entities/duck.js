/**
 * duck.js — the duck itself: procedural geometry, rig, plumage and animation.
 *
 * Design notes
 * ------------
 * * ONE draw call per duck. The whole animal (body, neck, head, bill, eyes,
 *   wings, primaries, tail fan, legs, webbed feet) is a single indexed
 *   SkinnedMesh sharing one texture atlas and one MeshPhysicalMaterial.
 *   Ducklings add one extra transparent "down shell" pass.
 * * Geometry + textures are built ONCE per variant and reference counted; each
 *   duck gets a fresh 27-bone skeleton and a cheap material clone (clones share
 *   the compiled program and every texture, so 24 ducks cost 24 draws and
 *   one program).
 * * The body is a single swept surface running tail tip -> back -> nape ->
 *   crown -> bill tip, with per-section super-ellipse cross sections. That
 *   makes the neck/head/bill one continuous skin with no seams and gives a
 *   natural (around, along) UV for painting feather rows.
 * * Local axes: the duck faces **+Z**, up is +Y, +X is the duck's right.
 *   y = 0 is the floating waterline. Pass `forward: '-z'` if your system uses
 *   Object3D.lookAt() semantics.
 */

import * as THREE from 'three';
import { Noise, makeRandom } from '../core/noise.js';
import { settings } from '../core/settings.js';

/* ------------------------------------------------------------------ palettes */

const C = (hex) => new THREE.Color(hex);

export const DUCK_PALETTES = {
  mallardDrake: {
    key: 'mallardDrake',
    head: '#134f36',
    headLow: '#0c3a2a',
    headSheen: '#2f8f5f',
    iridescence: 1.0,
    ring: '#f4efe2',
    breast: '#7c3f27',
    breastHi: '#a75e37',
    flank: '#cbcfca',
    flankLine: '#5f6b6d',
    back: '#7a6a56',
    backDark: '#4f4436',
    rump: '#1d2b26',
    belly: '#dadbd2',
    vent: '#c9cabf',
    tailWhite: '#d9d4c6',
    tailDark: '#191a1c',
    curl: '#14161a',
    wing: '#8d8072',
    wingDark: '#5d5346',
    speculum: '#2c4d92',
    specBar: '#f2f0e6',
    bill: '#d8a53c',
    billDark: '#b5822a',
    nail: '#3a3228',
    leg: '#e07d2c',
    legDark: '#b8571b',
    iris: '#2a1a0e',
    eyering: '#eae2cf',
    down: '#e8c39a',
  },
  mallardHen: {
    key: 'mallardHen',
    head: '#a68a62',
    headLow: '#cdb98e',
    headSheen: '#c0a578',
    iridescence: 0.0,
    ring: '#c9b58c',
    breast: '#9a7a4e',
    breastHi: '#c6a473',
    flank: '#b39668',
    flankLine: '#5a4529',
    back: '#6d5636',
    backDark: '#3e3120',
    rump: '#4a3a24',
    belly: '#cdba94',
    vent: '#bda882',
    tailWhite: '#d8c8a4',
    tailDark: '#4b3b25',
    curl: '#4b3b25',
    wing: '#8a7350',
    wingDark: '#544128',
    speculum: '#2c4d92',
    specBar: '#f2f0e6',
    bill: '#63563c',
    billDark: '#4a4030',
    nail: '#2e2a22',
    leg: '#d2762c',
    legDark: '#a8541c',
    iris: '#2a1a0e',
    eyering: '#e0d3b4',
    down: '#e5cba0',
  },
  duckling: {
    key: 'duckling',
    head: '#f0d67e',
    headLow: '#f6e5a6',
    headSheen: '#f7e6a8',
    iridescence: 0.0,
    ring: '#f2dd97',
    breast: '#f4de95',
    breastHi: '#faedbe',
    flank: '#e8cf82',
    flankLine: '#8d7a3c',
    back: '#63552a',
    backDark: '#463c1b',
    rump: '#7a6a33',
    belly: '#f7e9b4',
    vent: '#efdc9c',
    tailWhite: '#e6d290',
    tailDark: '#6d5d2a',
    curl: '#6d5d2a',
    wing: '#8b7a3c',
    wingDark: '#5c4f21',
    speculum: '#7d6d34',
    specBar: '#efe0a8',
    bill: '#8b8577',
    billDark: '#5d594c',
    nail: '#c8bda6',
    leg: '#7b7460',
    legDark: '#585244',
    iris: '#1d1409',
    eyering: '#f2e4b0',
    down: '#ffe9a8',
    cap: '#4e441f',
    eyeStripe: '#3d3517',
  },
};

const VARIANT_KIND = {
  adult: 'drake',
  drake: 'drake',
  male: 'drake',
  hen: 'hen',
  female: 'hen',
  duckling: 'duckling',
  chick: 'duckling',
};

const DEFAULT_PALETTE = {
  drake: 'mallardDrake',
  hen: 'mallardHen',
  duckling: 'duckling',
};

/* ------------------------------------------------------------- atlas layout */

// v = 1 - canvasY/H. Body occupies the big band, accessories the top strip.
const ATLAS = {
  body: { u0: 0.0, u1: 1.0, v0: 0.015, v1: 0.600 },
  wing: { u0: 0.0, u1: 1.0, v0: 0.845, v1: 0.995 },
  primary: { u0: 0.0, u1: 1.0, v0: 0.775, v1: 0.840 },
  tail: { u0: 0.0, u1: 1.0, v0: 0.700, v1: 0.770 },
  leg: { u0: 0.0, u1: 0.86, v0: 0.610, v1: 0.695 },
  eye: { u0: 0.88, u1: 0.965, v0: 0.610, v1: 0.695 },
};

/* --------------------------------------------------------------- bone table */

// [name, parent, x, y, z]  — rest rotations are identity so local axes are
// world axes at bind time: rotation.x = pitch, .y = yaw, .z = roll.
function boneTable(kind) {
  const d = kind === 'duckling';
  const S = d ? DUCKLING : DRAKE;
  return S.bones;
}

/* ---------------------------------------------------------------- shape spec */

// Body sweep keys: [p, y, z, rA(half width), rB+(dorsal), rB-(ventral), pPos, pNeg]
const DRAKE = {
  kind: 'drake',
  sections: 64,
  radial: 22,
  texSize: 1024,
  featherScale: 1.0,
  fuzz: 0.0,
  spine: [
    [0.000, 0.130, -0.244, 0.006, 0.006, 0.006, 2.0, 2.0],
    [0.032, 0.126, -0.232, 0.021, 0.018, 0.016, 2.0, 2.1],
    [0.075, 0.114, -0.212, 0.038, 0.031, 0.027, 2.0, 2.3],
    [0.130, 0.097, -0.184, 0.053, 0.045, 0.041, 2.0, 2.5],
    [0.195, 0.077, -0.147, 0.065, 0.056, 0.058, 2.1, 2.7],
    [0.265, 0.056, -0.100, 0.075, 0.066, 0.076, 2.1, 2.9],
    [0.335, 0.045, -0.048, 0.081, 0.070, 0.088, 2.1, 3.0],
    [0.405, 0.040, 0.004, 0.083, 0.071, 0.092, 2.1, 3.05],
    [0.470, 0.040, 0.052, 0.081, 0.069, 0.090, 2.1, 3.0],
    [0.530, 0.045, 0.094, 0.075, 0.064, 0.086, 2.1, 2.9],
    [0.580, 0.056, 0.124, 0.066, 0.056, 0.082, 2.1, 2.7],
    [0.622, 0.074, 0.144, 0.054, 0.047, 0.076, 2.1, 2.5],
    [0.660, 0.098, 0.156, 0.042, 0.038, 0.062, 2.05, 2.3],
    [0.696, 0.124, 0.163, 0.033, 0.031, 0.046, 2.0, 2.1],
    [0.732, 0.152, 0.168, 0.028, 0.027, 0.033, 2.0, 2.0],
    [0.766, 0.178, 0.174, 0.027, 0.027, 0.027, 2.0, 2.0],
    [0.798, 0.200, 0.183, 0.028, 0.030, 0.026, 2.0, 2.0],
    [0.830, 0.216, 0.195, 0.030, 0.035, 0.029, 2.05, 2.1],
    [0.862, 0.226, 0.211, 0.029, 0.037, 0.033, 2.1, 2.2],
    [0.892, 0.229, 0.228, 0.025, 0.030, 0.031, 2.2, 2.3],
    [0.912, 0.229, 0.239, 0.018, 0.019, 0.021, 2.5, 2.7],
    [0.932, 0.2275, 0.251, 0.0155, 0.0125, 0.0115, 3.1, 3.3],
    [0.955, 0.2265, 0.266, 0.0165, 0.0100, 0.0095, 3.5, 3.7],
    [0.978, 0.2270, 0.280, 0.0170, 0.0088, 0.0085, 3.7, 3.9],
    [0.993, 0.2290, 0.290, 0.0135, 0.0074, 0.0072, 3.4, 3.6],
    [1.000, 0.2310, 0.296, 0.0045, 0.0042, 0.0042, 2.4, 2.6],
  ],
  // extra section density around the head + bill
  density: [
    [0.0, 1.0], [0.45, 1.0], [0.60, 1.25], [0.70, 1.15],
    [0.80, 1.5], [0.88, 2.3], [0.95, 2.3], [1.0, 1.9],
  ],
  brow: { p: 0.852, w: 0.05, amount: 0.0050 },
  eye: { x: 0.0243, y: 0.2390, z: 0.2235, r: 0.0095, out: [0.90, 0.30, 0.32] },
  bones: [
    ['root', -1, 0, 0, 0],
    ['body', 0, 0, 0.042, 0.005],
    ['spine', 1, 0, 0.045, 0.095],
    ['tailBase', 1, 0, 0.092, -0.172],
    ['tailFeathers', 3, 0, 0.118, -0.212],
    ['neck0', 1, 0, 0.086, 0.150],
    ['neck1', 5, 0, 0.128, 0.163],
    ['neck2', 6, 0, 0.172, 0.173],
    ['neck3', 7, 0, 0.208, 0.190],
    ['head', 8, 0, 0.226, 0.208],
    ['jaw', 9, 0, 0.2225, 0.2385],
    ['shoulderR', 1, 0.048, 0.074, 0.112],
    ['wristR', 11, 0.064, 0.070, -0.020],
    ['tipR', 12, 0.044, 0.094, -0.150],
    ['shoulderL', 1, -0.048, 0.074, 0.112],
    ['wristL', 14, -0.064, 0.070, -0.020],
    ['tipL', 15, -0.044, 0.094, -0.150],
    ['hipR', 1, 0.036, 0.006, -0.030],
    ['footR', 17, 0.045, -0.060, -0.052],
    ['toeR0', 18, 0, 0, 0],
    ['toeR1', 18, 0, 0, 0],
    ['toeR2', 18, 0, 0, 0],
    ['hipL', 1, -0.036, 0.006, -0.030],
    ['footL', 22, -0.045, -0.060, -0.052],
    ['toeL0', 23, 0, 0, 0],
    ['toeL1', 23, 0, 0, 0],
    ['toeL2', 23, 0, 0, 0],
  ],
  wing: {
    // [t, x, y, z, chordHalf, thickOuter, thickInner]
    keys: [
      [0.00, 0.040, 0.074, 0.122, 0.022, 0.009, 0.006],
      [0.14, 0.058, 0.072, 0.086, 0.040, 0.015, 0.008],
      [0.34, 0.070, 0.068, 0.026, 0.046, 0.017, 0.008],
      [0.55, 0.069, 0.070, -0.038, 0.041, 0.014, 0.007],
      [0.74, 0.059, 0.082, -0.100, 0.031, 0.010, 0.005],
      [0.88, 0.045, 0.097, -0.152, 0.020, 0.006, 0.004],
      [1.00, 0.031, 0.108, -0.198, 0.007, 0.003, 0.002],
    ],
    sections: 16,
    radial: 12,
    scallop: { rows: 5, depth: 0.005 },
    primaries: [
      // [rootT, spread, length, drop, width]
      [0.66, 0.00, 0.128, 0.004, 0.0120],
      [0.71, 0.16, 0.118, 0.010, 0.0114],
      [0.76, 0.32, 0.106, 0.017, 0.0106],
      [0.815, 0.48, 0.092, 0.024, 0.0096],
    ],
  },
  tail: {
    count: 11,
    length: 0.100,
    width: 0.0270,
    fan: 0.34,
    rise: 0.30,
    curl: 2,
  },
  leg: {
    tarsus: [
      [0.0, 0.036, 0.004, -0.030, 0.0145],
      [0.5, 0.041, -0.028, -0.042, 0.0125],
      [1.0, 0.045, -0.060, -0.052, 0.0100],
    ],
    footLen: 0.072,
    footAngles: [-0.60, 0.0, 0.60],
    webDrop: 0.005,
  },
};

const DUCKLING = {
  kind: 'duckling',
  sections: 42,
  radial: 18,
  texSize: 1024,
  featherScale: 0.42,
  fuzz: 1.0,
  // The duckling is modelled at adult-ish coordinates and shrunk on the way
  // out, so one texel density and one set of proportions serve both.
  baseScale: 0.72,
  spine: [
    [0.000, 0.106, -0.108, 0.005, 0.005, 0.005, 2.0, 2.0],
    [0.055, 0.096, -0.096, 0.022, 0.020, 0.018, 2.0, 2.2],
    [0.130, 0.078, -0.076, 0.040, 0.037, 0.034, 2.0, 2.5],
    [0.230, 0.055, -0.046, 0.055, 0.052, 0.052, 2.1, 2.8],
    [0.340, 0.040, -0.008, 0.062, 0.058, 0.060, 2.1, 2.9],
    [0.440, 0.037, 0.030, 0.062, 0.057, 0.060, 2.1, 2.9],
    [0.520, 0.044, 0.058, 0.056, 0.051, 0.056, 2.1, 2.7],
    [0.580, 0.060, 0.075, 0.046, 0.042, 0.050, 2.1, 2.4],
    [0.630, 0.082, 0.084, 0.034, 0.032, 0.040, 2.05, 2.2],
    [0.680, 0.106, 0.088, 0.024, 0.024, 0.028, 2.0, 2.0],
    [0.725, 0.128, 0.092, 0.021, 0.022, 0.022, 2.0, 2.0],
    [0.770, 0.150, 0.098, 0.024, 0.026, 0.023, 2.0, 2.0],
    [0.815, 0.168, 0.110, 0.028, 0.032, 0.029, 2.05, 2.1],
    [0.860, 0.176, 0.128, 0.029, 0.034, 0.032, 2.1, 2.2],
    [0.900, 0.177, 0.145, 0.024, 0.026, 0.026, 2.2, 2.4],
    [0.930, 0.176, 0.156, 0.014, 0.013, 0.013, 2.8, 3.0],
    [0.962, 0.175, 0.167, 0.014, 0.0075, 0.0072, 3.4, 3.6],
    [0.985, 0.176, 0.174, 0.012, 0.0062, 0.0060, 3.2, 3.4],
    [1.000, 0.177, 0.178, 0.004, 0.0030, 0.0030, 2.4, 2.6],
  ],
  density: [[0.0, 1.0], [0.6, 1.1], [0.8, 1.5], [0.9, 2.0], [1.0, 1.6]],
  brow: { p: 0.855, w: 0.06, amount: 0.004 },
  eye: { x: 0.0245, y: 0.1830, z: 0.1355, r: 0.0112, out: [0.90, 0.24, 0.36] },
  bones: [
    ['root', -1, 0, 0, 0],
    ['body', 0, 0, 0.040, 0.010],
    ['spine', 1, 0, 0.044, 0.062],
    ['tailBase', 1, 0, 0.080, -0.072],
    ['tailFeathers', 3, 0, 0.096, -0.096],
    ['neck0', 1, 0, 0.086, 0.086],
    ['neck1', 5, 0, 0.112, 0.089],
    ['neck2', 6, 0, 0.140, 0.095],
    ['neck3', 7, 0, 0.162, 0.106],
    ['head', 8, 0, 0.176, 0.126],
    ['jaw', 9, 0, 0.1725, 0.1495],
    ['shoulderR', 1, 0.040, 0.078, 0.060],
    ['wristR', 11, 0.044, 0.076, 0.010],
    ['tipR', 12, 0.030, 0.082, -0.030],
    ['shoulderL', 1, -0.040, 0.078, 0.060],
    ['wristL', 14, -0.044, 0.076, 0.010],
    ['tipL', 15, -0.030, 0.082, -0.030],
    ['hipR', 1, 0.026, 0.010, -0.008],
    ['footR', 17, 0.032, -0.048, -0.020],
    ['toeR0', 18, 0, 0, 0],
    ['toeR1', 18, 0, 0, 0],
    ['toeR2', 18, 0, 0, 0],
    ['hipL', 1, -0.026, 0.010, -0.008],
    ['footL', 22, -0.032, -0.048, -0.020],
    ['toeL0', 23, 0, 0, 0],
    ['toeL1', 23, 0, 0, 0],
    ['toeL2', 23, 0, 0, 0],
  ],
  wing: {
    keys: [
      [0.00, 0.036, 0.079, 0.062, 0.018, 0.008, 0.005],
      [0.30, 0.046, 0.076, 0.026, 0.024, 0.010, 0.006],
      [0.65, 0.044, 0.076, -0.014, 0.019, 0.008, 0.005],
      [1.00, 0.032, 0.082, -0.046, 0.006, 0.003, 0.002],
    ],
    sections: 8,
    radial: 10,
    scallop: { rows: 3, depth: 0.0025 },
    primaries: [],
  },
  tail: { count: 7, length: 0.030, width: 0.0085, fan: 0.85, rise: 0.42, curl: 0 },
  leg: {
    tarsus: [
      [0.0, 0.026, 0.010, -0.008, 0.0105],
      [0.5, 0.030, -0.020, -0.014, 0.0092],
      [1.0, 0.032, -0.048, -0.019, 0.0076],
    ],
    footLen: 0.050,
    footAngles: [-0.62, 0.0, 0.62],
    webDrop: 0.004,
  },
};

function specFor(kind) {
  if (kind === 'duckling') return DUCKLING;
  return DRAKE;
}

/* ------------------------------------------------------------------- helpers */

/** Set `DUCK_DEBUG.log = console.log` to trace the (once-per-variant) build. */
export const DUCK_DEBUG = { log: null, t: 0 };
const trace = (s) => {
  if (!DUCK_DEBUG.log) return;
  const now = performance.now();
  DUCK_DEBUG.log(`[duck] ${s} +${(now - DUCK_DEBUG.t).toFixed(0)}ms`);
  DUCK_DEBUG.t = now;
};

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Catmull-Rom sample of a key table on non-uniform knots (channel-wise). */
function sampleKeys(keys, p, out) {
  const n = keys.length;
  let i = 0;
  while (i < n - 2 && keys[i + 1][0] < p) i++;
  const k0 = keys[Math.max(0, i - 1)];
  const k1 = keys[i];
  const k2 = keys[Math.min(n - 1, i + 1)];
  const k3 = keys[Math.min(n - 1, i + 2)];
  const h = k2[0] - k1[0] || 1e-6;
  const t = clamp((p - k1[0]) / h, 0, 1);
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  const ch = k1.length;
  for (let c = 1; c < ch; c++) {
    const d0 = (k2[c] - k0[c]) / ((k2[0] - k0[0]) || 1e-6);
    const d1 = (k3[c] - k1[c]) / ((k3[0] - k1[0]) || 1e-6);
    out[c - 1] = h00 * k1[c] + h10 * h * d0 + h01 * k2[c] + h11 * h * d1;
  }
  return out;
}

function sampleTable(keys, p) {
  // 1-channel lookup with linear interpolation, for density curves.
  const n = keys.length;
  if (p <= keys[0][0]) return keys[0][1];
  if (p >= keys[n - 1][0]) return keys[n - 1][1];
  for (let i = 0; i < n - 1; i++) {
    if (p <= keys[i + 1][0]) {
      const t = (p - keys[i][0]) / (keys[i + 1][0] - keys[i][0]);
      return lerp(keys[i][1], keys[i + 1][1], t);
    }
  }
  return keys[n - 1][1];
}

/* ------------------------------------------------------- geometry: builder */

class MeshBuilder {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.si = [];
    this.sw = [];
    this.ex = []; // aExtra: x = feather fan index, y = part id, z = fuzz length
    this.idx = [];
  }
  get count() { return this.pos.length / 3; }
  vert(x, y, z, u, v, w, part, fan, fuzz) {
    this.pos.push(x, y, z);
    this.nor.push(0, 1, 0);
    this.uv.push(u, v);
    this.si.push(w[0], w[2], 0, 0);
    this.sw.push(w[1], w[3], 0, 0);
    this.ex.push(fan, part, fuzz);
    return this.count - 1;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
}

const _wScratch = [0, 1, 0, 0];
function chainWeights(chain, p, out) {
  const n = chain.length;
  if (p <= chain[0][0]) { out[0] = chain[0][1]; out[1] = 1; out[2] = chain[0][1]; out[3] = 0; return out; }
  if (p >= chain[n - 1][0]) { out[0] = chain[n - 1][1]; out[1] = 1; out[2] = chain[n - 1][1]; out[3] = 0; return out; }
  for (let i = 0; i < n - 1; i++) {
    if (p <= chain[i + 1][0]) {
      const t = (p - chain[i][0]) / (chain[i + 1][0] - chain[i][0] || 1e-6);
      const s = t * t * (3 - 2 * t);
      out[0] = chain[i][1]; out[1] = 1 - s;
      out[2] = chain[i + 1][1]; out[3] = s;
      return out;
    }
  }
  return out;
}

/* ------------------------------------------------- geometry: the body sweep */

const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _key = new Float64Array(8);

/**
 * Mirror a freshly appended block across x. Mirroring reverses orientation, so
 * the winding of the block's triangles is reversed too — that keeps normals
 * pointing outward without having to reason about each frame's handedness.
 */
function mirrorBlock(mb, vFrom, iFrom) {
  for (let i = vFrom; i < mb.count; i++) mb.pos[i * 3] = -mb.pos[i * 3];
  for (let i = iFrom; i < mb.idx.length; i += 3) {
    const t = mb.idx[i + 1];
    mb.idx[i + 1] = mb.idx[i + 2];
    mb.idx[i + 2] = t;
  }
}

/**
 * Sample the body spine at p -> { y, z, rA, rBp, rBn, pP, pN }
 */
function spineAt(spec, p, out) {
  sampleKeys(spec.spine, clamp(p, 0, 1), out);
  return out;
}

function buildBody(spec, mb, noise, rnd, info) {
  const keys = spec.spine;
  const N = spec.sections;
  const R = spec.radial;

  // --- dense pre-pass: arc length, section-density measure, and a texel
  // measure. The texel measure is what v is laid out along: u always spends
  // the full atlas width on the ring, so slim parts (neck, head, bill) need a
  // larger share of v or their texels end up wildly anisotropic.
  const M = 512;
  const px = new Float64Array(M + 1);
  const py = new Float64Array(M + 1);
  const pz = new Float64Array(M + 1);
  const arc = new Float64Array(M + 1);
  const mea = new Float64Array(M + 1);
  const tex = new Float64Array(M + 1);
  let cMax = 1e-4;
  const circAt = (i) => {
    spineAt(spec, px[i], _key);
    return 2 * Math.PI * (_key[2] * 0.5 + (_key[3] + _key[4]) * 0.25) + 1e-5;
  };
  for (let i = 0; i <= M; i++) {
    const p = i / M;
    spineAt(spec, p, _key);
    px[i] = p; py[i] = _key[0]; pz[i] = _key[1];
    cMax = Math.max(cMax, 2 * Math.PI * (_key[2] * 0.5 + (_key[3] + _key[4]) * 0.25));
  }
  for (let i = 1; i <= M; i++) {
    const dy = py[i] - py[i - 1], dz = pz[i] - pz[i - 1];
    const dl = Math.hypot(dy, dz);
    arc[i] = arc[i - 1] + dl;
    mea[i] = mea[i - 1] + dl * sampleTable(spec.density, px[i]);
    const w = clamp(Math.pow(cMax / circAt(i), 0.55), 1, 2.6);
    tex[i] = tex[i - 1] + dl * w;
  }
  const arcTotal = arc[M] || 1;
  const meaTotal = mea[M] || 1;
  const texTotal = tex[M] || 1;

  // resample section p values uniformly in the density measure
  const sp = new Float64Array(N);
  const scum = new Float64Array(N); // normalized texel measure, for UV v
  let j = 0;
  for (let s = 0; s < N; s++) {
    const target = (s / (N - 1)) * meaTotal;
    while (j < M && mea[j + 1] < target) j++;
    const seg = mea[j + 1] - mea[j] || 1e-9;
    const f = clamp((target - mea[j]) / seg, 0, 1);
    sp[s] = lerp(px[j], px[j + 1] ?? 1, f);
    scum[s] = lerp(tex[j], tex[j + 1] ?? texTotal, f) / texTotal;
  }
  sp[0] = 0; sp[N - 1] = 1; scum[0] = 0; scum[N - 1] = 1;

  // --- frames + section data
  const cx = new Float64Array(N), cy = new Float64Array(N), cz = new Float64Array(N);
  const ay = new Float64Array(N), az = new Float64Array(N); // B axis (in YZ plane)
  const rA = new Float64Array(N), rBp = new Float64Array(N), rBn = new Float64Array(N);
  const pP = new Float64Array(N), pN = new Float64Array(N);
  const circ = new Float64Array(N);

  for (let s = 0; s < N; s++) {
    spineAt(spec, sp[s], _key);
    cx[s] = 0; cy[s] = _key[0]; cz[s] = _key[1];
    rA[s] = _key[2]; rBp[s] = _key[3]; rBn[s] = _key[4];
    pP[s] = _key[5]; pN[s] = _key[6];
  }
  for (let s = 0; s < N; s++) {
    const a = Math.max(0, s - 1), b = Math.min(N - 1, s + 1);
    let ty = cy[b] - cy[a], tz = cz[b] - cz[a];
    const l = Math.hypot(ty, tz) || 1e-6;
    ty /= l; tz /= l;
    // A = +X (constant, planar curve). B = cross(T, A) with T=(0,ty,tz), A=(1,0,0)
    // cross((0,ty,tz),(1,0,0)) = (ty*0 - tz*0, tz*1 - 0*0, 0*0 - ty*1) = (0, tz, -ty)
    ay[s] = tz; az[s] = -ty;
    circ[s] = 2 * Math.PI * (rA[s] * 0.5 + (rBp[s] + rBn[s]) * 0.25) + 1e-5;
  }

  const chain = spec.kind === 'duckling' ? [
    [0.00, 3], [0.150, 3], [0.360, 1], [0.530, 2], [0.680, 5],
    [0.725, 6], [0.770, 7], [0.815, 8], [0.860, 9], [1.0, 9],
  ] : [
    [0.00, 3], [0.120, 3], [0.400, 1], [0.530, 2], [0.660, 5],
    [0.700, 6], [0.752, 7], [0.805, 8], [0.862, 9], [1.0, 9],
  ];
  const jawStart = spec.kind === 'duckling' ? 0.918 : 0.908;
  const JAW = 10, HEAD = 9;

  const rect = ATLAS.body;
  const base = mb.count;
  const brow = spec.brow;

  for (let s = 0; s < N; s++) {
    const p = sp[s];
    const vTex = rect.v0 + (rect.v1 - rect.v0) * scum[s];
    const browAmt = brow
      ? brow.amount * Math.exp(-(((p - brow.p) / brow.w) ** 2))
      : 0;
    for (let r = 0; r <= R; r++) {
      const th = -Math.PI + (2 * Math.PI * r) / R;
      const cb = Math.cos(th), sa = Math.sin(th);
      const ex = cb >= 0 ? pP[s] : pN[s];
      const e = 2 / ex;
      const sB = Math.sign(cb) * Math.pow(Math.abs(cb), e);
      const sA = Math.sign(sa) * Math.pow(Math.abs(sa), e);
      const rb = cb >= 0 ? rBp[s] : rBn[s];
      let bAmt = sB * rb;
      // brow: extra lift on the upper hemisphere near the head front
      if (browAmt > 0 && cb > 0) bAmt += browAmt * Math.pow(cb, 1.4) * (1 - 0.5 * Math.abs(sa));
      let x = sA * rA[s];
      let y = cy[s] + ay[s] * bAmt;
      let z = cz[s] + az[s] * bAmt;
      // organic micro-displacement (3D noise so it wraps at the seam)
      const nAmp = p > jawStart ? 0.0002 : 0.0011 * (spec.kind === 'duckling' ? 0.6 : 1);
      const nn = noise.fbm3(x * 21, y * 21, z * 21, 3);
      const inv = 1 / Math.max(1e-5, Math.hypot(x, bAmt));
      x += x * inv * nn * nAmp;
      y += ay[s] * bAmt * inv * nn * nAmp;
      z += az[s] * bAmt * inv * nn * nAmp;

      // weights
      chainWeights(chain, p, _wScratch);
      let w0 = _wScratch[0], ww0 = _wScratch[1], w1 = _wScratch[2], ww1 = _wScratch[3];
      if (p > jawStart) {
        const jf = (1 - smooth(-0.28, 0.30, sB)) * smooth(jawStart, jawStart + 0.02, p);
        w0 = HEAD; ww0 = 1 - jf; w1 = JAW; ww1 = jf;
      }
      _wScratch[0] = w0; _wScratch[1] = ww0; _wScratch[2] = w1; _wScratch[3] = ww1;

      const u = rect.u0 + (rect.u1 - rect.u0) * (0.5 + th / (2 * Math.PI));
      // fuzz shell length: full on the body, none on the bill
      const fz = (1 - smooth(jawStart - 0.06, jawStart + 0.01, p)) * (0.55 + 0.45 * smooth(0.02, 0.2, p));
      mb.vert(x, y, z, u, vTex, _wScratch, 0, 0, fz);
    }
  }
  for (let s = 0; s < N - 1; s++) {
    for (let r = 0; r < R; r++) {
      const a = base + s * (R + 1) + r;
      const b = a + 1;
      const c = a + (R + 1);
      const d = c + 1;
      mb.quad(a, c, d, b);
    }
  }
  // Cap the tail tip and the bill tip — the end rings are small but not zero,
  // and an open hole at the tip of the bill is very visible up close.
  for (const end of [0, N - 1]) {
    let mx = 0, my = 0, mz = 0;
    for (let r = 0; r < R; r++) {
      const i = (base + end * (R + 1) + r) * 3;
      mx += mb.pos[i]; my += mb.pos[i + 1]; mz += mb.pos[i + 2];
    }
    mx /= R; my /= R; mz /= R;
    // outward tangent at this end, so the cap domes instead of sitting flat
    const ty = end === 0 ? cy[0] - cy[1] : cy[N - 1] - cy[N - 2];
    const tz = end === 0 ? cz[0] - cz[1] : cz[N - 1] - cz[N - 2];
    const tl = Math.hypot(ty, tz) || 1;
    const push = (end === 0 ? rA[0] : rA[N - 1]) * 0.85;
    my += (ty / tl) * push;
    mz += (tz / tl) * push;
    const p = sp[end];
    chainWeights(chain, p, _wScratch);
    if (p > jawStart) { _wScratch[0] = HEAD; _wScratch[1] = 0.5; _wScratch[2] = JAW; _wScratch[3] = 0.5; }
    const vTex = rect.v0 + (rect.v1 - rect.v0) * scum[end];
    const ci = mb.vert(mx, my, mz, rect.u0 + (rect.u1 - rect.u0) * 0.5, vTex, _wScratch, 0, 0,
      end === 0 ? 0.5 : 0);
    for (let r = 0; r < R; r++) {
      const a = base + end * (R + 1) + r;
      const b = a + 1;
      if (end === 0) mb.tri(ci, a, b); else mb.tri(ci, b, a);
    }
  }

  // Painter lookups sampled uniformly in v (= normalized texel measure):
  // how many metres of body each unit of v covers, and the local circumference.
  {
    const K = 64;
    const arcByV = new Float64Array(K + 1);
    const circByV = new Float64Array(K + 1);
    let q = 0;
    for (let k = 0; k <= K; k++) {
      const target = (k / K) * texTotal;
      while (q < M && tex[q + 1] < target) q++;
      const seg = tex[q + 1] - tex[q] || 1e-9;
      const f = clamp((target - tex[q]) / seg, 0, 1);
      arcByV[k] = lerp(arc[q], arc[q + 1] ?? arcTotal, f);
      spineAt(spec, lerp(px[q], px[q + 1] ?? 1, f), _key);
      circByV[k] = 2 * Math.PI * (_key[2] * 0.5 + (_key[3] + _key[4]) * 0.25) + 1e-5;
    }
    info.arcByV = arcByV;
    info.circByV = circByV;
    info.vSamples = K;
    // metres of body per unit of v at v = c
    info.mPerV = (c) => {
      const t = clamp(c, 0, 0.999) * K;
      const i = Math.floor(t);
      return Math.max(1e-4, (arcByV[Math.min(K, i + 1)] - arcByV[i]) * K);
    };
    info.circAtV = (c) => {
      const t = clamp(c, 0, 1) * K;
      const i = Math.floor(t), f = t - i;
      return lerp(circByV[Math.min(K, i)], circByV[Math.min(K, i + 1)], f);
    };
  }

  info.bodyBase = base;
  info.bodyN = N;
  info.bodyR = R;
  info.arcTotal = arcTotal;
  info.circ = circ;
  info.scum = scum;
  info.sp = sp;
  info.cy = cy; info.cz = cz; info.ay = ay; info.az = az;
  info.rA = rA; info.rBp = rBp; info.rBn = rBn;
  info.cumOfP = (p) => {
    // invert sp -> scum
    for (let s = 0; s < N - 1; s++) {
      if (p <= sp[s + 1]) {
        const t = (p - sp[s]) / (sp[s + 1] - sp[s] || 1e-9);
        return lerp(scum[s], scum[s + 1], clamp(t, 0, 1));
      }
    }
    return 1;
  };
  return info;
}

/* ----------------------------------------------- geometry: generic sweep */

/**
 * Sweep a closed super-elliptic tube along a 3D key track.
 * keys: [t, x, y, z, rA, rBp, rBn]
 */
function sweepTube(mb, keys, opts) {
  const {
    sections = 10, radial = 10, ref = [0, 1, 0], rect, uvSwap = true,
    weights, part = 0, capEnd = true, capStart = false, expo = 2.2,
    scallop = null, twist = 0, fan = 0, fuzz = 0, vSpan = null,
  } = opts;
  const buf = new Float64Array(6);
  const base = mb.count;
  const P = [];
  for (let s = 0; s < sections; s++) {
    const t = s / (sections - 1);
    sampleKeys(keys, t, buf);
    P.push([buf[0], buf[1], buf[2], buf[3], buf[4], buf[5]]);
  }
  const v0 = vSpan ? vSpan[0] : rect.v0;
  const v1 = vSpan ? vSpan[1] : rect.v1;

  for (let s = 0; s < sections; s++) {
    const t = s / (sections - 1);
    const a = P[Math.max(0, s - 1)], b = P[Math.min(sections - 1, s + 1)];
    _v3a.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
    _v3b.set(ref[0], ref[1], ref[2]).normalize();
    _v3c.crossVectors(_v3b, _v3a);
    if (_v3c.lengthSq() < 1e-9) _v3c.set(1, 0, 0);
    _v3c.normalize();                       // A axis (chord)
    const Bx = _v3a.y * _v3c.z - _v3a.z * _v3c.y;
    const By = _v3a.z * _v3c.x - _v3a.x * _v3c.z;
    const Bz = _v3a.x * _v3c.y - _v3a.y * _v3c.x;
    const bl = Math.hypot(Bx, By, Bz) || 1;
    const bx = Bx / bl, by = By / bl, bz = Bz / bl;
    const Ax = _v3c.x, Ay = _v3c.y, Az = _v3c.z;

    let rAv = P[s][3], rBp = P[s][4], rBn = P[s][5];
    if (scallop) {
      const w = Math.sin(t * Math.PI * scallop.rows * 2) * 0.5 + 0.5;
      rAv -= scallop.depth * w * smooth(0.15, 0.6, t);
    }
    const tw = twist * (t - 0.5);
    for (let r = 0; r <= radial; r++) {
      const th = -Math.PI + (2 * Math.PI * r) / radial + tw;
      const cb = Math.cos(th), sa = Math.sin(th);
      const e = 2 / expo;
      const sB = Math.sign(cb) * Math.pow(Math.abs(cb), e);
      const sA = Math.sign(sa) * Math.pow(Math.abs(sa), e);
      const rb = cb >= 0 ? rBp : rBn;
      const x = P[s][0] + Ax * sA * rAv + bx * sB * rb;
      const y = P[s][1] + Ay * sA * rAv + by * sB * rb;
      const z = P[s][2] + Az * sA * rAv + bz * sB * rb;
      const around = 0.5 + th / (2 * Math.PI);
      const u = uvSwap
        ? rect.u0 + (rect.u1 - rect.u0) * t
        : rect.u0 + (rect.u1 - rect.u0) * around;
      const v = uvSwap
        ? v0 + (v1 - v0) * clamp(around, 0, 1)
        : v0 + (v1 - v0) * t;
      weights(t, sB, sA, _wScratch);
      mb.vert(x, y, z, u, v, _wScratch, part, fan, fuzz);
    }
  }
  for (let s = 0; s < sections - 1; s++) {
    for (let r = 0; r < radial; r++) {
      const a = base + s * (radial + 1) + r;
      const b = a + 1;
      const c = a + (radial + 1);
      const d = c + 1;
      mb.quad(a, c, d, b);
    }
  }
  // caps
  const capRing = (sIdx, outward) => {
    let mx = 0, my = 0, mz = 0;
    for (let r = 0; r < radial; r++) {
      const i = (base + sIdx * (radial + 1) + r) * 3;
      mx += mb.pos[i]; my += mb.pos[i + 1]; mz += mb.pos[i + 2];
    }
    mx /= radial; my /= radial; mz /= radial;
    const t = sIdx / (sections - 1);
    weights(t, 0, 0, _wScratch);
    const u = uvSwap ? rect.u0 + (rect.u1 - rect.u0) * t : rect.u0 + (rect.u1 - rect.u0) * 0.5;
    const v = uvSwap ? (v0 + v1) * 0.5 : v0 + (v1 - v0) * t;
    const ci = mb.vert(mx, my, mz, u, v, _wScratch, part, fan, fuzz);
    for (let r = 0; r < radial; r++) {
      const a = base + sIdx * (radial + 1) + r;
      const b = a + 1;
      if (outward) mb.tri(ci, a, b); else mb.tri(ci, b, a);
    }
  };
  if (capStart) capRing(0, false);
  if (capEnd) capRing(sections - 1, true);
  return base;
}

/* ------------------------------------------------------- geometry: the eyes */

function buildEye(mb, spec, headIdx) {
  const e = spec.eye;
  const R = 10, Rings = 8;
  const base = mb.count;
  // outward gaze axis (built on the +X side; the other eye is a mirrored block)
  const g = new THREE.Vector3(e.out[0], e.out[1], e.out[2]).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const t1 = new THREE.Vector3().crossVectors(up, g).normalize();
  const t2 = new THREE.Vector3().crossVectors(g, t1).normalize();
  const rect = ATLAS.eye;
  const cu = (rect.u0 + rect.u1) * 0.5, cv = (rect.v0 + rect.v1) * 0.5;
  const hu = (rect.u1 - rect.u0) * 0.5 - 0.0015, hv = (rect.v1 - rect.v0) * 0.5 - 0.0015;
  const w = [headIdx, 1, headIdx, 0];
  for (let i = 0; i <= Rings; i++) {
    const a = (i / Rings) * Math.PI; // 0 = looking out, PI = back
    const sr = Math.sin(a), cr = Math.cos(a);
    for (let j = 0; j <= R; j++) {
      const b = (j / R) * Math.PI * 2;
      const dx = g.x * cr + (t1.x * Math.cos(b) + t2.x * Math.sin(b)) * sr;
      const dy = g.y * cr + (t1.y * Math.cos(b) + t2.y * Math.sin(b)) * sr;
      const dz = g.z * cr + (t1.z * Math.cos(b) + t2.z * Math.sin(b)) * sr;
      // slight lens bulge at the cornea
      const bulge = 1 + 0.09 * Math.pow(Math.max(0, cr), 3);
      const rr = e.r * bulge;
      const x = e.x + dx * rr;
      const y = e.y + dy * rr;
      const z = e.z + dz * rr;
      const rad = clamp(a / Math.PI, 0, 1);
      const u = cu + Math.cos(b) * rad * hu;
      const v = cv + Math.sin(b) * rad * hv;
      mb.vert(x, y, z, u, v, w, 5, 0, 0);
    }
  }
  for (let i = 0; i < Rings; i++) {
    for (let j = 0; j < R; j++) {
      const a = base + i * (R + 1) + j;
      const b = a + 1, c = a + (R + 1), d = c + 1;
      mb.quad(a, b, d, c);
    }
  }
}

/* -------------------------------------------------- geometry: webbed foot */

/**
 * The webbed foot: a cupped fan with three toe lobes and scalloped webbing
 * between them. Built on the +X side; the other foot is a mirrored block.
 * Weighted to the three toe bones so the web spreads on the push stroke and
 * folds on the return.
 */
function buildFoot(mb, spec, ankleIdx, toeIdx) {
  const L = spec.leg;
  const A = 14, Rg = 6;
  const angles = L.footAngles;
  const rect = ATLAS.leg;
  const base = mb.count;
  const ax = spec.bones.find((b) => b[0] === 'footR');
  const ox = ax[2], oy = ax[3], oz = ax[4];

  const lobeM = (a, w) => {
    let m = 0;
    for (const ta of angles) {
      const d = (a * 0.80 - ta) / w;
      m = Math.max(m, Math.exp(-d * d));
    }
    return m;
  };
  const w4 = [0, 0, 0, 0];

  for (let i = 0; i <= A; i++) {
    const a = -1 + (2 * i) / A;
    const ang = a * 0.80;
    // webbing is shorter between the toes, giving a scalloped trailing edge
    const rmax = L.footLen * (0.58 + 0.42 * lobeM(a, 0.36));
    const th = 0.0013 + 0.0030 * lobeM(a, 0.20);
    // toe bone blend across the fan
    const seg = clamp((a + 1), 0, 1.999);
    const i0 = Math.floor(seg), f = seg - i0;
    const b0 = toeIdx[Math.min(2, i0)], b1 = toeIdx[Math.min(2, i0 + 1)];
    for (let k = 0; k <= Rg; k++) {
      const r = k / Rg;
      const rr = r * rmax;
      const dz = Math.cos(ang), dx = Math.sin(ang);
      const cup = -L.webDrop * (1 - Math.cos(r * Math.PI * 0.85));
      const x = ox + dx * rr;
      const y = oy + cup;
      const z = oz + dz * rr;
      // the base of the foot stays on the ankle, the blade follows the toes
      const anch = 1 - smooth(0.05, 0.42, r);
      w4[0] = b0; w4[1] = (1 - f) * (1 - anch) + anch;
      w4[2] = b1; w4[3] = f * (1 - anch);
      const nrm = w4[1] + w4[3] || 1;
      w4[1] /= nrm; w4[3] /= nrm;
      void ankleIdx;
      const u = rect.u0 + (rect.u1 - rect.u0) * (0.34 + 0.64 * r);
      const across = (a + 1) * 0.5;
      mb.vert(x, y + th, z, u, rect.v0 + (rect.v1 - rect.v0) * across * 0.5, w4, 4, 0, 0);
      mb.vert(x, y - th * 0.55, z, u, rect.v0 + (rect.v1 - rect.v0) * (0.5 + across * 0.5), w4, 4, 0, 0);
    }
  }
  const stride = (Rg + 1) * 2;
  for (let i = 0; i < A; i++) {
    for (let k = 0; k < Rg; k++) {
      const a = base + i * stride + k * 2;
      const b = a + 2, c = a + stride, d = c + 2;
      mb.quad(a, b, d, c);                       // top
      mb.quad(a + 1, c + 1, d + 1, b + 1);       // underside
    }
  }
  // rim along the outer edge so the web reads as a thin membrane
  for (let i = 0; i < A; i++) {
    const a = base + i * stride + Rg * 2;
    const c = a + stride;
    mb.quad(a, a + 1, c + 1, c);
  }
}

/* ---------------------------------------------------- geometry: assembly */

function buildDuckGeometry(spec, seed) {
  const noise = new Noise(seed);
  const rnd = makeRandom(seed ^ 0x9e37);
  const mb = new MeshBuilder();
  const info = {};

  trace('geo:start');
  buildBody(spec, mb, noise, rnd, info);
  const bodyVerts = mb.count;
  trace('geo:body');

  const B = {};
  spec.bones.forEach((b, i) => { B[b[0]] = i; });

  // ---- wings (folded along the flanks)
  for (const side of [1, -1]) {
    const v0 = mb.count, i0 = mb.idx.length;
    const sh = side > 0 ? B.shoulderR : B.shoulderL;
    const wr = side > 0 ? B.wristR : B.wristL;
    const tp = side > 0 ? B.tipR : B.tipL;
    const keys = spec.wing.keys.map((k) => [k[0], k[1], k[2], k[3], k[4], k[5], k[6]]);
    sweepTube(mb, keys, {
      sections: spec.wing.sections,
      radial: spec.wing.radial,
      ref: [1, 0.22, 0],
      rect: ATLAS.wing,
      uvSwap: true,
      expo: 2.6,
      scallop: spec.wing.scallop,
      part: 2,
      capStart: true,
      capEnd: true,
      fuzz: spec.kind === 'duckling' ? 0.5 : 0,
      weights: (t, sB, sA, out) => {
        if (t < 0.42) {
          const f = smooth(0.05, 0.42, t);
          out[0] = sh; out[1] = 1 - f; out[2] = wr; out[3] = f;
        } else {
          const f = smooth(0.42, 0.92, t);
          out[0] = wr; out[1] = 1 - f; out[2] = tp; out[3] = f;
        }
        return out;
      },
    });
    // primaries crossing over the tail
    spec.wing.primaries.forEach((pr, pi) => {
      const [rootT, spread, len, drop, wid] = pr;
      sampleKeys(spec.wing.keys, rootT, _key);
      const rx = _key[0], ry = _key[1], rz = _key[2];
      const kx = [];
      for (let k = 0; k < 5; k++) {
        const t = k / 4;
        const bend = t * t;
        kx.push([
          t,
          rx * (1 - t * (0.55 + spread * 0.25)) + spread * 0.010 * t,
          ry + 0.010 * t - drop * bend * 1.4 + 0.014 * t * (1 - t),
          rz - len * t * (1 + spread * 0.10),
          wid * (0.95 - 0.72 * bend),
          0.0016 * (1 - 0.6 * t),
          0.0014 * (1 - 0.6 * t),
        ]);
      }
      sweepTube(mb, kx, {
        sections: 6,
        radial: 6,
        ref: [1, 0.30, 0],
        rect: ATLAS.primary,
        uvSwap: true,
        vSpan: [
          ATLAS.primary.v0 + (ATLAS.primary.v1 - ATLAS.primary.v0) * (pi / 4 + 0.01),
          ATLAS.primary.v0 + (ATLAS.primary.v1 - ATLAS.primary.v0) * ((pi + 1) / 4 - 0.01),
        ],
        expo: 3.0,
        part: 2,
        capEnd: true,
        fan: (pi + 1) * side,
        weights: (t, sB, sA, out) => {
          const f = smooth(0.0, 0.5, t);
          out[0] = wr; out[1] = 1 - f; out[2] = tp; out[3] = f;
          return out;
        },
      });
    });
    if (side < 0) mirrorBlock(mb, v0, i0);
  }

  trace('geo:wings');
  // ---- tail fan
  const T = spec.tail;
  for (let i = 0; i < T.count; i++) {
    const f = T.count === 1 ? 0 : (i / (T.count - 1)) * 2 - 1; // -1..1
    const isCurl = T.curl > 0 && Math.abs(f) < (T.curl === 2 ? 0.14 : 0.08);
    sampleKeys(spec.spine, 0.10, _key);
    const rootY = _key[0] + 0.012;
    const rootZ = _key[1] - 0.004;
    const ang = f * T.fan;
    const kx = [];
    const segs = isCurl ? 7 : 5;
    for (let k = 0; k < segs; k++) {
      const t = k / (segs - 1);
      let x, y, z;
      if (isCurl) {
        // drake's curl: a tight upward-forward hook
        const a = t * 3.4;
        x = Math.sin(ang) * T.length * 0.35 * t + (f > 0 ? 1 : -1) * 0.004 * Math.sin(a);
        y = rootY + T.length * (0.30 * t + 0.34 * Math.sin(a * 0.62));
        z = rootZ - T.length * (0.72 * t) + T.length * 0.30 * (1 - Math.cos(a * 0.62));
      } else {
        const rise = T.rise * (1 - Math.abs(f) * 0.35);
        x = Math.sin(ang) * T.length * t;
        y = rootY + T.length * rise * t + T.length * 0.10 * t * t;
        z = rootZ - Math.cos(ang) * T.length * t * (1 - rise * 0.35);
      }
      const wtaper = isCurl
        ? T.width * 0.55 * (1 - 0.45 * t)
        : T.width * (0.55 + 0.55 * Math.sin(Math.min(1, t * 1.25) * Math.PI * 0.55)) * (1 - 0.55 * t * t);
      kx.push([t, x, y, z, wtaper, 0.0013 * (1 - 0.5 * t), 0.0012 * (1 - 0.5 * t)]);
    }
    const vb = ATLAS.tail;
    const slot = isCurl ? 0 : 1 + (i % 3);
    sweepTube(mb, kx, {
      sections: segs + 1,
      radial: 6,
      ref: [0, 1, 0.15],
      rect: vb,
      uvSwap: true,
      vSpan: [
        vb.v0 + (vb.v1 - vb.v0) * (slot / 4 + 0.008),
        vb.v0 + (vb.v1 - vb.v0) * ((slot + 1) / 4 - 0.008),
      ],
      expo: 2.8,
      part: 3,
      capEnd: true,
      fan: 0,
      weights: (t, sB, sA, out) => {
        const g = smooth(0.0, 0.4, t);
        out[0] = B.tailBase; out[1] = 1 - g; out[2] = B.tailFeathers; out[3] = g;
        return out;
      },
    });
  }

  trace('geo:tail');
  // ---- legs + feet
  for (const side of [1, -1]) {
    const v0 = mb.count, i0 = mb.idx.length;
    const hip = side > 0 ? B.hipR : B.hipL;
    const ank = side > 0 ? B.footR : B.footL;
    const toes = side > 0 ? [B.toeR0, B.toeR1, B.toeR2] : [B.toeL0, B.toeL1, B.toeL2];
    const keys = spec.leg.tarsus.map((k) => [k[0], k[1], k[2], k[3], k[4], k[4], k[4]]);
    sweepTube(mb, keys, {
      sections: 6,
      radial: 8,
      ref: [1, 0, 0.2],
      rect: { u0: ATLAS.leg.u0 + 0.004, u1: ATLAS.leg.u0 + 0.30 * (ATLAS.leg.u1 - ATLAS.leg.u0) },
      uvSwap: true,
      expo: 2.2,
      part: 4,
      capStart: false,
      capEnd: false,
      weights: (t, sB, sA, out) => {
        const f = smooth(0.25, 0.95, t);
        out[0] = hip; out[1] = 1 - f; out[2] = ank; out[3] = f;
        return out;
      },
      vSpan: [ATLAS.leg.v0 + 0.004, ATLAS.leg.v1 - 0.004],
    });
    buildFoot(mb, spec, ank, toes);
    if (side < 0) mirrorBlock(mb, v0, i0);
  }

  trace('geo:legs');
  // ---- eyes
  buildEye(mb, spec, B.head);
  {
    const v0 = mb.count, i0 = mb.idx.length;
    buildEye(mb, spec, B.head);
    mirrorBlock(mb, v0, i0);
  }

  trace('geo:eyes');
  // ---- pack
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(mb.pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(mb.uv, 2));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(mb.si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(mb.sw, 4));
  geo.setAttribute('aExtra', new THREE.Float32BufferAttribute(mb.ex, 3));
  geo.setIndex(mb.idx);
  geo.computeVertexNormals();

  // stitch the UV seam normals on the body (u=0 / u=1 duplicates)
  {
    const nor = geo.attributes.normal.array;
    const N = info.bodyN, R = info.bodyR, base = info.bodyBase;
    for (let s = 0; s < N; s++) {
      const a = (base + s * (R + 1)) * 3;
      const b = (base + s * (R + 1) + R) * 3;
      const nx = (nor[a] + nor[b]) * 0.5;
      const ny = (nor[a + 1] + nor[b + 1]) * 0.5;
      const nz = (nor[a + 2] + nor[b + 2]) * 0.5;
      const l = Math.hypot(nx, ny, nz) || 1;
      nor[a] = nor[b] = nx / l;
      nor[a + 1] = nor[b + 1] = ny / l;
      nor[a + 2] = nor[b + 2] = nz / l;
    }
    geo.attributes.normal.needsUpdate = true;
  }

  geo.computeBoundingSphere();
  geo.boundingSphere.radius *= 2.1;
  geo.computeBoundingBox();

  // ---- fuzz shell (body verts pushed out along the normal)
  let fuzzGeo = null;
  if (spec.fuzz > 0) {
    const n = bodyVerts;
    const pos = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    const nor = geo.attributes.normal.array;
    const len = spec.kind === 'duckling' ? 0.0055 : 0.004;
    for (let i = 0; i < n; i++) {
      const f = mb.ex[i * 3 + 2] * len;
      pos[i * 3] = mb.pos[i * 3] + nor[i * 3] * f;
      pos[i * 3 + 1] = mb.pos[i * 3 + 1] + nor[i * 3 + 1] * f;
      pos[i * 3 + 2] = mb.pos[i * 3 + 2] + nor[i * 3 + 2] * f;
      uv[i * 2] = mb.uv[i * 2];
      uv[i * 2 + 1] = mb.uv[i * 2 + 1];
      for (let k = 0; k < 4; k++) { si[i * 4 + k] = mb.si[i * 4 + k]; sw[i * 4 + k] = mb.sw[i * 4 + k]; }
    }
    fuzzGeo = new THREE.BufferGeometry();
    fuzzGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    fuzzGeo.setAttribute('normal', new THREE.Float32BufferAttribute(nor.slice(0, n * 3), 3));
    fuzzGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    fuzzGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    fuzzGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    const bi = [];
    const N = info.bodyN, R = info.bodyR, base = info.bodyBase;
    for (let s = 0; s < N - 1; s++) {
      for (let r = 0; r < R; r++) {
        const a = base + s * (R + 1) + r, b = a + 1, c = a + (R + 1), d = c + 1;
        bi.push(a, c, d, a, d, b);
      }
    }
    fuzzGeo.setIndex(bi);
    fuzzGeo.boundingSphere = geo.boundingSphere.clone();
  }

  info.triangles = mb.idx.length / 3;
  return { geometry: geo, fuzzGeometry: fuzzGeo, info, boneIndex: B };
}

/* ----------------------------------------------------------- the painter */

/**
 * Painter canvases are created CPU-backed (`willReadFrequently`). Without it
 * Chromium keeps them on the GPU and a single 1024² getImageData readback
 * costs tens of seconds under SwiftShader.
 */
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.__ctx = c.getContext('2d', { willReadFrequently: true });
  return c;
}
const ctx2d = (c) => c.__ctx || (c.__ctx = c.getContext('2d', { willReadFrequently: true }));

const hexRGB = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

function mixRGB(a, b, t, out) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

function paintDuckTextures(spec, pal, info) {
  const W = spec.texSize, H = spec.texSize;
  const noise = new Noise(4771);
  const rnd = makeRandom(9013);
  const kind = spec.kind;

  const albC = makeCanvas(W, H);
  const hgtC = makeCanvas(W, H);
  const ormC = makeCanvas(W, H);
  const mskC = makeCanvas(W, H);
  const a2 = ctx2d(albC);
  const h2 = ctx2d(hgtC);
  const o2 = ctx2d(ormC);
  const m2 = ctx2d(mskC);

  const alb = a2.createImageData(W, H);
  const hgt = h2.createImageData(W, H);
  const orm = o2.createImageData(W, H);
  const msk = m2.createImageData(W, H);
  const A = alb.data, Hd = hgt.data, O = orm.data, M = msk.data;

  const cP = info.cumOfP;
  const cum = {
    tailTip: 0,
    tailBase: cP(0.12),
    rump: cP(0.24),
    bodyMid: cP(0.40),
    bodyFront: cP(0.54),
    shoulder: cP(0.615),
    neckBase: cP(0.660),
    ringLo: cP(kind === 'duckling' ? 0.760 : 0.778),
    ringHi: cP(kind === 'duckling' ? 0.790 : 0.806),
    headBase: cP(kind === 'duckling' ? 0.800 : 0.812),
    headMid: cP(kind === 'duckling' ? 0.860 : 0.852),
    headFront: cP(kind === 'duckling' ? 0.905 : 0.884),
    billBase: cP(kind === 'duckling' ? 0.925 : 0.898),
    billTip: 1,
  };

  const col = {};
  for (const k in pal) if (typeof pal[k] === 'string' && pal[k][0] === '#') col[k] = hexRGB(pal[k]);

  const bodyRect = ATLAS.body;
  const y0 = Math.floor((1 - bodyRect.v1) * H);
  const y1 = Math.ceil((1 - bodyRect.v0) * H);
  const tmp = [0, 0, 0], tmp2 = [0, 0, 0], tmp3 = [0, 0, 0];
  const capCol = kind === 'duckling' ? hexRGB(pal.cap || pal.backDark) : null;
  const stripeCol = kind === 'duckling' ? hexRGB(pal.eyeStripe || pal.backDark) : null;

  const circOf = info.circAtV;
  const vSpanPx = (bodyRect.v1 - bodyRect.v0) * H;
  // px per metre along the body at v = c (v is not linear in arc length)
  const pxPerM_v = (c) => vSpanPx / info.mPerV(c);

  /* ---- base pass: colour, height, roughness, masks, per pixel ---- */
  for (let py = y0; py < y1; py++) {
    const v = 1 - (py + 0.5) / H;
    const c = clamp((v - bodyRect.v0) / (bodyRect.v1 - bodyRect.v0), 0, 1);
    for (let px = 0; px < W; px++) {
      const u = (px + 0.5) / W;
      const th = (u - 0.5) * 2 * Math.PI;
      const dorsal = Math.cos(th);          // +1 back, -1 belly
      const flank = Math.abs(Math.sin(th));
      const i = (py * W + px) * 4;

      // noise fields (wrap in u via cos/sin)
      const nx = Math.cos(th) * 1.0, nz = Math.sin(th) * 1.0;
      const blot = noise.fbm3(nx * 3.1, c * 26, nz * 3.1, 4);
      const fine = noise.fbm3(nx * 9, c * 92, nz * 9, 3);
      const grain = noise.noise3(nx * 26, c * 300, nz * 26);

      let base = tmp;
      let rough = 0.62;
      let irid = 0, sheen = 0, coat = 0, wetR = 1;
      let h = 0.5;

      const onBill = c > cum.billBase - 0.004;
      const onHead = c > cum.headBase;

      if (onBill) {
        const bt = clamp((c - cum.billBase) / (1 - cum.billBase), 0, 1);
        mixRGB(col.bill, col.billDark, 0.35 + 0.35 * Math.pow(Math.abs(dorsal), 1.5) * (dorsal > 0 ? 1 : 0.2), base);
        // culmen ridge (dark line down the centre of the top)
        const culmen = Math.exp(-((th / 0.34) ** 2));
        mixRGB(base, col.billDark, culmen * 0.45 * (1 - bt * 0.4), base);
        // the "grin line" where the mandibles meet
        const grin = Math.exp(-(((flank - 0.985) / 0.02) ** 2));
        mixRGB(base, col.nail, grin * 0.55, base);
        h = 0.5 + culmen * 0.10 - grin * 0.18;
        // lamellae: fine cross ridges near the edge
        const lam = Math.sin(bt * 210) * 0.5 + 0.5;
        h += lam * 0.05 * smooth(0.80, 0.99, flank);
        // nail
        const nail = smooth(0.86, 0.95, bt) * (1 - smooth(0.55, 0.85, flank));
        mixRGB(base, col.nail, nail * 0.9, base);
        h += nail * 0.06;
        // nostril
        const nos = Math.exp(-(((bt - 0.16) / 0.055) ** 2) - (((flank - 0.55) / 0.12) ** 2));
        mixRGB(base, col.nail, nos * 0.7, base);
        h -= nos * 0.35;
        rough = 0.30 + 0.14 * lam * 0.2 + 0.10 * nail;
        coat = 0.55 - 0.25 * nail;
        wetR = 0.25;
        // waxy translucency: warm bleed at the thin edges
        mixRGB(base, [246, 196, 122], smooth(0.90, 1.0, flank) * 0.30 * (kind !== 'duckling' ? 1 : 0.4), base);
        base[0] += grain * 3; base[1] += grain * 3; base[2] += grain * 3;
      } else if (kind === 'drake' && onHead) {
        const ht = clamp((c - cum.headBase) / (cum.billBase - cum.headBase), 0, 1);
        mixRGB(col.head, col.headLow, clamp(0.5 - dorsal * 0.55, 0, 1), base);
        mixRGB(base, col.headSheen, 0.13 * smooth(-0.1, 0.9, dorsal) + 0.10 * fine, base);
        // darker crown stripe and a subtly darker throat
        mixRGB(base, col.rump, Math.exp(-((th / 0.5) ** 2)) * 0.18, base);
        irid = 1.0;
        rough = 0.32 + 0.10 * fine;
        sheen = 0.35;
        h = 0.5 + fine * 0.035;
        void ht;
      } else if (kind === 'duckling') {
        // yellow body, dark olive cap / back / eye stripe
        const capMask = smooth(-0.62, 0.28, dorsal) * smooth(cum.headBase - 0.04, cum.headBase + 0.03, c);
        const backMask = smooth(-0.40, 0.55, dorsal) * (1 - smooth(cum.neckBase - 0.02, cum.neckBase + 0.06, c))
          * smooth(cum.tailBase - 0.02, cum.tailBase + 0.06, c);
        const rumpMask = smooth(-0.25, 0.6, dorsal) * (1 - smooth(cum.tailBase, cum.rump, c));
        mixRGB(col.belly, col.head, smooth(-0.9, 0.4, dorsal) * 0.9, base);
        mixRGB(base, col.back, clamp(Math.max(backMask, rumpMask) * (0.85 + 0.3 * blot), 0, 1), base);
        mixRGB(base, capCol, capMask * (0.9 + 0.2 * blot), base);
        // eye stripe: a dark band running back from the eye
        const esV = info.eyeUV ? info.eyeUV.c : cum.headMid;
        const esU = info.eyeUV ? Math.abs(info.eyeUV.th) : 1.0;
        const stripe = Math.exp(-(((Math.abs(th) - esU) / 0.42) ** 2))
          * Math.exp(-(((c - (esV - 0.014)) / 0.030) ** 2));
        mixRGB(base, stripeCol, stripe * 0.95, base);
        // pale wing patch line
        const wl = Math.exp(-(((flank - 0.86) / 0.10) ** 2)) * smooth(cum.rump, cum.bodyMid, c)
          * (1 - smooth(cum.bodyFront, cum.shoulder, c));
        mixRGB(base, col.belly, wl * 0.35, base);
        base[0] += blot * 11; base[1] += blot * 9; base[2] += blot * 3;
        rough = 0.86 + 0.08 * fine;
        sheen = 1.0;
        h = 0.5 + fine * 0.10 + grain * 0.02;
        wetR = 1.0;
      } else {
        // adult body: back / flank / breast / belly
        if (kind === 'drake') {
          mixRGB(col.back, col.backDark, clamp(0.35 + blot * 0.5, 0, 1), tmp3);
          // vermiculation: the drake's fine wavy grey barring on the flanks
          const verm = 0.5 + 0.5 * Math.sin(c * 640 + fine * 9 + Math.sin(th * 5) * 2.2);
          mixRGB(col.flank, col.flankLine, verm * 0.42 * smooth(0.25, 0.7, flank), tmp2);
        } else {
          mixRGB(col.back, col.backDark, clamp(0.30 + blot * 0.6, 0, 1), tmp3);
          mixRGB(col.flank, col.flankLine, clamp(0.18 + blot * 0.5, 0, 1) * 0.5, tmp2);
        }
        mixRGB(tmp2, tmp3, smooth(0.15, 0.9, dorsal), base);
        mixRGB(base, col.belly, smooth(-0.2, -0.95, dorsal), base);
        // breast + throat
        const br = smooth(cum.bodyFront, cum.shoulder + 0.02, c) * (1 - smooth(cum.ringLo - 0.01, cum.ringLo + 0.02, c));
        const brFront = clamp(br * (0.35 + 0.65 * smooth(0.6, -0.9, dorsal)), 0, 1);
        mixRGB(col.breast, col.breastHi, clamp(0.4 + blot * 0.6, 0, 1), tmp2);
        mixRGB(base, tmp2, brFront * (kind === 'drake' ? 1 : 0.75), base);
        // white neck ring (drake)
        if (kind === 'drake') {
          const ring = smooth(cum.ringLo, cum.ringLo + 0.010, c) * (1 - smooth(cum.ringHi - 0.010, cum.ringHi, c));
          mixRGB(base, col.ring, ring * (0.92 - 0.25 * Math.exp(-((th / 0.4) ** 2))), base);
        } else {
          // hen: pale throat, dark crown, eye stripe
          const cap = smooth(0.45, 0.95, dorsal) * smooth(cum.ringHi, cum.headBase + 0.03, c);
          mixRGB(base, col.backDark, cap * 0.75, base);
          const thr = smooth(-0.3, -0.95, dorsal) * smooth(cum.ringLo, cum.headBase, c);
          mixRGB(base, col.belly, thr * 0.55, base);
          const esV = info.eyeUV ? info.eyeUV.c : cum.headMid;
          const esU = info.eyeUV ? Math.abs(info.eyeUV.th) : 1.0;
          const stripe = Math.exp(-(((Math.abs(th) - esU) / 0.26) ** 2))
            * Math.exp(-(((c - (esV - 0.010)) / 0.024) ** 2));
          mixRGB(base, col.backDark, stripe * 0.8, base);
        }
        // rump / vent / undertail: the drake's black stern with a white
        // crescent just ahead of it is most of his read at distance
        const rp = 1 - smooth(cum.tailBase - 0.01, cum.rump + 0.03, c);
        if (kind === 'drake') {
          const white = smooth(cum.tailBase + 0.015, cum.tailBase + 0.055, c)
            * (1 - smooth(cum.rump + 0.02, cum.rump + 0.075, c));
          mixRGB(base, col.tailWhite, white * (0.55 + 0.40 * flank) * 0.92, base);
          mixRGB(base, col.curl, rp * smooth(-0.55, 0.65, dorsal) * 0.95, base);
          mixRGB(base, col.curl, rp * smooth(0.1, -0.75, dorsal) * 0.85, base);
        } else {
          mixRGB(base, col.rump, rp * smooth(-0.1, 0.9, dorsal) * 0.9, base);
          mixRGB(base, col.tailWhite, rp * smooth(0.2, -0.8, dorsal) * 0.7, base);
        }
        rough = 0.55 + 0.12 * fine + 0.18 * brFront;
        sheen = 0.25 + 0.75 * brFront;
        h = 0.5 + fine * 0.08 + grain * 0.012;
      }

      // AO: neck crease, under the wing line, under the tail, around the eye
      let ao = 1;
      ao -= 0.30 * Math.exp(-(((c - cum.neckBase) / 0.020) ** 2)) * smooth(0.1, -0.9, dorsal);
      ao -= 0.22 * Math.exp(-(((flank - 0.93) / 0.055) ** 2))
        * smooth(cum.rump, cum.bodyMid, c) * (1 - smooth(cum.bodyFront, cum.shoulder + 0.03, c));
      ao -= 0.25 * (1 - smooth(cum.tailTip, cum.tailBase, c)) * smooth(0.0, -0.8, dorsal);
      if (info.eyeUV) {
        const du = Math.abs(Math.abs(th) - Math.abs(info.eyeUV.th));
        const dv = (c - info.eyeUV.c) / 0.020;
        const near = Math.exp(-((du / 0.24) ** 2) - dv * dv);
        ao -= 0.48 * near;
        // pale eye-ring on adults, dark socket on ducklings
        const ring = Math.exp(-(((du - 0.20) / 0.06) ** 2) - (dv / 1.6) ** 2);
        if (kind !== 'duckling') mixRGB(base, col.eyering, ring * 0.55, base);
      }
      ao = clamp(ao, 0.35, 1);

      A[i] = clamp(base[0], 0, 255);
      A[i + 1] = clamp(base[1], 0, 255);
      A[i + 2] = clamp(base[2], 0, 255);
      A[i + 3] = 255;
      const bead = noise.noise3(nx * 60, c * 620, nz * 60) * 0.5 + 0.5;

      Hd[i] = Hd[i + 1] = Hd[i + 2] = clamp(h * 255, 0, 255);
      Hd[i + 3] = 255;

      O[i] = clamp(ao * 255, 0, 255);
      O[i + 1] = clamp(rough * 255, 0, 255);
      O[i + 2] = clamp(Math.pow(bead, 2.4) * 255 * 1.6, 0, 255);
      O[i + 3] = 255;

      M[i] = clamp(irid * 255, 0, 255);
      M[i + 1] = clamp(sheen * 255, 0, 255);
      M[i + 2] = clamp(coat * 255, 0, 255);
      M[i + 3] = clamp(wetR * 255, 0, 255);
    }
  }

  trace('tex:base');
  /* ---- accessory regions ---- */
  paintAccessories(alb, hgt, orm, msk, W, H, spec, pal, col, info, noise);
  trace('tex:accessories');

  a2.putImageData(alb, 0, 0);
  h2.putImageData(hgt, 0, 0);
  o2.putImageData(orm, 0, 0);
  m2.putImageData(msk, 0, 0);

  trace('tex:putImageData');
  /* ---- vector pass: overlapping feather rows on the body ---- */
  drawFeatherRows(a2, h2, o2, W, H, spec, pal, col, info, cum, circOf, pxPerM_v, rnd);
  trace('tex:feathers');

  /* ---- wing coverts + secondaries ---- */
  drawWingFeathers(a2, h2, o2, W, H, spec, pal, col, rnd);
  trace('tex:wing');

  /* ---- eye ---- */
  drawEye(a2, h2, o2, m2, W, H, pal, col, spec);
  trace('tex:eye');

  /* ---- normal map from height ---- */
  const nrmC = normalFromHeight(hgtC, W, H, spec.kind === 'duckling' ? 1.1 : 1.5);
  trace('tex:normal');

  const mk = (canvas, srgb) => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.needsUpdate = true;
    return t;
  };

  return {
    albedo: mk(albC, true),
    normal: mk(nrmC, false),
    orm: mk(ormC, false),
    mask: mk(mskC, false),
    strand: spec.fuzz > 0 ? makeStrandTexture(512, spec.kind) : null,
  };
}

/* -------------------------------------------------- accessory atlas paint */

function paintAccessories(alb, hgt, orm, msk, W, H, spec, pal, col, info, noise) {
  const A = alb.data, Hd = hgt.data, O = orm.data, M = msk.data;
  const kind = spec.kind;
  const tmp = [0, 0, 0], tmp2 = [0, 0, 0];

  const region = (rect, fn) => {
    const px0 = Math.floor(rect.u0 * W), px1 = Math.ceil(rect.u1 * W);
    const py0 = Math.floor((1 - rect.v1) * H), py1 = Math.ceil((1 - rect.v0) * H);
    for (let py = py0; py < py1; py++) {
      const v = 1 - (py + 0.5) / H;
      const tv = clamp((v - rect.v0) / (rect.v1 - rect.v0), 0, 1);
      for (let px = px0; px < px1; px++) {
        const u = (px + 0.5) / W;
        const tu = clamp((u - rect.u0) / (rect.u1 - rect.u0), 0, 1);
        const i = (py * W + px) * 4;
        fn(tu, tv, i);
      }
    }
  };

  const put = (i, c, h, ao, rough, irid, sheen, coat, wetR, bead) => {
    A[i] = clamp(c[0], 0, 255); A[i + 1] = clamp(c[1], 0, 255); A[i + 2] = clamp(c[2], 0, 255);
    A[i + 3] = 255;
    Hd[i] = Hd[i + 1] = Hd[i + 2] = clamp(h * 255, 0, 255); Hd[i + 3] = 255;
    O[i] = clamp(ao * 255, 0, 255); O[i + 1] = clamp(rough * 255, 0, 255);
    O[i + 2] = clamp(bead * 255, 0, 255); O[i + 3] = 255;
    M[i] = clamp(irid * 255, 0, 255); M[i + 1] = clamp(sheen * 255, 0, 255);
    M[i + 2] = clamp(coat * 255, 0, 255); M[i + 3] = clamp(wetR * 255, 0, 255);
  };

  // ---- wing: tu = along (shoulder->tip), tv = around (0.5 = outer face)
  region(ATLAS.wing, (tu, tv, i) => {
    const outer = 1 - Math.min(1, Math.abs(tv - 0.5) / 0.5);   // 1 at the outer centre
    const chord = (tv - 0.5) * 2;                              // -1..1 across the chord
    const nA = noise.fbm3(tu * 7, tv * 5, 1.7, 4);
    const nB = noise.fbm3(tu * 30, tv * 16, 4.3, 3);
    mixRGB(col.wing, col.wingDark, clamp(0.30 + nA * 0.6, 0, 1), tmp);
    // coverts get scalloped rows; drawn as a colour ripple here, relief below
    const rows = Math.sin(tu * 46 + Math.sin(tv * 7) * 1.4) * 0.5 + 0.5;
    mixRGB(tmp, col.wingDark, rows * 0.16, tmp);
    // pale feather edging
    mixRGB(tmp, col.belly, Math.pow(rows, 6) * 0.28 * (1 - outer * 0.4), tmp);
    let irid = 0, coat = 0;
    // the speculum: a blue band with white bars, on the outer face near the middle
    const specBand = Math.exp(-(((tu - 0.70) / 0.062) ** 2)) * smooth(0.20, 0.55, outer);
    if (kind !== 'duckling') {
      mixRGB(tmp, col.speculum, specBand * 0.85, tmp);
      irid = specBand * 0.85;
      const bar = Math.exp(-(((tu - 0.628) / 0.013) ** 2)) + Math.exp(-(((tu - 0.772) / 0.014) ** 2));
      mixRGB(tmp, col.specBar, clamp(bar, 0, 1) * 0.85 * smooth(0.20, 0.55, outer), tmp);
    }
    // underwing is paler
    mixRGB(tmp, col.belly, (1 - outer) * 0.42, tmp);
    // primaries: darker toward the tip
    mixRGB(tmp, col.backDark, smooth(0.74, 1.0, tu) * 0.45, tmp);
    const h = 0.5 + rows * 0.10 + nB * 0.10 - Math.exp(-(((Math.abs(chord) - 0.98) / 0.03) ** 2)) * 0.2;
    const ao = 1 - 0.25 * (1 - outer) - 0.12 * (1 - smooth(0.0, 0.2, tu));
    put(i, tmp, h, ao, 0.44 + 0.16 * nB - 0.14 * specBand, irid, kind === 'duckling' ? 0.9 : 0.35, coat, 1,
      Math.pow(noise.noise3(tu * 70, tv * 40, 9) * 0.5 + 0.5, 2.4) * 1.6);
  });

  // ---- primaries
  region(ATLAS.primary, (tu, tv, i) => {
    const band = (tv * 4) % 1;                 // per-feather sub-band
    const across = Math.abs((band - 0.5) * 2); // 0 shaft .. 1 edge
    const nB = noise.fbm3(tu * 26, band * 12, 2.2, 3);
    mixRGB(col.wingDark, col.backDark, clamp(0.3 + tu * 0.6, 0, 1), tmp);
    mixRGB(tmp, col.wing, (1 - across) * 0.22, tmp);
    // barbs
    const barb = Math.sin(tu * 300 + across * 22) * 0.5 + 0.5;
    mixRGB(tmp, col.belly, Math.pow(barb, 5) * 0.10, tmp);
    // pale tip
    mixRGB(tmp, col.flank, smooth(0.9, 1.0, tu) * 0.25, tmp);
    const shaft = Math.exp(-((across / 0.10) ** 2));
    mixRGB(tmp, col.flank, shaft * 0.22, tmp);
    const h = 0.5 + shaft * 0.22 + barb * 0.05 + nB * 0.05 - smooth(0.85, 1.0, across) * 0.25;
    put(i, tmp, h, 1 - 0.18 * across, 0.40 + 0.2 * nB, 0, 0.5, 0, 1, 0.4);
  });

  // ---- tail feathers
  region(ATLAS.tail, (tu, tv, i) => {
    const band = (tv * 4) % 1;
    const slot = Math.floor(tv * 4);
    const across = Math.abs((band - 0.5) * 2);
    const nB = noise.fbm3(tu * 22, band * 14, 5.5, 3);
    if (slot === 0) {
      // the drake's curl / central feathers: near black
      mixRGB(col.curl, col.tailDark, clamp(0.35 + nB * 0.5, 0, 1), tmp);
    } else {
      mixRGB(col.tailDark, col.tailWhite, clamp(0.10 + slot * 0.19 + nB * 0.16, 0, 1), tmp);
    }
    const barb = Math.sin(tu * 240 + across * 18) * 0.5 + 0.5;
    mixRGB(tmp, col.tailWhite, Math.pow(barb, 5) * 0.10 + smooth(0.88, 1.0, tu) * 0.18, tmp);
    const shaft = Math.exp(-((across / 0.11) ** 2));
    mixRGB(tmp, col.flank, shaft * 0.16, tmp);
    const h = 0.5 + shaft * 0.20 + barb * 0.05 + nB * 0.05;
    put(i, tmp, h, 1 - 0.14 * across, 0.46 + 0.2 * nB, slot === 0 ? 0.25 : 0, 0.4, 0, 1, 0.4);
  });

  // ---- legs + webbed feet: tu = along, tv = around (0..0.5 top, 0.5..1 bottom)
  region(ATLAS.leg, (tu, tv, i) => {
    const topFace = tv < 0.5 ? 1 : 0;
    const nA = noise.fbm3(tu * 16, tv * 11, 7.1, 3);
    mixRGB(col.leg, col.legDark, clamp(0.25 + nA * 0.55 + (1 - topFace) * 0.18, 0, 1), tmp);
    // reticulated scales
    const sc = Math.sin(tu * 130 + Math.sin(tv * 40) * 1.6) * 0.5 + 0.5;
    const sc2 = Math.sin(tv * 150 + Math.sin(tu * 30) * 1.2) * 0.5 + 0.5;
    const scale = Math.pow(sc * sc2, 0.7);
    mixRGB(tmp, col.legDark, scale * 0.22, tmp);
    // web membrane: translucent, warmer, veins
    const web = smooth(0.32, 0.52, tu);
    mixRGB(tmp, [232, 150, 92], web * 0.30, tmp);
    const vein = Math.exp(-(((((tv * 6) % 1) - 0.5) / 0.10) ** 2)) * web;
    mixRGB(tmp, col.legDark, vein * 0.24, tmp);
    const h = 0.5 + scale * 0.16 * (1 - web * 0.7) + vein * 0.06;
    put(i, tmp, h, 1 - 0.2 * (1 - topFace), 0.36 + 0.18 * scale + 0.12 * web, 0, 0.15,
      0.35 + 0.25 * web, 0.6, 0.3);
  });
}

/* ------------------------------------------- wing coverts + secondaries */

/**
 * The wing band is (along × around). Draw three ranks of overlapping coverts
 * running down the wing plus the long secondaries at the trailing end, so the
 * folded wing reads as feathers rather than a painted plate.
 */
function drawWingFeathers(a2, h2, o2, W, H, spec, pal, col, rnd) {
  const r = ATLAS.wing;
  const x0 = r.u0 * W, x1 = r.u1 * W;
  const y0 = (1 - r.v1) * H, y1 = (1 - r.v0) * H;
  const hgt = y1 - y0;
  const clip = (ctx) => { ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, hgt); ctx.clip(); };
  clip(a2); clip(h2); clip(o2);

  // three covert ranks across the outer face (around ≈ 0.28 … 0.72)
  const ranks = [
    { v: 0.30, h: 0.070, n: 26, a: 0.34 },
    { v: 0.40, h: 0.085, n: 22, a: 0.32 },
    { v: 0.50, h: 0.100, n: 18, a: 0.30 },
    { v: 0.61, h: 0.110, n: 15, a: 0.28 },
  ];
  for (const rank of ranks) {
    const cy = y0 + rank.v * hgt;
    const fh = rank.h * hgt;
    for (let i = 0; i < rank.n; i++) {
      const t = (i + 0.5) / rank.n;
      // coverts get longer and sweep back toward the tip
      const cx = x0 + t * (x1 - x0);
      const fw = ((x1 - x0) / rank.n) * (1.25 + 0.5 * t);
      const jt = (rnd() - 0.5);
      a2.save(); a2.translate(cx, cy); a2.rotate(-0.16 - 0.12 * t + jt * 0.05);
      h2.save(); h2.translate(cx, cy); h2.rotate(-0.16 - 0.12 * t + jt * 0.05);
      o2.save(); o2.translate(cx, cy); o2.rotate(-0.16 - 0.12 * t + jt * 0.05);
      const path = (ctx) => {
        ctx.beginPath();
        ctx.moveTo(-fw * 0.5, -fh * 0.15);
        ctx.bezierCurveTo(-fw * 0.42, fh * 0.72, -fw * 0.16, fh * 0.95, 0, fh * 0.95);
        ctx.bezierCurveTo(fw * 0.16, fh * 0.95, fw * 0.42, fh * 0.72, fw * 0.5, -fh * 0.15);
      };
      a2.lineCap = h2.lineCap = 'round';
      path(a2);
      a2.globalAlpha = rank.a * (0.7 + 0.5 * rnd());
      a2.strokeStyle = 'rgba(48,40,30,1)';
      a2.lineWidth = Math.max(1.2, fh * 0.10);
      a2.stroke();
      a2.globalAlpha = rank.a * 0.55;
      a2.strokeStyle = 'rgba(246,242,226,1)';
      a2.lineWidth = Math.max(1.0, fh * 0.07);
      a2.beginPath();
      a2.moveTo(-fw * 0.44, -fh * 0.22);
      a2.bezierCurveTo(-fw * 0.37, fh * 0.58, -fw * 0.14, fh * 0.78, 0, fh * 0.78);
      a2.bezierCurveTo(fw * 0.14, fh * 0.78, fw * 0.37, fh * 0.58, fw * 0.44, -fh * 0.22);
      a2.stroke();
      path(h2);
      h2.globalAlpha = 0.34;
      h2.strokeStyle = 'rgba(58,58,58,1)';
      h2.lineWidth = Math.max(1.2, fh * 0.13);
      h2.stroke();
      path(o2);
      o2.globalAlpha = 0.11;
      o2.strokeStyle = 'rgba(0,215,0,1)';
      o2.lineWidth = Math.max(1.0, fh * 0.11);
      o2.stroke();
      a2.restore(); h2.restore(); o2.restore();
    }
  }

  // long secondaries / primaries along the trailing half of the wing
  const nSec = 11;
  for (let i = 0; i < nSec; i++) {
    const t = i / (nSec - 1);
    const sx = x0 + (0.42 + 0.56 * t) * (x1 - x0);
    a2.globalAlpha = 0.30;
    a2.strokeStyle = 'rgba(40,34,26,1)';
    a2.lineWidth = 1.6;
    h2.globalAlpha = 0.30;
    h2.strokeStyle = 'rgba(70,70,70,1)';
    h2.lineWidth = 2.2;
    for (const ctx of [a2, h2]) {
      ctx.beginPath();
      ctx.moveTo(sx, y0 + 0.22 * hgt);
      ctx.quadraticCurveTo(sx + (x1 - x0) * 0.05, y0 + 0.45 * hgt, sx + (x1 - x0) * 0.10, y0 + 0.70 * hgt);
      ctx.stroke();
    }
  }
  a2.restore(); h2.restore(); o2.restore();
}

/* --------------------------------------------------------- the eye paint */

function drawEye(a2, h2, o2, m2, W, H, pal, col, spec) {
  const r = ATLAS.eye;
  const x0 = r.u0 * W, x1 = r.u1 * W;
  const y0 = (1 - r.v1) * H, y1 = (1 - r.v0) * H;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const R = Math.min(x1 - x0, y1 - y0) / 2;

  const grad = (ctx, stops, radius) => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    for (const s of stops) g.addColorStop(s[0], s[1]);
    ctx.fillStyle = g;
    ctx.fillRect(x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4);
  };

  const iris = pal.iris;
  a2.save();
  a2.beginPath(); a2.rect(x0, y0, x1 - x0, y1 - y0); a2.clip();
  grad(a2, [
    [0.00, '#07050a'],
    [0.26, '#080606'],
    [0.36, iris],
    [0.56, iris],
    [0.64, '#0d0805'],
    [0.70, '#000000'],
    [0.76, pal.eyering],
    [0.90, pal.eyering],
    [1.00, pal.backDark],
  ], R);
  // painted catchlight so the eye is alive even in shadow
  const g2 = a2.createRadialGradient(cx - R * 0.13, cy - R * 0.15, 0, cx - R * 0.13, cy - R * 0.15, R * 0.095);
  g2.addColorStop(0, 'rgba(255,253,246,0.98)');
  g2.addColorStop(0.5, 'rgba(255,248,232,0.42)');
  g2.addColorStop(1, 'rgba(255,255,255,0)');
  a2.fillStyle = g2;
  a2.fillRect(x0, y0, x1 - x0, y1 - y0);
  // a cooler bounce light low-right
  const g3 = a2.createRadialGradient(cx + R * 0.20, cy + R * 0.22, 0, cx + R * 0.20, cy + R * 0.22, R * 0.11);
  g3.addColorStop(0, 'rgba(140,200,235,0.42)');
  g3.addColorStop(1, 'rgba(150,205,235,0)');
  a2.fillStyle = g3;
  a2.fillRect(x0, y0, x1 - x0, y1 - y0);
  a2.restore();

  // height: a cornea bulge
  h2.save();
  h2.beginPath(); h2.rect(x0, y0, x1 - x0, y1 - y0); h2.clip();
  grad(h2, [[0, '#b4b4b4'], [0.55, '#8c8c8c'], [0.66, '#5e5e5e'], [0.78, '#909090'], [1, '#808080']], R);
  h2.restore();

  // orm: ao 1, roughness very low in the cornea, higher on the lid ring
  o2.save();
  o2.beginPath(); o2.rect(x0, y0, x1 - x0, y1 - y0); o2.clip();
  grad(o2, [[0, '#ff0c00'], [0.55, '#ff1200'], [0.66, '#c03800'], [0.80, '#b06e00'], [1, '#a07800']], R);
  o2.restore();

  // mask: clearcoat 1 over the cornea, no iridescence, low sheen
  m2.save();
  m2.beginPath(); m2.rect(x0, y0, x1 - x0, y1 - y0); m2.clip();
  grad(m2, [[0, '#0010ff'], [0.60, '#0010ff'], [0.70, '#000c80'], [0.85, '#000640'], [1, '#000440']], R);
  m2.restore();
}

/* -------------------------------------------------- vector feather rows */

function drawFeatherRows(a2, h2, o2, W, H, spec, pal, col, info, cum, circOf, pxPerM_v, rnd) {
  const rect = ATLAS.body;
  const kind = spec.kind;
  const yOf = (c) => (1 - (rect.v0 + (rect.v1 - rect.v0) * c)) * H;

  // feather size in metres by region  [cumFrom, cumTo, widthM, heightM, alpha]
  const fs = spec.featherScale;
  const bands = kind === 'duckling'
    ? [
      [0.00, 0.30, 0.0090, 0.0072, 0.075],
      [0.30, 0.62, 0.0105, 0.0084, 0.070],
      [0.62, cum.headBase, 0.0068, 0.0055, 0.055],
    ]
    : [
      [0.00, cum.tailBase, 0.0105, 0.0080, 0.17],
      [cum.tailBase, cum.rump, 0.0130, 0.0098, 0.16],
      [cum.rump, cum.bodyMid, 0.0165, 0.0120, 0.15],
      [cum.bodyMid, cum.bodyFront, 0.0180, 0.0130, 0.15],
      [cum.bodyFront, cum.neckBase, 0.0130, 0.0098, 0.13],
      [cum.neckBase, cum.headBase, 0.0075, 0.0060, 0.10],
      [cum.headBase, cum.billBase - 0.010, 0.0055, 0.0045, 0.07],
    ];

  a2.save();
  h2.save();
  o2.save();
  a2.beginPath(); a2.rect(0, yOf(1) - 1, W, yOf(0) - yOf(1) + 2); a2.clip();
  h2.beginPath(); h2.rect(0, yOf(1) - 1, W, yOf(0) - yOf(1) + 2); h2.clip();
  o2.beginPath(); o2.rect(0, yOf(1) - 1, W, yOf(0) - yOf(1) + 2); o2.clip();

  for (const [c0, c1, wM, hM, alpha] of bands) {
    const cMid = (c0 + c1) * 0.5;
    const rowH = Math.max(3, hM * pxPerM_v(cMid) * fs);
    const nRows = Math.max(1, Math.round(((c1 - c0) * (rect.v1 - rect.v0) * H) / rowH));
    for (let row = 0; row < nRows; row++) {
      const cRow = c0 + ((row + 0.5) / nRows) * (c1 - c0);
      const yc = yOf(cRow);
      const circ = circOf(cRow);
      const fw = Math.max(4, (wM * fs * W) / Math.max(0.06, circ));
      const nCols = Math.max(6, Math.round(W / fw));
      const stagger = (row * 0.37) % 1;
      for (let ci = 0; ci < nCols; ci++) {
        const u = ((ci + stagger + (rnd() - 0.5) * 0.22) / nCols);
        const x = u * W;
        const th = (u - 0.5) * 2 * Math.PI;
        const dorsal = Math.cos(th);
        // rows sag toward the belly and shear along the flow
        const sag = Math.sin(th) * rowH * 0.55;
        const y = yc + sag;
        const w = fw * (1.0 + (rnd() - 0.5) * 0.22);
        const hh = rowH * (1.05 + (rnd() - 0.5) * 0.25);
        const rot = Math.sin(th) * 0.30 + (rnd() - 0.5) * 0.16;

        /**
         * One feather = the visible free edge of an overlapping plate: a soft
         * shadow along the scalloped rim and a lighter lip just inside it.
         * Only the rim is drawn — stroking a closed outline reads as chainmail.
         */
        const drawScallop = (ctx, dark, light, aM, lw) => {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(rot);
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(-w * 0.50, hh * 0.10);
          ctx.bezierCurveTo(-w * 0.46, hh * 0.78, -w * 0.20, hh * 1.00, 0, hh * 1.00);
          ctx.bezierCurveTo(w * 0.20, hh * 1.00, w * 0.46, hh * 0.78, w * 0.50, hh * 0.10);
          ctx.strokeStyle = dark;
          ctx.lineWidth = Math.max(1.1, hh * lw);
          ctx.globalAlpha = aM;
          ctx.stroke();
          if (light) {
            ctx.globalAlpha = aM * 0.5;
            ctx.strokeStyle = light;
            ctx.lineWidth = Math.max(0.9, hh * lw * 0.55);
            ctx.beginPath();
            ctx.moveTo(-w * 0.44, hh * 0.02);
            ctx.bezierCurveTo(-w * 0.40, hh * 0.62, -w * 0.17, hh * 0.82, 0, hh * 0.82);
            ctx.bezierCurveTo(w * 0.17, hh * 0.82, w * 0.40, hh * 0.62, w * 0.44, hh * 0.02);
            ctx.stroke();
          }
          ctx.restore();
        };

        // albedo: soft dark rim + a pale lip catching the light
        const dk = kind === 'duckling' ? 'rgba(96,82,40,1)' : (dorsal > 0.2 ? 'rgba(44,38,30,1)' : 'rgba(104,106,104,1)');
        const lt = kind === 'duckling' ? 'rgba(255,246,206,1)' : 'rgba(248,246,236,1)';
        const bellyFade = 0.35 + 0.65 * smooth(-0.85, -0.05, dorsal);
        drawScallop(a2, dk, lt, alpha * (0.55 + 0.55 * Math.abs(Math.sin(th))) * bellyFade, 0.16);
        // height: a shallow step where one feather laps over the next
        drawScallop(h2, 'rgba(64,64,64,1)', 'rgba(190,190,190,1)', 0.26 * bellyFade, 0.20);
        // roughness (G channel): edges catch a little more diffusion
        drawScallop(o2, 'rgba(0,210,0,1)', null, 0.09, 0.18);
      }
    }
  }
  a2.restore();
  h2.restore();
  o2.restore();
}

/* ------------------------------------------------------------ normal map */

function normalFromHeight(hgtC, W, H, strength) {
  const src = ctx2d(hgtC).getImageData(0, 0, W, H).data;
  trace('normal:read');
  // Copy the single height channel into a flat Uint8Array first: sampling a
  // strided RGBA buffer eight times per pixel is what makes the naive version
  // slow, and this keeps the inner loop on a cache-friendly array.
  const hh = new Uint8Array(W * H);
  for (let i = 0, n = W * H; i < n; i++) hh[i] = src[i * 4];
  trace('normal:pack');
  const out = new Uint8ClampedArray(W * H * 4);
  const k = 1 / (255 * 3);
  // wrap tables — a modulo per tap per pixel is the whole cost otherwise
  const XM1 = new Int32Array(W), XP1 = new Int32Array(W);
  const XM2 = new Int32Array(W), XP2 = new Int32Array(W);
  for (let x = 0; x < W; x++) {
    XM1[x] = (x - 1 + W) % W; XP1[x] = (x + 1) % W;
    XM2[x] = (x - 2 + W) % W; XP2[x] = (x + 2) % W;
  }
  for (let y = 0; y < H; y++) {
    const ym1 = ((y - 1 + H) % H) * W;
    const yp1 = ((y + 1) % H) * W;
    const ym2 = ((y - 2 + H) % H) * W;
    const yp2 = ((y + 2) % H) * W;
    const y0 = y * W;
    for (let x = 0; x < W; x++) {
      const xm1 = XM1[x], xp1 = XP1[x], xm2 = XM2[x], xp2 = XP2[x];
      const dx = ((hh[y0 + xp1] - hh[y0 + xm1]) * 2 + (hh[y0 + xp2] - hh[y0 + xm2])) * k;
      const dy = ((hh[yp1 + x] - hh[ym1 + x]) * 2 + (hh[yp2 + x] - hh[ym2 + x])) * k;
      const nx = -dx * strength, ny = -dy * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const i = (y0 + x) * 4;
      out[i] = (nx * inv * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      out[i + 2] = (inv * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  trace('normal:sobel');
  const c = makeCanvas(W, H);
  ctx2d(c).putImageData(new ImageData(out, W, H), 0, 0);
  trace('normal:put');
  return c;
}

/* --------------------------------------------------------- down strands */

function makeStrandTexture(S, kind) {
  const c = makeCanvas(S, S);
  const g = ctx2d(c);
  g.fillStyle = '#000000';
  g.fillRect(0, 0, S, S);
  const rnd = makeRandom(5521);
  const n = kind === 'duckling' ? 2600 : 1400;
  for (let i = 0; i < n; i++) {
    const x = rnd() * S, y = rnd() * S;
    const r = 1.1 + rnd() * 2.6;
    const a = 0.35 + rnd() * 0.6;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(255,255,255,${a})`);
    gr.addColorStop(0.55, `rgba(255,255,255,${a * 0.4})`);
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}

/* ------------------------------------------------------------- materials */

// Per-material uniform bags live here rather than in userData: Material.copy()
// deep-clones userData through JSON, which would try to serialise every canvas
// texture into a data URL on each clone (hundreds of ms per duck).
const MAT_UNIFORMS = new WeakMap();
const MAT_DEFS = new WeakMap();

/** The live uniform bag for a duck material (wetness, blink, tint, spread). */
export function duckUniforms(mat) { return MAT_UNIFORMS.get(mat); }

const DUCK_CHUNK_PARS = /* glsl */ `
uniform sampler2D uMask;
uniform float uWetness;
uniform float uBlink;
uniform float uFuzz;
uniform float uWingSpread;
uniform vec3 uTint;
uniform vec3 uDownColor;
uniform vec3 uIridA;
uniform vec4 uEyeRect;
`;

/**
 * One material for the whole duck. Deliberately a MeshStandardMaterial with
 * hand-written sheen / thin-film iridescence / wet-coat terms rather than
 * MeshPhysicalMaterial: three's sheen+clearcoat+iridescence permutation is an
 * enormous shader that costs far more than the look is worth when 24 of these
 * are on screen (and takes minutes to compile on a software rasteriser).
 */
function buildDuckMaterial(tex, spec, pal) {
  const mat = new THREE.MeshStandardMaterial({
    map: tex.albedo,
    normalMap: tex.normal,
    aoMap: tex.orm,
    roughnessMap: tex.orm,
    metalness: 0.0,
    roughness: 1.0,
    normalScale: new THREE.Vector2(1.0, 1.0),
    envMapIntensity: 0.85,
    side: THREE.FrontSide,
  });
  mat.name = `duck-${spec.kind}`;
  const defs = () => ({
    uMask: { value: tex.mask },
    uWetness: { value: 0 },
    uBlink: { value: 0 },
    uFuzz: { value: spec.fuzz },
    uWingSpread: { value: 0 },
    uTint: { value: new THREE.Vector3(1, 1, 1) },
    uDownColor: { value: new THREE.Color(pal.down || '#e8c39a') },
    uIridA: { value: new THREE.Vector3(1.9, 0.0, 0.0) },
    uEyeRect: {
      value: new THREE.Vector4(
        (ATLAS.eye.u0 + ATLAS.eye.u1) * 0.5,
        (ATLAS.eye.v0 + ATLAS.eye.v1) * 0.5,
        (ATLAS.eye.u1 - ATLAS.eye.u0) * 0.5,
        (ATLAS.eye.v1 - ATLAS.eye.v0) * 0.5
      ),
    },
  });
  MAT_DEFS.set(mat, defs);
  MAT_UNIFORMS.set(mat, defs());

  mat.onBeforeCompile = function (shader) {
    Object.assign(shader.uniforms, MAT_UNIFORMS.get(this));

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aExtra;
uniform float uWingSpread;
varying float vPart;
varying float vFuzzT;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
vPart = aExtra.y;
vFuzzT = aExtra.z;
mat3 duckDeform = mat3(1.0);
if (aExtra.x != 0.0 && uWingSpread > 0.001) {
  float fi = aExtra.x;
  float ang = uWingSpread * 0.34 * abs(fi) * sign(fi);
  float ca = cos(ang), sa = sin(ang);
  duckDeform = mat3(ca, 0.0, -sa, 0.0, 1.0, 0.0, sa, 0.0, ca);
}
objectNormal = duckDeform * objectNormal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
if (aExtra.y == 2.0 && uWingSpread > 0.001) {
  // fan the primaries and lengthen the wing's chord as it opens
  transformed = duckDeform * transformed;
  transformed.y += uWingSpread * 0.030 * step(0.5, abs(aExtra.x));
}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
${DUCK_CHUNK_PARS}
varying float vPart;
varying float vFuzzT;
vec4 duckMask;
float duckWet;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
duckMask = texture2D(uMask, vMapUv);
duckWet = uWetness * duckMask.a;
diffuseColor.rgb *= uTint;
// wet plumage darkens and saturates
diffuseColor.rgb *= mix(1.0, 0.56, duckWet);
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.92, 0.97, 1.06), duckWet * 0.5);
// blink: lid sweeps over the eye region of the atlas
{
  vec2 d = (vMapUv - uEyeRect.xy) / uEyeRect.zw;
  float inEye = step(abs(d.x), 1.0) * step(abs(d.y), 1.0);
  float h = 1.0 - uBlink;
  float lid = smoothstep(h - 0.30, h + 0.05, abs(d.y)) * inEye;
  vec3 lidCol = diffuseColor.rgb * 0.0 + uDownColor * 0.42;
  diffuseColor.rgb = mix(diffuseColor.rgb, lidCol * (0.75 + 0.25 * smoothstep(h, h - 0.3, abs(d.y))), lid);
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.32 + 0.02, duckWet);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
if (duckWet > 0.01) {
  // clump the plumage normal when wet: a lower-frequency resample
  vec3 clump = texture2D(normalMap, vNormalMapUv * 0.34).xyz * 2.0 - 1.0;
  clump.xy *= normalScale * 1.7;
  vec3 cn = normalize(tbn * clump);
  normal = normalize(mix(normal, cn, duckWet * 0.65));
  // water beads sit proud on the back
  float bead = step(1.0 - duckWet * 0.9, texture2D(roughnessMap, vRoughnessMapUv).b);
  normal = normalize(normal + bead * duckWet * 0.9 * vec3(0.5, 0.5, 0.0));
}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
#if NUM_DIR_LIGHTS > 0
{
  float ndv = abs(dot(geometryNormal, geometryViewDir));
  float fres = pow(saturate(1.0 - ndv), 2.4);
  vec3 L = directionalLights[0].direction;
  vec3 lc = directionalLights[0].color;
  vec3 Hv = normalize(L + geometryViewDir);
  float ndl = dot(geometryNormal, L);
  float ndh = saturate(dot(geometryNormal, Hv));
  float back = saturate(-dot(geometryViewDir, L));
  float wrap = saturate(ndl * 0.5 + 0.5);
  float fuzz = duckMask.g * uFuzz;

  // --- thin-film iridescence (drake head, wing speculum). The phase is taken
  //     from the SMOOTH interpolated normal, not the normal-mapped one: driving
  //     a hue sweep with a high-frequency normal produces rainbow confetti.
  float ir = smoothstep(0.22, 0.70, duckMask.r);
  if (ir > 0.001) {
    vec3 sN = normalize(vNormal) * faceDirection;
    float sNdv = saturate(1.0 - abs(dot(sN, geometryViewDir)));
    vec3 sH = normalize(L + geometryViewDir);
    float phase = (1.0 - saturate(dot(geometryViewDir, sH))) * 1.35 + sNdv * 0.75;
    float ph = fract(phase * 0.62 + 0.08);
    vec3 hue = ph < 0.5
      ? mix(vec3(0.06, 0.42, 0.20), vec3(0.10, 0.52, 0.46), ph * 2.0)
      : mix(vec3(0.10, 0.52, 0.46), vec3(0.16, 0.20, 0.52), (ph - 0.5) * 2.0);
    hue *= uIridA.x;
    float glint = pow(saturate(dot(sN, sH)), 30.0);
    reflectedLight.directSpecular += lc * hue * ir
      * (glint * 0.42 + pow(sNdv, 3.2) * 0.20) * saturate(dot(sN, L) + 0.30);
    reflectedLight.indirectDiffuse += hue * ir * pow(sNdv, 3.5) * 0.055;
  }

  // --- velvet sheen: soft grazing bloom on the downy chest and flanks
  reflectedLight.directSpecular += lc * uDownColor * duckMask.g
    * pow(fres, 1.7) * saturate(ndl * 0.55 + 0.45) * 0.22 * (1.0 - duckWet * 0.7);

  // --- waxy bill / wet eye / wet plumage: one tight coat highlight
  float coat = clamp(duckMask.b + duckWet * 0.9, 0.0, 1.2);
  if (coat > 0.01) {
    reflectedLight.directSpecular += lc * coat * saturate(ndl + 0.08)
      * (pow(ndh, 120.0) * 0.75 + pow(saturate(1.0 - ndv), 5.0) * 0.30);
  }

  // --- backlit down: light scattering through the fluff at the silhouette
  reflectedLight.directDiffuse += lc * diffuseColor.rgb * (
      fuzz * (pow(back, 2.2) * 2.2 * fres + 0.34 * pow(back, 4.0))
    + 0.13 * fres * pow(back, 3.0)) * (1.0 - duckWet * 0.7);
  // --- warm rim on every silhouette
  reflectedLight.directDiffuse += lc * uDownColor * fres * wrap
    * (0.15 + 0.55 * fuzz) * (1.0 - duckWet * 0.5);
}
#endif`);
  };
  mat.customProgramCacheKey = () => 'duck-plumage-v5';
  return mat;
}

function cloneDuckMaterial(mat) {
  const m = mat.clone();
  const defs = MAT_DEFS.get(mat);
  MAT_DEFS.set(m, defs);
  MAT_UNIFORMS.set(m, defs());
  m.onBeforeCompile = mat.onBeforeCompile;
  m.customProgramCacheKey = mat.customProgramCacheKey;
  return m;
}

function buildFuzzMaterial(tex, spec, pal) {
  const mat = new THREE.MeshStandardMaterial({
    map: tex.albedo,
    alphaMap: tex.strand,
    transparent: true,
    depthWrite: false,
    roughness: 0.95,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: 0,
    // Additive: the down shell may only ADD light. Blended normally it reads
    // as a dirty grey outline instead of backlit fluff.
    blending: THREE.AdditiveBlending,
  });
  mat.name = `duck-down-${spec.kind}`;
  const defs = () => ({
    uDownColor: { value: new THREE.Color(pal.down || '#ffe9a8') },
    uFuzzAmt: { value: 1 },
    uWetness: { value: 0 },
  });
  MAT_DEFS.set(mat, defs);
  MAT_UNIFORMS.set(mat, defs());
  mat.onBeforeCompile = function (shader) {
    Object.assign(shader.uniforms, MAT_UNIFORMS.get(this));
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDuckN;\nvarying vec3 vDuckV;')
      .replace('#include <project_vertex>', `
vDuckN = normalize(mat3(modelMatrix) * objectNormal);
vDuckV = normalize(cameraPosition - (modelMatrix * vec4(transformed, 1.0)).xyz);
#include <project_vertex>`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vDuckN;
varying vec3 vDuckV;
uniform vec3 uDownColor;
uniform float uFuzzAmt;
uniform float uWetness;`)
      .replace('#include <alphamap_fragment>', `
float duckStrand = texture2D(alphaMap, vAlphaMapUv * 14.0).g;
float duckFres = pow(saturate(1.0 - abs(dot(vDuckN, vDuckV))), 3.0);
diffuseColor.a *= duckStrand * (0.02 + 2.10 * duckFres) * uFuzzAmt * (1.0 - uWetness * 0.9);`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
#if NUM_DIR_LIGHTS > 0
  vec3 fL = directionalLights[0].direction;
  float fBack = saturate(-dot(vDuckV, fL));
  reflectedLight.directDiffuse += directionalLights[0].color * uDownColor
      * (0.30 + 3.2 * pow(fBack, 2.0)) * duckFres;
#endif`);
  };
  mat.customProgramCacheKey = () => 'duck-down-v3';
  return mat;
}

/* ------------------------------------------------------------ asset cache */

const CACHE = new Map();

function getAsset(kind, palette) {
  const pal = typeof palette === 'string'
    ? (DUCK_PALETTES[palette] || DUCK_PALETTES[DEFAULT_PALETTE[kind]])
    : (palette || DUCK_PALETTES[DEFAULT_PALETTE[kind]]);
  const key = `${kind}|${pal.key || 'custom'}`;
  let e = CACHE.get(key);
  if (e) { e.refs++; return e; }

  const spec = specFor(kind);
  const t0 = performance.now();
  const built = buildDuckGeometry(spec, kind === 'duckling' ? 7717 : kind === 'hen' ? 4421 : 1337);

  // eye position in body UV space (used by the painter for the socket + stripe)
  {
    const ep = spec.eye;
    const N = spec.sections, R = spec.radial;
    const pos = built.geometry.attributes.position.array;
    const uvA = built.geometry.attributes.uv.array;
    let best = Infinity, bi = -1;
    for (let i = 0; i < N * (R + 1); i++) {
      const dx = pos[i * 3] - ep.x * 1.0;
      const dy = pos[i * 3 + 1] - ep.y;
      const dz = pos[i * 3 + 2] - ep.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) { best = d; bi = i; }
    }
    if (bi >= 0) {
      const u = uvA[bi * 2], v = uvA[bi * 2 + 1];
      built.info.eyeUV = {
        c: (v - ATLAS.body.v0) / (ATLAS.body.v1 - ATLAS.body.v0),
        th: (u - 0.5) * 2 * Math.PI,
      };
    }
  }

  trace('asset:eyeUV');
  const tex = paintDuckTextures(spec, pal, built.info);
  trace('asset:textures');
  const mat = buildDuckMaterial(tex, spec, pal);
  const fuzzMat = built.fuzzGeometry ? buildFuzzMaterial(tex, spec, pal) : null;
  trace('asset:materials');

  e = {
    key, kind, spec, pal, tex, mat, fuzzMat,
    geometry: built.geometry,
    fuzzGeometry: built.fuzzGeometry,
    boneIndex: built.boneIndex,
    info: built.info,
    triangles: built.info.triangles,
    buildMs: performance.now() - t0,
    refs: 1,
  };
  CACHE.set(key, e);
  return e;
}

function releaseAsset(e) {
  e.refs--;
  if (e.refs > 0) return;
  CACHE.delete(e.key);
  e.geometry.dispose();
  e.fuzzGeometry?.dispose();
  e.mat.dispose();
  e.fuzzMat?.dispose();
  for (const k in e.tex) e.tex[k]?.dispose?.();
}

/** Release every cached duck asset (for a full teardown). */
export function disposeDuckAssets() {
  for (const e of [...CACHE.values()]) { e.refs = 1; releaseAsset(e); }
}

/* -------------------------------------------------------------- skeleton */

function buildSkeleton(table) {
  const bones = [];
  const byName = {};
  for (const [name, parent, x, y, z] of table) {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    if (parent >= 0) {
      // Table positions are absolute rest positions; make them parent-relative.
      // (0,0,0) is the sentinel for "coincident with the parent" (toe bones).
      const p = table[parent];
      if (x === 0 && y === 0 && z === 0) b.position.set(0, 0, 0);
      else b.position.set(x - p[2], y - p[3], z - p[4]);
      bones[parent].add(b);
    }
    bones.push(b);
    byName[name] = b;
  }
  return { bones, byName, root: bones[0] };
}

/* -------------------------------------------------------- spring helper */

class Spring {
  constructor(v = 0, k = 90, d = 14) { this.v = v; this.t = v; this.dv = 0; this.k = k; this.d = d; }
  step(dt, target) {
    this.t = target;
    const a = (target - this.v) * this.k - this.dv * this.d;
    this.dv += a * dt;
    this.v += this.dv * dt;
    return this.v;
  }
  set(v) { this.v = v; this.dv = 0; this.t = v; }
}

/* ------------------------------------------------------------- the duck */

const EMPTY_PARAMS = {};
const POSE_NAMES = ['auto', 'idle', 'paddle', 'alert', 'dive', 'underwater', 'dabble', 'preen', 'sleep', 'stand'];

export function createDuck({
  variant = 'adult',
  scale = 1,
  palette = null,
  seed = 1,
  forward = '+z',
  castShadow = true,
  downShell = false,
} = {}) {
  const kind = VARIANT_KIND[variant] || 'drake';
  const asset = getAsset(kind, palette);
  const spec = asset.spec;
  const rnd = makeRandom((seed | 0) * 2654435761 % 2147483647 || 12345);

  const object = new THREE.Group();
  object.name = `duck-${variant}`;
  const flip = new THREE.Group();
  flip.name = 'duck-orient';
  if (forward === '-z') flip.rotation.y = Math.PI;
  object.add(flip);

  const { bones, byName, root } = buildSkeleton(spec.bones);
  flip.add(root);

  trace('duck:skeleton');
  const material = cloneDuckMaterial(asset.mat);
  trace('duck:material');
  // per-duck plumage tint jitter so a flock is never uniform
  const jt = (rnd() - 0.5) * 2;
  MAT_UNIFORMS.get(material).uTint.value.set(
    1 + jt * 0.05, 1 + jt * 0.015, 1 - jt * 0.035
  );

  const mesh = new THREE.SkinnedMesh(asset.geometry, material);
  mesh.name = 'duck-body';
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  flip.add(mesh);
  // Bone inverses are taken from the rest world matrices, so those must exist
  // before the Skeleton is constructed. The group is still at identity here.
  object.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton, mesh.matrixWorld);

  let fuzzMesh = null;
  if (asset.fuzzGeometry && downShell) {
    const fm = cloneDuckMaterial(asset.fuzzMat);
    fuzzMesh = new THREE.SkinnedMesh(asset.fuzzGeometry, fm);
    fuzzMesh.name = 'duck-down';
    fuzzMesh.castShadow = false;
    fuzzMesh.receiveShadow = false;
    fuzzMesh.renderOrder = 3;
    flip.add(fuzzMesh);
    fuzzMesh.updateMatrixWorld(true);
    fuzzMesh.bind(skeleton, fuzzMesh.matrixWorld);
  }

  const baseScale = spec.baseScale || 1;
  object.scale.setScalar(scale * baseScale);

  /* -------- rig shortcuts -------- */
  const b = byName;
  // Wing bones compose Y (swing the folded wing out from along the flank) then
  // Z (lift it). Default XYZ order applies Z first, which does nothing to a
  // wing lying along -Z.
  for (const n of ['shoulderR', 'shoulderL', 'wristR', 'wristL', 'tipR', 'tipL']) {
    byName[n].rotation.order = 'ZXY';
  }
  const neckChain = [b.neck0, b.neck1, b.neck2, b.neck3];
  const publicBones = {
    root: b.root, body: b.body, spine: b.spine,
    neck: b.neck2, neckChain, head: b.head, beak: b.jaw, jaw: b.jaw,
    tailBase: b.tailBase, tailFeathers: b.tailFeathers,
    wingL: b.shoulderL, wingR: b.shoulderR,
    wristL: b.wristL, wristR: b.wristR, tipL: b.tipL, tipR: b.tipR,
    hipL: b.hipL, hipR: b.hipR, footL: b.footL, footR: b.footR,
    toesL: [b.toeL0, b.toeL1, b.toeL2], toesR: [b.toeR0, b.toeR1, b.toeR2],
  };

  const uni = MAT_UNIFORMS.get(material);
  const fuzzUni = fuzzMesh ? MAT_UNIFORMS.get(fuzzMesh.material) : null;

  /* -------- animation state -------- */
  const st = {
    t: rnd() * 40,
    paddleP: rnd() * Math.PI * 2,
    breathP: rnd() * Math.PI * 2,
    idleSeed: rnd() * 100,
    blink: 0,
    blinkT: 1 + rnd() * 3,
    lookT: 1.5 + rnd() * 4,
    lookYaw: 0, lookPitch: 0,
    flickT: 3 + rnd() * 5,
    flick: 0,
    shake: 0,
    quack: 0,
    flapT: 0,
    flapCount: 0,
    diveT: 0,
    wasSub: false,
    pose: 'auto',
    wetness: 0,
    speed: 0,
  };

  const sp = {
    headYaw: new Spring(0, 120, 17),
    headPitch: new Spring(0, 120, 17),
    neckExt: new Spring(0, 70, 13),
    bank: new Spring(0, 60, 12),
    pitch: new Spring(0, 70, 14),
    lift: new Spring(0, 90, 15),
    tail: new Spring(0, 80, 13),
    wing: new Spring(0, 110, 15),
    spread: new Spring(0, 90, 14),
    submerge: new Spring(0, 34, 11),
    dabble: new Spring(0, 30, 10),
    preen: new Spring(0, 26, 9),
    alert: new Spring(0, 30, 10),
    paddleAmt: new Spring(0, 26, 10),
    wet: new Spring(0, 12, 7),
    throat: new Spring(0, 130, 16),
    jaw: new Spring(0, 200, 20),
    lagX: new Spring(0, 55, 9),
    lagY: new Spring(0, 55, 9),
  };

  // scratch (no per-frame allocation)
  const _q = new THREE.Quaternion();
  const _lv = new THREE.Vector3();
  const _prevQ = new THREE.Quaternion();
  const _dq = new THREE.Quaternion();
  const _e = new THREE.Euler();
  let _lastYaw = 0;
  // hoisted scratch — update() must not allocate
  const SIDES = [1, -1];
  const TOE_FAN = [-1, 0, 1];
  const _legPhase = new Float64Array(2);
  const NECK_W = [0.34, 0.30, 0.22, 0.14];
  const NECK_UP = [0.10, 0.22, 0.32, 0.36];
  const NECK_REST = [0.16, 0.02, -0.10, -0.12];
  const NECK_EXT = [0.30, 0.36, 0.24, 0.10];
  const NECK_PREEN_Y = [0.18, 0.26, 0.22, 0.10];
  const NECK_PREEN_Z = [0.10, 0.16, 0.14, 0.06];

  const noise = asset.info.noise || (asset.info.noise = new Noise(3313));

  function resetPose() {
    for (const bone of bones) {
      bone.rotation.set(0, 0, 0);
      bone.scale.set(1, 1, 1);
    }
    b.body.position.set(spec.bones[1][2], spec.bones[1][3], spec.bones[1][4]);
  }

  const api = {
    object,
    bones: publicBones,
    skeleton,
    mesh,
    fuzzMesh,
    material,
    variant,
    kind,
    scale: scale * baseScale,
    baseScale,
    palette: asset.pal,
    triangles: asset.triangles,
    waterlineY: 0,
    forwardAxis: new THREE.Vector3(0, 0, forward === '-z' ? -1 : 1),
    /** Fired when the duck shakes off water — hook particles/audio here. */
    onSpray: null,
    onFlap: null,
    onQuack: null,
    wetness: 0,

    setPose(name) {
      st.pose = POSE_NAMES.includes(name) ? name : 'auto';
      return api;
    },
    setWetness(w) { st.wetness = clamp(w, 0, 1); sp.wet.set(st.wetness); return api; },
    quack() { st.quack = 1; return api; },
    flap(n = 2) { st.flapT = 1e-4; st.flapCount = n; return api; },
    shake() { st.shake = 1; if (api.onSpray) api.onSpray(); return api; },
    /** Approximate world position of the head (camera / bubble emission). */
    headPosition(out = new THREE.Vector3()) {
      b.head.updateWorldMatrix(true, false);
      return out.setFromMatrixPosition(b.head.matrixWorld);
    },
    billPosition(out = new THREE.Vector3()) {
      b.jaw.updateWorldMatrix(true, false);
      return out.setFromMatrixPosition(b.jaw.matrixWorld);
    },
    setAnisotropy(n) {
      for (const k in asset.tex) if (asset.tex[k]) { asset.tex[k].anisotropy = n; asset.tex[k].needsUpdate = true; }
      return api;
    },

    update(dt, params) {
      const p = params || EMPTY_PARAMS;
      dt = clamp(dt || 0, 0, 1 / 15);
      st.t += dt;
      const T = st.t;

      const speed = p.speed ?? 0;
      const turn = clamp(p.turn ?? 0, -1, 1);
      const subIn = p.submerged ? 1 : (p.submerged === 0 ? 0 : (p.submerged || 0));
      const dabbleIn = clamp(p.dabble ?? 0, 0, 1);
      const preenIn = clamp(p.preen ?? 0, 0, 1);
      const pose = st.pose;

      // --- pose overrides
      let subTarget = clamp(subIn, 0, 1);
      let dabTarget = dabbleIn;
      let alertTarget = 0;
      let paddleTarget = p.paddle != null ? clamp(p.paddle, 0, 1) : clamp(speed / 2.2, 0, 1);
      let preenTarget = preenIn;
      if (pose === 'idle') { paddleTarget = 0; }
      else if (pose === 'paddle') { paddleTarget = Math.max(paddleTarget, 0.85); }
      else if (pose === 'alert') { alertTarget = 1; paddleTarget = Math.min(paddleTarget, 0.15); }
      else if (pose === 'dive' || pose === 'underwater') { subTarget = 1; }
      else if (pose === 'dabble') { dabTarget = 1; }
      else if (pose === 'preen') { preenTarget = 1; }
      else if (pose === 'sleep') { paddleTarget = 0; }
      if (p.alert) alertTarget = Math.max(alertTarget, clamp(p.alert, 0, 1));

      const sub = sp.submerge.step(dt, subTarget);
      const dab = sp.dabble.step(dt, dabTarget * (1 - sub * 0.7));
      const pre = sp.preen.step(dt, preenTarget * (1 - sub) * (1 - dab));
      const alert = sp.alert.step(dt, alertTarget * (1 - sub) * (1 - dab));
      const pad = sp.paddleAmt.step(dt, paddleTarget);

      // --- dive / surface transitions
      const nowSub = subTarget > 0.5;
      if (nowSub && !st.wasSub) { st.diveT = 0.001; }
      if (!nowSub && st.wasSub) { st.shake = 1; st.flapT = 1e-4; st.flapCount = 2; if (api.onSpray) api.onSpray(); }
      st.wasSub = nowSub;
      if (st.diveT > 0) { st.diveT += dt; if (st.diveT > 0.85) st.diveT = 0; }
      const diveKick = st.diveT > 0 ? Math.sin(clamp(st.diveT / 0.85, 0, 1) * Math.PI) : 0;

      // --- wetness
      const wetTarget = p.wetness != null ? clamp(p.wetness, 0, 1)
        : (nowSub ? 1 : Math.max(0, st.wetness - dt * 0.055));
      st.wetness = wetTarget;
      const wet = sp.wet.step(dt, wetTarget);
      api.wetness = wet;
      uni.uWetness.value = wet;
      if (fuzzUni) fuzzUni.uWetness.value = wet;

      // --- shake
      if (st.shake > 0) st.shake = Math.max(0, st.shake - dt * 1.9);
      const shake = st.shake;

      // --- quack
      if (p.quack) st.quack = Math.max(st.quack, clamp(p.quack, 0, 1) > 0.5 ? 1 : st.quack);
      if (st.quack > 0) { st.quack = Math.max(0, st.quack - dt * 2.6); }
      const q = st.quack;
      const qOpen = q > 0 ? Math.pow(Math.sin(Math.min(1, (1 - q) * 1.7) * Math.PI), 0.7) : 0;

      // --- flap
      if (p.flap && st.flapT <= 0) { st.flapT = 1e-4; st.flapCount = 2; }
      let flapPhase = 0;
      if (st.flapT > 0) {
        st.flapT += dt * 3.4;
        if (st.flapT >= st.flapCount) { st.flapT = 0; }
        else flapPhase = st.flapT;
      }
      const flapCyc = flapPhase > 0 ? Math.sin(flapPhase * Math.PI * 2) : 0;
      const flapEnv = flapPhase > 0 ? Math.min(1, Math.sin(clamp(flapPhase / st.flapCount, 0, 1) * Math.PI) * 2.2) : 0;
      const wingOpen = sp.wing.step(dt, flapEnv * 0.5 + (flapPhase > 0 ? 0.5 : 0) * flapEnv);
      const spread = sp.spread.step(dt, flapEnv);
      uni.uWingSpread.value = spread;

      // --- paddle cycle
      const strokeHz = lerp(1.15, 2.7, clamp(speed / 4.6, 0, 1.3));
      st.paddleP += dt * strokeHz * Math.PI * 2 * (0.35 + 0.65 * pad + sub * 0.5);
      const ph = st.paddleP;
      _legPhase[0] = ph; _legPhase[1] = ph + Math.PI;

      resetPose();

      /* ---------------- body ---------------- */
      const breath = Math.sin(T * 1.45 + st.breathP);
      const bodyPitch =
        -0.030 * pad * Math.sin(ph * 2 + 0.6)
        + sub * 0.52 + diveKick * 0.62 + dab * 1.30
        - 0.05 * pad * clamp(speed / 4.6, 0, 1)
        + flapEnv * -0.16;
      const bodyRoll = -turn * 0.20 * (1 - sub * 0.6) + 0.018 * pad * Math.sin(ph);
      const bodyYaw = 0.030 * pad * Math.sin(ph) * (1 - sub * 0.7);
      b.body.rotation.set(bodyPitch, bodyYaw, bodyRoll);
      b.body.position.y += 0.004 * breath
        + 0.0055 * pad * Math.sin(ph * 2)
        + flapEnv * 0.030 * Math.max(0, flapCyc)
        + dab * 0.020;
      b.body.position.z += -dab * 0.018 - sub * 0.010;
      b.spine.scale.set(1 + 0.012 * breath + 0.02 * pre, 1 + 0.016 * breath, 1);

      /* ---------------- neck + head ---------------- */
      // look direction -> local yaw/pitch
      let lookYaw = 0, lookPitch = 0;
      if (p.look) {
        _q.copy(object.quaternion).invert();
        _lv.copy(p.look);
        if (_lv.lengthSq() > 1e-8) {
          _lv.normalize().applyQuaternion(_q);
          if (forward === '-z') { _lv.x = -_lv.x; _lv.z = -_lv.z; }
          lookYaw = clamp(Math.atan2(_lv.x, Math.max(0.15, _lv.z)), -1.25, 1.25);
          lookPitch = clamp(-Math.asin(clamp(_lv.y, -1, 1)), -0.8, 0.8);
        }
      }

      // idle look-around
      st.lookT -= dt;
      if (st.lookT <= 0) {
        st.lookT = 1.6 + rnd() * 5.0;
        st.lookYaw = (rnd() - 0.5) * 1.5;
        st.lookPitch = (rnd() - 0.5) * 0.35;
      }
      const idleAmt = (1 - pad * 0.55) * (1 - sub) * (1 - dab) * (1 - pre);
      const micro = noise.noise2(T * 0.55, st.idleSeed) * 0.10 + noise.noise2(T * 1.9, st.idleSeed + 8) * 0.035;
      const microP = noise.noise2(T * 0.7, st.idleSeed + 20) * 0.07;

      const yawTarget = lookYaw + (st.lookYaw * 0.55 + micro) * idleAmt
        + shake * Math.sin(T * 58) * 0.55
        + pre * 1.05;
      const pitchTarget = lookPitch + (st.lookPitch * 0.5 + microP) * idleAmt
        + sub * -0.30 - diveKick * 0.55 + dab * -0.85
        + pre * 0.85 + q * 0.10 * qOpen - alert * 0.14;

      const hy = sp.headYaw.step(dt, yawTarget);
      const hp = sp.headPitch.step(dt, pitchTarget);

      // secondary motion: the head lags the body
      _dq.copy(_prevQ).invert().premultiply(object.quaternion);
      _e.setFromQuaternion(_dq, 'YXZ');
      _prevQ.copy(object.quaternion);
      const yawRate = clamp(_e.y / Math.max(dt, 1e-3), -6, 6);
      _lastYaw = lerp(_lastYaw, yawRate, 0.25);
      const lagY = sp.lagY.step(dt, clamp(-_lastYaw * 0.055, -0.35, 0.35));
      const lagX = sp.lagX.step(dt, clamp(-turn * turn * 0.06 - pad * 0.02 * Math.sin(ph * 2), -0.3, 0.3));

      // neck shape: S-curve at rest, extended forward when swimming/diving
      const ext = sp.neckExt.step(dt,
        clamp(speed / 4.6, 0, 1) * 0.35 + sub * 1.0 + dab * 0.55 + alert * 0.9 - pre * 0.3);
      const stretch = 1 + alert * 0.28 + sub * 0.20 + dab * 0.16 - pre * 0.08 + q * 0.05 * qOpen;

      for (let i = 0; i < 4; i++) {
        const bn = neckChain[i];
        const w = NECK_W[i];
        const wUp = NECK_UP[i];
        // rest S-curve: lean back low, forward high
        const rest = NECK_REST[i] * (1 - sub * 0.8 - dab * 0.6);
        bn.rotation.x = rest + hp * wUp + ext * NECK_EXT[i] + lagX * w
          + 0.012 * pad * Math.sin(ph * 2 + 1.1) * (1 - sub)
          + 0.008 * breath;
        bn.rotation.y = hy * w * 0.85 + lagY * w + pre * NECK_PREEN_Y[i];
        bn.rotation.z = (-bodyRoll * 0.30 + turn * 0.05) * (1 - sub * 0.5) + pre * NECK_PREEN_Z[i];
        bn.scale.y = i < 3 ? stretch : 1;
        if (i === 2) bn.scale.x = bn.scale.z = 1 + sp.throat.step(dt, qOpen * 0.22 + q * 0.06);
      }

      b.head.rotation.x = hp * 0.34 - ext * 0.42 * (sub + dab) * 0.5 + alert * -0.06;
      b.head.rotation.y = hy * 0.30 + lagY * 0.20;
      b.head.rotation.z = -bodyRoll * 0.55 + turn * 0.10 + pre * -0.55 + shake * Math.sin(T * 58 + 1.1) * 0.35;
      b.head.scale.set(1, 1, 1 + q * 0.02 * qOpen);

      // jaw: quack, preen nibble, dabble sift
      const nibble = pre > 0.4 ? Math.max(0, Math.sin(T * 15)) * 0.35 : 0;
      const sift = dab > 0.4 ? Math.max(0, Math.sin(T * 11)) * 0.30 : 0;
      b.jaw.rotation.x = sp.jaw.step(dt, qOpen * 0.52 + nibble + sift);

      /* ---------------- tail ---------------- */
      st.flickT -= dt;
      if (st.flickT <= 0) { st.flickT = 2.5 + rnd() * 6; st.flick = 1; }
      if (st.flick > 0) st.flick = Math.max(0, st.flick - dt * 4.5);
      const flick = st.flick;
      const tailUp = sp.tail.step(dt,
        0.10 + dab * 1.05 + sub * 0.30 + diveKick * 0.85 - 0.14 * pad + flick * 0.35);
      b.tailBase.rotation.x = -tailUp * 0.55 + 0.02 * breath;
      b.tailBase.rotation.y = Math.sin(T * 6.5) * flick * 0.25 + bodyYaw * -0.4;
      b.tailFeathers.rotation.x = -tailUp * 0.30 - lagX * 0.5 + 0.03 * Math.sin(T * 2.1);
      b.tailFeathers.rotation.y = flick * Math.sin(T * 9) * 0.30;
      b.tailFeathers.scale.set(1 + spread * 0.35, 1, 1);

      /* ---------------- wings ---------------- */
      for (let si = 0; si < 2; si++) {
        const side = SIDES[si];
        const sh = side > 0 ? b.shoulderR : b.shoulderL;
        const wr = side > 0 ? b.wristR : b.wristL;
        const tp = side > 0 ? b.tipR : b.tipL;
        const beat = flapCyc;
        const up = Math.max(0, beat), down = Math.max(0, -beat);
        // clamp tight to the body when submerged
        const clampIn = sub * 0.22 + diveKick * 0.10;
        // y: swing the wing out from the flank. z: the actual beat.
        sh.rotation.y = side * (-wingOpen * 1.30 + clampIn * 0.20);
        sh.rotation.z = side * (wingOpen * 0.30 + up * 0.95 - down * 0.40);
        sh.rotation.x = -wingOpen * 0.10 - down * 0.10 + clampIn * 0.05;
        wr.rotation.y = side * (-wingOpen * 0.62);
        wr.rotation.z = side * (down * 0.50 - up * 0.30);
        wr.rotation.x = wingOpen * 0.12;
        tp.rotation.y = side * (-wingOpen * 0.40 - spread * 0.20);
        tp.rotation.z = side * (down * 0.30);
        // tiny idle settle
        sh.rotation.z += side * 0.012 * Math.sin(T * 1.1 + side);
      }

      /* ---------------- legs + webbed feet ---------------- */
      const legAmt = clamp(pad * 0.9 + sub * 0.6 + dab * 0.8, 0, 1);
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? 1 : -1;
        const hip = side > 0 ? b.hipR : b.hipL;
        const ank = side > 0 ? b.footR : b.footL;
        const toes = side > 0 ? publicBones.toesR : publicBones.toesL;
        // underwater the legs beat in unison, on the surface they alternate
        const phase = lerp(_legPhase[i], _legPhase[0], sub);
        const push = Math.sin(phase);            // +1 = mid power stroke
        const swing = -Math.cos(phase);
        hip.rotation.x = 0.16 + legAmt * (0.62 * swing) + sub * 0.10 + dab * 0.22;
        hip.rotation.z = side * (0.10 + legAmt * 0.06 * push);
        ank.rotation.x = -0.30 - legAmt * (0.55 * swing + 0.15) + sub * 0.15;
        ank.rotation.y = side * legAmt * 0.10 * push;
        // web opens on the push, folds on the return
        const open = clamp(0.5 + 0.5 * push, 0, 1);
        const openAmt = lerp(0.25, 1.0, open) * (0.35 + 0.65 * legAmt);
        for (let k = 0; k < 3; k++) {
          const fanA = TOE_FAN[k];
          toes[k].rotation.y = side * fanA * (1 - openAmt) * -0.55;
          toes[k].rotation.x = (1 - openAmt) * 0.30;
          toes[k].scale.set(1, 1, lerp(0.72, 1.0, openAmt));
        }
      }

      /* ---------------- blink ---------------- */
      st.blinkT -= dt;
      if (st.blinkT <= 0) {
        st.blinkT = 2.2 + rnd() * 4.5;
        st.blink = 1e-4;
      }
      if (st.blink > 0) {
        st.blink += dt * 7.5;
        if (st.blink >= 1) st.blink = 0;
      }
      const blinkV = st.blink > 0 ? Math.sin(clamp(st.blink, 0, 1) * Math.PI) : 0;
      uni.uBlink.value = Math.max(blinkV, sub * 0.20, pose === 'sleep' ? 1 : 0);

      if (fuzzUni) fuzzUni.uFuzzAmt.value = 1 - sub * 0.35;
      st.speed = speed;
      return api;
    },

    dispose() {
      object.removeFromParent();
      material.dispose();
      fuzzMesh?.material.dispose();
      skeleton.dispose?.();
      releaseAsset(asset);
    },
  };

  _prevQ.copy(object.quaternion);
  resetPose();
  api.update(0.016, EMPTY_PARAMS);
  trace('duck:done');
  return api;
}

/* ------------------------------------------------------------------------ */
/* Preview harness. NEVER called by the game — the shot spec calls it        */
/* explicitly (tools/shots/duck.json). Nothing is added to the scene unless  */
/* you call this.                                                           */
/* ------------------------------------------------------------------------ */

export function createDuckPreview(scene, opts = {}) {
  const list = opts.ducks || [
    { variant: 'drake', x: 0, z: 0, ry: 0 },
  ];
  const ducks = [];
  // A stand-in water plane so preview frames have a horizon and a reflection
  // to sit against instead of a black void. Preview only.
  let ground = null;
  if (opts.ground !== false) {
    const g = new THREE.CircleGeometry(160, 48);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x2b4a52),
      roughness: 0.10,
      metalness: 0.0,
      envMapIntensity: 1.4,
    });
    ground = new THREE.Mesh(g, m);
    ground.name = 'duck-preview-water';
    ground.receiveShadow = true;
    scene.add(ground);
  }
  for (const d of list) {
    const duck = createDuck({
      variant: d.variant || 'drake',
      scale: d.scale || 1,
      palette: d.palette || null,
      seed: d.seed || 1,
    });
    duck.object.position.set(d.x || 0, d.y || 0, d.z || 0);
    duck.object.rotation.y = d.ry || 0;
    if (d.pose) duck.setPose(d.pose);
    if (d.wetness != null) duck.setWetness(d.wetness);
    duck.params = d.params || {};
    scene.add(duck.object);
    ducks.push(duck);
  }
  const handle = {
    ducks,
    ground,
    step(seconds, dt = 1 / 60) {
      const n = Math.max(1, Math.round(seconds / dt));
      for (let i = 0; i < n; i++) for (const d of ducks) d.update(dt, d.params);
      return handle;
    },
    dispose() {
      for (const d of ducks) d.dispose();
      ducks.length = 0;
      if (ground) { ground.removeFromParent(); ground.geometry.dispose(); ground.material.dispose(); }
    },
    info: [...CACHE.values()].map((e) => ({ kind: e.kind, tris: e.triangles, buildMs: +e.buildMs.toFixed(1) })),
  };
  return handle;
}
