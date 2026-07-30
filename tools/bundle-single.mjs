#!/usr/bin/env node
// Produce ONE self-contained .html file with all JS, CSS and generated assets
// inlined. Everything in this game is procedural, so a single file really is
// the whole game: double-click it, or host it anywhere, no server needed.
//
//   npm run build && node tools/bundle-single.mjs
//   → dist-single/duckling.html
//
// Also the form the game needs to be in to publish as an Artifact (strict CSP,
// no external hosts).

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

const DIST = process.argv[2] || 'dist';
const OUT_DIR = process.argv[3] || 'dist-single';
const OUT = path.join(OUT_DIR, 'duckling.html');

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.ktx2': 'image/ktx2', '.bin': 'application/octet-stream',
};

async function collect(dir, base = dir, acc = new Map()) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await collect(p, base, acc);
    else acc.set('/' + path.relative(base, p).split(path.sep).join('/'), p);
  }
  return acc;
}

async function main() {
  const files = await collect(DIST);
  let html = await readFile(path.join(DIST, 'index.html'), 'utf8');

  const resolve = (href) => {
    const clean = href.replace(/^\.?\/?/, '/').split('?')[0];
    return files.get(clean) || files.get('/' + path.basename(clean));
  };

  // Inline any binary asset references inside JS/CSS as data URIs first.
  const inlineAssets = async (code) => {
    const refs = [...code.matchAll(/["'`](\.?\/?assets\/[\w.\-]+\.(png|jpe?g|webp|svg|woff2|bin|ktx2))["'`]/g)];
    for (const m of refs) {
      const file = resolve(m[1]);
      if (!file) continue;
      const buf = await readFile(file);
      const mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      code = code.split(m[0]).join(`"data:${mime};base64,${buf.toString('base64')}"`);
    }
    return code;
  };

  // CSS <link>s → <style>
  for (const m of [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/g)]) {
    const href = /href=["']([^"']+)["']/.exec(m[0])?.[1];
    const file = href && resolve(href);
    if (!file) continue;
    const css = await inlineAssets(await readFile(file, 'utf8'));
    html = html.replace(m[0], `<style>\n${css}\n</style>`);
  }

  // Module preloads are pointless once everything is inline.
  html = html.replace(/<link[^>]+rel=["']modulepreload["'][^>]*>\s*/g, '');

  // Collect every module script in document order and concatenate them. Vite
  // emits ES modules that import each other by path, so instead of stitching
  // them by hand we re-point the import specifiers at blob-free inline copies:
  // simplest reliable approach is to ask Vite for a single chunk (see
  // vite.config.js: inlineDynamicImports for the single-file build) and then
  // there is exactly one script to inline.
  const scripts = [...html.matchAll(/<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/g)];
  if (scripts.length > 1) {
    throw new Error(
      `expected a single JS chunk but found ${scripts.length}. Build with ` +
      `SINGLE=1 (vite.config.js switches on it to disable code splitting).`
    );
  }
  for (const m of scripts) {
    const file = resolve(m[1]);
    if (!file) throw new Error(`cannot resolve script ${m[1]}`);
    let js = await inlineAssets(await readFile(file, 'utf8'));
    // Guard against a stray </script> inside a template literal or shader.
    js = js.replace(/<\/script>/gi, '<\\/script>');
    html = html.replace(m[0], `<script type="module">\n${js}\n</script>`);
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT, html);

  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`wrote ${OUT}  (${kb} KB, single file, no external requests)`);

  const external = [...html.matchAll(/(?:src|href)=["'](https?:\/\/[^"']+)["']/g)].map((m) => m[1]);
  if (external.length) {
    console.warn('WARNING: external references remain (will break under CSP):');
    for (const u of new Set(external)) console.warn('  ' + u);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
