/**
 * Ground / rock materials for the riverbanks.
 *
 * Owned by the terrain system (see CONTRACT.md ownership table).
 *
 * Everything here is procedural: three tiling data textures are baked once with
 * canvas 2D + seeded noise, then splatted in a MeshStandardMaterial patched via
 * onBeforeCompile. The splat is driven by height above the waterline, slope and
 * several scales of noise, so the banks read as layered river ground rather than
 * as one noise texture:
 *
 *   silt → wet band → sand/gravel shelf → cobbles → moist earth → grass →
 *   dry ochre grass → exposed rock
 *
 * Anti-tiling comes from three things at once: multi-scale sampling (each octave
 * of UV scale rotated so the repeats never line up), a simplex domain warp, and
 * macro colour variation over 20–300 m so no two stretches of bank match.
 */

import * as THREE from 'three';
import { GLSL_NOISE, makeRandom } from '../core/noise.js';

// ── palette ────────────────────────────────────────────────────────────────
// Warm/cool complementary scheme: honeyed sand and ochre grass against cool
// teal-leaning silt. Tuned under a low sun; never grey, never flat.
export const GROUND_PALETTE = {
  siltWet: 0x2c3630,   // wet dark silt at the waterline
  siltDeep: 0x17262a,  // deeper bed, colder and greener
  sand: 0xa98b5c,      // honeyed sand on the beach shelf
  cobble: 0x847b6d,    // river cobbles, warm grey
  earth: 0x54401f,     // moist earth with roots
  grassCool: 0x3c5c33, // deep shadowed bank green
  grassWarm: 0x687f38, // sunlit yellow-green
  grassDry: 0x826d36,  // drier ochre grass on the hillsides
  rock: 0x8b8378,      // exposed rock
  shadowTint: 0x8fb4d6, // cool bounce multiplied into unlit faces
};

// ── tiling noise helpers (seamless, seeded) ────────────────────────────────
// Simplex noise does not tile, so the baked maps use a periodic value-noise
// lattice instead: wrapping the integer lattice coordinates guarantees the
// texture repeats without a seam.

function hash2i(x, y, seed) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function wrap(i, n) {
  return ((i % n) + n) % n;
}

/** Periodic value noise with `period` cells across the tile. */
function tileValue(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const x0 = wrap(xi, period), x1 = wrap(xi + 1, period);
  const y0 = wrap(yi, period), y1 = wrap(yi + 1, period);
  const a = hash2i(x0, y0, seed), b = hash2i(x1, y0, seed);
  const c = hash2i(x0, y1, seed), d = hash2i(x1, y1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function tileFbm(x, y, period, seed, octaves = 4) {
  let sum = 0, amp = 0.5, norm = 0, p = period, fx = x, fy = y;
  for (let o = 0; o < octaves; o++) {
    sum += amp * tileValue(fx, fy, p, seed + o * 131);
    norm += amp;
    amp *= 0.5;
    fx *= 2; fy *= 2; p *= 2;
  }
  return sum / norm;
}

function tileRidged(x, y, period, seed, octaves = 4) {
  let sum = 0, amp = 0.5, norm = 0, p = period, fx = x, fy = y;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(tileValue(fx, fy, p, seed + o * 91) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    fx *= 2; fy *= 2; p *= 2;
  }
  return sum / norm;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function dataTexture(data, size, aniso) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso || 4;
  t.colorSpace = THREE.NoColorSpace; // pure detail data, never a colour
  t.needsUpdate = true;
  return t;
}

/** height field → tangent-space normal XY packed into RG (Z is implicit). */
function heightToNormalRG(height, size, strength, out, rOff, gOff, stride) {
  for (let j = 0; j < size; j++) {
    const jm = ((j - 1) + size) % size, jp = (j + 1) % size;
    for (let i = 0; i < size; i++) {
      const im = ((i - 1) + size) % size, ip = (i + 1) % size;
      const hl = height[j * size + im], hr = height[j * size + ip];
      const hd = height[jm * size + i], hu = height[jp * size + i];
      let nx = (hl - hr) * strength;
      let ny = (hd - hu) * strength;
      const len = Math.sqrt(nx * nx + ny * ny + 1);
      nx /= len; ny /= len;
      const o = (j * size + i) * stride;
      out[o + rOff] = Math.round((nx * 0.5 + 0.5) * 255);
      out[o + gOff] = Math.round((ny * 0.5 + 0.5) * 255);
    }
  }
}

// ── baked maps ─────────────────────────────────────────────────────────────

/**
 * Detail map.
 *   R fine grit (sand/blade scale)   G mid mottle (earth patches)
 *   B streaks (grass blades, roots)  A macro patchM mask
 */
export function makeDetailTexture(size = 512, seed = 1201, aniso = 4) {
  const data = new Uint8Array(size * size * 4);
  const inv = 1 / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = i * inv, y = j * inv;
      // fine grit — high frequency, high contrast
      let grit = tileFbm(x * 46, y * 46, 46, seed, 2);
      grit = clamp01((grit - 0.5) * 1.9 + 0.5);
      // mid mottle
      const mot = tileFbm(x * 7, y * 7, 7, seed + 7, 4);
      // streaks: strongly anisotropic, then broken up
      const stA = tileFbm(x * 60, y * 5, 60, seed + 21, 2);
      const stB = tileFbm(x * 9, y * 11, 9, seed + 33, 2);
      const streak = clamp01((stA * 0.72 + stB * 0.42 - 0.24) * 1.8);
      // macro patches
      const mac = tileFbm(x * 2, y * 2, 2, seed + 55, 3);
      const o = (j * size + i) * 4;
      data[o] = (grit * 255) | 0;
      data[o + 1] = (clamp01(mot) * 255) | 0;
      data[o + 2] = (streak * 255) | 0;
      data[o + 3] = (clamp01((mac - 0.5) * 1.35 + 0.5) * 255) | 0;
    }
  }
  const t = dataTexture(data, size, aniso);
  t.name = 'terrain-detail';
  return t;
}

