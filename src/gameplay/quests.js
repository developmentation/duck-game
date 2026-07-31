/**
 * quests.js — the story spine and the play verbs.
 *
 * Two jobs:
 *
 *  1. **A chain of gentle objectives.** Nine of them, in the order a duckling
 *     would actually learn things: stay near the hen, find your voice, let the
 *     river carry you, dabble, dive, catch a fish, find the lily pool, preen,
 *     lead the brood home. There is always exactly one "now", it always has a
 *     direction and a distance, and finishing one shows a card with a fact
 *     about real ducks or real rivers. Progress is kept in localStorage.
 *
 *  2. **The verbs the play layer owns.** Two things the world systems do not
 *     do for themselves:
 *       * `E` underwater = *snap at a fish*. `duckPlayer._interact()` returns
 *         early while submerged, so the key is free there, and `fish.tryCatch`
 *         is documented as "the whole catching contract" for this system.
 *       * *tap / click a destination* = swim there. The player reads
 *         `ctx.input.move`, which `Input.update()` rewrites from the keyboard
 *         at the top of every frame, so the only honest place to inject an
 *         autopilot is a wrapper around `Input.update` installed at boot. It
 *         yields instantly to any key, and dive/flap cancel it.
 *
 * Nothing here allocates per frame: the scratch vectors are instance fields
 * and the quest table is built once.
 *
 * Published on `ctx.quests`:
 *   .current            { key, title, objective, hint, icon, progress, index }
 *   .objectiveTarget    Vector3 | null   — what the HUD arrow points at
 *   .objectiveLabel     string           — "24 m" style suffix, may be ''
 *   .completed (Set) / .total / .allDone
 *   .fishCaught         lifetime tally (persisted)
 *   .catchPrompt        bool — a fish is in reach right now
 *   .pilot              { active, target: Vector3 }
 *   .suppressInput(b)   HUD calls this while the pause panel is open
 *   .resetProgress()    wipe and start again
 *   .skip()             "I'm stuck" from the pause panel
 */

import * as THREE from 'three';

const STORE_KEY = 'duckling.progress.v2';
const clamp = THREE.MathUtils.clamp;

/* ─────────────────────────────── the chain ──────────────────────────────── */
/*
 * Each entry:
 *   objective  the imperative shown in the HUD ("now")
 *   hint       one line of teaching, toasted when the quest opens
 *   lesson     shown on completion; must be TRUE
 *   target(q)  world position to point at, or null
 *   tick(q,dt) sets q.progress 0..1; 1 completes
 */
