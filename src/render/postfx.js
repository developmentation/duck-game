/**
 * PostFX — the post chain and the final colour grade.
 *
 * The engine hands us a composer that already contains a RenderPass at index 0
 * rendering the scene into a HalfFloat, linear, *un-tone-mapped* target. Three
 * only applies `renderer.toneMapping` in a material when it is rendering
 * straight to the canvas (`currentRenderTarget === null`, see
 * WebGLPrograms.getParameters), so everything that reaches us here is honest
 * linear HDR — bloom thresholds above 1.0 mean something.
 *
 * ── Tone mapping decision ───────────────────────────────────────────────────
 * We tone map exactly once, in our own grade pass, and we do it with the *same*
 * ACES fit three uses (identical constants, identical `exposure / 0.6`) so the
 * sky's exposure tuning stays valid — then we grade on top of it in
 * display-linear space. Because the grade already tone maps, we flip
 * `renderer.toneMapping` to `NoToneMapping` while our chain is alive, which
 * leaves `OutputPass` doing nothing but the sRGB transfer. `setEnabled(false)`
 * puts ACES back on the renderer so the bypassed image is still a correct
 * (if flat) picture to compare against.
 *
 * ── Chain ───────────────────────────────────────────────────────────────────
 *   RenderPass (engine)
 *   GBufferPass      view normals + depth, one override-material scene pass,
 *                    shared by AO / DOF / god rays  (skipped on low)
 *   GTAOPass         subtle contact darkening, high only
 *   UnderwaterPass   refraction, absorption, CA, shafts (enabled only when wet)
 *   GodrayPass       screen-space radial shafts from the sun, additive
 *   DOFPass          half-res scatter-as-gather bokeh
 *   BloomPass        threshold + 5-level down/up pyramid → texture (no swap)
 *   GradePass        bloom composite, ACES, tone curve, split tone, vignette,
 *                    grain, edge CA, lens drops
 *   SMAAPass / FXAAPass
 *   OutputPass       sRGB only
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { GLSL_NOISE } from '../core/noise.js';
import { settings } from '../core/settings.js';

/* ────────────────────────────────────────────────────────────────────────── *
 * Shared GLSL
 * ────────────────────────────────────────────────────────────────────────── */

const VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const DEPTH_HELPERS = /* glsl */ `
#include <packing>
uniform sampler2D tDepth;
uniform float uNear;
uniform float uFar;
float sceneDepth(vec2 uv){
  float z = texture2D(tDepth, uv).x;
  if (z >= 1.0) return uFar;
  return -perspectiveDepthToViewZ(z, uNear, uFar);
}`;

const HASH = /* glsl */ `
float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}`;

const LUMA = /* glsl */ `
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }`;

/**
 * Only the 2D half of the shared noise. Pulling in `GLSL_NOISE` whole drags
 * `snoise3` + both fbm loops along with it; nothing here needs them, and on a
 * software GL the extra code costs *minutes* of shader compile time.
 */
const GLSL_SNOISE2 = GLSL_NOISE.slice(0, GLSL_NOISE.indexOf('float snoise3'));

/* ────────────────────────────────────────────────────────────────────────── *
 * GBufferPass — view-space normals + depth for AO / DOF / god rays.
 * One extra scene pass with an override material. Points, lines and
 * non-depth-writing transparents are hidden so bubbles and light shafts do not
 * become occluders.
 * ────────────────────────────────────────────────────────────────────────── */

