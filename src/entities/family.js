/**
 * family.js — the duck family: a mother and her brood moving down the river.
 *
 * The premise of the game is that you are one duckling in a family that is
 * going somewhere. So this system has two jobs:
 *
 *   1. Make a *line of ducklings behind a mother* read as a family and not as
 *      a formation. Real duckling lines follow the leader's **wake**, not each
 *      other's positions — so the model here is a path/trail follower with a
 *      per-duckling slot distance, plus personality on top: the runt lags and
 *      sprints, the bold one veers off after something and hurries back, they
 *      jostle for the slot right behind mum.
 *   2. Give the player somewhere to be. The mother routes downstream along the
 *      deep channel, avoids shallows and boulders, pauses in pools to dabble
 *      and preen, calls stragglers, and calls *you* if you fall behind. And if
 *      you swim out in front, the bold ducklings will follow **you** instead.
 *
 * Everything is allocation-free after init(): scratch vectors are instance
 * fields, the trails are ring buffers over Float32Arrays.
 *
 * Draw calls: one per duck body (skinned, shared geometry + cloned material)
 * plus one per duckling down-shell above the `low` tier.
 */

import * as THREE from 'three';
import { createDuck } from './duck.js';
import { Noise, makeRandom } from '../core/noise.js';
import { settings, WATER_LEVEL } from '../core/settings.js';

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const smoothstep = THREE.MathUtils.smoothstep;

/** Metres of travel between trail samples. 0.12 * 256 ≈ 30m of history. */
const TRAIL_STEP = 0.12;
const TRAIL_CAP = 256;

/** How far the player may drift before the family is quietly re-seeded near them. */
const REGROUP_DISTANCE = 72;
/** Stray thresholds, metres. */
const STRAY_NEAR = 20;
const STRAY_FAR = 44;
const REUNITE = 8;

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/* ------------------------------------------------------------------ trail */

/**
 * A ring buffer of positions with cumulative arc length, sampled by "how many
 * metres back along the path". This is the wake a duckling swims in.
 */
class Trail {
  constructor(cap = TRAIL_CAP) {
    this.cap = cap;
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.z = new Float32Array(cap);
    this.d = new Float32Array(cap);
    this.n = 0;
    this.head = -1;
    this.total = 0;
  }

  reset(x, y, z) {
    this.n = 0;
    this.head = -1;
    this.total = 0;
    this.push(x, y, z, true);
  }

  push(x, y, z, force = false) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (this.head >= 0) {
      const dx = x - this.x[this.head];
      const dz = z - this.z[this.head];
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (!force && dist < TRAIL_STEP) {
        this.y[this.head] = y;
        return;
      }
      this.total += dist;
    }
    this.head = (this.head + 1) % this.cap;
    this.x[this.head] = x;
    this.y[this.head] = y;
    this.z[this.head] = z;
    this.d[this.head] = this.total;
    if (this.n < this.cap) this.n++;
  }

  /** Length of usable history, metres. */
  get span() {
    if (this.n < 2) return 0;
    const oldest = (this.head - (this.n - 1) + this.cap) % this.cap;
    return this.total - this.d[oldest];
  }

  /**
   * World point `back` metres behind the head. Returns the distance actually
   * found (< back when the trail is too short — i.e. the leader has not moved
   * far enough yet, and the follower should crowd in rather than teleport).
   */
  sample(back, out) {
    if (this.head < 0) return 0;
    if (back <= 0 || this.n < 2) {
      out.set(this.x[this.head], this.y[this.head], this.z[this.head]);
      return 0;
    }
    const target = this.total - back;
    let prev = this.head;
    for (let k = 1; k < this.n; k++) {
      const i = (this.head - k + this.cap) % this.cap;
      if (this.d[i] <= target) {
        const seg = this.d[prev] - this.d[i] || 1e-6;
        const t = clamp((target - this.d[i]) / seg, 0, 1);
        out.set(
          lerp(this.x[i], this.x[prev], t),
          lerp(this.y[i], this.y[prev], t),
          lerp(this.z[i], this.z[prev], t)
        );
        return back;
      }
      prev = i;
    }
    out.set(this.x[prev], this.y[prev], this.z[prev]);
    return this.total - this.d[prev];
  }
}

/* ------------------------------------------------------------------ agent */

/** One duck in the family: physics state, personality, animation params. */
class Agent {
  constructor(kind, index, duck, rnd) {
    this.kind = kind;                 // 'mother' | 'duckling'
    this.index = index;
    this.duck = duck;
    this.object = duck.object;
    this.position = duck.object.position;
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.yawVel = 0;
    this.pitch = 0;
    this.roll = 0;
    this.coord = { s: 0, u: 0, distance: 0 };

    // personality
    this.boldness = rnd();            // veers off, follows the player
    this.laziness = rnd();            // hangs back in the line
    this.chatter = rnd();             // quacks and peeps
    this.runt = false;

    this.slot = 0;                    // nominal metres behind the leader
    this.side = 0;                    // lateral offset in the line
    this.lag = 0;                     // live extra lag, drifts
    this.maxSpeed = 1.55;
    this.sprint = 1;
    this.gap = 0;                     // distance to its slot point

    this.leader = 'mother';           // 'mother' | 'player'
    this.leaderHold = 0;              // commit timer, stops leader flapping

    this.state = 'follow';
    this.stateT = 0;
    this.nextIdle = 4 + rnd() * 10;

    this.target = new THREE.Vector3();
    this.look = new THREE.Vector3(0, 0, 1);
    this.veer = new THREE.Vector3();

    this.submerge = 0;
    this.dabble = 0;
    this.preen = 0;
    this.alert = 0;
    this.quack = 0;
    this.wakeAcc = 0;
    this.animAcc = 0;
    this.bobPhase = rnd() * Math.PI * 2;
    this.speed = 0;
    this.grounded = false;

    this.params = {
      speed: 0, paddle: 0, turn: 0, submerged: 0, look: this.look,
      dabble: 0, preen: 0, alert: 0, quack: 0, wetness: 0.35,
    };
  }
}

