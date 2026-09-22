// Build script for the SourceMonkey Chrome extension.
//
// What this does, end to end:
//   1. Wipes the dist/ directory so each build starts from a clean slate.
//   2. Copies src/icons/ -> dist/icons/ (the toolbar action icons in
//      16/48/128 sizes referenced by manifest.json).
//   3. Copies src/manifest.json -> dist/manifest.json verbatim. Chrome loads
//      the unpacked extension from dist/, so the manifest must live there.
//   4. Copies src/**/*.html -> dist/**/*.html (extension pages such as
//      collections.html and debug/icons.html), inlining the shared glyph
//      sprite where a page writes `<!--#include glyph-sprite-->`.
//   5. Runs the TypeScript compiler (tsc) to compile src/*.ts -> dist/*.js.
//      With --watch, tsc keeps running and rebuilds on change.
//
// Run with `pnpm run build`. Pass --watch to keep tsc running.
//
// Note on watch mode: only TypeScript is watched. If you edit
// src/manifest.json, src/glyph-sprite.svg, or any HTML/CSS asset,
// re-run `pnpm run build`.

import { rm, mkdir, cp, readdir, readFile, writeFile } from 'node:fs/promises';
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

// 2b. Vendor Prism.js (syntax highlighting for the userscript viewer).
// We copy from node_modules at build time so we don't check the
// library into the source tree; the userscript page loads these as
// plain <script>/<link> tags rather than ES modules.
const prismDir = resolve(root, 'node_modules', 'prismjs');
await mkdir(resolve(dist, 'vendor', 'prism'), { recursive: true });
await cp(resolve(prismDir, 'prism.js'), resolve(dist, 'vendor', 'prism', 'prism.js'));
await cp(resolve(prismDir, 'themes', 'prism.min.css'), resolve(dist, 'vendor', 'prism', 'prism.css'));
// Line-numbers plugin: adds a left-side gutter of line numbers next
// to each highlighted code block. Loaded after prism.js by the
// viewer page; activated by the `line-numbers` class on the <pre>.
await cp(
  resolve(prismDir, 'plugins', 'line-numbers', 'prism-line-numbers.min.js'),
  resolve(dist, 'vendor', 'prism', 'prism-line-numbers.js'),
);
await cp(
  resolve(prismDir, 'plugins', 'line-numbers', 'prism-line-numbers.min.css'),
  resolve(dist, 'vendor', 'prism', 'prism-line-numbers.css'),
);

// 3. Copy the manifest into dist/ so Chrome can find it when loading
//    unpacked from dist/.
await cp(resolve(src, 'manifest.json'), resolve(dist, 'manifest.json'));

// 4. Copy every HTML / CSS asset under src/, keeping its subdirectory
//    (collections.html, debug/icons.html, plus any shared *.css the pages
//    <link> in). Iterate so new pages and stylesheets get picked up
//    automatically without editing this script.
//
//    HTML gets one substitution on the way through: `<!--#include
//    glyph-sprite-->` is replaced with src/glyph-sprite.svg. The sprite
//    has to be inlined per page (a `<use href="other.svg#id">` across
//    documents doesn't inherit `currentColor`, and would be a second
//    fetch), but keeping one copy in the source tree is what stops two
//    pages from drifting into different glyphs. A page that doesn't
//    write the marker simply gets no sprite.
const SPRITE_MARKER = '<!--#include glyph-sprite-->';
const sprite = (await readFile(resolve(src, 'glyph-sprite.svg'), 'utf8')).trim();

// The sprite's header comment must contain no comment terminator of
// its own: anything ending in `--` + `>` before the root element closes
// that comment early and spills the remainder onto every page as
// visible text. Spelling the include marker out in the comment is how
// this happened once; any other stray terminator does the same, so the
// check is on the class, not that one phrase.
const rootAt = sprite.indexOf('<svg');
if (rootAt < 0) {
  throw new Error('src/glyph-sprite.svg has no <svg> root element.');
}
if (sprite.slice(0, rootAt).split('-->').length > 2) {
  throw new Error(
    'src/glyph-sprite.svg closes its header comment more than once before the'
    + ' <svg> root. The text after the first close leaks into every page.',
  );
}

