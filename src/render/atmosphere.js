// Atmosphere helpers for the sky/lighting system.
//
// Everything here is analytic and deterministic: a single-scattering
// Rayleigh + Mie model with hand-tuned artistic tint curves on top, evaluated
// twice — once in GLSL for the sky dome, once in JS so fog, ambient and the
// light rig can read the *same* colours the sky is painting.
//
// Owned by the sky system (see CONTRACT.md). Nothing else should import this
// expecting stability, but nothing here mutates shared state either.

import * as THREE from 'three';
import { GLSL_NOISE } from '../core/noise.js';

// ---------------------------------------------------------------------------
// small math
// ---------------------------------------------------------------------------

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const mix = (a, b, t) => a + (b - a) * t;
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Piecewise-linear keyframe lookup. stops = [[x, v], …] ascending in x. */
export function lerpStops(stops, x) {
  const n = stops.length;
  if (x <= stops[0][0]) return stops[0][1];
  if (x >= stops[n - 1][0]) return stops[n - 1][1];
  for (let i = 0; i < n - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (x <= b[0]) {
      const t = (x - a[0]) / (b[0] - a[0]);
      return mix(a[1], b[1], t);
    }
  }
  return stops[n - 1][1];
}

/** Same but for [r,g,b] triples; writes into `out` (length 3). */
export function lerpStops3(stops, x, out) {
  const n = stops.length;
  let a = stops[0], b = stops[0], t = 0;
  if (x <= stops[0][0]) { a = b = stops[0]; t = 0; }
  else if (x >= stops[n - 1][0]) { a = b = stops[n - 1]; t = 0; }
  else {
    for (let i = 0; i < n - 1; i++) {
      if (x <= stops[i + 1][0]) {
        a = stops[i]; b = stops[i + 1];
        t = (x - a[0]) / (b[0] - a[0]);
        break;
      }
    }
  }
  out[0] = mix(a[1][0], b[1][0], t);
  out[1] = mix(a[1][1], b[1][1], t);
  out[2] = mix(a[1][2], b[1][2], t);
  return out;
}

// ---------------------------------------------------------------------------
// solar geometry
// ---------------------------------------------------------------------------

// timeOfDay 0..1. Sunrise / sunset chosen so that 0.30 is a low golden morning
// (~15 degrees) and 0.76 is a low golden evening (~7 degrees).
export const T_RISE = 0.235;
export const T_SET = 0.792;
export const MAX_ELEV_DEG = 42.0;
// how much of the sine the sun is allowed to dip below the horizon; keeps
// twilight long and gentle instead of snapping to night.
const BELOW_SQUASH = 0.30;

/** Sun elevation in degrees for a time of day. */
export function sunElevationDeg(t) {
  const f = (t - T_RISE) / (T_SET - T_RISE);
  let s = Math.sin(Math.PI * f);
  if (s < 0) s *= BELOW_SQUASH;
  return s * MAX_ELEV_DEG;
}

/**
 * Azimuth in degrees, 0 = +Z (downstream). The sun swings from front-right in
 * the morning through near-downstream at noon to front-left in the evening, so
 * the river is back-lit for most of the playable day — the money light.
 */
export function sunAzimuthDeg(t) {
  const f = clamp((t - T_RISE) / (T_SET - T_RISE), -0.22, 1.22);
  return 78.0 - 156.0 * f;
}

/** Unit vector pointing FROM the scene TOWARD the sun. */
export function sunDirectionFor(t, out) {
  const el = sunElevationDeg(t) * Math.PI / 180;
  const az = sunAzimuthDeg(t) * Math.PI / 180;
  const ce = Math.cos(el);
  out.set(Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce);
  return out.normalize();
}

// ---------------------------------------------------------------------------
// scattering constants
// ---------------------------------------------------------------------------

// Zenith optical depths (beta * scale height), Rayleigh at sea level.
const BETA_R = [0.0464, 0.1080, 0.2650];
// Mie zenith optical depth per unit turbidity, very slightly warm-biased.
const BETA_M_BASE = [0.0110, 0.0106, 0.0100];

// ---------------------------------------------------------------------------
// artistic curves, keyed on sun elevation in degrees
// ---------------------------------------------------------------------------

const S_ZENITH_TINT = [
  [-13, [0.30, 0.42, 0.94]],
  [-6, [0.46, 0.62, 1.14]],
  [-1.5, [0.67, 0.85, 1.32]],
  [4, [0.81, 1.01, 1.44]],
  [15, [0.90, 1.08, 1.46]],
  [28, [0.98, 1.14, 1.44]],
  [42, [1.04, 1.18, 1.39]],
];