/* ----------------------------------------------------------------- system */

export class Family {
  constructor(ctx) {
    this.ctx = ctx;
    this.river = ctx.river;
    this.noise = new Noise(991733);
    this.rnd = makeRandom(0x00fa1117);

    this.group = new THREE.Group();
    this.group.name = 'family';

    /** @type {Agent|null} */
    this.mother = null;
    /** @type {Agent[]} */
    this.ducklings = [];
    /** The agent (or player) the line is currently strung out behind. */
    this.leader = null;
    /** Distance from the player to the mother, metres. */
    this.distanceToPlayer = Infinity;
    /** Distance from the player to the nearest family member. */
    this.distanceToNearest = Infinity;
    /** How many ducklings are currently following the player. */
    this.followingPlayer = 0;

    this.motherTrail = new Trail();
    this.playerTrail = new Trail();

    // mother routing
    this.motherU = 0;
    this.motherState = 'travel';
    this.motherStateT = 0;
    this.nextPause = 26;
    this.paused = false;          // family is loafing, ducklings mill
    this.gatherT = 0;
    this.callT = 0;
    this.callCool = 0;
    this.strayT = 0;
    this.strayStage = 0;
    this.leadToastT = 0;
    this.userTarget = null;
    this.regroupT = 0;
    this.elapsed = 0;
    this.frame = 0;

    // scratch — update() must not allocate
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._c = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._flow = new THREE.Vector3();
    this._normal = new THREE.Vector3(0, 1, 0);
    this._desired = new THREE.Vector3();
    this._coord = { s: 0, u: 0, distance: 0 };
    this._coord2 = { s: 0, u: 0, distance: 0 };
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._camPos = new THREE.Vector3();
    this._eventPos = new THREE.Vector3();
    this._rockBuckets = new Map();
    this._agents = [];
  }

  /* ------------------------------------------------------------- boot */

  async init() {
    const ctx = this.ctx;
    const quality = settings.quality?.name || 'high';
    const downShell = quality !== 'low';
    const count = quality === 'low' ? 6 : 8;

    ctx.scene.add(this.group);

    // Mother: a mallard hen, noticeably bigger than the brood.
    const hen = createDuck({
      variant: 'hen', scale: 1.30, seed: 21, castShadow: true,
    });
    this.mother = new Agent('mother', -1, hen, makeRandom(4242));
    this.mother.maxSpeed = 1.5;
    this.group.add(hen.object);
    this._agents.push(this.mother);

    // The brood. Slot distance grows down the line; the runt is last, smallest
    // and slowest, so it is permanently catching up — that is the whole charm.
    for (let i = 0; i < count; i++) {
      const rnd = makeRandom(9001 + i * 7717);
      const runt = i === count - 1;
      const size = runt ? 1.30 : 1.44 + rnd() * 0.34;
      const duck = createDuck({
        variant: 'duckling',
        scale: size,
        seed: 300 + i * 13,
        castShadow: true,
        downShell,
      });
      const a = new Agent('duckling', i, duck, rnd);
      a.runt = runt;
      a.slot = 0.95 + i * 0.72 + rnd() * 0.16;
      a.side = (i % 2 === 0 ? 1 : -1) * (0.10 + rnd() * 0.26);
      a.maxSpeed = (runt ? 1.30 : 1.55 + rnd() * 0.30);
      a.laziness = runt ? 0.85 : a.laziness * 0.8;
      a.boldness = runt ? 0.15 : a.boldness;
      this.group.add(duck.object);
      this.ducklings.push(a);
      this._agents.push(a);
    }
    this.leader = this.mother;

    this._buildRockIndex();
    this._seedPositions();

    // Distant family members do not need to be posed every frame.
    this._frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();
    this._sphere = new THREE.Sphere(new THREE.Vector3(), 0.9);

    if (typeof window !== 'undefined' && window.__duck) window.__duck.family = this;
  }

  /** Index the boulders that actually stick up in the channel, bucketed by s. */
  _buildRockIndex() {
    const rocks = this.ctx.get?.('terrain')?.rocks || this.ctx.terrain?.rocks;
    this._rockBuckets.clear();
    if (!rocks || !rocks.length) return;
    const coord = { s: 0, u: 0, distance: 0 };
    for (const r of rocks) {
      const top = r.position.y + r.radius * 0.85;
      if (top < WATER_LEVEL - 0.45) continue;      // safely under the keel
      this.river.toRiver(r.position, coord);
      if (Math.abs(coord.u) > 1.2) continue;       // sitting up the bank
      const b = Math.floor(coord.s / 16);
      let list = this._rockBuckets.get(b);
      if (!list) this._rockBuckets.set(b, (list = []));
      list.push({ x: r.position.x, z: r.position.z, r: r.radius, top });
    }
  }

