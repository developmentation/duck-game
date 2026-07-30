// Sky, sun and global lighting. Every other system reads its light from here,
// so the public surface (see CONTRACT.md) is the contract:
//
//   sunDirection sunLight sunColor ambientColor fogColor envMap
//   exposure timeOfDay horizonColor setTimeOfDay(t)
//
// Structure:
//   * an analytic Rayleigh + Mie sky, hand-tuned, painted on a camera-locked
//     inverted dome at full resolution — HDR, linear, tone mapped downstream
//   * a raymarched cumulus + cirrus layer baked into a small HDR cube and
//     composited into that dome (soft clouds do not need screen resolution,
//     and this turns the only expensive part of the sky into one texture tap)
//   * a directional sun with a tight, texel-snapped, camera-following shadow
//     frustum, plus a hemisphere fill and a warm bounce light
//   * FogExp2 whose colour is the analytic horizon in the current view
//     direction, evaluated on the CPU with the same maths as the shader
//   * a PMREM environment map generated from our own dome

import * as THREE from 'three';
import {
  skyParams, skyRadiance, makeSkyUniforms, makeSkyMaterial, makeCloudMaterial,
  applyParamsToUniforms, sunDirectionFor, clamp, mix, smoothstep,
} from '../render/atmosphere.js';

const DOME_RADIUS = 240;
// Rayleigh zenith optical depth, matching atmosphere.js.
const BETA_R = [0.0464, 0.1080, 0.2650];

function qsInt(name, def) {
  try {
    const v = new URLSearchParams(location.search).get(name);
    if (v === null) return def;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
  } catch { return def; }
}

/** Is this a software rasteriser? Then the cloud bake must be much cheaper. */
function detectSoftware(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    return /swiftshader|softwarerasterizer|llvmpipe|basic render/i.test(name);
  } catch { return false; }
}

export class Sky {
  constructor(ctx) {
    this.ctx = ctx;

    // ---- public contract, valid from init() onward -----------------------
    this.timeOfDay = ctx.settings.timeOfDay ?? 0.3;
    this.sunDirection = new THREE.Vector3(0, 0.28, 1).normalize();
    this.sunLight = null;
    this.sunColor = new THREE.Color(1, 0.86, 0.68);
    this.ambientColor = new THREE.Color(0.28, 0.42, 0.6);
    this.fogColor = new THREE.Color(0.6, 0.7, 0.8);
    this.horizonColor = new THREE.Color(0.7, 0.72, 0.72);
    this.envMap = null;
    this.exposure = 1.0;

    // extras other systems find useful (not part of the required contract)
    this.zenithColor = new THREE.Color(0.2, 0.35, 0.6);
    this.sunIntensity = 3.4;
    this.sunElevationDeg = 15;
    this.night = 0;

    // ---- internals -------------------------------------------------------
    this.params = skyParams(this.timeOfDay);
    this.uniforms = makeSkyUniforms();

    this._v0 = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._focus = new THREE.Vector3();
    this._ax = new THREE.Vector3();
    this._ay = new THREE.Vector3();
    this._az = new THREE.Vector3();
    this._clearSave = new THREE.Color();
    this._rgb = [0, 0, 0];
    this._rgb2 = [0, 0, 0];
  }