function buildQuests(sys) {
  const { ctx } = sys;
  const river = ctx.river;

  const player = () => ctx.player || ctx.get?.('player');
  const family = () => ctx.family || ctx.get?.('family');

  return [
    {
      key: 'stay-close',
      icon: '\u{1F423}',
      title: 'Stay close to mother',
      objective: 'Paddle over to the hen',
      hint: 'W A S D to paddle, Shift to sprint. Keep the hen in sight.',
      lesson: {
        title: 'Imprinting',
        body: 'A duckling fixes on the first moving thing it sees in its first day and follows it everywhere after. Usually that is its mother. Occasionally it is a scientist in wellingtons.',
      },
      target() {
        const f = family();
        return f?.mother?.position ?? null;
      },
      tick(q, dt) {
        const f = family();
        const p = player();
        if (!f?.mother || !p) { q.progress = Math.min(0.99, q.progress + dt * 0.05); return; }
        const d = f.distanceToPlayer ?? p.position.distanceTo(f.mother.position);
        if (d < 11) q.t += dt; else q.t = Math.max(0, q.t - dt * 0.6);
        q.progress = clamp(q.t / 2.0, 0, 1);
      },
    },
    {
      key: 'hello',
      icon: '\u{1F4E3}',
      title: 'Say hello',
      objective: 'Press Q to quack',
      hint: 'Q calls out. The brood answers if they hear you.',
      lesson: {
        title: 'Who quacks?',
        body: 'Only the female mallard makes the loud quack everyone knows. The drake manages nothing louder than a hoarse rasp, so the voice of a duck pond is entirely the mothers.',
      },
      target() { return null; },
      tick(q, dt) {
        if (sys._quacks > 0) q.progress = 1;
        else q.progress = Math.min(q.progress + dt * 0.02, 0.35);
      },
    },
    {
      key: 'downstream',
      icon: '\u{1F30A}',
      title: 'Let the river carry you',
      objective: 'Follow the river downstream',
      hint: 'The current runs fastest down the middle. Steer with A and D and let it push.',
      lesson: {
        title: 'Why the middle is quickest',
        body: 'Water drags on the bed and the banks, so a river runs fastest just under the surface in the deepest part of the channel. Ducklings that stay mid-stream travel for free.',
      },
      begin(q) { q.s0 = player()?.riverCoord?.s ?? null; },
      target(q) {
        if (!river) return null;
        const s = clamp((q.s0 ?? 0) + 80, 0, river.length - 6);
        return river.toWorld(s, 0, 0.05, sys._tv);
      },
      tick(q) {
        const p = player();
        if (!p) return;
        if (q.s0 == null) q.s0 = p.riverCoord.s;
        q.progress = clamp((p.riverCoord.s - q.s0) / 75, 0, 1);
      },
    },
    {
      key: 'dabble',
      icon: '\u{1F343}',
      title: 'Dabble for weed',
      objective: 'Press E in the shallows',
      hint: 'Find water shallow enough to reach the bottom — near a bank — and press E.',
      lesson: {
        title: 'Tail up',
        body: 'Mallards are dabbling ducks: they up-end in the shallows and strain weed and snails off the bottom instead of diving for them. A dabbler feeds down to about half a metre — the length of its own neck.',
      },
      target(q) { return sys._shallowTarget(q); },
      tick(q, dt) {
        if (sys._dabbles > 0) q.progress = 1;
        else q.progress = Math.min(q.progress + dt * 0.02, 0.3);
      },
    },
    {
      key: 'dive',
      icon: '\u{1F4A7}',
      title: 'Take a breath and dive',
      objective: 'Hold Space to swim under',
      hint: 'Space pushes you under. Watch the breath meter — surface before it empties.',
      lesson: {
        title: 'One lungful',
        body: 'A mallard can hold its breath for roughly fifteen seconds and usually bothers for about five. The long-tailed duck, a proper diver, reaches sixty metres down and stays under for a minute.',
      },
      target() { return null; },
      tick(q) {
        const p = player();
        if (!p) return;
        q.progress = Math.max(q.progress, clamp(p.depthBelow / 1.15, 0, 1));
      },
    },
    {
      key: 'first-fish',
      icon: '\u{1F41F}',
      title: 'Catch your first fish',
      objective: 'Dive, drift close, press E',
      hint: 'Underwater, E snaps at a fish. Charging scatters the shoal — drift in slowly.',
      lesson: {
        title: 'A thousand eyes',
        body: 'Minnows shoal in their hundreds because a thousand eyes see a pike sooner than two, and a boiling ball of silver is very hard to aim at. Ducklings take the stragglers.',
      },
      begin() { sys._questFish = 0; },
      target() {
        const n = sys._nearFish;
        return n ? sys._tv.copy(n.position) : null;
      },
      tick(q) {
        q.progress = clamp(sys._questFish, 0, 1);
      },
    },
    {
      key: 'lily-pool',
      icon: '\u{1F4A0}',
      title: 'Find the lily pool',
      objective: 'Swim down to the still pool',
      hint: 'The river widens and slows ahead. Tap the water to set a course.',
      lesson: {
        title: 'Lilies breathe',
        body: 'A water lily leaf is plumbed: air travels down hollow stalks from the pads to roots buried in airless mud. The pads are also a nursery roof — everything small hides under them.',
      },
      target() {
        const pool = sys._poolFor('lily');
        if (!pool) return null;
        return pool.position ? sys._tv.copy(pool.position) : river?.toWorld(pool.s, 0, 0.05, sys._tv);
      },
      tick(q) {
        const pool = sys._poolFor('lily');
        const p = player();
        if (!pool || !p) return;
        const d = Math.abs(p.riverCoord.s - pool.s);
        if (q.d0 == null) q.d0 = Math.max(d, 40);
        q.progress = clamp(1 - (d - pool.radius * 0.8) / Math.max(1, q.d0), 0, 1);
        if (d < pool.radius * 0.9) q.progress = 1;
      },
    },
    {
      key: 'preen',
      icon: '\u{1FAB6}',
      title: 'Preen your feathers dry',
      objective: 'Press E in deep water',
      hint: 'Away from the shallows, E preens. Oil the feathers and the water rolls off.',
      lesson: {
        title: 'Why a duck stays dry',
        body: 'A duck combs oil from a gland at the base of its tail through every feather. The barbs zip together into a waterproof sheet, so the down underneath never gets wet — which is also how it stays warm.',
      },
      target() { return null; },
      tick(q, dt) {
        if (sys._preens > 0) q.progress = 1;
        else q.progress = Math.min(q.progress + dt * 0.02, 0.3);
      },
    },
    {
      key: 'lead-home',
      icon: '\u{1F3E1}',
      title: 'Lead the ducklings home',
      objective: 'Take the brood down the last reach',
      hint: 'Swim ahead and they string out behind you. Q keeps the stragglers coming.',
      lesson: {
        title: 'The long walk',
        body: 'A mallard brood may travel a kilometre on its first day, the ducklings following in the hen’s wake because water she has already pushed aside is easier going. The runt at the back works hardest.',
      },
      begin(q) { q.s0 = player()?.riverCoord?.s ?? null; },
      target() {
        if (!river) return null;
        return river.toWorld(river.length - 45, 0, 0.05, sys._tv);
      },
      tick(q) {
        const p = player();
        if (!p || !river) return;
        if (q.s0 == null) q.s0 = p.riverCoord.s;
        const end = river.length - 60;
        q.progress = clamp((p.riverCoord.s - q.s0) / Math.max(60, end - q.s0), 0, 1);
      },
    },
  ];
}

