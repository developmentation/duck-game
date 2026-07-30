#!/usr/bin/env node
// Headless capture harness. Boots the game in Chromium (SwiftShader WebGL2),
// waits for the world to settle, runs an optional setup script per shot, and
// writes PNGs plus a JSON report of console errors and perf.
//
//   node tools/screenshot.mjs                       # default shot set
//   node tools/screenshot.mjs --shots tools/shots/underwater.json
//   node tools/screenshot.mjs --out shots/run7 --width 1600 --height 900
//   node tools/screenshot.mjs --only sunrise,dive

// Playwright comes from the globally installed copy, which matches the
// pre-downloaded Chromium in /opt/pw-browsers. Do not add it to package.json —
// a different version re-downloads browsers that this box has no network for.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright'
);
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const BASE = arg('url', 'http://127.0.0.1:5173/');
const OUT = arg('out', 'shots/latest');
const WIDTH = parseInt(arg('width', '1600'), 10);
const HEIGHT = parseInt(arg('height', '900'), 10);
const SETTLE = parseFloat(arg('settle', '2.2'));
const ONLY = arg('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_SHOTS = [
  {
    name: '01-hero-morning',
    desc: 'Third person hero shot: duck family on open water, golden morning.',
    setup: `__duck.setTime(0.30); __duck.teleport?.(120, 0);`,
    settle: 3.0,
  },
  {
    name: '02-wide-river',
    desc: 'Wide establishing shot down a bend showing banks, trees, reeds.',
    setup: `__duck.setTime(0.34); __duck.teleport?.(520, -0.35);`,
    settle: 2.6,
  },
  {
    name: '03-reeds-shallows',
    desc: 'Close among the reeds in the shallows.',
    setup: `__duck.setTime(0.28); __duck.teleport?.(760, 0.82);`,
    settle: 2.6,
  },
  {
    name: '04-underwater-dive',
    desc: 'Submerged: caustics, godrays, fish, bubbles, weed.',
    setup: `__duck.setTime(0.33); __duck.teleport?.(300, 0); __duck.forceDive?.(3.0);`,
    settle: 3.4,
  },
  {
    name: '05-surface-line',
    desc: 'Camera at the waterline, half in half out.',
    setup: `__duck.setTime(0.31); __duck.teleport?.(940, 0.1); __duck.forceDive?.(0.35);`,
    settle: 2.8,
  },
  {
    name: '06-evening',
    desc: 'Late golden hour / dusk mood over a broad pool.',
    setup: `__duck.setTime(0.76); __duck.teleport?.(1420, 0);`,
    settle: 2.8,
  },
];

async function main() {
  await mkdir(OUT, { recursive: true });

  let shots = DEFAULT_SHOTS;
  const shotsFile = arg('shots', '');
  if (shotsFile && existsSync(shotsFile)) {
    shots = JSON.parse(await readFile(shotsFile, 'utf8'));
  }
  if (ONLY.length) shots = shots.filter((s) => ONLY.some((o) => s.name.includes(o)));

  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || undefined,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--disable-frame-rate-limit',
    ],
  });

  const report = { base: BASE, out: OUT, when: new Date().toISOString(), shots: [] };

  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      consoleErrors.push(`${m.type()}: ${m.text()}`.slice(0, 400));
    }
  });
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 400)));

  const url = `${BASE}${BASE.includes('?') ? '&' : '?'}q=${arg('q', 'high')}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

  // Wait for the game to report ready.
  let booted = true;
  try {
    await page.waitForFunction('window.__duck && window.__duck.ready === true', {
      timeout: 120000,
    });
  } catch {
    booted = false;
  }

  const missing = await page.evaluate(() => window.__duck?.missing ?? ['<no boot>']);

  for (const shot of shots) {
    try {
      await page.evaluate((s) => {
        window.__duck?.screenshotMode?.(true);
        // eslint-disable-next-line no-new-func
        if (s) new Function('__duck', s)(window.__duck);
      }, shot.setup || '');
    } catch (e) {
      pageErrors.push(`setup(${shot.name}): ${e.message}`);
    }

    await page.waitForTimeout((shot.settle ?? SETTLE) * 1000);

    const file = path.join(OUT, `${shot.name}.png`);
    // Software WebGL under load can take a while to produce a frame.
    await page.screenshot({ path: file, type: 'png', timeout: 180000 });

    const perf = await page.evaluate(() => {
      const e = window.__duck?.engine;
      const info = e?.renderer?.info;
      return {
        fps: e ? Math.round(e.fps) : null,
        dpr: e ? +e._dpr?.toFixed(2) : null,
        drawCalls: info?.render?.calls ?? null,
        triangles: info?.render?.triangles ?? null,
        textures: info?.memory?.textures ?? null,
        programs: info?.programs?.length ?? null,
      };
    });

    report.shots.push({ name: shot.name, desc: shot.desc || '', file, perf });
    process.stdout.write(`shot ${shot.name} → ${file}  fps=${perf.fps} tris=${perf.triangles}\n`);
  }

  report.booted = booted;
  report.missingSystems = missing;
  report.consoleErrors = consoleErrors.slice(0, 60);
  report.pageErrors = pageErrors.slice(0, 60);

  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();

  console.log('\n--- report ---');
  console.log(`booted: ${booted}`);
  console.log(`missing systems: ${missing.join(', ') || 'none'}`);
  if (pageErrors.length) console.log(`page errors:\n  ${pageErrors.slice(0, 12).join('\n  ')}`);
  if (consoleErrors.length) console.log(`console:\n  ${consoleErrors.slice(0, 12).join('\n  ')}`);
  if (!booted || pageErrors.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
