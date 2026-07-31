/**
 * Terrain — the stage the whole game plays on.
 *
 * The land is built as a RIBBON in river coordinates rather than as a grid over
 * the world, because the player only ever sees a corridor. For every station `s`
 * along the centreline a cross-section is swept out:
 *
 *      far hills  ·  bank  ·  beach │ channel bed │ beach  ·  bank  ·  far hills
 *      ←────────  coarse  ──────────┤   dense     ├────────  coarse  ─────────→
 *
 * All heights come from `river.bedHeight` / `river.bankHeight`, so the ground
 * matches the river contract exactly and nothing else in the game has to guess.
 *
 * Resolution is graded in BOTH directions:
 *   • across the channel, by how far apart the columns are placed — 20 columns
 *     inside the water alone, ~1 m spacing over the beach, ~100 m on the horizon;
 *   • along the river, by a per-column stride `level` (1 → every 2.1 m row,
 *     16 → every 34 m). Bands between columns of different level are stitched
 *     with triangle fans, which removes T-junctions entirely: a column is only
 *     ever subdivided at multiples of its own level, whichever band looks at it.
 *
 * That grading is not only about triangle count. Uniform 2 m rows out at 800 m
 * produce 100 m × 2 m slivers, and at grazing angles those slivers z-fight and
 * backface-cull into dashed holes across the whole horizon. Spacing the distant
 * rows out is what makes the far hills solid.
 *
 * The ribbon is then cut into chunks along `s` (frustum culling) and split at
 * SPLIT_DIST into a near shell (tight bounds, casts shadows) and a far shell
 * (cheap, no shadow casting). The split column has equal level on both sides, so
 * both meshes subdivide the shared edge identically — the seam is exact.
 *
 * On top of the ribbon sit instanced boulders: bank rocks, rocks in the fast
 * shallows, and a handful of hero midstream blocks for the water to break around.
 * They are bucketed by river segment so distant ones can be culled too.
 *
 * Public API (also documented in the reply to the integrator):
 *   terrain.material                        ground material (patched standard)
 *   terrain.rockMaterial
 *   terrain.group                           Object3D holding everything
 *   terrain.setCaustics(texture, params)     project water caustics on the bed
 *   terrain.rocks                           [{ position, radius, submerged }]
 *   terrain.heightAt(x, z)                  convenience wrapper over the river
 *   terrain.nearMeshes / farMeshes / rockMeshes
 */

import * as THREE from 'three';
import { makeRandom } from '../core/noise.js';
import { createGroundMaterial, createRockMaterial } from '../render/groundMaterial.js';

const CHANNEL = 0; // cross-section column addressed by u
const BANK = 1;    // cross-section column addressed by metres inland

// Half of the cross-section, from the centreline outward. `level` is the row
// stride this column is sampled at: level 1 means every row (≈2.1 m along the
// river), level 16 means every sixteenth (≈34 m). Bands between columns of
// different level are stitched with triangle fans, so the mesh stays watertight
// while the far ground costs almost nothing — and, critically, distant rows are
// far enough apart that they stop z-fighting each other at grazing angles.
// NORMALISED cross parameter, not u: 1.0 is the waterline for this station,
// wherever shoreU() puts it. Weighted toward the outer end because that is
// where the bed does all its work — a 2 m drop inside the last metre.
const CHANNEL_U = [
  0, 0.09, 0.18, 0.27, 0.36, 0.45, 0.53, 0.61, 0.685, 0.755,
  0.815, 0.865, 0.905, 0.938, 0.962, 0.978, 0.988, 0.9945, 0.9985, 1.0,
];
const BANK_SPEC = [
  // [metres inland, row stride level]
  [0.25, 1], [0.6, 1], [1.0, 1], [1.5, 1], [2.1, 1], [2.8, 1],
  [3.7, 1], [4.8, 1], [6.2, 1], [8.0, 2], [10.5, 2], [14, 2],
  [19, 4], [26, 4], [35, 4],
  [48, 8], [68, 8], [95, 8],
  // 130–500 m is where the ridgelines actually silhouette against the sky, so it
  // gets ~25 m spacing; past that the sky's fog has taken over almost completely
  // and the columns only exist so the horizon is never open.
  [128, 8], [152, 8], [178, 8], [206, 8], [236, 16], [268, 16],
  [302, 16], [338, 16], [376, 16], [416, 16], [458, 16], [502, 16],
  [560, 16], [630, 16], [712, 16], [806, 16], [912, 16],
];
// The mesh is cut in two at this distance: everything closer is one set of
// chunks with tight bounds that cast shadows, everything beyond is a second set.
// The split column has the same level on both sides, so both meshes subdivide
// the shared edge identically and the seam is exact.
const SPLIT_DIST = 68;
const MAX_LEVEL = 16;