  async init() {
    const { scene, renderer, settings } = this.ctx;
    // NB: ctx.camera is reassigned to the cameraRig *system* once it boots, so
    // the only reliable handle on the actual PerspectiveCamera is the engine's.
    this._camera = this.ctx.engine?.camera || this.ctx.camera;
    const q = settings.quality;
    const soft = detectSoftware(renderer);
    this._software = soft;

    this._cubeSize = qsInt('skycube',
      soft ? 288 : q.name === 'low' ? 256 : q.name === 'medium' ? 384 : 448);
    // The march is baked, not per-frame, so a generous step count is cheap. Too
    // few and the constant step positions along a screen row band visibly.
    this._cloudSteps = qsInt('skysteps',
      soft ? 22 : q.name === 'low' ? 16 : q.name === 'medium' ? 22 : 26);
    // The bake is amortised one cube face per tick; the tick length is tuned
    // from the measured face cost so cloud drift never costs more than a
    // fraction of a frame. Software rasterisers only ever bake on demand.
    this._faceInterval = soft ? 1e9 : 0.25;
    this._face = 0;
    this._bakeClock = 0;
    this._bakeCost = 0;
    this._cloudsDirty = true;

    this._shadowExtent = q.name === 'low' ? 38 : q.name === 'medium' ? 48 : 58;
    this._shadowDist = 190;
    this._shadowLookAhead = 16;

    // --- cloud cube (baked) ----------------------------------------------
    this._cloudRT = new THREE.WebGLCubeRenderTarget(this._cubeSize, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this._cloudRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this._cloudRT.texture.generateMipmaps = false;
    this._cloudRT.texture.minFilter = THREE.LinearFilter;
    this._cloudRT.texture.magFilter = THREE.LinearFilter;
    this.uniforms.uCloudCube.value = this._cloudRT.texture;
    // one cube texel in radians, used as the composite tent-filter radius
    // one texel of cube-face parameter space (face coords span [-1,1])
    this.uniforms.uCloudBlur.value = 2.0 / this._cubeSize;

    this._cloudScene = new THREE.Scene();
    this._cloudGeo = new THREE.SphereGeometry(DOME_RADIUS, 40, 24);
    this._cloudMat = makeCloudMaterial(this.uniforms, { steps: this._cloudSteps });
    this._cloudDome = new THREE.Mesh(this._cloudGeo, this._cloudMat);
    this._cloudDome.frustumCulled = false;
    this._cloudScene.add(this._cloudDome);
    this._cloudCam = new THREE.CubeCamera(1, 1000, this._cloudRT);
    this._cloudScene.add(this._cloudCam);

    // --- the visible dome -------------------------------------------------
    this.geometry = new THREE.SphereGeometry(DOME_RADIUS, 96, 48);
    this.material = makeSkyMaterial(this.uniforms, { cloudCube: true });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'SkyDome';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    scene.add(this.mesh);
    scene.background = null;

    // --- the lighting rig -------------------------------------------------
    this.sunLight = new THREE.DirectionalLight(0xffffff, 3.4);
    this.sunLight.name = 'Sun';
    this.sunLight.castShadow = true;
    const sh = this.sunLight.shadow;
    // A tight ortho frustum makes a huge map pointless: 58 m half-extent at
    // 2048 is already 5.7 cm per texel. Software rasterisers get less again.
    const shadowSize = qsInt('skyshadow', soft ? 1024 : Math.min(q.shadowMap, 2048));
    sh.mapSize.set(shadowSize, shadowSize);
    sh.camera.near = 1;
    sh.camera.far = this._shadowDist * 2.0;
    this._fitShadowOrtho();
    if (renderer.shadowMap.type === THREE.VSMShadowMap) {
      sh.bias = 0.0;
      sh.normalBias = 0.035;
      sh.radius = 3.0;
      sh.blurSamples = 8;
    } else {
      sh.bias = -0.00035;
      sh.normalBias = 0.030;
      sh.radius = 1.6;
    }
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);

    // Sky/ground bounce. Deliberately modest — most of the ambient comes from
    // the PMREM env map; this keeps non-PBR materials from going flat.
    this.hemi = new THREE.HemisphereLight(0x9fc8e8, 0x4e5a34, 0.55);
    this.hemi.name = 'SkyBounce';
    scene.add(this.hemi);

    // A small warm bounce off the water and banks onto the shaded side.
    this.bounce = new THREE.DirectionalLight(0xffd9a8, 0.25);
    this.bounce.name = 'SunBounce';
    this.bounce.castShadow = false;
    scene.add(this.bounce);
    scene.add(this.bounce.target);

    // --- fog --------------------------------------------------------------
    this.fog = new THREE.FogExp2(0x9fb8c4, 0.0024);
    scene.fog = this.fog;

    // --- PMREM ------------------------------------------------------------
    this._pmrem = new THREE.PMREMGenerator(renderer);
    this._pmremRT = null;
    this._pmremScene = new THREE.Scene();
    this._pmremGeo = new THREE.SphereGeometry(DOME_RADIUS, 32, 20);
    this._pmremMesh = new THREE.Mesh(this._pmremGeo, this.material);
    this._pmremMesh.frustumCulled = false;
    this._pmremScene.add(this._pmremMesh);
    this._envDirty = true;

    this.setTimeOfDay(this.timeOfDay, true);
    this._cloudCam.update(renderer, this._cloudScene); // establishes face cameras
    this._bakeClouds(true);
    this._regenerateEnv();
    renderer.toneMappingExposure = this.exposure;
  }

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------

