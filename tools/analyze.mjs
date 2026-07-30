#!/usr/bin/env node
// Objective image statistics for a shot directory, plus a contact sheet.
//
// The visual critics judge taste, but taste is easy to fool. These numbers catch
// the failure modes that a tired eye misses: grey mud, crushed blacks, blown
// highlights, a flat frame with no depth, a monochrome palette, or a frame with
// no warm/cool separation at all.
//
//   node tools/analyze.mjs shots/latest
//
// Writes <dir>/analysis.json and <dir>/contact.png

import { createRequire } from 'node:module';
import { readdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright'
);

const dir = process.argv[2] || 'shots/latest';

const PAGE = `<!doctype html><meta charset=utf8><body style="margin:0;background:#111"></body>`;

/** Serve the shot directory over http so canvas can read the pixels back. */
function serve(root) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const name = decodeURIComponent(req.url.slice(1)).replace(/[^\w.\-]/g, '');
        const buf = await readFile(path.join(root, name));
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(buf);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, base: `http://127.0.0.1:${server.address().port}/` })
    );
  });
}

async function main() {
  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.png') && f !== 'contact.png')
    .sort();
  if (!files.length) {
    console.error(`no PNGs in ${dir}`);
    process.exit(1);
  }

  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  const { server, base } = await serve(path.resolve(dir));
  await page.goto(base + '__index', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.setContent(PAGE);

  const urls = files.map((f) => base + encodeURIComponent(f));

  const stats = await page.evaluate(async (urls) => {
    const load = (src) =>
      new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('load ' + src));
        im.src = src;
      });

    const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

    const out = [];
    for (const url of urls) {
      const im = await load(url);
      const W = 480;
      const H = Math.round((im.height / im.width) * W);
      const cv = new OffscreenCanvas(W, H);
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.drawImage(im, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;

      let n = 0, sumL = 0, sumL2 = 0, sumSat = 0;
      let clipHi = 0, clipLo = 0;
      const hist = new Array(32).fill(0);
      // Warm/cool separation: mean hue-ish ratio in shadows vs highlights.
      let shR = 0, shB = 0, shN = 0, hiR = 0, hiB = 0, hiN = 0;
      const hueBins = new Array(24).fill(0);
      let sumR = 0, sumG = 0, sumB = 0;

      for (let i = 0; i < d.length; i += 4) {
        const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
        const L = 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(gg) + 0.0722 * srgbToLin(b);
        const Y = 0.299 * r + 0.587 * gg + 0.114 * b;
        const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
        const sat = mx <= 0 ? 0 : (mx - mn) / mx;
        n++;
        sumL += Y; sumL2 += Y * Y; sumSat += sat;
        sumR += r; sumG += gg; sumB += b;
        if (mx > 0.995) clipHi++;
        if (mx < 0.02) clipLo++;
        hist[Math.min(31, (Y * 32) | 0)]++;
        if (Y < 0.28) { shR += r; shB += b; shN++; }
        else if (Y > 0.68) { hiR += r; hiB += b; hiN++; }
        if (sat > 0.12) {
          let h;
          if (mx === mn) h = 0;
          else if (mx === r) h = ((gg - b) / (mx - mn) + 6) % 6;
          else if (mx === gg) h = (b - r) / (mx - mn) + 2;
          else h = (r - gg) / (mx - mn) + 4;
          hueBins[Math.min(23, ((h / 6) * 24) | 0)]++;
        }
        void L;
      }

      const mean = sumL / n;
      const rms = Math.sqrt(Math.max(0, sumL2 / n - mean * mean));
      // Edge energy: mean |gradient| of luminance on a coarse grid, a proxy for
      // how much readable detail and depth layering the frame carries.
      let edge = 0, en = 0;
      const at = (x, y) => {
        const i = (y * W + x) * 4;
        return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      };
      for (let y = 1; y < H - 1; y += 2) {
        for (let x = 1; x < W - 1; x += 2) {
          edge += Math.abs(at(x + 1, y) - at(x - 1, y)) + Math.abs(at(x, y + 1) - at(x, y - 1));
          en++;
        }
      }
      edge = edge / en / 255;

      // How many hue bins carry real weight — a one-note frame scores low.
      const totalHue = hueBins.reduce((a, b) => a + b, 0) || 1;
      const hueSpread = hueBins.filter((v) => v / totalHue > 0.03).length;

      const shWarm = shN ? shR / shN - shB / shN : 0;
      const hiWarm = hiN ? hiR / hiN - hiB / hiN : 0;

      out.push({
        file: url.split('/').pop(),
        meanLuma: +mean.toFixed(4),
        rmsContrast: +rms.toFixed(4),
        meanSaturation: +(sumSat / n).toFixed(4),
        clippedHighlightsPct: +((clipHi / n) * 100).toFixed(3),
        crushedBlacksPct: +((clipLo / n) * 100).toFixed(3),
        edgeEnergy: +edge.toFixed(4),
        hueSpread,
        shadowWarmth: +shWarm.toFixed(4),
        highlightWarmth: +hiWarm.toFixed(4),
        warmCoolSeparation: +(hiWarm - shWarm).toFixed(4),
        meanRGB: [+(sumR / n).toFixed(3), +(sumG / n).toFixed(3), +(sumB / n).toFixed(3)],
        histogram: hist.map((v) => +(v / n).toFixed(4)),
        width: im.width,
        height: im.height,
      });
    }
    return out;
  }, urls);

  // Contact sheet so a critic can see the whole set in one read.
  const cols = Math.min(3, files.length);
  const rows = Math.ceil(files.length / cols);
  const cw = 620, ch = 349;
  await page.setViewportSize({ width: cols * cw, height: rows * (ch + 26) });
  const sheet = await page.evaluate(
    async ({ urls, names, cols, cw, ch }) => {
      const load = (src) =>
        new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = rej;
          im.src = src;
        });
      const rows = Math.ceil(urls.length / cols);
      const cv = document.createElement('canvas');
      cv.width = cols * cw;
      cv.height = rows * (ch + 26);
      const g = cv.getContext('2d');
      g.fillStyle = '#101416';
      g.fillRect(0, 0, cv.width, cv.height);
      for (let i = 0; i < urls.length; i++) {
        const im = await load(urls[i]);
        const x = (i % cols) * cw;
        const y = Math.floor(i / cols) * (ch + 26);
        g.drawImage(im, x + 4, y + 22, cw - 8, ch - 4);
        g.fillStyle = '#cfe3ea';
        g.font = '13px monospace';
        g.fillText(names[i], x + 6, y + 15);
      }
      return cv.toDataURL('image/png');
    },
    { urls, names: files, cols, cw, ch }
  );

  await writeFile(
    path.join(dir, 'contact.png'),
    Buffer.from(sheet.split(',')[1], 'base64')
  );

  const flags = [];
  for (const s of stats) {
    if (s.rmsContrast < 0.11) flags.push(`${s.file}: flat frame (rmsContrast ${s.rmsContrast})`);
    if (s.meanSaturation < 0.14) flags.push(`${s.file}: desaturated/grey (${s.meanSaturation})`);
    if (s.meanSaturation > 0.58) flags.push(`${s.file}: oversaturated (${s.meanSaturation})`);
    if (s.clippedHighlightsPct > 6) flags.push(`${s.file}: blown highlights ${s.clippedHighlightsPct}%`);
    if (s.crushedBlacksPct > 4) flags.push(`${s.file}: crushed blacks ${s.crushedBlacksPct}%`);
    if (s.edgeEnergy < 0.035) flags.push(`${s.file}: little readable detail (edgeEnergy ${s.edgeEnergy})`);
    if (s.hueSpread < 4) flags.push(`${s.file}: one-note palette (hueSpread ${s.hueSpread})`);
    if (Math.abs(s.warmCoolSeparation) < 0.02)
      flags.push(`${s.file}: no warm/cool separation (${s.warmCoolSeparation})`);
    if (s.meanLuma < 0.13) flags.push(`${s.file}: very dark (meanLuma ${s.meanLuma})`);
    if (s.meanLuma > 0.78) flags.push(`${s.file}: washed out (meanLuma ${s.meanLuma})`);
  }

  await writeFile(
    path.join(dir, 'analysis.json'),
    JSON.stringify({ dir, stats, flags }, null, 2)
  );
  await browser.close();
  server.close();

  console.log(`analysed ${stats.length} shot(s) → ${dir}/analysis.json, ${dir}/contact.png`);
  for (const s of stats) {
    console.log(
      `${s.file.padEnd(26)} luma=${s.meanLuma} contrast=${s.rmsContrast} sat=${s.meanSaturation} ` +
      `edge=${s.edgeEnergy} hues=${s.hueSpread} warmCool=${s.warmCoolSeparation}`
    );
  }
  if (flags.length) {
    console.log('\nflags:');
    for (const f of flags) console.log('  - ' + f);
  } else {
    console.log('\nno objective flags');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
