// Unit tests for `collection list` and `script list`'s output, how
// collections and scripts are named, and the changing verbs' checks
// (src/harness/manager-commands.ts), against a stand-in
// for SourceMonkey, and for the extension's side of them
// (src/extension/managed-items.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectionList, managerVerb, pickCollection, pickManagedScript, runOfLinkId, scriptList } from '../../lib/harness/manager-commands.js';
import { linkRunId } from '../../lib/harness/extension-link.js';
import { managedCollection, managedScripts } from '../../dist/extension/managed-items.js';
import { plainLine } from '../../lib/harness/output-style.js';

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
const manager = { label: 'SourceMonkey', collections: async () => collections, scripts: async () => scripts, onDisk: async () => null };

async function lines(fn) {
  const out = [];
  await fn((line) => out.push(plainLine(line)));
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
  assert.throws(() => pickCollection(collections, 'C9'), /There is no collection `C9`/);
  assert.throws(() => pickCollection(collections, 'i'), /^Error: `i` names more than one collection: C1 \(mine\), C2 \(Scripts from web\)\. /);
  // Not a run's test collection by a part of its name.
  assert.throws(() => pickCollection(collections, 'test'), /No collection is named `test`/);
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

test('a script is named by its run number in its run, E-id, id, whole name, or a part only it has', () => {
  const own = new Map([['s2', '1']]);
  assert.equal(pickManagedScript(scripts, '1', { own }).id, 's2');
  assert.throws(() => pickManagedScript(scripts, '1'), /A number names one of a run's scripts, in that run/);
  assert.equal(pickManagedScript(scripts, 'e4').id, 's1');
  assert.equal(pickManagedScript(scripts, 'id=s2').id, 's2');
  assert.equal(pickManagedScript(scripts, 'dark').id, 's1');
  assert.throws(() => pickManagedScript(scripts, 'r'), /^Error: `r` names more than one script: E4: Dark mode, Run script\. /);
  assert.throws(() => pickManagedScript(scripts, 'E9'), /There is no script `E9`/);
});

test('a change to another run\'s script, or one that takes something away, is refused before SourceMonkey is asked', async () => {
  const asked = [];
  const changing = {
    ...manager,
    setScriptEnabled: async (id, enabled) => { asked.push([id, enabled]); return { script: { ...scripts[0], enabled }, turnedOff: [] }; },
    uninstallScript: async (id) => { asked.push([id]); return scripts[0]; },
  };
  const run = async (verb, args, guarded = true) => {
    const out = [];
    const ok = await managerVerb({ manager: changing, out: (l) => out.push(plainLine(l)), json: false, guarded, cwd: '/' }, 'script', verb, args[0], [], {});
    return { ok, out };
  };
  assert.deepEqual(await run('disable', ['Run script']), { ok: false, out: ['[sm-dev] Run script is a script of run D1, which only that run changes'] });
  assert.deepEqual(await run('uninstall', ['E4']), {
    ok: false, out: ['[sm-dev] ERROR: E4: Dark mode is installed in SourceMonkey in this browser, so this would remove it for real. Use --force to continue.'],
  });
  assert.deepEqual(asked, []);
  // Turning one off is easily undone, so needs no --force.
  assert.deepEqual(await run('disable', ['E4']), { ok: true, out: ['Disabled E4: Dark mode'] });
  // A --temp-browser's scripts are the run's own.
  assert.deepEqual(await run('uninstall', ['E4'], false), { ok: true, out: ['Uninstalled E4: Dark mode from C2: Scripts from web'] });
  assert.deepEqual(asked, [['s1', false], ['s1']]);
});

test('turning a script on lists the copies it turned off, and says when its collection is disabled', async () => {
  const inDir = { ...scripts[0], collectionId: 'dir' };
  const off = { ...scripts[0], id: 'o1', number: 7, version: '1.0', collectionId: 'dir', enabled: false };
  const changing = {
    ...manager,
    scripts: async () => [inDir, scripts[1]],
    setScriptEnabled: async (_id, enabled) => ({ script: { ...inDir, enabled }, turnedOff: [off] }),
  };
  const run = async (json) => {
    const out = [];
    await managerVerb({ manager: changing, out: (l) => out.push(plainLine(l)), json, guarded: true, cwd: '/' }, 'script', 'enable', 'E4', [], {});
    return out;
  };
  assert.deepEqual(await run(false), [
    'Enabled E4: Dark mode',
    '  Another version of this script was disabled: Version 1.0 (E7) in collection C1: mine',
    '  E4: Dark mode is enabled, but won\'t run because it\'s inside disabled collection C1: mine',
  ]);
  const [line] = await run(true);
  const result = JSON.parse(line.slice(line.indexOf('{')));
  assert.deepEqual(result.turnedOff.map((s) => [s.id, s.enabled]), [['E7', false]]);
  assert.equal(result.collectionDisabled, true);
});

test('the listings mark local files changed on disk, as the collections page does', async () => {
  const onDisk = { ...manager, onDisk: async () => ({ scripts: { s1: 'modified' }, collections: { dir: { modified: 1, deleted: 0, added: 2 } } }) };
  const listed = await lines((out) => collectionList(onDisk, out, false));
  assert.ok(listed.includes('      Refresh pending: 1 file modified, 2 new files on disk'), listed.join('\n'));
  assert.ok((await lines((out) => scriptList(onDisk, undefined, out, false))).includes('  E4: Dark mode 2.1 (modified on disk)'));
  const [json] = await lines((out) => scriptList(onDisk, undefined, out, true));
  assert.equal(JSON.parse(json.slice(json.indexOf('{'))).scripts.find((s) => s.id === 'E4').onDisk, 'modified');
});

test('the script or collection comes before its verb, and a missing one is said', async () => {
  const { managerCommandOf } = await import('../../lib/harness/console-commands.js');
  assert.deepEqual(managerCommandOf(['script', 'E4', 'enable']), { command: 'script', verb: 'enable' });
  assert.deepEqual(managerCommandOf(['script', 'install', 'x.user.js']), { command: 'script', verb: 'install' });
  // Picks the script, as before.
  assert.equal(managerCommandOf(['script', 'E4']), null);
  assert.deepEqual(managerCommandOf(['collection', 'C3', 'show']), { command: 'collection', verb: 'show' });
  // A flag's value before the verb isn't taken for the script.
  assert.deepEqual(managerCommandOf(['script', '--collection', 'C2', 'install', 'x.user.js']), { command: 'script', verb: 'install' });
  // The old order is still the verb's, which says the new one.
  assert.deepEqual(managerCommandOf(['script', 'enable', 'E4']), { command: 'script', verb: 'enable' });
  const { onlyInspects } = await import('../../lib/harness/console-commands.js');
  assert.equal(onlyInspects('script "Dark mode" show'), true);
  assert.equal(onlyInspects('script "Dark mode" disable'), false);
  const out = [];
  const ok = await managerVerb({ manager, out: (l) => out.push(plainLine(l)), json: false, guarded: true, cwd: '/' }, 'collection', 'show', undefined, [], {});
  assert.equal(ok, false);
  assert.deepEqual(out, ['[sm-dev] ERROR: The `collection show` command needs a collection: `collection <collection> show`']);
  out.length = 0;
  await managerVerb({ manager, out: (l) => out.push(plainLine(l)), json: false, guarded: true, cwd: '/' }, 'collection', 'rename', undefined, ['C3', 'New', 'name'], {});
  assert.deepEqual(out, ['[sm-dev] ERROR: Name the collection before the verb: `collection C3 rename ...`']);
  out.length = 0;
  await managerVerb({ manager, out: (l) => out.push(plainLine(l)), json: false, guarded: true, cwd: '/' }, 'script', 'enable', undefined, [], {});
  assert.deepEqual(out, ['[sm-dev] ERROR: The `script enable` command needs a script: `script <script> enable`. There is no selected script outside a run.']);
});

test('another manager\'s scripts: one collection, C0, and a run\'s scripts by their E-ids', async () => {
  const all = [{ id: 'all', number: 0, name: 'Violentmonkey', kind: 'container', enabled: true, scriptCount: 3 }];
  const vmScripts = [
    { id: '3', number: 3, name: 'Mine', location: 'https://example.org/mine.user.js', collectionId: 'all', enabled: true, status: 'ok' },
    { id: '5', number: 5, name: 'Run one', location: 'file:///home/me/run.user.js', loadedAs: '/home/me/run.user.js', collectionId: 'all', enabled: true, status: 'ok', run: 'D1' },
    { id: '6', number: 6, name: 'Left', location: '', collectionId: 'all', enabled: false, status: 'ok', leftBy: 'D2' },
  ];
  const vm = { label: 'Violentmonkey', collections: async () => all, scripts: async () => vmScripts, onDisk: async () => null };
  const view = { own: new Map([['5', '1']]), selected: { internalId: '5' } };
  assert.deepEqual(await lines((out) => scriptList(vm, undefined, out, false, view)), [
    'C0: Violentmonkey',
    '  E3: Mine',
    '      https://example.org/mine.user.js',
    '* E5: Run one (run D1\'s script 1)',
    '      /home/me/run.user.js',
    '  E6: Left (disabled, left by run D2, which ended)',
  ]);
  assert.equal(pickCollection(all, 'C0'), all[0]);
  assert.equal(pickManagedScript(vmScripts, '1', view), vmScripts[1]);
  const [json] = await lines((out) => scriptList(vm, undefined, out, true, view));
  const result = JSON.parse(json.slice(json.indexOf('{')));
  assert.deepEqual(result.scripts.map((s) => [s.id, s.kind, s.run, s.leftBy]), [['E3', 'installed', undefined, undefined], ['E5', 'run', 'D1', undefined], ['E6', 'installed', undefined, 'D2']]);
});