const S_OVERRUN = 150;    // ribbon continues past both ends of the river
const CHUNK_ROWS = 48;    // must be a multiple of MAX_LEVEL
const CHUNKS = 24;

// ── the shoreline, shared with world/water.js ──────────────────────────────
//
// `river.depth` clamps a skewed cross-channel profile, so on a bend the bed
// reaches the still level well INSIDE |u| = 1 — measured, as early as |u| = 0.28,
// which leaves up to 11 m of the nominal channel as a dry point bar sitting at
// exactly WATER_LEVEL. Nothing used to know that: the ground ribbon put all its
// resolution at |u| = 1 (so the real shelf, a 2 m drop over a metre, was
// resolved by columns 1.1 m apart and undershot the true bed by up to 1.14 m),
// and the water ribbon painted opaque water and blown-out shore foam across the
// whole bar, coplanar with the ground. That is the jagged waterline: a
// z-fighting patchwork of bright foam and dark silt with wedges of unwatered
// bed hanging off it.
//
// Both ribbons now scale their cross-section by this one function, so their
// waterlines are the same curve by construction rather than by coincidence.
// It lives here because terrain owns the bed; water.js imports it.

const _shoreCache = new WeakMap();
const SHORE_STEP = 1.0;   // metres along s between solved samples

function solveShore(river, s, side) {
  // depth() is monotone in |u| (its noise factor is strictly positive), so a
  // plain bisection on "is there any water here" finds the waterline exactly.
  let lo = 0, hi = 1;
  for (let i = 0; i < 18; i++) {
    const m = (lo + hi) * 0.5;
    if (river.depth(s, side * m) > 1e-7) lo = m; else hi = m;
  }
  return Math.min(1, Math.max(0.12, hi));
}

/** Cached table of the waterline |u| for both banks, sampled every metre. */
export function shoreProfile(river) {
  let c = _shoreCache.get(river);
  if (c) return c;
  const n = Math.ceil(river.length / SHORE_STEP) + 2;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = Math.min(river.length, i * SHORE_STEP);
    L[i] = solveShore(river, s, -1);
    R[i] = solveShore(river, s, 1);
  }
  c = { step: SHORE_STEP, n, L, R };
  _shoreCache.set(river, c);
  return c;
}

/**
 * |u| of the waterline at station `s` on `side` (-1 or +1), in (0.12 … 1].
 * Linear between the metre samples — which also takes the worst of the jitter
 * out of `curvature()`, whose 1 m lookup table makes the raw edge a staircase.
 */
export function shoreU(river, s, side) {
  const c = shoreProfile(river);
  let f = s / c.step;
  if (!(f > 0)) f = 0; else if (f > c.n - 1) f = c.n - 1;
  const i = f | 0;
  const j = Math.min(c.n - 1, i + 1);
  const t = f - i;
  const a = side < 0 ? c.L : c.R;
  return a[i] + (a[j] - a[i]) * t;
}

export class Terrain {
  constructor(ctx) {
    this.ctx = ctx;
    this.river = ctx.river;
    this.waterLevel = ctx.WATER_LEVEL ?? 0;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    this.nearMeshes = [];
    this.farMeshes = [];
    this.rockMeshes = [];
    this.rocks = [];
    this._geometries = [];
    this._fallbackLights = [];

    // hoisted scratch — update() must never allocate
    this._v0 = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._tan = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._eu = new THREE.Euler();
    this._sc = new THREE.Vector3();
    this._mat = new THREE.Matrix4();
    this._flow = new THREE.Vector3();
    this._riverCoord = { s: 0, u: 0, distance: 0 };
  }

  async init() {
    const q = this.ctx.settings?.quality ?? {};
    const texSize = q.name === 'low' ? 256 : 512;
    const aniso = this.ctx.engine?.maxAnisotropy ?? 4;

    this.material = createGroundMaterial({
      anisotropy: aniso,
      textureSize: texSize,
      waterLevel: this.waterLevel,
    });
    this.rockMaterial = createRockMaterial({
      groundMaterial: this.material,
      waterLevel: this.waterLevel,
    });
    this._uniforms = this.material.userData.uniforms;
    this._rockUniforms = this.rockMaterial.userData.uniforms;

    this._buildColumns();
    this._buildRibbon();
    this._buildRocks();

    this.ctx.scene.add(this.group);
    this._installFallbackLighting();
  }