  /** Set the time of day (0..1) and re-derive the whole lighting state. */
  setTimeOfDay(t, force = false) {
    t = ((t % 1) + 1) % 1;
    if (!force && Math.abs(t - this.timeOfDay) < 1e-6) return;
    this.timeOfDay = t;
    this.ctx.settings.timeOfDay = t;

    const p = skyParams(t, this.params);
    applyParamsToUniforms(p, this.uniforms);
    sunDirectionFor(t, this.sunDirection);
    this.sunElevationDeg = p.elevationDeg;
    this.night = p.night;
    this.exposure = p.exposure;

    // --- direct sun colour ------------------------------------------------
    // Physical extinction along the sun's own path through the atmosphere, so
    // the light and the sky agree about what colour the sun is.
    const sd = this.sunDirection;
    const dayMask = smoothstep(-0.10, 0.10, sd.y);
    const ext = this._sunExtinction(p, this._rgb);
    const m = Math.max(ext[0], ext[1], ext[2], 1e-4);
    // Never let the sun go fully monochromatic: dusk should read gold-to-rose,
    // not like a blood filter.
    const lift = mix(0.34, 0.0, dayMask);
    this.sunColor.setRGB(
      clamp(ext[0] / m, 0, 1),
      clamp(mix(ext[1] / m, 0.64, lift), 0, 1),
      clamp(mix(ext[2] / m, 0.44, lift), 0, 1),
      THREE.LinearSRGBColorSpace
    );
    this.sunIntensity = p.sunLightIntensity;
    if (this.sunLight) {
      this.sunLight.color.copy(this.sunColor);
      this.sunLight.intensity = p.sunLightIntensity;
    }

    // --- sky-derived ambient ---------------------------------------------
    const zen = skyRadiance(0, 1, 0, p, this._rgb);
    this.zenithColor.setRGB(
      clamp(zen[0], 0, 4), clamp(zen[1], 0, 4), clamp(zen[2], 0, 4),
      THREE.LinearSRGBColorSpace
    );
    // Sample the horizon *across* the sun, not toward it: the sunward horizon is
    // the brightest, warmest part of the sky and would turn the "sky bounce"
    // orange, collapsing the warm-light / cool-shadow contrast the whole look
    // depends on.
    const pl = Math.hypot(sd.z, sd.x) || 1;
    const hz = skyRadiance(-sd.z / pl, 0.05, sd.x / pl, p, this._rgb2);
    const aR = mix(zen[0], hz[0], 0.30);
    const aG = mix(zen[1], hz[1], 0.30);
    const aB = mix(zen[2], hz[2], 0.30);
    const an = Math.max(aR, aG, aB, 1e-4);
    this.ambientColor.setRGB(
      clamp(aR / an, 0, 1), clamp(aG / an, 0, 1), clamp(aB / an, 0, 1),
      THREE.LinearSRGBColorSpace
    );

    if (this.hemi) {
      this.hemi.color.copy(this.ambientColor);
      const gw = smoothstep(-4, 14, p.elevationDeg);
      this.hemi.groundColor.setRGB(
        mix(0.10, 0.28, gw), mix(0.11, 0.30, gw), mix(0.16, 0.18, gw),
        THREE.LinearSRGBColorSpace
      );
      this.hemi.intensity = mix(0.46, 0.32, smoothstep(-8, 10, p.elevationDeg));
    }
    if (this.bounce) {
      this.bounce.color.setRGB(
        mix(0.30, 1.0, dayMask), mix(0.34, 0.82, dayMask), mix(0.48, 0.60, dayMask),
        THREE.LinearSRGBColorSpace
      );
      this.bounce.intensity = mix(0.05, 0.30, dayMask);
    }

    this._cloudsDirty = true;
    this._envDirty = true;
    this._updateFogColor();
  }

