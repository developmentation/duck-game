// Water surface material + the procedural textures it needs.
//
// Everything here is shared between the GPU and the CPU on purpose. The wave
// table below is the single source of truth: the vertex shader displaces the
// ribbon with it, and `evalWaves()` re-evaluates the identical sum in JS so
// `water.heightAt()` agrees with what the player can see to within a few
// millimetres. If those two ever disagree the duck hovers or sinks, so they are
// written next to each other and must be edited together.
//
// The textures are built from integer-frequency sine spectra rather than from
// simplex noise. Two reasons: an integer-frequency sum over [0,1) is perfectly
// tileable with no seam fixup at all, and its analytic derivative gives an exact
// normal map for free. A water spectrum is what we want anyway.

import * as THREE from 'three';
import { makeRandom } from '../core/noise.js';

export const WAVE_COUNT = 6;
export const RIPPLE_SLOTS = 24;

/**
 * The wave train. Directions are offsets from the LOCAL DOWNSTREAM flow
 * direction, so every wave travels downstream no matter how the river bends.
 *   angle  : radians from the flow direction
 *   lambda : wavelength, metres
 *   amp    : amplitude at full strength, metres
 *   steep  : Gerstner horizontal steepness (0 = plain sine, 1 = cusped)
 */
export const WAVES = [
  { angle: 0.00, lambda: 13.0, amp: 0.052, steep: 0.34 },
  { angle: 0.33, lambda: 7.40, amp: 0.037, steep: 0.29 },
  { angle: -0.47, lambda: 4.30, amp: 0.026, steep: 0.24 },
  { angle: 0.79, lambda: 2.50, amp: 0.016, steep: 0.18 },
  { angle: -1.05, lambda: 1.45, amp: 0.0105, steep: 0.13 },
  { angle: 1.37, lambda: 0.85, amp: 0.0062, steep: 0.09 },
];

export const WAVE_AMP_TOTAL = WAVES.reduce((a, w) => a + w.amp, 0);

const GRAV = 9.81;
const DISPERSION = 0.34; // fraction of deep-water celerity
const ADVECTION = 0.85;  // how much of the current the wave rides

// ---------------------------------------------------------------------------
// shared maths, written once in GLSL and once in JS
// ---------------------------------------------------------------------------

const WAVE_GLSL = /* glsl */ `
uniform vec4 uWaves[NW];   // angle, lambda, amp, steep

// Local wave amplitude: dies in the shallows, dies at the bank, grows with the
// current. Mirrored exactly by waterAmpJS() on the CPU side.
float waterAmp(float depth, float u, float speed) {
  float sh = clamp(depth / 0.85, 0.0, 1.0);
  sh = sh * sh * (3.0 - 2.0 * sh);
  float bank = 1.0 - smoothstep(0.74, 1.0, abs(u));
  float fl = 0.42 + 0.66 * clamp(speed / 1.35, 0.0, 1.9);
  return sh * bank * fl;
}

void waterWaves(vec2 p, float t, vec2 fdir, float fspeed, float amp,
                out vec3 disp, out vec3 nrm) {
  disp = vec3(0.0);
  vec3 tx = vec3(1.0, 0.0, 0.0);
  vec3 tz = vec3(0.0, 0.0, 1.0);
  for (int i = 0; i < NW; i++) {
    float a = uWaves[i].z * amp;
    if (a < 1e-5) continue;
    float ca = cos(uWaves[i].x), sa = sin(uWaves[i].x);
    vec2 d = vec2(fdir.x * ca - fdir.y * sa, fdir.x * sa + fdir.y * ca);
    float k = 6.28318530718 / uWaves[i].y;
    float q = uWaves[i].w;
    float c = ${DISPERSION.toFixed(3)} * sqrt(${GRAV.toFixed(2)} / k) + fspeed * ${ADVECTION.toFixed(3)};
    float ph = k * dot(d, p) - t * k * c;
    float s = sin(ph), co = cos(ph);
    disp.y += a * s;
    disp.xz += d * (q * a * co);
    float ak = a * k;
    // d(disp)/dx and d(disp)/dz
    tx += vec3(-q * ak * d.x * s * d.x, ak * co * d.x, -q * ak * d.y * s * d.x);
    tz += vec3(-q * ak * d.x * s * d.y, ak * co * d.y, -q * ak * d.y * s * d.y);
  }
  nrm = normalize(cross(tz, tx));
}
`;

/** JS twin of waterAmp(). */
export function waterAmpJS(depth, u, speed) {
  let sh = Math.min(1, Math.max(0, depth / 0.85));
  sh = sh * sh * (3 - 2 * sh);
  const a = Math.abs(u);
  let b = (a - 0.74) / 0.26;
  b = Math.min(1, Math.max(0, b));
  const bank = 1 - b * b * (3 - 2 * b);
  const fl = 0.42 + 0.66 * Math.min(1.9, Math.max(0, speed / 1.35));
  return sh * bank * fl;
}

/**
 * JS twin of waterWaves(). Writes into `out`:
 *   out.dx, out.dy, out.dz  displacement
 *   out.nx, out.ny, out.nz  surface normal
 * Allocation free — pass a reused plain object.
 */