const S_HORIZON_TINT = [
  [-13, [1.10, 0.55, 0.62]],
  [-6, [1.82, 0.78, 0.60]],
  [-1.5, [2.20, 0.98, 0.56]],
  [4, [2.02, 1.10, 0.64]],
  [15, [1.72, 1.14, 0.78]],
  [28, [1.38, 1.15, 0.98]],
  [42, [1.22, 1.14, 1.06]],
];

// additive haze band at the horizon (linear HDR, small numbers)
const S_HAZE_COLOR = [
  [-13, [0.012, 0.010, 0.020]],
  [-6, [0.058, 0.029, 0.026]],
  [-1.5, [0.115, 0.060, 0.034]],
  [4, [0.125, 0.078, 0.048]],
  [15, [0.108, 0.082, 0.062]],
  [28, [0.084, 0.081, 0.077]],
  [42, [0.076, 0.077, 0.079]],
];

// multiple-scattering fill: cool teal, this is the "shadow" half of the palette
const S_MS_COLOR = [
  [-13, [0.10, 0.16, 0.30]],
  [-6, [0.18, 0.28, 0.46]],
  [-1.5, [0.26, 0.42, 0.62]],
  [4, [0.32, 0.50, 0.72]],
  [15, [0.36, 0.55, 0.78]],
  [42, [0.42, 0.60, 0.80]],
];

const S_TWILIGHT_WARM = [
  [-14, [0.030, 0.012, 0.016]],
  [-8, [0.115, 0.042, 0.040]],
  [-3.5, [0.320, 0.115, 0.075]],
  [0.5, [0.400, 0.170, 0.095]],
  [5, [0.230, 0.115, 0.075]],
  [11, [0.045, 0.026, 0.020]],
  [16, [0.0, 0.0, 0.0]],
];

const S_TWILIGHT_COOL = [
  [-14, [0.062, 0.062, 0.150]],
  [-6, [0.098, 0.094, 0.200]],
  [0, [0.090, 0.096, 0.186]],
  [8, [0.036, 0.043, 0.083]],
  [16, [0.0, 0.0, 0.0]],
];

const S_TURBIDITY = [
  [-10, 2.9], [0, 3.1], [10, 2.5], [25, 2.1], [42, 1.95],
];

const S_EXPOSURE = [
  [-13, 2.30], [-6, 1.88], [-1, 1.44], [6, 1.14], [15, 0.99], [28, 0.88], [42, 0.83],
];

const S_SUN_LIGHT = [ // directional light intensity
  [-8, 0.00], [-2.0, 0.24], [1.5, 1.75], [6, 3.30], [15, 4.30], [28, 5.00], [42, 5.30],
];

const S_FOG_DENSITY = [
  [-13, 0.0044], [-4, 0.0038], [3, 0.0031], [15, 0.0024], [28, 0.0020], [42, 0.0019],
];

const S_CLOUD_SUN = [
  [-13, [0.020, 0.012, 0.018]],
  [-5, [0.235, 0.105, 0.080]],
  [0, [0.900, 0.430, 0.250]],
  [6, [2.00, 1.32, 0.80]],
  [15, [2.06, 1.64, 1.18]],
  [28, [1.98, 1.78, 1.50]],
  [42, [2.02, 1.92, 1.78]],
];

const S_CLOUD_AMB_TOP = [
  [-13, [0.020, 0.026, 0.066]],
  [-5, [0.058, 0.064, 0.140]],
  [0, [0.116, 0.128, 0.202]],
  [6, [0.162, 0.198, 0.296]],
  [15, [0.190, 0.250, 0.372]],
  [42, [0.228, 0.294, 0.430]],
];

const S_CLOUD_AMB_BOT = [
  [-13, [0.008, 0.011, 0.034]],
  [-5, [0.020, 0.027, 0.072]],
  [0, [0.034, 0.055, 0.120]],
  [6, [0.042, 0.082, 0.180]],
  [15, [0.048, 0.104, 0.232]],
  [42, [0.058, 0.128, 0.272]],
];

const S_GROUND = [ // colour the dome fades to below the horizon
  [-13, [0.016, 0.019, 0.038]],
  [-5, [0.052, 0.054, 0.080]],
  [0, [0.090, 0.086, 0.094]],
  [6, [0.115, 0.124, 0.140]],
  [15, [0.128, 0.148, 0.172]],
  [42, [0.135, 0.158, 0.184]],
];

const NIGHT_COLOR = [0.0090, 0.0135, 0.0300];

export const SUN_INTENSITY = 18.0;
export const SUN_DISC_INTENSITY = 260.0;
export const SUN_ANG_RAD = 0.0165; // ~0.95 degrees, a touch bigger than real
export const MS_STRENGTH = 0.044;
export const HAZE_FALLOFF = 7.5;
// Single scattering with a physical Mie phase makes the sky within ~30 deg of a
// low sun 10x brighter than everything else, which tone maps to a flat white
// blob. Attenuating just the Mie in-scatter keeps the deep zenith blue and the
// warm horizon band while letting the aureole live in the sun-disc term where
// its size and falloff are art-directable.
export const MIE_GAIN = 0.30;

