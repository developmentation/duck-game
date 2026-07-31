/**
 * hud.js — the interface. Everything the game says to the player.
 *
 * Design brief: the HUD is part of the world, not a web page bolted on. Warm
 * paper and ink for anything you are meant to *read* (lessons, the pause
 * panel), a thin luminous line for anything you only glance at (objective,
 * breath, stamina). Nothing is a hard rectangle of black; nothing blocks the
 * river; nothing appears that is not currently useful.
 *
 * What lives here:
 *   * objective line          — what you are doing now, distance + direction
 *   * breath + stamina meters — visible only when they matter
 *   * fish tally
 *   * toasts and lesson cards — EVENTS.TOAST / EVENTS.LESSON
 *   * off-screen family arrow — where your mother went
 *   * minigame banner, start card, end card, and the "swim in to play" offer
 *   * tap-to-swim destination ring
 *   * pause / settings panel on Escape (quality, time of day, volume,
 *     controls, games, restart)
 *   * touch action buttons on touch devices
 *
 * Cost: zero draw calls, zero triangles. All DOM. Per-frame work is a dozen
 * cached property writes; strings are only assigned when they change.
 */

import * as THREE from 'three';
import { settings, QUALITY_TIERS } from '../core/settings.js';
import '../ui/hud-game.css';

const clamp = THREE.MathUtils.clamp;

const CONTROLS = [
  ['W A S D', 'paddle'],
  ['Shift', 'sprint'],
  ['Space', 'dive'],
  ['F', 'flap — a short hop'],
  ['Q', 'quack'],
  ['E', 'dabble in the shallows, preen elsewhere, snap at a fish underwater'],
  ['Tap / click the water', 'swim there'],
  ['Drag', 'look around · wheel zooms'],
  ['G', 'start the game you are floating in'],
  ['Esc', 'pause, settings and this list'],
];

const TEMPLATE = `
<div class="hud-objective" id="hud-obj">
  <div class="ho-eyebrow"><span id="ho-step">1 / 9</span> · Now</div>
  <div class="ho-row">
    <span class="ho-icon" id="ho-icon">🐣</span>
    <span class="ho-title" id="ho-title">…</span>
  </div>
  <div class="ho-meta" id="ho-meta">
    <span class="ho-arrow" id="ho-arrow">↑</span><span id="ho-dist">—</span>
  </div>
  <div class="ho-bar"><i id="ho-fill"></i></div>
</div>

<div class="hud-tally" id="hud-tally" title="fish caught">
  <span class="tally-icon">🐟</span><span id="tally-n">0</span>
</div>

<div class="hud-game" id="hud-game">
  <div class="hg-head"><span id="hg-icon">🐟</span><span id="hg-name">Fish Dash</span></div>
  <div class="hg-score"><span id="hg-score">0</span><small>pts</small></div>
  <div class="hg-label" id="hg-label">—</div>
  <div class="hg-clock"><i id="hg-clockfill"></i></div>
</div>

<div class="hud-meters" id="hud-meters">
  <div class="meter breath" id="m-breath">
    <span class="m-icon">◍</span>
    <div class="m-track"><i id="m-breath-fill"></i></div>
    <span class="m-label">breath</span>
  </div>
  <div class="meter stamina" id="m-stamina">
    <span class="m-icon">≈</span>
    <div class="m-track"><i id="m-stamina-fill"></i></div>
    <span class="m-label">stamina</span>
  </div>
</div>

<div class="hud-prompt" id="hud-prompt"></div>

<div class="hud-toasts" id="hud-toasts"></div>

<div class="hud-lesson" id="hud-lesson">
  <div class="lesson-eyebrow"><span id="lesson-eyebrow">did you know</span></div>
  <div class="lesson-title" id="lesson-title"></div>
  <div class="lesson-body" id="lesson-body"></div>
  <div class="lesson-close">tap to close</div>
</div>

<div class="hud-marker" id="hud-family"><span class="fm-arrow">➤</span><span class="fm-label" id="fm-label">family</span></div>
<div class="hud-dest" id="hud-dest"></div>

<div class="hud-touch" id="hud-touch"></div>

<div class="hud-hint" id="hud-hint">Esc — pause &amp; controls</div>

<div class="hud-pause" id="hud-pause">
  <div class="pause-card">
    <div class="pause-head">
      <div>
        <div class="pause-eyebrow">Duckling</div>
        <div class="pause-title">A river story</div>
      </div>
      <button class="btn ghost" id="p-resume">Resume</button>
    </div>
    <div class="pause-cols">
      <section>
        <h3>Controls</h3>
        <dl class="controls" id="p-controls"></dl>
      </section>
      <section>
        <h3>Games</h3>
        <div class="games" id="p-games"></div>
        <h3>Your journey</h3>
        <div class="journey" id="p-journey"></div>
      </section>
      <section>
        <h3>Settings</h3>
        <label class="field">
          <span>Quality</span>
          <select id="p-quality">
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </label>
        <label class="field">
          <span>Time of day <b id="p-tod-v">morning</b></span>
          <input type="range" id="p-tod" min="0" max="1" step="0.005" />
        </label>
        <label class="field">
          <span>Volume <b id="p-vol-v">70%</b></span>
          <input type="range" id="p-vol" min="0" max="1" step="0.02" />
        </label>
        <div class="pause-actions">
          <button class="btn" id="p-skip">Skip this objective</button>
          <button class="btn" id="p-restart">Restart</button>
          <button class="btn danger" id="p-reset">Reset progress</button>
        </div>
        <p class="note">Quality applies when the river restarts.</p>
      </section>
    </div>
  </div>
</div>
`;

