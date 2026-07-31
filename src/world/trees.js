/**
 * Trees — the silhouette layer.
 *
 * Owned by the vegetation system (CONTRACT.md ownership table); `Vegetation`
 * constructs this, hands it the shared wind, and drives its update.
 *
 * What matters here is the SHAPE against the sky, so trees are grown rather
 * than assembled from primitives:
 *
 *   • a skeleton of tapered, curving tubes with three levels of branching,
 *     side shoots along each parent rather than only at its tip, so the bare
 *     structure already reads as a tree;
 *   • a canopy of leaf CARDS — small alpha-cut quads scattered through a set of
 *     overlapping lobes, each card shaded with the lobe's *spherical* normal
 *     rather than its own flat one. That is the difference between a soft
 *     rounded crown and the faceted lollipop that a low-poly sphere gives you;
 *   • ambient occlusion baked into the leaf colour so crowns are dark
 *     underneath and luminous on top;
 *   • willows that lean out over the water and hang long trailing fronds.
 *
 * Everything is merged into a handful of chunk meshes along the river (two
 * draw calls each: bark and leaf) and frustum/distance culled. Wind comes from
 * the vegetation system's shared `vegWind`, with the canopy LAGGING the trunk
 * and the willow fronds lagging further still, so a gust visibly travels up
 * and out through the tree.
 */

import * as THREE from 'three';
import { makeRandom } from '../core/noise.js';

const clamp = THREE.MathUtils.clamp;
const smoothstep = THREE.MathUtils.smoothstep;
const lerp = THREE.MathUtils.lerp;

const CHUNKS = 10;
const CULL_DIST = 430;
const SHADOW_DIST = 160;
// Beyond this a tree contributes nothing readable to the planar water
// reflection, so it is moved off the reflected layer entirely.
const REFLECT_DIST = 185;

// ── procedural leaf atlas ──────────────────────────────────────────────────

/** One pointed leaf, drawn around the origin along +x. */
function leafPath(g, len, wid) {
  g.beginPath();
  g.moveTo(-len, 0);
  g.quadraticCurveTo(-len * 0.1, -wid, len, 0);
  g.quadraticCurveTo(-len * 0.1, wid, -len, 0);
  g.closePath();
}

function drawCluster(g, ox, oy, size, rng, style) {
  const cx = ox + size * 0.5;
  const cy = oy + size * 0.5;
  const R = size * 0.46;
  const lobes = 3 + ((rng() * 3) | 0);
  const lobePhase = rng() * 6.283;
  const n = 46 + ((rng() * 26) | 0);
  const leafLen = size * (style === 3 ? 0.10 : 0.135);
  for (let i = 0; i < n; i++) {
    const ang = rng() * 6.283;
    // lobed boundary keeps the silhouette from being a circle
    const lobe = 0.68 + 0.32 * Math.sin(ang * lobes + lobePhase);
    const rr = R * lobe * Math.pow(rng(), 0.55);
    const x = cx + Math.cos(ang) * rr;
    const y = cy + Math.sin(ang) * rr * 0.86;
    const l = leafLen * (0.6 + rng() * 0.7);
    const w = l * (0.30 + rng() * 0.22);
    // depth shading inside the cluster: leaves near the rim catch light
    const d = clamp(rr / R, 0, 1);
    const v = 118 + d * 96 + rng() * 40;
    const warm = 0.86 + rng() * 0.22;
    g.save();
    g.translate(x, y);
    g.rotate(rng() * 6.283);
    g.fillStyle = `rgb(${(v * warm) | 0},${(v * 1.02) | 0},${(v * 0.66) | 0})`;
    leafPath(g, l, w);
    g.fill();
    g.restore();
  }
}