/**
 * Cobble / pebble map, drawn as overlapping domes with canvas 2D so the
 * silhouettes are real packed stones rather than blobby noise.
 *   RG normal.xy   B per-pebble random id   A pebble height
 */
export function makeCobbleTexture(size = 512, seed = 9061, aniso = 4) {
  const hc = document.createElement('canvas');
  hc.width = hc.height = size;
  const hg = hc.getContext('2d', { willReadFrequently: true });
  const ic = document.createElement('canvas');
  ic.width = ic.height = size;
  const ig = ic.getContext('2d', { willReadFrequently: true });
  hg.fillStyle = '#000'; hg.fillRect(0, 0, size, size);
  ig.fillStyle = '#808080'; ig.fillRect(0, 0, size, size);
  hg.globalCompositeOperation = 'lighten';

  const rnd = makeRandom(seed);
  const dome = (g, peak) => {
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    const p = Math.round(peak * 255);
    const stop = (t, v) => grd.addColorStop(t, `rgb(${(p * v) | 0},${(p * v) | 0},${(p * v) | 0})`);
    stop(0, 1); stop(0.32, 0.97); stop(0.56, 0.87);
    stop(0.74, 0.70); stop(0.88, 0.47); stop(0.97, 0.18); stop(1, 0);
    return grd;
  };

  // three size bands: cobbles, pebbles, gravel
  const bands = [
    { n: 34, rMin: 0.055, rMax: 0.098, peak: 1.0 },
    { n: 130, rMin: 0.024, rMax: 0.05, peak: 0.82 },
    { n: 520, rMin: 0.006, rMax: 0.018, peak: 0.6 },
  ];
  for (const band of bands) {
    for (let k = 0; k < band.n; k++) {
      const cx = rnd() * size, cy = rnd() * size;
      const r = (band.rMin + rnd() * (band.rMax - band.rMin)) * size;
      const rot = rnd() * Math.PI;
      const sq = 0.62 + rnd() * 0.38;
      const peak = band.peak * (0.72 + rnd() * 0.28);
      const id = 0.12 + rnd() * 0.88;
      // draw 9 times so the tile wraps seamlessly
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const px = cx + ox * size, py = cy + oy * size;
          if (px < -r * 1.6 || px > size + r * 1.6 || py < -r * 1.6 || py > size + r * 1.6) continue;
          hg.save();
          hg.translate(px, py); hg.rotate(rot); hg.scale(r, r * sq);
          hg.fillStyle = dome(hg, peak);
          hg.beginPath(); hg.arc(0, 0, 1, 0, Math.PI * 2); hg.fill();
          hg.restore();
          ig.save();
          ig.translate(px, py); ig.rotate(rot); ig.scale(r * 0.94, r * sq * 0.94);
          ig.fillStyle = `rgb(${(id * 255) | 0},${(id * 255) | 0},${(id * 255) | 0})`;
          ig.beginPath(); ig.arc(0, 0, 1, 0, Math.PI * 2); ig.fill();
          ig.restore();
        }
      }
    }
  }

  const hPix = hg.getImageData(0, 0, size, size).data;
  const iPix = ig.getImageData(0, 0, size, size).data;
  const height = new Float32Array(size * size);
  for (let p = 0; p < size * size; p++) height[p] = hPix[p * 4] / 255;

  const data = new Uint8Array(size * size * 4);
  heightToNormalRG(height, size, size * 0.022, data, 0, 1, 4);
  for (let p = 0; p < size * size; p++) {
    data[p * 4 + 2] = iPix[p * 4];
    data[p * 4 + 3] = hPix[p * 4];
  }
  const t = dataTexture(data, size, aniso);
  t.name = 'terrain-cobble';
  return t;
}

