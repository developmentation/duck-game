#!/usr/bin/env node
// Bundle every capture into one shareable zip. PNGs are re-encoded as JPEG so
// the archive is a sensible size to send; the originals stay on disk.
//
//   node tools/export-shots.mjs [shotsDir] [outZip]

import { createRequire } from 'node:module';
import { readdir, writeFile, mkdir, rm, readFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright'
);
const run = promisify(execFile);

const SHOTS = process.argv[2] || 'shots';
const OUT_ZIP = path.resolve(process.argv[3] || 'dist-single/duckling-screenshots.zip');
const STAGE = path.resolve('.shots-export');
const MAX_W = parseInt(process.env.MAX_W || '1440', 10);
const QUALITY = parseFloat(process.env.JPEG_Q || '0.85');

function serve(root) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const rel = decodeURIComponent(req.url.slice(1));
        if (rel.includes('..')) throw new Error('nope');
        // Read before writing headers: a miss must still be able to 404.
        const buf = await readFile(path.join(root, rel));
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(buf);
      } catch {
        if (!res.headersSent) res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, base: `http://127.0.0.1:${server.address().port}/` })
    );
  });
}

async function walk(dir, base = dir, acc = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, base, acc);
    else acc.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return acc;
}

async function main() {
  const all = await walk(SHOTS);
  const pngs = all.filter((f) => f.endsWith('.png'));
  const meta = all.filter((f) => f.endsWith('.json'));
  if (!pngs.length) {
    console.error(`no PNGs under ${SHOTS}`);
    process.exit(1);
  }

  await rm(STAGE, { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });

  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  const { server, base } = await serve(path.resolve(SHOTS));
  await page.goto(base + '__blank').catch(() => {});
  await page.setContent('<!doctype html><meta charset=utf8><body></body>');

  let totalIn = 0, totalOut = 0;
  // Batch so a huge set does not build one enormous evaluate payload.
  const BATCH = 8;
  for (let i = 0; i < pngs.length; i += BATCH) {
    const batch = pngs.slice(i, i + BATCH);
    const encoded = await page.evaluate(
      async ({ names, base, maxW, q }) => {
        const out = [];
        for (const name of names) {
          const im = await new Promise((res, rej) => {
            const x = new Image();
            x.onload = () => res(x);
            x.onerror = () => rej(new Error(name));
            x.src = base + name.split('/').map(encodeURIComponent).join('/');
          });
          const scale = Math.min(1, maxW / im.width);
          const cv = new OffscreenCanvas(
            Math.round(im.width * scale),
            Math.round(im.height * scale)
          );
          const g = cv.getContext('2d');
          g.drawImage(im, 0, 0, cv.width, cv.height);
          const blob = await cv.convertToBlob({ type: 'image/jpeg', quality: q });
          const buf = new Uint8Array(await blob.arrayBuffer());
          let s = '';
          for (let k = 0; k < buf.length; k += 0x8000) {
            s += String.fromCharCode.apply(null, buf.subarray(k, k + 0x8000));
          }
          out.push({ name, data: btoa(s) });
        }
        return out;
      },
      { names: batch, base, maxW: MAX_W, q: QUALITY }
    );

    for (const { name, data } of encoded) {
      const dest = path.join(STAGE, name.replace(/\.png$/, '.jpg'));
      await mkdir(path.dirname(dest), { recursive: true });
      const buf = Buffer.from(data, 'base64');
      await writeFile(dest, buf);
      totalOut += buf.length;
      totalIn += (await readFile(path.join(SHOTS, name))).length;
    }
    process.stdout.write(`  encoded ${Math.min(i + BATCH, pngs.length)}/${pngs.length}\r`);
  }
  process.stdout.write('\n');

  server.close();
  await browser.close();

  // Carry the machine-readable reports along; they explain what each shot is.
  for (const m of meta) {
    const dest = path.join(STAGE, m);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(path.join(SHOTS, m), dest);
  }

  const index = [
    'Duckling — capture set',
    '='.repeat(60),
    '',
    'Folders are per-system capture runs made while building the game.',
    'contact.jpg in a folder is a contact sheet of that run.',
    'report.json  — console errors, missing systems, draw calls, triangles.',
    'analysis.json — objective image stats and flags (see CRITIQUE.md).',
    '',
    'Runs:',
    ...[...new Set(pngs.map((p) => p.split('/')[0]))].sort().map((d) => {
      const n = pngs.filter((p) => p.startsWith(d + '/')).length;
      return `  ${d.padEnd(20)} ${n} shot(s)`;
    }),
    '',
    `Generated ${new Date().toISOString()}`,
    `${pngs.length} images, re-encoded to JPEG q${QUALITY} at max ${MAX_W}px wide.`,
  ].join('\n');
  await writeFile(path.join(STAGE, 'README.txt'), index);

  await mkdir(path.dirname(OUT_ZIP), { recursive: true });
  if (existsSync(OUT_ZIP)) await rm(OUT_ZIP);
  await run('zip', ['-r', '-q', '-9', OUT_ZIP, '.'], { cwd: STAGE });
  await rm(STAGE, { recursive: true, force: true });

  const zipSize = (await readFile(OUT_ZIP)).length;
  console.log(
    `\n${OUT_ZIP}\n  ${pngs.length} images  ` +
    `${(totalIn / 1048576).toFixed(1)} MB PNG → ${(totalOut / 1048576).toFixed(1)} MB JPEG → ` +
    `${(zipSize / 1048576).toFixed(1)} MB zip`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
