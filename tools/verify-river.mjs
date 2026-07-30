// Sanity checks on the river's geometry contract. Everything downstream trusts
// these invariants, so they get asserted rather than eyeballed.
import * as THREE from 'three';
import { River } from '../src/world/river.js';

const river = new River({ seed: 20260730, length: 2000 });
let fails = 0;
const check = (name, ok, extra = '') => {
  if (!ok) { fails++; console.log(`FAIL  ${name} ${extra}`); }
  else console.log(`ok    ${name} ${extra}`);
};

check('length is sane', river.length > 1800 && river.length < 2600, `len=${river.length.toFixed(1)}`);

// Round trip: world → river → world should land back where it started.
let maxErr = 0, maxDepthSeen = 0, minHW = Infinity, maxHW = 0;
const p = new THREE.Vector3();
const back = new THREE.Vector3();
const r = { s: 0, u: 0, distance: 0 };
for (let i = 0; i < 400; i++) {
  const s = (i / 399) * river.length;
  const u = Math.sin(i * 2.3) * 0.85;
  river.toWorld(s, u, 0, p);
  river.toRiver(p, r);
  river.toWorld(r.s, r.u, 0, back);
  maxErr = Math.max(maxErr, back.distanceTo(p));
  maxDepthSeen = Math.max(maxDepthSeen, river.depth(s, u));
  minHW = Math.min(minHW, river.halfWidth(s));
  maxHW = Math.max(maxHW, river.halfWidth(s));
}
check('world↔river round trip', maxErr < 0.9, `maxErr=${maxErr.toFixed(3)}m`);
check('half width in range', minHW > 6 && maxHW < 40, `${minHW.toFixed(1)}..${maxHW.toFixed(1)}`);
check('channel has depth', maxDepthSeen > 3.5 && maxDepthSeen < 12, `maxDepth=${maxDepthSeen.toFixed(2)}`);

// Depth must go to zero at the banks and be continuous across the waterline.
let edgeDepth = 0, disc = 0;
for (let i = 0; i < 200; i++) {
  const s = (i / 199) * river.length;
  edgeDepth = Math.max(edgeDepth, river.depth(s, 0.999));
  const a = river.bedHeight(s, 0.995);
  const b = river.bankHeight(s, 1.005);
  disc = Math.max(disc, Math.abs(a - b));
}
check('depth vanishes at bank', edgeDepth < 0.25, `edge=${edgeDepth.toFixed(3)}`);
check('bed→bank is continuous', disc < 0.6, `jump=${disc.toFixed(3)}m`);

// Banks must rise above water everywhere, and climb inland.
let minBank = Infinity, lowInland = Infinity;
for (let i = 0; i < 300; i++) {
  const s = (i / 299) * river.length;
  for (const side of [-1, 1]) {
    const hw = river.halfWidth(s);
    minBank = Math.min(minBank, river.bankHeight(s, side * (1 + 4 / hw)));
    lowInland = Math.min(lowInland, river.bankHeight(s, side * (1 + 60 / hw)));
  }
}
check('bank above waterline at 4m', minBank > -0.05, `min=${minBank.toFixed(2)}`);
check('land climbs inland', lowInland > 2.0, `min@60m=${lowInland.toFixed(2)}`);

// Flow: downstream, faster mid-channel, non-zero everywhere in the channel.
const v = new THREE.Vector3();
let minMid = Infinity, maxMid = 0, wrongWay = 0;
const tan = new THREE.Vector3();
for (let i = 0; i < 300; i++) {
  const s = (i / 299) * river.length;
  river.flowAt(s, 0, v);
  river.tangent(s, tan);
  const along = v.dot(tan);
  if (along <= 0) wrongWay++;
  minMid = Math.min(minMid, v.length());
  maxMid = Math.max(maxMid, v.length());
  const edge = river.flowAt(s, 0.97, new THREE.Vector3()).length();
  if (edge > v.length()) wrongWay++;
}
check('flow always downstream', wrongWay === 0, `bad=${wrongWay}`);
check('flow speed plausible', minMid > 0.4 && maxMid < 6, `${minMid.toFixed(2)}..${maxMid.toFixed(2)} m/s`);

// Pools should sit on water, spaced along the river.
let poolsOk = true;
for (const pool of river.pools) {
  const rr = river.toRiver(pool.position, { s: 0, u: 0, distance: 0 });
  if (Math.abs(rr.u) > 1) poolsOk = false;
}
check('pools sit on open water', poolsOk, `n=${river.pools.length}`);

// Perf: toRiver is called thousands of times per frame.
const t0 = performance.now();
const probe = new THREE.Vector3();
for (let i = 0; i < 200000; i++) {
  probe.set(Math.sin(i) * 60, 0, (i % 2000));
  river.toRiver(probe, r);
}
const per = ((performance.now() - t0) / 200000) * 1000;
check('toRiver is fast', per < 6, `${per.toFixed(2)}µs/call`);

console.log(fails ? `\n${fails} check(s) failed` : '\nall river checks passed');
process.exit(fails ? 1 : 0);