/**
 * Fractured rock map.
 *   RG normal.xy   B crevice mask   A height
 */
export function makeRockTexture(size = 512, seed = 4477, aniso = 4) {
  const height = new Float32Array(size * size);
  const crev = new Float32Array(size * size);
  const inv = 1 / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = i * inv, y = j * inv;
      const ridge = tileRidged(x * 5, y * 5, 5, seed, 4);
      const plates = tileFbm(x * 3, y * 3, 3, seed + 13, 2);
      const grain = tileFbm(x * 26, y * 26, 26, seed + 29, 3);
      // quantise a little so the rock breaks into plates instead of rolling
      const step = Math.floor(plates * 5) / 5;
      let h = ridge * 0.52 + step * 0.30 + grain * 0.18;
      const c = clamp01(1.0 - tileRidged(x * 3.2, y * 3.2, 3, seed + 51, 3) * 2.1);
      h -= c * 0.16;
      height[j * size + i] = clamp01(h);
      crev[j * size + i] = c;
    }
  }
  const data = new Uint8Array(size * size * 4);
  heightToNormalRG(height, size, size * 0.030, data, 0, 1, 4);
  for (let p = 0; p < size * size; p++) {
    data[p * 4 + 2] = (crev[p] * 255) | 0;
    data[p * 4 + 3] = (height[p] * 255) | 0;
  }
  const t = dataTexture(data, size, aniso);
  t.name = 'terrain-rock';
  return t;
}

// ── shared GLSL ────────────────────────────────────────────────────────────

const COMMON_DECL = /* glsl */ `
uniform sampler2D uDetail;
uniform sampler2D uCobble;
uniform sampler2D uRock;
uniform sampler2D uCaustics;
uniform vec4 uCaustParams;   // xyzw = scale, strength, speed, depth falloff
uniform vec3 uCaustTint;
uniform vec3 uSunDir;
uniform float uTime;
uniform float uWaterLevel;
uniform float uDetailScale;
uniform vec3 uSiltWet;
uniform vec3 uSiltDeep;
uniform vec3 uSand;
uniform vec3 uCobbleCol;
uniform vec3 uEarth;
uniform vec3 uGrassCool;
uniform vec3 uGrassWarm;
uniform vec3 uGrassDry;
uniform vec3 uRockCol;
uniform vec3 uShadowTint;

varying vec3 vWorld;
varying vec3 vWorldN;

${GLSL_NOISE}

mat2 rot2( float a ) {
  float c = cos( a ), s = sin( a );
  return mat2( c, -s, s, c );
}

/** Two explicit octaves. Same look as fbm2(p,3), a fraction of the cost. */
float terFbm2( vec2 p ) {
  return snoise2( p ) * 0.66 + snoise2( p * 2.17 + 11.3 ) * 0.34;
}

// Caustics projected from the water surface onto whatever is under it.
vec3 terrainCaustics( vec3 wpos ) {
  if ( uCaustParams.y <= 0.0 ) return vec3( 0.0 );
  float depth = uWaterLevel - wpos.y;
  if ( depth <= 0.0 ) return vec3( 0.0 );
  vec2 cuv = wpos.xz * uCaustParams.x;
  // refraction skew: the pattern slides with depth away from the sun
  cuv += uSunDir.xz * depth * 0.22;
  vec2 drift = vec2( uTime * uCaustParams.z * 0.021, uTime * uCaustParams.z * 0.014 );
  float a = texture2D( uCaustics, cuv + drift ).r;
  float b = texture2D( uCaustics, cuv * 1.41 + vec2( 0.37, 0.19 ) - drift * 0.7 ).r;
  float c = a * b * 3.2;
  float att = smoothstep( 0.0, 0.10, depth ) * exp( -depth * uCaustParams.w );
  return uCaustTint * c * att * uCaustParams.y;
}
`;

const VERTEX_WORLD = /* glsl */ `
#include <begin_vertex>
#ifdef USE_INSTANCING
  vWorld = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
  vWorldN = normalize( mat3( modelMatrix ) * ( mat3( instanceMatrix ) * objectNormal ) );
#else
  vWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vWorldN = normalize( mat3( modelMatrix ) * objectNormal );
#endif
`;

// ── ground material ────────────────────────────────────────────────────────