export class HUD {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = null;
    this.paused = false;
    this.volume = 0.7;

    this._offs = [];
    this._toasts = [];
    this._lessonT = 0;
    this._breathVis = 0;
    this._staminaVis = 0;
    this._hintT = 14;
    this._acc = 0;
    this._card = null;      // start / end card element
    this._cardT = 0;

    this._v = new THREE.Vector3();
    this._camFwd = new THREE.Vector3();
    this._els = Object.create(null);
  }

  /* ─────────────────────────────── boot ───────────────────────────────── */

  async init() {
    const host = document.getElementById('ui-root') || document.body;
    const root = document.createElement('div');
    root.id = 'hud';
    root.className = 'hud';
    root.innerHTML = TEMPLATE;
    host.appendChild(root);
    this.root = root;

    const $ = (id) => root.querySelector(`#${id}`);
    this._els = {
      obj: $('hud-obj'), step: $('ho-step'), icon: $('ho-icon'), title: $('ho-title'),
      meta: $('ho-meta'), arrow: $('ho-arrow'), dist: $('ho-dist'), fill: $('ho-fill'),
      tally: $('hud-tally'), tallyN: $('tally-n'),
      game: $('hud-game'), gIcon: $('hg-icon'), gName: $('hg-name'), gScore: $('hg-score'),
      gLabel: $('hg-label'), gClock: $('hg-clockfill'),
      meters: $('hud-meters'), breath: $('m-breath'), breathFill: $('m-breath-fill'),
      stamina: $('m-stamina'), staminaFill: $('m-stamina-fill'),
      prompt: $('hud-prompt'), toasts: $('hud-toasts'),
      lesson: $('hud-lesson'), lEyebrow: $('lesson-eyebrow'), lTitle: $('lesson-title'),
      lBody: $('lesson-body'),
      family: $('hud-family'), famLabel: $('fm-label'), dest: $('hud-dest'),
      touch: $('hud-touch'), hint: $('hud-hint'),
      pause: $('hud-pause'), pControls: $('p-controls'), pGames: $('p-games'),
      pJourney: $('p-journey'), pQuality: $('p-quality'), pTod: $('p-tod'),
      pTodV: $('p-tod-v'), pVol: $('p-vol'), pVolV: $('p-vol-v'),
      pResume: $('p-resume'), pSkip: $('p-skip'), pRestart: $('p-restart'),
      pReset: $('p-reset'),
    };

    this._buildPause();
    this._buildTouch();
    this._bindEvents();

    // The interim controls card from the base shell is now redundant.
    document.getElementById('controls')?.classList.add('hud-superseded');
  }

  _bindEvents() {
    const ctx = this.ctx;
    const E = ctx.EVENTS;
    this._offs.push(ctx.events.on(E.TOAST, (p) => this._toast(p)));
    this._offs.push(ctx.events.on(E.LESSON, (p) => this._lesson(p)));
    this._offs.push(ctx.events.on(E.FISH_CAUGHT, (p) => {
      this._els.tally.classList.remove('pop');
      void this._els.tally.offsetWidth;
      this._els.tally.classList.add('pop');
      const f = p?.fish;
      if (f) {
        this._toast({
          text: `${f.name} · ${Math.round((f.length ?? 0) * 100)} cm`,
          icon: '\u{1F41F}', duration: 2.4,
        });
      }
    }));
    this._offs.push(ctx.events.on(E.GAME_STARTED, (p) => this._gameCard(p, 'start')));
    this._offs.push(ctx.events.on(E.GAME_ENDED, (p) => this._gameCard(p, 'end')));
    this._els.lesson.addEventListener('click', () => this._hideLesson());
  }

  /* ────────────────────────── pause / settings ────────────────────────── */

  _buildPause() {
    const els = this._els;

    els.pControls.innerHTML = CONTROLS
      .map(([k, v]) => `<div class="ctl"><kbd>${k}</kbd><span>${v}</span></div>`)
      .join('');

    const games = this.ctx.get?.('minigames');
    const modes = games?.modes ?? [];
    els.pGames.innerHTML = modes.map((m) => `
      <button class="game-btn" data-key="${m.key}">
        <span class="gb-icon">${m.icon}</span>
        <span class="gb-name">${m.name}</span>
        <span class="gb-best" data-best="${m.key}"></span>
      </button>`).join('') || '<p class="note">Games are still asleep.</p>';
    els.pGames.addEventListener('click', (e) => {
      const btn = e.target.closest('.game-btn');
      if (!btn) return;
      this.setPaused(false);
      this.ctx.get?.('minigames')?.start(btn.dataset.key);
    });

    // settings values
    els.pQuality.value = settings.quality?.name ?? 'high';
    els.pQuality.addEventListener('change', () => {
      const tier = QUALITY_TIERS[els.pQuality.value];
      if (tier) settings.quality = tier;
      this._toast({ text: 'Quality applies when the river restarts', duration: 2.6 });
    });

    els.pTod.value = String(settings.timeOfDay ?? 0.3);
    els.pTod.addEventListener('input', () => {
      const v = parseFloat(els.pTod.value);
      settings.timeOfDay = v;
      this.ctx.sky?.setTimeOfDay?.(v);
      els.pTodV.textContent = todName(v);
    });
    els.pTodV.textContent = todName(settings.timeOfDay ?? 0.3);

    try {
      const v = localStorage.getItem('duckling.volume');
      if (v != null) this.volume = clamp(parseFloat(v), 0, 1);
    } catch { /* ignore */ }
    els.pVol.value = String(this.volume);
    els.pVolV.textContent = `${Math.round(this.volume * 100)}%`;
    els.pVol.addEventListener('input', () => {
      this.volume = parseFloat(els.pVol.value);
      els.pVolV.textContent = `${Math.round(this.volume * 100)}%`;
      this._applyVolume();
    });
    this._applyVolume();

    els.pResume.addEventListener('click', () => this.setPaused(false));
    els.pSkip.addEventListener('click', () => {
      this.ctx.get?.('quests')?.skip();
      this.setPaused(false);
    });
    els.pRestart.addEventListener('click', () => {
      const tier = els.pQuality.value;
      location.href = `${location.pathname}?q=${encodeURIComponent(tier)}`;
    });
    els.pReset.addEventListener('click', () => {
      this.ctx.get?.('quests')?.resetProgress();
      this._refreshJourney();
      this._toast({ text: 'The story starts again', icon: '\u{1F423}', duration: 2.4 });
    });

    // Clicking the dim area closes.
    els.pause.addEventListener('pointerdown', (e) => {
      if (e.target === els.pause) this.setPaused(false);
    });
  }

  _applyVolume() {
    const audio = this.ctx.get?.('audio');
    audio?.setMasterVolume?.(this.volume);
    audio?.setVolume?.(this.volume);
    try { localStorage.setItem('duckling.volume', String(this.volume)); } catch { /* ignore */ }
  }

  _refreshJourney() {
    const q = this.ctx.get?.('quests');
    const games = this.ctx.get?.('minigames');
    const els = this._els;
    if (q?.defs) {
      els.pJourney.innerHTML = q.defs.map((d, i) => {
        const done = q.completed.has(d.key);
        const now = !done && i === q.index;
        return `<div class="jr ${done ? 'done' : ''} ${now ? 'now' : ''}">
          <span class="jr-dot">${done ? '✓' : now ? '•' : ''}</span>
          <span>${d.title}</span></div>`;
      }).join('') + `<div class="jr total">🐟 ${q.fishCaught} fish caught</div>`;
    }
    if (games) {
      for (const m of games.modes) {
        const el = els.pGames.querySelector(`[data-best="${m.key}"]`);
        if (el) el.textContent = games.best[m.key] ? `best ${games.best[m.key]}` : 'unplayed';
      }
    }
  }

  setPaused(on) {
    this.paused = !!on;
    this._els.pause.classList.toggle('show', this.paused);
    this.ctx.get?.('quests')?.suppressInput?.(this.paused);
    if (this.paused) {
      this._refreshJourney();
      this._els.pTod.value = String(settings.timeOfDay ?? 0.3);
      this._els.pTodV.textContent = todName(settings.timeOfDay ?? 0.3);
    }
  }

  /* ─────────────────────────────── touch ──────────────────────────────── */

  _buildTouch() {
    const touch = (navigator.maxTouchPoints || 0) > 0
      || window.matchMedia?.('(hover: none)').matches;
    if (!touch) return;
    const defs = [
      ['dive', 'Dive', true],
      ['interact', 'E', false],
      ['quack', 'Q', false],
      ['flap', 'F', false],
    ];
    const el = this._els.touch;
    el.classList.add('on');
    el.innerHTML = defs
      .map(([a, label]) => `<button class="tbtn" data-a="${a}">${label}</button>`)
      .join('');
    const input = this.ctx.input;
    const set = (a, down) => {
      if (!input) return;
      if (down && !input.keys[a]) input.pressed[a] = true;
      input.keys[a] = down;
    };
    el.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('.tbtn');
      if (!b) return;
      e.preventDefault();
      b.classList.add('down');
      set(b.dataset.a, true);
      const hold = defs.find((d) => d[0] === b.dataset.a)?.[2];
      if (!hold) setTimeout(() => set(b.dataset.a, false), 90);
    });
    const up = (e) => {
      const b = e.target.closest?.('.tbtn');
      if (!b) return;
      b.classList.remove('down');
      set(b.dataset.a, false);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
  }

  /* ──────────────────────── toasts, lessons, cards ────────────────────── */

  _toast(p) {
    if (!p?.text) return;
    const el = document.createElement('div');
    el.className = `toast${p.kind === 'hint' ? ' hint' : ''}`;
    el.innerHTML = `${p.icon ? `<span class="t-icon">${p.icon}</span>` : ''}<span>${escapeHtml(p.text)}</span>`;
    this._els.toasts.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    this._toasts.push({ el, t: p.duration ?? 3 });
    while (this._toasts.length > 3) {
      const old = this._toasts.shift();
      old.el.remove();
    }
  }

  _lesson(p) {
    if (!p?.title) return;
    const els = this._els;
    els.lEyebrow.textContent = p.eyebrow || 'did you know';
    els.lTitle.textContent = p.title;
    els.lBody.textContent = p.body || '';
    els.lesson.classList.add('show');
    this._lessonT = 15;
  }

  _hideLesson() {
    this._els.lesson.classList.remove('show');
    this._lessonT = 0;
  }

  /** Big centred card at the start and the end of a minigame. */
  _gameCard(p, kind) {
    if (!p) return;
    this._card?.remove();
    const el = document.createElement('div');
    el.className = `game-card ${kind}`;
    if (kind === 'start') {
      el.innerHTML = `
        <div class="gc-eyebrow">${p.icon ?? ''} ${escapeHtml(p.name ?? '')}</div>
        <div class="gc-body">${escapeHtml(p.blurb ?? '')}</div>
        <div class="gc-foot">${p.best ? `best ${p.best} pts` : 'first attempt'} · ${Math.round(p.duration ?? 0)}s</div>`;
      this._cardT = 4.2;
    } else {
      el.innerHTML = `
        <div class="gc-eyebrow">${p.icon ?? ''} ${escapeHtml(p.name ?? '')}</div>
        <div class="gc-score">${p.score}<small>pts</small></div>
        <div class="gc-body">${escapeHtml(p.summary ?? '')}</div>
        <div class="gc-foot">${p.isBest ? 'a new best' : `best ${p.best} pts`}</div>`;
      this._cardT = 6;
    }
    this.root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    this._card = el;
  }

  /* ─────────────────────────────── frame ──────────────────────────────── */

  update(dt) {
    const ctx = this.ctx;
    const els = this._els;
    if (!this.root) return;

    /* pause -------------------------------------------------------------- */
    if (ctx.input?.justPressed?.('pause')) this.setPaused(!this.paused);
    if (ctx.input?.justPressed?.('help') && !this.paused) this.setPaused(true);

    /* timers ------------------------------------------------------------- */
    for (let i = this._toasts.length - 1; i >= 0; i--) {
      const t = this._toasts[i];
      t.t -= dt;
      if (t.t <= 0) {
        t.el.classList.remove('show');
        if (t.t < -0.6) { t.el.remove(); this._toasts.splice(i, 1); }
      }
    }
    if (this._lessonT > 0) {
      this._lessonT -= dt;
      if (this._lessonT <= 0) this._hideLesson();
    }
    if (this._card) {
      this._cardT -= dt;
      if (this._cardT <= 0) {
        const c = this._card;
        this._card = null;
        c.classList.remove('show');
        setTimeout(() => c.remove(), 600);
      }
    }
    if (this._hintT > 0) {
      this._hintT -= dt;
      if (this._hintT <= 0) els.hint.classList.add('gone');
    }

    const player = ctx.player || ctx.get?.('player');
    const quests = ctx.get?.('quests');
    const games = ctx.get?.('minigames');

    /* objective ---------------------------------------------------------- */
    if (quests) {
      const q = quests.current;
      const running = games?.isRunning;
      const showObj = !!q && !quests.allDone && !running;
      els.obj.classList.toggle('show', showObj);
      if (showObj) {
        setText(els.step, `${quests.index + 1} / ${quests.total}`);
        setText(els.icon, q.icon);
        setText(els.title, q.objective);
        setWidth(els.fill, q.progress);
        const target = quests.objectiveTarget;
        if (target) {
          els.meta.style.visibility = 'visible';
          setText(els.dist, quests.objectiveLabel);
          this._pointArrow(els.arrow, target);
        } else {
          els.meta.style.visibility = 'hidden';
        }
      }
      setText(els.tallyN, String(quests.fishCaught ?? 0));
      els.tally.classList.toggle('show', (quests.fishCaught ?? 0) > 0 || !!games?.isRunning);
    }

    /* meters ------------------------------------------------------------- */
    if (player) {
      const breath = clamp(player.breath ?? 1, 0, 1);
      if (player.submerged || breath < 0.995) this._breathVis = 2.2;
      else this._breathVis = Math.max(0, this._breathVis - dt);
      els.breath.classList.toggle('show', this._breathVis > 0);
      els.breath.classList.toggle('low', breath < 0.3);
      setWidth(els.breathFill, breath);

      const stam = clamp(player.stamina ?? 1, 0, 1);
      if (stam < 0.995) this._staminaVis = 1.6;
      else this._staminaVis = Math.max(0, this._staminaVis - dt);
      els.stamina.classList.toggle('show', this._staminaVis > 0);
      els.stamina.classList.toggle('low', stam < 0.25);
      setWidth(els.staminaFill, stam);
      els.meters.classList.toggle('show', this._breathVis > 0 || this._staminaVis > 0);
    }

    /* minigame banner ---------------------------------------------------- */
    const active = games?.active;
    els.game.classList.toggle('show', !!active);
    if (active) {
      setText(els.gIcon, active.icon ?? '');
      setText(els.gName, active.name);
      setText(els.gScore, String(active.score));
      setText(els.gLabel, active.lead > 0 ? `starting in ${Math.ceil(active.lead)}` : active.label);
      setWidth(els.gClock, active.duration ? active.timeLeft / active.duration : 0);
      els.game.classList.toggle('danger', !!active.danger);
    }

    /* prompt line -------------------------------------------------------- */
    this._updatePrompt(quests, games);

    /* markers ------------------------------------------------------------ */
    this._updateFamilyMarker(player);
    this._updateDest(quests);
  }

  _updatePrompt(quests, games) {
    const els = this._els;
    let html = '';
    if (games?.offer && !games.isRunning) {
      const m = games.offer;
      const best = games.best[m.key] ? ` · best ${games.best[m.key]}` : '';
      html = `<button class="prompt-card" data-start="${m.key}">
        <span class="pc-icon">${m.icon}</span>
        <span class="pc-text"><b>${m.name}</b><small>${escapeHtml(m.blurb)}</small></span>
        <span class="pc-key">G${best}</span></button>`;
    } else if (quests?.catchPrompt) {
      html = '<div class="prompt-key"><kbd>E</kbd> snap</div>';
    }
    if (html !== els.prompt.__html) {
      els.prompt.__html = html;
      els.prompt.innerHTML = html;
      els.prompt.classList.toggle('show', !!html);
      const b = els.prompt.querySelector('[data-start]');
      if (b) b.addEventListener('click', () => this.ctx.get?.('minigames')?.start(b.dataset.start));
    }
  }

  /** Rotate a chevron so it points at a world position, camera-relative. */
  _pointArrow(el, target) {
    const cam = this.ctx.engine?.camera;
    const player = this.ctx.player || this.ctx.get?.('player');
    if (!cam || !player) return;
    const e = cam.matrixWorld.elements;
    this._camFwd.set(-e[8], 0, -e[10]);
    if (this._camFwd.lengthSq() < 1e-6) return;
    this._camFwd.normalize();
    const dx = target.x - player.position.x;
    const dz = target.z - player.position.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = dx / len;
    const nz = dz / len;
    const dot = nx * this._camFwd.x + nz * this._camFwd.z;
    const cross = this._camFwd.z * nx - this._camFwd.x * nz;
    const deg = Math.atan2(cross, dot) * 57.2957795;
    setRotate(el, deg);
  }

  _updateFamilyMarker(player) {
    const els = this._els;
    const fam = this.ctx.get?.('family');
    const cam = this.ctx.engine?.camera;
    if (!fam?.mother || !cam || !player) { els.family.classList.remove('show'); return; }
    const dist = fam.distanceToPlayer ?? player.position.distanceTo(fam.mother.position);
    this._v.copy(fam.mother.position);
    this._v.y += 0.35;
    this._v.project(cam);
    const behind = this._v.z > 1;
    let x = this._v.x;
    let y = this._v.y;
    if (behind) { x = -x; y = -y; }
    const onScreen = !behind && Math.abs(x) < 0.93 && Math.abs(y) < 0.93;
    const show = !onScreen && dist > 6;
    els.family.classList.toggle('show', show);
    if (!show) return;
    // Clamp the direction to the edge of a slightly inset box.
    const m = Math.max(Math.abs(x), Math.abs(y)) || 1;
    const k = 0.86 / m;
    const px = 50 + x * k * 50;
    const py = 50 - y * k * 50;
    setPos(els.family, px, py);
    setRotate(els.family.firstElementChild, Math.atan2(-y, x) * 57.2957795);
    setText(els.famLabel, `family ${Math.round(dist)} m`);
  }

  _updateDest(quests) {
    const els = this._els;
    const pilot = quests?.pilot;
    const cam = this.ctx.engine?.camera;
    if (!pilot?.active || !cam) { els.dest.classList.remove('show'); return; }
    this._v.copy(pilot.target);
    this._v.project(cam);
    if (this._v.z > 1) { els.dest.classList.remove('show'); return; }
    els.dest.classList.add('show');
    setPos(els.dest, 50 + this._v.x * 50, 50 - this._v.y * 50);
  }

  resize() { /* CSS handles it */ }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    this.root?.remove();
  }
}