  update(dt, elapsed) {
    const { settings, renderer, scene } = this.ctx;
    const camera = this._camera;

    if (Math.abs((settings.timeOfDay ?? this.timeOfDay) - this.timeOfDay) > 1e-6) {
      this.setTimeOfDay(settings.timeOfDay);
    }

    this.uniforms.uTime.value = elapsed;
    if (this.mesh && camera) this.mesh.position.copy(camera.position);

    this._updateSunTransform();
    this._updateFogColor();

    // Exposure is ours, per the contract.
    renderer.toneMappingExposure = this.exposure;

    // Re-bake clouds: immediately when the light changed, otherwise on a slow
    // cadence for drift. The interval is auto-tuned from the measured cost so
    // weak machines simply stop animating the clouds instead of stuttering.
    this._bakeClock += dt;
    if (this._cloudsDirty) {
      this._bakeClock = 0;
      this._cloudsDirty = false;
      this._bakeClouds(true);
    } else if (this._bakeClock >= this._faceInterval) {
      this._bakeClock = 0;
      this._bakeClouds(false);
    }
    if (this._envDirty && !this._cloudsDirty) {
      this._envDirty = false;
      this._regenerateEnv();
    }

    // Underwater may take the fog over; if it hands it back, take it again.
    if (scene.fog === null) scene.fog = this.fog;
  }

