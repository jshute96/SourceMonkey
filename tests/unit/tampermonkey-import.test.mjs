// Unit tests for the Tampermonkey backup parser (src/extension/tampermonkey-import.ts).
//
// The format is described in docs/import-export-tampermonkey.md. The
// fixtures here are hand-built rather than captured from a real export
// so each test states exactly the one field it is about.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IMPORT_IS_USERSCRIPT,
  IMPORT_NOT_A_BACKUP,
  IMPORT_NO_SCRIPTS,
  importCollectionName,
  importedScriptFilename,
  parseTampermonkeyBackup,
} from '../../dist/extension/tampermonkey-import.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function userscript(name, extraHeaderLines = '') {
  return [
    '// ==UserScript==',
    `// @name         ${name}`,
    '// @match        https://example.com/*',
    extraHeaderLines,
    '// ==/UserScript==',
    '',
    "console.log('hi');",
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function backup(scripts) {
  return JSON.stringify({ settings: {}, scripts });
}

function script(overrides = {}) {
  const name = overrides.name ?? 'Test Script';
  return {
    uuid: 'uuid-1',
    name,
    file_url: null,
    enabled: true,
    position: 1,
    options: {},
    storage: { ts: 0, data: {} },
    source: b64(userscript(name)),
    requires: [],
    resources: [],
    ...overrides,
  };
}

// ---------- Happy path ----------

test('decodes the base64 source, including non-ASCII', () => {
  const src = userscript('Café ☕');
  const { scripts, warnings } = parseTampermonkeyBackup(
    backup([script({ name: 'Café ☕', source: b64(src) })]),
  );
  assert.equal(warnings.length, 0);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].source, src);
  assert.equal(scripts[0].name, 'Café ☕');
});

test('orders scripts by the dashboard position, unpositioned last', () => {
  const { scripts } = parseTampermonkeyBackup(
    backup([
      script({ name: 'Third', position: 3, uuid: 'c' }),
      script({ name: 'Nowhere', position: undefined, uuid: 'z' }),
      script({ name: 'First', position: 1, uuid: 'a' }),
    ]),
  );
  assert.deepEqual(
    scripts.map((s) => s.name),
    ['First', 'Third', 'Nowhere'],
  );
});

test('mirrors the enabled flag, and defaults a missing one to enabled', () => {
  const { scripts } = parseTampermonkeyBackup(
    backup([
      script({ name: 'Off', enabled: false, position: 1 }),
      script({ name: 'On', enabled: true, position: 2 }),
      script({ name: 'Unsaid', enabled: undefined, position: 3 }),
    ]),
  );
  assert.deepEqual(
    scripts.map((s) => s.enabled),
    [false, true, true],
  );
});

test('carries GM storage across, unwrapping the {ts, data} envelope', () => {
  const { scripts } = parseTampermonkeyBackup(
    backup([script({ storage: { ts: 123, data: { theme: 'dark', count: 7 } } })]),
  );
  assert.deepEqual(scripts[0].storage, { theme: 'dark', count: 7 });
});

test('a script with no storage gets an empty object, not undefined', () => {
  const { scripts } = parseTampermonkeyBackup(backup([script({ storage: undefined })]));
  assert.deepEqual(scripts[0].storage, {});
});

// ---------- Location ----------

test('takes the location from file_url when the backup names one', () => {
  const { scripts } = parseTampermonkeyBackup(
    backup([script({ file_url: 'https://example.com/a.user.js' })]),
  );
  assert.equal(scripts[0].location, 'https://example.com/a.user.js');
});

test('falls back to the header @downloadURL', () => {
  const src = userscript('Dl', '// @downloadURL https://greasyfork.org/x.user.js');
  const { scripts } = parseTampermonkeyBackup(
    backup([script({ name: 'Dl', source: b64(src), file_url: null })]),
  );
  assert.equal(scripts[0].location, 'https://greasyfork.org/x.user.js');
});