/* ──────────────────────────────── system ────────────────────────────────── */

export class Quests {
  constructor(ctx) {
    this.ctx = ctx;

    this.defs = [];
    this.index = 0;
    this.completed = new Set();
    this.current = null;
    this.objectiveTarget = null;
    this.objectiveLabel = '';
    this.allDone = false;
    this.fishCaught = 0;
    this.catchPrompt = false;
    this.total = 0;

    this.pilot = { active: false, target: new THREE.Vector3(), age: 0 };

    // verb counters, consumed by the quest ticks each frame
    this._quacks = 0;
    this._dabbles = 0;
    this._preens = 0;
    this._questFish = 0;
    this._nearFish = null;

    this._inputSuppressed = false;
    this._offs = [];
    this._openDelay = 0;
    this._scanAcc = 0;
    this._catchCool = 0;
    this._shallowT = -1;

    // scratch — no per-frame allocation
    this._tv = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._camFwd = new THREE.Vector3(0, 0, 1);
    this._camRight = new THREE.Vector3(1, 0, 0);
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._shallow = new THREE.Vector3();
    this._coord = { s: 0, u: 0, distance: 0 };
    this._pointer = { id: -1, x: 0, y: 0, t: 0, moved: 0 };
  }

  async init() {
    const ctx = this.ctx;
    this.defs = buildQuests(this);
    this.total = this.defs.length;
    for (const d of this.defs) { d.progress = 0; d.t = 0; d.s0 = null; d.d0 = null; }

    this._load();
    this._pickPools();

    const E = ctx.EVENTS;
    this._offs.push(ctx.events.on(E.QUACK, () => { this._quacks++; }));
    this._offs.push(ctx.events.on(E.FISH_CAUGHT, () => {
      this.fishCaught++;
      this._questFish++;
      this._save();
    }));

    this._bindPointer();
    this._wrapInput();
    // The HUD boots after us, so opening the first objective right here would
    // fire its hint into an empty room. Let the first frame do it.
    this._openDelay = 0.5;
  }

  /* ───────────────────────────── persistence ──────────────────────────── */