for (const entry of await readdir(src, { withFileTypes: true, recursive: true })) {
  if (!entry.isFile()) continue;
  const ext = extname(entry.name);
  if (ext !== '.css' && ext !== '.html') continue;
  const relDir = entry.parentPath.slice(src.length).replace(/^[/\\]/, '');
  const relFile = relDir ? `${relDir}/${entry.name}` : entry.name;
  const srcFile = resolve(entry.parentPath, entry.name);
  const dstDir = relDir ? resolve(dist, relDir) : dist;
  await mkdir(dstDir, { recursive: true });
  const dstFile = resolve(dstDir, entry.name);
  if (ext === '.css') {
    await cp(srcFile, dstFile);
  } else if (ext === '.html') {
    const html = await readFile(srcFile, 'utf8');
    // One marker per page at most: a second would emit a second copy of
    // every symbol id, and `<use>` / `url(#…)` would silently bind to
    // whichever came first.
    const parts = html.split(SPRITE_MARKER);
    if (parts.length > 2) {
      throw new Error(`${relFile} writes the glyph-sprite marker more than once.`);
    }
    await writeFile(dstFile, parts.join(sprite));
  }
}

// 4b. Generate the userscript-wrapper template module.
//
// The injected wrapper lives in plain JS source files in src/ so they
// get real syntax highlighting and can be edited / linted as
// JavaScript rather than as embedded strings in TS. The build
// minifies each to a single physical line and writes them as exported
// string constants into dist/generated-wrappers.js. The injector
// splices these into chrome.userScripts.register specs as
// { code: ... } blobs.
//
// Why all-{code}, never {file}: chrome.userScripts.register's
// { file: "..." } entries are loaded asynchronously in MAIN world
// (likely via a <script src=> element under the hood), so the next
// js[] entry runs before the file has parsed. Per-script entries
// that depend on the prelude's helpers (self.__smRun, self.__smSealed)
// would then see "is not a function" on the first call.
// USER_SCRIPT world appears to load { file } synchronously, but using
// {code} unconditionally avoids relying on that distinction and keeps
// behavior identical across worlds. See docs/injection-modes.md.
//
// The minifier is intentionally conservative — see
// userscript-prelude.js for the source-file rules that keep it safe
// (only /* block */ comments, no // sequences inside strings).
await generateWrappers();

async function generateWrappers() {
  const wrapperFiles = [
    'userscript-prelude.js',
    'wrapper-bridge.js',
    'wrapper-gm-runtime.js',
  ];
  const out = ['/* Generated by scripts/build.mjs. Do not edit. */', ''];
  const exportName = {
    'userscript-prelude.js': 'WRAPPER_PRELUDE',
    'wrapper-bridge.js': 'WRAPPER_BRIDGE',
    'wrapper-gm-runtime.js': 'WRAPPER_GM_RUNTIME',
  };
  for (const name of wrapperFiles) {
    const text = await readFile(resolve(src, name), 'utf8');
    const minified = minifyForInjection(text);
    out.push(`export const ${exportName[name]} = ${JSON.stringify(minified)};`);
  }
  await writeFile(resolve(dist, 'generated-wrappers.js'), out.join('\n') + '\n');
  // The hand-written declarations go beside it: tsc emits `.d.ts` for
  // every module it compiles, and a consumer of the package resolving
  // `injector.d.ts` needs this one too.
  await cp(resolve(src, 'generated-wrappers.d.ts'), resolve(dist, 'generated-wrappers.d.ts'));
}

function minifyForInjection(source) {
  // Strip /* ... */ comments.
  let s = source.replace(/\/\*[\s\S]*?\*\//g, '');
  // Strip whole-line // comments (matches only lines whose first
  // non-whitespace token is //; safe for our wrapper sources, which
  // never use trailing-line comments).
  s = s.replace(/^\s*\/\/.*$/gm, '');
  // Collapse every whitespace run — including newlines — to a single
  // space. Drop leading/trailing whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// 5. Run tsc. Watch mode keeps tsc running until the user Ctrl-C's; we
//    await its exit so signals route through the build script and a spawn
//    failure surfaces as a non-zero exit instead of being silently
//    swallowed. Non-watch mode just runs once and propagates the exit code.
if (watch) {
  const child = spawn('pnpm', ['exec', 'tsc', '--watch'], { stdio: 'inherit', cwd: root });
  const code = await new Promise((res, rej) => {
    child.on('exit', (c) => res(c ?? 0));
    child.on('error', rej);
  });
  process.exit(code);
} else {
  const r = spawnSync('pnpm', ['exec', 'tsc'], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
