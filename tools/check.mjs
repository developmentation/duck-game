#!/usr/bin/env node
// Syntax gate. A single stray backtick inside a GLSL comment once closed the
// template literal holding a shader, breaking the production build AND the dev
// server — so every agent's captures failed silently. One second here catches it.
//
//   node tools/check.mjs

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

// esbuild ships with vite and parses in-process in about a millisecond a file.
// Spawning `node --check` per file took minutes, and a slow gate gets skipped.
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

async function walk(dir, acc = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, acc);
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) acc.push(p);
  }
  return acc;
}

const files = [...(await walk('src')), ...(await walk('tools'))];
let bad = 0;

for (const f of files) {
  const src = await readFile(f, 'utf8');
  try {
    esbuild.transformSync(src, { loader: 'js', format: 'esm', sourcefile: f });
  } catch (err) {
    bad++;
    const e = err.errors?.[0];
    const where = e?.location ? `${e.location.line}:${e.location.column}` : '?';
    console.log(`FAIL ${f}:${where}\n    ${e?.text || err.message}`);
    if (e?.location?.lineText) console.log(`    | ${e.location.lineText.trim().slice(0, 100)}`);
  }
}

console.log(bad ? `\n${bad} of ${files.length} file(s) failed to parse` : `all ${files.length} files parse`);
process.exit(bad ? 1 : 0);