const CLOUD_BOTTOM = 850.0;
const CLOUD_TOP = 2600.0;

// ---------------------------------------------------------------------------
// parameter block
// ---------------------------------------------------------------------------

/**
 * Everything the sky shader and the light rig need for a given time of day.
 * Pure function of `t` — call it, then copy into uniforms.
 */
export function skyParams(t, out = null) {
  const p = out || {
    zenithTint: [0, 0, 0], horizonTint: [0, 0, 0], hazeColor: [0, 0, 0],
    msColor: [0, 0, 0], twilightWarm: [0, 0, 0], twilightCool: [0, 0, 0],
    cloudSun: [0, 0, 0], cloudAmbTop: [0, 0, 0], cloudAmbBot: [0, 0, 0],
    ground: [0, 0, 0], betaM: [0, 0, 0], nightColor: NIGHT_COLOR.slice(),
    sunDir: [0, 0, 0],
  };
  p.timeOfDay = t;
  const el = sunElevationDeg(t);
  const az = sunAzimuthDeg(t);
  p.elevationDeg = el;
  p.azimuthDeg = az;

  const elr = el * Math.PI / 180, azr = az * Math.PI / 180;
  const ce = Math.cos(elr);
  p.sunDir[0] = Math.sin(azr) * ce;
  p.sunDir[1] = Math.sin(elr);
  p.sunDir[2] = Math.cos(azr) * ce;

  lerpStops3(S_ZENITH_TINT, el, p.zenithTint);
  lerpStops3(S_HORIZON_TINT, el, p.horizonTint);
  lerpStops3(S_HAZE_COLOR, el, p.hazeColor);
  lerpStops3(S_MS_COLOR, el, p.msColor);
  lerpStops3(S_TWILIGHT_WARM, el, p.twilightWarm);
  lerpStops3(S_TWILIGHT_COOL, el, p.twilightCool);
  lerpStops3(S_CLOUD_SUN, el, p.cloudSun);
  lerpStops3(S_CLOUD_AMB_TOP, el, p.cloudAmbTop);
  lerpStops3(S_CLOUD_AMB_BOT, el, p.cloudAmbBot);
  lerpStops3(S_GROUND, el, p.ground);

  p.turbidity = lerpStops(S_TURBIDITY, el);
  p.exposure = lerpStops(S_EXPOSURE, el);
  p.sunLightIntensity = lerpStops(S_SUN_LIGHT, el);
  p.fogDensity = lerpStops(S_FOG_DENSITY, el);

  p.betaM[0] = BETA_M_BASE[0] * p.turbidity;
  p.betaM[1] = BETA_M_BASE[1] * p.turbidity;
  p.betaM[2] = BETA_M_BASE[2] * p.turbidity;

  p.mieG = mix(0.84, 0.72, smoothstep(0, 22, el));
  p.mieGain = MIE_GAIN;
  p.night = smoothstep(2.0, -9.0, el);
  p.twilight = smoothstep(15.0, -2.0, el) * (1.0 - 0.55 * smoothstep(-4.0, -13.0, el));
  p.hazeStrength = mix(1.30, 0.66, smoothstep(-2, 20, el));
  p.saturation = mix(1.16, 1.06, smoothstep(-2, 24, el));
  p.sunIntensity = SUN_INTENSITY;
  p.sunDiscVisible = smoothstep(-0.035, 0.004, p.sunDir[1]);
  p.cirrus = mix(0.30, 0.46, smoothstep(-2, 18, el));
  // Coverage breathes very slowly over the day but is a pure function of t.
  p.cloudCoverage = 0.425 - 0.05 * Math.sin(t * 6.2831853 * 2.0 + 1.1);
  p.cloudStrength = 1.0;
  return p;
}

// ---------------------------------------------------------------------------
// CPU evaluation of the analytic sky (no clouds, no sun disc)
// ---------------------------------------------------------------------------

function airMass(c) {
  const cc = Math.max(c, 0.0);
  return 1.0 / (cc + 0.025 * Math.exp(-11.0 * cc));
}

function hg(cosT, g) {
  const gg = g * g;
  const d = 1.0 + gg - 2.0 * g * cosT;
  return (1.0 - gg) / (12.5663706 * Math.max(d, 1e-4) * Math.sqrt(Math.max(d, 1e-4)));
}

const _c3 = [0, 0, 0];

/**
 * Linear HDR radiance of the analytic sky in direction (dx,dy,dz).
 * Mirrors `skyBase()` in the GLSL below so fog matches the horizon exactly.
 */