export function evalWaves(px, pz, t, fdx, fdz, fspeed, amp, out) {
  let dx = 0, dy = 0, dz = 0;
  let txx = 1, txy = 0, txz = 0;
  let tzx = 0, tzy = 0, tzz = 1;
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i];
    const a = w.amp * amp;
    if (a < 1e-5) continue;
    const ca = Math.cos(w.angle), sa = Math.sin(w.angle);
    const ddx = fdx * ca - fdz * sa;
    const ddz = fdx * sa + fdz * ca;
    const k = 6.28318530718 / w.lambda;
    const q = w.steep;
    const c = DISPERSION * Math.sqrt(GRAV / k) + fspeed * ADVECTION;
    const ph = k * (ddx * px + ddz * pz) - t * k * c;
    const s = Math.sin(ph), co = Math.cos(ph);
    dy += a * s;
    dx += ddx * (q * a * co);
    dz += ddz * (q * a * co);
    const ak = a * k;
    txx += -q * ak * ddx * s * ddx;
    txy += ak * co * ddx;
    txz += -q * ak * ddz * s * ddx;
    tzx += -q * ak * ddx * s * ddz;
    tzy += ak * co * ddz;
    tzz += -q * ak * ddz * s * ddz;
  }
  // normal = normalize(cross(tz, tx))
  let nx = tzy * txz - tzz * txy;
  let ny = tzz * txx - tzx * txz;
  let nz = tzx * txy - tzy * txx;
  const l = Math.hypot(nx, ny, nz) || 1;
  out.dx = dx; out.dy = dy; out.dz = dz;
  out.nx = nx / l; out.ny = ny / l; out.nz = nz / l;
  return out;
}

// Ripples: expanding rings from a small ring buffer of sources. Same wavelet on
// both sides so heightAt() feels the splash the player sees.
//
// Two properties are load bearing for the *physics*, not just the look:
//
//   * a ring has no displacement at its own origin. The naive packet
//     exp(-(d - r0)^2 / w^2) is at full crest when d = 0 and r0 = 0, so a ring
//     emitted under the duck instantly lifts the reported surface by its whole
//     amplitude. Splashes are emitted at the duck's feet on every dive/surface
//     transition, so that lift re-triggered the transition, which emitted more
//     rings: `heightAt` ran away to over a metre of phantom swell and the duck
//     was permanently "submerged". `grow` ramps the ring in as it leaves the
//     source and the inward-narrow packet keeps the relaxed water inside it flat.
//   * the sum is clamped. Four co-located rings used to add linearly.
const RIPPLE_LAMBDA = 0.95;
const RIPPLE_DECAY = 1.5;
const RIPPLE_GROW = 0.45;   // metres of ring radius before it reaches full amplitude
const RIPPLE_INNER = 0.55;  // packet width inside the ring, as a fraction of w
export const RIPPLE_H_MAX = 0.26;  // metres, hard cap on the summed ring height

const RIPPLE_GLSL = /* glsl */ `
uniform vec4 uRipA[NR];   // xy centre, z age (s), w strength
uniform vec4 uRipB[NR];   // x ring speed, y kind (0 ring, 1 wake), zw travel dir
uniform float uRipCount;  // live sources, packed into the front of the array

void ripplesAt(vec2 p, out float h, out float foam, out vec2 grad) {
  h = 0.0; foam = 0.0; grad = vec2(0.0);
  for (int i = 0; i < NR; i++) {
    if (float(i) >= uRipCount) break;
    vec4 A = uRipA[i];
    if (A.w <= 0.0) continue;
    vec2 rel = p - A.xy;
    float d2 = dot(rel, rel);
    vec4 B = uRipB[i];
    float r0 = B.x * A.z;
    float w = 0.5 + 0.5 * A.z;
    float x = sqrt(d2) - r0;
    if (abs(x) > w * 2.6) continue;
    // Narrower on the inside: water the ring has already crossed has relaxed.
    float ww = x < 0.0 ? w * ${RIPPLE_INNER.toFixed(3)} : w;
    float e = exp(-(x * x) / (ww * ww));
    float grow = smoothstep(0.0, ${RIPPLE_GROW.toFixed(3)}, r0);
    float amp = A.w * exp(-${RIPPLE_DECAY.toFixed(2)} * A.z) * grow;
    if (B.y > 0.5) {
      // Kelvin wake: emphasise the classic 19.5 degree shoulder behind the duck
      vec2 rd = rel * inversesqrt(max(d2, 1e-6));
      float g = (dot(rd, -B.zw) - 0.94) * 5.0;
      amp *= 0.22 + 1.15 * exp(-g * g);
    }
    float k = 6.28318530718 / ${RIPPLE_LAMBDA.toFixed(3)};
    float ph = k * x;
    float cs = cos(ph), sn = sin(ph);
    h += amp * cs * e;
    grad += rel * inversesqrt(max(d2, 1e-6)) * amp * e * (-k * sn - 2.0 * x * cs / (ww * ww));
    foam += A.w * 3.5 * exp(-1.4 * A.z) * smoothstep(0.0, 0.30, r0)
          * exp(-(x * x) / (w * w * 1.5));
  }
  h = clamp(h, -${RIPPLE_H_MAX.toFixed(3)}, ${RIPPLE_H_MAX.toFixed(3)});
}
`;