function drawFrond(g, ox, oy, size, rng) {
  const strands = 4;
  for (let s = 0; s < strands; s++) {
    const x0 = ox + size * (0.14 + s * 0.24) + (rng() - 0.5) * size * 0.05;
    g.strokeStyle = 'rgb(126,132,84)';
    g.lineWidth = Math.max(1, size * 0.006);
    g.beginPath();
    g.moveTo(x0, oy + size * 0.02);
    const bend = (rng() - 0.5) * size * 0.1;
    g.quadraticCurveTo(x0 + bend, oy + size * 0.5, x0 + bend * 1.6, oy + size * 0.98);
    g.stroke();
    const n = 26;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const px = x0 + bend * 2 * t * (1 - t) * 2 + bend * t * t * 1.6;
      const py = oy + size * (0.02 + t * 0.96);
      const l = size * 0.075 * (0.55 + rng() * 0.6) * (1 - t * 0.35);
      const w = l * 0.20;
      const v = 128 + (1 - t) * 70 + rng() * 40;
      g.save();
      g.translate(px, py);
      g.rotate((rng() < 0.5 ? 1 : -1) * (0.5 + rng() * 0.5) + Math.PI * 0.5);
      g.fillStyle = `rgb(${(v * 0.94) | 0},${(v * 1.02) | 0},${(v * 0.66) | 0})`;
      leafPath(g, l, w);
      g.fill();
      g.restore();
    }
  }
}

function makeLeafAtlas(size, seed) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, size, size);
  const rng = makeRandom(seed);
  const half = size / 2;
  drawCluster(g, 0, 0, half, rng, 0);
  drawCluster(g, half, 0, half, rng, 1);
  drawCluster(g, 0, half, half, rng, 2);
  drawFrond(g, half, half, half, rng);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

// UV rects for the four atlas tiles, inset so mipmaps never bleed across.
const TILES = [
  [0.006, 0.006, 0.488, 0.488],
  [0.506, 0.006, 0.488, 0.488],
  [0.006, 0.506, 0.488, 0.488],
];
const FROND_TILE = [0.506, 0.506, 0.488, 0.488];

// ── geometry accumulation ──────────────────────────────────────────────────

class Buf {
  constructor(withUV) {
    this.pos = [];
    this.nrm = [];
    this.col = [];
    this.uv = withUV ? [] : null;
    this.wind = []; // vec4 originX, originZ, phase, sway
    this.lag = [];
    this.card = withUV ? [] : null; // vec3 offset from the card centre
    this.idx = [];
  }
  get count() { return this.pos.length / 3; }
  vert(p, n, c, u, v, w, card) {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.col.push(c.r, c.g, c.b);
    if (this.uv) this.uv.push(u, v);
    this.wind.push(w[0], w[1], w[2], w[3]);
    this.lag.push(w[4]);
    if (this.card) this.card.push(card ? card.x : 0, card ? card.y : 0, card ? card.z : 0);
  }
  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.wind, 4));
    g.setAttribute('aLag', new THREE.Float32BufferAttribute(this.lag, 1));
    if (this.card) g.setAttribute('aCard', new THREE.Float32BufferAttribute(this.card, 3));
    const IndexArray = this.count > 65535 ? Uint32Array : Uint16Array;
    g.setIndex(new THREE.BufferAttribute(new IndexArray(this.idx), 1));
    g.computeBoundingSphere();
    return g;
  }
}

// ── the system ─────────────────────────────────────────────────────────────

export class Trees {
  constructor(ctx, shared) {
    this.ctx = ctx;
    this.river = ctx.river;
    this.shared = shared;
    this.group = new THREE.Group();
    this.group.name = 'trees';
    this.chunks = [];
    this._geoms = [];
    this._mats = [];
    this._camPos = new THREE.Vector3();
    this.trees = [];

    // scratch used only during the (one-off) build
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._c = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._col = new THREE.Color();
  }