export function skyRadiance(dx, dy, dz, p, out = _c3) {
  const sd = p.sunDir;
  const cosVS = dx * sd[0] + dy * sd[1] + dz * sd[2];
  const vy = dy;
  const amView = airMass(vy);
  const sy = sd[1];
  const amSun = airMass(Math.max(sy, 0.004));
  const amSunEff = amSun * mix(1.0, 0.34, smoothstep(0.02, 0.9, Math.max(vy, 0)));

  const phR = 0.0596831 * (1.0 + cosVS * cosVS);
  const phM = hg(cosVS, p.mieG);
  const dayMask = smoothstep(-0.11, 0.05, sy);
  const hMix = Math.pow(clamp(1.0 - Math.max(vy, 0), 0, 1), 2.2);
  const hz = Math.exp(-Math.max(vy, 0) * HAZE_FALLOFF);
  const sunward = Math.pow(Math.max(cosVS, 0), 5.0);
  const msLift = Math.max(sy + 0.10, 0.0);

  for (let i = 0; i < 3; i++) {
    const bR = BETA_R[i], bM = p.betaM[i];
    const bt = bR + bM;
    const sunExt = Math.exp(-bt * amSunEff);
    const Tv = Math.exp(-bt * amView);
    const inscat = ((bR * phR + bM * phM * p.mieGain) / bt) * (1.0 - Tv);
    let c = p.sunIntensity * sunExt * inscat * dayMask;
    c *= mix(p.zenithTint[i], p.horizonTint[i], hMix);
    c += p.msColor[i] * MS_STRENGTH * p.sunIntensity * (1.0 - Tv) * msLift * dayMask;
    c += p.hazeColor[i] * mix(1.0, 1.9, sunward) * p.hazeStrength * hz * (0.22 + 0.78 * dayMask);
    c += p.twilight * (
      p.twilightWarm[i] * Math.exp(-Math.max(vy, 0) * 5.0) * (0.22 + 1.0 * Math.pow(Math.max(cosVS, 0), 1.6))
      + p.twilightCool[i] * Math.exp(-Math.max(vy, 0) * 1.5) * 0.6
    );
    c += p.nightColor[i] * p.night * (0.55 + 0.45 * smoothstep(-0.1, 0.9, vy));
    const g = smoothstep(0.0, -0.045, vy);
    c = mix(c, p.ground[i], g * 0.97);
    out[i] = Math.max(c, 0);
  }
  // saturation
  const l = out[0] * 0.2126 + out[1] * 0.7152 + out[2] * 0.0722;
  for (let i = 0; i < 3; i++) out[i] = Math.max(mix(l, out[i], p.saturation), 0);
  return out;
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const SKY_COMMON = /* glsl */ `
#define PI 3.141592653589793
#define CLOUD_BOTTOM ${CLOUD_BOTTOM.toFixed(1)}
#define CLOUD_TOP ${CLOUD_TOP.toFixed(1)}
#define HAZE_FALLOFF ${HAZE_FALLOFF.toFixed(2)}
#define MS_STRENGTH ${MS_STRENGTH.toFixed(4)}

uniform vec3  uSunDir;
uniform vec3  uBetaR;
uniform vec3  uBetaM;
uniform float uMieG;
uniform float uMieGain;
uniform float uSunIntensity;
uniform float uSunDisc;
uniform float uSunAngRad;
uniform float uSunDiscVisible;
uniform vec3  uZenithTint;
uniform vec3  uHorizonTint;
uniform vec3  uHazeColor;
uniform float uHazeStrength;
uniform vec3  uMsColor;
uniform vec3  uTwilightWarm;
uniform vec3  uTwilightCool;
uniform float uTwilight;
uniform float uNight;
uniform vec3  uNightColor;
uniform vec3  uGroundColor;
uniform float uSat;
uniform float uTime;
uniform float uCloudCoverage;
uniform float uCloudStrength;
uniform float uCloudSigma;
uniform float uCloudScale;
uniform vec3  uCloudSun;
uniform vec3  uCloudAmbTop;
uniform vec3  uCloudAmbBot;
uniform float uCirrus;

float airMass(float c){
  float cc = max(c, 0.0);
  return 1.0 / (cc + 0.025 * exp(-11.0 * cc));
}

float hgPhase(float cosT, float g){
  float gg = g * g;
  float d = max(1.0 + gg - 2.0 * g * cosT, 1e-4);
  return (1.0 - gg) / (12.5663706 * d * sqrt(d));
}

// Analytic sky without clouds. sunExtHoriz is the sun's own extinction along
// its full path — the colour of direct sunlight.
vec3 skyBase(vec3 dir, out vec3 sunExtHoriz){
  float vy = dir.y;
  float cosVS = dot(dir, uSunDir);
  float amView = airMass(vy);
  float sy = uSunDir.y;
  float amSun = airMass(max(sy, 0.004));
  float amSunEff = amSun * mix(1.0, 0.34, smoothstep(0.02, 0.9, max(vy, 0.0)));

  vec3 bt = uBetaR + uBetaM;
  vec3 sunExt = exp(-bt * amSunEff);
  sunExtHoriz = exp(-bt * amSun);
  vec3 Tv = exp(-bt * amView);

  float phR = 0.0596831 * (1.0 + cosVS * cosVS);
  float phM = hgPhase(cosVS, uMieG);
  vec3 inscat = ((uBetaR * phR + uBetaM * phM * uMieGain) / bt) * (1.0 - Tv);

  float dayMask = smoothstep(-0.11, 0.05, sy);
  vec3 col = uSunIntensity * sunExt * inscat * dayMask;

  float hMix = pow(clamp(1.0 - max(vy, 0.0), 0.0, 1.0), 2.2);
  col *= mix(uZenithTint, uHorizonTint, hMix);

  col += uMsColor * MS_STRENGTH * uSunIntensity * (1.0 - Tv) * max(sy + 0.10, 0.0) * dayMask;

  float hz = exp(-max(vy, 0.0) * HAZE_FALLOFF);
  float sunward = pow(max(cosVS, 0.0), 5.0);
  col += uHazeColor * mix(1.0, 1.9, sunward) * uHazeStrength * hz * (0.22 + 0.78 * dayMask);

  col += uTwilight * (
      uTwilightWarm * exp(-max(vy, 0.0) * 5.0) * (0.22 + pow(max(cosVS, 0.0), 1.6))
    + uTwilightCool * exp(-max(vy, 0.0) * 1.5) * 0.6);

  col += uNightColor * uNight * (0.55 + 0.45 * smoothstep(-0.1, 0.9, vy));

  float g = smoothstep(0.0, -0.045, vy);
  col = mix(col, uGroundColor, g * 0.97);
  return max(col, vec3(0.0));
}

vec3 sunDisc(vec3 dir, vec3 sunExt){
  float cosVS = dot(dir, uSunDir);
  float ang = acos(clamp(cosVS, -1.0, 1.0));
  float r = ang / uSunAngRad;
  // limb softening: no hard circle, and the very edge fades over ~25% of R
  float body = 1.0 - smoothstep(0.74, 1.10, r);
  float limb = pow(max(1.0 - r * r * 0.92, 0.0), 0.34);
  vec3 core = uSunDisc * sunExt * body * mix(0.55, 1.0, limb);
  // aureole: two exponential lobes, warm and wide
  float a1 = exp(-ang * 42.0);
  float a2 = exp(-ang * 11.0);
  float a3 = exp(-ang * 3.2);
  vec3 aur = uSunDisc * sunExt * (0.046 * a1 + 0.0070 * a2 + 0.0011 * a3);
  return (core + aur) * uSunDiscVisible;
}

// 2x2 ordered dither in [0,1). Period two texels exactly, which the [1,2,1]
// tent in sampleClouds() annihilates for any phase.
float bayer2(vec2 a){ a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }

float hash31(vec3 p){
  p = fract(p * 0.3183099 + vec3(0.11, 0.37, 0.71));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

vec3 starField(vec3 dir){
  if (uNight < 0.02 || dir.y < 0.0) return vec3(0.0);
  vec3 p = dir * 240.0;
  vec3 ip = floor(p);
  vec3 fp = fract(p) - 0.5;
  float h = hash31(ip);
  float on = step(0.9865, h);
  float h2 = hash31(ip + 3.7);
  float d2 = dot(fp, fp);
  float tw = 0.68 + 0.32 * sin(uTime * (1.1 + h2 * 2.4) + h * 40.0);
  float b = on * exp(-d2 * 120.0) * (0.35 + 0.65 * h2) * tw;
  vec3 tint = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.88, 0.74), h2);
  return tint * b * uNight * 2.2 * smoothstep(0.0, 0.30, dir.y);
}
`;

// The cumulus raymarch is the only expensive thing in the whole sky, so it is
// baked into a low-resolution HDR cube (premultiplied RGB + coverage in A) and
// composited into the crisp full-resolution analytic sky. Clouds are soft by
// nature, so the resolution loss reads as painterly rather than blurry, and the
// per-frame cost collapses to one cube tap.
const SKY_CLOUDS = /* glsl */ `
float cloudProfile(float h){
  // flat base, widest a third of the way up, dissolving cauliflower top
  return smoothstep(0.0, 0.11, h) * (1.0 - smoothstep(0.32, 0.94, h));
}

vec3 cloudSpace(vec3 p){
  vec3 q = p * uCloudScale;
  q.x += uTime * 0.0060;
  q.z += uTime * 0.0034;
  return q;
}

// Coverage threshold is modulated by the vertical profile, which is what makes
// a blob round in Y instead of a flat slab with soft edges.
float cloudCover(vec2 qxz){
  float w = snoise2(qxz * 0.80 + vec2(3.1, -1.7)) * 0.5 + 0.5;
  return clamp(uCloudCoverage * (0.14 + 1.86 * w * w), 0.0, 0.95);
}

// Cheap density used for the toward-the-sun shadow taps.
float cloudDensityLite(vec3 p){
  float h = clamp((p.y - CLOUD_BOTTOM) / (CLOUD_TOP - CLOUD_BOTTOM), 0.0, 1.0);
  float prof = cloudProfile(h);
  if (prof <= 0.002) return 0.0;
  vec3 q = cloudSpace(p);
  float base = snoise3(q) * 0.5 + 0.5;
  float thr = 1.0 - cloudCover(q.xz) * prof;
  return clamp((base - thr) / max(1.0 - thr, 0.03), 0.0, 1.0);
}

float cloudDensity(vec3 p){
  float h = clamp((p.y - CLOUD_BOTTOM) / (CLOUD_TOP - CLOUD_BOTTOM), 0.0, 1.0);
  float prof = cloudProfile(h);
  if (prof <= 0.002) return 0.0;
  vec3 q = cloudSpace(p);
  // Low-frequency weather mask: clumps the clouds into islands with generous
  // clear sky between them. Negative space matters as much as the clouds.
  float base = (snoise3(q) * 0.66 + snoise3(q * 2.2) * 0.34) * 0.5 + 0.5;
  float thr = 1.0 - cloudCover(q.xz) * prof;
  float d = clamp((base - thr) / max(1.0 - thr, 0.03), 0.0, 1.0);
  if (d > 0.02){
    // erosion grows with height: firm flat bases, cauliflower tops
    float er = snoise3(q * 2.6 + 9.0) * 0.5 + 0.5;
    d = clamp(d - (1.0 - er) * (0.10 + 0.40 * h), 0.0, 1.0);
  }
  // firm up the cores, thin out the fringes so the silhouette stays readable
  return d * d * (3.0 - 2.0 * d);
}

// premultiplied colour in .rgb, coverage in .a
vec4 marchClouds(vec3 dir, vec3 hazeCol){
  if (dir.y < 0.010) return vec4(0.0);
  float t0 = CLOUD_BOTTOM / dir.y;
  float t1 = min(CLOUD_TOP / dir.y, t0 + 4400.0);
  float dt = (t1 - t0) / float(CLOUD_STEPS);
  float cosVS = dot(dir, uSunDir);
  // forward scatter for the silver lining, plus a little back-scatter glow
  float phase = 0.55 + 1.10 * min(hgPhase(cosVS, 0.62), 1.0) + 0.30 * hgPhase(cosVS, 0.22);
  float T = 1.0;
  vec3 L = vec3(0.0);
  float jit = bayer2(gl_FragCoord.xy);
  for (int i = 0; i < CLOUD_STEPS; i++){
    float t = t0 + (float(i) + jit) * dt;
    vec3 p = dir * t;
    float d = cloudDensity(p);
    if (d > 0.004){
      float ls = cloudDensityLite(p + uSunDir * 200.0)
               + cloudDensityLite(p + uSunDir * 620.0) * 0.75
               + cloudDensityLite(p + uSunDir * 1500.0) * 0.5;
      float shadow = exp(-ls * 4.6);
      float powder = 1.0 - exp(-d * 6.5);
      float hN = clamp((p.y - CLOUD_BOTTOM) / (CLOUD_TOP - CLOUD_BOTTOM), 0.0, 1.0);
      vec3 amb = mix(uCloudAmbBot, uCloudAmbTop, hN * hN);
      // bases also catch a little light bounced up off the bright horizon
      amb += hazeCol * 0.05;
      vec3 sc = uCloudSun * shadow * phase * (0.18 + 0.82 * powder) + amb;
      float aT = exp(-d * uCloudSigma * dt);
      L += T * sc * (1.0 - aT);
      T *= aT;
      if (T < 0.02) break;
    }
  }
  float a = 1.0 - T;
  if (a <= 0.002) return vec4(0.0);
  // aerial perspective: distant cloud banks sink into the horizon haze
  // Aerial perspective only past a threshold, so near cumulus keep their cool
  // bases and only the distant bank of cloud melts into the horizon haze.
  float ap = 1.0 - exp(-max(t0 - 1700.0, 0.0) * 0.000075);
  L = mix(L, hazeCol * a, ap * 0.62);
  float k = smoothstep(0.014, 0.105, dir.y) * uCloudStrength;
  return vec4(L * k, a * k);
}

vec4 cirrusLayer(vec3 dir, vec3 hazeCol){
  if (dir.y < 0.028 || uCirrus < 0.01) return vec4(0.0);
  float t = 5800.0 / dir.y;
  vec2 uv = dir.xz * t * 0.000105;
  uv += vec2(uTime * 0.0038, uTime * 0.0019);
  // stretched along x so it streaks the way real cirrus does
  float n = fbm2(vec2(uv.x * 0.28, uv.y * 2.35), 4) * 0.5 + 0.5;
  float m = snoise2(uv * 2.6 + 7.0) * 0.5 + 0.5;
  float v = smoothstep(0.50, 0.88, n * 0.84 + m * 0.22);
  v *= smoothstep(0.028, 0.24, dir.y) * (1.0 - smoothstep(0.5, 1.0, dir.y) * 0.5);
  float a = clamp(v * uCirrus, 0.0, 1.0);
  if (a <= 0.002) return vec4(0.0);
  float cosVS = dot(dir, uSunDir);
  vec3 c = uCloudSun * (0.18 + 1.00 * pow(max(cosVS, 0.0), 5.0)) * 0.52 + uCloudAmbTop * 0.5;
  float ap = 1.0 - exp(-t * 0.000030);
  c = mix(c, hazeCol, ap * 0.5);
  return vec4(c * a, a);
}
`;

const SKY_MAIN = /* glsl */ `
varying vec3 vDir;

#ifdef CLOUD_PASS
void main(){
  vec3 dir = normalize(vDir);
  vec3 tmp;
  vec3 hazeCol = skyBase(normalize(vec3(dir.x, 0.014, dir.z)), tmp);
  vec4 o = cirrusLayer(dir, hazeCol);
  vec4 cu = marchClouds(dir, hazeCol);
  o.rgb = o.rgb * (1.0 - cu.a) + cu.rgb;
  o.a = o.a * (1.0 - cu.a) + cu.a;
  gl_FragColor = o;
}
#else
uniform samplerCube uCloudCube;
uniform float uCloudBlur;

vec4 sampleClouds(vec3 dir){
  // Separable [1,2,1] tent at one-texel spacing. A symmetric tent of width two
  // texels has *zero* response at the Nyquist frequency for any phase, which is
  // exactly what annihilates the period-2 march dither baked into the cube; it
  // also reconstructs the low-resolution cube without the cross-hatch that a
  // plus-shaped kernel leaves behind.
  // The taps must be axis-aligned with the *cube face* texel grid, otherwise a
  // rotated tent cannot cancel the checkerboard at all. Pick the face from the
  // dominant component; one texel of face parameter space is a direction offset
  // of (2/N) * m, where m is that dominant component of the unit direction.
  vec3 ad = abs(dir);
  float m = max(max(ad.x, ad.y), ad.z);
  vec3 a, b;
  if (m == ad.x)      { a = vec3(0.0, 0.0, 1.0); b = vec3(0.0, 1.0, 0.0); }
  else if (m == ad.y) { a = vec3(1.0, 0.0, 0.0); b = vec3(0.0, 0.0, 1.0); }
  else                { a = vec3(1.0, 0.0, 0.0); b = vec3(0.0, 1.0, 0.0); }
  float e = uCloudBlur * m;
  a *= e;
  b *= e;
  vec4 c = textureCube(uCloudCube, dir) * 0.25;
  c += (textureCube(uCloudCube, normalize(dir + a))
      + textureCube(uCloudCube, normalize(dir - a))
      + textureCube(uCloudCube, normalize(dir + b))
      + textureCube(uCloudCube, normalize(dir - b))) * 0.125;
  c += (textureCube(uCloudCube, normalize(dir + a + b))
      + textureCube(uCloudCube, normalize(dir + a - b))
      + textureCube(uCloudCube, normalize(dir - a + b))
      + textureCube(uCloudCube, normalize(dir - a - b))) * 0.0625;
  return c;
}

void main(){
  vec3 dir = normalize(vDir);
  vec3 sunExt;
  vec3 col = skyBase(dir, sunExt);
  col += starField(dir);
  col += sunDisc(dir, sunExt);

#ifdef USE_CLOUD_CUBE
  vec4 cl = sampleClouds(dir);
  col = col * (1.0 - clamp(cl.a, 0.0, 1.0)) + max(cl.rgb, vec3(0.0));
#endif

  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(l), col, uSat), vec3(0.0));
  gl_FragColor = vec4(col, 1.0);
}
#endif
`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Uniform block shared by the visible dome and the PMREM dome. */
export function makeSkyUniforms() {
  return {
    uSunDir: { value: new THREE.Vector3(0, 0.3, 1) },
    uBetaR: { value: new THREE.Vector3(BETA_R[0], BETA_R[1], BETA_R[2]) },
    uBetaM: { value: new THREE.Vector3(0.026, 0.025, 0.024) },
    uMieG: { value: 0.78 },
    uSunIntensity: { value: SUN_INTENSITY },
    uSunDisc: { value: SUN_DISC_INTENSITY },
    uSunAngRad: { value: SUN_ANG_RAD },
    uSunDiscVisible: { value: 1 },
    uZenithTint: { value: new THREE.Vector3(0.8, 0.94, 1.26) },
    uHorizonTint: { value: new THREE.Vector3(1.6, 1.16, 0.84) },
    uHazeColor: { value: new THREE.Vector3(0.14, 0.106, 0.08) },
    uHazeStrength: { value: 1.0 },
    uMsColor: { value: new THREE.Vector3(0.36, 0.55, 0.78) },
    uTwilightWarm: { value: new THREE.Vector3(0, 0, 0) },
    uTwilightCool: { value: new THREE.Vector3(0, 0, 0) },
    uTwilight: { value: 0 },
    uNight: { value: 0 },
    uNightColor: { value: new THREE.Vector3(...NIGHT_COLOR) },
    uGroundColor: { value: new THREE.Vector3(0.115, 0.12, 0.115) },
    uSat: { value: 1.1 },
    uTime: { value: 0 },
    uCloudCoverage: { value: 0.48 },
    uCloudStrength: { value: 1.0 },
    uCloudSigma: { value: 0.021 },
    uCloudScale: { value: 1.0 / 1150.0 },
    uCloudSun: { value: new THREE.Vector3(2.8, 2.3, 1.8) },
    uCloudAmbTop: { value: new THREE.Vector3(0.4, 0.45, 0.56) },
    uCloudAmbBot: { value: new THREE.Vector3(0.14, 0.19, 0.265) },
    uCirrus: { value: 0.42 },
    uMieGain: { value: MIE_GAIN },
    uCloudBlur: { value: 0.004 },
    uCloudCube: { value: null },
  };
}

const FRAG = `
${GLSL_NOISE}
${SKY_COMMON}
${SKY_CLOUDS}
${SKY_MAIN}
`;

/**
 * The visible sky dome material: analytic sky + sun disc at full resolution,
 * with the baked cloud cube composited in. Cheap — no noise per frame.
 */
export function makeSkyMaterial(uniforms, { cloudCube = true } = {}) {
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SKY_VERT,
    fragmentShader: FRAG,
    defines: { CLOUD_STEPS: 8 },
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    transparent: false,
  });
  if (cloudCube) mat.defines.USE_CLOUD_CUBE = '';
  return mat;
}