/** JS twin of ripplesAt(); `list` is the live ripple array from Water. */
export function evalRipples(list, px, pz, out) {
  let h = 0, foam = 0;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (r.strength <= 0) continue;
    const rx = px - r.x, rz = pz - r.z;
    const d = Math.sqrt(rx * rx + rz * rz) + 1e-6;
    const r0 = r.speed * r.age;
    const w = 0.5 + 0.5 * r.age;
    const x = d - r0;
    if (Math.abs(x) > w * 2.6) continue;
    const ww = x < 0 ? w * RIPPLE_INNER : w;
    const e = Math.exp(-(x * x) / (ww * ww));
    let g0 = r0 / RIPPLE_GROW;
    g0 = g0 < 0 ? 0 : g0 > 1 ? 1 : g0;
    const grow = g0 * g0 * (3 - 2 * g0);
    let amp = r.strength * Math.exp(-RIPPLE_DECAY * r.age) * grow;
    if (r.kind > 0.5) {
      const g = ((rx / d) * -r.dirx + (rz / d) * -r.dirz - 0.94) * 5.0;
      amp *= 0.22 + 1.15 * Math.exp(-g * g);
    }
    const k = 6.28318530718 / RIPPLE_LAMBDA;
    h += amp * Math.cos(k * x) * e;
    let f0 = r0 / 0.30;
    f0 = f0 < 0 ? 0 : f0 > 1 ? 1 : f0;
    foam += r.strength * 3.5 * Math.exp(-1.4 * r.age) * (f0 * f0 * (3 - 2 * f0))
      * Math.exp(-(x * x) / (w * w * 1.5));
  }
  out.h = h < -RIPPLE_H_MAX ? -RIPPLE_H_MAX : h > RIPPLE_H_MAX ? RIPPLE_H_MAX : h;
  out.foam = foam;
  return out;
}

// ---------------------------------------------------------------------------
// procedural textures
// ---------------------------------------------------------------------------

/**
 * A tileable spectrum: integer frequency vectors so the field wraps exactly.
 * `aniso` biases energy toward waves travelling along +x, which is what gives
 * the chop a direction to be advected along.
 */
function buildSpectrum(rng, count, fMin, fMax, falloff, aniso) {
  const waves = [];
  let norm = 0;
  for (let i = 0; i < count; i++) {
    let fx = 0, fz = 0, mag = 0;
    for (let tries = 0; tries < 8; tries++) {
      const ang = rng() * Math.PI * 2;
      const f = fMin + (fMax - fMin) * Math.pow(rng(), 1.7);
      fx = Math.round(Math.cos(ang) * f);
      fz = Math.round(Math.sin(ang) * f);
      mag = Math.hypot(fx, fz);
      if (mag >= Math.max(1, fMin * 0.6)) break;
    }
    if (mag < 1) { fx = 1; fz = 0; mag = 1; }
    let amp = Math.pow(mag, -falloff);
    amp *= Math.pow(0.22 + 0.78 * Math.abs(fx) / mag, aniso);
    waves.push({ fx, fz, amp, ph: rng() * Math.PI * 2 });
    norm += amp;
  }
  for (const w of waves) w.amp /= norm;
  return waves;
}

/**
 * Evaluate a spectrum over a size×size grid into height + slope buffers.
 * Uses the sin/cos rotation recurrence along each row: one sincos per wave per
 * row instead of per pixel, which keeps the whole texture build under ~20ms.
 */
function rasterSpectrum(size, spec, h, du, dv) {
  h.fill(0); du.fill(0); dv.fill(0);
  const TAU = Math.PI * 2;
  for (let wi = 0; wi < spec.length; wi++) {
    const { fx, fz, amp, ph } = spec[wi];
    const d = (TAU * fx) / size;
    const cd = Math.cos(d), sd = Math.sin(d);
    const gu = amp * TAU * fx;
    const gv = amp * TAU * fz;
    for (let j = 0; j < size; j++) {
      const base = (TAU * fz * j) / size + ph;
      let s = Math.sin(base), c = Math.cos(base);
      let o = j * size;
      for (let i = 0; i < size; i++, o++) {
        h[o] += amp * s;
        du[o] += gu * c;
        dv[o] += gv * c;
        const ns = s * cd + c * sd;
        c = c * cd - s * sd;
        s = ns;
      }
    }
  }
}