  async init() {
    const q = this.ctx.settings?.quality ?? {};
    this.count = Math.max(8, q.treeCount ?? 80);
    this.noReflectLayer = this.shared.noReflectLayer ?? 11;
    this.atlas = makeLeafAtlas(q.name === 'low' ? 256 : 512, 5150);
    this.atlas.anisotropy = Math.min(4, this.ctx.engine?.maxAnisotropy ?? 1);

    this._makeMaterials();
    this._place();
    this._build();
    this.ctx.scene.add(this.group);
  }

  // ── materials ────────────────────────────────────────────────────────────

  _windVertexChunk(isLeaf) {
    return /* glsl */ `
  vec3 transformed = vec3( position );
  ${isLeaf ? `
  vec3 cardCentre = transformed - aCard;
  float dcam = distance(cardCentre, uCamPos);
  // cards grow slightly with distance so a canopy never fizzes into holes
  transformed = cardCentre + aCard * (1.0 + smoothstep(45.0, 240.0, dcam) * 0.85);
  ` : ''}
  vec2 w = vegWind(aWind.xy, uWindPhase + aWind.z - aLag * uLag);
  float sway = aWind.w;
  transformed.xz += w * sway * uTreeBend;
  transformed.y -= dot(w, w) * sway * sway * 0.018;
`;
  }

