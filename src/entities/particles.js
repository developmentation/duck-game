/**
 * Particles — every bit of tactile feedback in the river.
 *
 *   bubbles   spherical, refractive, thin-film rim, wobble + accelerate, pop
 *             at the surface with a ring ripple
 *   droplets  splash crowns, run-off, spray streaks, feather down
 *   sheets    splash curtains, foam / marker rings, spray puffs, dawn mist
 *   motes     dust + pollen in the sun, marker confirmation motes
 *
 * Four draw calls in the main pass (bubbles / droplets / motes as Points,
 * sheets as one instanced quad mesh). Everything sits on layer 11
 * (NO_REFLECT_LAYER, the convention vegetation established) so the planar
 * reflection skips it, and every material is `transparent + depthWrite:false`
 * so postfx's g-buffer pass drops it too — the shadow pass never sees it
 * because nothing here casts. Net: 4 calls in the main pass, 4 in the water
 * refraction pass, 0 elsewhere.
 *
 * Public API (also reachable as `ctx.particles` / `ctx.get('particles')`):
 *
 *   particles.emit(kind, positionOrOptions, options)
 *     'bubbles' | 'bubble'   { count, spread, size, speed, rise }
 *     'splash'               { strength, dir }
 *     'droplets'             { count, strength, spread }
 *     'spray'                { count, strength, dir }
 *     'mist'                 { radius, amount }
 *     'dust'                 { count }
 *     'down' | 'feather'     { count, spread }
 *     'marker'               { color, strength }
 *     'ring' | 'foam'        { radius, strength }
 *   particles.counts       // { bubbles, droplets, motes, sheets }
 *   particles.wind(pos, out)
 */

import * as THREE from 'three';
import { makeRandom, noise } from '../core/noise.js';

/** Main-camera-only layer; the water's reflection camera has it disabled. */
const NO_REFLECT_LAYER = 11;

/* ── particle kinds inside each pool ──────────────────────────────────────── */
const D_DROP = 0;   // fat water droplet, ballistic
const D_SPRAY = 1;  // fine airborne spray, drags hard
const D_DOWN = 2;   // feather down, flutters
const M_DUST = 0;   // dust / pollen mote
const M_MARK = 1;   // navigation-marker mote
const S_CLOUD = 0;  // soft volumetric puff (mist, spray haze)
const S_RING = 1;   // flat ring on the water
const S_SHEET = 2;  // splash curtain

/* ── shared GLSL ──────────────────────────────────────────────────────────── */

const GLSL_COMMON = /* glsl */ `
uniform float uTime;
uniform vec3  uSunView;      // sun direction in VIEW space
uniform vec3  uSunColor;
uniform vec3  uAmbient;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform float uUnderwater;
uniform sampler2D tDepth;
uniform float uHasDepth;
uniform vec2  uInvRes;
uniform float uNear;
uniform float uFar;

float h21(vec2 p){ p = fract(p * vec2(127.1, 311.7)); p += dot(p, p + 34.53); return fract(p.x * p.y * 95.4307); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x),
             mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm3(vec2 p){
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 3; i++){ s += a * vnoise(p); p *= 2.07; a *= 0.5; }
  return s;
}

// Linear view depth of the opaque scene behind this fragment (last frame's
// g-buffer; one frame of latency is invisible at these sizes).
float sceneViewZ(){
  if (uHasDepth < 0.5) return uFar;
  float z = texture2D(tDepth, gl_FragCoord.xy * uInvRes).x;
  if (z >= 1.0) return uFar;
  float ndc = z * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
}

// Soft-particle fade so nothing shows a hard intersection edge.
float softFade(float viewZ, float range){
  if (uHasDepth < 0.5) return 1.0;
  return clamp((sceneViewZ() - viewZ) / max(range, 0.001), 0.0, 1.0);
}

float fogAmount(float viewZ){
  float d = viewZ * uFogDensity;
  return 1.0 - exp(-d * d);
}
`;

/* ── one struct-of-arrays pool, reused by all three point systems ─────────── */

class Pool {
  constructor(max) {
    this.max = max | 0;
    this.count = 0;
    const f = () => new Float32Array(this.max);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.age = f(); this.life = f(); this.size = f();
    this.seed = f(); this.kind = f();
    this.a0 = f(); this.a1 = f(); this.a2 = f();
    this.c0 = f(); this.c1 = f(); this.c2 = f();   // colour, per particle
    this._ch = [
      this.px, this.py, this.pz, this.vx, this.vy, this.vz,
      this.age, this.life, this.size, this.seed, this.kind,
      this.a0, this.a1, this.a2, this.c0, this.c1, this.c2,
    ];
  }

  spawn() {
    if (this.count >= this.max) return -1;
    return this.count++;
  }

  kill(i) {
    const last = --this.count;
    if (i !== last) {
      const ch = this._ch;
      for (let c = 0; c < ch.length; c++) ch[c][i] = ch[c][last];
    }
  }

  clear() { this.count = 0; }
}