  // ── cross-section ────────────────────────────────────────────────────────

  _buildColumns() {
    const cols = [];
    // left bank, outermost first
    const last = BANK_SPEC[BANK_SPEC.length - 1];
    cols.push({ kind: BANK, v: -(last[0] + 12), level: MAX_LEVEL, drop: 90 }); // skirt
    for (let i = BANK_SPEC.length - 1; i >= 0; i--) {
      cols.push({ kind: BANK, v: -BANK_SPEC[i][0], level: BANK_SPEC[i][1] });
    }
    for (let i = CHANNEL_U.length - 1; i >= 1; i--) {
      cols.push({ kind: CHANNEL, v: -CHANNEL_U[i], level: 1 });
    }
    for (let i = 0; i < CHANNEL_U.length; i++) {
      cols.push({ kind: CHANNEL, v: CHANNEL_U[i], level: 1 });
    }
    for (let i = 0; i < BANK_SPEC.length; i++) {
      cols.push({ kind: BANK, v: BANK_SPEC[i][0], level: BANK_SPEC[i][1] });
    }
    cols.push({ kind: BANK, v: last[0] + 12, level: MAX_LEVEL, drop: 90 });    // skirt
    this._cols = cols;

    // Indices of the two split columns (one per side) that bound the near shell.
    this._splitLeft = cols.findIndex((c) => c.kind === BANK && c.v === -SPLIT_DIST);
    this._splitRight = cols.findIndex((c) => c.kind === BANK && c.v === SPLIT_DIST);
  }

  /** Metres of extra lift used to close the valley off past the river's ends. */
  _endLift(s) {
    const L = this.river.length;
    const out = s < 0 ? -s : s > L ? s - L : 0;
    if (out <= 0) return 0;
    const t = THREE.MathUtils.smoothstep(out, 4, 145);
    const n = this.river.noise.fbm2(s * 0.02 + 3.3, 61.7, 3);
    return t * 26 * (0.85 + n * 0.3);
  }

  /**
   * `river.bankHeight` saturates into a plateau about 90 m inland — correct for
   * the playable bank, but it leaves nothing on the horizon. Past 80 m a ridged
   * band grows on top of it, reaching ~170 m several hundred metres out, so every
   * wide shot closes on layered ridges sitting in the haze. It fades in from zero,
   * so inside the playable bank the ground still matches the river contract exactly.
   *
   * The noise deliberately varies fast along the river and slowly across it: the
   * ridges then run roughly parallel to the valley (which is what real river
   * valleys look like) and, just as importantly, the ~100 m column spacing out
   * there is enough to resolve them without turning hills into giant slabs.
   */
  _farHills(s, side, dist) {
    if (dist < 80) return 0;
    // The mass is deliberately front-loaded: sky's fog reaches ~97% by 800 m, so a
    // ridge out there is a pure white cut-out against the sky no matter what colour
    // it is. Peaking the relief around 300–400 m puts the ridgelines where haze
    // still lets their own colour through, which is what reads as a hazy hill.
    const t = THREE.MathUtils.smoothstep(dist, 80, 380);
    const n = this.river.noise;
    const k = side > 0 ? 21.7 : 77.3;
    let big = n.ridged2(s * 0.0032 + 5.0, dist * 0.0012 + k, 2);
    big = Math.pow(Math.max(0, big), 1.35) * 92;
    // a second, much longer wave so ridgelines overlap in depth
    big += Math.max(0, n.fbm2(s * 0.0014 + 40.0, dist * 0.0007 + k, 2)) * 48;
    // and a cross-cutting spur system, so the skyline is not one repeated wave.
    // Raised to a power rather than thresholded: a threshold gives hard spikes.
    const spur = Math.max(0, n.ridged2(s * 0.0018 + 88.0, dist * 0.0010 + k, 2));
    big += Math.pow(spur, 2.0) * 46;
    // fine relief that varies only along the valley, where 34 m rows resolve it
    big += n.fbm2(s * 0.0125 + 12.0, dist * 0.0006 + k, 2) * 11;
    return t * Math.max(0, big);
  }