  /** Put the family on the water ahead of the player and pre-fill the wake. */
  _seedPositions(ahead = 9) {
    const river = this.river;
    const player = this.ctx.player || this.ctx.get?.('player');
    const base = player ? river.toRiver(player.position, this._coord).s : 120;
    const startS = clamp(base + ahead, 12, river.length - 40);
    this.motherU = clamp((player?.riverCoord?.u ?? 0) * 0.4 + 0.06, -0.5, 0.5);

    // Seed the trail with the path the mother "came down", so the ducklings
    // have a wake to fall into on frame one instead of piling up on her tail.
    this.motherTrail.reset(0, 0, 0);
    this.motherTrail.n = 0;
    this.motherTrail.head = -1;
    this.motherTrail.total = 0;
    for (let s = startS - 26; s <= startS; s += 0.5) {
      const u = this.motherU + Math.sin(s * 0.06) * 0.05;
      river.toWorld(clamp(s, 2, river.length - 2), u, WATER_LEVEL, this._a);
      this.motherTrail.push(this._a.x, this._a.y, this._a.z, true);
    }

    river.toWorld(startS, this.motherU, WATER_LEVEL, this.mother.position);
    river.tangent(startS, this._a);
    this.mother.yaw = Math.atan2(this._a.x, this._a.z);
    this.mother.object.rotation.set(0, this.mother.yaw, 0);
    this.mother.velocity.set(0, 0, 0);

    for (const a of this.ducklings) {
      this.motherTrail.sample(a.slot, this._b);
      river.right(startS, this._c);
      a.position.copy(this._b).addScaledVector(this._c, a.side);
      a.position.y = WATER_LEVEL;
      a.yaw = this.mother.yaw;
      a.object.rotation.set(0, a.yaw, 0);
      a.velocity.set(0, 0, 0);
      a.leader = 'mother';
    }
    this.playerTrail.reset(
      player ? player.position.x : this.mother.position.x,
      WATER_LEVEL,
      player ? player.position.z : this.mother.position.z
    );
  }

  /* --------------------------------------------------------- public API */

  /** Call the brood in tight around the mother for a few seconds. */
  gather() {
    this.gatherT = 5.0;
    this.paused = true;
    this.motherState = 'call';
    this.motherStateT = 0;
    for (const a of this.ducklings) {
      a.leader = 'mother';
      a.leaderHold = 3;
      a.state = 'follow';
      a.lag = 0;
      a.sprint = 1.7;
    }
    this._quack(this.mother, 1.0);
    return this;
  }

  /** Send the mother to a world position (she still routes inside the channel). */
  setTarget(worldPos) {
    if (!worldPos) { this.userTarget = null; return this; }
    if (!this.userTarget) this.userTarget = new THREE.Vector3();
    this.userTarget.copy(worldPos);
    this.motherState = 'travel';
    this.paused = false;
    return this;
  }

  /* --------------------------------------------------------- per frame */

  update(dt, elapsed) {
    if (!this.mother) return;
    dt = clamp(dt || 0, 0, 1 / 20);
    this.elapsed = elapsed;
    this.frame++;

    const ctx = this.ctx;
    const player = ctx.player || ctx.get?.('player');
    const cam = ctx.camera;
    if (cam) {
      this._camPos.setFromMatrixPosition(cam.matrixWorld);
      this._projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this._frustum.setFromProjectionMatrix(this._projScreen);
    }

    // Player trail — ducklings that decide to follow you swim in your wake too.
    if (player) {
      this.playerTrail.push(player.position.x, player.position.y, player.position.z);
      this.distanceToPlayer = player.position.distanceTo(this.mother.position);
    } else {
      this.distanceToPlayer = Infinity;
    }

    this.gatherT = Math.max(0, this.gatherT - dt);
    this.callT = Math.max(0, this.callT - dt);
    this.callCool = Math.max(0, this.callCool - dt);
    this.leadToastT = Math.max(0, this.leadToastT - dt);

    this._updateMother(dt, player);
    this._updateLeadership(dt, player);

    let nearest = Infinity;
    for (let i = 0; i < this.ducklings.length; i++) {
      const a = this.ducklings[i];
      this._updateDuckling(a, dt, player);
      if (player) {
        const d = a.position.distanceTo(player.position);
        if (d < nearest) nearest = d;
      }
    }
    this.distanceToNearest = Math.min(nearest, this.distanceToPlayer);

    // Integrate, float, orient, animate.
    for (let i = 0; i < this._agents.length; i++) {
      this._settle(this._agents[i], dt);
    }
    for (let i = 0; i < this._agents.length; i++) {
      this._animate(this._agents[i], dt);
    }

    this._playerRelationship(dt, player);

    // Rubber band: if the player has gone a very long way (or teleported), the
    // family is "round the next bend" rather than lost for good.
    if (player && this.distanceToPlayer > REGROUP_DISTANCE) {
      this.regroupT += dt;
      if (this.regroupT > 1.2) {
        this.regroupT = 0;
        this._seedPositions(11);
        this.strayT = 0;
        this.strayStage = 0;
      }
    } else {
      this.regroupT = 0;
    }
  }

  /* ------------------------------------------------------------ mother */