/**
 * The cloud-bake material: renders the cumulus raymarch + cirrus as
 * premultiplied HDR RGBA into a cube render target.
 */
export function makeCloudMaterial(uniforms, { steps = 12 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SKY_VERT,
    fragmentShader: FRAG,
    defines: { CLOUD_STEPS: Math.max(3, steps), CLOUD_PASS: '' },
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: false,
    transparent: false,
    blending: THREE.NoBlending,
  });
}

/** Copy a params block into a uniform block. */
export function applyParamsToUniforms(p, u) {
  u.uSunDir.value.set(p.sunDir[0], p.sunDir[1], p.sunDir[2]);
  u.uBetaM.value.set(p.betaM[0], p.betaM[1], p.betaM[2]);
  u.uMieG.value = p.mieG;
  u.uMieGain.value = p.mieGain;
  u.uSunIntensity.value = p.sunIntensity;
  u.uSunDiscVisible.value = p.sunDiscVisible;
  u.uZenithTint.value.set(p.zenithTint[0], p.zenithTint[1], p.zenithTint[2]);
  u.uHorizonTint.value.set(p.horizonTint[0], p.horizonTint[1], p.horizonTint[2]);
  u.uHazeColor.value.set(p.hazeColor[0], p.hazeColor[1], p.hazeColor[2]);
  u.uHazeStrength.value = p.hazeStrength;
  u.uMsColor.value.set(p.msColor[0], p.msColor[1], p.msColor[2]);
  u.uTwilightWarm.value.set(p.twilightWarm[0], p.twilightWarm[1], p.twilightWarm[2]);
  u.uTwilightCool.value.set(p.twilightCool[0], p.twilightCool[1], p.twilightCool[2]);
  u.uTwilight.value = p.twilight;
  u.uNight.value = p.night;
  u.uGroundColor.value.set(p.ground[0], p.ground[1], p.ground[2]);
  u.uSat.value = p.saturation;
  u.uCloudCoverage.value = p.cloudCoverage;
  u.uCloudStrength.value = p.cloudStrength;
  u.uCloudSun.value.set(p.cloudSun[0], p.cloudSun[1], p.cloudSun[2]);
  u.uCloudAmbTop.value.set(p.cloudAmbTop[0], p.cloudAmbTop[1], p.cloudAmbTop[2]);
  u.uCloudAmbBot.value.set(p.cloudAmbBot[0], p.cloudAmbBot[1], p.cloudAmbBot[2]);
  u.uCirrus.value = p.cirrus;
}
