#!/usr/bin/env node
// Objective controller checks. Nobody can play this build interactively from
// here, so control correctness gets asserted instead of felt: drive the input
// struct directly, step the real game loop, and measure where the duck went.
//
// The simulation is stepped by hand rather than waiting on rendered frames — a
// rendered frame costs seconds under software WebGL, the physics is pure CPU.
//
//   node tools/control-test.mjs [--only forward,boulder] [--url ...]

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright'
);

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const BASE = arg('url', 'http://127.0.0.1:5173/');

const PROBE = `
async (spec) => {
  const d = window.__duck;
  const g = d.game;
  const p = d.sys.player;
  const cam = d.engine.camera;
  const THREE = g.ctx.THREE;

  const DT = 1 / 60;
  let simT = g.time.elapsed;
  let maxDepth = 0, submergedFrames = 0, frames = 0;
  const step = (n) => {
    for (let i = 0; i < n; i++) {
      simT += DT;
      g.time.dt = DT;
      g.time.elapsed = simT;
      g.input.update();
      for (const s of g.systems) {
        try { s.update(DT, simT); } catch (e) { /* matches the live loop */ }
      }
      cam.updateMatrixWorld(true);
      g.input.endFrame();
      frames++;
      if (p.depthBelow > maxDepth) maxDepth = p.depthBelow;
      if (p.submerged) submergedFrames++;
    }
  };

  d.teleport(spec.s ?? 300, spec.u ?? 0);
  step(40);
  maxDepth = 0; submergedFrames = 0; frames = 0;

  let landing = null;
  if (spec.landOn) {
    const terrain = d.sys.terrain;
    let target = null;
    if (spec.landOn === 'rock') {
      const waterY = g.ctx.WATER_LEVEL ?? 0;
      const all = (terrain?.rocks || []).map(r => ({
        r, top: terrain.surfaceHeightAt(r.position.x, r.position.z),
      }));
      // Must break the surface: landing on a submerged rock just means
      // floating above it, which proves nothing.
      const emergent = all.filter(o => o.top > waterY + 0.25).sort((a, b) => b.top - a.top);
      const pick = emergent[spec.rockIndex ?? 0];
      if (pick) target = { x: pick.r.position.x, z: pick.r.position.z, radius: pick.r.radius, top: pick.top };
    } else if (spec.landOn === 'bank') {
      const s = spec.s ?? 300, u = spec.bankU ?? 2.4;
      const w = d.river.toWorld(s, u, 0, new THREE.Vector3());
      target = { x: w.x, z: w.z, radius: 0, top: d.river.groundAt(w) };
    }
    if (target) {
      p.position.set(target.x, target.top + 2.5, target.z);
      p.velocity.set(0, 0, 0);
      step(Math.round((spec.settleSeconds ?? 3.0) * 60));
      landing = {
        expectedTop: +target.top.toFixed(2),
        restY: +p.position.y.toFixed(2),
        above: +(p.position.y - target.top).toFixed(2),
        state: p.state,
        radius: +target.radius.toFixed(2),
      };
    }
  }

  const start = p.position.clone();
  const yaw0 = p.yaw;
  const e = cam.matrixWorld.elements;
  const fwd = new THREE.Vector3(-e[8], 0, -e[10]).normalize();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x).normalize();

  let navBefore = null, navDest = null;
  if (spec.navNdc) {
    navDest = p.pickDestination?.(spec.navNdc[0], spec.navNdc[1]) ?? null;
    if (navDest) {
      navBefore = Math.hypot(navDest.x - p.position.x, navDest.z - p.position.z);
      p.navigateTo(navDest);
    }
  }

  const held = spec.keys || [];
  const restore = g.input.update.bind(g.input);
  g.input.update = function () {
    restore();
    for (const k of held) this.keys[k] = true;
    const kx = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
    const ky = (this.keys.forward ? 1 : 0) - (this.keys.back ? 1 : 0);
    const len = Math.hypot(kx, ky) || 1;
    if (kx || ky) this.move.set(kx / len, ky / len);
  };

  maxDepth = 0; submergedFrames = 0; frames = 0;
  step(Math.round((spec.seconds ?? 2.0) * 60));

  g.input.update = restore;
  for (const k of held) g.input.keys[k] = false;
  g.input.move.set(0, 0);

  const delta = p.position.clone().sub(start);
  return {
    forward: +delta.dot(fwd).toFixed(3),
    right: +delta.dot(right).toFixed(3),
    up: +delta.y.toFixed(3),
    yawChange: +(((p.yaw - yaw0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI).toFixed(3),
    speed: +(p.speed ?? 0).toFixed(2),
    state: p.state,
    depthBelow: +(p.depthBelow ?? 0).toFixed(2),
    maxDepth: +maxDepth.toFixed(2),
    submergedPct: +((submergedFrames / Math.max(1, frames)) * 100).toFixed(1),
    landing,
    navDistanceBefore: navBefore,
    navDistanceAfter: navDest
      ? Math.hypot(navDest.x - p.position.x, navDest.z - p.position.z) : null,
    navCleared: navDest ? p._nav == null : null,
  };
}
`;