  _updateMother(dt, player) {
    const m = this.mother;
    const river = this.river;
    river.toRiver(m.position, m.coord);
    const s = m.coord.s;
    this.motherStateT += dt;

    // --- state machine -----------------------------------------------------
    if (this.gatherT > 0) {
      this.motherState = 'call';
      this.paused = true;
    } else if (this.motherState === 'travel') {
      this.nextPause -= dt;
      const pool = river.poolNear(s);
      const inPool = pool && Math.abs(pool.s - s) < pool.radius * 0.9;
      if (this.nextPause <= 0 && inPool) {
        this.motherState = this.rnd() < 0.6 ? 'dabble' : 'preen';
        this.motherStateT = 0;
        this.paused = true;
      }
      if (s > river.length - 60) {
        // End of the river: loaf in the last pool rather than swim off the map.
        this.motherState = 'dabble';
        this.motherStateT = 0;
        this.paused = true;
      }
    } else if (this.motherState === 'dabble' || this.motherState === 'preen') {
      const dur = this.motherState === 'dabble' ? 6.5 : 5.0;
      if (this.motherStateT > dur) {
        this.motherState = 'travel';
        this.motherStateT = 0;
        this.nextPause = 40 + this.rnd() * 60;
        this.paused = false;
        this._quack(m, 0.7);         // "come on, then"
      }
    } else if (this.motherState === 'call') {
      if (this.motherStateT > 2.4 && this.gatherT <= 0) {
        this.motherState = 'travel';
        this.motherStateT = 0;
        this.paused = false;
      }
    }

    // Stragglers hold the family up: mother slows, turns and calls.
    let worstGap = 0;
    for (const a of this.ducklings) if (a.leader === 'mother' && a.gap > worstGap) worstGap = a.gap;
    const waiting = worstGap > 5.5;
    if (waiting && this.callCool <= 0 && this.motherState === 'travel') {
      this._quack(m, 0.55);
      this.callCool = 6 + this.rnd() * 4;
      this.callT = 1.4;
    }

    // --- route -------------------------------------------------------------
    const travelling = this.motherState === 'travel' && !this.paused;
    let cruise = travelling ? 1.02 : 0.0;
    if (travelling && waiting) cruise = 0.30;
    if (travelling && player && this.distanceToPlayer > STRAY_NEAR) cruise = 0.18;

    if (this.userTarget) {
      this._desired.copy(this.userTarget);
      if (this._desired.distanceTo(m.position) < 1.6) this.userTarget = null;
      cruise = travelling ? 1.15 : cruise;
    } else if (travelling) {
      // Pick the cross-channel line: deep enough, off the rocks, gently
      // wandering, favouring the outside of a bend where the channel scours.
      this.motherU = this._pickLine(s, this.motherU);
      const ahead = clamp(s + 7, 2, river.length - 2);
      river.toWorld(ahead, this.motherU, WATER_LEVEL, this._desired);
    } else {
      // Holding station: drift very slightly, keep her nose into the current.
      river.toWorld(clamp(s + 0.6, 2, river.length - 2), this.motherU, WATER_LEVEL, this._desired);
    }

    m.alert = this.motherState === 'call' || waiting ? 1 : (this.distanceToPlayer > STRAY_NEAR ? 0.6 : 0);
    m.dabble = this.motherState === 'dabble'
      ? clamp(m.dabble + dt * 1.6, 0, 1) : Math.max(0, m.dabble - dt * 1.6);
    m.preen = this.motherState === 'preen'
      ? clamp(m.preen + dt * 1.2, 0, 1) : Math.max(0, m.preen - dt * 1.4);

    this._steer(m, this._desired, cruise, dt, travelling ? 0.42 : 0.0);
    this.motherTrail.push(m.position.x, m.position.y, m.position.z);

    // Look: at the brood when calling, at the player when they are close,
    // otherwise down the river.
    if (this.motherState === 'call' || waiting) {
      const t = this.ducklings[this.ducklings.length - 1];
      m.look.copy(t.position).sub(m.position).normalize();
    } else if (player && this.distanceToPlayer < 6) {
      m.look.copy(player.position).sub(m.position).normalize();
    } else {
      m.look.set(Math.sin(m.yaw), 0, Math.cos(m.yaw));
    }
  }

  /** Score a few candidate lines across the channel and take the best. */
  _pickLine(s, cur) {
    const river = this.river;
    const ahead = clamp(s + 8, 2, river.length - 2);
    const wander = this.noise.noise2(this.elapsed * 0.035, 7.31);
    const bend = clamp(river.curvature(ahead) * 30, -0.5, 0.5);
    let best = cur, bestScore = -Infinity;
    for (let i = -3; i <= 3; i++) {
      const u = clamp(cur + i * 0.085, -0.68, 0.68);
      const depth = river.depth(ahead, u);
      let score = smoothstep(depth, 0.35, 1.5) * 2.2;      // stay off the bars
      score -= Math.abs(u) * 0.45;                          // prefer mid channel
      score += wander * u * 1.1;                            // slow meander
      score -= Math.abs(u - bend) * 0.35;                   // follow the scour
      river.toWorld(ahead, u, WATER_LEVEL, this._a);
      score -= this._rockPenalty(ahead, this._a.x, this._a.z, 1.6) * 2.0;
      if (score > bestScore) { bestScore = score; best = u; }
    }
    return lerp(cur, best, clamp(this.ctx.time?.dt ? 1.5 * this.ctx.time.dt : 0.02, 0, 0.3));
  }