  _load() {
    let raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch { /* private mode */ }
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      this.fishCaught = data.fish | 0;
      for (const k of data.done || []) this.completed.add(k);
      const i = this.defs.findIndex((d) => !this.completed.has(d.key));
      this.index = i < 0 ? this.defs.length : i;
      this.allDone = this.index >= this.defs.length;
    } catch { /* corrupt: start fresh */ }
  }

  _save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        done: [...this.completed], fish: this.fishCaught, v: 2,
      }));
    } catch { /* ignore */ }
  }

  resetProgress() {
    this.completed.clear();
    this.fishCaught = 0;
    this.index = 0;
    this.allDone = false;
    this._openDelay = 0;
    for (const d of this.defs) { d.progress = 0; d.t = 0; d.s0 = null; d.d0 = null; }
    this._save();
    this._openCurrent();
  }

  /** Give up on the current step (pause panel). Still shows the lesson. */
  skip() {
    if (this.allDone || this._openDelay > 0) return;
    this._complete(this.defs[this.index], true);
  }

  /* ─────────────────────────── quest machinery ────────────────────────── */

  _openCurrent() {
    if (this.index >= this.defs.length) {
      this.allDone = true;
      this.current = null;
      this.objectiveTarget = null;
      this.ctx.events.emit(this.ctx.EVENTS.TOAST, {
        text: 'The whole river is yours now — the games are waiting in the pools.',
        icon: '\u{2728}', duration: 6,
      });
      return;
    }
    const q = this.defs[this.index];
    q.progress = 0;
    q.t = 0;
    q.begin?.(q);
    this.current = q;
    const ctx = this.ctx;
    ctx.events.emit(ctx.EVENTS.QUEST_STARTED, { quest: this._describe(q) });
    ctx.events.emit(ctx.EVENTS.TOAST, {
      text: q.hint, icon: q.icon, duration: 5.5, kind: 'hint',
    });
  }

  _describe(q) {
    return {
      key: q.key, title: q.title, objective: q.objective, icon: q.icon,
      hint: q.hint, progress: q.progress, index: this.defs.indexOf(q),
      total: this.defs.length,
    };
  }

  _complete(q, skipped = false) {
    const ctx = this.ctx;
    q.progress = 1;
    this.completed.add(q.key);
    this.index = Math.min(this.defs.length, this.index + 1);
    this._save();
    ctx.events.emit(ctx.EVENTS.QUEST_COMPLETED, {
      quest: this._describe(q), reward: q.lesson, skipped,
    });
    ctx.events.emit(ctx.EVENTS.LESSON, {
      title: q.lesson.title, body: q.lesson.body, eyebrow: skipped ? 'Skipped' : q.title,
    });
    ctx.events.emit(ctx.EVENTS.SFX, { name: 'chime', volume: 0.6 });
    // A beat of quiet before the next objective lands.
    this._openDelay = 1.2;
  }

  /* ───────────────────────────── the verbs ────────────────────────────── */

  /**
   * E while submerged: snap at whatever is in front of the bill.
   * duckPlayer._interact() bails out when submerged, so the key is genuinely
   * free underwater and nothing double-fires.
   */
  _tryCatch() {
    const ctx = this.ctx;
    const p = ctx.player || ctx.get?.('player');
    const fish = ctx.get?.('fish');
    if (!p) return;
    this._catchCool = 0.4;
    const pos = p.billPosition ? p.billPosition(this._v1) : this._v1.copy(p.position);
    const got = fish?.tryCatch?.(pos, 0.55) ?? null;
    if (got) return; // fish.js emits FISH_CAUGHT, SFX and bubbles for us
    ctx.events.emit(ctx.EVENTS.SFX, { name: 'snap', volume: 0.35 });
    if (this._nearFish && this._nearFish.distance < 1.6) {
      ctx.events.emit(ctx.EVENTS.TOAST, {
        text: 'It slipped away', icon: '\u{1F4A6}', duration: 1.3,
      });
    }
  }

  /** Nearest fish, refreshed a few times a second (not every frame). */
  _scanFish(dt) {
    const ctx = this.ctx;
    const p = ctx.player || ctx.get?.('player');
    const fish = ctx.get?.('fish');
    this._scanAcc += dt;
    if (this._scanAcc < 0.16) return;
    this._scanAcc = 0;
    if (!p || !fish?.nearest || !p.submerged) {
      this._nearFish = null;
      this.catchPrompt = false;
      return;
    }
    const pos = p.billPosition ? p.billPosition(this._v1) : this._v1.copy(p.position);
    this._nearFish = fish.nearest(pos, 3.2);
    this.catchPrompt = !!this._nearFish && this._nearFish.distance < 1.1;
  }

  /** A point near the player where the water is dabbling depth (0.35–1.1 m). */
  _shallowTarget() {
    const river = this.ctx.river;
    const p = this.ctx.player || this.ctx.get?.('player');
    if (!river || !p) return null;
    if (this._shallowT > 0) return this._shallow;
    const s = p.riverCoord.s;
    let best = null;
    let bestErr = 1e9;
    for (let k = 0; k < 22; k++) {
      const ds = (k % 11) * 9 - 45;
      const side = k < 11 ? 1 : -1;
      const ss = clamp(s + ds, 6, river.length - 6);
      for (let j = 0; j < 5; j++) {
        const u = side * (0.55 + j * 0.09);
        const d = river.depth(ss, u);
        const err = Math.abs(d - 0.7);
        if (d > 0.32 && d < 1.15 && err < bestErr) { bestErr = err; best = { ss, u }; }
      }
    }
    if (!best) return null;
    river.toWorld(best.ss, best.u, 0.05, this._shallow);
    this._shallowT = 2.5; // hold the marker still for a couple of seconds
    return this._shallow;
  }

  _pickPools() {
    const pools = this.ctx.river?.pools;
    this._pools = { lily: null };
    if (!pools?.length) return;
    let best = null;
    for (const p of pools) {
      if (p.s < 260 || p.s > 1500) continue;
      if (!best || p.radius > best.radius) best = p;
    }
    this._pools.lily = best || pools[Math.min(2, pools.length - 1)];
  }

  _poolFor(key) { return this._pools?.[key] ?? null; }

  /* ────────────────────────── tap-to-swim pilot ───────────────────────── */

  _bindPointer() {
    const dom = this.ctx.renderer?.domElement || document.getElementById('scene');
    if (!dom) return;
    const down = (e) => {
      this._pointer.id = e.pointerId;
      this._pointer.x = e.clientX;
      this._pointer.y = e.clientY;
      this._pointer.t = performance.now();
      this._pointer.moved = 0;
    };
    const move = (e) => {
      if (e.pointerId !== this._pointer.id) return;
      this._pointer.moved = Math.max(this._pointer.moved,
        Math.hypot(e.clientX - this._pointer.x, e.clientY - this._pointer.y));
    };
    const up = (e) => {
      if (e.pointerId !== this._pointer.id) return;
      this._pointer.id = -1;
      if (this._inputSuppressed) return;
      const held = performance.now() - this._pointer.t;
      if (held > 420 || this._pointer.moved > 10) return; // that was a look-drag
      this._setCourse(e.clientX, e.clientY, dom);
    };
    const cancel = () => { this._pointer.id = -1; };
    dom.addEventListener('pointerdown', down);
    dom.addEventListener('pointermove', move);
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', cancel);
    this._offs.push(() => {
      dom.removeEventListener('pointerdown', down);
      dom.removeEventListener('pointermove', move);
      dom.removeEventListener('pointerup', up);
      dom.removeEventListener('pointercancel', cancel);
    });
  }

  _setCourse(clientX, clientY, dom) {
    const ctx = this.ctx;
    const cam = ctx.engine?.camera;
    const river = ctx.river;
    if (!cam || !river) return;
    const r = dom.getBoundingClientRect();
    this._ndc.set(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
    this._ray.setFromCamera(this._ndc, cam);
    this._plane.constant = -(ctx.WATER_LEVEL ?? 0);
    const hit = this._ray.ray.intersectPlane(this._plane, this._v2);
    if (!hit) return;
    // Keep the course inside the channel — a tap must never beach the duck.
    river.toRiver(hit, this._coord);
    const u = clamp(this._coord.u, -0.92, 0.92);
    const s = clamp(this._coord.s, 4, river.length - 6);
    river.toWorld(s, u, ctx.WATER_LEVEL ?? 0, this.pilot.target);
    this.pilot.active = true;
    this.pilot.age = 0;
    ctx.events.emit(ctx.EVENTS.SFX, { name: 'tap', volume: 0.25 });
  }

  /**
   * Wrap Input.update so the autopilot can write `move` *after* the keyboard
   * has been folded in and *before* the player reads it. Yields to any key.
   */
  _wrapInput() {
    const input = this.ctx.input;
    if (!input || input.__pilotWrapped) return;
    const orig = input.update.bind(input);
    input.update = () => {
      orig();
      try {
        this._drive(input);
      } catch (err) {
        if (!this._driveErr) { this._driveErr = true; console.warn('[quests] pilot', err); }
      }
    };
    input.__pilotWrapped = true;
    this._offs.push(() => { input.update = orig; input.__pilotWrapped = false; });
  }

  _drive(input) {
    if (this._inputSuppressed) {
      input.move.set(0, 0);
      this.pilot.active = false;
      return;
    }
    if (!this.pilot.active) return;
    const p = this.ctx.player || this.ctx.get?.('player');
    const cam = this.ctx.engine?.camera;
    if (!p || !cam) { this.pilot.active = false; return; }
    // Any real input takes the wheel back.
    if (input.move.lengthSq() > 0.02 || input.isDown('dive') || input.isDown('flap')) {
      this.pilot.active = false;
      return;
    }
    const dx = this.pilot.target.x - p.position.x;
    const dz = this.pilot.target.z - p.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1.3 || this.pilot.age > 45) { this.pilot.active = false; return; }
    const e = cam.matrixWorld.elements;
    this._camFwd.set(-e[8], 0, -e[10]);
    if (this._camFwd.lengthSq() < 1e-6) this._camFwd.set(0, 0, 1);
    this._camFwd.normalize();
    this._camRight.set(-this._camFwd.z, 0, this._camFwd.x);
    const nx = dx / dist;
    const nz = dz / dist;
    const throttle = clamp(dist / 3.5, 0.45, 1);
    input.move.set(
      (nx * this._camRight.x + nz * this._camRight.z) * throttle,
      (nx * this._camFwd.x + nz * this._camFwd.z) * throttle,
    );
  }

  suppressInput(on) { this._inputSuppressed = !!on; }

  /* ──────────────────────────────── frame ─────────────────────────────── */

  update(dt) {
    const ctx = this.ctx;
    const input = ctx.input;
    const p = ctx.player || ctx.get?.('player');
    if (this._shallowT > 0) this._shallowT -= dt;
    this.pilot.age += dt;
    this._catchCool = Math.max(0, this._catchCool - dt);

    /* verbs -------------------------------------------------------------- */
    if (input?.justPressed?.('interact') && p && !this._inputSuppressed) {
      if (p.submerged) {
        if (this._catchCool <= 0) this._tryCatch();
      } else {
        // Mirror duckPlayer's context split so the quests know which verb ran.
        const river = ctx.river;
        const d = ctx.water?.signedDepthAt
          ? ctx.water.signedDepthAt(p.position.x, p.position.z)
          : (river ? river.depth(p.riverCoord.s, p.riverCoord.u) : 0);
        if (d > 0.34 && d < 1.16) this._dabbles++; else this._preens++;
      }
    }
    this._scanFish(dt);

    /* the chain ---------------------------------------------------------- */
    if (this._openDelay > 0) {
      this._openDelay -= dt;
      if (this._openDelay <= 0) this._openCurrent();
    } else if (!this.allDone) {
      const q = this.defs[this.index];
      if (q) {
        const before = q.progress;
        try { q.tick(q, dt); } catch { /* a missing system, not fatal */ }
        q.progress = clamp(q.progress, 0, 1);
        this.current = q;
        // Progress events, throttled to quarter steps.
        const step = Math.floor(q.progress * 4);
        if (step > Math.floor(before * 4) && q.progress < 1) {
          ctx.events.emit(ctx.EVENTS.QUEST_PROGRESS, {
            quest: this._describe(q), step, total: 4,
          });
        }
        // Stuck? Say the hint again rather than leave them guessing.
        if (q.progress > before + 0.002) this._idle = 0;
        else this._idle = (this._idle || 0) + dt;
        if (this._idle > 34 && q.progress < 1) {
          this._idle = 0;
          ctx.events.emit(ctx.EVENTS.TOAST, {
            text: q.hint, icon: q.icon, duration: 5, kind: 'hint',
          });
        }
        if (q.progress >= 1) this._complete(q);
      }
    }

    /* objective marker --------------------------------------------------- */
    this.objectiveTarget = null;
    this.objectiveLabel = '';
    const q = this.allDone ? null : this.defs[this.index];
    if (q && this._openDelay <= 0) {
      let t = null;
      try { t = q.target?.(q); } catch { t = null; }
      if (t && p) {
        if (t !== this._tv) this._tv.copy(t);
        this.objectiveTarget = this._tv;
        const d = Math.hypot(this._tv.x - p.position.x, this._tv.z - p.position.z);
        this.objectiveLabel = d > 2000 ? '' : `${d < 10 ? d.toFixed(1) : Math.round(d)} m`;
      }
    }

    // Counters are single-use signals; drain them so they cannot double-fire.
    this._quacks = 0;
    this._dabbles = 0;
    this._preens = 0;
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
  }
}