class GBufferPass extends Pass {
  constructor(scene, camera, w, h) {
    super();
    this.needsSwap = false;
    this.scene = scene;
    this.camera = camera;
    this.material = new THREE.MeshNormalMaterial();
    this.depthTexture = new THREE.DepthTexture(w, h);
    this.depthTexture.format = THREE.DepthFormat;
    this.depthTexture.type = THREE.UnsignedIntType;
    this.depthTexture.minFilter = THREE.NearestFilter;
    this.depthTexture.magFilter = THREE.NearestFilter;
    this.target = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.HalfFloatType,
      depthTexture: this.depthTexture,
    });
    this._hidden = [];
    this._clear = new THREE.Color();
  }

  _hide(object) {
    const cache = this._hidden;
    object.traverse((o) => {
      if (!o.visible) return;
      if (o.isPoints || o.isLine || o.isLine2 || o.isSprite) {
        o.visible = false;
        cache.push(o);
        return;
      }
      const m = o.material;
      if (!m) return;
      const one = Array.isArray(m) ? m[0] : m;
      // Transparent things that do not write depth are not occluders.
      if (one && one.transparent === true && one.depthWrite === false) {
        o.visible = false;
        cache.push(o);
      }
    });
  }

  _restore() {
    const cache = this._hidden;
    for (let i = 0; i < cache.length; i++) cache[i].visible = true;
    cache.length = 0;
  }

  render(renderer) {
    const scene = this.scene;
    renderer.getClearColor(this._clear);
    const prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear;
    const prevOverride = scene.overrideMaterial;
    const prevBg = scene.background;
    const prevFog = scene.fog;
    // The main RenderPass already refreshed the shadow map this frame; do not
    // let this second scene traversal render it all over again.
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;

    this._hide(scene);
    scene.background = null;
    scene.fog = null;
    scene.overrideMaterial = this.material;

    renderer.setRenderTarget(this.target);
    renderer.autoClear = false;
    renderer.setClearColor(0x7777ff, 1.0);
    renderer.clear(true, true, false);
    renderer.render(scene, this.camera);

    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
    scene.fog = prevFog;
    renderer.autoClear = prevAuto;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.setClearColor(this._clear, prevAlpha);
    this._restore();
  }

  setSize(w, h) {
    const s = this.scale ?? 1;
    this.target.setSize(Math.max(2, Math.round(w * s)), Math.max(2, Math.round(h * s)));
  }

  dispose() {
    this.target.dispose();
    this.depthTexture.dispose();
    this.material.dispose();
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * BloomPass — threshold + 5-level down/up pyramid.
 *
 * Not a compositing pass: it leaves the composer buffers alone and publishes
 * `this.texture`, which the grade composites in HDR with a warm tint. Per-level
 * upsample weights let us keep a tight core *and* a very wide, soft halation —
 * the "two-scale" filmic look — for the cost of one pyramid.
 * ────────────────────────────────────────────────────────────────────────── */

const BLOOM_LEVELS = 5;

class BloomPass extends Pass {
  constructor(w, h) {
    super();
    this.needsSwap = false;
    this.strength = 1.0;

    this.bright = new THREE.ShaderMaterial({
      name: 'bloom-bright',
      uniforms: {
        tDiffuse: { value: null },
        uThreshold: { value: 1.15 },
        uKnee: { value: 0.70 },
        uClamp: { value: 32.0 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform float uThreshold, uKnee, uClamp;
        ${LUMA}
        void main(){
          vec3 c = texture2D(tDiffuse, vUv).rgb;
          c = min(c, vec3(uClamp));
          float br = max(c.r, max(c.g, c.b));
          float knee = uThreshold * uKnee + 1e-5;
          float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
          soft = soft * soft / (4.0 * knee);
          float contrib = max(soft, br - uThreshold) / max(br, 1e-5);
          gl_FragColor = vec4(c * contrib, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.down = new THREE.ShaderMaterial({
      name: 'bloom-down',
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: VERT,
      // 13-tap partial Karis-average downsample (Jimenez / CoD).
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform vec2 uTexel;
        vec3 t(vec2 o){ return texture2D(tDiffuse, vUv + o * uTexel).rgb; }
        void main(){
          vec3 a = t(vec2(-2.0, 2.0)), b = t(vec2(0.0, 2.0)), c = t(vec2(2.0, 2.0));
          vec3 d = t(vec2(-2.0, 0.0)), e = t(vec2(0.0, 0.0)), f = t(vec2(2.0, 0.0));
          vec3 g = t(vec2(-2.0,-2.0)), h = t(vec2(0.0,-2.0)), i = t(vec2(2.0,-2.0));
          vec3 j = t(vec2(-1.0, 1.0)), k = t(vec2(1.0, 1.0));
          vec3 l = t(vec2(-1.0,-1.0)), m = t(vec2(1.0,-1.0));
          vec3 r = e * 0.125;
          r += (a + c + g + i) * 0.03125;
          r += (b + d + f + h) * 0.0625;
          r += (j + k + l + m) * 0.125;
          gl_FragColor = vec4(r, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.up = new THREE.ShaderMaterial({
      name: 'bloom-up',
      uniforms: {
        tDiffuse: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uWeight: { value: 1.0 },
        uRadius: { value: 1.0 },
      },
      vertexShader: VERT,
      // 9-tap tent, additively accumulated into the larger level.
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform vec2 uTexel;
        uniform float uWeight, uRadius;
        vec3 t(vec2 o){ return texture2D(tDiffuse, vUv + o * uTexel * uRadius).rgb; }
        void main(){
          vec3 r = t(vec2(0.0, 0.0)) * 4.0;
          r += (t(vec2(-1.0, 0.0)) + t(vec2(1.0, 0.0)) + t(vec2(0.0, -1.0)) + t(vec2(0.0, 1.0))) * 2.0;
          r += t(vec2(-1.0,-1.0)) + t(vec2(1.0,-1.0)) + t(vec2(-1.0,1.0)) + t(vec2(1.0,1.0));
          gl_FragColor = vec4(r * (1.0 / 16.0) * uWeight, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      transparent: true,
    });

    this.levels = [];
    this._quad = new FullScreenQuad(this.bright);
    this.setSize(w, h);
  }

  get texture() { return this.levels.length ? this.levels[0].texture : null; }

  setSize(w, h) {
    for (const rt of this.levels) rt.dispose();
    this.levels.length = 0;
    let lw = Math.max(2, Math.floor(w * 0.5));
    let lh = Math.max(2, Math.floor(h * 0.5));
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const rt = new THREE.WebGLRenderTarget(lw, lh, {
        type: THREE.HalfFloatType,
        depthBuffer: false,
        stencilBuffer: false,
      });
      rt.texture.minFilter = THREE.LinearFilter;
      rt.texture.magFilter = THREE.LinearFilter;
      rt.texture.wrapS = THREE.ClampToEdgeWrapping;
      rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      this.levels.push(rt);
      lw = Math.max(2, Math.floor(lw * 0.5));
      lh = Math.max(2, Math.floor(lh * 0.5));
    }
  }

  _draw(renderer, material, target) {
    this._quad.material = material;
    renderer.setRenderTarget(target);
    this._quad.render(renderer);
  }

  render(renderer, writeBuffer, readBuffer) {
    const auto = renderer.autoClear;
    renderer.autoClear = true;

    this.bright.uniforms.tDiffuse.value = readBuffer.texture;
    this._draw(renderer, this.bright, this.levels[0]);

    for (let i = 1; i < this.levels.length; i++) {
      const src = this.levels[i - 1];
      this.down.uniforms.tDiffuse.value = src.texture;
      this.down.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this._draw(renderer, this.down, this.levels[i]);
    }

    // Upsample back down the pyramid, additively. Weights > 1 on the coarse
    // levels are what gives the wide, filmic halation instead of a tight glow.
    renderer.autoClear = false;
    const weights = [1.0, 1.2, 1.4, 1.55, 1.5];
    for (let i = this.levels.length - 1; i > 0; i--) {
      const src = this.levels[i];
      this.up.uniforms.tDiffuse.value = src.texture;
      this.up.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this.up.uniforms.uWeight.value = weights[i] ?? 1.0;
      this._draw(renderer, this.up, this.levels[i - 1]);
    }

    renderer.autoClear = auto;
  }

  dispose() {
    for (const rt of this.levels) rt.dispose();
    this.bright.dispose();
    this.down.dispose();
    this.up.dispose();
    this._quad.dispose();
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * DOFPass — half-res scatter-as-gather bokeh.
 *   A: downsample colour + circle of confusion from depth
 *   B: 22-tap golden-angle spiral, a sample only reaches a pixel if its own
 *      CoC is wide enough to get there (kills the classic sharp-onto-blurred
 *      bleed that haloes a silhouette)
 *   C: full-res composite, mixing on the *upsampled* CoC so the boundary is
 *      soft rather than a hard edge around the duck.
 * ────────────────────────────────────────────────────────────────────────── */

class DOFPass extends Pass {
  constructor(gbuffer, camera, w, h) {
    super();
    this.gbuffer = gbuffer;
    this.camera = camera;

    this.focusDistance = 6.0;
    this.nearStrength = 0.85;
    this.farStrength = 1.0;
    this.maxRadius = 9.0; // half-res pixels
    this.intensity = 1.0;

    this.cocMat = new THREE.ShaderMaterial({
      name: 'dof-coc',
      defines: {},
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: gbuffer.depthTexture },
        uNear: { value: camera.near },
        uFar: { value: camera.far },
        uFocus: { value: 6.0 },
        uNearRange: { value: 0.45 },
        uFarRange: { value: 2.4 },
        uNearAmt: { value: 0.55 },
        uFarAmt: { value: 0.22 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform float uFocus, uNearRange, uFarRange, uNearAmt, uFarAmt;
        ${DEPTH_HELPERS}
        ${LUMA}
        void main(){
          float d = max(sceneDepth(vUv), 1e-3);
          // Thin-lens circle of confusion, normalised: (1 - focus/d) tends to 1
          // at infinity, so uFarAmt *is* the maximum far blur. The far bank gets
          // softened, never dissolved — and the sky keeps its cloud shapes.
          float farC  = clamp(1.0 - uFocus / d, 0.0, 1.0);
          farC = farC * farC * (3.0 - 2.0 * farC) * uFarAmt;
          float nearC = clamp((uFocus / d - 1.0) / max(uNearRange, 1e-3), 0.0, 1.0) * uNearAmt;
          float coc = clamp(max(farC, nearC), 0.0, 1.0);
          vec3 c = texture2D(tDiffuse, vUv).rgb;
          // Lift the highlights a touch so out-of-focus speculars read as bokeh.
          c *= 1.0 + smoothstep(1.2, 5.0, luma(c)) * 0.45;
          gl_FragColor = vec4(min(c, vec3(24.0)), coc);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.blurMat = new THREE.ShaderMaterial({
      name: 'dof-blur',
      uniforms: {
        tDiffuse: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uMaxRadius: { value: 9.0 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform vec2 uTexel;
        uniform float uMaxRadius;
        const int TAPS = 18;
        void main(){
          vec4 c = texture2D(tDiffuse, vUv);
          float rMax = c.a * uMaxRadius;
          vec3 sum = c.rgb;
          float wsum = 1.0;
          for (int i = 0; i < TAPS; i++){
            float fi = float(i) + 0.5;
            float ang = fi * 2.39996323;
            float r = sqrt(fi / float(TAPS)) * uMaxRadius;
            vec2 off = vec2(cos(ang), sin(ang)) * r * uTexel;
            vec4 s = texture2D(tDiffuse, vUv + off);
            float reach = s.a * uMaxRadius;
            // sample contributes only if its own circle reaches this pixel
            float w = smoothstep(r - 1.2, r + 1.2, reach);
            // and never let a far-blurred pixel eat a sharp foreground one
            w *= step(r - 0.5, max(rMax, reach));
            sum += s.rgb * w;
            wsum += w;
          }
          gl_FragColor = vec4(sum / max(wsum, 1e-4), c.a);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.compMat = new THREE.ShaderMaterial({
      name: 'dof-composite',
      uniforms: {
        tDiffuse: { value: null },
        tBlur: { value: null },
        uIntensity: { value: 1.0 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tDiffuse, tBlur;
        uniform float uIntensity;
        void main(){
          vec4 sharp = texture2D(tDiffuse, vUv);
          vec4 blur = texture2D(tBlur, vUv);
          float m = smoothstep(0.02, 0.30, blur.a) * uIntensity;
          gl_FragColor = vec4(mix(sharp.rgb, blur.rgb, m), sharp.a);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this._quad = new FullScreenQuad(this.cocMat);
    this.rtA = null;
    this.rtB = null;
    this.setSize(w, h);
  }

  setSize(w, h) {
    const hw = Math.max(2, Math.floor(w * 0.5));
    const hh = Math.max(2, Math.floor(h * 0.5));
    if (this.rtA) this.rtA.dispose();
    if (this.rtB) this.rtB.dispose();
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false };
    this.rtA = new THREE.WebGLRenderTarget(hw, hh, opts);
    this.rtB = new THREE.WebGLRenderTarget(hw, hh, opts);
    for (const rt of [this.rtA, this.rtB]) {
      rt.texture.minFilter = THREE.LinearFilter;
      rt.texture.magFilter = THREE.LinearFilter;
      rt.texture.wrapS = THREE.ClampToEdgeWrapping;
      rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    }
    this.blurMat.uniforms.uTexel.value.set(1 / hw, 1 / hh);
  }

  _draw(renderer, material, target) {
    this._quad.material = material;
    renderer.setRenderTarget(target);
    this._quad.render(renderer);
  }

  render(renderer, writeBuffer, readBuffer) {
    const auto = renderer.autoClear;
    renderer.autoClear = true;

    this.cocMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.cocMat.uniforms.uNear.value = this.camera.near;
    this.cocMat.uniforms.uFar.value = this.camera.far;
    this.cocMat.uniforms.uFocus.value = this.focusDistance;
    this.cocMat.uniforms.uNearAmt.value = this.nearStrength;
    this.cocMat.uniforms.uFarAmt.value = this.farStrength;
    this._draw(renderer, this.cocMat, this.rtA);

    this.blurMat.uniforms.tDiffuse.value = this.rtA.texture;
    this.blurMat.uniforms.uMaxRadius.value = this.maxRadius;
    this._draw(renderer, this.blurMat, this.rtB);

    this.compMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.compMat.uniforms.tBlur.value = this.rtB.texture;
    this.compMat.uniforms.uIntensity.value = this.intensity;
    renderer.autoClear = false;
    this._draw(renderer, this.compMat, this.renderToScreen ? null : writeBuffer);

    renderer.autoClear = auto;
  }

  dispose() {
    this.rtA.dispose();
    this.rtB.dispose();
    this.cocMat.dispose();
    this.blurMat.dispose();
    this.compMat.dispose();
    this._quad.dispose();
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * GodrayPass — screen-space radial shafts from the sun.
 * Quarter-res occlusion/emission extraction (bright pixels that are far away,
 * cut by everything near), two radial blur sweeps, additive warm composite.
 * Masked by how close the sun is to the frame so it never appears from nowhere.
 * ────────────────────────────────────────────────────────────────────────── */

class GodrayPass extends Pass {
  constructor(gbuffer, camera, w, h) {
    super();
    this.gbuffer = gbuffer;
    this.camera = camera;
    this.intensity = 0.5;

    const shared = {
      uSun: { value: new THREE.Vector2(0.5, 0.9) },
    };
    this.sunUniform = shared.uSun;

    this.occMat = new THREE.ShaderMaterial({
      name: 'godray-occlusion',
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: gbuffer.depthTexture },
        uNear: { value: camera.near },
        uFar: { value: camera.far },
        uSun: shared.uSun,
        uSkyNear: { value: 55.0 },
        uSkyFar: { value: 165.0 },
        uLo: { value: 1.1 },
        uHi: { value: 5.0 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform vec2 uSun;
        uniform float uSkyNear, uSkyFar, uLo, uHi;
        ${DEPTH_HELPERS}
        ${LUMA}
        void main(){
          float d = sceneDepth(vUv);
          float sky = smoothstep(uSkyNear, uSkyFar, d);
          vec3 c = texture2D(tDiffuse, vUv).rgb;
          float e = smoothstep(uLo, uHi, luma(c)) * sky;
          // fade emitters that are miles from the sun so the shafts stay radial
          float r = length((vUv - uSun) * vec2(1.0, 0.62));
          e *= 1.0 - smoothstep(0.35, 1.1, r);
          gl_FragColor = vec4(c * e, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.blurMat = new THREE.ShaderMaterial({
      name: 'godray-radial',
      uniforms: {
        tDiffuse: { value: null },
        uSun: shared.uSun,
        uDensity: { value: 0.6 },
        uDecay: { value: 0.955 },
        uStep: { value: 1.0 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform vec2 uSun;
        uniform float uDensity, uDecay, uStep;
        const int SAMPLES = 16;
        void main(){
          vec2 delta = (vUv - uSun) * (uDensity / float(SAMPLES)) * uStep;
          vec2 uv = vUv;
          vec3 acc = vec3(0.0);
          float illum = 1.0;
          float wsum = 0.0;
          for (int i = 0; i < SAMPLES; i++){
            uv -= delta;
            acc += texture2D(tDiffuse, uv).rgb * illum;
            wsum += illum;
            illum *= uDecay;
          }
          gl_FragColor = vec4(acc / max(wsum, 1e-4), 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.compMat = new THREE.ShaderMaterial({
      name: 'godray-composite',
      uniforms: {
        tDiffuse: { value: null },
        tRays: { value: null },
        uIntensity: { value: 0.5 },
        uTint: { value: new THREE.Color(1.0, 0.82, 0.55) },
        uSun: shared.uSun,
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tDiffuse, tRays;
        uniform float uIntensity;
        uniform vec3 uTint;
        uniform vec2 uSun;
        void main(){
          vec3 base = texture2D(tDiffuse, vUv).rgb;
          vec3 rays = texture2D(tRays, vUv).rgb;
          float r = length((vUv - uSun) * vec2(1.0, 0.72));
          float fall = 1.0 - smoothstep(0.15, 1.05, r);
          gl_FragColor = vec4(base + rays * uTint * (uIntensity * fall), 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this._quad = new FullScreenQuad(this.occMat);
    this.rtA = null;
    this.rtB = null;
    this.setSize(w, h);
  }

  setSize(w, h) {
    const qw = Math.max(2, Math.floor(w * 0.25));
    const qh = Math.max(2, Math.floor(h * 0.25));
    if (this.rtA) this.rtA.dispose();
    if (this.rtB) this.rtB.dispose();
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false };
    this.rtA = new THREE.WebGLRenderTarget(qw, qh, opts);
    this.rtB = new THREE.WebGLRenderTarget(qw, qh, opts);
    for (const rt of [this.rtA, this.rtB]) {
      rt.texture.minFilter = THREE.LinearFilter;
      rt.texture.magFilter = THREE.LinearFilter;
      rt.texture.wrapS = THREE.ClampToEdgeWrapping;
      rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    }
  }

  _draw(renderer, material, target) {
    this._quad.material = material;
    renderer.setRenderTarget(target);
    this._quad.render(renderer);
  }

  render(renderer, writeBuffer, readBuffer) {
    const auto = renderer.autoClear;
    renderer.autoClear = true;

    this.occMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.occMat.uniforms.uNear.value = this.camera.near;
    this.occMat.uniforms.uFar.value = this.camera.far;
    this._draw(renderer, this.occMat, this.rtA);

    this.blurMat.uniforms.tDiffuse.value = this.rtA.texture;
    this.blurMat.uniforms.uStep.value = 1.0;
    this._draw(renderer, this.blurMat, this.rtB);

    // second sweep at a longer stride: cheap way to reach a long, soft shaft
    this.blurMat.uniforms.tDiffuse.value = this.rtB.texture;
    this.blurMat.uniforms.uStep.value = 3.0;
    this._draw(renderer, this.blurMat, this.rtA);

    this.compMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.compMat.uniforms.tRays.value = this.rtA.texture;
    this.compMat.uniforms.uIntensity.value = this.intensity;
    renderer.autoClear = false;
    this._draw(renderer, this.compMat, this.renderToScreen ? null : writeBuffer);

    renderer.autoClear = auto;
  }

  dispose() {
    this.rtA.dispose();
    this.rtB.dispose();
    this.occMat.dispose();
    this.blurMat.dispose();
    this.compMat.dispose();
    this._quad.dispose();
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * GTAO at a fraction of the frame. AO is a low-frequency signal and it gets
 * denoised anyway, so half resolution is free quality — and it keeps the whole
 * AO block (plus the G-buffer it shares) inside a sane fill budget.
 * ────────────────────────────────────────────────────────────────────────── */

class ScaledGTAOPass extends GTAOPass {
  constructor(scene, camera, w, h, scale) {
    super(scene, camera, Math.max(2, Math.round(w * scale)), Math.max(2, Math.round(h * scale)));
    this.renderScale = scale;
  }

  setSize(w, h) {
    const s = this.renderScale ?? 1;
    super.setSize(Math.max(2, Math.round(w * s)), Math.max(2, Math.round(h * s)));
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Underwater treatment
 * ────────────────────────────────────────────────────────────────────────── */

const UnderwaterShader = {
  name: 'UnderwaterShader',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uStrength: { value: 0 },
    uDepth: { value: 0 },
    uAspect: { value: 1.6 },
    uRefract: { value: 0.0055 },
    uAberration: { value: 0.0045 },
    // per-metre extinction: red goes first, blue survives
    uAbsorb: { value: new THREE.Vector3(0.26, 0.075, 0.052) },
    // equilibrium in-scatter colour — this is what stops deep water going black
    uTint: { value: new THREE.Color(0.075, 0.34, 0.50) },
    uScatter: { value: 2.2 },
    uShaft: { value: new THREE.Color(1.0, 0.88, 0.66) },
    uSunX: { value: 0.5 },
    uSunY: { value: 0.85 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uTime, uStrength, uDepth, uAspect, uRefract, uAberration;
    uniform float uSunX, uSunY, uScatter;
    uniform vec3 uAbsorb;
    uniform vec3 uTint, uShaft;
    ${GLSL_SNOISE2}
    ${LUMA}

    void main(){
      float S = uStrength;
      vec2 uv = vUv;
      vec2 centred = (uv - 0.5) * vec2(uAspect, 1.0);
      float r = length(centred);

      // Two scrolling noise fields at different scales and drift directions —
      // a wander, not a sine wave.
      vec2 slow = vec2(
        snoise2(uv * vec2(5.5, 3.6) + vec2(uTime * 0.055, uTime * 0.083)),
        snoise2(uv * vec2(4.2, 6.1) + vec2(-uTime * 0.071, uTime * 0.041) + 37.4)
      );
      vec2 fast = vec2(
        snoise2(uv * vec2(15.0, 11.5) - vec2(uTime * 0.15, uTime * 0.11)),
        snoise2(uv * vec2(12.5, 16.5) + vec2(uTime * 0.13, -uTime * 0.17) + 91.7)
      );
      vec2 wob = (slow * 0.72 + fast * 0.28) * uRefract * S;

      // chromatic aberration grows toward the edges
      float ca = uAberration * S * (0.25 + 0.95 * r * r);
      vec2 dir = r > 1e-4 ? centred / r : vec2(0.0);
      vec2 caOff = dir * ca;

      vec3 c;
      c.r = texture2D(tDiffuse, uv + wob * 1.05 + caOff).r;
      c.g = texture2D(tDiffuse, uv + wob).g;
      c.b = texture2D(tDiffuse, uv + wob * 0.95 - caOff).b;

      // ── single-scatter water ────────────────────────────────────────────
      // L = L0 * T + S * (1 - T). Transmittance eats the warm end of the
      // spectrum; the in-scatter term puts a luminous teal back in its place,
      // which is why real deep water glows instead of going black.
      float dd = max(uDepth, 0.0);
      vec3 T = exp(-uAbsorb * dd);
      float up = smoothstep(-0.05, 0.85, uv.y);
      vec3 inScatter = uTint * uScatter * (0.72 + 0.55 * up);
      vec3 wet = c * T + inScatter * (vec3(1.0) - T);

      // a warm shaft of light from above: soft columns that wander, brightest
      // just under the surface and fading with depth
      float band = smoothstep(0.0, 1.0, up);
      float cols = 0.5 + 0.5 * snoise2(vec2((uv.x - uSunX) * 4.2, uTime * 0.05));
      cols *= 0.55 + 0.45 * (0.5 + 0.5 * snoise2(vec2(uv.x * 11.0 + 4.1, uTime * 0.08)));
      float shaftFade = exp(-dd * 0.10);
      wet += uShaft * band * band * cols * (0.20 * shaftFade);

      // contrast eases off with depth — light stops being directional down there
      float dens = 1.0 - exp(-dd * 0.16);
      float lm = luma(wet);
      wet = mix(wet, mix(vec3(lm), wet, 0.55), dens * 0.45);

      // the frame closes in, but gently: a black surround reads as a bug
      float vig = 1.0 - smoothstep(0.40, 1.30, r) * (0.20 + 0.26 * dens);
      wet *= vig;

      vec3 dry = texture2D(tDiffuse, uv).rgb;
      gl_FragColor = vec4(mix(dry, wet, S), 1.0);
    }`,
};

/* ────────────────────────────────────────────────────────────────────────── *
 * The grade — bloom composite, ACES, hand-authored curve, split tone,
 * vignette, grain, edge aberration, lens drops. The last thing before AA.
 * ────────────────────────────────────────────────────────────────────────── */

const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null },
    tBloom: { value: null },
    uExposure: { value: 1.0 },
    uBloom: { value: 0.42 },
    uBloomTint: { value: new THREE.Color(1.0, 0.78, 0.55) },
    uTime: { value: 0 },
    uAspect: { value: 1.6 },
    uResolution: { value: new THREE.Vector2(1600, 900) },
    uContrast: { value: 0.32 },
    uSaturation: { value: 1.06 },
    uToe: { value: 0.028 },
    uToeTint: { value: new THREE.Color(0.34, 0.62, 0.78) },
    uShadowTint: { value: new THREE.Color(0.86, 1.0, 1.06) },
    uHighTint: { value: new THREE.Color(1.06, 1.0, 0.9) },
    uHiRoll: { value: 0.55 },
    uVignette: { value: 0.34 },
    uGrain: { value: 0.016 },
    uCA: { value: 0.0009 },
    uDrops: { value: 0.0 },
    uDropTime: { value: 0.0 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tDiffuse, tBloom;
    uniform float uExposure, uBloom, uTime, uAspect, uContrast, uSaturation;
    uniform float uToe, uVignette, uGrain, uCA, uDrops, uDropTime;
    uniform vec3 uBloomTint, uToeTint, uShadowTint, uHighTint;
    uniform float uHiRoll;
    uniform vec2 uResolution;
    ${HASH}
    ${LUMA}

    vec3 RRTAndODTFit(vec3 v){
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }
    // Byte-for-byte three's ACESFilmicToneMapping, so the sky's exposure
    // calibration means the same thing here as it would on the renderer.
    vec3 acesFilmic(vec3 color, float exposure){
      const mat3 ACESInputMat = mat3(
        vec3(0.59719, 0.07600, 0.02840),
        vec3(0.35458, 0.90834, 0.13383),
        vec3(0.04823, 0.01566, 0.83777));
      const mat3 ACESOutputMat = mat3(
        vec3( 1.60475, -0.10208, -0.00327),
        vec3(-0.53108,  1.10813, -0.07276),
        vec3(-0.07367, -0.00605,  1.07602));
      color *= exposure / 0.6;
      color = ACESInputMat * color;
      color = RRTAndODTFit(color);
      color = ACESOutputMat * color;
      return clamp(color, 0.0, 1.0);
    }

    // Lens drops: a sparse cell field of beads that slide down and shrink.
    vec2 dropOffset(vec2 uv, out float sparkle){
      sparkle = 0.0;
      if (uDrops < 0.001) return vec2(0.0);
      vec2 p = uv * vec2(uAspect, 1.0) * 7.0;
      vec2 acc = vec2(0.0);
      for (int j = 0; j < 2; j++){
        vec2 q = p + vec2(float(j) * 3.7, float(j) * 1.3);
        vec2 cell = floor(q);
        vec2 f = fract(q) - 0.5;
        float h = hash21(cell + float(j) * 17.0);
        if (h > 0.42) continue;
        vec2 c = (vec2(hash21(cell + 1.7), hash21(cell + 9.3)) - 0.5) * 0.55;
        c.y -= uDropTime * (0.25 + 0.9 * h) * 1.4;      // slide down
        vec2 d = f - c;
        float rad = (0.13 + 0.20 * h) * uDrops;
        float m = smoothstep(rad, rad * 0.25, length(d));
        acc += normalize(d + 1e-5) * m * 0.030;
        sparkle += m;
      }
      return acc * uDrops;
    }

    void main(){
      vec2 centred = (vUv - 0.5) * vec2(uAspect, 1.0);
      float r = length(centred);
      vec2 dir = r > 1e-5 ? centred / r : vec2(0.0);

      float sparkle;
      vec2 dOff = dropOffset(vUv, sparkle);

      // gentle edge aberration — barely legible, but the eye reads "lens"
      float ca = uCA * (r * r * r);
      vec2 base = vUv + dOff;
      vec3 hdr;
      hdr.r = texture2D(tDiffuse, base + dir * ca).r;
      hdr.g = texture2D(tDiffuse, base).g;
      hdr.b = texture2D(tDiffuse, base - dir * ca).b;

      vec3 bloom = texture2D(tBloom, base).rgb;
      hdr += bloom * uBloomTint * uBloom;

      vec3 c = acesFilmic(hdr, uExposure);

      // ── hand-authored curve, display-linear ───────────────────────────────
      // 0. highlight rolloff: as a value approaches clipping it desaturates
      //    toward the colour of the light, not toward paper white. Sun glitter
      //    on the river becomes warm cream instead of a flat blown patch.
      float mx = max(c.r, max(c.g, c.b));
      float hiRoll = smoothstep(0.68, 1.0, mx);
      c = mix(c, mx * uHighTint, hiRoll * uHiRoll);
      // 1. cool, lifted toe: shadows never reach zero and never go neutral grey
      float shadowMask = 1.0 - smoothstep(0.0, 0.30, luma(c));
      c += uToeTint * (uToe * shadowMask);

      // 2. filmic S: smoothstep is a proper sigmoid, mixed in by taste
      vec3 s = c * c * (3.0 - 2.0 * c);
      c = mix(c, s, uContrast);

      // 3. split tone — teal in the shadows, honey in the highlights
      float lm = luma(c);
      vec3 tone = mix(uShadowTint, uHighTint, smoothstep(0.12, 0.78, lm));
      c *= tone;

      // 4. saturation, with shadows a shade quieter than the light
      float lm2 = luma(c);
      float satAdj = uSaturation * mix(0.88, 1.0, smoothstep(0.05, 0.5, lm2));
      c = mix(vec3(lm2), c, satAdj);

      // 5. vignette: a soft closing of the frame, slightly warm-preserving
      float vig = 1.0 - uVignette * smoothstep(0.50, 1.42, r);
      c *= vig;

      // droplet sparkle
      c += vec3(0.9, 0.95, 1.0) * sparkle * 0.05 * uDrops;

      // 6. grain: stepped in time so it does not crawl, quieter in the light
      float t = floor(uTime * 11.0);
      float g = hash21(vUv * uResolution + vec2(t * 1.7, t * 3.1)) - 0.5;
      c += g * uGrain * (1.0 - 0.65 * smoothstep(0.35, 0.95, luma(c)));

      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }`,
};

/* ────────────────────────────────────────────────────────────────────────── *
 * Time-of-day grade keyframes. 0 = midnight, 0.25 sunrise, 0.5 noon,
 * 0.75 sunset. Every entry is a complete look; we lerp between neighbours.
 * ────────────────────────────────────────────────────────────────────────── */

const GRADE_KEYS = [
  { t: 0.00, exposure: 1.06, contrast: 0.24, saturation: 0.94, toe: 0.040,
    toeTint: [0.30, 0.55, 0.86], shadow: [0.80, 0.94, 1.14], high: [0.92, 0.98, 1.10],
    vignette: 0.34, bloom: 0.60, bloomTint: [0.72, 0.84, 1.0], grain: 0.018 },
  { t: 0.22, exposure: 1.02, contrast: 0.36, saturation: 1.05, toe: 0.026,
    toeTint: [0.36, 0.60, 0.84], shadow: [0.84, 0.98, 1.10], high: [1.10, 0.98, 0.86],
    vignette: 0.28, bloom: 0.72, bloomTint: [1.0, 0.70, 0.44], grain: 0.015 },
  { t: 0.32, exposure: 1.0, contrast: 0.36, saturation: 1.09, toe: 0.018,
    toeTint: [0.34, 0.64, 0.80], shadow: [0.86, 1.0, 1.07], high: [1.08, 1.0, 0.88],
    vignette: 0.24, bloom: 0.64, bloomTint: [1.0, 0.79, 0.54], grain: 0.012 },
  { t: 0.50, exposure: 0.97, contrast: 0.38, saturation: 1.05, toe: 0.014,
    toeTint: [0.32, 0.62, 0.86], shadow: [0.90, 1.0, 1.06], high: [1.04, 1.0, 0.94],
    vignette: 0.20, bloom: 0.50, bloomTint: [1.0, 0.89, 0.72], grain: 0.011 },
  { t: 0.68, exposure: 1.0, contrast: 0.36, saturation: 1.11, toe: 0.018,
    toeTint: [0.34, 0.62, 0.82], shadow: [0.86, 0.99, 1.09], high: [1.09, 0.99, 0.86],
    vignette: 0.24, bloom: 0.66, bloomTint: [1.0, 0.77, 0.50], grain: 0.012 },
  { t: 0.78, exposure: 1.03, contrast: 0.36, saturation: 1.13, toe: 0.024,
    toeTint: [0.32, 0.56, 0.84], shadow: [0.82, 0.95, 1.14], high: [1.14, 0.96, 0.78],
    vignette: 0.28, bloom: 0.82, bloomTint: [1.0, 0.66, 0.40], grain: 0.015 },
  { t: 1.00, exposure: 1.06, contrast: 0.24, saturation: 0.94, toe: 0.040,
    toeTint: [0.30, 0.55, 0.86], shadow: [0.80, 0.94, 1.14], high: [0.92, 0.98, 1.10],
    vignette: 0.34, bloom: 0.60, bloomTint: [0.72, 0.84, 1.0], grain: 0.018 },
];

const lerp = (a, b, t) => a + (b - a) * t;

/* ────────────────────────────────────────────────────────────────────────── */

export class PostFX {
  constructor(ctx) {
    this.ctx = ctx;
    this.composer = ctx.composer;
    this.renderer = ctx.renderer;
    this.scene = ctx.scene;
    // NOTE: main.js assigns every booted system onto ctx by its manifest key,
    // and the camera *rig* uses the key `camera` — so `ctx.camera` is the rig,
    // not the THREE camera. The real camera is always engine.camera.
    this.camera = ctx.engine.camera;

    this.enabled = true;
    this.passes = [];
    this.gbuffer = null;
    this.gtao = null;
    this.underwaterPass = null;
    this.godrays = null;
    this.dof = null;
    this.bloom = null;
    this.grade = null;
    this.aa = null;
    this.output = null;

    // live state
    this.wet = 0;            // 0..1 underwater blend
    this.depthBelow = 0;
    this.dropTimer = 0;
    this.focus = 6.0;
    this.sunOnScreen = 0;
    this._lastSunX = 0.5;
    this.debugUnderwater = null;   // { on, depth } — capture/debug override
    this.debugSunUV = null;        // { x, y } — force the god-ray origin

    this._qualityName = null;
    /** G-buffer / AO render scale. AO and CoC are low-frequency; half is plenty. */
    this._gbScale = 0.5;
    this._w = 1600;
    this._h = 900;
    this._dpr = 1;

    // scratch — no allocation in update()
    this._sunWorld = new THREE.Vector3();
    this._sunProj = new THREE.Vector3();
    this._camDir = new THREE.Vector3();
    this._fallbackSun = new THREE.Vector3(0.35, 0.32, 0.88).normalize();
    this._c0 = new THREE.Color();
    this._c1 = new THREE.Color();
    this._c2 = new THREE.Color();

    this.params = {
      bloomThreshold: 1.15,
      bloomKnee: 0.70,
      bloomScale: 1.0,
      aoIntensity: 0.55,
      dofScale: 1.0,
      godrayScale: 1.0,
      gradeScale: 1.0,
    };
  }

  async init() {
    const e = this.ctx.engine;
    this._w = e.width;
    this._h = e.height;
    this._dpr = e._dpr ?? 1;
    this.build();
  }

  /* ── chain construction ─────────────────────────────────────────────── */

  get _pw() { return Math.max(2, Math.round(this._w * this._dpr)); }
  get _ph() { return Math.max(2, Math.round(this._h * this._dpr)); }

  build() {
    const q = settings.quality;
    this._qualityName = q.name;
    const w = this._pw;
    const h = this._ph;

    const wantAO = !!q.ssao;
    const wantGod = !!q.godrays;
    const wantDOF = q.name !== 'low';
    const wantGBuffer = wantAO || wantGod || wantDOF;

    this._teardown();

    const gs = this._gbScale;
    if (wantGBuffer) {
      this.gbuffer = new GBufferPass(
        this.scene, this.camera,
        Math.max(2, Math.round(w * gs)), Math.max(2, Math.round(h * gs))
      );
      this.gbuffer.scale = gs;
      this._add(this.gbuffer);
    }

    if (wantAO && this.gbuffer) {
      const gtao = new ScaledGTAOPass(this.scene, this.camera, w, h, gs);
      // Hand it our G-buffer so it does not render the scene a second time.
      // (setGBuffer still pokes normalRenderTarget, so point that at ours
      //  before calling it — and drop the one it made in its constructor.)
      if (gtao.normalRenderTarget) gtao.normalRenderTarget.dispose();
      gtao.normalRenderTarget = this.gbuffer.target;
      gtao.setGBuffer(this.gbuffer.depthTexture, this.gbuffer.target.texture);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.blendIntensity = this.params.aoIntensity;
      gtao.updateGtaoMaterial({
        radius: 0.55,
        distanceExponent: 1.0,
        thickness: 0.6,
        scale: 1.0,
        samples: 8,
        screenSpaceRadius: false,
      });
      gtao.updatePdMaterial({ lumaPhi: 8, depthPhi: 2.5, normalPhi: 3.5, radius: 5, samples: 8 });
      this.gtao = gtao;
      this._add(gtao);
    }

    // Underwater sits before the shafts and the bloom so the tinted water
    // colours everything downstream. Disabled (skipped entirely) when dry.
    this.underwaterPass = new ShaderPass(UnderwaterShader);
    this.underwaterPass.enabled = false;
    this._add(this.underwaterPass);

    if (wantGod && this.gbuffer) {
      this.godrays = new GodrayPass(this.gbuffer, this.camera, w, h);
      this.godrays.enabled = false; // turned on when the sun is near the frame
      this._add(this.godrays);
    }

    if (wantDOF && this.gbuffer) {
      this.dof = new DOFPass(this.gbuffer, this.camera, w, h);
      this.dof.maxRadius = q.name === 'high' ? 8.0 : 6.0;
      this._add(this.dof);
    }

    this.bloom = new BloomPass(w, h);
    this.bloom.bright.uniforms.uThreshold.value = this.params.bloomThreshold;
    this.bloom.bright.uniforms.uKnee.value = this.params.bloomKnee;
    this._add(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.tBloom.value = this.bloom.texture;
    this.grade.uniforms.uResolution.value.set(w, h);
    this._add(this.grade);

    if (q.name === 'low') {
      this.aa = new FXAAPass();
    } else {
      this.aa = new SMAAPass();
    }
    this._add(this.aa);

    this.output = new OutputPass();
    this._add(this.output);

    this._sizePasses(w, h);

    // We tone map in the grade; leave OutputPass with nothing but sRGB to do.
    this.renderer.toneMapping = THREE.NoToneMapping;
  }

  _add(pass) {
    this.composer.addPass(pass);
    this.passes.push(pass);
  }

  _teardown() {
    for (const p of this.passes) {
      this.composer.removePass(p);
      if (p.dispose) {
        try { p.dispose(); } catch { /* library passes are sloppy about this */ }
      }
    }
    this.passes.length = 0;
    this.gbuffer = this.gtao = this.underwaterPass = null;
    this.godrays = this.dof = this.bloom = this.grade = this.aa = this.output = null;
  }

  _sizePasses(w, h) {
    for (const p of this.passes) {
      if (p.setSize) p.setSize(w, h);
    }
    if (this.bloom && this.grade) this.grade.uniforms.tBloom.value = this.bloom.texture;
    if (this.grade) this.grade.uniforms.uResolution.value.set(w, h);
  }

  /** Rebuild the whole chain — call after changing settings.quality. */
  rebuild() {
    this.build();
  }

  /**
   * Bypass the chain. When off we hand ACES back to the renderer so the
   * un-graded image is still correctly tone mapped — that is the honest
   * "before" picture.
   */
  setEnabled(on) {
    const want = !!on;
    if (want === this.enabled) return this.enabled;
    this.enabled = want;
    if (want) {
      for (const p of this.passes) {
        // godrays / underwater are driven per frame; update() re-enables them
        p.enabled = p !== this.godrays && p !== this.underwaterPass;
      }
      this.renderer.toneMapping = THREE.NoToneMapping;
    } else {
      for (const p of this.passes) p.enabled = p === this.output;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    }
    return this.enabled;
  }

  /** Debug/capture hook: pin the god-ray origin to a screen position. */
  setSunUV(x, y) { this.debugSunUV = (x == null) ? null : { x, y }; }

  /** Debug/capture hook: force the underwater treatment on. */
  setUnderwater(on, depth = 2.0) {
    this.debugUnderwater = on ? { on: true, depth } : null;
  }

  /* ── per-frame ──────────────────────────────────────────────────────── */

  update(dt, elapsed) {
    if (!this.grade) return;
    if (settings.quality?.name !== this._qualityName) this.rebuild();
    if (!this.enabled) return;

    const ctx = this.ctx;
    const sky = ctx.sky;
    const rig = ctx.get?.('camera');
    const player = ctx.player;

    /* underwater blend ------------------------------------------------- */
    let wetTarget = 0;
    let depth = 0;
    if (this.debugUnderwater?.on) {
      wetTarget = 1;
      depth = this.debugUnderwater.depth;
    } else if (rig?.underwater || player?.submerged) {
      wetTarget = 1;
      // How dense the water reads is about how deep the *lens* is, not the duck.
      const cp = this.camera.position;
      const surf = ctx.water?.heightAt ? ctx.water.heightAt(cp.x, cp.z) : (ctx.WATER_LEVEL ?? 0);
      const camDepth = surf - cp.y;
      depth = camDepth > 0.05 ? camDepth : (player?.depthBelow ?? 1.0);
    }
    const wasWet = this.wet > 0.5;
    const k = 1 - Math.exp(-dt * 8.6); // ≈0.35s to settle
    this.wet += (wetTarget - this.wet) * k;
    this.depthBelow += (depth - this.depthBelow) * Math.min(1, dt * 4.0);
    if (wasWet && wetTarget === 0) this.dropTimer = 0.85;
    if (this.dropTimer > 0) this.dropTimer = Math.max(0, this.dropTimer - dt);

    const up = this.underwaterPass;
    if (up) {
      const s = this.wet;
      up.enabled = s > 0.004;
      if (up.enabled) {
        const u = up.uniforms;
        u.uTime.value = elapsed;
        u.uStrength.value = s;
        u.uDepth.value = this.depthBelow;
        u.uAspect.value = this.camera.aspect;
        u.uSunY.value = sky?.sunDirection?.y ?? 0.4;
        u.uSunX.value = this.debugSunUV ? this.debugSunUV.x : this._lastSunX;
        // in-scatter tracks the sky so dusk water is not lit like noon water
        if (sky?.horizonColor) {
          u.uTint.value.copy(sky.horizonColor).lerp(this._c1.setRGB(0.075, 0.34, 0.50), 0.72);
        }
        if (sky?.sunColor) u.uShaft.value.copy(sky.sunColor);
      }
    }

    /* sun on screen ---------------------------------------------------- */
    const sunDir = sky?.sunDirection ?? this._fallbackSun;
    this._sunWorld.copy(this.camera.position).addScaledVector(sunDir, 600);
    this._sunProj.copy(this._sunWorld).project(this.camera);
    this.camera.getWorldDirection(this._camDir);
    const facing = this._camDir.dot(sunDir);
    const sx = this._sunProj.x * 0.5 + 0.5;
    this._lastSunX = Math.max(0, Math.min(1, sx));
    const sy = this._sunProj.y * 0.5 + 0.5;
    const offCentre = Math.max(Math.abs(this._sunProj.x), Math.abs(this._sunProj.y));
    let vis = Math.max(0, Math.min(1, (facing - 0.02) / 0.30));
    vis *= 1 - Math.min(1, Math.max(0, (offCentre - 0.85) / 1.15));
    vis *= Math.max(0, Math.min(1, (sunDir.y + 0.02) / 0.10)); // sun below the horizon: nothing
    if (this.debugSunUV) { vis = 1; }
    this.sunOnScreen = vis;

    if (this.godrays) {
      const s = vis * this.params.godrayScale * (1 + this.wet * 1.6);
      this.godrays.enabled = s > 0.01;
      if (this.godrays.enabled) {
        if (this.debugSunUV) this.godrays.sunUniform.value.set(this.debugSunUV.x, this.debugSunUV.y);
        else this.godrays.sunUniform.value.set(sx, sy);
        this.godrays.intensity = 0.42 * s;
        const occ = this.godrays.occMat.uniforms;
        // underwater everything is close, so the "sky" test has to come in
        occ.uSkyNear.value = lerp(55, 2.5, this.wet);
        occ.uSkyFar.value = lerp(165, 22.0, this.wet);
        occ.uLo.value = lerp(1.1, 0.55, this.wet);
        occ.uHi.value = lerp(5.0, 2.4, this.wet);
        const tint = this.godrays.compMat.uniforms.uTint.value;
        if (sky?.sunColor) {
          tint.copy(sky.sunColor).lerp(this._c0.setRGB(0.55, 0.92, 0.95), this.wet * 0.7);
        }
      }
    }

    /* depth of field --------------------------------------------------- */
    if (this.dof) {
      let fd = rig?.focusDistance;
      if (!(fd > 0)) {
        // No rig yet: focus on whatever the centre of frame is looking at.
        fd = player?.position ? this.camera.position.distanceTo(player.position) : 7.5;
      }
      this.focus += (fd - this.focus) * Math.min(1, dt * 3.2);
      this.dof.focusDistance = Math.max(0.6, this.focus);
      const q = settings.quality;
      const base = q.name === 'high' ? 1.0 : 0.8;
      this.dof.intensity = base * this.params.dofScale * (1 + this.wet * 0.35);
      this.dof.nearStrength = 0.55;
      this.dof.farStrength = 0.22;
      // uNearRange: focus/d - 1 at which the near field is fully soft.
      // 1.6 ≈ everything closer than ~0.4x the focus distance.
      this.dof.cocMat.uniforms.uNearRange.value = 2.6;
      this.dof.cocMat.uniforms.uFarAmt.value = lerp(0.22, 0.40, this.wet);
    }

    /* grade ------------------------------------------------------------ */
    const tod = sky?.timeOfDay ?? settings.timeOfDay ?? 0.3;
    this._applyGrade(tod, elapsed);
  }

  _applyGrade(tod, elapsed) {
    const keys = GRADE_KEYS;
    let i = 0;
    while (i < keys.length - 2 && tod > keys[i + 1].t) i++;
    const a = keys[i];
    const b = keys[i + 1];
    const f = Math.max(0, Math.min(1, (tod - a.t) / Math.max(1e-4, b.t - a.t)));

    const u = this.grade.uniforms;
    const exposureFromSky = this.renderer.toneMappingExposure ?? 1.0;
    const scale = this.params.gradeScale;

    u.uExposure.value = exposureFromSky * lerp(a.exposure, b.exposure, f);
    u.uContrast.value = lerp(a.contrast, b.contrast, f) * scale;
    u.uSaturation.value = lerp(a.saturation, b.saturation, f);
    u.uToe.value = lerp(a.toe, b.toe, f) * scale;
    u.uVignette.value = lerp(a.vignette, b.vignette, f) * scale;
    u.uGrain.value = lerp(a.grain, b.grain, f);
    u.uBloom.value = lerp(a.bloom, b.bloom, f) * this.params.bloomScale;
    u.uTime.value = elapsed;
    u.uAspect.value = this.camera.aspect;
    u.uCA.value = 0.0009 * scale;
    u.uHiRoll.value = 0.55;

    this._c0.setRGB(a.toeTint[0], a.toeTint[1], a.toeTint[2]);
    this._c1.setRGB(b.toeTint[0], b.toeTint[1], b.toeTint[2]);
    u.uToeTint.value.copy(this._c0).lerp(this._c1, f);

    this._c0.setRGB(a.shadow[0], a.shadow[1], a.shadow[2]);
    this._c1.setRGB(b.shadow[0], b.shadow[1], b.shadow[2]);
    u.uShadowTint.value.copy(this._c0).lerp(this._c1, f);

    this._c0.setRGB(a.high[0], a.high[1], a.high[2]);
    this._c1.setRGB(b.high[0], b.high[1], b.high[2]);
    u.uHighTint.value.copy(this._c0).lerp(this._c1, f);

    this._c0.setRGB(a.bloomTint[0], a.bloomTint[1], a.bloomTint[2]);
    this._c1.setRGB(b.bloomTint[0], b.bloomTint[1], b.bloomTint[2]);
    u.uBloomTint.value.copy(this._c0).lerp(this._c1, f);

    // Underwater pushes the whole grade cool and quiet.
    if (this.wet > 0.001) {
      const w = this.wet;
      u.uSaturation.value = lerp(u.uSaturation.value, 0.92, w * 0.6);
      u.uContrast.value = lerp(u.uContrast.value, 0.20, w * 0.7);
      u.uVignette.value = lerp(u.uVignette.value, 0.34, w * 0.8);
      u.uToe.value = lerp(u.uToe.value, 0.05, w);
      u.uBloom.value = lerp(u.uBloom.value, u.uBloom.value * 1.25, w);
      u.uBloomTint.value.lerp(this._c2.setRGB(0.62, 0.95, 1.0), w * 0.75);
      u.uCA.value = lerp(u.uCA.value, 0.0022, w);
      u.uHiRoll.value = lerp(0.55, 0.30, w);
    }

    // lens drops for ~0.5s after breaking the surface
    const drops = Math.max(0, Math.min(1, this.dropTimer / 0.5));
    u.uDrops.value = drops * drops * (1 - this.wet);
    u.uDropTime.value = Math.max(0, 0.85 - this.dropTimer);
  }

  /* ── plumbing ───────────────────────────────────────────────────────── */

  resize(w, h, dpr) {
    this._w = w;
    this._h = h;
    this._dpr = dpr ?? this._dpr;
    // The composer has already called setSize on every pass, but our own
    // half/quarter-res targets and the bloom pyramid key off the *pixel* size,
    // so redo it here with the numbers we trust.
    this._sizePasses(this._pw, this._ph);
  }

  dispose() {
    this._teardown();
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  }
}
