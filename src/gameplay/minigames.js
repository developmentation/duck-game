/**
 * minigames.js — three short games, startable from a river spot or the pause
 * panel.
 *
 *   fish-dash     sixty seconds, take as many fish as you can
 *   breath-dive   one lungful: get deep and get back up
 *   follow-leader sixty seconds in the hen's wake
 *
 * Each one lives at a pool (`river.pools`). Swim into the pool and the HUD
 * offers it; press G or tap the card to start. Every mode emits
 * `GAME_STARTED { mode, name, blurb, duration }` and
 * `GAME_ENDED { mode, name, score, best, isBest, summary, reason }`, keeps a
 * live `active` block for the HUD, and stores bests in localStorage.
 *
 * Degrades: a mode whose dependency is missing (fish / family) reports
 * `available === false` and is never offered.
 *
 * Published on `ctx.minigames`:
 *   .modes    [{ key, name, icon, blurb, duration, spot, available }]
 *   .active   { key, name, icon, timeLeft, duration, score, label, danger } | null
 *   .best     { key: score }
 *   .offer    mode | null   — a game you are standing in right now
 *   .start(key) / .stop(reason) / .isRunning
 */

import * as THREE from 'three';

const STORE_KEY = 'duckling.bests.v1';
const clamp = THREE.MathUtils.clamp;

export class Minigames {
  constructor(ctx) {
    this.ctx = ctx;

    this.modes = [
      {
        key: 'fish-dash',
        name: 'Fish Dash',
        icon: '\u{1F41F}',
        blurb: 'Sixty seconds. Dive on the shoals and take as many fish as you can — E when one is in reach. Charging only scatters them.',
        duration: 60,
        unit: 'pts',
        needs: 'fish',
      },
      {
        key: 'breath-dive',
        name: 'Breath-hold Dive',
        icon: '\u{1F4A7}',
        blurb: 'One breath. Swim to the deepest water in this pool and come back up before it runs out. Deeper scores more; surfacing with air to spare scores more still.',
        duration: 45,
        unit: 'pts',
        needs: null,
      },
      {
        key: 'follow-leader',
        name: 'Follow the Leader',
        icon: '\u{1F423}',
        blurb: 'Stay in the hen’s wake through the reach below. Close is worth more than far, and falling twenty metres behind ends the run.',
        duration: 60,
        unit: 'pts',
        needs: 'family',
      },
    ];

    this.best = Object.create(null);
    this.active = null;
    this.offer = null;
    this.isRunning = false;

    this._lead = 0;          // countdown before the clock starts
    this._offs = [];
    this._score = 0;
    this._fish = 0;
    this._maxDepth = 0;
    this._wasUnder = false;
    this._surfaceT = 0;
    this._lostT = 0;
    this._closeAcc = 0;
    this._offerCool = 0;
    this._v1 = new THREE.Vector3();
    this._label = '';
  }

  async init() {
    const ctx = this.ctx;
    this._load();
    this._assignSpots();

    this._offs.push(ctx.events.on(ctx.EVENTS.FISH_CAUGHT, (p) => {
      if (!this.isRunning || this.active?.key !== 'fish-dash' || this._lead > 0) return;
      this._fish++;
      const w = p?.fish?.weight ?? 0.05;
      this._score += 10 + Math.round(clamp(w * 60, 0, 22));
    }));

    // G starts whatever is on offer. Input maps no G, so this is not a clash.
    this._onKey = (e) => {
      if (e.code !== 'KeyG' || e.repeat) return;
      if (this.isRunning) return;
      if (this.offer) this.start(this.offer.key);
    };
    window.addEventListener('keydown', this._onKey);
    this._offs.push(() => window.removeEventListener('keydown', this._onKey));
  }

  /* ─────────────────────────── spots & storage ────────────────────────── */

