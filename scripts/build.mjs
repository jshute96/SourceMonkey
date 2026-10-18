// Build script for the SourceMonkey Chrome extension.
//
// What this does, end to end:
//   1. Builds into a fresh temporary directory, .build-<pid>/ (pid is
//      this process's id), beside dist/ and lib/. Each output is renamed
//      into place only once it is complete, so a running sm-dev, test,
//      or second build keeps using the previous output until then. A
//      failed build leaves the previous output standing.
//   2. Copies src/icons/ -> dist/icons/ (the toolbar action icons in
//      16/48/128 sizes referenced by manifest.json).
//   3. Copies src/manifest.json -> dist/manifest.json verbatim. Chrome loads
//      the unpacked extension from dist/, so the manifest must live there.
//      lib/ gets a copy for the harness, which reads the extension key.
//   4. Copies src/**/*.html -> dist/**/*.html (extension pages such as
//      collections.html and debug/icons.html), inlining the shared glyph
//      sprite where a page writes `<!--#include glyph-sprite-->`.
//   5. Runs the TypeScript compiler (tsc) twice: src/ (all but
//      src/harness/) -> dist/ for the extension, and src/harness/ plus
//      the shared modules directly in src/ -> lib/ (with .d.ts) for the
//      `sourcemonkey` package, whose development harness is Node-only
//      code Chrome never loads. See docs/architecture.md#source-layout.
//      With --watch, only the extension build runs, and after the
//      swap, tsc keeps running and rebuilds dist/ in place on change.
//
// Run with `pnpm run build`. Pass --watch to keep tsc running.
//
// Note on watch mode: only TypeScript is watched. If you edit
// src/manifest.json, src/glyph-sprite.svg, or any HTML/CSS asset,
// re-run `pnpm run build`.

import { rm, mkdir, cp, readdir, readFile, writeFile, rename, utimes } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { constants } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve, extname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const src = resolve(root, 'src');
const watch = process.argv.includes('--watch');
const buildStart = new Date();

// 1. Build into a temporary directory of our own. It sits in the repo
//    root rather than the system temp dir because the swap is a rename,
//    which can't cross filesystems. Watch mode rebuilds only dist/, so
//    it leaves lib/ standing: the harness tests and the validate script
//    import from it.
await removeAbandonedBuilds();
const buildDir = resolve(root, `.build-${process.pid}`);
const dist = resolve(buildDir, 'dist');
const lib = resolve(buildDir, 'lib');
await rm(buildDir, { recursive: true, force: true });

// Remove the build directory however this process ends: done, failed,
// thrown, or interrupted. 'exit' handlers must be synchronous. A signal
// would end the process without 'exit', so turn it into a process.exit
// with the usual 128 + signal code. Watch mode drops the signal
// handlers once the directory is gone, so Ctrl-C reaches tsc as before.
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }));
const BUILD_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const exitOnSignal = (signal) => process.exit(128 + constants.signals[signal]);
for (const signal of BUILD_SIGNALS) process.on(signal, exitOnSignal);

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

// 2c. Vendor fflate (zip writing for the backup export), as an ES
// module the extension imports from `vendor/fflate.js`. Its types are
// src/vendor/fflate.d.ts.
await cp(resolve(root, 'node_modules', 'fflate', 'esm', 'browser.js'), resolve(dist, 'vendor', 'fflate.js'));
// Its MIT license asks for the notice to travel with the code.
await cp(resolve(root, 'node_modules', 'fflate', 'LICENSE'), resolve(dist, 'vendor', 'fflate.LICENSE'));

// 3. Copy the manifest into dist/ so Chrome can find it when loading
//    unpacked from dist/. The package gets a copy too: the harness
//    derives the extension id from its `key` (extension-backend.ts).
//    dist/manifest.json gets its mtime set before the swap (step 5).
await cp(resolve(src, 'manifest.json'), resolve(dist, 'manifest.json'));
await mkdir(lib, { recursive: true });
await cp(resolve(src, 'manifest.json'), resolve(lib, 'manifest.json'));

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
// that depend on the prelude's helpers (the registry's run and sealed)
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
  const text = out.join('\n') + '\n';
  await writeFile(resolve(dist, 'generated-wrappers.js'), text);
  // The package gets the same module, plus the hand-written
  // declarations beside it: tsc emits a `.d.ts` for every module it
  // compiles, and a consumer resolving `injector.d.ts` needs this one
  // too. Written here rather than copied from dist so the two outputs
  // never depend on each other's timing.
  await mkdir(lib, { recursive: true });
  await writeFile(resolve(lib, 'generated-wrappers.js'), text);
  await cp(resolve(src, 'generated-wrappers.d.ts'), resolve(lib, 'generated-wrappers.d.ts'));
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

