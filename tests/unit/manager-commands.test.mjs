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

// ---------- script print --file / --out, and script save ----------

const b64 = (text) => Buffer.from(text).toString('base64');
const deps = [
  { kind: 'require', url: 'https://cdn.example.com/npm/jquery@3/jquery.min.js', path: 'cdn.example.com/npm/jquery@3/jquery.min.js', base64: b64('jq();\n') },
  { kind: 'require', url: 'https://other.example.com/lib/util.js', path: 'other.example.com/lib/util.js', base64: b64('util();\n') },
  { kind: 'resource', name: 'icon', url: 'https://cdn.example.com/img/icon.png', path: 'cdn.example.com/img/icon.png', base64: Buffer.from([0x89, 0x50, 0, 1]).toString('base64'), contentType: 'image/png' },
  { kind: 'resource', name: 'css', url: 'https://other.example.com/x/util.js', path: 'other.example.com/x/util.js', base64: b64('/* css */\n') },
];
const withFiles = {
  ...manager,
  scriptText: async () => '// ==UserScript==\n// @name Dark mode\n// ==/UserScript==\nmain();\n',
  scriptFiles: async () => deps,
};

async function verb(name, args, flags, { json = false, cwd = '/', control = withFiles } = {}) {
  const out = [];
  const ok = await managerVerb({ manager: control, out: (l) => out.push(plainLine(l)), json, guarded: true, cwd }, 'script', name, 'E4', args, flags);
  return { ok, out };
}