const CASES = [
  {
    name: 'W moves forward, not sideways',
    spec: { keys: ['forward'], seconds: 2.2 },
    check: (r) => r.forward > 1.2 && Math.abs(r.right) < r.forward * 0.6 &&
      `${r.forward}m forward, ${r.right}m sideways`,
  },
  {
    name: 'D steers RIGHT',
    spec: { keys: ['forward', 'right'], seconds: 2.2 },
    check: (r) => r.right > 0.35 && `drifted ${r.right}m to screen-right`,
  },
  {
    name: 'A steers LEFT',
    spec: { keys: ['forward', 'left'], seconds: 2.2 },
    check: (r) => r.right < -0.35 && `drifted ${r.right}m to screen-left`,
  },
  {
    name: 'W alone does not spin the duck',
    spec: { keys: ['forward'], seconds: 3.0 },
    check: (r) => Math.abs(r.yawChange) < 1.0 &&
      `yaw changed ${(r.yawChange * 57.3).toFixed(0)}deg`,
  },
  {
    // The reported game-breaker: the duck gets dragged under with no input and
    // cannot recover. A floating duck must stay floating.
    name: 'idle duck stays on the surface and is not dragged under',
    spec: { keys: [], seconds: 20.0 },
    check: (r) => r.submergedPct < 5 && r.maxDepth < 0.25 &&
      `submerged ${r.submergedPct}% of 20s, max depth ${r.maxDepth}m`,
  },
  {
    name: 'paddling duck stays on the surface',
    spec: { keys: ['forward'], seconds: 15.0 },
    check: (r) => r.submergedPct < 5 && r.maxDepth < 0.25 &&
      `submerged ${r.submergedPct}% of 15s, max depth ${r.maxDepth}m`,
  },
  {
    name: 'duck resurfaces after a dive is released',
    spec: { keys: [], seconds: 12.0, preDive: true },
    check: (r) => r.state !== 'underwater' && r.depthBelow < 0.3 &&
      `ended at ${r.depthBelow}m, state ${r.state}`,
  },
  {
    name: 'idle duck is not swept away by the current',
    spec: { keys: [], seconds: 3.0 },
    check: (r) => {
      const drift = Math.hypot(r.forward, r.right);
      return drift < 6.5 && `drifted ${drift.toFixed(2)}m in 3s`;
    },
  },
  {
    name: 'can swim upstream against the current',
    spec: { keys: ['forward', 'sprint'], seconds: 3.0 },
    check: (r) => r.forward > 1.5 && `made ${r.forward}m of headway`,
  },
  {
    name: 'duck lands on a midstream boulder instead of falling through',
    spec: { landOn: 'rock', keys: [], seconds: 1.0, settleSeconds: 3.5 },
    check: (r) => r.landing && r.landing.above > -0.35 && r.landing.above < 0.9 &&
      `rested ${r.landing.above}m above a ${r.landing.radius}m boulder (state ${r.landing.state})`,
  },
  {
    name: 'duck stands on the bank well away from the water',
    spec: { landOn: 'bank', bankU: 2.4, keys: [], seconds: 1.0, settleSeconds: 3.5 },
    check: (r) => r.landing && r.landing.above > -0.35 && r.landing.above < 0.9 &&
      `rested ${r.landing.above}m above bank (state ${r.landing.state})`,
  },
  {
    name: 'Space dives and stays under',
    spec: { keys: ['dive'], seconds: 2.5 },
    check: (r) => r.depthBelow > 0.3 && `depth ${r.depthBelow}m, state ${r.state}`,
  },
];

async function main() {
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__duck && window.__duck.ready === true', { timeout: 180000 });
  await page.waitForTimeout(1500);

  const only = arg('only', '').split(',').map((s) => s.trim()).filter(Boolean);
  const cases = only.length
    ? CASES.filter((c) => only.some((o) => c.name.toLowerCase().includes(o.toLowerCase())))
    : CASES;

  let fails = 0;
  for (const c of cases) {
    // A concurrent agent's edit hot-reloads the page and wipes window.__duck
    // mid-run, which looks like a spurious failure. Wait for ready, retry once.
    let r, err = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await page.waitForFunction('window.__duck && window.__duck.ready === true', { timeout: 180000 });
        if (c.spec.preDive) {
          await page.evaluate(() => window.__duck?.forceDive?.(2.5));
          await page.waitForTimeout(400);
          await page.evaluate(() => window.__duck?.surface?.());
        }
        r = await page.evaluate(`(${PROBE})(${JSON.stringify(c.spec)})`);
        err = null;
        break;
      } catch (e) {
        err = e;
        await page.waitForTimeout(2500);
      }
    }
    if (err) {
      console.log(`FAIL  ${c.name}  (threw: ${err.message.slice(0, 90)})`);
      fails++;
      continue;
    }
    const verdict = c.check(r);
    if (verdict && typeof verdict === 'string') console.log(`ok    ${c.name}  — ${verdict}`);
    else {
      fails++;
      console.log(`FAIL  ${c.name}  — ${JSON.stringify(r)}`);
    }
  }

  if (errors.length) {
    console.log('\npage errors:');
    for (const e of errors.slice(0, 8)) console.log('  ' + e);
  }

  await browser.close();
  console.log(fails ? `\n${fails} control check(s) failed` : '\nall control checks passed');
  process.exitCode = fails ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