// 5. Run tsc into the build directory, then swap the outputs into
//    place. Watch mode builds only the extension: that is what a
//    developer watching `dist/` is iterating on, and the package build
//    is a full `pnpm run build`. Watch mode also carries on past type
//    errors, as `tsc --watch` does: tsc still writes its output, and
//    the watcher reports the errors and waits for a fix.
const compiles = [['exec', 'tsc', '--outDir', dist]];
if (!watch) compiles.push(['exec', 'tsc', '-p', 'tsconfig.lib.json', '--outDir', lib]);
for (const args of compiles) {
  const r = spawnSync('pnpm', args, { stdio: 'inherit', cwd: root });
  if (r.status !== 0 && !(watch && r.status === 2)) process.exit(r.status ?? 1);
}
// Where lib/ was built from, so sm-dev can say how to rebuild it
// (src/harness/rebuild-advice.ts), including in an installed copy.
if (!watch) await writeFile(resolve(lib, 'build-info.json'), JSON.stringify({ source: root }) + '\n');
// Date dist/manifest.json to when the build started, so an install
// script can treat dist/ as up to date when no input is newer than it,
// and an edit made during the build still counts as newer. Watch mode
// dates it 1970: its output carries on past type errors, so it never
// counts as an up-to-date build.
const manifestTime = watch ? new Date(0) : buildStart;
await utimes(resolve(dist, 'manifest.json'), manifestTime, manifestTime);
await swapIn(dist, resolve(root, 'dist'));
if (!watch) await swapIn(lib, resolve(root, 'lib'));
await rm(buildDir, { recursive: true, force: true });

// Watch mode then keeps tsc running on the real dist/ until the user
// Ctrl-C's. Its first pass rewrites files that are already there, so
// dist/ stays complete. We await its exit so signals route through the
// build script and a spawn failure surfaces as a non-zero exit instead
// of being silently swallowed.
if (watch) {
  for (const signal of BUILD_SIGNALS) process.off(signal, exitOnSignal);
  const child = spawn('pnpm', ['exec', 'tsc', '--watch'], { stdio: 'inherit', cwd: root });
  const code = await new Promise((res, rej) => {
    child.on('exit', (c) => res(c ?? 0));
    child.on('error', rej);
  });
  process.exit(code);
}

// Put a finished output directory at `dest`, replacing what's there.
// A rename can't replace a non-empty directory, so the old one is
// first renamed aside (into our build dir, removed on exit). `dest` is
// missing only for the moment between those renames.
//
// The loop covers a concurrent build swapping in its own output in
// that moment: we move that aside too. The last build to swap a
// directory wins it, so two concurrent builds can each win one of
// dist/ and lib/. The retries are capped so an error that keeps
// coming back can't spin forever.
async function swapIn(from, dest) {
  const aside = resolve(buildDir, `old-${basename(dest)}`);
  for (let tries = 1; ; tries++) {
    try {
      await rename(from, dest);
      return;
    } catch (err) {
      if (!['ENOTEMPTY', 'EEXIST'].includes(err.code) || tries > 5) {
        await restore(aside, dest);
        throw err;
      }
    }
    await rm(aside, { recursive: true, force: true });
    try {
      await rename(dest, aside);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

// After a failed swap, put the old output back if nothing replaced it,
// since the exit cleanup would otherwise delete it with the build dir.
async function restore(aside, dest) {
  try {
    await rename(aside, dest);
  } catch {
    // Nothing was set aside, or another build's output is in place.
  }
}

// Remove the .build-<pid> directories of builds that were killed
// before they could clean up. A directory whose process is still
// running belongs to a concurrent build, so it stays. (A build in a
// container sharing this checkout has a pid we can't see, so it
// would look dead. We don't build that way.)
async function removeAbandonedBuilds() {
  for (const name of await readdir(root)) {
    const pid = Number(/^\.build-(\d+)$/.exec(name)?.[1]);
    if (!pid || isRunning(pid)) continue;
    await rm(resolve(root, name), { recursive: true, force: true });
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return err.code === 'EPERM';
  }
}
