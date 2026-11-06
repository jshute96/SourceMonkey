// `record-results.mjs import-results`: results files from the testing method,
// recorded as `set` would, all checked before anything is written.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('../../greasyfork-testing/record-results.mjs', import.meta.url));

let dir;
let corpusFile;
let root;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sm-import-results-'));
  corpusFile = path.join(dir, 'corpus.json');
  root = path.join(dir, 'files');
  await mkdir(root);
  await writeFile(corpusFile, JSON.stringify({ tags: { known: 'A known tag' }, scripts: { 1: {}, 2: {} } }));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function runImport(results, extra = {}) {
  const file = path.join(dir, 'results.json');
  await writeFile(file, JSON.stringify({ results, ...extra }));
  return spawnSync(process.execPath, [TOOL, 'import-results', file, '--corpus', corpusFile, '--root', root, '--date', '2026-01-02'], { encoding: 'utf8' });
}

const readBack = async () => JSON.parse(await readFile(corpusFile, 'utf8'));

test('records status, blame, reason, note and tags, and ignores other fields', async () => {
  const run = await runImport([
    { id: '1', status: 'pass', version: '1.2', summary: 'Works', safety: { verdict: 'ok', findings: [] }, tags: ['known'] },
    { id: 2, status: 'n/a', reason: 'unsafe', blame: null, note: 'Not run: sends cookies', tags: [] },
  ]);
  assert.equal(run.status, 0, run.stderr);
  const { scripts } = await readBack();
  assert.deepEqual(scripts[1].test, { status: 'pass', date: '2026-01-02', version: '1.2' });
  assert.deepEqual(scripts[1].tags, ['known']);
  assert.deepEqual(scripts[2].test, { status: 'n/a', reason: 'unsafe', date: '2026-01-02' });
  assert.equal(scripts[2].notes[0].text, 'Not run: sends cookies');
});

test('fail records its blame, and newTags are defined', async () => {
  const run = await runImport(
    [{ id: '1', status: 'fail', blame: 'script', note: 'Broken', tags: ['needs-webgl'] }],
    { newTags: { 'needs-webgl': 'Draws with WebGL', known: 'Another description' } },
  );
  assert.equal(run.status, 0, run.stderr);
  const corpus = await readBack();
  assert.equal(corpus.scripts[1].test.blame, 'script');
  assert.deepEqual(corpus.scripts[1].tags, ['needs-webgl']);
  assert.equal(corpus.tags['needs-webgl'], 'Draws with WebGL');
  assert.equal(corpus.tags.known, 'A known tag');
});

for (const [what, bad, message] of [
  ['a missing id', { status: 'pass' }, /Result number 2: The "id" field is missing/],
  ['a missing status', { id: '2' }, /"status" field is missing/],
  ['a fail with no note', { id: '2', status: 'fail', blame: 'script' }, /needs a "note" field/],
  ['a fail with no blame', { id: '2', status: 'fail', note: 'x' }, /needs a "blame" field/],
  ['an n/a with no reason', { id: '2', status: 'n/a', note: 'x' }, /needs a "reason" field/],
  ['a blame on a pass', { id: '2', status: 'pass', blame: 'script' }, /"blame" field only goes with/],
  ['another manager', { id: '2', status: 'pass', manager: 'tampermonkey' }, /only records sourcemonkey/],
  ['a second result for a script', { id: '1', status: 'pass' }, /more than one result/],
  ['an unknown reason', { id: '2', status: 'n/a', reason: 'nope', note: 'x' }, /Unknown reason/],
  ['a reason on a pass', { id: '2', status: 'pass', reason: 'paid' }, /"reason" field only goes with/],
  ['a non-numeric id', { id: 's1', status: 'pass' }, /"id" field must be a numeric script id/],
  ['an unlisted script', { id: '99', status: 'pass' }, /No script 99/],
  ['an undefined tag', { id: '2', status: 'pass', tags: ['nope'] }, /isn't defined/],
]) {
  test(`${what} refuses the whole file`, async () => {
    const before = await readFile(corpusFile, 'utf8');
    const run = await runImport([{ id: '1', status: 'pass' }, bad]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, message);
    assert.equal(await readFile(corpusFile, 'utf8'), before);
  });
}

test('a manager of sourcemonkey is accepted, and a whole file is written at once', async () => {
  const run = await runImport([
    { id: '1', status: 'pass', manager: 'sourcemonkey', note: 'One' },
    { id: '2', status: 'pass', manager: 'sourcemonkey', note: 'Two' },
  ]);
  assert.equal(run.status, 0, run.stderr);
  const { scripts } = await readBack();
  assert.equal(scripts[1].notes.length, 1);
  assert.equal(scripts[2].notes.length, 1);
});

test('a file with no results list is refused', async () => {
  const file = path.join(dir, 'x.json');
  await writeFile(file, '{}');
  const run = spawnSync(process.execPath, [TOOL, 'import-results', file, '--corpus', corpusFile, '--root', root], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no "results" list/);
});
