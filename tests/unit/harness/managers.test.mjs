// Unit tests for picking a userscript manager (`--manager`, managers.ts),
// which commands work with which (command-list.ts), and reading a
// fetched manager's package (manager-fetch.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { managerNamed } from '../../../lib/harness/managers.js';
import { commandManagers, unsupportedCommand } from '../../../lib/harness/command-list.js';
import { readCrx, unzipTo } from '../../../lib/harness/manager-fetch.js';
import { extensionIdFromKey } from '../../../lib/harness/extension-backend.js';

test('--manager takes the short and full names, in any case', () => {
  assert.equal(managerNamed('tm'), 'tampermonkey');
  assert.equal(managerNamed('VM'), 'violentmonkey');
  assert.equal(managerNamed('SourceMonkey'), 'sourcemonkey');
  assert.equal(managerNamed('greasemonkey'), null);
});

test('commands that work through SourceMonkey say so; page commands work with any manager', () => {
  assert.deepEqual(commandManagers('values'), ['sourcemonkey']);
  assert.equal(commandManagers('collection').length, 3);
  assert.equal(commandManagers('load').length, 3);
  assert.equal(commandManagers('click').length, 3);
  assert.equal(unsupportedCommand('click', 'tampermonkey', 'this run uses'), null);
  assert.equal(unsupportedCommand('script', 'violentmonkey', 'this run uses'), null);
  assert.equal(unsupportedCommand('script', 'tampermonkey', 'this run uses'), null);
  assert.equal(unsupportedCommand('values', 'violentmonkey', 'this run uses'),
    'The values command works with SourceMonkey only, and this run uses Violentmonkey');
});

// A zip of `files`, deflated, as a CRX holds one.
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const body = deflateRawSync(Buffer.from(text));
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// A protobuf length-delimited field.
function field(number, bytes) {
  const lengths = [];
  for (let n = bytes.length; ; n >>= 7) {
    lengths.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
    if (n <= 0x7f) break;
  }
  return Buffer.concat([Buffer.from([(number << 3) | 2, ...lengths]), bytes]);
}

test('a CRX gives its zip, and the key its extension id comes from', () => {
  const key = (n) => generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' });
  const [other, own] = [key(), key()];
  // The header proves both keys; the store's is the one matching the id.
  const header = Buffer.concat([field(2, field(1, other)), field(2, field(1, own))]);
  const body = zip({ 'manifest.json': '{"name":"X"}' });
  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0, 'latin1');
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  const crx = Buffer.concat([prefix, header, body]);
  const id = extensionIdFromKey(own.toString('base64'));
  const read = readCrx(crx, id);
  assert.equal(read.key, own.toString('base64'));
  assert.deepEqual(read.zip, body);
  assert.throws(() => readCrx(crx, 'a'.repeat(32)), /no key for extension id/);
  assert.throws(() => readCrx(body, id), /not a Chrome extension package/);
});

test('a zip unpacks into its folder, and a name reaching outside it is refused', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sm-unzip-'));
  try {
    await unzipTo(zip({ 'manifest.json': '{}', 'js/bg.js': 'go()' }), path.join(dir, 'a'));
    assert.equal(readFileSync(path.join(dir, 'a', 'js', 'bg.js'), 'utf8'), 'go()');
    await assert.rejects(unzipTo(zip({ '../evil.js': 'x' }), path.join(dir, 'b')), /outside its folder/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
