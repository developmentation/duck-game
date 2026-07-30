import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { settings } from './settings.js';

/**
 * Owns the renderer, the scene graph root, the camera and the post chain.
 * Nothing in here knows about ducks — it is pure plumbing, plus an adaptive
 * resolution loop that protects the frame rate on weaker machines.
 */
export class Engine {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // handled in the post chain (SMAA/FXAA)
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      logarithmicDepthBuffer: false,
    });
    this.renderer.setClearColor(0x8fc4e8, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = settings.quality.softShadows
      ? THREE.VSMShadowMap
      : THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = true;

    this.maxAnisotropy = Math.min(
      settings.quality.anisotropy,
      this.renderer.capabilities.getMaxAnisotropy()
    );

    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = true;

    this.camera = new THREE.PerspectiveCamera(
      settings.fov, 1, settings.near, settings.far
    );
    this.camera.position.set(0, 3, -8);

    this.composer = new EffectComposer(this.renderer, this._makeTarget());
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    // postfx.js appends the rest of the chain and always finishes with an
    // output/tonemap pass.

    this.clock = new THREE.Clock();
    this.elapsed = 0;
    this.frame = 0;

    this._dpr = Math.min(window.devicePixelRatio || 1, settings.quality.dprCap);
    this._targetDpr = this._dpr;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this.fps = 60;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
    this.resize();
  }

  _makeTarget() {
    const t = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 0,
      depthBuffer: true,
      stencilBuffer: false,
    });
    t.texture.colorSpace = THREE.LinearSRGBColorSpace;
    return t;
  }

  get width() { return this._w; }
  get height() { return this._h; }
  get aspect() { return this._w / Math.max(1, this._h); }

  resize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this._w = w;
    this._h = h;
    this.renderer.setPixelRatio(this._dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this._dpr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const fn of this._resizeHooks || []) fn(w, h, this._dpr);
  }

  onResize(fn) {
    (this._resizeHooks ||= []).push(fn);
    return () => {
      this._resizeHooks = this._resizeHooks.filter((f) => f !== fn);
    };
  }

  /** Nudge render scale to hold ~55fps. Cheap insurance, invisible when idle. */
  _adaptResolution(dt) {
    this._fpsAccum += dt;
    this._fpsFrames++;
    if (this._fpsAccum < 1.0) return;
    this.fps = this._fpsFrames / this._fpsAccum;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    const cap = settings.quality.dprCap;
    const before = this._dpr;
    if (this.fps < 45) this._dpr = Math.max(0.62, this._dpr - 0.12);
    else if (this.fps > 58 && this._dpr < cap) this._dpr = Math.min(cap, this._dpr + 0.06);
    if (Math.abs(this._dpr - before) > 0.001) this.resize();
  }

  render(dt) {
    this.frame++;
    this._adaptResolution(dt);
    this.composer.render(dt);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    this.renderer.dispose();
  }
}
