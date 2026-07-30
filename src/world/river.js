import * as THREE from 'three';
import { Noise, makeRandom } from '../core/noise.js';
import { WATER_LEVEL } from '../core/settings.js';

/**
 * The River is the geometric authority for the whole world.
 *
 * Every other system — water surface, banks, reeds, fish, the duck family —
 * asks the river where things are instead of inventing its own geometry. That
 * is what keeps the reeds standing in the shallows and the fish inside the
 * channel.
 *
 * Coordinates
 *   s : arc length along the centerline, 0 .. length (downstream is +s)
 *   u : signed fraction across the channel, -1 (left bank) .. +1 (right bank)
 *   y : world height. The still water plane sits at WATER_LEVEL.
 *
 * The centerline advances broadly along +Z and meanders in X.
 */
export class River {
  constructor({ seed = 20260730, length = 2000, baseWidth = 26 } = {}) {
    this.seed = seed;
    this.noise = new Noise(seed);
    this.random = makeRandom(seed ^ 0x5eed);
    this.waterLevel = WATER_LEVEL;
    this.baseHalfWidth = baseWidth * 0.5;
    this.maxDepth = 6.2;
    this.targetLength = length;

    // Scratch vectors so the hot query paths never allocate. Declared before
    // construction because _placePools() already uses toWorld().
    this._scratchRight = new THREE.Vector3();
    this._scratchFlow = new THREE.Vector3();

    this._buildCenterline(length);
    this._buildWidthProfile();
    this._buildLookup();
    this._placePools();
  }

  // ── construction ─────────────────────────────────────────────────────────

  _buildCenterline(length) {
    const pts = [];
    const span = 26; // control point spacing along Z
    const count = Math.ceil(length / span) + 4;
    for (let i = 0; i < count; i++) {
      const z = (i - 1) * span;
      const t = z * 0.0042;
      // Two octaves of meander: long sweeping bends plus gentle wandering.
      const x =
        Math.sin(t * 1.7) * 34 +
        this.noise.fbm2(t * 1.15, 11.3, 3) * 30 +
        Math.sin(t * 4.3 + 1.2) * 6;
      pts.push(new THREE.Vector3(x, WATER_LEVEL, z));
    }
    this.curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    this.curve.arcLengthDivisions = Math.max(2000, count * 12);
    this.length = this.curve.getLength();
  }