const GROUND_FN = /* glsl */ `
vec3 gAlbedo;
float gRough;
vec3 gNormalW;
vec3 gCaust;
float gAO;
vec3 gHaze;    // aerial-perspective colour that replaces lighting at distance
float gAer;    // how much of it takes over

void terrainSample() {
  vec2 P = vWorld.xz * uDetailScale;
  vec3 toCam = vWorld - cameraPosition;
  float camDist = length( toCam );
  // Fine detail must die away with distance or it turns into moire; the far
  // hills are then carried by macro colour alone, which is what makes them read
  // as painted forms sitting in haze.
  float fadeFine = 1.0 - smoothstep( 22.0, 150.0, camDist );
  float fadeMid = 1.0 - smoothstep( 160.0, 620.0, camDist );
  // Grazing angles are where a planar-projected detail map turns into streaks.
  // Only the finest octave is pulled back there — killing everything leaves flat
  // paint, which is worse than a little streaking.
  float graze = abs( dot( toCam / max( camDist, 1e-4 ), vWorldN ) );
  fadeFine *= 0.35 + 0.65 * smoothstep( 0.04, 0.26, graze );
  fadeMid *= 0.70 + 0.30 * smoothstep( 0.02, 0.16, graze );

  float h = vWorld.y - uWaterLevel;
  float slope = 1.0 - clamp( vWorldN.y, 0.0, 1.0 );

  // ── macro variation: the thing that stops this looking procedural ──
  // Explicit taps rather than the fbm2 loop: identical character, a third of
  // the instruction count, and no dynamic loop for the driver to unroll.
  float mA = terFbm2( P * 0.0125 + 3.7 );      // ~80 m
  float mB = snoise2( P * 0.049 + 21.3 );      // ~20 m
  float mC = snoise2( P * 0.0034 + 57.1 );     // ~290 m
  float mD = snoise2( P * 0.24 + 8.4 );        // ~4 m, immune to mip blur

  vec2 warp = vec2( mB, mA ) * 2.6;

  // ── multi-scale detail sampling (rotated so repeats never align) ──
  float grit = texture2D( uDetail, P * 2.6 ).r;
  vec4 dMid = texture2D( uDetail, ( P + warp ) * 0.34 );
  vec4 dMac = texture2D( uDetail, rot2( 1.24 ) * P * 0.081 );
  float patchM = mix( 0.5, dMac.a, 0.85 );

  vec4 cbA = texture2D( uCobble, rot2( 0.31 ) * P * 0.70 );
  vec4 cbB = texture2D( uCobble, rot2( -2.05 ) * P * 0.215 );

  vec3 an = abs( vWorldN );
  vec2 pv = ( an.x > an.z ) ? vWorld.zy : vWorld.xy;
  float vertW = 1.0 - clamp( vWorldN.y * 1.7, 0.0, 1.0 );
  // Cliff faces get a vertical projection so the rock does not smear; flat
  // ground keeps the XZ plane. Two taps, blended by how steep we are.
  vec4 rkS = mix(
    texture2D( uRock, rot2( 0.12 ) * P * 0.155 ),
    texture2D( uRock, pv * uDetailScale * 0.155 ),
    vertW
  );

  float mid = dMid.g * 2.0 - 1.0;
  float mac = dMac.a * 2.0 - 1.0;

  // A noisy waterline: the shore must never be a ruled line.
  float wl = h - ( dMid.r - 0.5 ) * 0.22 * fadeMid - ( mB * 0.10 );

  // ── layers ──
  float depth = max( 0.0, -h );
  vec3 silt = mix( uSiltWet, uSiltDeep, smoothstep( 0.15, 3.2, depth ) );
  silt *= 0.86 + 0.22 * dMid.a + 0.10 * mA;

  vec3 sand = uSand * ( 0.88 + 0.22 * grit * fadeFine );
  sand *= 0.82 + 0.24 * dMac.a + 0.22 * dMid.a;
  sand = mix( sand, sand * vec3( 1.05, 0.98 , 0.86 ), clamp( mA * 0.9 + 0.3, 0.0, 1.0 ) );
  sand *= 1.0 + 0.10 * mD;

  float cobH = max( cbA.a, cbB.a * 0.92 );
  vec3 cob = mix( uCobbleCol * 0.76, uCobbleCol * 1.17, cbA.b );
  cob *= 0.80 + 0.36 * cobH;
  cob = mix( cob, cob * vec3( 1.03, 1.00, 0.93 ), dMac.g * 0.6 );
  cob *= 1.0 + 0.13 * mD;

  vec3 earth = uEarth * ( 0.76 + 0.46 * dMid.g ) * ( 1.0 + 0.14 * mac * fadeMid );
  earth *= 1.0 - 0.30 * pow( dMid.b, 2.0 ) * fadeMid;   // dark roots
  earth *= 0.90 + 0.22 * grit * fadeFine;

  // Grass is lush where the ground is damp and dries out as it climbs away
  // from the river — the single strongest cue that this is a riverbank.
  float dryness = clamp(
    smoothstep( 9.0, 42.0, h ) * 0.70 + mC * 0.34 + mA * 0.20
    + smoothstep( 12.0, 60.0, abs( vShoreDist ) ) * 0.25, 0.0, 1.0
  );
  // Clump scales that actually survive to the screen: the ~0.3 m grit octave is
  // gone by 25 m, so the readable variation has to live at metres, not centimetres.
  float clumpS = dMid.a;   // ~1.5 m
  float clumpM = dMac.g;   // ~1.8 m
  float clumpL = dMac.a;   // ~6 m
  vec3 grass = mix( uGrassCool, uGrassWarm,
    clamp( clumpL * 0.90 + clumpM * 0.45 + mB * 0.35 - 0.12, 0.0, 1.0 ) );
  grass = mix( grass, uGrassDry, dryness );
  grass *= 0.68 + 0.36 * clumpS + 0.28 * clumpM;
  grass *= 0.88 + 0.24 * grit * fadeFine;
  grass *= 1.0 + 0.18 * mA + 0.15 * mD;
  // thick tussocks read darker at their base
  grass *= 1.0 - 0.16 * smoothstep( 0.5, 0.95, dMid.b ) * fadeFine;

  float rkH = mix( 0.5 + mA * 0.45, rkS.a, 0.66 );
  vec3 rock = mix( uRockCol * 0.52, uRockCol * 1.18, rkH );
  rock *= 1.0 - 0.35 * rkS.b;
  rock *= 1.0 + 0.13 * mac;

  // ── masks ──
  float siltM = 1.0 - smoothstep( -0.70, 0.14, wl );
  float sandM = ( 1.0 - smoothstep( 0.45, 2.30, wl ) ) * ( 1.0 - smoothstep( 0.34, 0.72, slope ) );
  sandM *= smoothstep( -1.6, -0.2, wl ) * 0.55 + 0.45;
  // Cobbles hug the water: a shingle bank a few metres either side of the line.
  float cobbleBand = 1.0 - smoothstep( 0.7, 3.2, abs( wl ) );
  float cobblePatch = smoothstep( 0.26, 0.70, patchM * 0.80 + mA * 0.55 + 0.30 );
  float cobbleM = smoothstep( 0.07, 0.40, cobH ) * cobbleBand * cobblePatch;
  cobbleM *= 1.0 - smoothstep( 0.55, 0.85, slope );
  float grassM = smoothstep( 0.55, 2.20, wl ) * ( 1.0 - smoothstep( 0.32, 0.64, slope ) );
  grassM *= smoothstep( 0.16, 0.60, patchM * 0.55 + 0.45 + mA * 0.5 );
  float rockM = smoothstep( 0.40, 0.70, slope );
  rockM = max( rockM, smoothstep( 18.0, 46.0, h ) * smoothstep( 0.20, 0.48, slope ) );
  rockM = max( rockM, smoothstep( 0.55, 0.85, rkH ) * smoothstep( 0.28, 0.55, slope ) );

  // ── composite: order matters, water wins at the shore ──
  vec3 alb = earth;
  float rough = 0.92;
  alb = mix( alb, grass, clamp( grassM, 0.0, 1.0 ) );
  rough = mix( rough, 0.96, clamp( grassM, 0.0, 1.0 ) );
  alb = mix( alb, sand, clamp( sandM, 0.0, 1.0 ) );
  rough = mix( rough, 0.86, clamp( sandM, 0.0, 1.0 ) );
  alb = mix( alb, cob, clamp( cobbleM, 0.0, 1.0 ) );
  rough = mix( rough, 0.64, clamp( cobbleM, 0.0, 1.0 ) );
  alb = mix( alb, rock, clamp( rockM, 0.0, 1.0 ) );
  rough = mix( rough, 0.76, clamp( rockM, 0.0, 1.0 ) );
  alb = mix( alb, silt, clamp( siltM, 0.0, 1.0 ) );
  rough = mix( rough, 0.46, clamp( siltM, 0.0, 1.0 ) );

  // ── the wet band: ~0.5 m of darkened, glossy ground above the waterline ──
  // This single detail is what makes the shoreline believable.
  float wet = 1.0 - smoothstep( -0.06, 0.52, wl );
  wet = max( wet, 1.0 - smoothstep( -0.30, 0.02, h ) );
  wet = clamp( wet, 0.0, 1.0 );
  alb *= mix( 1.0, 0.40, wet );
  alb = mix( alb, alb * vec3( 0.78, 0.95, 1.05 ), wet * 0.65 );
  rough = mix( rough, 0.38, wet * 0.92 );

  // Broad value break-up at ~6 m and ~20 m, applied to every material. Without
  // this the banks read as smooth pillows however good the fine detail is.
  alb *= 0.90 + 0.20 * dMac.a + 0.12 * ( mB * 0.5 + 0.5 ) + 0.07 * mD;

  // ── altitude: the ridges go cool and rocky, which separates them in depth ──
  float alt = smoothstep( 55.0, 180.0, h );
  alb = mix( alb, mix( uRockCol * 0.46, vec3( 0.17, 0.23, 0.32 ), 0.62 ), alt * 0.90 );

  // ── aerial perspective ──
  // Darkening the albedo is not enough: a low sun at intensity 3+ drives even a
  // dark surface past white, and the fog then only adds more brightness, so far
  // ridges come out as snowfields. Instead the surface progressively stops being
  // lit at all and becomes a flat haze colour, which is what actually gives a
  // distant ridge a value BELOW the sky it is silhouetted against.
  float aer = smoothstep( 90.0, 620.0, camDist );
  alb = mix( alb, mix( alb * 0.55, vec3( 0.22, 0.30, 0.41 ), 0.6 ), aer * 0.85 );

  // ── painterly macro colour over tens of metres ──
  alb *= 1.0 + mC * 0.15;
  alb = mix( alb, alb * vec3( 1.15, 1.03, 0.80 ), max( 0.0, mA ) * 0.45 );
  alb = mix( alb, alb * vec3( 0.84, 0.96, 1.08 ), max( 0.0, -mA ) * 0.38 );

  // ── warm sun / cool shade, painted into the albedo ──
  // The complementary split is the whole art direction, and leaving it to the
  // lights alone gives grey shadows. Faces turned away from the sun pick up a
  // teal sky bounce; faces turned into it get a honeyed lift.
  float ndl = dot( vWorldN, uSunDir );
  float shade = 1.0 - smoothstep( -0.22, 0.42, ndl );
  alb = mix( alb, alb * uShadowTint, shade * 0.42 );
  alb = mix( alb, alb * vec3( 1.06, 0.98, 0.83 ), smoothstep( 0.25, 0.85, ndl ) * 0.38 );

  // ── detail normal ──
  vec2 nd = vec2( 0.0 );
  nd += ( vec2( cbA.r, cbA.g ) * 2.0 - 1.0 ) * cobbleM * 2.6;
  nd += ( vec2( cbB.r, cbB.g ) * 2.0 - 1.0 ) * cobbleM * 1.2;
  nd += ( vec2( rkS.r, rkS.g ) * 2.0 - 1.0 ) * clamp( rockM, 0.0, 1.0 ) * 1.9;
  nd += ( vec2( dMid.g, dMid.r ) * 2.0 - 1.0 ) * ( sandM * 0.40 + grassM * 0.26 + siltM * 0.16 );
  nd *= mix( 0.18, 1.0, fadeFine );
  nd *= 1.0 - 0.55 * vertW;
  // Submerged silt is smooth; leaving it bumpy under a low roughness gives a
  // field of glitter, which is instantly fake. The wet band above the line keeps
  // its relief, because that is what makes the shingle sparkle in a low sun.
  float submerged = 1.0 - smoothstep( -0.28, 0.03, h );
  nd *= 1.0 - 0.72 * submerged;

  gAer = aer * 0.88;
  gHaze = mix( vec3( 0.15, 0.21, 0.29 ), vec3( 0.26, 0.27, 0.25 ),
               clamp( ndl * 0.5 + 0.5, 0.0, 1.0 ) );
  gNormalW = normalize( vWorldN + vec3( nd.x, 0.0, nd.y ) );
  gAlbedo = max( alb, vec3( 0.0 ) ) * 0.74 * ( 1.0 - gAer );
  gRough = clamp( rough, 0.05, 1.0 );
  gCaust = terrainCaustics( vWorld );
  gAO = vTerrainAO;
}
`;