  /* ---------------------------------------------------------- leadership */

  /**
   * Who is each duckling following? Bold ducklings will peel off after the
   * player when the player gets in front of them and is close — the moment
   * that sells the whole premise, so it must be visible and it must persist
   * long enough to read.
   */
  _updateLeadership(dt, player) {
    let following = 0;
    if (!player) {
      for (const a of this.ducklings) a.leader = 'mother';
      this.leader = this.mother;
      this.followingPlayer = 0;
      return;
    }
    const pc = player.riverCoord || this.river.toRiver(player.position, this._coord2);
    const leadAmount = pc.s - this.mother.coord.s;      // + = player is downstream
    const playerMoving = (player.speed ?? 0) > 0.35;

    for (const a of this.ducklings) {
      a.leaderHold = Math.max(0, a.leaderHold - dt);
      if (this.gatherT > 0) { a.leader = 'mother'; continue; }
      if (a.leaderHold > 0) { if (a.leader === 'player') following++; continue; }
      const dPlayer = a.position.distanceTo(player.position);
      const dMother = a.position.distanceTo(this.mother.position);
      // Bold ducklings switch at a longer range; the runt basically never does.
      const range = 2.4 + a.boldness * 5.0;
      const wantPlayer =
        !player.submerged &&
        dPlayer < range &&
        dPlayer < dMother * 1.35 &&
        (leadAmount > -1.0 || playerMoving) &&
        a.boldness > 0.22;
      const next = wantPlayer ? 'player' : 'mother';
      if (next !== a.leader) {
        a.leader = next;
        a.leaderHold = next === 'player' ? 2.6 + a.boldness * 3.0 : 1.6;
        if (next === 'player') this._peep(a);
      }
      if (a.leader === 'player') following++;
    }

    if (following !== this.followingPlayer && following > 0 && this.leadToastT <= 0) {
      this.leadToastT = 26;
      this.ctx.events?.emit(this.ctx.EVENTS.TOAST, {
        text: following === 1
          ? 'A duckling is following you'
          : `${following} ducklings are following you`,
        icon: '\u{1F423}',
        duration: 2.4,
      });
    }
    this.followingPlayer = following;
    this.leader = following > this.ducklings.length * 0.5 ? player : this.mother;
  }

  /* --------------------------------------------------------- ducklings */

