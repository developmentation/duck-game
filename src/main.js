import * as THREE from 'three';
import { Engine } from './core/engine.js';
import { Input } from './core/input.js';
import { EventBus, EVENTS } from './core/events.js';
import { settings, autoDetectQuality, WATER_LEVEL } from './core/settings.js';
import { River } from './world/river.js';

/**
 * Boot order matters: later systems read the earlier ones off ctx.
 * Each entry loads lazily so a system that is still being built (or that
 * throws) degrades to "missing" instead of taking the whole river with it.
 */
const MANIFEST = [
  { key: 'sky', path: './world/sky.js', cls: 'Sky', note: 'raising the sun' },
  { key: 'terrain', path: './world/terrain.js', cls: 'Terrain', note: 'shaping the banks' },
  { key: 'water', path: './world/water.js', cls: 'Water', note: 'pouring the river' },
  { key: 'underwater', path: './world/underwater.js', cls: 'Underwater', note: 'flooding the light' },
  { key: 'vegetation', path: './world/vegetation.js', cls: 'Vegetation', note: 'planting reeds' },
  { key: 'fish', path: './entities/fish.js', cls: 'FishSchools', note: 'releasing the fish' },
  { key: 'particles', path: './entities/particles.js', cls: 'Particles', note: 'blowing bubbles' },
  { key: 'wildlife', path: './entities/wildlife.js', cls: 'Wildlife', note: 'waking the dragonflies' },
  { key: 'player', path: './entities/duckPlayer.js', cls: 'DuckPlayer', note: 'hatching a duckling' },
  { key: 'family', path: './entities/family.js', cls: 'Family', note: 'gathering the family' },
  { key: 'camera', path: './entities/cameraRig.js', cls: 'CameraRig', note: 'framing the shot' },
  { key: 'postfx', path: './render/postfx.js', cls: 'PostFX', note: 'grading the image' },
  { key: 'audio', path: './gameplay/audio.js', cls: 'Audio', note: 'tuning the morning' },
  { key: 'quests', path: './gameplay/quests.js', cls: 'Quests', note: 'writing the story' },
  { key: 'minigames', path: './gameplay/minigames.js', cls: 'Minigames', note: 'setting up games' },
  { key: 'hud', path: './gameplay/hud.js', cls: 'HUD', note: 'painting the interface' },
];

class Game {
  constructor() {
    settings.quality = autoDetectQuality();
    const qs = new URLSearchParams(location.search);
    if (qs.has('q')) {
      const tier = qs.get('q');
      import('./core/settings.js').then(({ QUALITY_TIERS }) => {
        if (QUALITY_TIERS[tier]) settings.quality = QUALITY_TIERS[tier];
      });
    }

    this.canvas = document.getElementById('scene');
    this.engine = new Engine(this.canvas);
    this.input = new Input(this.canvas);
    this.events = new EventBus();
    this.river = new River({ seed: 20260730, length: 2000 });

    this.systems = [];
    this.missing = [];
    this.paused = false;
    this.time = { elapsed: 0, dt: 0, frame: 0 };

    /** Shared context handed to every system. */
    this.ctx = {
      THREE,
      engine: this.engine,
      renderer: this.engine.renderer,
      scene: this.engine.scene,
      camera: this.engine.camera,
      composer: this.engine.composer,
      input: this.input,
      events: this.events,
      EVENTS,
      settings,
      river: this.river,
      time: this.time,
      WATER_LEVEL,
      // Filled in as systems boot; a system may be undefined if it failed.
      get sky() { return game.sys.sky; },
      get water() { return game.sys.water; },
      get terrain() { return game.sys.terrain; },
      get player() { return game.sys.player; },
      get(key) { return game.sys[key]; },
    };
    this.sys = Object.create(null);
  }

  async boot() {
    const fill = document.getElementById('boot-fill');
    const note = document.getElementById('boot-note');
    let done = 0;

    for (const entry of MANIFEST) {
      if (note) note.textContent = `${entry.note}…`;
      try {
        const mod = await import(/* @vite-ignore */ entry.path);
        const Cls = mod[entry.cls] || mod.default;
        if (!Cls) throw new Error(`module has no export "${entry.cls}"`);
        const inst = new Cls(this.ctx);
        this.sys[entry.key] = inst;
        this.ctx[entry.key] = inst;
        if (inst.init) await inst.init();
        if (inst.update) this.systems.push(inst);
        if (inst.resize) this.engine.onResize((w, h, dpr) => inst.resize(w, h, dpr));
      } catch (err) {
        this.missing.push(entry.key);
        console.warn(`[boot] system "${entry.key}" unavailable:`, err.message);
      }
      done++;
      if (fill) fill.style.width = `${(done / MANIFEST.length) * 100}%`;
      // Yield so the loader can actually paint between heavy builds.
      await new Promise((r) => requestAnimationFrame(r));
    }

    if (this.missing.length) {
      console.warn(`[boot] ${this.missing.length} system(s) missing: ${this.missing.join(', ')}`);
    }

    // Nothing to look at without a sky — keep a readable background either way.
    if (!this.sys.sky) this.engine.scene.background = new THREE.Color(0x9fd0ee);

    this._bindLifecycle();
    document.body.classList.add('booted');
    const boot = document.getElementById('boot');
    if (boot) {
      boot.classList.add('gone');
      setTimeout(() => boot.remove(), 1200);
    }

    // Expose a small handle for the screenshot harness and for debugging.
    window.__duck = {
      game: this,
      ready: true,
      engine: this.engine,
      river: this.river,
      sys: this.sys,
      missing: this.missing,
      errors: this.errors || [],
      setTime: (v) => { settings.timeOfDay = v; },
      teleport: (s, u = 0) => this.sys.player?.teleportRiver?.(s, u),
      screenshotMode: (on = true) => { this._hideUI = on; document.body.classList.toggle('capture', on); },
    };

    this.engine.clock.start();
    this._loop();
  }

  _bindLifecycle() {
    document.addEventListener('visibilitychange', () => {
      this.paused = document.hidden;
      if (!document.hidden) this.engine.clock.getDelta();
    });
    this.events.on(EVENTS.TOAST, (p) => console.log('[toast]', p.text));
    window.addEventListener('error', (e) => {
      (this.errors ||= []).push(String(e.message));
    });
  }

  _loop = () => {
    requestAnimationFrame(this._loop);
    // Clamp: a long stall must not teleport physics through the world.
    const raw = this.engine.clock.getDelta();
    const dt = Math.min(raw, 1 / 20);
    this.time.dt = dt;
    this.time.elapsed += dt;
    this.time.frame++;
    this.engine.elapsed = this.time.elapsed;

    if (!this.paused) {
      this.input.update();
      for (const s of this.systems) {
        try {
          s.update(dt, this.time.elapsed);
        } catch (err) {
          if (!s.__errored) {
            s.__errored = true;
            console.error('[update] system threw, disabling:', s.constructor.name, err);
            this.systems = this.systems.filter((x) => x !== s);
          }
        }
      }
      this.input.endFrame();
    }

    this.engine.render(dt);
  };
}

const game = new Game();
window.game = game;
game.boot().catch((err) => {
  console.error('[boot] fatal', err);
  const note = document.getElementById('boot-note');
  if (note) note.textContent = `could not start: ${err.message}`;
});