/**
 * The riverbank ground material.
 *
 * @param {object} opts
 * @param {number} opts.anisotropy  renderer max anisotropy
 * @param {number} [opts.textureSize]
 * @param {number} [opts.waterLevel]
 * @param {object} [opts.maps] reuse already-baked maps
 */
export function createGroundMaterial({
  anisotropy = 4,
  textureSize = 512,
  waterLevel = 0,
  maps = null,
} = {}) {
  const detail = maps?.detail ?? makeDetailTexture(textureSize, 1201, anisotropy);
  const cobble = maps?.cobble ?? makeCobbleTexture(textureSize, 9061, anisotropy);
  const rock = maps?.rock ?? makeRockTexture(textureSize, 4477, anisotropy);

  const blackPx = new THREE.DataTexture(
    new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat
  );
  blackPx.needsUpdate = true;

  const uniforms = {
    uDetail: { value: detail },
    uCobble: { value: cobble },
    uRock: { value: rock },
    uCaustics: { value: blackPx },
    uCaustParams: { value: new THREE.Vector4(0.09, 0.0, 1.0, 0.30) },
    uCaustTint: { value: new THREE.Color(1.0, 0.95, 0.82) },
    uSunDir: { value: new THREE.Vector3(0.4, 0.5, -0.76) },
    uTime: { value: 0 },
    uWaterLevel: { value: waterLevel },
    uDetailScale: { value: 1.0 },
    uSiltWet: { value: new THREE.Color(GROUND_PALETTE.siltWet) },
    uSiltDeep: { value: new THREE.Color(GROUND_PALETTE.siltDeep) },
    uSand: { value: new THREE.Color(GROUND_PALETTE.sand) },
    uCobbleCol: { value: new THREE.Color(GROUND_PALETTE.cobble) },
    uEarth: { value: new THREE.Color(GROUND_PALETTE.earth) },
    uGrassCool: { value: new THREE.Color(GROUND_PALETTE.grassCool) },
    uGrassWarm: { value: new THREE.Color(GROUND_PALETTE.grassWarm) },
    uGrassDry: { value: new THREE.Color(GROUND_PALETTE.grassDry) },
    uRockCol: { value: new THREE.Color(GROUND_PALETTE.rock) },
    uShadowTint: { value: new THREE.Color(GROUND_PALETTE.shadowTint) },
  };

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0.0,
    dithering: true,
    // The bed meets the still-water plane exactly at the waterline, so bias the
    // ground back in depth: the water surface wins every tie, no z-fighting.
    polygonOffset: true,
    polygonOffsetFactor: 1.0,
    polygonOffsetUnits: 2.0,
  });
  mat.envMapIntensity = 0.8;
  mat.name = 'ground';

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec3 aTerrain;
         varying vec3 vWorld;
         varying vec3 vWorldN;
         varying float vTerrainAO;
         varying float vShoreDist;`
      )
      .replace(
        '#include <begin_vertex>',
        `${VERTEX_WORLD}
         vTerrainAO = aTerrain.y;
         vShoreDist = aTerrain.x;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         ${COMMON_DECL}
         varying float vTerrainAO;
         varying float vShoreDist;
         ${GROUND_FN}`
      )
      .replace('#include <map_fragment>', 'terrainSample();\n  diffuseColor.rgb *= gAlbedo;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         normal = normalize( ( viewMatrix * vec4( gNormalW, 0.0 ) ).xyz );`
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
         reflectedLight.indirectDiffuse *= gAO;
         reflectedLight.directDiffuse += gCaust * diffuseColor.rgb;
         totalEmissiveRadiance += gHaze * gAer;`
      );
  };
  mat.customProgramCacheKey = () => 'duck-ground-v2';
  mat.userData.uniforms = uniforms;
  mat.userData.maps = { detail, cobble, rock };
  mat.userData.ownedTextures = maps ? [blackPx] : [detail, cobble, rock, blackPx];

  return mat;
}

// ── rock material ──────────────────────────────────────────────────────────

const ROCK_FN = /* glsl */ `
vec3 gAlbedo;
float gRough;
vec3 gNormalW;
vec3 gCaust;