  _updateDuckling(a, dt, player) {
    const river = this.river;
    river.toRiver(a.position, a.coord);
    a.stateT += dt;

    const leadingObj = a.leader === 'player' && player ? player : this.mother;
    const trail = a.leader === 'player' && player ? this.playerTrail : this.motherTrail;

    // --- lag: the line breathes. Lazy ducklings drop back, then notice.
    const wob = this.noise.noise2(this.elapsed * 0.22 + a.index * 3.7, a.index * 1.13);
    const lagTarget = (0.25 + a.laziness * 1.5) * (0.5 + 0.5 * wob) + (a.runt ? 0.6 : 0);
    a.lag = lerp(a.lag, lagTarget, clamp(dt * 0.6, 0, 1));

    // --- idle behaviours -------------------------------------------------
    a.nextIdle -= dt;
    if (a.state === 'follow' && a.nextIdle <= 0) {
      a.nextIdle = 6 + this.rnd() * 14;
      const r = this.rnd();
      if (this.paused && r < 0.45) { a.state = 'dabble'; a.stateT = 0; }
      else if (this.paused && r < 0.7) { a.state = 'preen'; a.stateT = 0; }
      else if (r < 0.78 && a.boldness > 0.45 && a.gap < 2.5) {
        // Veer off after something — a bug, a leaf, a glint.
        a.state = 'veer';
        a.stateT = 0;
        const side = this.rnd() < 0.5 ? -1 : 1;
        const u = clamp(a.coord.u + side * (0.18 + this.rnd() * 0.35), -0.8, 0.8);
        river.toWorld(clamp(a.coord.s + 1 + this.rnd() * 4, 2, river.length - 2),
          u, WATER_LEVEL, a.veer);
      } else if (r < 0.86 && !this.paused && river.depth(a.coord.s, a.coord.u) > 1.1) {
        a.state = 'dip';                 // a quick duckling dunk
        a.stateT = 0;
      }
    }
    let mult = 1;
    switch (a.state) {
      case 'veer':
        if (a.stateT > 2.2 + a.boldness * 2.0) {
          a.state = 'follow'; a.stateT = 0; a.sprint = 1.8;   // hurry back!
          if (this.rnd() < 0.5) this._peep(a);
        }
        break;
      case 'dabble':
        if (a.stateT > 2.0 + this.rnd() * 2 || !this.paused) { a.state = 'follow'; a.stateT = 0; }
        break;
      case 'preen':
        if (a.stateT > 2.4 || !this.paused) { a.state = 'follow'; a.stateT = 0; }
        break;
      case 'dip':
        if (a.stateT > 1.3) { a.state = 'follow'; a.stateT = 0; }
        mult = 0.4;
        break;
      default:
        break;
    }
    a.dabble = a.state === 'dabble' ? clamp(a.dabble + dt * 2, 0, 1) : Math.max(0, a.dabble - dt * 2);
    a.preen = a.state === 'preen' ? clamp(a.preen + dt * 1.6, 0, 1) : Math.max(0, a.preen - dt * 2);
    const dipping = a.state === 'dip';
    a.submerge = dipping
      ? clamp(a.submerge + dt * 2.6, 0, 1) * (a.stateT > 0.9 ? 0.6 : 1)
      : Math.max(0, a.submerge - dt * 2.4);

    // --- pick the target --------------------------------------------------
    if (a.state === 'veer') {
      this._desired.copy(a.veer);
    } else if (this.paused && a.leader !== 'player') {
      // Loafing: mill around the mother instead of queueing behind her.
      const ang = this.elapsed * (0.16 + a.index * 0.02) + a.index * 2.4;
      const rad = (this.gatherT > 0 ? 0.55 : 0.9) + (a.index % 3) * 0.30;
      this._desired.set(
        this.mother.position.x + Math.cos(ang) * rad,
        WATER_LEVEL,
        this.mother.position.z + Math.sin(ang) * rad * 0.8
      );
    } else {
      const back = (a.slot + a.lag) * (this.gatherT > 0 ? 0.45 : 1);
      const got = trail.sample(back, this._desired);
      // Lateral jostle: they weave for the slot right behind the leader.
      const jostle = this.noise.noise2(this.elapsed * 0.5 + a.index * 5.1, a.index * 0.77);
      const off = a.side * (0.6 + 0.6 * jostle);
      trail.sample(Math.max(0, back - 0.5), this._a);
      this._b.subVectors(this._a, this._desired);
      if (this._b.lengthSq() > 1e-6) {
        this._b.normalize();
        this._desired.x += -this._b.z * off;
        this._desired.z += this._b.x * off;
      }
      if (got < back - 0.05) {
        // Trail too short (leader has barely moved): fall in behind anyway.
        this._c.copy(leadingObj.position).sub(this._desired);
        if (this._c.lengthSq() < 0.01) {
          this._desired.x -= Math.sin(leadingObj.yaw ?? 0) * (back - got);
          this._desired.z -= Math.cos(leadingObj.yaw ?? 0) * (back - got);
        }
      }
    }

    a.gap = a.position.distanceTo(this._desired);
    // Catch-up: the further behind, the harder they paddle. This is the
    // "little legs going like mad" read.
    const chase = clamp(a.gap / 2.2, 0, 1);
    a.sprint = Math.max(a.sprint * Math.exp(-dt * 1.4), 1 + chase * 0.85);
    const speedWant = clamp(a.gap * 1.9, 0, a.maxSpeed * a.sprint) * mult;

    this._steer(a, this._desired, speedWant, dt, 0.5, true);

    // Look at whatever matters: the leader, or the player if they are near.
    const lookAt = (player && a.position.distanceTo(player.position) < 3.2 && a.leader !== 'player')
      ? player.position
      : (a.state === 'veer' ? a.veer : leadingObj.position);
    this._a.copy(lookAt).sub(a.position);
    if (this._a.lengthSq() > 1e-5) a.look.copy(this._a).normalize();

    a.alert = clamp((a.gap - 3) * 0.4, 0, 1);
    if (a.gap > 6 && this.callT > 0 && this.rnd() < 0.02) this._peep(a);
  }

  /* ------------------------------------------------------------ physics */

  /**
   * Kinematic steering: blend toward the desired ground velocity, add the part
   * of the current the duck lets carry it, then push out of banks and rocks.
   */
  _steer(a, target, speedWant, dt, drift, isDuckling = false) {
    const river = this.river;
    this._desired.copy(target).sub(a.position);
    this._desired.y = 0;
    const dist = this._desired.length();
    if (dist > 1e-4) this._desired.multiplyScalar(speedWant / dist);
    else this._desired.set(0, 0, 0);

    if (drift > 0) {
      river.flowAt(a.coord.s, clamp(a.coord.u, -1, 1), this._flow);
      this._desired.addScaledVector(this._flow, drift);
    }

    // --- avoidance ---------------------------------------------------------
    // banks: never let a duck touch the waterline geometry
    const au = a.coord.u;
    const edge = Math.abs(au) - 0.80;
    if (edge > 0) {
      river.right(a.coord.s, this._a);
      this._desired.addScaledVector(this._a, -Math.sign(au) * edge * 6.0);
    }
    // rocks
    this._avoidRocks(a, this._desired);
    // each other
    for (let i = 0; i < this._agents.length; i++) {
      const o = this._agents[i];
      if (o === a) continue;
      const dx = a.position.x - o.position.x;
      const dz = a.position.z - o.position.z;
      const d2 = dx * dx + dz * dz;
      const rad = (a.kind === 'mother' || o.kind === 'mother') ? 0.52 : 0.40;
      if (d2 < rad * rad && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = (rad - d) / rad * 1.5;
        this._desired.x += (dx / d) * push;
        this._desired.z += (dz / d) * push;
      }
    }
    // the player is a duckling too — do not swim through them
    const player = this.ctx.player || this.ctx.get?.('player');
    if (player && !player.submerged) {
      const dx = a.position.x - player.position.x;
      const dz = a.position.z - player.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 0.30 && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        this._desired.x += (dx / d) * (0.55 - d) * 3.0;
        this._desired.z += (dz / d) * (0.55 - d) * 3.0;
      }
    }