test('ignores @updateURL — it may point at a body-less .meta.js', () => {
  const src = userscript('Up', '// @updateURL https://greasyfork.org/x.meta.js');
  const { scripts } = parseTampermonkeyBackup(
    backup([script({ name: 'Up', source: b64(src), file_url: null })]),
  );
  assert.equal(scripts[0].location, undefined);
});

test('ignores a file:// location — it names a path on another machine', () => {
  const { scripts } = parseTampermonkeyBackup(
    backup([script({ file_url: 'file:///home/someone/a.user.js' })]),
  );
  assert.equal(scripts[0].location, undefined);
});

test('flags a Tampermonkey-local edit so the store can pin it', () => {
  const { scripts } = parseTampermonkeyBackup(
    backup([
      script({
        name: 'Edited',
        file_url: 'https://example.com/a.user.js',
        options: { user_modified: 1777135224538 },
      }),
    ]),
  );
  assert.equal(scripts[0].userModified, true);
  // The location is still reported; pinning is the store's call.
  assert.equal(scripts[0].location, 'https://example.com/a.user.js');
});

test('user_modified: null reads as not edited', () => {
  const { scripts } = parseTampermonkeyBackup(
    backup([script({ options: { user_modified: null } })]),
  );
  assert.equal(scripts[0].userModified, false);
});

// ---------- Partial failure ----------

test('one unreadable script becomes a warning; the rest still import', () => {
  const { scripts, warnings } = parseTampermonkeyBackup(
    backup([
      script({ name: 'Good', position: 1 }),
      script({ name: 'Bad', position: 2, source: '!!!not base64!!!' }),
    ]),
  );
  assert.deepEqual(
    scripts.map((s) => s.name),
    ['Good'],
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Bad/);
});

test('an empty source is a warning, not a silently blank script', () => {
  const { scripts, warnings } = parseTampermonkeyBackup(
    backup([script({ name: 'Good', position: 1 }), script({ name: 'Blank', position: 2, source: b64('   ') })]),
  );
  assert.equal(scripts.length, 1);
  assert.match(warnings[0], /Blank/);
});

test('a nameless broken entry is identified by its position in the file', () => {
  const { warnings } = parseTampermonkeyBackup(
    backup([script({ name: 'Good' }), { name: '', source: 42 }]),
  );
  assert.match(warnings[0], /script 2/);
});

test('when every script fails, the throw says so rather than "no scripts"', () => {
  assert.throws(
    () => parseTampermonkeyBackup(backup([script({ name: 'Bad', source: 42 })])),
    (err) => {
      assert.match(err.message, /No userscript in this backup could be read/);
      assert.match(err.message, /Bad/);
      return true;
    },
  );
});

// ---------- Rejected files ----------

test('an empty file is named as such', () => {
  assert.throws(() => parseTampermonkeyBackup('   \n  '), /The file is empty/);
});

test('a userscript is redirected to the Add field', () => {
  assert.throws(() => parseTampermonkeyBackup(userscript('Nope')), (err) => {
    assert.equal(err.message, IMPORT_IS_USERSCRIPT);
    return true;
  });
});

test('a userscript with leading blank lines is still recognised', () => {
  assert.throws(
    () => parseTampermonkeyBackup(`\n\n${userscript('Nope')}`),
    (err) => {
      assert.equal(err.message, IMPORT_IS_USERSCRIPT);
      return true;
    },
  );
});

test('a file that is not JSON is rejected as not a backup', () => {
  assert.throws(() => parseTampermonkeyBackup('hello there'), (err) => {
    assert.equal(err.message, IMPORT_NOT_A_BACKUP);
    return true;
  });
});

test('JSON without a scripts array is rejected as not a backup', () => {
  assert.throws(() => parseTampermonkeyBackup('{"settings":{}}'), (err) => {
    assert.equal(err.message, IMPORT_NOT_A_BACKUP);
    return true;
  });
});