  _assignSpots() {
    const pools = this.ctx.river?.pools ?? [];
    if (!pools.length) {
      for (const m of this.modes) m.spot = null;
      return;
    }
    const byFish = [...pools].sort((a, b) => (b.fishDensity ?? 0) - (a.fishDensity ?? 0));
    const byDeep = [...pools].sort((a, b) => (b.radius ?? 0) - (a.radius ?? 0));
    const pick = (list, used) => list.find((p) => !used.has(p)) ?? list[0];
    const used = new Set();
    const assign = (mode, list) => {
      const p = pick(list, used);
      used.add(p);
      mode.spot = p ? {
        s: p.s,
        radius: Math.max(10, (p.radius ?? 12)),
        position: p.position ? p.position.clone() : this.ctx.river.toWorld(p.s, 0, 0, new THREE.Vector3()),
      } : null;
    };
    assign(this.modes[0], byFish);
    assign(this.modes[1], byDeep);
    // Follow the leader wants a winding reach: the pool furthest downstream.
    assign(this.modes[2], [...pools].sort((a, b) => b.s - a.s));
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) Object.assign(this.best, JSON.parse(raw) || {});
    } catch { /* ignore */ }
  }

  _save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.best)); } catch { /* ignore */ }
  }

  modeAvailable(m) {
    if (!m.needs) return true;
    return !!this.ctx.get?.(m.needs);
  }

  /* ──────────────────────────────── run ───────────────────────────────── */

  start(key) {
    const ctx = this.ctx;
    const mode = this.modes.find((m) => m.key === key);
    if (!mode || this.isRunning) return false;
    if (!this.modeAvailable(mode)) {
      ctx.events.emit(ctx.EVENTS.TOAST, { text: `${mode.name} is not available here`, duration: 2 });
      return false;
    }
    const p = ctx.player || ctx.get?.('player');
    this._score = 0;
    this._fish = 0;
    this._maxDepth = 0;
    this._closeAcc = 0;
    this._lostT = 0;
    this._surfaceT = 0;
    this._wasUnder = !!p?.submerged;
    this._lead = 3.0;
    this._label = '';
    this.active = {
      key: mode.key,
      name: mode.name,
      icon: mode.icon,
      duration: mode.duration,
      timeLeft: mode.duration,
      score: 0,
      label: '',
      danger: false,
      lead: 3,
    };
    this.isRunning = true;
    ctx.events.emit(ctx.EVENTS.GAME_STARTED, {
      mode: mode.key, name: mode.name, icon: mode.icon,
      blurb: mode.blurb, duration: mode.duration, best: this.best[mode.key] ?? 0,
    });
    ctx.events.emit(ctx.EVENTS.SFX, { name: 'chime', volume: 0.5 });
    return true;
  }

  stop(reason = 'ended') {
    if (!this.isRunning || !this.active) return;
    const ctx = this.ctx;
    const key = this.active.key;
    const mode = this.modes.find((m) => m.key === key);
    const score = Math.max(0, Math.round(this._score));
    const prev = this.best[key] ?? 0;
    const isBest = score > prev;
    if (isBest) { this.best[key] = score; this._save(); }
    const summary = this._summary(key, score, reason);
    this.isRunning = false;
    this.active = null;
    this._lead = 0;
    ctx.events.emit(ctx.EVENTS.GAME_ENDED, {
      mode: key, name: mode?.name ?? key, icon: mode?.icon,
      score, best: this.best[key] ?? score, isBest, summary, reason,
    });
    ctx.events.emit(ctx.EVENTS.SFX, { name: isBest ? 'chime' : 'bell', volume: 0.55 });
    this._offerCool = 6; // don't immediately re-offer the same game
  }

  _summary(key, score, reason) {
    if (key === 'fish-dash') {
      return `${this._fish} fish in sixty seconds.`;
    }
    if (key === 'breath-dive') {
      const d = this._maxDepth.toFixed(1);
      return reason === 'out-of-breath'
        ? `You surfaced gasping from ${d} m.`
        : `Down to ${d} m and back on one breath.`;
    }
    if (key === 'follow-leader') {
      return reason === 'lost'
        ? 'You lost the line — the hen went on without you.'
        : `You held the wake for ${Math.round(this._closeAcc)} of sixty seconds.`;
    }
    return `${score} points.`;
  }

  /* ─────────────────────────────── frame ──────────────────────────────── */

  update(dt) {
    const ctx = this.ctx;
    const p = ctx.player || ctx.get?.('player');
    this._offerCool = Math.max(0, this._offerCool - dt);

    if (this.isRunning && this.active) {
      if (this._lead > 0) {
        this._lead -= dt;
        this.active.lead = Math.max(0, this._lead);
      } else {
        this.active.lead = 0;
        this.active.timeLeft = Math.max(0, this.active.timeLeft - dt);
      }
      const run = this._lead <= 0;
      switch (this.active.key) {
        case 'fish-dash': this._tickFish(dt, p, run); break;
        case 'breath-dive': this._tickBreath(dt, p, run); break;
        case 'follow-leader': this._tickLeader(dt, p, run); break;
        default: break;
      }
      this.active.score = Math.max(0, Math.round(this._score));
      this.active.label = this._label;
      if (run && this.active.timeLeft <= 0) this.stop('time');
      this.offer = null;
      return;
    }

    /* what is on offer where I am floating ------------------------------- */
    this.offer = null;
    if (!p || this._offerCool > 0) return;
    const s = p.riverCoord?.s ?? 0;
    for (const m of this.modes) {
      if (!m.spot || !this.modeAvailable(m)) continue;
      if (Math.abs(s - m.spot.s) < m.spot.radius + 8) { this.offer = m; break; }
    }
  }

  _tickFish(dt, p, run) {
    if (!run) { this._label = 'Get ready…'; return; }
    this._label = `${this._fish} fish`;
    const fish = this.ctx.get?.('fish');
    this.active.danger = this.active.timeLeft < 10;
    if (!fish) this._label = 'no fish here';
  }

  _tickBreath(dt, p, run) {
    if (!p) { this.stop('no-player'); return; }
    if (!run) { this._label = 'Fill your lungs…'; return; }
    const depth = p.depthBelow ?? 0;
    if (p.submerged) {
      this._wasUnder = true;
      this._surfaceT = 0;
      this._maxDepth = Math.max(this._maxDepth, depth);
      this._score = this._maxDepth * 22 + (this._maxDepth > 2 ? 20 : 0);
      this._label = `${depth.toFixed(1)} m · deepest ${this._maxDepth.toFixed(1)} m`;
      this.active.danger = (p.breath ?? 1) < 0.28;
      if ((p.breath ?? 1) <= 0.001) {
        this._score *= 0.55;
        this.stop('out-of-breath');
      }
    } else {
      this._label = this._wasUnder ? 'Surfacing…' : 'Dive! Space to go under';
      if (this._wasUnder) {
        this._surfaceT += dt;
        if (this._surfaceT > 0.7) {
          this._score += 25 + (p.breath ?? 0) * 40; // came back with air to spare
          this.stop('surfaced');
        }
      }
    }
  }

  _tickLeader(dt, p, run) {
    const fam = this.ctx.get?.('family');
    if (!p || !fam?.mother) { this.stop('no-family'); return; }
    const d = fam.distanceToPlayer ?? p.position.distanceTo(fam.mother.position);
    if (!run) { this._label = `Get in her wake — ${Math.round(d)} m`; return; }
    const close = clamp(1 - (d - 3) / 13, 0, 1); // 3 m = perfect, 16 m = nothing
    this._score += close * 6 * dt;
    if (close > 0.35) this._closeAcc += dt;
    this._label = `${Math.round(d)} m behind`;
    this.active.danger = d > 14;
    if (d > 20) {
      this._lostT += dt;
      if (this._lostT > 2.5) this.stop('lost');
    } else {
      this._lostT = Math.max(0, this._lostT - dt);
    }
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
  }
}