test('script print --file picks a file by resource name or a unique part of its URL', async () => {
  assert.deepEqual(await verb('print', [], { '--file': 'jquery' }), { ok: true, out: ['jq();'] });
  // An exact resource name wins over URL parts.
  assert.deepEqual(await verb('print', [], { '--file': 'css' }), { ok: true, out: ['/* css */'] });
  assert.deepEqual(await verb('print', [], { '--file': 'script' }), { ok: true, out: ['// ==UserScript==', '// @name Dark mode', '// ==/UserScript==', 'main();'] });
  const several = await verb('print', [], { '--file': 'util' });
  assert.equal(several.ok, false);
  assert.deepEqual(several.out, [
    '[sm-dev] The name `util` matches multiple files of E4: Dark mode. Give more of the URL, or a @resource\'s name:',
    '  @require https://other.example.com/lib/util.js',
    '  @resource css https://other.example.com/x/util.js',
  ]);
  const none = await verb('print', [], { '--file': 'nope' });
  assert.deepEqual(none.out.slice(0, 2), ['[sm-dev] No file of E4: Dark mode matches `nope`. Its files:', '  @require https://cdn.example.com/npm/jquery@3/jquery.min.js']);
  assert.equal(none.out.length, 5);
  // A binary resource can only be written.
  assert.match((await verb('print', [], { '--file': 'icon' })).out[0], /@resource icon .* is not text \(image\/png\), so it can't be printed\. Use `--out <file>` to write it to a file\.$/);
  // Under a manager that doesn't give the files.
  const { scriptFiles: _, ...tm } = { ...withFiles, label: 'Tampermonkey' };
  assert.match((await verb('print', [], { '--file': 'jquery' }, { control: tm })).out[0], /Tampermonkey doesn't give sm-dev its scripts' @require and @resource files/);
});

test('script print --out writes the file', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'sm-print-'));
  try {
    assert.deepEqual(await verb('print', [], { '--file': 'icon', '--out': 'icon.png' }, { cwd: dir }), { ok: true, out: ['Wrote icon.png (4 bytes)'] });
    assert.deepEqual([...readFileSync(path.join(dir, 'icon.png'))], [0x89, 0x50, 0, 1]);
    const { out } = await verb('print', [], { '--out': 'x.user.js' }, { cwd: dir, json: true });
    const result = JSON.parse(out[0].slice(out[0].indexOf('{')));
    assert.deepEqual(result, { command: 'script print', script: 'E4', name: 'Dark mode', out: path.join(dir, 'x.user.js') });
    assert.match(readFileSync(path.join(dir, 'x.user.js'), 'utf8'), /main\(\);\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('script save writes the script and its files by URL, flat, or some of them, and replaces only with --force', async () => {
  const { existsSync, mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const cwd = mkdtempSync(path.join(tmpdir(), 'sm-save-'));
  try {
    const saved = await verb('save', ['out/sub'], {}, { cwd });
    assert.deepEqual(saved, {
      ok: true,
      out: [
        'Saved E4: Dark mode to out/sub: 5 files',
        '  out/sub/dark.user.js',
        '  out/sub/cdn.example.com/npm/jquery@3/jquery.min.js',
        '  out/sub/other.example.com/lib/util.js',
        '  out/sub/cdn.example.com/img/icon.png',
        '  out/sub/other.example.com/x/util.js',
      ],
    });
    assert.equal(readFileSync(path.join(cwd, 'out/sub/other.example.com/lib/util.js'), 'utf8'), 'util();\n');
    // Again: refused, naming what exists, until --force.
    const again = await verb('save', ['out/sub'], { '--only': 'script,resources' }, { cwd });
    assert.deepEqual(again, {
      ok: false,
      out: [
        '[sm-dev] ERROR: These files already exist. Use --force to replace them:',
        '  out/sub/dark.user.js',
        '  out/sub/cdn.example.com/img/icon.png',
        '  out/sub/other.example.com/x/util.js',
      ],
    });
    assert.equal((await verb('save', ['out/sub'], { '--only': 'script,resources', '--force': true }, { cwd })).ok, true);
    // Flat: two util.js files clash.
    const flat = await verb('save', ['flat'], { '--flat': true }, { cwd });
    assert.deepEqual(flat.out, ['[sm-dev] Multiple files of E4: Dark mode would be saved under the same name. Leave out --flat to save them in folders by URL:', '  flat/util.js']);
    assert.equal(existsSync(path.join(cwd, 'flat')), false);
    const flatRequires = await verb('save', ['flat'], { '--flat': true, '--only': 'requires' }, { cwd });
    assert.deepEqual(flatRequires.out, ['Saved E4: Dark mode to flat: 2 files', '  flat/jquery.min.js', '  flat/util.js']);
    assert.match((await verb('save', ['x'], { '--only': 'script,deps' }, { cwd })).out[0], /^\[sm-dev\] ERROR: The --only flag takes `script`, `requires`, `resources`, comma-separated, and not `deps`$/);
    // Under a manager that doesn't give the files: the script alone, said.
    const { scriptFiles: _, ...tm } = { ...withFiles, label: 'Tampermonkey' };
    const tmSaved = await verb('save', ['tm'], {}, { cwd, control: tm });
    assert.deepEqual(tmSaved.out, [
      'Saved E4: Dark mode to tm: 1 file',
      '  tm/dark.user.js',
      '  Tampermonkey doesn\'t give sm-dev its scripts\' @require and @resource files, so only the script itself can be printed or saved',
    ]);
    // A file where the directory would go.
    const blocked = await verb('save', ['out/sub/dark.user.js'], { '--only': 'script' }, { cwd });
    assert.match(blocked.out[0], /^\[sm-dev\] Could not create the directory out\/sub\/dark\.user\.js: /);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('script save puts a local file where a relative @require finds it, and skips a data: one', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const local = { ...scripts[0], location: 'file:///home/me/a/dark.user.js' };
  const control = {
    ...withFiles,
    scripts: async () => [local, scripts[1]],
    scriptFiles: async () => [
      { kind: 'require', url: 'file:///home/me/a/lib/util.js', path: 'util.js', base64: b64('util();\n') },
      { kind: 'require', url: 'file:///home/me/shared/other.js', path: 'other.js', base64: b64('other();\n') },
      { kind: 'require', url: `data:text/javascript;base64,${b64('x'.repeat(500))}`, base64: b64('x'.repeat(500)) },
    ],
  };
  const cwd = mkdtempSync(path.join(tmpdir(), 'sm-save-'));
  try {
    assert.deepEqual((await verb('save', ['out'], {}, { cwd, control })).out, [
      'Saved E4: Dark mode to out: 3 files',
      '  out/dark.user.js',
      '  out/lib/util.js',
      '  out/other.js',
      '  Skipped @require data:text/javascript;base64,...: It has no file name to save it as',
    ]);
    assert.equal(readFileSync(path.join(cwd, 'out/lib/util.js'), 'utf8'), 'util();\n');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a flag only another verb takes is refused', async () => {
  const { managerCommand } = await import('../../lib/harness/console-commands.js');
  const run = async (form, flags) => {
    const out = [];
    const ok = await managerCommand({ manager: withFiles, out: (l) => out.push(plainLine(l)), json: false }, 'script', { form, subject: 'E4', words: ['/tmp/x'], flags });
    return { ok, out };
  };
  assert.deepEqual(await run('save', { '--file': 'xx' }), {
    ok: false, out: ['[sm-dev] ERROR: The `script save` command has no --file flag. It takes --only, --flat, --force.'],
  });
  assert.deepEqual(await run('enable', { '--out': 'x' }), { ok: false, out: ['[sm-dev] ERROR: The `script enable` command has no --out flag. It takes no flags.'] });
});