  _patch(mat, isLeaf, depth) {
    const u = this.shared.uniforms;
    const extra = {
      uTreeBend: { value: 0.30 },
      uLag: { value: 0.55 },
    };
    this._extra = this._extra || extra;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u, this._extra);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
${this.shared.windDecl}
uniform float uTreeBend;
uniform float uLag;
attribute vec4 aWind;
attribute float aLag;
${isLeaf ? 'attribute vec3 aCard;' : ''}
${depth ? '' : 'varying float vLeafLag;'}
${this.shared.windGlsl}`
        )
        .replace('#include <begin_vertex>', this._windVertexChunk(isLeaf) +
          (depth ? '' : '  vLeafLag = aWind.w;'));

      if (!depth) {
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
varying float vLeafLag;`
          )
          .replace(
            '#include <opaque_fragment>',
            `{
    vec3 L = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
    vec3 V = normalize(vViewPosition);
    float back = max(0.0, dot(-V, L));
    float glow = pow(back, ${isLeaf ? '2.4' : '5.0'}) * ${isLeaf ? '1.25' : '0.25'};
    outgoingLight += glow * uSunColor * (diffuseColor.rgb * 1.4 + 0.10);
    outgoingLight += uSkyColor * diffuseColor.rgb * ${isLeaf ? '0.13' : '0.07'};
  }
  #include <opaque_fragment>`
          );
      }
      mat.userData.shader = shader;
    };
    mat.customProgramCacheKey = () => `tree-${isLeaf ? 'leaf' : 'bark'}-${depth ? 'd' : 'c'}`;
    return mat;
  }

  _makeMaterials() {
    this.barkMaterial = this._patch(
      new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true }),
      false, false
    );
    this.leafMaterial = this._patch(
      new THREE.MeshLambertMaterial({
        color: 0xffffff,
        vertexColors: true,
        map: this.atlas,
        alphaTest: 0.34,
        side: THREE.DoubleSide,
      }),
      true, false
    );
    this.barkDepth = this._patch(
      new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }),
      false, true
    );
    this.leafDepth = this._patch(
      new THREE.MeshDepthMaterial({
        depthPacking: THREE.RGBADepthPacking,
        map: this.atlas,
        alphaTest: 0.34,
        side: THREE.DoubleSide,
      }),
      true, true
    );
    this._mats.push(this.barkMaterial, this.leafMaterial, this.barkDepth, this.leafDepth);
  }

  // ── placement ────────────────────────────────────────────────────────────

  _place() {
    const river = this.river;
    const noise = river.noise;
    const rng = makeRandom(0x7a3e11);
    const list = this.trees;
    let guard = 0;
    while (list.length < this.count && guard++ < this.count * 40) {
      const s = 6 + rng() * (river.length - 12);
      const side = rng() < 0.5 ? -1 : 1;

      // copses: trees cluster, they do not sprinkle
      const copse = noise.fbm2(s * 0.011, side * 13.9, 3);
      if (rng() > smoothstep(copse, -0.30, 0.30) * 0.9 + 0.12) continue;

      const roll = rng();
      let inland, species;
      if (roll < 0.30) {
        inland = 1.4 + rng() * 5.0;
        species = 'willow';
      } else if (roll < 0.72) {
        inland = 6 + rng() * 34;
        species = rng() < 0.42 ? 'slender' : 'broad';
      } else {
        // the ridge line: these are the ones that read against the sky
        inland = 42 + rng() * 78;
        species = rng() < 0.5 ? 'slender' : 'broad';
      }

      const hw = river.halfWidth(s);
      const u = side * (1 + inland / hw);
      const y = river.bankHeight(s, u);
      if (y < (species === 'willow' ? 0.25 : 0.7)) continue;
      // no trees on cliffs
      const du = 1.6 / hw;
      const slope = Math.abs(river.bankHeight(s, u + side * du) - y) / 1.6;
      if (slope > 0.95) continue;
      // keep a little breathing room between trunks
      const p = river.toWorld(s, u, y);
      let tooClose = false;
      for (const t of list) {
        const dx = t.pos.x - p.x, dz = t.pos.z - p.z;
        if (dx * dx + dz * dz < 12) { tooClose = true; break; }
      }
      if (tooClose) continue;

      list.push({ s, u, side, inland, species, pos: p, seed: (rng() * 1e9) | 0 });
    }
    list.sort((a, b) => a.s - b.s);
  }

  // ── growth ───────────────────────────────────────────────────────────────

  _build() {
    const perChunk = Math.ceil(this.trees.length / CHUNKS) || 1;
    for (let ci = 0; ci < CHUNKS; ci++) {
      const slice = this.trees.slice(ci * perChunk, (ci + 1) * perChunk);
      if (!slice.length) continue;
      const bark = new Buf(false);
      const leaf = new Buf(true);
      for (const t of slice) this._growTree(t, bark, leaf);
      const chunk = { meshes: [], center: new THREE.Vector3(), radius: 0 };

      if (bark.count) {
        const g = bark.toGeometry();
        this._geoms.push(g);
        const m = new THREE.Mesh(g, this.barkMaterial);
        m.customDepthMaterial = this.barkDepth;
        m.castShadow = true;
        m.receiveShadow = true;
        m.name = `treeBark${ci}`;
        this.group.add(m);
        chunk.meshes.push(m);
        chunk.center.copy(g.boundingSphere.center);
        chunk.radius = g.boundingSphere.radius;
      }
      if (leaf.count) {
        const g = leaf.toGeometry();
        this._geoms.push(g);
        const m = new THREE.Mesh(g, this.leafMaterial);
        m.customDepthMaterial = this.leafDepth;
        m.castShadow = true;
        m.receiveShadow = true;
        m.name = `treeLeaf${ci}`;
        this.group.add(m);
        chunk.meshes.push(m);
        if (chunk.radius === 0) {
          chunk.center.copy(g.boundingSphere.center);
          chunk.radius = g.boundingSphere.radius;
        }
      }
      this.chunks.push(chunk);
    }
  }

  _growTree(tree, bark, leaf) {
    const rng = makeRandom(tree.seed ^ 0x51ab);
    const river = this.river;
    const base = tree.pos;
    const sp = tree.species;

    // Species profile ------------------------------------------------------
    let height, trunkR, levels, spread, upBias, crownR, crownY, leanOut, fronds;
    if (sp === 'willow') {
      height = 5.4 + rng() * 3.4;
      trunkR = 0.20 + rng() * 0.13;
      levels = 3; spread = 0.78; upBias = 0.42;
      crownR = 1.5 + rng() * 0.7; crownY = 0.62;
      leanOut = 0.30 + rng() * 0.26;   // leans out over the water
      fronds = true;
    } else if (sp === 'slender') {
      height = 8.5 + rng() * 6.0;
      trunkR = 0.15 + rng() * 0.10;
      levels = 3; spread = 0.34; upBias = 0.80;
      crownR = 1.0 + rng() * 0.5; crownY = 0.74;
      leanOut = (rng() - 0.5) * 0.10;
      fronds = false;
    } else {
      height = 6.5 + rng() * 5.5;
      trunkR = 0.26 + rng() * 0.18;
      levels = 3; spread = 0.62; upBias = 0.40;
      crownR = 1.7 + rng() * 0.9; crownY = 0.66;
      leanOut = (rng() - 0.5) * 0.16;
      fronds = false;
    }

    // outward direction = away from the river, so willows lean over the water
    const right = river.right(tree.s, this._a).multiplyScalar(tree.side);
    const outward = this._b.copy(right).multiplyScalar(-1); // toward the channel

    // Palette --------------------------------------------------------------
    const barkA = new THREE.Color(sp === 'slender' ? 0x6d6353 : 0x453425);
    const barkB = new THREE.Color(sp === 'slender' ? 0x9a9483 : 0x6d5a41);
    const hue = rng();
    const leafBase = new THREE.Color(0x33512f).lerp(new THREE.Color(0x74883a), hue);
    if (rng() < 0.18) leafBase.lerp(new THREE.Color(0xa78c3e), 0.45); // an ochre one
    if (sp === 'willow') leafBase.lerp(new THREE.Color(0x7d8f4a), 0.35);

    const phase = rng();
    const windRef = [base.x, base.z, phase, 0, 0];
    const ctxT = {
      bark, leaf, rng, base, height, windRef,
      leafBase, barkA, barkB, crownR, crownY, sp, fronds,
      cards: 0,
    };

    // Trunk ----------------------------------------------------------------
    const dir = this._c.set(outward.x * leanOut, 1, outward.z * leanOut).normalize();
    this._branch(ctxT, base, dir, height * (sp === 'slender' ? 0.62 : 0.46), trunkR, 0, levels, spread, upBias);
  }

  /**
   * One branch: a tapered tube of `rings` nodes that curves as it goes, then
   * either children, or canopy lobes if this is a tip.
   */
  _branch(T, start, dir, len, rad, depth, levels, spread, upBias) {
    const { bark, rng } = T;
    const rings = depth === 0 ? 6 : depth === 1 ? 4 : 3;
    const radial = depth === 0 ? 7 : depth === 1 ? 5 : 4;
    const p = new THREE.Vector3().copy(start);
    const d = new THREE.Vector3().copy(dir).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const nodes = [];
    const step = len / rings;
    // parallel-transported frame
    let nrm = new THREE.Vector3();
    if (Math.abs(d.y) > 0.95) nrm.set(1, 0, 0); else nrm.crossVectors(d, up).normalize();
    let bin = new THREE.Vector3().crossVectors(d, nrm).normalize();

    for (let i = 0; i <= rings; i++) {
      const t = i / rings;
      const r = rad * Math.pow(1 - t, 0.62) * (0.32 + 0.68 * (1 - t * 0.2));
      nodes.push({ p: p.clone(), r: Math.max(r, rad * 0.10), n: nrm.clone(), b: bin.clone(), t });
      if (i === rings) break;
      // curve: a little sag, a little wander, a little reach for the light
      const wob = new THREE.Vector3(
        (rng() - 0.5) * 0.42, (rng() - 0.5) * 0.20, (rng() - 0.5) * 0.42
      );
      d.addScaledVector(wob, 0.30 * (depth + 1) * 0.5);
      d.y += (upBias - 0.5) * 0.16 - (depth > 0 ? 0.06 * depth : 0);
      d.normalize();
      p.addScaledVector(d, step);
      // re-orthogonalise the frame
      nrm.crossVectors(d, bin).normalize();
      bin.crossVectors(d, nrm).normalize();
    }

    this._emitTube(T, nodes, radial, depth);

    const tip = nodes[nodes.length - 1];
    if (depth >= levels - 1) {
      this._canopy(T, tip.p, rad, depth);
      if (T.fronds && depth >= levels - 1) this._fronds(T, tip.p, rad);
      return;
    }

    // Side shoots along the parent plus a continuing leader: this is what
    // stops every branch fanning out from a single point.
    const kids = depth === 0 ? 3 + ((rng() * 2) | 0) : 2 + ((rng() * 2) | 0);
    for (let k = 0; k < kids; k++) {
      const at = 0.42 + (k / Math.max(1, kids)) * 0.5 + rng() * 0.12;
      const ni = clamp(Math.round(at * rings), 1, rings);
      const node = nodes[ni];
      const ang = rng() * 6.283;
      const outDir = new THREE.Vector3()
        .copy(node.n).multiplyScalar(Math.cos(ang))
        .addScaledVector(node.b, Math.sin(ang));
      const sub = new THREE.Vector3()
        .subVectors(nodes[Math.min(ni + 1, rings)].p, nodes[ni - 1].p).normalize();
      const child = new THREE.Vector3()
        .copy(sub).multiplyScalar(1 - spread)
        .addScaledVector(outDir, spread)
        .addScaledVector(new THREE.Vector3(0, 1, 0), upBias * 0.5 - 0.15)
        .normalize();
      const childLen = len * (0.52 + rng() * 0.26) * (depth === 0 ? 0.9 : 0.82);
      const childRad = rad * (0.46 + rng() * 0.18);
      this._branch(T, node.p, child, childLen, childRad, depth + 1, levels, spread * 0.86, upBias * 0.8);
    }
    // leader continues past the last fork for one more level
    if (depth === 0) {
      const leadDir = new THREE.Vector3()
        .subVectors(tip.p, nodes[rings - 1].p).normalize()
        .addScaledVector(new THREE.Vector3(0, 1, 0), 0.35).normalize();
      this._branch(T, tip.p, leadDir, len * 0.62, rad * 0.5, depth + 1, levels, spread * 0.8, upBias);
    }
  }

  _emitTube(T, nodes, radial, depth) {
    const { bark, base, height, windRef, barkA, barkB, rng } = T;
    const start = bark.count;
    const c = new THREE.Color();
    const cs = new THREE.Color();
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const w = [windRef[0], windRef[1], windRef[2], 0, 0];
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      const h = clamp((nd.p.y - base.y) / height, 0, 1.4);
      const sway = Math.pow(h, 1.55) * (0.35 + depth * 0.30);
      const lag = clamp(h * 0.5 + depth * 0.22, 0, 1.3);
      c.copy(barkA).lerp(barkB, clamp(h * 0.8 + depth * 0.12 + (rng() - 0.5) * 0.15, 0, 1));
      for (let k = 0; k < radial; k++) {
        const a = (k / radial) * 6.283;
        const ca = Math.cos(a), sa = Math.sin(a);
        // slightly non-circular so trunks are not extruded cylinders
        const rr = nd.r * (0.88 + 0.24 * Math.abs(Math.sin(a * 2.3 + i)));
        p.copy(nd.p).addScaledVector(nd.n, ca * rr).addScaledVector(nd.b, sa * rr);
        n.copy(nd.n).multiplyScalar(ca).addScaledVector(nd.b, sa).normalize();
        // fake AO: the underside of the trunk stays cool and dark
        const shade = 0.70 + 0.30 * clamp(n.y * 0.5 + 0.6, 0, 1);
        w[3] = sway; w[4] = lag;
        cs.copy(c).multiplyScalar(shade);
        bark.vert(p, n, cs, 0, 0, w, null);
      }
    }
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = start + i * radial;
      const b = a + radial;
      for (let k = 0; k < radial; k++) {
        const k2 = (k + 1) % radial;
        bark.idx.push(a + k, b + k, a + k2, a + k2, b + k, b + k2);
      }
    }
  }

  /** A crown of overlapping lobes filled with alpha-cut leaf cards. */
  _canopy(T, tip, rad, depth) {
    const { leaf, rng, base, height, windRef, leafBase, crownR } = T;
    const lobes = 1 + ((rng() * 3) | 0);
    const up = new THREE.Vector3(0, 1, 0);
    const centre = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    const right = new THREE.Vector3();
    const upv = new THREE.Vector3();
    const off = new THREE.Vector3();
    const col = new THREE.Color();
    const w = [windRef[0], windRef[1], windRef[2], 0, 0];

    for (let l = 0; l < lobes; l++) {
      const R = crownR * (0.52 + rng() * 0.55);
      centre.copy(tip).add(
        this._d.set((rng() - 0.5) * R * 1.1, (rng() - 0.3) * R * 0.8, (rng() - 0.5) * R * 1.1)
      );
      const cards = Math.round((5 + rng() * 6) * clamp(R, 0.6, 2.2));
      for (let i = 0; i < cards; i++) {
        // point on a squashed spheroid, shell-biased so the rim stays dense
        dir.set(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1);
        if (dir.lengthSq() < 1e-5) dir.set(0, 1, 0);
        dir.normalize();
        const rr = R * (0.45 + 0.55 * Math.cbrt(rng()));
        pos.copy(centre).addScaledVector(dir, rr);
        pos.y = centre.y + (pos.y - centre.y) * 0.78;

        // spherical normal → the canopy shades as one rounded mass
        nrm.copy(dir).multiplyScalar(0.82).addScaledVector(up, 0.34).normalize();

        // face outward, jittered, so the rim reads solid from outside
        const face = this._c.copy(dir).addScaledVector(
          this._d.set(rng() - 0.5, rng() - 0.5, rng() - 0.5), 0.85
        ).normalize();
        right.crossVectors(up, face);
        if (right.lengthSq() < 1e-4) right.set(1, 0, 0);
        right.normalize();
        upv.crossVectors(face, right).normalize();
        const roll = rng() * 6.283;
        const cr = Math.cos(roll), sr = Math.sin(roll);
        const r2 = this._a.copy(right).multiplyScalar(cr).addScaledVector(upv, sr);
        const u2 = this._b.copy(right).multiplyScalar(-sr).addScaledVector(upv, cr);

        const sz = (0.52 + rng() * 0.52) * clamp(R * 0.85, 0.4, 1.9);
        const h = clamp((pos.y - base.y) / height, 0, 1.4);
        const sway = 0.42 + Math.pow(h, 1.3) * 0.95;
        const lag = clamp(0.55 + h * 0.55 + depth * 0.12, 0, 1.5);
        // baked AO: dark under the crown, luminous on top and at the rim
        const aoY = clamp((dir.y * 0.5 + 0.5) * 0.7 + rr / R * 0.4, 0, 1);
        col.copy(leafBase).multiplyScalar(0.52 + aoY * 0.72);
        col.r *= 0.94 + rng() * 0.14;
        col.g *= 0.94 + rng() * 0.13;
        col.b *= 0.90 + rng() * 0.18;

        const tile = TILES[(rng() * TILES.length) | 0];
        const flip = rng() < 0.5;
        const u0 = flip ? tile[0] + tile[2] : tile[0];
        const u1 = flip ? tile[0] : tile[0] + tile[2];
        const v0 = tile[1], v1 = tile[1] + tile[3];

        const idx0 = leaf.count;
        w[3] = sway; w[4] = lag;
        const corners = [
          [-1, -1, u0, v1], [1, -1, u1, v1], [-1, 1, u0, v0], [1, 1, u1, v0],
        ];
        for (const [sx, sy, uu, vv] of corners) {
          off.copy(r2).multiplyScalar(sx * sz).addScaledVector(u2, sy * sz);
          this._d.copy(pos).add(off);
          leaf.vert(this._d, nrm, col, uu, vv, w, off);
        }
        leaf.idx.push(idx0, idx0 + 1, idx0 + 2, idx0 + 2, idx0 + 1, idx0 + 3);
        T.cards++;
      }
    }
  }

  /** Willow fronds: long tapering ribbons that hang and swing with a lag. */
  _fronds(T, tip, rad) {
    const { leaf, rng, base, height, windRef } = T;
    const n = 3 + ((rng() * 4) | 0);
    const p = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    const right = new THREE.Vector3();
    const col = new THREE.Color();
    const w = [windRef[0], windRef[1], windRef[2], 0, 0];
    const [fu, fv, fw, fh] = FROND_TILE;

    for (let f = 0; f < n; f++) {
      const ang = rng() * 6.283;
      const outX = Math.cos(ang), outZ = Math.sin(ang);
      const spreadR = 0.25 + rng() * 1.15;
      const len = 1.4 + rng() * 2.6;
      const segs = 5;
      const width = 0.19 + rng() * 0.16;
      right.set(-outZ, 0, outX);
      const startX = tip.x + outX * spreadR * 0.4;
      const startZ = tip.z + outZ * spreadR * 0.4;
      const startY = tip.y + (rng() - 0.4) * 0.5;
      const shade = 0.72 + rng() * 0.4;
      col.copy(T.leafBase).multiplyScalar(shade);
      const idx0 = leaf.count;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        // the strand arcs out then falls
        const ox = outX * spreadR * (0.4 + t * 0.85);
        const oz = outZ * spreadR * (0.4 + t * 0.85);
        const y = startY - len * (t * t * 0.72 + t * 0.34);
        const wI = width * (1 - t * 0.55);
        const h = clamp((y - base.y) / height, 0, 1.4);
        const sway = 0.7 + t * 1.85;
        const lag = 0.9 + t * 1.5;
        w[3] = sway; w[4] = lag;
        nrm.set(outX * 0.35, 0.55, outZ * 0.35).normalize();
        const shadeT = 0.62 + 0.5 * (1 - t);
        col.copy(T.leafBase).multiplyScalar(shade * shadeT);
        for (let k = 0; k < 2; k++) {
          const sx = k === 0 ? -1 : 1;
          p.set(startX + ox + right.x * sx * wI, y, startZ + oz + right.z * sx * wI);
          leaf.vert(p, nrm, col, fu + (k === 0 ? 0.02 : fw - 0.02), fv + fh * t, w, null);
        }
      }
      for (let i = 0; i < segs; i++) {
        const a = idx0 + i * 2;
        leaf.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  }

  // ── per frame ────────────────────────────────────────────────────────────

  update(dt, elapsed) {
    const cam = this.ctx.camera;
    if (!cam || !this.chunks.length) return;
    this._camPos.setFromMatrixPosition(cam.matrixWorld);
    for (const ch of this.chunks) {
      const d = this._camPos.distanceTo(ch.center) - ch.radius;
      const vis = d < CULL_DIST;
      const shade = d < SHADOW_DIST;
      const refl = d < REFLECT_DIST;
      for (const m of ch.meshes) {
        m.visible = vis;
        if (m.castShadow !== shade) m.castShadow = shade;
        if (ch.reflected !== refl) {
          // layer 0 = seen by every camera; the veg layer = main camera only
          if (refl) { m.layers.enable(0); m.layers.disable(this.noReflectLayer); }
          else { m.layers.set(this.noReflectLayer); }
        }
      }
      ch.reflected = refl;
    }
  }

  dispose() {
    this.group.removeFromParent();
    for (const g of this._geoms) g.dispose();
    for (const m of this._mats) m.dispose();
    this.atlas?.dispose();
    this._geoms.length = 0;
    this._mats.length = 0;
  }
}