  _buildWidthProfile() {
    // Half-width sampled on a coarse table then read with smooth interpolation.
    const n = 512;
    this._widthTable = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = (i / (n - 1)) * this.length;
      const t = s * 0.0031;
      // Alternating narrow runs and broad calm pools.
      const broad = this.noise.fbm2(t, 4.7, 3);
      const run = Math.sin(t * 2.1 + 0.7) * 0.5 + Math.sin(t * 5.3) * 0.18;
      let w = this.baseHalfWidth * (1 + broad * 0.42 + run * 0.22);
      // The river opens up as it matures downstream.
      w *= 1 + (s / this.length) * 0.35;
      this._widthTable[i] = Math.max(6.5, w);
    }
    // A couple of smoothing passes: abrupt width jumps read as bad geometry.
    for (let pass = 0; pass < 3; pass++) {
      const copy = this._widthTable.slice();
      for (let i = 1; i < n - 1; i++) {
        this._widthTable[i] = (copy[i - 1] + copy[i] * 2 + copy[i + 1]) * 0.25;
      }
    }
  }

  /**
   * Dense polyline samples plus a Z bucket index, so world→river lookups are
   * O(bucket) instead of O(curve).
   */
  _buildLookup() {
    const step = 1.0;
    const n = Math.ceil(this.length / step) + 1;
    this._sampleStep = this.length / (n - 1);
    this._sx = new Float32Array(n);
    this._sz = new Float32Array(n);
    this._tx = new Float32Array(n);
    this._tz = new Float32Array(n);
    const p = new THREE.Vector3();
    const tan = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      this.curve.getPointAt(u, p);
      this.curve.getTangentAt(u, tan);
      tan.y = 0;
      tan.normalize();
      this._sx[i] = p.x;
      this._sz[i] = p.z;
      this._tx[i] = tan.x;
      this._tz[i] = tan.z;
    }
    this._sampleCount = n;

    // Bucket samples by Z so a query only tests a local slice.
    this._bucketSize = 20;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      if (this._sz[i] < minZ) minZ = this._sz[i];
      if (this._sz[i] > maxZ) maxZ = this._sz[i];
    }
    this._minZ = minZ;
    this._maxZ = maxZ;
    const buckets = Math.ceil((maxZ - minZ) / this._bucketSize) + 1;
    this._buckets = Array.from({ length: buckets }, () => []);
    for (let i = 0; i < n; i++) {
      const b = Math.floor((this._sz[i] - minZ) / this._bucketSize);
      this._buckets[b].push(i);
      // Also register in neighbours: a bend can put a nearby point one over.
      if (b > 0) this._buckets[b - 1].push(i);
      if (b < buckets - 1) this._buckets[b + 1].push(i);
    }
  }

  _placePools() {
    // Wide, slow stretches: good fishing, good quest anchors.
    this.pools = [];
    const n = 9;
    for (let i = 0; i < n; i++) {
      const s = this.length * ((i + 0.5) / n) + (this.random() - 0.5) * 40;
      const sc = THREE.MathUtils.clamp(s, 40, this.length - 40);
      this.pools.push({
        s: sc,
        radius: this.halfWidth(sc) * (0.7 + this.random() * 0.5),
        position: this.toWorld(sc, (this.random() - 0.5) * 0.5, WATER_LEVEL),
        fishDensity: 0.6 + this.random() * 0.8,
      });
    }
  }

  // ── centerline queries ───────────────────────────────────────────────────

  /** Centerline point at arc length s. */
  point(s, target = new THREE.Vector3()) {
    const u = THREE.MathUtils.clamp(s / this.length, 0, 1);
    return this.curve.getPointAt(u, target);
  }

  /** Unit downstream direction at s (horizontal). */
  tangent(s, target = new THREE.Vector3()) {
    const u = THREE.MathUtils.clamp(s / this.length, 0, 1);
    this.curve.getTangentAt(u, target);
    target.y = 0;
    return target.normalize();
  }

  /**
   * Unit vector from the centerline toward the +u bank: tangent × up, i.e. the
   * right-hand side when facing downstream.
   */
  right(s, target = new THREE.Vector3()) {
    this.tangent(s, target);
    return target.set(-target.z, 0, target.x).normalize();
  }

  /** Half-width of open water at s, in world units. */
  halfWidth(s) {
    const n = this._widthTable.length;
    const f = THREE.MathUtils.clamp(s / this.length, 0, 1) * (n - 1);
    const i = Math.floor(f);
    const j = Math.min(n - 1, i + 1);
    const k = f - i;
    return this._widthTable[i] * (1 - k) + this._widthTable[j] * k;
  }

  width(s) {
    return this.halfWidth(s) * 2;
  }

  // ── coordinate conversion ────────────────────────────────────────────────

  /** (s, u, y) → world position. */
  toWorld(s, u, y = WATER_LEVEL, target = new THREE.Vector3()) {
    const p = this.point(s, target);
    const r = this.right(s, this._scratchRight);
    p.addScaledVector(r, u * this.halfWidth(s));
    p.y = y;
    return p;
  }

  /**
   * World position → { s, u, distance }.
   * `distance` is the perpendicular distance to the centerline in world units,
   * signed the same way as u.
   */
  toRiver(worldPos, out = { s: 0, u: 0, distance: 0 }) {
    const px = worldPos.x, pz = worldPos.z;
    const b = Math.floor((pz - this._minZ) / this._bucketSize);
    const bucket = this._buckets[THREE.MathUtils.clamp(b, 0, this._buckets.length - 1)];

    let bestI = 0;
    let bestD = Infinity;
    if (bucket && bucket.length) {
      for (let k = 0; k < bucket.length; k++) {
        const i = bucket[k];
        const dx = px - this._sx[i];
        const dz = pz - this._sz[i];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; bestI = i; }
      }
    } else {
      // Off the ends of the river: fall back to a strided global scan.
      for (let i = 0; i < this._sampleCount; i += 4) {
        const dx = px - this._sx[i];
        const dz = pz - this._sz[i];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; bestI = i; }
      }
    }

    // Refine against the two adjacent segments for sub-sample accuracy.
    let s = bestI * this._sampleStep;
    let signedDist = 0;
    let bestErr = Infinity;
    for (let o = -1; o <= 0; o++) {
      const i = bestI + o;
      const j = i + 1;
      if (i < 0 || j >= this._sampleCount) continue;
      const ax = this._sx[i], az = this._sz[i];
      const bx = this._sx[j], bz = this._sz[j];
      const ex = bx - ax, ez = bz - az;
      const len2 = ex * ex + ez * ez;
      if (len2 < 1e-9) continue;
      let t = ((px - ax) * ex + (pz - az) * ez) / len2;
      t = THREE.MathUtils.clamp(t, 0, 1);
      const cx = ax + ex * t, cz = az + ez * t;
      const dx = px - cx, dz = pz - cz;
      const err = dx * dx + dz * dz;
      if (err < bestErr) {
        bestErr = err;
        s = (i + t) * this._sampleStep;
        // Sign via the cross product of tangent and offset.
        const tx = this._tx[i], tz = this._tz[i];
        const cross = tx * dz - tz * dx;
        signedDist = Math.sqrt(err) * Math.sign(cross || 1);
      }
    }

    s = THREE.MathUtils.clamp(s, 0, this.length);
    out.s = s;
    out.distance = signedDist;
    out.u = signedDist / this.halfWidth(s);
    return out;
  }

  // ── bed and banks ────────────────────────────────────────────────────────

  /**
   * Water depth (positive, metres) at river coords. Zero once you are past the
   * waterline. Deep mid-channel, shelving to nothing at the banks, with pools.
   */
  depth(s, u) {
    const a = Math.abs(u);
    if (a >= 1) return 0;
    // Asymmetric channel: the outside of a bend scours deeper.
    const bend = this.curvature(s);
    const skew = THREE.MathUtils.clamp(bend * 26, -0.45, 0.45);
    const uu = THREE.MathUtils.clamp((u - skew) / (1 - Math.abs(skew) * 0.6), -1, 1);
    let profile = Math.pow(Math.max(0, 1 - uu * uu), 0.62);
    // Local scour and bars.
    const n = this.noise.fbm2(s * 0.02, u * 1.6 + 30.2, 3);
    profile *= 1 + n * 0.22;
    let d = this.maxDepth * profile;
    // Pools deepen, riffles shallow out.
    d *= 1 + this.noise.noise2(s * 0.006, 71.5) * 0.35;
    // Feather the very edge so nothing pops through the surface.
    d *= THREE.MathUtils.smoothstep(1 - a, 0, 0.06);
    return Math.max(0, d);
  }

  /** World Y of the river bed under a given river coordinate. */
  bedHeight(s, u) {
    const a = Math.abs(u);
    if (a <= 1) return this.waterLevel - this.depth(s, u);
    return this.bankHeight(s, u);
  }

  /**
   * World Y of the dry land at river coords with |u| > 1. Rises out of the
   * water gently at first, then climbs into the treeline.
   */
  bankHeight(s, u) {
    const a = Math.abs(u);
    const over = Math.max(0, a - 1); // 0 at the waterline
    const hw = this.halfWidth(s);
    const dist = over * hw; // metres inland

    // Beach → bank → hillside.
    const beach = THREE.MathUtils.smoothstep(dist, 0, 3.0) * 0.55;
    const bank = THREE.MathUtils.smoothstep(dist, 1.5, 14) * 2.6;
    const hill = THREE.MathUtils.smoothstep(dist, 10, 90) * 16;

    // Terrain character. Two scales of rolling ground plus rockier ridges.
    const wx = s * 0.014;
    const wz = (u > 0 ? 1 : -1) * dist * 0.014;
    const roll = this.noise.fbm2(wx, wz + 4.1, 4) * 3.2;
    const ridge = this.noise.ridged2(wx * 0.5, wz * 0.5 + 12.0, 3) * 5.0;
    const detail = this.noise.fbm2(wx * 6, wz * 6, 3) * 0.35;

    let h =
      this.waterLevel +
      beach +
      bank +
      hill +
      roll * THREE.MathUtils.smoothstep(dist, 2, 30) +
      ridge * THREE.MathUtils.smoothstep(dist, 18, 80) +
      detail * THREE.MathUtils.smoothstep(dist, 0.5, 6);

    // Occasional low sandy spits and inlets keep the bank line from reading
    // as a single extruded ribbon.
    const inlet = this.noise.noise2(s * 0.008, u > 0 ? 90.3 : 140.7);
    if (inlet > 0.55) {
      h -= (inlet - 0.55) * 4.5 * THREE.MathUtils.smoothstep(dist, 0, 12);
    }
    return h;
  }

  /** Ground height for any world position, water or land. */
  groundAt(worldPos, scratch = { s: 0, u: 0, distance: 0 }) {
    const r = this.toRiver(worldPos, scratch);
    return this.bedHeight(r.s, r.u);
  }

  /** Signed curvature of the centerline at s (1/metres, + turning right). */
  curvature(s) {
    const h = 4;
    const a = this._tangentFast(Math.max(0, s - h));
    const b = this._tangentFast(Math.min(this.length, s + h));
    const cross = a.x * b.z - a.z * b.x;
    return -cross / (2 * h);
  }

  _tangentFast(s) {
    const i = THREE.MathUtils.clamp(
      Math.round(s / this._sampleStep), 0, this._sampleCount - 1
    );
    return { x: this._tx[i], z: this._tz[i] };
  }

  // ── flow ─────────────────────────────────────────────────────────────────

  /**
   * Current velocity (m/s) at a world position. Fast mid-channel, slack at the
   * banks, faster where the river narrows, with slow eddies for character.
   */
  flow(worldPos, target = new THREE.Vector3(), scratch = { s: 0, u: 0, distance: 0 }) {
    const r = this.toRiver(worldPos, scratch);
    return this.flowAt(r.s, r.u, target);
  }

  flowAt(s, u, target = new THREE.Vector3()) {
    const a = Math.min(1, Math.abs(u));
    // Continuity: narrow reaches run faster.
    const speedFromWidth = (this.baseHalfWidth / this.halfWidth(s)) ** 0.9;
    // Parabolic-ish cross-channel profile with a no-slip edge.
    const profile = Math.pow(Math.max(0, 1 - a * a), 0.5);
    const base = 1.35 * speedFromWidth * profile;
    this.tangent(s, target).multiplyScalar(base);

    // Eddies: a divergence-free-ish swirl from noise, strongest near banks.
    const eddy = this.noise.fbm2(s * 0.03, u * 2.0 + 7.7, 3);
    const across = this.right(s, this._scratchFlow);
    target.addScaledVector(across, eddy * 0.35 * (0.3 + a * 0.9));
    return target;
  }

  /** Convenience: is this world position over open water? */
  isOverWater(worldPos, scratch = { s: 0, u: 0, distance: 0 }) {
    const r = this.toRiver(worldPos, scratch);
    return Math.abs(r.u) < 1 && r.s > 0 && r.s < this.length;
  }

  /** Nearest pool to an arc-length position. */
  poolNear(s) {
    let best = this.pools[0];
    let bestD = Infinity;
    for (const p of this.pools) {
      const d = Math.abs(p.s - s);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }
}