test('a top-level JSON array is rejected as not a backup', () => {
  assert.throws(() => parseTampermonkeyBackup('[]'), (err) => {
    assert.equal(err.message, IMPORT_NOT_A_BACKUP);
    return true;
  });
});

test('a backup with an empty scripts list says it holds nothing', () => {
  assert.throws(() => parseTampermonkeyBackup(backup([])), (err) => {
    assert.equal(err.message, IMPORT_NO_SCRIPTS);
    return true;
  });
});

// ---------- Filenames ----------

test('importedScriptFilename: appends the .user.js extension', () => {
  assert.equal(importedScriptFilename('My Script', new Set()), 'My Script.user.js');
});

test('importedScriptFilename: keeps hyphens and other title punctuation', () => {
  assert.equal(
    importedScriptFilename('Pinkbike: auto-close ads!', new Set()),
    'Pinkbike auto-close ads!.user.js',
  );
});

test('importedScriptFilename: strips path separators so the name is one segment', () => {
  assert.equal(importedScriptFilename('a/b\\c', new Set()), 'a b c.user.js');
});

test('importedScriptFilename: does not double the extension', () => {
  assert.equal(importedScriptFilename('thing.user.js', new Set()), 'thing.user.js');
});

test('importedScriptFilename: dedups repeats within one import', () => {
  const seen = new Set();
  assert.equal(importedScriptFilename('Same', seen), 'Same.user.js');
  assert.equal(importedScriptFilename('Same', seen), 'Same-2.user.js');
  assert.equal(importedScriptFilename('Same', seen), 'Same-3.user.js');
});

test('importedScriptFilename: dedup is case-insensitive, matching real filesystems', () => {
  const seen = new Set();
  assert.equal(importedScriptFilename('Same', seen), 'Same.user.js');
  assert.equal(importedScriptFilename('SAME', seen), 'SAME-2.user.js');
});

test('importedScriptFilename: a nameless script still gets a filename', () => {
  assert.equal(importedScriptFilename('', new Set()), 'userscript.user.js');
  assert.equal(importedScriptFilename('///', new Set()), 'userscript.user.js');
});

test('importedScriptFilename: leading dots are dropped so it is not a hidden file', () => {
  assert.equal(importedScriptFilename('.hidden', new Set()), 'hidden.user.js');
});

test('importCollectionName: names the manager and dates the run', () => {
  const name = importCollectionName(new Date(2026, 7, 8));
  assert.match(name, /^Imported from Tampermonkey \(.+\)$/);
});

test('a stringified position still orders the script', () => {
  const { scripts } = parseTampermonkeyBackup(
    backup([
      script({ name: 'Second', position: '2' }),
      script({ name: 'First', position: '1' }),
    ]),
  );
  assert.deepEqual(scripts.map((s) => s.name), ['First', 'Second']);
});

test('a nonsense position sorts last rather than poisoning the order', () => {
  const { scripts } = parseTampermonkeyBackup(
    backup([
      script({ name: 'Junk', position: 'later, please' }),
      script({ name: 'Real', position: 1 }),
    ]),
  );
  assert.deepEqual(scripts.map((s) => s.name), ['Real', 'Junk']);
});

test('storage that is not a {ts, data} envelope reads as empty', () => {
  for (const storage of [[], 'nope', 42, { ts: 0, data: [] }]) {
    const { scripts } = parseTampermonkeyBackup(backup([script({ storage })]));
    assert.deepEqual(scripts[0].storage, {}, `for ${JSON.stringify(storage)}`);
  }
});

test('two scripts sharing a @name get distinct filenames end to end', () => {
  const { scripts } = parseTampermonkeyBackup(
    backup([
      script({ name: 'Same', uuid: 'a', position: 1 }),
      script({ name: 'Same', uuid: 'b', position: 2 }),
    ]),
  );
  const seen = new Set();
  const names = scripts.map((s) => importedScriptFilename(s.name, seen));
  assert.deepEqual(names, ['Same.user.js', 'Same-2.user.js']);
});
