// The source tree's three parts, and the two builds' contents:
//   - src/extension/: modules only the extension loads.
//   - src/harness/: modules only the Node harness loads.
//   - src/ itself: modules both use.
// tsconfig.json builds dist/ (the extension) and tsconfig.lib.json builds
// lib/ (the package). Each compiles what its entry points import, type-only
// imports included, so these checks ask tsc which files each one reaches.
// See docs/architecture.md#source-layout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tsc = path.join(root, 'node_modules/typescript/bin/tsc');

// The source files a tsconfig compiles, relative to src/.
function compiled(config) {
  const out = execFileSync(process.execPath, [tsc, '-p', config, '--listFilesOnly'], { cwd: root, encoding: 'utf8' });
  const src = path.join(root, 'src') + path.sep;
  return out.split('\n').filter((f) => f.startsWith(src)).map((f) => f.slice(src.length).split(path.sep).join('/'));
}

const lib = compiled('tsconfig.lib.json');

test('lib/ compiles nothing from src/extension/', () => {
  assert.deepEqual(lib.filter((f) => f.startsWith('extension/')), [],
    'A harness or shared module imports an extension-only module. Move what it needs into src/.');
});

test('dist/ compiles nothing from src/harness/', () => {
  assert.deepEqual(compiled('tsconfig.json').filter((f) => f.startsWith('harness/')), []);
});

test('every module directly in src/ is one the harness uses', () => {
  const shared = readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.ts'));
  const unused = shared.filter((f) => !lib.includes(f));
  assert.deepEqual(unused, [],
    'Only the extension uses these, so they belong in src/extension/.');
});