const _clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Particles {
  constructor(ctx) {
    this.ctx = ctx;
    this.rng = makeRandom(0x9d2b1f);
    this.enabled = true;

    // scratch — nothing in update() allocates
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._wind = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._camFwd = new THREE.Vector3();
    this._sunView = new THREE.Vector3(0, 0.62, -0.78).normalize();
    this._rc = { s: 0, u: 0, distance: 0 };
    this._runoff = 0;
    this._col = new THREE.Color();

    this._elapsed = 0;
    this._ripBudget = 0;
    this._seepAcc = 0;
    this._sprayAcc = 0;
    this._dustAcc = 0;
    this._runoffAcc = 0;
    this._sprayRock = 0;
    this._sprayHooked = false;
    this._mistAmount = 0;
    this._mistInit = false;
    this._sortEvery = 0;
  }

  async init() {
    const ctx = this.ctx;
    const q = ctx.settings?.quality ?? {};
    const budget = q.bubbleCount ?? 900;

    this.bubbleMax = Math.max(120, Math.round(budget));
    this.dropMax = Math.max(120, Math.round(budget * 0.62));
    this.moteMax = Math.max(80, Math.round(budget * 0.34));
    this.mistCount = budget >= 1400 ? 40 : budget >= 800 ? 26 : 14;
    this.sheetMax = this.mistCount + (budget >= 800 ? 110 : 60);
    this.dustTarget = budget >= 1400 ? 260 : budget >= 800 ? 160 : 80;

    this.bubbles = new Pool(this.bubbleMax);
    this.drops = new Pool(this.dropMax);
    this.motes = new Pool(this.moteMax);
    this.sheets = new Pool(this.sheetMax);

    this.group = new THREE.Group();
    this.group.name = 'particles';
    this.group.frustumCulled = false;
    this.group.matrixAutoUpdate = false;

    this._blankDepth = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this._blankDepth.needsUpdate = true;

    this._materials = [];
    this._buildBubbles();
    this._buildDroplets();
    this._buildMotes();
    this._buildSheets();

    ctx.scene.add(this.group);
    // Vegetation enables this layer on the main camera; do it ourselves too so
    // we still render if vegetation failed to boot.
    ctx.engine?.camera?.layers?.enable(NO_REFLECT_LAYER);

    this._seedMist();
    this._seedDust();
    this._collectSprayRocks();
    this._bindEvents();
  }

  /* ───────────────────────────────────────────────────────────── materials ── */

  _commonUniforms() {
    return {
      uTime: { value: 0 },
      uSunView: { value: new THREE.Vector3(0, 0.6, -0.8) },
      uSunColor: { value: new THREE.Color(1, 0.86, 0.68) },
      uAmbient: { value: new THREE.Color(0.28, 0.42, 0.6) },
      uFogColor: { value: new THREE.Color(0.62, 0.72, 0.8) },
      uFogDensity: { value: 0.0024 },
      uUnderwater: { value: 0 },
      uPointScale: { value: 500 },
      tDepth: { value: this._blankDepth },
      uHasDepth: { value: 0 },
      uInvRes: { value: new THREE.Vector2(1 / 1600, 1 / 900) },
      uNear: { value: 0.08 },
      uFar: { value: 900 },
    };
  }

  _pointsMesh(count, extra, material, renderOrder) {
    const geo = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pos);
    const attrs = { position: geo.attributes.position };
    for (const [name, itemSize] of extra) {
      const a = new THREE.BufferAttribute(new Float32Array(count * itemSize), itemSize);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      attrs[name] = a;
    }
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mesh = new THREE.Points(geo, material);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = renderOrder;
    mesh.layers.set(NO_REFLECT_LAYER);
    this.group.add(mesh);
    this._materials.push(material);
    return { geo, mesh, attrs };
  }

  _buildBubbles() {
    const mat = new THREE.ShaderMaterial({
      uniforms: this._commonUniforms(),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aSeed;
        attribute float aFade;
        uniform float uPointScale;
        varying float vSeed;
        varying float vFade;
        varying float vZ;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float dist = max(0.01, -mv.z);
          float px = aSize * uPointScale / dist;
          float clamped = max(px, 2.0);
          // sub-pixel bubbles fade out instead of shimmering as hard dots
          vFade = aFade * clamp(px / clamped, 0.18, 1.0) * clamp(px / clamped, 0.18, 1.0);
          gl_PointSize = min(clamped, 190.0);
          vSeed = aSeed;
          vZ = dist;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${GLSL_COMMON}
        varying float vSeed;
        varying float vFade;
        varying float vZ;
        void main(){
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(c, c);
          if (r2 > 1.0) discard;
          float r = sqrt(r2);
          float z = sqrt(max(0.0, 1.0 - r2));
          vec3 n = normalize(vec3(c.x, -c.y, z));
          vec3 V = vec3(0.0, 0.0, 1.0);

          float ndv = max(dot(n, V), 0.02);
          float fres = pow(1.0 - ndv, 2.6);

          // thin-film interference: optical path grows with obliquity, film
          // thickness varies per bubble and thins as it rises (aSeed carries it)
          float phase = (1.25 + vSeed * 2.4) / ndv + vSeed * 5.1;
          vec3 film = 0.5 + 0.5 * cos(6.28318 * phase + vec3(0.0, 2.09, 4.19));
          film = mix(vec3(dot(film, vec3(0.33))), film, 0.85);

          vec3 H = normalize(uSunView + V);
          float spec = pow(max(dot(n, H), 0.0), 48.0);
          float sheen = pow(max(dot(n, H), 0.0), 6.0) * 0.10;

          // the refracted counter-highlight that really sells a bubble
          vec2 sp = uSunView.xy;
          float spl = max(length(sp), 0.001);
          vec2 sdir = sp / spl;
          float caustic = 1.0 - smoothstep(0.0, 0.30, length(c + sdir * 0.46));

          float rim = smoothstep(0.42, 0.99, r);
          float shell = rim * 0.62 + fres * 0.30;

          vec3 tint = mix(uAmbient * 1.15, uFogColor, 0.35);
          vec3 col = mix(tint, film * (uSunColor * 0.85 + 0.35), 0.45 + 0.4 * rim);
          col += uSunColor * (spec * 2.6 + caustic * 0.85 + sheen);
          col = mix(col, col * vec3(0.82, 0.96, 1.0), uUnderwater * 0.5);

          float a = (shell + spec * 0.95 + caustic * 0.45) * vFade;
          a *= 1.0 - smoothstep(0.96, 1.0, r) * 0.5;
          a *= softFade(vZ, 0.35);
          float fog = fogAmount(vZ);
          col = mix(col, uFogColor, fog * 0.7);
          a *= 1.0 - fog * 0.75;
          if (a <= 0.004) discard;
          gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
        }`,
    });
    const r = this._pointsMesh(this.bubbleMax, [['aSize', 1], ['aSeed', 1], ['aFade', 1]], mat, 12);
    this.bubbleGeo = r.geo; this.bubbleAttrs = r.attrs; this.bubbleMat = mat;
  }

  _buildDroplets() {
    const mat = new THREE.ShaderMaterial({
      uniforms: this._commonUniforms(),
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aSeed;
        attribute float aFade;
        attribute float aKind;
        attribute vec2  aDir;     // screen-space direction of travel
        attribute float aStretch;
        uniform float uPointScale;
        varying float vSeed; varying float vFade; varying float vKind;
        varying vec2 vDir; varying float vStretch; varying float vZ;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float dist = max(0.01, -mv.z);
          float px = aSize * aStretch * uPointScale / dist;
          float clamped = max(px, 2.0);
          vFade = aFade * clamp(px / clamped, 0.2, 1.0);
          gl_PointSize = min(clamped, 160.0);
          vSeed = aSeed; vKind = aKind; vDir = aDir; vStretch = aStretch; vZ = dist;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${GLSL_COMMON}
        varying float vSeed; varying float vFade; varying float vKind;
        varying vec2 vDir; varying float vStretch; varying float vZ;
        void main(){
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          c.y = -c.y;
          vec2 dir = length(vDir) > 0.001 ? normalize(vDir) : vec2(0.0, 1.0);
          vec2 d = vec2(dot(c, dir), dot(c, vec2(-dir.y, dir.x)));
          vec3 col; float a;

          if (vKind < 0.5) {
            // fat droplet, stretched along travel, lit like a tiny lens
            d.x /= max(vStretch, 1.0);
            float r2 = dot(d, d);
            if (r2 > 1.0) discard;
            float z = sqrt(max(0.0, 1.0 - r2));
            vec3 n = normalize(vec3(d.x, d.y, z));
            vec3 V = vec3(0.0, 0.0, 1.0);
            vec3 H = normalize(uSunView + V);
            float spec = pow(max(dot(n, H), 0.0), 40.0);
            float fres = pow(1.0 - max(dot(n, V), 0.02), 3.0);
            vec3 body = mix(uAmbient * 1.25, uFogColor, 0.45);
            col = body + uSunColor * (spec * 2.8 + fres * 0.35);
            a = (0.30 + fres * 0.45 + spec * 1.1) * vFade;
          } else if (vKind < 1.5) {
            // fine spray: soft, bright, no hard edge
            d.x /= max(vStretch, 1.0);
            float r = length(d);
            if (r > 1.0) discard;
            float core = 1.0 - smoothstep(0.05, 1.0, r);
            col = mix(uFogColor, uSunColor, 0.45) * (0.85 + 0.5 * core);
            a = core * core * 0.55 * vFade;
          } else {
            // feather down: fluffy tuft with barbs
            float ang = atan(d.y, d.x);
            float rr = length(vec2(d.x * 1.35, d.y * 0.72));
            float barb = 0.20 * sin(ang * 9.0 + vSeed * 24.0) + 0.10 * sin(ang * 21.0 - vSeed * 11.0);
            float edge = 1.0 - rr + barb;
            if (edge < 0.0) discard;
            float body = smoothstep(0.0, 0.55, edge);
            float lit = 0.55 + 0.45 * smoothstep(-0.4, 0.6, dot(normalize(vec3(d, 0.6)), uSunView));
            col = mix(uAmbient * 1.1, uSunColor * 1.15, lit);
            a = body * 0.72 * vFade;
          }

          a *= softFade(vZ, 0.30);
          float fog = fogAmount(vZ);
          col = mix(col, uFogColor, fog * 0.75);
          a *= 1.0 - fog * 0.8;
          if (a <= 0.004) discard;
          gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
        }`,
    });
    const r = this._pointsMesh(this.dropMax, [
      ['aSize', 1], ['aSeed', 1], ['aFade', 1], ['aKind', 1], ['aDir', 2], ['aStretch', 1],
    ], mat, 13);
    this.dropGeo = r.geo; this.dropAttrs = r.attrs; this.dropMat = mat;
  }

  _buildMotes() {
    const mat = new THREE.ShaderMaterial({
      uniforms: this._commonUniforms(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aSeed;
        attribute float aFade;
        attribute float aWarm;
        uniform float uPointScale;
        varying float vFade; varying float vWarm; varying float vSeed; varying float vZ;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float dist = max(0.01, -mv.z);
          float px = aSize * uPointScale / dist;
          float clamped = max(px, 2.0);
          vFade = aFade * clamp(px / clamped, 0.15, 1.0);
          gl_PointSize = min(clamped, 120.0);
          vWarm = aWarm; vSeed = aSeed; vZ = dist;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${GLSL_COMMON}
        varying float vFade; varying float vWarm; varying float vSeed; varying float vZ;
        void main(){
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          float r = length(c);
          if (r > 1.0) discard;
          float halo = 1.0 - smoothstep(0.0, 1.0, r);
          halo *= halo;
          float core = 1.0 - smoothstep(0.0, 0.42, r);
          vec3 warm = uSunColor * 1.15;
          vec3 cool = mix(uAmbient, uFogColor, 0.5);
          vec3 col = mix(cool, warm, vWarm);
          float a = (halo * 0.55 + core * 0.75) * vFade;
          a *= softFade(vZ, 0.6);
          float fog = fogAmount(vZ);
          a *= 1.0 - fog * 0.85;
          if (a <= 0.003) discard;
          gl_FragColor = vec4(col * (0.7 + 0.6 * core), clamp(a, 0.0, 1.0));
        }`,
    });
    const r = this._pointsMesh(this.moteMax, [
      ['aSize', 1], ['aSeed', 1], ['aFade', 1], ['aWarm', 1],
    ], mat, 11);
    this.moteGeo = r.geo; this.moteAttrs = r.attrs; this.moteMat = mat;
  }

  _buildSheets() {
    const max = this.sheetMax;
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    this._sheetBase = base;   // shares its buffers — dispose it, not them, at the end

    const mk = (name, size) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(max * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a;
    };
    this.sheetAttrs = {
      iPos: mk('iPos', 3),
      iSize: mk('iSize', 2),
      iParams: mk('iParams', 4),  // kind, life01, seed, rot
      iParams2: mk('iParams2', 4), // alpha, orient, softness, spare
      iColor: mk('iColor', 3),
    };
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      uniforms: this._commonUniforms(),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute vec3 iPos;
        attribute vec2 iSize;
        attribute vec4 iParams;
        attribute vec4 iParams2;
        attribute vec3 iColor;
        uniform vec3 uSunView;
        varying vec2 vUv; varying vec4 vP; varying vec4 vP2;
        varying vec3 vCol; varying float vZ; varying vec2 vSunUv;
        void main(){
          // NOTE: derive uv from position — the shared PlaneGeometry 'uv'
          // attribute comes through this InstancedBufferGeometry constant.
          vUv = position.xy + 0.5;
          vP = iParams; vP2 = iParams2; vCol = iColor;
          float rot = iParams.w;
          float cr = cos(rot), sr = sin(rot);
          vec3 right, up;
          if (iParams2.y < 0.5) {
            right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
            up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
            vec3 r2 = right * cr + up * sr;
            up = up * cr - right * sr;
            right = r2;
          } else {
            right = vec3(cr, 0.0, sr);
            up    = vec3(-sr, 0.0, cr);
          }
          vec3 world = iPos + right * (position.x * iSize.x) + up * (position.y * iSize.y);
          vec4 mv = viewMatrix * vec4(world, 1.0);
          vZ = max(0.01, -mv.z);
          // sun direction projected into the quad's own plane, for shading
          vec3 rv = (viewMatrix * vec4(right, 0.0)).xyz;
          vec3 uv3 = (viewMatrix * vec4(up, 0.0)).xyz;
          vSunUv = vec2(dot(uSunView, rv), dot(uSunView, uv3));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${GLSL_COMMON}
        varying vec2 vUv; varying vec4 vP; varying vec4 vP2;
        varying vec3 vCol; varying float vZ; varying vec2 vSunUv;
        void main(){
          float kind = vP.x, life = vP.y, seed = vP.z;
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          vec3 col = vCol; float a = 0.0;

          if (kind < 0.5) {
            // soft volumetric puff
            vec2 q = vUv * vec2(2.6, 1.5) + vec2(seed * 31.0 + uTime * 0.012, seed * 17.0 - uTime * 0.006);
            float n = fbm3(q * 1.7);
            float n2 = fbm3(q * 4.3 + 11.0);
            float mask = 1.0 - smoothstep(0.10, 1.00, length(p * vec2(1.0, 1.25)));
            if (mask <= 0.002) discard;
            float body = mask * mask * (0.42 + 0.78 * n) - 0.22 * n2 * mask;
            body = max(body, 0.0);
            // volumetric-ish shading: brighter on the sun-facing side
            vec2 sd = length(vSunUv) > 0.001 ? normalize(vSunUv) : vec2(0.0, 1.0);
            float lit = 0.5 + 0.5 * dot(normalize(p + 1e-4), sd);
            lit = pow(lit, 1.6);
            vec3 warm = uSunColor * 1.05;
            vec3 cool = mix(uAmbient * 0.9, uFogColor, 0.55);
            col = mix(cool, warm, 0.20 + 0.62 * lit * (0.45 + 0.55 * n));
            col = mix(col, vCol, 0.35);
            a = body * vP2.x * life;
          } else if (kind < 1.5) {
            // expanding foam / marker ring
            float ring = vP2.z;
            float w = 0.055 + 0.075 * (1.0 - life);
            float band = 1.0 - smoothstep(0.0, w, abs(r - ring));
            band *= band;
            float wob = 0.72 + 0.28 * vnoise(vec2(atan(p.y, p.x) * 2.4 + seed * 20.0, seed * 8.0));
            band *= wob;
            band *= 1.0 - smoothstep(0.80, 1.02, r);
            float foam = fbm3(vec2(atan(p.y, p.x) * 3.5, r * 7.0) + seed * 13.0);
            col = mix(vCol, uSunColor * 1.15, 0.35 + 0.35 * foam);
            a = band * vP2.x * life * (0.55 + 0.65 * foam);
          } else {
            // splash curtain: a wall of water rising and thinning
            float x = p.x;
            float prof = 1.0 - x * x;                 // arc profile
            float top = prof * (0.35 + 0.65 * (1.0 - life * 0.55));
            float h = vUv.y;
            float body = (1.0 - smoothstep(top - 0.30, top + 0.03, h)) * smoothstep(0.0, 0.16, h);
            float streak = fbm3(vec2(x * 6.0 + seed * 21.0, h * 3.2 - uTime * 0.4));
            body *= 0.45 + 0.9 * streak;
            body *= 1.0 - smoothstep(0.55, 1.0, abs(x));
            float crest = (1.0 - smoothstep(0.0, 0.10, abs(h - top))) * streak;
            vec3 warm = uSunColor * 1.2;
            col = mix(vCol, warm, 0.25 + 0.55 * crest);
            a = (body * 0.75 + crest * 0.55) * vP2.x * life;
          }

          if (vP2.w > 0.5) a *= smoothstep(7.0, 22.0, vZ);
          a *= softFade(vZ, kind < 0.5 ? 2.6 : (kind < 1.5 ? 0.22 : 0.7));
          float fog = fogAmount(vZ);
          col = mix(col, uFogColor, fog * 0.65);
          a *= 1.0 - fog * 0.6;
          if (a <= 0.004) discard;
          gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
        }`,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 10;
    mesh.layers.set(NO_REFLECT_LAYER);
    this.group.add(mesh);
    this._materials.push(mat);
    this.sheetGeo = geo;
    this.sheetMesh = mesh;
    this.sheetMat = mat;
    this._sheetOrder = new Int32Array(this.sheetMax);
    this._sheetDepth = new Float32Array(this.sheetMax);
  }

  /* ─────────────────────────────────────────────────────────────── spawning ── */

  emit(kind, posOrOpts, options) {
    if (!this.enabled || !this.bubbles) return;
    let o = options || null;
    let p = posOrOpts;
    if (p && (p.position || p.pos)) { o = p; p = p.position || p.pos; }
    if (!p) return;
    const x = p.x ?? 0, y = p.y ?? 0, z = p.z ?? 0;
    o = o || {};
    switch (kind) {
      case 'bubble':
      case 'bubbles': this.bubbleBurst(x, y, z, o.count ?? 8, o.spread ?? 0.14, o.size ?? 1, o.rise ?? 1); break;
      case 'splash': this.splash(x, y, z, o.strength ?? 0.6, o.dir); break;
      case 'droplets': this.dropletBurst(x, y, z, o.count ?? 12, o.strength ?? 0.6, o.spread ?? 0.2); break;
      case 'spray': this.sprayBurst(x, y, z, o.count ?? 10, o.strength ?? 0.5, o.dir); break;
      case 'mist': this.mistPuff(x, y, z, o.radius ?? 6, o.amount ?? 0.5); break;
      case 'dust': for (let i = 0; i < (o.count ?? 8); i++) this._spawnDust(x, y, z, 3); break;
      case 'down':
      case 'feather': this.downBurst(x, y, z, o.count ?? 4, o.spread ?? 0.25); break;
      case 'marker': this.marker(x, y, z, o); break;
      case 'ring':
      case 'foam': this._sheetRing(x, y, z, o.radius ?? 2.2, o.strength ?? 0.6, o.color); break;
      default: break;
    }
  }

  bubbleBurst(x, y, z, count = 8, spread = 0.14, sizeMul = 1, rise = 1) {
    const n = Math.min(count | 0, 60);
    const rng = this.rng;
    for (let i = 0; i < n; i++) {
      const idx = this.bubbles.spawn();
      if (idx < 0) return;
      const b = this.bubbles;
      const a = rng() * Math.PI * 2;
      const rr = Math.sqrt(rng()) * spread;
      b.px[idx] = x + Math.cos(a) * rr;
      b.py[idx] = y + (rng() - 0.35) * spread * 0.7;
      b.pz[idx] = z + Math.sin(a) * rr;
      b.vx[idx] = (rng() - 0.5) * 0.30;
      b.vy[idx] = (0.24 + rng() * 0.34) * rise;
      b.vz[idx] = (rng() - 0.5) * 0.30;
      b.age[idx] = 0;
      b.life[idx] = 3.0 + rng() * 6.0;
      const t = rng();
      b.size[idx] = (0.006 + t * t * 0.040) * sizeMul;
      b.seed[idx] = rng();
      b.kind[idx] = 0;
      b.a0[idx] = rng() * 6.283;          // wobble phase
      b.a1[idx] = 1.4 + rng() * 2.6;      // wobble rate
      b.a2[idx] = 0.5 + rng() * 0.9;      // wobble amplitude
    }
  }

  dropletBurst(x, y, z, count = 12, strength = 0.6, spread = 0.2, kind = D_DROP) {
    const n = Math.min(count | 0, 90);
    const rng = this.rng;
    for (let i = 0; i < n; i++) {
      const idx = this.drops.spawn();
      if (idx < 0) return;
      const d = this.drops;
      const a = rng() * Math.PI * 2;
      const tilt = 0.42 + rng() * 0.72;   // outward lean of the crown
      const sp = (1.6 + rng() * 2.6) * (0.55 + strength);
      const rr = Math.sqrt(rng()) * spread;
      d.px[idx] = x + Math.cos(a) * rr;
      d.py[idx] = y + 0.02 + rng() * 0.05;
      d.pz[idx] = z + Math.sin(a) * rr;
      d.vx[idx] = Math.cos(a) * sp * tilt;
      d.vy[idx] = sp * (1.05 - tilt * 0.45);
      d.vz[idx] = Math.sin(a) * sp * tilt;
      d.age[idx] = 0;
      d.life[idx] = kind === D_SPRAY ? 0.8 + rng() * 1.5 : 0.6 + rng() * 1.1;
      const t = rng();
      d.size[idx] = kind === D_SPRAY
        ? 0.018 + t * 0.042
        : (0.014 + t * t * 0.048) * (0.7 + strength * 0.7);
      d.seed[idx] = rng();
      d.kind[idx] = kind;
      d.a0[idx] = 0; d.a1[idx] = 0; d.a2[idx] = rng() * 6.283;
    }
  }

  sprayBurst(x, y, z, count = 10, strength = 0.5, dir) {
    const n = Math.min(count | 0, 60);
    const rng = this.rng;
    const dx = dir?.x ?? 0, dy = dir?.y ?? 1, dz = dir?.z ?? 0;
    for (let i = 0; i < n; i++) {
      const idx = this.drops.spawn();
      if (idx < 0) return;
      const d = this.drops;
      d.px[idx] = x + (rng() - 0.5) * 0.5;
      d.py[idx] = y + rng() * 0.25;
      d.pz[idx] = z + (rng() - 0.5) * 0.5;
      const sp = (0.7 + rng() * 1.5) * (0.4 + strength);
      d.vx[idx] = dx * sp + (rng() - 0.5) * 0.9;
      d.vy[idx] = dy * sp * (0.6 + rng() * 0.8) + 0.3;
      d.vz[idx] = dz * sp + (rng() - 0.5) * 0.9;
      d.age[idx] = 0;
      d.life[idx] = 1.1 + rng() * 1.8;
      d.size[idx] = 0.028 + rng() * 0.075;
      d.seed[idx] = rng();
      d.kind[idx] = D_SPRAY;
      d.a2[idx] = rng() * 6.283;
    }
  }

  downBurst(x, y, z, count = 4, spread = 0.25) {
    const n = Math.min(count | 0, 14);
    const rng = this.rng;
    for (let i = 0; i < n; i++) {
      const idx = this.drops.spawn();
      if (idx < 0) return;
      const d = this.drops;
      d.px[idx] = x + (rng() - 0.5) * spread * 2;
      d.py[idx] = y + rng() * spread;
      d.pz[idx] = z + (rng() - 0.5) * spread * 2;
      d.vx[idx] = (rng() - 0.5) * 0.9;
      d.vy[idx] = 0.4 + rng() * 0.9;
      d.vz[idx] = (rng() - 0.5) * 0.9;
      d.age[idx] = 0;
      d.life[idx] = 5.0 + rng() * 6.0;
      d.size[idx] = 0.026 + rng() * 0.030;
      d.seed[idx] = rng();
      d.kind[idx] = D_DOWN;
      d.a2[idx] = rng() * 6.283;
    }
  }

  _spawnMote(x, y, z, kind, size, life, warm) {
    const idx = this.motes.spawn();
    if (idx < 0) return -1;
    const m = this.motes;
    m.px[idx] = x; m.py[idx] = y; m.pz[idx] = z;
    m.vx[idx] = 0; m.vy[idx] = 0; m.vz[idx] = 0;
    m.age[idx] = 0; m.life[idx] = life;
    m.size[idx] = size;
    m.seed[idx] = this.rng();
    m.kind[idx] = kind;
    m.a0[idx] = this.rng() * 6.283;
    m.a1[idx] = 0.3 + this.rng() * 0.8;
    m.a2[idx] = warm;
    return idx;
  }

  _spawnDust(cx, cy, cz, radius) {
    const rng = this.rng;
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng()) * radius;
    const y = cy + (rng() - 0.25) * radius * 0.8;
    const i = this._spawnMote(cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr,
      M_DUST, 0.012 + rng() * 0.022, 14 + rng() * 16, 0.55 + rng() * 0.45);
    if (i >= 0) this.motes.age[i] = rng() * 2.0;
    return i;
  }

  _sheetSpawn(kind, x, y, z, w, h, life, alpha, orient, color) {
    const idx = this.sheets.spawn();
    if (idx < 0) return -1;
    const s = this.sheets;
    s.px[idx] = x; s.py[idx] = y; s.pz[idx] = z;
    s.vx[idx] = 0; s.vy[idx] = 0; s.vz[idx] = 0;
    s.age[idx] = 0; s.life[idx] = life;
    s.size[idx] = w;
    s.seed[idx] = this.rng();
    s.kind[idx] = kind;
    s.a0[idx] = h;                      // height
    s.a1[idx] = alpha;                  // peak alpha
    s.a2[idx] = orient;                 // 0 billboard, 1 horizontal
    this._sheetColor(idx, color);
    return idx;
  }

  _sheetColor(idx, color) {
    const s = this.sheets;
    s.c0[idx] = color ? color.r : 0.86;
    s.c1[idx] = color ? color.g : 0.92;
    s.c2[idx] = color ? color.b : 0.97;
  }

  _sheetRing(x, y, z, radius, strength, color) {
    const i = this._sheetSpawn(S_RING, x, y + 0.035, z, radius, radius,
      0.9 + strength * 0.9, 0.42 + strength * 0.45, 1, color);
    if (i >= 0) {
      this.sheets.vx[i] = radius;                 // target radius
      this.sheets.vy[i] = radius * 0.28;          // start radius
      this.sheets.a0[i] = radius;
    }
    return i;
  }

  mistPuff(x, y, z, radius = 6, amount = 0.5, persistent = 0) {
    const rng = this.rng;
    const i = this._sheetSpawn(S_CLOUD, x, y, z,
      radius * (0.7 + rng() * 0.7), radius * (0.16 + rng() * 0.16),
      persistent ? 1e9 : 3.5 + rng() * 3.0, amount, 0, null);
    if (i >= 0) {
      const s = this.sheets;
      s.vx[i] = (rng() - 0.5) * 0.05;
      s.vy[i] = persistent ? 0.0 : 0.16 + rng() * 0.34;
      s.vz[i] = (rng() - 0.5) * 0.05;
      s.a2[i] = 0;
      s.a1[i] = amount;
      s.px[i] = x; s.py[i] = y; s.pz[i] = z;
      // a1 doubles as alpha, persistence flagged by huge life
    }
    return i;
  }

  splash(x, y, z, strength = 0.6, dir) {
    const st = _clamp(strength, 0.05, 2.0);
    const rng = this.rng;
    // crown of droplets
    this.dropletBurst(x, y, z, Math.round(14 + st * 34), st, 0.10 + st * 0.16, D_DROP);
    // fine spray hanging above it
    this.sprayBurst(x, y + 0.06, z, Math.round(6 + st * 16), st * 0.8, dir);
    // the sheet / curtain
    const w = 0.55 + st * 1.5;
    const i = this._sheetSpawn(S_SHEET, x, y + 0.02, z, w, w * (0.42 + st * 0.20),
      0.42 + st * 0.22, _clamp(0.35 + st * 0.4, 0.2, 0.85), 0, null);
    if (i >= 0) {
      this.sheets.vx[i] = w * (1.7 + st * 0.9);   // grow to
      this.sheets.a1[i] = _clamp(0.35 + st * 0.4, 0.2, 0.85);
      this.sheets.seed[i] = rng();
    }
    // foam ring on the surface + real water ripple
    this._sheetRing(x, y, z, 0.9 + st * 2.0, st * 0.8, null);
    this._ripple(x, z, _clamp(0.05 + st * 0.14, 0.02, 0.3), 1.6 + st * 2.6);
    if (st > 0.55) {
      this.mistPuff(x, y + 0.25 + st * 0.2, z, 0.9 + st * 1.4, 0.10 + st * 0.07);
    }
  }

  marker(x, y, z, o = {}) {
    const water = this.ctx.water;
    const level = this.ctx.WATER_LEVEL ?? 0;
    const wy = water?.heightAt ? water.heightAt(x, z) : level;
    const overWater = this.ctx.river?.isOverWater ? this.ctx.river.isOverWater(this._v1.set(x, wy, z)) : true;
    const gy = overWater ? wy : (this.ctx.river?.groundAt?.(this._v1.set(x, y, z)) ?? y);
    const col = this._col.set(o.color ?? 0xffd9a0);
    const strength = o.strength ?? 1;

    // two staggered rings, the second delayed by a shorter start radius
    const r1 = this._sheetRing(x, gy + 0.02, z, 1.5 * strength, 0.55, col);
    if (r1 >= 0) { this.sheets.life[r1] = 1.25; this.sheets.vy[r1] = 0.12; }
    const r2 = this._sheetRing(x, gy + 0.015, z, 2.6 * strength, 0.5, col);
    if (r2 >= 0) { this.sheets.life[r2] = 1.7; this.sheets.vy[r2] = 0.02; this.sheets.a1[r2] = 0.32; }

    // rising motes so the tap has an unmistakable confirmation
    const rng = this.rng;
    for (let i = 0; i < 20; i++) {
      const a = rng() * Math.PI * 2;
      const rr = Math.sqrt(rng()) * 0.55 * strength;
      const idx = this._spawnMote(x + Math.cos(a) * rr, gy + 0.05 + rng() * 0.15, z + Math.sin(a) * rr,
        M_MARK, 0.035 + rng() * 0.045, 1.1 + rng() * 0.9, 0.9);
      if (idx < 0) break;
      const m = this.motes;
      m.vy[idx] = 0.7 + rng() * 1.2;
      m.vx[idx] = Math.cos(a) * 0.25;
      m.vz[idx] = Math.sin(a) * 0.25;
    }
    if (overWater) this._ripple(x, z, 0.09, 2.4);
  }

  /* ──────────────────────────────────────────────────────────────── helpers ── */

  _ripple(x, z, strength, radius) {
    if (this._ripBudget <= 0) return;
    this._ripBudget--;
    this.ctx.water?.addRipple?.(x, z, strength, radius);
  }

  wind(pos, out = this._wind) {
    const veg = this.ctx.get?.('vegetation');
    if (veg?.wind) { veg.wind(pos, out); return out; }
    // fallback breeze: same shape as vegetation's, just local
    const t = this._elapsed;
    const g = 0.55 + 0.45 * Math.sin(t * 0.23 + pos.x * 0.03 + pos.z * 0.021);
    out.set(0.79 * g * 0.8, 0, 0.61 * g * 0.8);
    return out;
  }

  _bindEvents() {
    const ctx = this.ctx;
    const E = ctx.EVENTS;
    const on = (t, fn) => ctx.events?.on(t, fn);
    on(E.SPLASH, (p) => {
      const pos = p?.position; if (!pos) return;
      this.splash(pos.x, pos.y, pos.z, p.strength ?? 0.6);
    });
    on(E.BUBBLES, (p) => {
      const pos = p?.position; if (!pos) return;
      this.bubbleBurst(pos.x, pos.y, pos.z, p.count ?? 8, p.spread ?? 0.14);
    });
    on(E.DIVE, (p) => {
      const pos = p?.position; if (!pos) return;
      this.bubbleBurst(pos.x, pos.y - 0.15, pos.z, 26, 0.34, 1.1, 1.2);
      this.dropletBurst(pos.x, pos.y, pos.z, 18, 0.8, 0.22);
      this._sheetRing(pos.x, pos.y, pos.z, 2.2, 0.7, null);
    });
    on(E.SURFACE, (p) => {
      const pos = p?.position; if (!pos) return;
      this.bubbleBurst(pos.x, pos.y - 0.25, pos.z, 20, 0.3, 0.9, 1.3);
      this.dropletBurst(pos.x, pos.y + 0.1, pos.z, 16, 0.7, 0.18);
      this._runoff = 1.0;   // droplets run off the duck for a moment
    });
    on(E.FISH_CAUGHT, (p) => {
      const pos = p?.position; if (!pos) return;
      this.splash(pos.x, this.ctx.WATER_LEVEL ?? 0, pos.z, 0.55);
      this.bubbleBurst(pos.x, pos.y, pos.z, 14, 0.25);
      this.downBurst(pos.x, pos.y + 0.2, pos.z, 2, 0.2);
    });
    on(E.SFX, (p) => {
      if (!p?.position) return;
      if (p.name === 'wingbeat') this.downBurst(p.position.x, p.position.y + 0.25, p.position.z, 4, 0.3);
      else if (p.name === 'preen') this.downBurst(p.position.x, p.position.y + 0.12, p.position.z, 3, 0.18);
    });
  }

  /** duck.onSpray fires once when the duck surfaces and shakes. */
  _hookSpray() {
    const player = this.ctx.get?.('player');
    const duck = player?.duck;
    if (!duck || this._sprayHooked) return;
    this._sprayHooked = true;
    const prev = duck.onSpray;
    duck.onSpray = () => {
      try { prev?.(); } catch (e) { /* keep ours alive */ }
      const p = player.headPosition ? player.headPosition(this._v1) : player.position;
      if (!p) return;
      const rng = this.rng;
      // a ring of spray thrown sideways off the head
      for (let i = 0; i < 26; i++) {
        const idx = this.drops.spawn();
        if (idx < 0) break;
        const d = this.drops;
        const a = rng() * Math.PI * 2;
        const el = (rng() - 0.35) * 0.8;
        const sp = 1.8 + rng() * 3.2;
        d.px[idx] = p.x + Math.cos(a) * 0.06;
        d.py[idx] = p.y + 0.02 + rng() * 0.08;
        d.pz[idx] = p.z + Math.sin(a) * 0.06;
        d.vx[idx] = Math.cos(a) * sp;
        d.vy[idx] = el * sp * 0.6 + 0.9;
        d.vz[idx] = Math.sin(a) * sp;
        d.age[idx] = 0;
        d.life[idx] = 0.5 + rng() * 0.8;
        d.size[idx] = 0.010 + rng() * 0.026;
        d.seed[idx] = rng();
        d.kind[idx] = rng() < 0.35 ? D_SPRAY : D_DROP;
        d.a2[idx] = rng() * 6.283;
      }
      this.downBurst(p.x, p.y + 0.1, p.z, 3, 0.16);
      this.mistPuff(p.x, p.y + 0.1, p.z, 0.7, 0.13);
    };
  }

  _seedMist() {
    const river = this.ctx.river;
    const level = this.ctx.WATER_LEVEL ?? 0;
    const rng = this.rng;
    for (let i = 0; i < this.mistCount; i++) {
      const s = rng() * (river?.length ?? 2000);
      const u = (rng() * 2 - 1) * 1.25;
      if (river?.toWorld) river.toWorld(s, u, 0, this._v1);
      else this._v1.set((rng() - 0.5) * 200, 0, (rng() - 0.5) * 200);
      const idx = this.mistPuff(this._v1.x, level + 0.18 + rng() * 0.85, this._v1.z,
        10 + rng() * 18, 0, 1);
      if (idx >= 0) {
        this.sheets.life[idx] = 1e9;
        this.sheets.a0[idx] = 2.4 + rng() * 3.4;   // height of the band
        this.sheets.size[idx] = 12 + rng() * 20;
      }
    }
    this._mistStart = 0;
  }

  _seedDust() {
    const cam = this.ctx.engine?.camera;
    const cx = cam?.position.x ?? 0, cy = (this.ctx.WATER_LEVEL ?? 0) + 1.2, cz = cam?.position.z ?? 0;
    for (let i = 0; i < this.dustTarget; i++) this._spawnDust(cx, cy, cz, 14);
  }

  _collectSprayRocks() {
    this.sprayRocks = [];
    const rocks = this.ctx.get?.('terrain')?.rocks;
    const river = this.ctx.river;
    if (!rocks || !river) return;
    for (const r of rocks) {
      const p = r.position;
      if (!p) continue;
      const top = p.y + (r.radius ?? 0.4);
      if (top < -0.30 || top > 1.6) continue;     // must break, or nearly break, the surface
      const rc = river.toRiver(p, this._rc);
      if (Math.abs(rc.u) > 1.0) continue;
      const flow = river.flowAt(rc.s, rc.u, this._v2);
      const speed = flow.length();
      if (speed < 0.95) continue;
      this.sprayRocks.push({
        x: p.x, y: p.y, z: p.z, r: r.radius ?? 0.5,
        dx: flow.x / speed, dz: flow.z / speed, speed,
      });
      if (this.sprayRocks.length > 180) break;
    }
  }

  /* ────────────────────────────────────────────────────────────────── update ── */

  update(dt, elapsed) {
    if (!this.enabled || !this.bubbles) return;
    const d = Math.min(dt, 0.05);
    this._elapsed = elapsed;
    this._ripBudget = 4;

    const ctx = this.ctx;
    const cam = ctx.engine?.camera;
    if (cam) {
      this._camPos.copy(cam.position);
      const e = cam.matrixWorld.elements;
      this._camFwd.set(-e[8], -e[9], -e[10]);
    }
    if (!this._sprayHooked) this._hookSpray();

    this._updateUniforms(d);
    this._updateAmbient(d);
    this._updateBubbles(d);
    this._updateDrops(d);
    this._updateMotes(d);
    this._updateSheets(d);
    this._upload();
  }

  _updateUniforms(dt) {
    const ctx = this.ctx;
    const sky = ctx.sky;
    const cam = ctx.engine?.camera;
    const water = ctx.water;
    const renderer = ctx.renderer;

    if (sky?.sunDirection && cam) {
      this._sunView.copy(sky.sunDirection).transformDirection(cam.matrixWorldInverse).normalize();
    }
    const gb = ctx.get?.('postfx')?.gbuffer;
    const depthTex = gb?.depthTexture ?? null;
    const size = renderer?.getDrawingBufferSize
      ? renderer.getDrawingBufferSize(this._invResTmp || (this._invResTmp = new THREE.Vector2()))
      : null;

    for (let i = 0; i < this._materials.length; i++) {
      const u = this._materials[i].uniforms;
      u.uTime.value = this._elapsed;
      u.uSunView.value.copy(this._sunView);
      if (sky?.sunColor) u.uSunColor.value.copy(sky.sunColor);
      if (sky?.ambientColor) u.uAmbient.value.copy(sky.ambientColor);
      if (sky?.fogColor) u.uFogColor.value.copy(sky.fogColor);
      const fog = ctx.scene?.fog;
      u.uFogDensity.value = fog?.density ?? 0.0024;
      u.uUnderwater.value = water?.underwater ? 1 : 0;
      if (cam) {
        u.uNear.value = cam.near;
        u.uFar.value = cam.far;
        // pixel size of a 1m sprite at 1m: 0.5 * viewportHeight * P[1][1]
        const h = size ? size.y : (ctx.engine?.height ?? 900);
        u.uPointScale.value = 0.5 * h * cam.projectionMatrix.elements[5];
      }
      if (size) u.uInvRes.value.set(1 / Math.max(1, size.x), 1 / Math.max(1, size.y));
      u.tDepth.value = depthTex || this._blankDepth;
      u.uHasDepth.value = depthTex ? 1 : 0;
    }
  }

  /** Ambient sources: bed seeps, riffle spray, sunbeam dust, drifting mist. */
  _updateAmbient(dt) {
    const ctx = this.ctx;
    const river = ctx.river;
    const water = ctx.water;
    const level = ctx.WATER_LEVEL ?? 0;
    const rng = this.rng;
    const cam = this._camPos;

    // — mist strength by time of day: heaviest just after dawn and at dusk —
    const t = ctx.sky?.timeOfDay ?? ctx.settings?.timeOfDay ?? 0.3;
    const dawn = Math.exp(-((t - 0.26) ** 2) / 0.0065);
    const dusk = Math.exp(-((t - 0.78) ** 2) / 0.0075);
    const night = t < 0.21 || t > 0.85 ? 0.6 : 0;
    const target = _clamp(0.16 + dawn * 0.95 + dusk * 0.8 + night * 0.4, 0, 1.1);
    if (this._mistInit) this._mistAmount += (target - this._mistAmount) * Math.min(1, dt * 2.2);
    else { this._mistAmount = target; this._mistInit = true; }

    // — bed seeps: slow strings of bubbles from the river bed —
    this._seepAcc -= dt;
    if (this._seepAcc <= 0 && river) {
      this._seepAcc = 0.5 + rng() * 1.1;
      const rc = river.toRiver(cam, this._rc);
      const s = rc.s + (rng() - 0.35) * 26;
      const u = (rng() * 2 - 1) * 0.8;
      const depth = river.depth(s, u);
      if (depth > 0.7) {
        river.toWorld(s, u, 0, this._v2);
        const bed = river.bedHeight(s, u);
        this.bubbleBurst(this._v2.x, bed + 0.06, this._v2.z, 2 + Math.floor(rng() * 3), 0.10, 0.75, 0.8);
      }
    }

    // — riffle spray around rocks that break the surface —
    this._sprayAcc -= dt;
    const rocks = this.sprayRocks;
    if (this._sprayAcc <= 0 && rocks && rocks.length) {
      this._sprayAcc = 0.10;
      for (let k = 0; k < 3; k++) {
        this._sprayRock = (this._sprayRock + 1) % rocks.length;
        const r = rocks[this._sprayRock];
        const dx = r.x - cam.x, dz = r.z - cam.z;
        const dist2 = dx * dx + dz * dz;
        if (dist2 > 3600) continue;
        const surf = water?.heightAt ? water.heightAt(r.x, r.z) : level;
        const bx = r.x - r.dx * (r.r * 0.9);
        const bz = r.z - r.dz * (r.r * 0.9);
        const inten = _clamp((r.speed - 0.8) * 0.55, 0.15, 1.0);
        this._v3.set(-r.dx, 0.8, -r.dz);
        this.sprayBurst(bx, surf + 0.05, bz, 2 + Math.round(inten * 3), inten * 0.7, this._v3);
        if (rng() < 0.25) this.mistPuff(bx, surf + 0.18 + rng() * 0.2, bz, 0.7 + inten, 0.10 + inten * 0.10);
        if (rng() < 0.2) this._ripple(bx, bz, 0.03 + inten * 0.03, 1.0 + r.r);
      }
    }

    // — sunbeam dust: keep the cloud around the camera —
    const dustBox = 16;
    const m = this.motes;
    for (let i = 0; i < m.count; i++) {
      if (m.kind[i] !== M_DUST) continue;
      const dx = m.px[i] - cam.x, dz = m.pz[i] - cam.z, dy = m.py[i] - cam.y;
      if (dx * dx + dz * dz > dustBox * dustBox * 1.6 || dy > 9 || dy < -3.5) {
        // recycle ahead of the camera so motes drift into frame
        const a = rng() * Math.PI * 2;
        const rr = 3 + Math.sqrt(rng()) * (dustBox - 3);
        m.px[i] = cam.x + this._camFwd.x * 4 + Math.cos(a) * rr;
        m.pz[i] = cam.z + this._camFwd.z * 4 + Math.sin(a) * rr;
        m.py[i] = level + 0.2 + rng() * 4.2;
        m.age[i] = 0;
        m.life[i] = 14 + rng() * 16;
      }
    }
    // top up if a burst ate the pool
    let dust = 0;
    for (let i = 0; i < m.count; i++) if (m.kind[i] === M_DUST) dust++;
    this._dustAcc -= dt;
    if (dust < this.dustTarget && this._dustAcc <= 0) {
      this._dustAcc = 0.08;
      for (let i = 0; i < 8 && dust + i < this.dustTarget; i++) {
        this._spawnDust(cam.x + this._camFwd.x * 5, level + 1.6, cam.z + this._camFwd.z * 5, 13);
      }
    }

    // — run-off droplets after surfacing —
    if (this._runoff > 0) {
      this._runoff -= dt;
      this._runoffAcc -= dt;
      const player = ctx.get?.('player');
      if (player && this._runoffAcc <= 0) {
        this._runoffAcc = 0.045;
        const p = player.headPosition ? player.headPosition(this._v1) : player.position;
        for (let i = 0; i < 2; i++) {
          const idx = this.drops.spawn();
          if (idx < 0) break;
          const dd = this.drops;
          const a = rng() * Math.PI * 2;
          dd.px[idx] = p.x + Math.cos(a) * 0.13;
          dd.py[idx] = p.y - rng() * 0.12;
          dd.pz[idx] = p.z + Math.sin(a) * 0.13;
          dd.vx[idx] = Math.cos(a) * 0.25;
          dd.vy[idx] = -0.2 - rng() * 0.4;
          dd.vz[idx] = Math.sin(a) * 0.25;
          dd.age[idx] = 0; dd.life[idx] = 0.7 + rng() * 0.5;
          dd.size[idx] = 0.012 + rng() * 0.020;
          dd.seed[idx] = rng(); dd.kind[idx] = D_DROP; dd.a2[idx] = rng() * 6.283;
        }
      }
    }
  }

  _updateBubbles(dt) {
    const b = this.bubbles;
    const water = this.ctx.water;
    const level = this.ctx.WATER_LEVEL ?? 0;
    const t = this._elapsed;
    const attrs = this.bubbleAttrs;
    const pos = attrs.position.array;
    const aSize = attrs.aSize.array, aSeed = attrs.aSeed.array, aFade = attrs.aFade.array;
    let n = 0;

    for (let i = 0; i < b.count; i++) {
      b.age[i] += dt;
      const life = b.life[i];
      if (b.age[i] >= life) { b.kill(i); i--; continue; }

      const r = b.size[i];
      // terminal rise speed grows with radius; small bubbles crawl
      const term = 0.25 + r * 22.0;
      b.vy[i] += (term - b.vy[i]) * Math.min(1, dt * 2.4);
      // helical wobble — the thing that stops them looking like rising dots
      const ph = b.a0[i] + t * b.a1[i];
      const wob = b.a2[i] * (0.14 + r * 3.0);
      b.vx[i] += (Math.cos(ph) * wob - b.vx[i]) * Math.min(1, dt * 3.0);
      b.vz[i] += (Math.sin(ph * 1.13) * wob - b.vz[i]) * Math.min(1, dt * 3.0);

      b.px[i] += b.vx[i] * dt;
      b.py[i] += b.vy[i] * dt;
      b.pz[i] += b.vz[i] * dt;

      // surface: pop
      let surf = level + 4;
      if (b.py[i] > level - 0.9) surf = water?.heightAt ? water.heightAt(b.px[i], b.pz[i]) : level;
      if (b.py[i] >= surf - r) {
        this._popBubble(b.px[i], surf, b.pz[i], r);
        b.kill(i); i--; continue;
      }

      const fade = Math.min(1, b.age[i] * 6) * Math.min(1, (life - b.age[i]) * 1.5);
      pos[n * 3] = b.px[i]; pos[n * 3 + 1] = b.py[i]; pos[n * 3 + 2] = b.pz[i];
      aSize[n] = r * 2.0;
      aSeed[n] = b.seed[i];
      aFade[n] = fade;
      n++;
    }
    this._bubbleDraw = n;
  }

  _popBubble(x, y, z, r) {
    if (r > 0.014) this._ripple(x, z, 0.012 + r * 0.35, 0.30 + r * 9);
    if (r > 0.02) {
      const rng = this.rng;
      const count = 1 + Math.floor(r * 40);
      for (let i = 0; i < count; i++) {
        const idx = this.drops.spawn();
        if (idx < 0) break;
        const d = this.drops;
        const a = rng() * Math.PI * 2;
        d.px[idx] = x; d.py[idx] = y + r; d.pz[idx] = z;
        d.vx[idx] = Math.cos(a) * (0.25 + rng() * 0.5);
        d.vy[idx] = 0.4 + rng() * 0.8;
        d.vz[idx] = Math.sin(a) * (0.25 + rng() * 0.5);
        d.age[idx] = 0; d.life[idx] = 0.25 + rng() * 0.3;
        d.size[idx] = r * (0.25 + rng() * 0.3);
        d.seed[idx] = rng(); d.kind[idx] = D_DROP; d.a2[idx] = 0;
      }
    }
  }

  _updateDrops(dt) {
    const d = this.drops;
    const water = this.ctx.water;
    const level = this.ctx.WATER_LEVEL ?? 0;
    const cam = this.ctx.engine?.camera;
    const attrs = this.dropAttrs;
    const pos = attrs.position.array;
    const aSize = attrs.aSize.array, aSeed = attrs.aSeed.array, aFade = attrs.aFade.array;
    const aKind = attrs.aKind.array, aDir = attrs.aDir.array, aStretch = attrs.aStretch.array;
    const t = this._elapsed;
    let n = 0;

    for (let i = 0; i < d.count; i++) {
      d.age[i] += dt;
      const life = d.life[i];
      if (d.age[i] >= life) { d.kill(i); i--; continue; }
      const kind = d.kind[i];

      this._v1.set(d.px[i], d.py[i], d.pz[i]);
      const w = this.wind(this._v1);

      if (kind === D_DROP) {
        d.vy[i] -= 12.0 * dt;
        const drag = 1 - Math.min(0.6, 1.1 * dt);
        d.vx[i] *= drag; d.vz[i] *= drag;
        d.vx[i] += w.x * 0.12 * dt; d.vz[i] += w.z * 0.12 * dt;
      } else if (kind === D_SPRAY) {
        d.vy[i] -= 3.4 * dt;
        const drag = 1 - Math.min(0.8, 2.6 * dt);
        d.vx[i] *= drag; d.vy[i] *= drag; d.vz[i] *= drag;
        d.vx[i] += w.x * 0.85 * dt; d.vz[i] += w.z * 0.85 * dt;
      } else { // down
        d.vy[i] -= 0.55 * dt;
        d.vy[i] = Math.max(d.vy[i], -0.22);
        const ph = d.a2[i] + t * 1.5;
        d.vx[i] += (Math.cos(ph) * 0.45 + w.x * 0.55 - d.vx[i]) * Math.min(1, dt * 1.2);
        d.vz[i] += (Math.sin(ph * 0.87) * 0.45 + w.z * 0.55 - d.vz[i]) * Math.min(1, dt * 1.2);
      }

      d.px[i] += d.vx[i] * dt;
      d.py[i] += d.vy[i] * dt;
      d.pz[i] += d.vz[i] * dt;

      // hitting the water
      if (d.vy[i] < 0 && d.py[i] < level + 0.6) {
        const surf = water?.heightAt ? water.heightAt(d.px[i], d.pz[i]) : level;
        if (d.py[i] <= surf) {
          if (kind === D_DROP && d.size[i] > 0.022 && this.rng() < 0.25) {
            this._ripple(d.px[i], d.pz[i], 0.016, 0.5);
          }
          if (kind === D_DOWN) {
            // down lands and floats
            d.py[i] = surf + 0.01;
            d.vy[i] = 0; d.vx[i] *= 0.2; d.vz[i] *= 0.2;
            d.life[i] = Math.min(d.life[i], d.age[i] + 2.5);
          } else { d.kill(i); i--; continue; }
        }
      }

      const fadeIn = Math.min(1, d.age[i] * 14);
      const fadeOut = Math.min(1, (life - d.age[i]) * (kind === D_DOWN ? 1.2 : 3.5));
      const fade = fadeIn * fadeOut;

      // screen-space travel direction for streaking
      let sx = 0, sy = 1, stretch = 1;
      if (cam && kind !== D_DOWN) {
        const e = cam.matrixWorldInverse.elements;
        const vxv = e[0] * d.vx[i] + e[4] * d.vy[i] + e[8] * d.vz[i];
        const vyv = e[1] * d.vx[i] + e[5] * d.vy[i] + e[9] * d.vz[i];
        const len = Math.hypot(vxv, vyv);
        if (len > 1e-4) { sx = vxv / len; sy = vyv / len; }
        stretch = 1 + Math.min(2.2, len * 0.16);
      } else if (kind === D_DOWN) {
        const a = d.a2[i] + t * 0.8;
        sx = Math.cos(a); sy = Math.sin(a); stretch = 1;
      }

      pos[n * 3] = d.px[i]; pos[n * 3 + 1] = d.py[i]; pos[n * 3 + 2] = d.pz[i];
      aSize[n] = d.size[i] * 2.0;
      aSeed[n] = d.seed[i];
      aFade[n] = fade;
      aKind[n] = kind;
      aDir[n * 2] = sx; aDir[n * 2 + 1] = sy;
      aStretch[n] = stretch;
      n++;
    }
    this._dropDraw = n;
  }

  _updateMotes(dt) {
    const m = this.motes;
    const attrs = this.moteAttrs;
    const pos = attrs.position.array;
    const aSize = attrs.aSize.array, aSeed = attrs.aSeed.array;
    const aFade = attrs.aFade.array, aWarm = attrs.aWarm.array;
    const sun = this.ctx.sky?.sunDirection;
    const t = this._elapsed;
    let n = 0;

    for (let i = 0; i < m.count; i++) {
      m.age[i] += dt;
      const life = m.life[i];
      if (m.age[i] >= life) { m.kill(i); i--; continue; }
      const kind = m.kind[i];
      this._v1.set(m.px[i], m.py[i], m.pz[i]);
      const w = this.wind(this._v1);

      if (kind === M_DUST) {
        const ph = m.a0[i] + t * m.a1[i] * 0.55;
        m.px[i] += (w.x * 0.16 + Math.cos(ph) * 0.05) * dt;
        m.pz[i] += (w.z * 0.16 + Math.sin(ph * 1.21) * 0.05) * dt;
        m.py[i] += (Math.sin(ph * 0.7) * 0.05 + 0.012) * dt;
      } else {
        m.vy[i] -= 0.7 * dt;
        m.px[i] += (m.vx[i] + w.x * 0.1) * dt;
        m.py[i] += m.vy[i] * dt;
        m.pz[i] += (m.vz[i] + w.z * 0.1) * dt;
        m.vx[i] *= 1 - Math.min(0.7, dt * 1.5);
        m.vz[i] *= 1 - Math.min(0.7, dt * 1.5);
      }

      let fade = Math.min(1, m.age[i] * 2.2) * Math.min(1, (life - m.age[i]) * 1.4);
      let warm = m.a2[i];

      if (kind === M_DUST) {
        // forward scattering: motes flare when you look toward the sun, and
        // clump into shafts via a slow noise so they read as light in air
        let scat = 0.5;
        if (sun) {
          const dx = m.px[i] - this._camPos.x, dy = m.py[i] - this._camPos.y, dz = m.pz[i] - this._camPos.z;
          const len = Math.hypot(dx, dy, dz) || 1;
          const dot = (dx * sun.x + dy * sun.y + dz * sun.z) / len;
          scat = 0.25 + 0.75 * Math.pow(Math.max(0, dot * 0.5 + 0.5), 3.0);
        }
        const shaft = 0.35 + 0.65 * Math.max(0, noise.noise3(m.px[i] * 0.12, m.py[i] * 0.08, m.pz[i] * 0.12 + t * 0.02));
        fade *= scat * shaft * this._dustGain();
        warm = 0.55 + 0.45 * scat;
      }

      if (fade <= 0.002) continue;
      pos[n * 3] = m.px[i]; pos[n * 3 + 1] = m.py[i]; pos[n * 3 + 2] = m.pz[i];
      aSize[n] = m.size[i] * 2.0;
      aSeed[n] = m.seed[i];
      aFade[n] = fade;
      aWarm[n] = warm;
      n++;
    }
    this._moteDraw = n;
  }

  _dustGain() {
    // no dust worth seeing in the dark; peaks with a low warm sun
    const t = this.ctx.settings?.timeOfDay ?? 0.3;
    const day = _clamp((t - 0.18) * 6, 0, 1) * _clamp((0.88 - t) * 6, 0, 1);
    const low = 0.55 + 0.45 * Math.exp(-((t - 0.27) ** 2) / 0.006) + 0.45 * Math.exp(-((t - 0.76) ** 2) / 0.006);
    return day * Math.min(1.4, low) * 1.9;
  }

  _updateSheets(dt) {
    const s = this.sheets;
    const water = this.ctx.water;
    const level = this.ctx.WATER_LEVEL ?? 0;
    const river = this.ctx.river;
    const cam = this._camPos;
    const rng = this.rng;
    const order = this._sheetOrder;
    const depth = this._sheetDepth;
    let n = 0;

    for (let i = 0; i < s.count; i++) {
      const kind = s.kind[i];
      const persistent = s.life[i] > 1e8;
      s.age[i] += dt;
      if (!persistent && s.age[i] >= s.life[i]) { s.kill(i); i--; continue; }

      if (kind === S_CLOUD) {
        this._v1.set(s.px[i], s.py[i], s.pz[i]);
        const w = this.wind(this._v1);
        s.px[i] += (w.x * 0.10 + s.vx[i]) * dt;
        s.pz[i] += (w.z * 0.10 + s.vz[i]) * dt;
        if (persistent) {
          // mist banks: recycle around the camera along the river
          const dx = s.px[i] - cam.x, dz = s.pz[i] - cam.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > 95 * 95 || d2 < 11 * 11) {
            if (river) {
              const rc = river.toRiver(cam, this._rc);
              const ns = rc.s + (rng() < 0.75 ? 20 + rng() * 70 : -(20 + rng() * 50));
              const nu = (rng() * 2 - 1) * 1.3;
              river.toWorld(ns, nu, 0, this._v3);
              s.px[i] = this._v3.x; s.pz[i] = this._v3.z;
            } else {
              const ang = rng() * Math.PI * 2, rad = 22 + rng() * 60;
              s.px[i] = cam.x + Math.cos(ang) * rad;
              s.pz[i] = cam.z + Math.sin(ang) * rad;
            }
            s.py[i] = level + 0.12 + rng() * 0.65;
            s.seed[i] = rng();
          }
        } else {
          s.py[i] += s.vy[i] * dt;
          s.size[i] += dt * 0.5;
        }
      } else if (kind === S_RING) {
        // keep the ring riding the surface
        if (water?.heightAt) s.py[i] = water.heightAt(s.px[i], s.pz[i]) + 0.035;
      } else if (kind === S_SHEET) {
        s.size[i] += (s.vx[i] - s.size[i]) * Math.min(1, dt * 4.0);
        s.a0[i] *= 1 - Math.min(0.9, dt * 0.7);
        if (water?.heightAt) s.py[i] = water.heightAt(s.px[i], s.pz[i]) + 0.02;
      }

      const idx = n++;
      order[idx] = i;
      const dx = s.px[i] - cam.x, dy = s.py[i] - cam.y, dz = s.pz[i] - cam.z;
      depth[idx] = dx * dx + dy * dy + dz * dz;
    }

    // back-to-front so the soft quads blend in a plausible order
    this._sortIndices(order, depth, n);

    const A = this.sheetAttrs;
    const iPos = A.iPos.array, iSize = A.iSize.array;
    const iParams = A.iParams.array, iParams2 = A.iParams2.array, iColor = A.iColor.array;
    const mist = this._mistAmount;

    for (let k = 0; k < n; k++) {
      const i = order[k];
      const kind = s.kind[i];
      const persistent = s.life[i] > 1e8;
      let life01, alpha, w, h, ring = 0;

      if (kind === S_CLOUD) {
        if (persistent) {
          life01 = 1;
          alpha = mist * (0.20 + 0.16 * s.seed[i]);
          w = s.size[i]; h = s.a0[i];
        } else {
          const f = s.age[i] / s.life[i];
          life01 = Math.min(1, f * 5) * (1 - f) * (1 - f);
          alpha = s.a1[i];
          w = s.size[i] * (1 + f * 1.4);
          h = s.a0[i] * (1 + f * 1.1);
        }
      } else if (kind === S_RING) {
        const f = s.age[i] / s.life[i];
        life01 = Math.min(1, f * 8) * (1 - f);
        alpha = s.a1[i];
        const rad = s.vy[i] + (s.vx[i] - s.vy[i]) * Math.pow(f, 0.55);
        w = rad * 2.2; h = rad * 2.2;
        ring = 0.45 + 0.35 * f;      // where the band sits in uv space
      } else {
        const f = s.age[i] / s.life[i];
        life01 = Math.min(1, f * 7) * (1 - f) * (1 - f * 0.4);
        alpha = s.a1[i];
        w = s.size[i]; h = s.a0[i];
      }

      iPos[k * 3] = s.px[i]; iPos[k * 3 + 1] = s.py[i]; iPos[k * 3 + 2] = s.pz[i];
      iSize[k * 2] = w; iSize[k * 2 + 1] = h;
      iParams[k * 4] = kind;
      iParams[k * 4 + 1] = life01;
      iParams[k * 4 + 2] = s.seed[i];
      iParams[k * 4 + 3] = kind === S_RING ? s.seed[i] * 6.283 : (kind === S_CLOUD ? (s.seed[i] - 0.5) * 0.25 : 0);
      iParams2[k * 4] = alpha;
      iParams2[k * 4 + 1] = s.a2[i];
      iParams2[k * 4 + 2] = ring;
      iParams2[k * 4 + 3] = (kind === S_CLOUD && persistent) ? 1 : 0;
      iColor[k * 3] = s.c0[i]; iColor[k * 3 + 1] = s.c1[i]; iColor[k * 3 + 2] = s.c2[i];
    }
    this._sheetDraw = n;
  }

  /** insertion sort on a preallocated index array — n is small and near-sorted */
  _sortIndices(order, depth, n) {
    for (let i = 1; i < n; i++) {
      const oi = order[i], di = depth[i];
      let j = i - 1;
      while (j >= 0 && depth[j] < di) { depth[j + 1] = depth[j]; order[j + 1] = order[j]; j--; }
      depth[j + 1] = di; order[j + 1] = oi;
    }
  }

  _upload() {
    const bn = this._bubbleDraw | 0;
    this.bubbleGeo.setDrawRange(0, bn);
    if (bn > 0) {
      this.bubbleAttrs.position.needsUpdate = true;
      this.bubbleAttrs.aSize.needsUpdate = true;
      this.bubbleAttrs.aSeed.needsUpdate = true;
      this.bubbleAttrs.aFade.needsUpdate = true;
    }
    const dn = this._dropDraw | 0;
    this.dropGeo.setDrawRange(0, dn);
    if (dn > 0) {
      for (const k in this.dropAttrs) this.dropAttrs[k].needsUpdate = true;
    }
    const mn = this._moteDraw | 0;
    this.moteGeo.setDrawRange(0, mn);
    if (mn > 0) {
      for (const k in this.moteAttrs) this.moteAttrs[k].needsUpdate = true;
    }
    const sn = this._sheetDraw | 0;
    this.sheetGeo.instanceCount = sn;
    if (sn > 0) {
      for (const k in this.sheetAttrs) this.sheetAttrs[k].needsUpdate = true;
    }
  }

  get counts() {
    return {
      bubbles: this.bubbles?.count ?? 0,
      droplets: this.drops?.count ?? 0,
      motes: this.motes?.count ?? 0,
      sheets: this.sheets?.count ?? 0,
    };
  }

  dispose() {
    this.group?.parent?.remove(this.group);
    for (const m of this._materials || []) m.dispose();
    this.bubbleGeo?.dispose();
    this.dropGeo?.dispose();
    this.moteGeo?.dispose();
    this.sheetGeo?.dispose();
    this._sheetBase?.dispose();
    this._blankDepth?.dispose();
    this._materials = [];
    this.bubbles = this.drops = this.motes = this.sheets = null;
  }
}