  /**
   * World position (and river coords) of one cross-section sample.
   *
   * `edgeL` / `edgeR` are this station's waterline |u| (see shoreU). Channel
   * columns are a NORMALISED cross parameter now: v = 1 lands exactly on the
   * waterline whatever the bend is doing, so the dense outer columns always sit
   * on the shelf instead of metres out on a dry bar.
   */
  _sample(s, col, out, edgeL = 1, edgeR = 1) {
    const river = this.river;
    const L = river.length;
    const sc = THREE.MathUtils.clamp(s, 0, L);
    const hw = river.halfWidth(sc);
    const edge = col.v < 0 ? edgeL : edgeR;

    let u;
    if (col.kind === CHANNEL) u = col.v * edge;
    else u = Math.sign(col.v) * (1 + Math.abs(col.v) / hw);

    let y = col.kind === CHANNEL ? river.bedHeight(sc, u) : river.bankHeight(sc, u);
    if (col.kind === BANK) y += this._farHills(sc, Math.sign(col.v), Math.abs(col.v));
    y += this._endLift(s);
    if (col.drop) y -= col.drop;

    // Beyond the ends of the curve the ribbon keeps going straight so the shot
    // never sees an open edge.
    if (s < 0 || s > L) {
      const anchor = s < 0 ? 0 : L;
      const over = s - anchor;
      river.point(anchor, out);
      river.tangent(anchor, this._tan);
      river.right(anchor, this._right);
      out.addScaledVector(this._tan, over).addScaledVector(this._right, u * hw);
      out.y = y;
    } else {
      river.toWorld(sc, u, y, out);
    }
    return { u, y, hw, edge };
  }

  /**
   * Signed distance from the waterline in metres, negative inside the channel.
   * Measured from the REAL waterline (edge·hw), not from |u| = 1, which on a
   * bend can be eleven metres of dry bar away from any water.
   */
  _shoreDist(col, info) {
    if (col.kind === CHANNEL) return (Math.abs(info.u) - info.edge) * info.hw;
    return Math.abs(col.v) + (1 - info.edge) * info.hw;
  }

  // ── ribbon ───────────────────────────────────────────────────────────────

  _buildRibbon() {
    const L = this.river.length;
    const sMin = -S_OVERRUN;
    const cells = CHUNK_ROWS * CHUNKS;
    this._sStep = (L + 2 * S_OVERRUN) / cells;
    const rows = cells + 1;

    const grid = this._buildGrid(this._cols, rows, sMin, this._sStep);

    for (let ci = 0; ci < CHUNKS; ci++) {
      const r0 = ci * CHUNK_ROWS;
      const r1 = r0 + CHUNK_ROWS;
      // near shell: the playable corridor, tight bounds, casts shadows
      this._makeChunk(grid, r0, r1, this._splitLeft, this._splitRight, `bank-${ci}`, true);
      // far shell: hills out to the horizon, cheap, no shadow casting
      this._makeChunk(grid, r0, r1, 0, this._splitLeft, `hills-L-${ci}`, false);
      this._makeChunk(grid, r0, r1, this._splitRight, grid.W - 1, `hills-R-${ci}`, false);
    }
  }