/* ───────────────────────────── tiny helpers ─────────────────────────────── */

function setText(el, v) {
  if (!el) return;
  const s = v == null ? '' : String(v);
  if (el.__v !== s) { el.__v = s; el.textContent = s; }
}

function setWidth(el, f) {
  if (!el) return;
  const q = Math.round(clamp(f, 0, 1) * 200) / 2; // 0.5% steps
  if (el.__w !== q) { el.__w = q; el.style.width = `${q}%`; }
}

function setRotate(el, deg) {
  if (!el) return;
  const q = Math.round(deg);
  if (el.__r !== q) { el.__r = q; el.style.transform = `rotate(${q}deg)`; }
}

function setPos(el, xPct, yPct) {
  const x = Math.round(xPct * 10) / 10;
  const y = Math.round(yPct * 10) / 10;
  if (el.__x !== x) { el.__x = x; el.style.left = `${x}%`; }
  if (el.__y !== y) { el.__y = y; el.style.top = `${y}%`; }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function todName(v) {
  const t = ((v % 1) + 1) % 1;
  if (t < 0.22) return 'dawn';
  if (t < 0.34) return 'morning';
  if (t < 0.46) return 'midday';
  if (t < 0.62) return 'afternoon';
  if (t < 0.74) return 'golden hour';
  if (t < 0.84) return 'dusk';
  return 'night';
}