void rockSample() {
  float camDist = length( vWorld - cameraPosition );
  float fadeFine = 1.0 - smoothstep( 14.0, 90.0, camDist );

  // Two-plane projection: the flat-ish top faces take the XZ plane, the steep
  // faces take whichever vertical plane they face. Cheaper than full triplanar
  // and, on a faceted boulder, indistinguishable.
  vec3 an = abs( vWorldN );
  vec2 pv = ( an.x > an.z ) ? vWorld.zy : vWorld.xy;
  float upW = smoothstep( 0.35, 0.85, an.y );
  vec4 rk = mix( texture2D( uRock, pv * 0.55 ),
                 texture2D( uRock, vWorld.xz * 0.55 ), upW );
  vec4 rkL = mix( texture2D( uRock, rot2( 1.1 ) * pv * 0.135 ),
                  texture2D( uRock, rot2( 1.1 ) * vWorld.xz * 0.135 ), upW );

  float hgt = mix( rkL.a, rk.a, 0.6 );
  float mac = snoise2( vWorld.xz * 0.06 + vRockVar.x * 31.0 );

  vec3 base = mix( uRockCol * 0.60, uRockCol * 1.34, hgt );
  base *= mix( 0.86, 1.20, vRockVar.x );
  base = mix( base, base * vec3( 1.14, 1.03, 0.82 ), clamp( mac * 0.6 + 0.35, 0.0, 1.0 ) );
  base *= 1.0 - 0.22 * rk.b;                        // crevices

  // lichen / moss creeping over upward faces above the water
  float upFace = clamp( vWorldN.y, 0.0, 1.0 );
  float moss = smoothstep( 0.30, 0.85, upFace ) * smoothstep( 0.18, 0.62, rkL.a )
             * smoothstep( 0.05, 0.75, vRockVar.y ) * smoothstep( 0.05, 0.5, vWorld.y - uWaterLevel );
  base = mix( base, mix( uGrassCool, uGrassDry, 0.35 ) * ( 0.75 + 0.5 * rk.a ), moss * 0.85 );

  float rough = mix( 0.86, 0.66, hgt );

  // wet ring: rocks standing in the river are dark and glossy at the waterline
  float hAbove = vWorld.y - uWaterLevel;
  float wet = 1.0 - smoothstep( -0.05, 0.42, hAbove );
  wet = max( wet, 1.0 - smoothstep( -0.35, 0.0, hAbove ) );
  base *= mix( 1.0, 0.40, wet );
  base = mix( base, base * vec3( 0.82, 0.97, 1.05 ), wet * 0.6 );
  rough = mix( rough, 0.14, wet * 0.95 );

  // same warm/cool split the ground uses, so boulders sit in the same light
  float ndl = dot( vWorldN, uSunDir );
  base = mix( base, base * uShadowTint, ( 1.0 - smoothstep( -0.22, 0.42, ndl ) ) * 0.40 );
  base = mix( base, base * vec3( 1.12, 1.04, 0.90 ), smoothstep( 0.25, 0.85, ndl ) * 0.28 );

  vec2 nd = ( vec2( rk.r, rk.g ) * 2.0 - 1.0 ) * 1.5
          + ( vec2( rkL.r, rkL.g ) * 2.0 - 1.0 ) * 0.9;
  nd *= mix( 0.3, 1.0, fadeFine );
  vec3 t1 = normalize( cross( vWorldN, vec3( 0.0, 1.0, 0.0 ) ) + vec3( 0.001, 0.0, 0.0 ) );
  vec3 t2 = cross( t1, vWorldN );
  gNormalW = normalize( vWorldN + ( t1 * nd.x + t2 * nd.y ) * 0.55 );

  gAlbedo = base;
  gRough = clamp( rough, 0.05, 1.0 );
  gCaust = terrainCaustics( vWorld );
}
`;

/** Boulder material — triplanar fractured rock, lichen, and a wet waterline ring. */
export function createRockMaterial({ groundMaterial, waterLevel = 0 } = {}) {
  const gu = groundMaterial?.userData?.uniforms;
  const uniforms = {
    uRock: { value: gu?.uRock.value ?? null },
    uCaustics: { value: gu?.uCaustics.value ?? null },
    uCaustParams: { value: gu?.uCaustParams.value ?? new THREE.Vector4(0.09, 0, 1, 0.3) },
    uCaustTint: { value: gu?.uCaustTint.value ?? new THREE.Color(1, 0.95, 0.82) },
    uSunDir: { value: gu?.uSunDir.value ?? new THREE.Vector3(0.4, 0.5, -0.76) },
    uTime: gu?.uTime ?? { value: 0 },
    uWaterLevel: { value: waterLevel },
    uRockCol: { value: new THREE.Color(GROUND_PALETTE.rock) },
    uGrassCool: { value: new THREE.Color(GROUND_PALETTE.grassCool) },
    uGrassDry: { value: new THREE.Color(GROUND_PALETTE.grassDry) },
    // unused by the rock path but referenced by the shared prelude
    uDetail: { value: gu?.uDetail.value ?? null },
    uCobble: { value: gu?.uCobble.value ?? null },
    uDetailScale: { value: 1 },
    uSiltWet: { value: new THREE.Color(GROUND_PALETTE.siltWet) },
    uSiltDeep: { value: new THREE.Color(GROUND_PALETTE.siltDeep) },
    uSand: { value: new THREE.Color(GROUND_PALETTE.sand) },
    uCobbleCol: { value: new THREE.Color(GROUND_PALETTE.cobble) },
    uEarth: { value: new THREE.Color(GROUND_PALETTE.earth) },
    uGrassWarm: { value: new THREE.Color(GROUND_PALETTE.grassWarm) },
    uShadowTint: { value: new THREE.Color(GROUND_PALETTE.shadowTint) },
  };

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0.0,
    dithering: true,
  });
  mat.name = 'boulder';
  mat.envMapIntensity = 0.85;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec2 aRockVar;
         varying vec3 vWorld;
         varying vec3 vWorldN;
         varying vec2 vRockVar;`
      )
      .replace('#include <begin_vertex>', `${VERTEX_WORLD}\n vRockVar = aRockVar;`);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         ${COMMON_DECL}
         varying vec2 vRockVar;
         ${ROCK_FN}`
      )
      .replace('#include <map_fragment>', 'rockSample();\n  diffuseColor.rgb *= gAlbedo;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         normal = normalize( ( viewMatrix * vec4( gNormalW, 0.0 ) ).xyz );`
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
         reflectedLight.directDiffuse += gCaust * diffuseColor.rgb;`
      );
  };
  mat.customProgramCacheKey = () => 'duck-boulder-v1';
  mat.userData.uniforms = uniforms;
  return mat;
}