  /**
   * Sample the whole grid once — positions, seam-free central-difference normals
   * and per-vertex occlusion — then let the chunk builder reference slices of it.
   * Computing normals globally is what keeps chunk boundaries invisible.
   */
  _buildGrid(cols, rows, sMin, sStep) {
    const W = cols.length;
    const N = W * rows;
    const pos = new Float32Array(N * 3);
    const nrm = new Float32Array(N * 3);
    const ter = new Float32Array(N * 3);
    const p = this._v0;

    const river = this.river;
    for (let r = 0; r < rows; r++) {
      const s = sMin + r * sStep;
      const sc = THREE.MathUtils.clamp(s, 0, river.length);
      const edgeL = shoreU(river, sc, -1);
      const edgeR = shoreU(river, sc, 1);
      for (let c = 0; c < W; c++) {
        const col = cols[c];
        const info = this._sample(s, col, p, edgeL, edgeR);
        const i = (r * W + c) * 3;
        pos[i] = p.x; pos[i + 1] = p.y; pos[i + 2] = p.z;
        ter[i] = this._shoreDist(col, info);
        ter[i + 2] = info.u;
      }
    }

    const ax = new THREE.Vector3();
    const az = new THREE.Vector3();
    const nn = new THREE.Vector3();
    for (let r = 0; r < rows; r++) {
      const rm = Math.max(0, r - 1), rp = Math.min(rows - 1, r + 1);
      for (let c = 0; c < W; c++) {
        const cm = Math.max(0, c - 1), cp = Math.min(W - 1, c + 1);
        const iA = (r * W + cp) * 3, iB = (r * W + cm) * 3;
        const iC = (rp * W + c) * 3, iD = (rm * W + c) * 3;
        ax.set(pos[iA] - pos[iB], pos[iA + 1] - pos[iB + 1], pos[iA + 2] - pos[iB + 2]);
        az.set(pos[iC] - pos[iD], pos[iC + 1] - pos[iD + 1], pos[iC + 2] - pos[iD + 2]);
        nn.crossVectors(ax, az);
        if (nn.lengthSq() < 1e-12) nn.set(0, 1, 0);
        else nn.normalize();
        if (nn.y < 0) nn.negate();
        const i = (r * W + c) * 3;
        nrm[i] = nn.x; nrm[i + 1] = nn.y; nrm[i + 2] = nn.z;
      }
    }

    // Cheap per-vertex occlusion: a vertex below its neighbourhood mean sits in
    // a hollow and sees less sky. Reads as soft valley shading for free.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < W; c++) {
        let sum = 0, n = 0;
        for (let dr = -3; dr <= 3; dr += 3) {
          const rr = THREE.MathUtils.clamp(r + dr, 0, rows - 1);
          for (let dc = -2; dc <= 2; dc += 2) {
            const cc = THREE.MathUtils.clamp(c + dc, 0, W - 1);
            sum += pos[(rr * W + cc) * 3 + 1];
            n++;
          }
        }
        const mean = sum / n;
        const d = pos[(r * W + c) * 3 + 1] - mean;
        const ao = THREE.MathUtils.clamp(0.5 + d / 3.5, 0, 1);
        ter[(r * W + c) * 3 + 1] = 0.46 + 0.54 * ao;
      }
    }

    return { cols, rows, W, pos, nrm, ter };
  }

  /**
   * Build one chunk covering rows [r0, r1] and columns [c0, c1].
   *
   * Each band between adjacent columns is triangulated at the coarser of the two
   * columns' row strides, fanning out to every row on the finer side. That is what
   * removes T-junctions: a column is only ever subdivided at multiples of its own
   * level, no matter which band is looking at it.
   */
  _makeChunk(grid, r0, r1, c0, c1, name, isNear) {
    const { cols, W, pos, nrm, ter } = grid;
    const nr = r1 - r0 + 1;
    const nc = c1 - c0 + 1;
    if (nc < 2) return;

    const map = new Int32Array(nr * nc).fill(-1);
    const gp = [], gn = [], gt = [], idx = [];
    const vertex = (r, c) => {
      const key = (r - r0) * nc + (c - c0);
      let v = map[key];
      if (v >= 0) return v;
      v = gp.length / 3;
      map[key] = v;
      const i = (r * W + c) * 3;
      gp.push(pos[i], pos[i + 1], pos[i + 2]);
      gn.push(nrm[i], nrm[i + 1], nrm[i + 2]);
      gt.push(ter[i], ter[i + 1], ter[i + 2]);
      return v;
    };

    for (let c = c0; c < c1; c++) {
      const kL = cols[c].level, kR = cols[c + 1].level;
      const k = Math.max(kL, kR);
      const kFine = Math.min(kL, kR);
      const fineIsLeft = kL <= kR;
      const fineCol = fineIsLeft ? c : c + 1;
      const coarseCol = fineIsLeft ? c + 1 : c;
      for (let r = r0; r + k <= r1; r += k) {
        const a0 = vertex(r, coarseCol);
        const a1 = vertex(r + k, coarseCol);
        let prev = vertex(r, fineCol);
        for (let rr = r + kFine; rr <= r + k; rr += kFine) {
          const cur = vertex(rr, fineCol);
          if (fineIsLeft) idx.push(prev, a0, cur);
          else idx.push(a0, prev, cur);
          prev = cur;
        }
        if (fineIsLeft) idx.push(prev, a0, a1);
        else idx.push(a0, prev, a1);
      }
    }
    if (!idx.length) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(gp), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(gn), 3));
    geo.setAttribute('aTerrain', new THREE.BufferAttribute(new Float32Array(gt), 3));
    const nv = gp.length / 3;
    geo.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(idx, 1)
      : new THREE.Uint16BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = name;
    mesh.receiveShadow = true;
    mesh.castShadow = isNear;   // the far hills are too big to be worth shadowing
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    this._geometries.push(geo);
    (isNear ? this.nearMeshes : this.farMeshes).push(mesh);
  }

  // ── boulders ─────────────────────────────────────────────────────────────

  /** A deformed icosahedron: lumpy, flat-bottomed, no hint of a sphere left. */
  _makeBoulder(detail, seed) {
    const geo = new THREE.IcosahedronGeometry(1, detail);
    geo.deleteAttribute('uv');
    const rnd = makeRandom(seed);
    const noise = this.river.noise;
    const ax = 1 + rnd() * 0.75;
    const ay = 0.52 + rnd() * 0.5;
    const az = 1 + rnd() * 0.75;
    const off = rnd() * 90;
    const off2 = rnd() * 90;
    const tiltX = (rnd() - 0.5) * 0.5;
    const tiltZ = (rnd() - 0.5) * 0.5;
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).normalize();
      let r = 1;
      r += noise.fbm3(v.x * 1.35 + off, v.y * 1.35, v.z * 1.35 + off, 3) * 0.34;
      r += noise.fbm3(v.x * 3.6 + off2, v.y * 3.6, v.z * 3.6, 3) * 0.13;
      r += noise.fbm3(v.x * 9.0, v.y * 9.0 + off2, v.z * 9.0, 2) * 0.05;
      let x = v.x * ax * r;
      let y = v.y * ay * r;
      let z = v.z * az * r;
      // shear a little so it does not read as a symmetric lump
      x += y * tiltX;
      z += y * tiltZ;
      // sit it down on a flattish base
      if (y < -0.34) y = -0.34 + (y + 0.34) * 0.32;
      pos.setXYZ(i, x, y, z);
    }
    geo.computeVertexNormals();   // non-indexed → faceted planes, good for rock
    geo.computeBoundingSphere();
    let rad = 0;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      rad = Math.max(rad, v.length());
    }
    geo.userData.radius = rad;
    this._geometries.push(geo);
    return geo;
  }

  _buildRocks() {
    const river = this.river;
    const L = river.length;
    const rnd = makeRandom(0x0b0c1de);

    // Six shapes. Instances are bucketed along s (see below) so a chunk of river
    // can be frustum-culled — that is what pays for the extra tessellation here.
    const shapes = [
      { geo: this._makeBoulder(2, 1101), items: [] },
      { geo: this._makeBoulder(2, 2203), items: [] },
      { geo: this._makeBoulder(2, 3307), items: [] },
      { geo: this._makeBoulder(2, 4409), items: [] },
      { geo: this._makeBoulder(3, 5501), items: [] },
      { geo: this._makeBoulder(3, 6607), items: [] },
    ];
    const small = [0, 1, 2];
    const mid = [3, 4];
    const hero = 5;

    const p = new THREE.Vector3();
    const S_BUCKETS = 7;
    const push = (bucket, s, position, scale, radius, submerged) => {
      shapes[bucket].items.push({
        bucket: Math.min(S_BUCKETS - 1, Math.floor((s / L) * S_BUCKETS)),
        position: position.clone(),
        scale,
        rotY: rnd() * Math.PI * 2,
        tilt: (rnd() - 0.5) * 0.42,
        tilt2: (rnd() - 0.5) * 0.42,
        var1: rnd(),
        var2: rnd(),
      });
      this.rocks.push({ position: position.clone(), radius: radius, submerged });
    };

    // 1. rocks strewn along the banks
    const bankCount = 340;
    for (let i = 0; i < bankCount; i++) {
      const s = rnd() * L;
      const side = rnd() < 0.5 ? -1 : 1;
      const d = 0.3 + Math.pow(rnd(), 1.8) * 15;
      const hw = river.halfWidth(s);
      const u = side * (1 + d / hw);
      const y = river.bankHeight(s, u);
      // clumpy, not uniform: reject in the gaps
      if (river.noise.fbm2(s * 0.05, side * 12.7, 2) < -0.18) continue;
      const scale = 0.18 + Math.pow(rnd(), 2.3) * 1.45;
      const bucket = scale > 1.0 ? mid[(rnd() * mid.length) | 0] : small[(rnd() * small.length) | 0];
      river.toWorld(s, u, y - scale * (0.14 + rnd() * 0.18), p);
      push(bucket, s, p, scale, scale, false);
    }

    // 2. rocks in the fast shallows — where the flow actually shifts gravel
    const shallowCount = 210;
    for (let i = 0; i < shallowCount; i++) {
      const s = rnd() * L;
      const side = rnd() < 0.5 ? -1 : 1;
      const u = side * (0.52 + rnd() * 0.46);
      const speed = river.flowAt(s, u, this._flow).length();
      if (speed < 0.85 && rnd() > 0.25) continue;
      const depth = river.depth(s, u);
      const scale = 0.2 + Math.pow(rnd(), 2.0) * 1.15;
      const y = river.bedHeight(s, u) - scale * (0.18 + rnd() * 0.20);
      river.toWorld(s, u, y, p);
      const bucket = scale > 0.95 ? mid[(rnd() * mid.length) | 0] : small[(rnd() * small.length) | 0];
      push(bucket, s, p, scale, scale, depth > 0.15);
    }

    // 3. hero boulders midstream at the riffles, big enough to break the water
    const riffles = [];
    for (let i = 0; i < 500; i++) {
      const s = 30 + (i / 499) * (L - 60);
      riffles.push({ s, d: river.depth(s, 0) });
    }
    riffles.sort((a, b) => a.d - b.d);
    const chosen = [];
    for (const cand of riffles) {
      if (chosen.length >= 16) break;
      if (chosen.some((c) => Math.abs(c - cand.s) < 70)) continue;
      chosen.push(cand.s);
    }
    for (const s of chosen) {
      const u = (rnd() - 0.5) * 0.95;
      const bed = river.bedHeight(s, u);
      const depth = Math.max(0, this.waterLevel - bed);
      const scale = Math.max(1.5, depth * 1.35 + 0.9 + rnd() * 1.4);
      const y = Math.min(bed - scale * 0.18, this.waterLevel + 0.55 + rnd() * 0.7 - scale);
      river.toWorld(s, u, y, p);
      push(hero, s, p, scale, scale, true);
      // a couple of smaller companions so it reads as an outcrop, not a prop
      const extras = 1 + ((rnd() * 3) | 0);
      for (let k = 0; k < extras; k++) {
        const u2 = THREE.MathUtils.clamp(u + (rnd() - 0.5) * 0.5, -0.95, 0.95);
        const s2 = s + (rnd() - 0.5) * 9;
        const b2 = river.bedHeight(s2, u2);
        const sc2 = scale * (0.28 + rnd() * 0.42);
        river.toWorld(s2, u2, b2 - sc2 * 0.18, p);
        push(mid[(rnd() * mid.length) | 0], s2, p, sc2, sc2, true);
      }
    }

    // ── bake to instanced meshes, one per (shape, river segment) ──
    // A single InstancedMesh spanning 2 km can never be frustum-culled, so every
    // boulder in the world would be submitted every frame. Splitting by river
    // segment keeps the submitted set to what is actually in front of the camera.
    for (let si = 0; si < shapes.length; si++) {
      const { geo, items } = shapes[si];
      if (!items.length) continue;
      // aRockVar is per-instance, so each segment needs its own geometry view.
      // Sharing the index/position buffers keeps that free of extra memory.
      for (let b = 0; b < S_BUCKETS; b++) {
        const group = items.filter((it) => it.bucket === b);
        if (!group.length) continue;
        const segGeo = si === 0 && b === 0 ? geo : geo.clone();
        if (segGeo !== geo) this._geometries.push(segGeo);
        const mesh = new THREE.InstancedMesh(segGeo, this.rockMaterial, group.length);
        const rockVar = new Float32Array(group.length * 2);
        for (let i = 0; i < group.length; i++) {
          const it = group[i];
          this._eu.set(it.tilt, it.rotY, it.tilt2);
          this._q.setFromEuler(this._eu);
          this._sc.setScalar(it.scale);
          this._mat.compose(it.position, this._q, this._sc);
          mesh.setMatrixAt(i, this._mat);
          rockVar[i * 2] = it.var1;
          rockVar[i * 2 + 1] = it.var2;
        }
        segGeo.setAttribute('aRockVar', new THREE.InstancedBufferAttribute(rockVar, 2));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = `boulders-${si}-${b}`;
        mesh.computeBoundingSphere();
        this.group.add(mesh);
        this.rockMeshes.push(mesh);
      }
    }
  }

  // ── public hooks ─────────────────────────────────────────────────────────

  /**
   * Project the water's caustics texture onto the submerged ground.
   * Called by world/underwater.js; also picked up automatically from
   * `ctx.water.causticsTexture` if nobody calls it.
   *
   * @param {THREE.Texture} texture
   * @param {{scale?:number, strength?:number, speed?:number, falloff?:number,
   *          tint?:THREE.Color}} [params]
   */
  setCaustics(texture, params = {}) {
    if (!this._uniforms) return;
    const p = this._uniforms.uCaustParams.value;
    if (texture) {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      this._uniforms.uCaustics.value = texture;
      this._rockUniforms.uCaustics.value = texture;
      if (p.y <= 0) p.y = 1.0;
    }
    if (params.scale !== undefined) p.x = params.scale;
    if (params.strength !== undefined) p.y = params.strength;
    if (params.speed !== undefined) p.z = params.speed;
    if (params.falloff !== undefined) p.w = params.falloff;
    if (params.tint) this._uniforms.uCaustTint.value.copy(params.tint);
    this._rockUniforms.uCaustParams.value.copy(p);
    this._rockUniforms.uCaustTint.value.copy(this._uniforms.uCaustTint.value);
    this._causticsSet = true;
  }

  /** Ground height anywhere — thin wrapper so callers need not build a Vector3. */
  heightAt(x, z) {
    this._v1.set(x, 0, z);
    return this.river.groundAt(this._v1, this._riverCoord);
  }

  // ── standalone lighting fallback ─────────────────────────────────────────
  // Sky owns lighting. If it is missing or still a stub the banks would render
  // pitch black, so a placeholder sun goes in and is retired the moment the real
  // sky shows up.
  _installFallbackLighting() {
    // Aerial perspective is not optional for this art direction. Sky owns the
    // fog, but if it has not set any we put a placeholder in rather than render
    // hard-edged hills against the sky, and step aside as soon as sky sets its own.
    if (!this.ctx.scene.fog) {
      this._fallbackFog = new THREE.FogExp2(0x93aabd, 0.0009);
      this.ctx.scene.fog = this._fallbackFog;
    }
    if (this.ctx.sky?.sunLight) return;
    const sun = new THREE.DirectionalLight(0xffe4b8, 3.1);
    sun.position.set(-120, 78, -190);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -70; c.right = 70; c.top = 70; c.bottom = -70;
    c.near = 1; c.far = 420;
    sun.shadow.bias = -0.0006;
    const hemi = new THREE.HemisphereLight(0xa8d8f0, 0x4c5a44, 1.15);
    this.ctx.scene.add(sun, hemi);
    this._fallbackLights.push(sun, hemi);
  }

  _retireFallbackLighting() {
    for (const l of this._fallbackLights) {
      this.ctx.scene.remove(l);
      l.dispose?.();
    }
    this._fallbackLights.length = 0;
    if (this._fallbackFog && this.ctx.scene.fog === this._fallbackFog) {
      this.ctx.scene.fog = null;
    }
    this._fallbackFog = null;
  }

  update(dt, elapsed) {
    const u = this._uniforms;
    if (!u) return;
    u.uTime.value = elapsed;
    this._rockUniforms.uTime.value = elapsed;

    const sun = this.ctx.sky?.sunDirection;
    if (sun) {
      u.uSunDir.value.copy(sun);
      this._rockUniforms.uSunDir.value.copy(sun);
    }

    if (this._fallbackLights.length && this.ctx.sky?.sunLight) {
      for (const l of this._fallbackLights) {
        this.ctx.scene.remove(l);
        l.dispose?.();
      }
      this._fallbackLights.length = 0;
    }
    // Keep the placeholder haze matched to whatever colour the sky is showing.
    if (this._fallbackFog && this.ctx.scene.fog === this._fallbackFog) {
      const c = this.ctx.sky?.fogColor ?? this.ctx.sky?.horizonColor;
      if (c) this._fallbackFog.color.copy(c);
    }

    // Adopt the water's caustics automatically if underwater never wired them.
    if (!this._causticsSet) {
      const tex = this.ctx.water?.causticsTexture;
      if (tex) this.setCaustics(tex);
    }
  }

  dispose() {
    this.ctx.scene.remove(this.group);
    for (const g of this._geometries) g.dispose();
    this._geometries.length = 0;
    for (const t of this.material?.userData?.ownedTextures ?? []) t.dispose();
    this.material?.dispose();
    this.rockMaterial?.dispose();
    this._retireFallbackLighting();
    this.nearMeshes.length = 0;
    this.farMeshes.length = 0;
    this.rockMeshes.length = 0;
    this.rocks.length = 0;
  }
}