function makeTexture(size, data, aniso) {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = aniso;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Build the three textures the surface needs.
 *   waveA : RGB broad swell normal, A big soft foam/cloud mask
 *   waveB : RGB fine chop normal,   A high-contrast sparkle/foam grain
 *   caustics: bright filament network for the bed (published on ctx.water)
 */
export function makeWaterTextures({ size = 256, anisotropy = 4, seed = 7717 } = {}) {
  const rng = makeRandom(seed);
  const n = size * size;
  const h = new Float32Array(n);
  const du = new Float32Array(n);
  const dv = new Float32Array(n);
  const h2 = new Float32Array(n);
  const du2 = new Float32Array(n);
  const dv2 = new Float32Array(n);

  const out = {};

  // ---- A: broad swell + soft foam ----------------------------------------
  {
    rasterSpectrum(size, buildSpectrum(rng, 26, 1, 6, 1.35, 1.1), h, du, dv);
    rasterSpectrum(size, buildSpectrum(rng, 18, 2, 9, 1.1, 0.4), h2, du2, dv2);
    const data = new Uint8Array(n * 4);
    let mu = 1e-6, mh = 1e-6;
    for (let i = 0; i < n; i++) {
      mu = Math.max(mu, Math.abs(du[i]), Math.abs(dv[i]));
      mh = Math.max(mh, Math.abs(h2[i]));
    }
    const k = 1.55 / mu;
    for (let i = 0; i < n; i++) {
      const nx = -du[i] * k, ny = -dv[i] * k;
      const inv = 1 / Math.hypot(nx, ny, 1);
      data[i * 4] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      data[i * 4 + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      data[i * 4 + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      // soft cloudy foam mask, biased dark so foam appears only where pushed
      let f = 0.5 + 0.5 * (h2[i] / mh);
      f = Math.pow(f, 1.6);
      data[i * 4 + 3] = Math.round(f * 255);
    }
    out.waveA = makeTexture(size, data, anisotropy);
  }

  // ---- B: fine chop + sparkle grain --------------------------------------
  {
    rasterSpectrum(size, buildSpectrum(rng, 30, 3, 16, 1.15, 1.6), h, du, dv);
    rasterSpectrum(size, buildSpectrum(rng, 22, 6, 24, 0.95, 0.3), h2, du2, dv2);
    const data = new Uint8Array(n * 4);
    let mu = 1e-6, mh = 1e-6;
    for (let i = 0; i < n; i++) {
      mu = Math.max(mu, Math.abs(du[i]), Math.abs(dv[i]));
      mh = Math.max(mh, Math.abs(h2[i]));
    }
    const k = 1.7 / mu;
    for (let i = 0; i < n; i++) {
      const nx = -du[i] * k, ny = -dv[i] * k;
      const inv = 1 / Math.hypot(nx, ny, 1);
      data[i * 4] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      data[i * 4 + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      data[i * 4 + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      let f = 0.5 + 0.5 * (h2[i] / mh);
      f = Math.pow(f, 3.2); // high contrast: isolated bright grains
      data[i * 4 + 3] = Math.round(f * 255);
    }
    out.waveB = makeTexture(size, data, anisotropy);
  }

  // ---- caustics ----------------------------------------------------------
  {
    const cs = Math.max(128, size >> 1);
    const cn = cs * cs;
    const ch = new Float32Array(cn);
    const cdu = new Float32Array(cn);
    const cdv = new Float32Array(cn);
    rasterSpectrum(cs, buildSpectrum(rng, 16, 2, 7, 1.2, 0.25), ch, cdu, cdv);
    const ch2 = new Float32Array(cn);
    rasterSpectrum(cs, buildSpectrum(rng, 12, 4, 12, 1.0, 0.25), ch2, cdu, cdv);
    let m1 = 1e-6, m2 = 1e-6;
    for (let i = 0; i < cn; i++) {
      m1 = Math.max(m1, Math.abs(ch[i]));
      m2 = Math.max(m2, Math.abs(ch2[i]));
    }
    const data = new Uint8Array(cn * 4);
    // Caustics are the bright curves where the refracted wavefront folds: the
    // zero contours of the height field, with a per-channel offset so the
    // filaments carry a faint chromatic fringe.
    const line = (v, off) => Math.pow(Math.max(0, 1 - Math.abs(v - off)), 9);
    for (let i = 0; i < cn; i++) {
      const a = ch[i] / m1, b = ch2[i] / m2;
      const r = line(a, -0.05) * 0.85 + line(b, 0.04) * 0.5;
      const g = line(a, 0.0) * 0.9 + line(b, 0.0) * 0.55;
      const bl = line(a, 0.05) * 0.85 + line(b, -0.04) * 0.5;
      data[i * 4] = Math.round(Math.min(1, r) * 255);
      data[i * 4 + 1] = Math.round(Math.min(1, g) * 255);
      data[i * 4 + 2] = Math.round(Math.min(1, bl) * 255);
      data[i * 4 + 3] = 255;
    }
    out.caustics = makeTexture(cs, data, anisotropy);
  }

  return out;
}

// ---------------------------------------------------------------------------
// the material
// ---------------------------------------------------------------------------

const VERT = /* glsl */ `
#define NW ${WAVE_COUNT}
#define NR ${RIPPLE_SLOTS}
precision highp float;

attribute vec3 aSU;     // s along the river (m), v across (-1.06..1.06), metres from the waterline
attribute vec3 aFlow;   // downstream unit dir (xz) and speed (m/s)
attribute float aDepth; // SIGNED still-water depth (m): < 0 once the bed is out of the water

uniform float uTime;
uniform float uLevel;
uniform vec3 uCamPos;

${WAVE_GLSL}
${RIPPLE_GLSL}

varying vec3 vWorld;
varying vec3 vWaveN;
varying vec3 vSU;
varying vec3 vFlow;
varying float vDepth;
varying float vAmp;
varying float vWaveH;
varying float vViewZ;
varying float vRayK;
varying vec4 vClip;

void main() {
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  vec2 fdir = normalize(aFlow.xy + vec2(1e-5, 0.0));
  float amp = waterAmp(max(aDepth, 0.0), aSU.y, aFlow.z);

  vec3 disp, nrm;
  waterWaves(wp.xz, uTime, fdir, aFlow.z, amp, disp, nrm);

  float rh, rfoam; vec2 rgrad;
  ripplesAt(wp.xz, rh, rfoam, rgrad);
  float rmask = 1.0 - smoothstep(0.72, 1.0, abs(aSU.y));

  wp.x += disp.x;
  wp.z += disp.z;
  wp.y += disp.y + rh * rmask;

  vWorld = wp;
  vWaveN = nrm;
  vSU = aSU;
  vFlow = aFlow;
  vDepth = aDepth;
  vAmp = amp;
  vWaveH = disp.y;

  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewZ = -mv.z;
  vRayK = length(mv.xyz) / max(1e-4, -mv.z);
  vClip = projectionMatrix * mv;
  gl_Position = vClip;
}
`;

const FRAG = /* glsl */ `
#define NW ${WAVE_COUNT}
#define NR ${RIPPLE_SLOTS}
precision highp float;

#include <common>
#include <packing>

uniform float uTime;
uniform float uLevel;
uniform vec3 uCamPos;
uniform float uNear;
uniform float uFar;

uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform sampler2D uReflection;
uniform mat4 uReflMatrix;
uniform float uReflMix;
uniform sampler2D uWaveA;
uniform sampler2D uWaveB;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunPower;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyZenith;
uniform vec3 uFogColor;
uniform float uFogDensity;

uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform vec3 uAbsorb;
uniform vec3 uFoamColor;
uniform vec3 uSSSColor;

uniform float uDetail;
uniform float uRefract;
uniform float uReflDistort;
uniform float uFoamAmount;
uniform float uScatterGain;
uniform float uDebug;
uniform float uUnderwater;

${WAVE_GLSL}
${RIPPLE_GLSL}

varying vec3 vWorld;
varying vec3 vWaveN;
varying vec3 vSU;
varying vec3 vFlow;
varying float vDepth;
varying float vAmp;
varying float vWaveH;
varying float vViewZ;
varying float vRayK;
varying vec4 vClip;

float eyeDepth(vec2 uv) {
  float d = texture2D(uSceneDepth, uv).x;
  return -perspectiveDepthToViewZ(d, uNear, uFar);
}

vec2 nrm2(vec4 t) { return t.xy * 2.0 - 1.0; }

// One flow-advected normal layer. Two half-period-offset samples cross faded so
// the texture never smears without bound where the flow direction diverges.
vec2 flowLayer(sampler2D tex, vec2 p, vec2 dir, float scroll, float period, float rot) {
  float cr = cos(rot), sr = sin(rot);
  vec2 q = vec2(p.x * cr - p.y * sr, p.x * sr + p.y * cr);
  float ph = uTime / period;
  float f0 = fract(ph);
  float f1 = fract(ph + 0.5);
  vec2 o0 = dir * (-(f0 - 0.5) * period * scroll);
  vec2 o1 = dir * (-(f1 - 0.5) * period * scroll);
  vec2 a = nrm2(texture2D(tex, q + o0));
  vec2 b = nrm2(texture2D(tex, q + o1));
  return mix(a, b, abs(1.0 - 2.0 * f0));
}

float flowAlpha(sampler2D tex, vec2 p, vec2 dir, float scroll, float period) {
  float ph = uTime / period;
  float f0 = fract(ph);
  float f1 = fract(ph + 0.5);
  float a = texture2D(tex, p + dir * (-(f0 - 0.5) * period * scroll)).a;
  float b = texture2D(tex, p + dir * (-(f1 - 0.5) * period * scroll)).a;
  return mix(a, b, abs(1.0 - 2.0 * f0));
}

vec3 skyApprox(vec3 d) {
  float up = clamp(d.y, 0.0, 1.0);
  return mix(uSkyHorizon, uSkyZenith, pow(up, 0.62));
}

void main() {
  vec2 uv = vClip.xy / vClip.w * 0.5 + 0.5;
  vec3 toCam = uCamPos - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);
  // Which side are we looking at? Comparing the eye height to this fragment's
  // own surface height is exact, stable, and handles a camera sitting right on
  // the waterline (near water reads top-side, water above the eye reads under-
  // side) without depending on triangle winding.
  bool below = (vWorld.y > uCamPos.y) || uUnderwater > 0.5;
  float facing = below ? -1.0 : 1.0;

  vec2 fdir = normalize(vFlow.xy + vec2(1e-5, 0.0));
  vec2 fperp = vec2(-fdir.y, fdir.x);
  float fspeed = max(vFlow.z, 0.0);

  // ---- surface normal --------------------------------------------------
  float detFade = mix(1.0, 0.42, smoothstep(26.0, 190.0, vViewZ));
  float calm = 0.35 + 0.65 * vAmp;
  vec2 d0 = flowLayer(uWaveA, vWorld.xz * 0.085, fdir, fspeed * 0.9, 3.1, 0.0);
  vec2 d1 = flowLayer(uWaveB, vWorld.xz * 0.34, fdir, fspeed * 1.15, 2.2, 0.7);
  vec2 d2 = nrm2(texture2D(uWaveB, vWorld.xz * 1.25 + fdir * (-uTime * fspeed * 0.55)));
  vec2 det = (d0 * 1.05 + d1 * 0.8 + d2 * 0.45) * uDetail * detFade * calm;

  float rh, rfoam; vec2 rgrad;
  rh = 0.0; rfoam = 0.0; rgrad = vec2(0.0);
  if (vViewZ < 70.0) ripplesAt(vWorld.xz, rh, rfoam, rgrad);
  det += clamp(rgrad * 1.3, vec2(-1.4), vec2(1.4));

  vec3 waveN = normalize(vWaveN);
  vec3 T = normalize(cross(waveN, vec3(0.0, 0.0, 1.0)));
  vec3 B = cross(T, waveN);
  vec3 nT = normalize(vec3(det.x, det.y, 1.0));
  vec3 N = normalize(T * nT.x + B * nT.y + waveN * nT.z);
  vec3 Nf = N * facing;

  // ---- how much water is between us and the bed ------------------------
  // Screen-space depth is what makes the shallows glow around the duck's feet,
  // but it is only trustworthy when we are looking INTO the water. Along the
  // surface, a centimetre of wave displacement moves the sampled point by
  // metres, so the comparison bands along every crest — there we fall back to
  // the river's own depth, which is exact and perfectly stable.
  float cosV = clamp(dot(Nf, V), 0.0, 1.0);
  float sceneZ = eyeDepth(uv);
  bool skyBehind = sceneZ > uFar * 0.85;
  float stillDepth = max(vDepth, 0.0);
  float analytic = min(stillDepth / max(abs(V.y), 0.16), 26.0);
  float ssThick = min(max(0.0, sceneZ - vViewZ) * vRayK, 26.0);
  float ssW = smoothstep(0.05, 0.26, cosV) * (1.0 - smoothstep(30.0, 80.0, vViewZ));
  if (skyBehind) ssW = 0.0;
  float thick = mix(analytic, ssThick, ssW);

  // ---- one definition of where the shore is ----------------------------
  // vDepth is the SIGNED still-water depth baked from the same river bed the
  // ground ribbon is built from, and vSU.z is metres back from that same
  // waterline. The alpha ramp, the wet band and the foam all key off these two,
  // so the water's edge is an analytic contour of a smooth interpolated value
  // rather than the intersection of two coarse meshes — which is what used to
  // stair-step. geoDepth is a safety net only: where the ground ribbon's own
  // linear interpolation dips below the still level between its columns, the
  // rendered depth rescues the alpha so no unwatered wedge can open up.
  float bankM = vSU.z;
  float geoDepth = min(ssThick * abs(V.y), 0.7) * ssW;
  float shoreA = smoothstep(0.0, 0.60, bankM) * smoothstep(0.006, 0.05, vDepth);
  float shoreAlpha = max(shoreA, smoothstep(0.05, 0.24, geoDepth));

  // ---- refraction ------------------------------------------------------
  float bend = uRefract * min(thick, 4.0) / max(1.0, vViewZ * 0.55);
  vec2 off = Nf.xz * bend;
  vec2 uvR = uv + off;
  float zR = eyeDepth(uvR);
  if (zR < vViewZ - 0.02) { uvR = uv; off = vec2(0.0); }
  uvR = clamp(uvR, vec2(0.0015), vec2(0.9985));
  float disp = (1.0 - cosV) * 0.9 + 0.1;
  vec3 refr;
  refr.r = texture2D(uSceneColor, clamp(uv + off * (1.0 + 0.055 * disp), vec2(0.0015), vec2(0.9985))).r;
  refr.g = texture2D(uSceneColor, uvR).g;
  refr.b = texture2D(uSceneColor, clamp(uv + off * (1.0 - 0.055 * disp), vec2(0.0015), vec2(0.9985))).b;
  float pathThick = clamp(thick, 0.0, 26.0);

  // ---- depth colour: Beer-Lambert absorption + scattering --------------
  // The light available to scatter back out. Keeping this in the same units the
  // terrain is lit in is what stops the river reading as a dark hole cut into a
  // bright valley — the single biggest thing between "tech demo" and "river".
  float sunUp = clamp(uSunDir.y, 0.0, 1.0);
  vec3 sunLit = uSunColor * uSunPower * (0.10 + 0.55 * sunUp);
  vec3 skyLit = min(mix(uSkyHorizon, uSkyZenith, 0.35), vec3(2.2));
  vec3 lightIn = sunLit * 0.42 + skyLit * 0.55;
  vec3 trans = exp(-uAbsorb * pathThick);
  float macro = texture2D(uWaveA, vWorld.xz * 0.0042).a;
  vec3 albedo = mix(uShallowColor * (0.84 + 0.32 * macro), uDeepColor,
                    smoothstep(0.25, 3.4, pathThick));
  vec3 water = refr * trans + albedo * lightIn * (1.0 - trans) * uScatterGain;

  // ---- subsurface glow through the crests ------------------------------
  float backLit = pow(clamp(dot(uSunDir, -V) * 0.5 + 0.5, 0.0, 1.0), 3.5);
  float crest = clamp(vWaveH / max(0.02, ${WAVE_AMP_TOTAL.toFixed(4)} * vAmp), -1.0, 1.0);
  float sss = clamp(crest, 0.0, 1.0) * backLit * smoothstep(0.05, 1.2, pathThick);
  water += uSSSColor * uSunColor * sss * 0.55 * (0.35 + 0.65 * sunUp);

  // ---- reflection ------------------------------------------------------
  vec3 R = reflect(-V, Nf);
  vec4 rq = uReflMatrix * vec4(vWorld, 1.0);
  vec2 ruv = rq.xy / max(rq.w, 1e-4);
  // Keep a floor under the distortion at distance: with none, the far surface
  // samples a few texels of the reflection target across hundreds of pixels
  // and the smear reads as flat polygonal bands.
  float distk = uReflDistort * (0.3 + 0.7 / max(1.0, sqrt(vViewZ)));
  ruv += vec2(Nf.x, Nf.z * 2.2) * distk;
  vec3 refl;
  if (uReflMix > 0.01 && ruv.x > -0.05 && ruv.x < 1.05 && ruv.y > -0.05 && ruv.y < 1.05) {
    vec2 c = clamp(ruv, vec2(0.002), vec2(0.998));
    // Grazing reflections come off a low-resolution target stretched over many
    // screen rows; without widening the blur there they alias into hard
    // horizontal bands across the whole distance.
    vec2 blur = (vec2(Nf.z, -Nf.x) * distk * 0.5 + vec2(0.0, 0.0026))
              * (1.0 + 3.5 * (1.0 - cosV));
    refl = (texture2D(uReflection, c).rgb * 2.0
          + texture2D(uReflection, clamp(c + blur, vec2(0.002), vec2(0.998))).rgb
          + texture2D(uReflection, clamp(c - blur, vec2(0.002), vec2(0.998))).rgb) * 0.25;
    refl = mix(skyApprox(R), refl, uReflMix);
  } else {
    refl = skyApprox(R);
  }
  // You never see a clean mirror of a dark bank: between the wavelets there is
  // always sky. A small sky floor keeps shaded reflections from reading as mud.
  // You never see a clean mirror of a dark bank: between the wavelets there is
  // always sky. A small sky floor keeps shaded reflections from reading as mud.
  refl = mix(refl, skyApprox(R), 0.2);
  // Aerial perspective INSIDE the reflection. A grazing reflected ray travels
  // far further than the view ray that lands on the surface, so a reflected far
  // bank has to sit deeper in the haze than the water it is reflected in —
  // without this, dark hills reflect as dark holes and the river goes to mud.
  float reflPath = vViewZ * (1.0 + 3.2 * (1.0 - cosV)) + 12.0;
  float reflFog = 1.0 - exp(-uFogDensity * uFogDensity * reflPath * reflPath);
  refl = mix(refl, uFogColor, clamp(reflFog, 0.0, 0.9));

  // ---- foam ------------------------------------------------------------
  // Three sources: a band measured in METRES back from the waterline (so it is
  // the same width whether the river is 14 m or 38 m across), screen-space
  // contact foam wherever the water thins out over anything solid, and the live
  // ripple rings. All dissolved through a drifting cloud mask so the waterline
  // is never a drawn white line.
  float shoreT = ssThick;
  // Flat-topped: full strength for the first metre or so of water, then out.
  // It has to be measured from the REAL waterline: on a bend |u| = 1 can be
  // eleven metres out on a dry bar, and keying the band off it is what painted
  // a saturated white sheet across the whole point bar.
  float shoreBand = 1.0 - smoothstep(0.25, 2.9, max(bankM, 0.0));
  // Contact foam is for ducks, rocks and the last inches of the beach. Viewed
  // edge-on, deep water an inch in front of a far bank also reports a thin
  // column, so gate it on the real depth and on distance or the whole middle
  // distance bands over with false foam.
  float contact = (1.0 - smoothstep(0.06, 0.55, shoreT))
                * (1.0 - smoothstep(0.5, 2.2, stillDepth)) * ssW;
  float wet = max(shoreBand, contact * 0.95);
  float wob = 0.11 * sin(vWorld.x * 1.6 + uTime * 1.15) + 0.11 * sin(vWorld.z * 2.0 - uTime * 1.55);
  float fnA = flowAlpha(uWaveA, vWorld.xz * 0.13, fdir, fspeed * 0.55, 3.4);
  float fnB = texture2D(uWaveB, vWorld.xz * 0.55 + fdir * (-uTime * fspeed * 0.42)).a;
  float foamNoise = fnA * 0.75 + fnB * 0.45;
  // Deliberately never reaches 1: a solid uFoamColor sheet against a low sun is
  // a blown highlight, and it was the brightest thing in the frame.
  float shoreFoam = smoothstep(0.46, 1.12,
      wet * 0.70 + foamNoise * 0.66 + wob * 0.36 + vWaveH * 1.6);

  // streaks in the fast shallow water and downstream of anything solid
  vec2 sUV = vec2(dot(vWorld.xz, fdir) * 0.055 - uTime * fspeed * 0.055,
                  dot(vWorld.xz, fperp) * 0.6);
  float streakN = texture2D(uWaveA, sUV).a;
  float fastMask = smoothstep(1.0, 1.8, fspeed) * (1.0 - smoothstep(0.5, 1.9, vDepth));
  float obstruct = (1.0 - smoothstep(0.3, 1.6, shoreT)) * ssW;
  float streak = smoothstep(0.5, 0.92, streakN * (0.5 + 0.75 * max(fastMask, obstruct * 0.9)))
               * max(fastMask, obstruct * 0.8);

  float ripFoam = smoothstep(0.20, 0.80, rfoam * (0.5 + 0.85 * foamNoise));
  float foam = clamp(max(max(shoreFoam, streak * 0.8), ripFoam) * uFoamAmount, 0.0, 0.92);
  // Foam only exists where there is water under it.
  foam *= shoreAlpha;

  // ---- specular: the sun glitter track ---------------------------------
  vec3 H = normalize(uSunDir + V);
  float sparkle = texture2D(uWaveB, vWorld.xz * 2.6 + fdir * (-uTime * (0.35 + fspeed * 0.5))).a;
  float sparkle2 = texture2D(uWaveB, vWorld.xz * 5.3 - fperp * (uTime * 0.21)).a;
  float glint = 0.35 + 2.6 * sparkle * (0.4 + 0.9 * sparkle2);
  float nh = clamp(dot(Nf, H), 0.0, 1.0);
  float spec = pow(nh, 620.0) * 1.6 * glint + pow(nh, 78.0) * 0.16;
  spec *= smoothstep(-0.02, 0.09, uSunDir.y);
  spec *= (1.0 - foam * 0.55);
  vec3 specular = uSunColor * uSunPower * spec;

  // ---- fresnel and composite -------------------------------------------
  float F = 0.02 + 0.98 * pow(1.0 - cosV, 5.0);
  F *= 1.0 - foam * 0.8;
  vec3 col;

  if (below) {
    // From underneath: Snell's window overhead, total internal reflection at
    // the edges, silvery and mirror-like at grazing angles.
    float ct = clamp(dot(Nf, V), 0.0, 1.0);
    float window = smoothstep(0.575, 0.79, ct);
    vec2 wuv = clamp(uv + Nf.xz * 0.22 * (1.0 - ct), vec2(0.0015), vec2(0.9985));
    vec3 above = texture2D(uSceneColor, wuv).rgb;
    vec3 mirror = mix(uDeepColor * lightIn * 2.2, refr * 0.55, 0.45);
    col = mix(mirror, above * 1.04, window);
    col += specular * (0.25 + 0.75 * window);
    col = mix(col, uFoamColor * lightIn, foam * 0.5);
  } else {
    col = mix(water, refl, F);
    // Foam is scattered water, not a light source: it takes the ambient it sits
    // in with a touch of sun, and the wet band underneath keeps showing through.
    col = mix(col, uFoamColor * (lightIn * 0.62 + sunLit * 0.34), foam);
    col += specular;
  }

  // Debug channels for the capture harness: water.debug(n).
  if (uDebug > 0.5) {
    if (uDebug < 1.5) col = vec3(foam);
    else if (uDebug < 2.5) col = vec3(pathThick / 6.0);
    else if (uDebug < 3.5) col = vec3(clamp(bankM / 4.0, 0.0, 1.0));
    else if (uDebug < 4.5) col = vec3(F);
    else if (uDebug < 5.5) col = Nf * 0.5 + 0.5;
    else col = vec3(shoreAlpha);
    gl_FragColor = vec4(col, 1.0);
    return;
  }

  // ---- fog, matching THREE.FogExp2 -------------------------------------
  float fogF = 1.0 - exp(-uFogDensity * uFogDensity * vViewZ * vViewZ);
  col = mix(col, uFogColor, clamp(fogF, 0.0, 1.0));

  // Opaque everywhere there is real water — any translucency out in the channel
  // lets the far bank's big flat triangles show through as pale polygonal
  // patches lying on the river — and a soft ramp to nothing over the last half
  // metre of the shore, on the same signed depth the ground shades its wet band
  // with. The outer skirt fade is a belt-and-braces cut for the overlap that
  // runs under the beach.
  float edge = 1.0 - smoothstep(1.0, 1.05, abs(vSU.y));
  float alpha = (below ? max(shoreAlpha, 0.9) : shoreAlpha) * edge;
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;

export function createWaterMaterial({
  level = 0,
  anisotropy = 4,
  textures = null,
} = {}) {
  const waveArray = [];
  for (const w of WAVES) waveArray.push(new THREE.Vector4(w.angle, w.lambda, w.amp, w.steep));
  const ripA = [];
  const ripB = [];
  for (let i = 0; i < RIPPLE_SLOTS; i++) {
    ripA.push(new THREE.Vector4(0, 0, 0, 0));
    ripB.push(new THREE.Vector4(1, 0, 0, 1));
  }

  const uniforms = {
    uTime: { value: 0 },
    uLevel: { value: level },
    uCamPos: { value: new THREE.Vector3() },
    uNear: { value: 0.1 },
    uFar: { value: 900 },

    uSceneColor: { value: null },
    uSceneDepth: { value: null },
    uReflection: { value: null },
    uReflMatrix: { value: new THREE.Matrix4() },
    uReflMix: { value: 0.0 },
    uWaveA: { value: textures?.waveA ?? null },
    uWaveB: { value: textures?.waveB ?? null },

    uWaves: { value: waveArray },
    uRipA: { value: ripA },
    uRipB: { value: ripB },
    uRipCount: { value: 0 },

    uSunDir: { value: new THREE.Vector3(0.836, 0.26, 0.487) },
    uSunColor: { value: new THREE.Color(1.0, 0.85, 0.66) },
    uSunPower: { value: 3.2 },
    uSkyHorizon: { value: new THREE.Color(0.62, 0.72, 0.82) },
    uSkyZenith: { value: new THREE.Color(0.24, 0.42, 0.72) },
    uFogColor: { value: new THREE.Color(0.62, 0.72, 0.8) },
    uFogDensity: { value: 0.0024 },

    // Honeyed light against teal shadow: the shallows read warm green, the
    // channel reads deep blue-teal, and red is absorbed fastest.
    uShallowColor: { value: new THREE.Color(0.33, 0.49, 0.35) },
    uDeepColor: { value: new THREE.Color(0.055, 0.185, 0.225) },
    uAbsorb: { value: new THREE.Vector3(0.40, 0.125, 0.082) },
    uScatterGain: { value: 1.32 },
    uFoamColor: { value: new THREE.Color(1.0, 0.98, 0.94) },
    uSSSColor: { value: new THREE.Color(0.55, 0.95, 0.62) },

    uDetail: { value: 0.78 },
    uRefract: { value: 0.055 },
    uReflDistort: { value: 0.105 },
    uFoamAmount: { value: 1.0 },
    uUnderwater: { value: 0.0 },
    uDebug: { value: 0.0 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false,
    // No offset of its own: the ground is the surface that gets pushed back, so
    // the water wins every tie. Offsetting the water too made its (very large)
    // depth slope at grazing angles push it behind the beach in patches, which
    // is half of where the shoreline's dark wedges came from.
    polygonOffset: false,
  });
  mat.name = 'WaterSurface';
  mat.userData.uniforms = uniforms;
  return mat;
}
