// Checks on userscripts/ as a collection (see userscripts/README.md): its
// script_manifest.json lists every userscript there, categorized by its
// top-level directory, and the generated README tables are up to date
// in userscripts/ and in the examples' and bad-examples' own READMEs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const USERSCRIPTS = path.join(REPO, 'userscripts');
const UPDATE_README = path.join(REPO, 'skills/userscript-collections/scripts/update_readme.py');

test('userscripts/script_manifest.json lists every userscript, by directory', () => {
  const files = fs.readdirSync(USERSCRIPTS, { recursive: true })
    .map((f) => String(f).split(path.sep).join('/'))
    .filter((f) => f.endsWith('.user.js'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const { scripts } = JSON.parse(fs.readFileSync(path.join(USERSCRIPTS, 'script_manifest.json'), 'utf8'));
  assert.deepEqual(scripts.map((e) => e.path), files,
    'Out of date: run pnpm sm-dev manifest --dir userscripts userscripts --prune');
  for (const entry of scripts) {
    assert.equal(entry.category, entry.path.split('/')[0], `${entry.path}: category`);
  }
});

for (const dir of ['.', 'examples', 'bad-examples']) {
  test(`${path.join('userscripts', dir)}: README tables are up to date`, () => {
    try {
      execFileSync('python3', [UPDATE_README, '--check', '--root', path.join(USERSCRIPTS, dir)],
        { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      assert.fail(`${e.stderr || e.stdout}`.trim());
    }
  });
}
