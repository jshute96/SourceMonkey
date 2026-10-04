// Unit tests for `collection list` and `script list`'s output and
// collection naming (src/harness/manager-commands.ts), against a stand-in
// for SourceMonkey, and for the extension's side of them
// (src/extension/managed-items.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectionList, pickCollection, runOfLinkId, scriptList } from '../../lib/harness/manager-commands.js';
import { linkRunId } from '../../lib/harness/extension-link.js';
import { managedCollection, managedScripts } from '../../dist/extension/managed-items.js';

const collections = [
  { id: 'web', number: 2, name: 'Scripts from web', kind: 'container', enabled: true, scriptCount: 1 },
  { id: 'run', name: 'sm-dev test collection (run D1-ab12)', kind: 'container', run: 'D1-ab12', enabled: true, scriptCount: 1 },
  { id: 'dir', number: 1, name: 'mine', kind: 'directory', location: 'file:///home/me/mine/', enabled: false, error: 'The folder is gone', scriptCount: 0 },
];
const scripts = [
  { id: 's1', number: 4, name: 'Dark mode', version: '2.1', location: 'https://example.org/dark.user.js', collectionId: 'web', enabled: true, status: 'ok' },
  {
    id: 's2', name: 'Run script', location: 'scratch:///D1-ab12/x.user.js', sourceFile: 'file:///home/me/x.user.js', loadedAs: 'x.user.js',
    collectionId: 'run', enabled: true, status: 'ok',
  },
];
const manager = { collections: async () => collections, scripts: async () => scripts };

async function lines(fn) {
  const out = [];
  await fn((line) => out.push(line));
  return out;
}

test('a run\'s id in the extension names the run', () => {
  assert.equal(runOfLinkId(linkRunId('D3')), 'D3');
  assert.equal(runOfLinkId(linkRunId('Dmy-run')), 'Dmy-run');
});

test('collection list: numbered first, then runs\' test collections by run', async () => {
  assert.deepEqual(await lines((out) => collectionList(manager, out, false)), [
    'Collections in SourceMonkey:',
    '  C1: mine (directory): 0 scripts, disabled',
    '      file:///home/me/mine/',
    '      Failed to load: The folder is gone',
    '  C2: Scripts from web (container): 1 script',
    '  D1: sm-dev test collection (run D1-ab12) (container): 1 script',
  ]);
  const [json] = await lines((out) => collectionList(manager, out, true));
  const result = JSON.parse(json.slice(json.indexOf('{')));
  assert.deepEqual(result.collections[0], {
    id: 'C1', internalId: 'dir', name: 'mine', kind: 'directory', location: 'file:///home/me/mine/',
    enabled: false, status: 'load-failed', error: 'The folder is gone', scriptCount: 0,
  });
  assert.deepEqual(result.collections[2], {
    id: 'D1', internalId: 'run', name: 'sm-dev test collection (run D1-ab12)', kind: 'container', runCollection: 'D1', enabled: true, status: 'ok', scriptCount: 1,
  });
});

test('script list: under their collections, a run\'s scripts with no E-id', async () => {
  assert.deepEqual(await lines((out) => scriptList(manager, undefined, out, false)), [
    'C2: Scripts from web',
    '  E4: Dark mode 2.1',
    '      https://example.org/dark.user.js',
    'D1: sm-dev test collection (run D1-ab12)',
    '  Run script',
    '      x.user.js',
  ]);
  assert.deepEqual(await lines((out) => scriptList(manager, 'C1', out, false)), ['C1: mine', '  No scripts']);
  // A run's test collection, named by its run as collection list shows it.
  const [json] = await lines((out) => scriptList(manager, 'd1', out, true));
  const result = JSON.parse(json.slice(json.indexOf('{')));
  assert.deepEqual(result.scripts, [{
    kind: 'run', internalId: 's2', name: 'Run script', location: 'file:///home/me/x.user.js', file: 'x.user.js',
    collection: { id: 'D1', name: 'sm-dev test collection (run D1-ab12)' }, enabled: true, status: 'ok',
  }]);
});

test('in a run, script list numbers its own scripts as it does, and marks the selected one', async () => {
  const own = new Map([['s2', '1']]);
  assert.deepEqual((await lines((out) => scriptList(manager, 'D1', out, false, { own, selected: { internalId: 's2' } }))).slice(1, 2), ['* 1: Run script']);
  const [json] = await lines((out) => scriptList(manager, undefined, out, true, { own, selected: { label: 'E4' } }));
  const scripts = JSON.parse(json.slice(json.indexOf('{'))).scripts;
  assert.deepEqual(scripts.map((s) => [s.id, s.selected]), [['E4', true], ['1', undefined]]);
});

test('a collection is named by number, id, whole name, or a part only it has', () => {
  assert.equal(pickCollection(collections, 'c2').id, 'web');
  assert.equal(pickCollection(collections, 'id=dir').id, 'dir');
  assert.equal(pickCollection(collections, 'MINE').id, 'dir');
  assert.equal(pickCollection(collections, 'web').id, 'web');
  assert.equal(pickCollection(collections, 'D1').id, 'run');
  assert.throws(() => pickCollection(collections, 'C9'), /There is no collection C9/);
  assert.throws(() => pickCollection(collections, 'i'), /^Error: i names more than one collection: C1 \(mine\), C2 \(Scripts from web\)\. /);
  // Not a run's test collection by a part of its name.
  assert.throws(() => pickCollection(collections, 'test'), /No collection is named test/);
});

test('the extension lists a test collection by its run, with no location, and its scripts unnumbered', () => {
  const stored = {
    id: 'r', path: 'container:sm-dev:D1-ab12', displayName: 'sm-dev test collection (run D1-ab12)', scriptIds: ['x'], enabled: true, lastRefreshedAt: 0,
  };
  assert.deepEqual(managedCollection(stored, undefined), {
    id: 'r', name: 'sm-dev test collection (run D1-ab12)', kind: 'container', run: 'D1-ab12', enabled: true, scriptCount: 1,
  });
  const dir = { id: 'd', path: 'file:///a/', scriptIds: ['y'], enabled: true, lastRefreshedAt: 0 };
  const script = (id, collectionId) => ({ id, collectionId, relativePath: `${id}.user.js`, fileUrl: `file:///a/${id}.user.js`, status: 'ok', enabled: true, header: null });
  assert.deepEqual(managedScripts([stored, dir], [script('x', 'r'), script('y', 'd')], { y: 3 }).map((s) => [s.id, s.number]), [['x', undefined], ['y', 3]]);
});