    // --- integrate ---------------------------------------------------------
    const accel = isDuckling ? 5.0 : 3.6;
    const k = clamp(accel * dt, 0, 1);
    a.velocity.x += (this._desired.x - a.velocity.x) * k;
    a.velocity.z += (this._desired.z - a.velocity.z) * k;
    const maxV = a.maxSpeed * a.sprint + 2.0;
    const vlen = Math.hypot(a.velocity.x, a.velocity.z);
    if (vlen > maxV) {
      a.velocity.x *= maxV / vlen;
      a.velocity.z *= maxV / vlen;
    }
    a.position.x += a.velocity.x * dt;
    a.position.z += a.velocity.z * dt;
    a.speed = Math.hypot(a.velocity.x, a.velocity.z);

    // hard clamp: whatever the steering did, stay inside the water
    river.toRiver(a.position, a.coord);
    const limit = 0.90;
    if (Math.abs(a.coord.u) > limit) {
      river.toWorld(a.coord.s, Math.sign(a.coord.u) * limit, WATER_LEVEL, this._a);
      a.position.x = this._a.x;
      a.position.z = this._a.z;
      a.coord.u = Math.sign(a.coord.u) * limit;
      a.velocity.multiplyScalar(0.6);
    }

    // --- heading -----------------------------------------------------------
    if (a.speed > 0.05) {
      const want = Math.atan2(a.velocity.x, a.velocity.z);
      const diff = wrapAngle(want - a.yaw);
      const rate = clamp(dt * (3.0 + a.speed * 2.2), 0, 1);
      a.yawVel = diff * rate / Math.max(dt, 1e-4);
      a.yaw = wrapAngle(a.yaw + diff * rate);
    } else {
      a.yawVel *= 0.9;
    }
  }

  _rockPenalty(s, x, z, pad) {
    const b = Math.floor(s / 16);
    let worst = 0;
    for (let k = -1; k <= 1; k++) {
      const list = this._rockBuckets.get(b + k);
      if (!list) continue;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        const dx = x - r.x, dz = z - r.z;
        const rr = r.r + pad;
        const d2 = dx * dx + dz * dz;
        if (d2 < rr * rr) {
          const v = 1 - Math.sqrt(d2) / rr;
          if (v > worst) worst = v;
        }
      }
    }
    return worst;
  }

  _avoidRocks(a, out) {
    const b = Math.floor(a.coord.s / 16);
    const pad = a.kind === 'mother' ? 0.55 : 0.40;
    for (let k = -1; k <= 1; k++) {
      const list = this._rockBuckets.get(b + k);
      if (!list) continue;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.top < WATER_LEVEL - 0.2) continue;
        const dx = a.position.x - r.x;
        const dz = a.position.z - r.z;
        const rr = r.r * 0.85 + pad;
        const d2 = dx * dx + dz * dz;
        if (d2 < rr * rr && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const push = (1 - d / rr) * 3.0;
          out.x += (dx / d) * push;
          out.z += (dz / d) * push;
        }
      }
    }
  }

  /** Height of anything solid the duck could be standing on, or -Infinity. */
  _standHeight(a) {
    const river = this.river;
    let h = river.bedHeight(a.coord.s, a.coord.u);
    // A barely-submerged boulder is something to clamber onto, not swim through.
    const b = Math.floor(a.coord.s / 16);
    for (let k = -1; k <= 1; k++) {
      const list = this._rockBuckets.get(b + k);
      if (!list) continue;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.top > WATER_LEVEL + 0.55 || r.top < WATER_LEVEL - 0.4) continue;
        const dx = a.position.x - r.x;
        const dz = a.position.z - r.z;
        const rr = r.r * 0.55;
        const d2 = dx * dx + dz * dz;
        if (d2 < rr * rr) {
          const dome = r.top - Math.sqrt(d2) * 0.35;
          if (dome > h) h = dome;
        }
      }
    }
    return h;
  }

  /** Float, bob, tilt with the surface, leave a wake. */
  _settle(a, dt) {
    const water = this.ctx.water;
    const far = this._camPos.distanceToSquared(a.position) > 70 * 70;
    let surf = WATER_LEVEL;
    if (water?.heightAt && !far) surf = water.heightAt(a.position.x, a.position.z);

    const stand = this._standHeight(a);
    const lift = a.kind === 'mother' ? 0.055 : 0.035;
    let y = surf;
    a.grounded = false;
    if (stand + lift > surf) {
      y = stand + lift;                 // standing on a bar or a boulder
      a.grounded = true;
    }
    y -= a.submerge * 0.14;             // a duckling dipping its head under
    y += Math.sin(this.elapsed * 1.7 + a.bobPhase) * 0.006;
    a.position.y = lerp(a.position.y, y, clamp(dt * 12, 0, 1));

    // Orientation: pitch/roll from the water normal plus a little swim pitch.
    let nx = 0, nz = 0;
    if (water?.normalAt && !far && !a.grounded) {
      const n = water.normalAt(a.position.x, a.position.z, this._normal);
      nx = n.x; nz = n.z;
    }
    const pitchWant = -(nz * Math.cos(a.yaw) + nx * Math.sin(a.yaw)) * 0.7
      - a.speed * 0.035 + a.submerge * 0.42 + a.dabble * 0.2;
    const rollWant = (nx * Math.cos(a.yaw) - nz * Math.sin(a.yaw)) * 0.7
      - clamp(a.yawVel, -3, 3) * 0.06;
    a.pitch = lerp(a.pitch, pitchWant, clamp(dt * 6, 0, 1));
    a.roll = lerp(a.roll, rollWant, clamp(dt * 6, 0, 1));
    this._euler.set(a.pitch, a.yaw, a.roll);
    a.object.quaternion.setFromEuler(this._euler);

    // Wake. Throttled by distance travelled so it does not eat ripple slots.
    if (water?.addWake && !a.grounded && a.speed > 0.12) {
      a.wakeAcc += a.speed * dt;
      const step = a.kind === 'mother' ? 0.42 : 0.34;
      if (a.wakeAcc > step) {
        a.wakeAcc = 0;
        const inv = 1 / Math.max(a.speed, 1e-3);
        const st = clamp(a.speed * (a.kind === 'mother' ? 0.030 : 0.016), 0.006, 0.06);
        water.addWake(
          a.position.x - Math.sin(a.yaw) * 0.12,
          a.position.z - Math.cos(a.yaw) * 0.12,
          a.velocity.x * inv, a.velocity.z * inv,
          st, a.kind === 'mother' ? 2.3 : 1.4
        );
      }
    }
  }

  /** Pose the duck. Off-screen and distant ducks are posed at a lower rate. */
  _animate(a, dt) {
    const p = a.params;
    p.speed = a.speed;
    p.paddle = clamp(a.speed / 1.5, 0, 1) * (a.grounded ? 0.25 : 1);
    p.turn = clamp(a.yawVel * 0.28, -1, 1);
    p.submerged = a.submerge;
    p.look = a.look;
    p.dabble = a.dabble;
    p.preen = a.preen;
    p.alert = a.alert;
    p.quack = a.quack > 0 ? 1 : 0;
    p.wetness = a.grounded ? 0.4 : 0.75;
    if (a.quack > 0) a.quack = Math.max(0, a.quack - dt);

    a.animAcc += dt;
    let stride = 1;
    if (this._frustum) {
      this._sphere.center.copy(a.position);
      if (!this._frustum.intersectsSphere(this._sphere)) stride = 6;
    }
    if (stride === 1) {
      const d2 = this._camPos.distanceToSquared(a.position);
      if (d2 > 90 * 90) stride = 4;
      else if (d2 > 38 * 38) stride = 2;
    }
    if (stride === 1 || this.frame % stride === 0) {
      a.duck.update(a.animAcc, p);
      a.animAcc = 0;
    }
  }

  /* ------------------------------------------------------ player & voice */

  _playerRelationship(dt, player) {
    if (!player) return;
    const ctx = this.ctx;
    const d = this.distanceToNearest;

    if (d > STRAY_NEAR) {
      this.strayT += dt;
      const stage = d > STRAY_FAR ? 2 : 1;
      if (this.strayT > (stage === 2 ? 1.2 : 2.6) && this.callCool <= 0) {
        this.callCool = stage === 2 ? 9 : 13;
        this.callT = 1.6;
        this.motherState = 'call';
        this.motherStateT = 0;
        this._quack(this.mother, stage === 2 ? 1.0 : 0.85);
        if (stage > this.strayStage || this.strayStage === 0) {
          ctx.events?.emit(ctx.EVENTS.TOAST, {
            text: stage === 2
              ? 'You have lost the family — follow the calls downstream'
              : 'Mother is calling you back',
            icon: '\u{1F986}',
            duration: 2.6,
          });
        }
        this.strayStage = stage;
      }
    } else {
      if (this.strayStage > 0 && d < REUNITE) {
        this.strayStage = 0;
        this.strayT = 0;
        ctx.events?.emit(ctx.EVENTS.TOAST, {
          text: 'Back with the family', icon: '\u{1F423}', duration: 2.0,
        });
        // A little chorus of relief.
        this._quack(this.mother, 0.6);
        for (let i = 0; i < this.ducklings.length; i += 3) this._peep(this.ducklings[i]);
      }
      this.strayT = Math.max(0, this.strayT - dt);
    }
  }

  _quack(a, volume = 0.8) {
    a.quack = 0.35;
    a.duck.quack?.();
    const ctx = this.ctx;
    this._eventPos.copy(a.position);
    this._eventPos.y += 0.25;
    ctx.events?.emit(ctx.EVENTS.QUACK, { position: this._eventPos.clone(), pitch: 0.85 });
    ctx.events?.emit(ctx.EVENTS.SFX, {
      name: 'quack', position: this._eventPos.clone(), volume, rate: 0.82,
    });
  }

  _peep(a) {
    a.quack = 0.25;
    a.duck.quack?.();
    const ctx = this.ctx;
    this._eventPos.copy(a.position);
    this._eventPos.y += 0.12;
    ctx.events?.emit(ctx.EVENTS.SFX, {
      name: 'quack', position: this._eventPos.clone(), volume: 0.35, rate: 1.75 + a.index * 0.04,
    });
  }

  /* ---------------------------------------------------------------- misc */

  dispose() {
    for (const a of this._agents) a.duck.dispose?.();
    this._agents.length = 0;
    this.ducklings.length = 0;
    this.mother = null;
    this.group.removeFromParent();
    this._rockBuckets.clear();
  }
}
