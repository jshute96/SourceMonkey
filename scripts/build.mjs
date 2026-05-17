// Build script for the VibeMonkey Chrome extension.
//
// What this does, end to end:
//   1. Wipes the dist/ directory so each build starts from a clean slate.
//   2. Copies src/icons/ -> dist/icons/ (the toolbar action icons in
//      16/48/128 sizes referenced by manifest.json).
//   3. Copies src/manifest.json -> dist/manifest.json verbatim. Chrome loads
//      the unpacked extension from dist/, so the manifest must live there.
//   4. Copies src/*.html -> dist/*.html (extension pages such as
//      options.html).
//   5. Runs the TypeScript compiler (tsc) to compile src/*.ts -> dist/*.js.
//      With --watch, tsc keeps running and rebuilds on change.
//
// Run with `npm run build`. Pass --watch to keep tsc running.
//
// Note on watch mode: only TypeScript is watched. If you edit
// src/manifest.json or any HTML/CSS asset, re-run `npm run build`.

import { rm, mkdir, cp, readdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const src = resolve(root, 'src');
const dist = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

// 1. Clean dist/.
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// 2. Copy icons.
await cp(resolve(src, 'icons'), resolve(dist, 'icons'), { recursive: true });

// 3. Copy the manifest into dist/ so Chrome can find it when loading
//    unpacked from dist/.
await cp(resolve(src, 'manifest.json'), resolve(dist, 'manifest.json'));

// 4. Copy every top-level HTML asset (options.html, etc.). Iterate so
//    new pages get picked up automatically without editing this script.
for (const entry of await readdir(src, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (extname(entry.name) === '.html') {
    await cp(resolve(src, entry.name), resolve(dist, entry.name));
  }
}

// 5. Run tsc. Watch mode keeps tsc running until the user Ctrl-C's; we
//    await its exit so signals route through the build script and a spawn
//    failure surfaces as a non-zero exit instead of being silently
//    swallowed. Non-watch mode just runs once and propagates the exit code.
if (watch) {
  const child = spawn('npx', ['tsc', '--watch'], { stdio: 'inherit', cwd: root });
  const code = await new Promise((res, rej) => {
    child.on('exit', (c) => res(c ?? 0));
    child.on('error', rej);
  });
  process.exit(code);
} else {
  const r = spawnSync('npx', ['tsc'], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