  dispose() {
    const { scene } = this.ctx;
    if (this.mesh) scene.remove(this.mesh);
    this.geometry?.dispose();
    this.material?.dispose();
    this._cloudGeo?.dispose();
    this._cloudMat?.dispose();
    this._cloudRT?.dispose();
    this._pmremGeo?.dispose();
    if (this.sunLight) {
      scene.remove(this.sunLight);
      scene.remove(this.sunLight.target);
      this.sunLight.dispose?.();
    }
    if (this.hemi) scene.remove(this.hemi);
    if (this.bounce) { scene.remove(this.bounce); scene.remove(this.bounce.target); }
    if (scene.fog === this.fog) scene.fog = null;
    if (scene.environment === this.envMap) scene.environment = null;
    this._pmremRT?.dispose();
    this._pmrem?.dispose();
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  _sunExtinction(p, out) {
    const sy = p.sunDir[1];
    const c = Math.max(sy, 0.004);
    const am = 1.0 / (c + 0.025 * Math.exp(-11.0 * c));
    for (let i = 0; i < 3; i++) out[i] = Math.exp(-(BETA_R[i] + p.betaM[i]) * am);
    return out;
  }

  /**
   * Render the cumulus + cirrus layers into the HDR cloud cube. `all` bakes the
   * whole cube (light changed); otherwise one face per call, round robin.
   */
  _bakeClouds(all) {
    const r = this.ctx.renderer;
    const cams = this._cloudCam?.children;
    if (!cams || cams.length < 6) return;
    const t0 = performance.now();
    r.getClearColor(this._clearSave);
    const alphaSave = r.getClearAlpha();
    const toneSave = r.toneMapping;
    const targetSave = r.getRenderTarget();
    r.setClearColor(0x000000, 0);
    r.toneMapping = THREE.NoToneMapping;
    try {
      const n = all ? 6 : 1;
      for (let i = 0; i < n; i++) {
        const face = all ? i : this._face;
        r.setRenderTarget(this._cloudRT, face);
        r.render(this._cloudScene, cams[face]);
        if (!all) this._face = (this._face + 1) % 6;
      }
    } catch (err) {
      console.warn('[sky] cloud bake failed:', err.message);
    }
    r.setRenderTarget(targetSave);
    r.toneMapping = toneSave;
    r.setClearColor(this._clearSave, alphaSave);
    const cost = performance.now() - t0;
    this._bakeCost = cost;
    if (!this._software) {
      // Keep the amortised drift cost near 2% of the frame.
      const faceCost = all ? cost / 6 : cost;
      this._faceInterval = clamp(faceCost * 0.05, 1 / 20, 8.0);
    }
  }

  _fitShadowOrtho() {
    const c = this.sunLight.shadow.camera;
    const e = this._shadowExtent;
    c.left = -e; c.right = e; c.top = e; c.bottom = -e;
    c.updateProjectionMatrix();
  }

  /**
   * Tight ortho shadow frustum that follows the camera, snapped to the shadow
   * map texel grid so shadow edges do not crawl as the camera moves.
   */
  _updateSunTransform() {
    const cam = this._camera;
    const sl = this.sunLight;
    if (!cam || !sl) return;

    cam.getWorldDirection(this._fwd);
    const focus = this._focus.copy(cam.position);
    focus.x += this._fwd.x * this._shadowLookAhead;
    focus.z += this._fwd.z * this._shadowLookAhead;
    focus.y = clamp(cam.position.y * 0.35, -3.0, 8.0);

    const az = this._az.copy(this.sunDirection);
    const nearPole = Math.abs(az.y) > 0.985;
    this._ax.set(nearPole ? 1 : 0, nearPole ? 0 : 1, 0).cross(az);
    if (this._ax.lengthSq() < 1e-6) this._ax.set(1, 0, 0);
    this._ax.normalize();
    this._ay.copy(az).cross(this._ax).normalize();

    const texel = (2 * this._shadowExtent) / sl.shadow.mapSize.x;
    const px = focus.dot(this._ax), py = focus.dot(this._ay), pz = focus.dot(az);
    const qx = Math.round(px / texel) * texel;
    const qy = Math.round(py / texel) * texel;
    focus.set(
      this._ax.x * qx + this._ay.x * qy + az.x * pz,
      this._ax.y * qx + this._ay.y * qy + az.y * pz,
      this._ax.z * qx + this._ay.z * qy + az.z * pz
    );

    sl.position.set(
      focus.x + az.x * this._shadowDist,
      focus.y + az.y * this._shadowDist,
      focus.z + az.z * this._shadowDist
    );
    sl.target.position.copy(focus);
    sl.target.updateMatrixWorld();

    const lit = sl.intensity > 0.01;
    sl.castShadow = lit;
    sl.visible = lit;

    if (this.bounce) {
      this.bounce.position.set(focus.x - az.x * 60, focus.y + 14, focus.z - az.z * 60);
      this.bounce.target.position.copy(focus);
      this.bounce.target.updateMatrixWorld();
    }
  }

  _updateFogColor() {
    const cam = this._camera;
    const p = this.params;
    if (cam) {
      cam.getWorldDirection(this._fwd);
      this._v0.set(this._fwd.x, 0, this._fwd.z);
      if (this._v0.lengthSq() < 1e-6) this._v0.set(0, 0, 1);
      this._v0.normalize();
    } else {
      this._v0.set(0, 0, 1);
    }

    // The horizon in the view direction, lifted slightly off zero so we sample
    // the bright band rather than the below-horizon blend.
    const h = skyRadiance(this._v0.x, 0.030, this._v0.z, p, this._rgb);
    this.horizonColor.setRGB(
      clamp(h[0], 0, 6), clamp(h[1], 0, 6), clamp(h[2], 0, 6),
      THREE.LinearSRGBColorSpace
    );

    // Fog is that horizon, a touch desaturated and pulled down so distant
    // geometry lifts into haze without blowing out.
    const l = h[0] * 0.2126 + h[1] * 0.7152 + h[2] * 0.0722;
    const k = 0.70;
    this.fogColor.setRGB(
      clamp(mix(l, h[0], 0.82) * k, 0, 2.2),
      clamp(mix(l, h[1], 0.82) * k, 0, 2.2),
      clamp(mix(l, h[2], 0.82) * k, 0, 2.2),
      THREE.LinearSRGBColorSpace
    );

    if (this.fog) {
      this.fog.color.copy(this.fogColor);
      this.fog.density = p.fogDensity;
    }
    this.ctx.renderer.setClearColor(this.fogColor, 1);
  }

  _regenerateEnv() {
    const { renderer, scene } = this.ctx;
    if (!this._pmrem || !this._pmremScene) return;
    try {
      const prev = this._pmremRT;
      const rt = this._pmrem.fromScene(this._pmremScene, 0.0, 1, 1000, { size: 256 });
      this._pmremRT = rt;
      this.envMap = rt.texture;
      scene.environment = this.envMap;
      scene.environmentIntensity = 0.55;
      if (prev && prev !== rt) prev.dispose();
    } catch (err) {
      console.warn('[sky] PMREM generation failed:', err.message);
    }
    renderer.toneMappingExposure = this.exposure;
  }
}
