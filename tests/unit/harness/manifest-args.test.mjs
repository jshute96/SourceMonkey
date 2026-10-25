// sm-dev's manifest arguments (checks.ts): which words are manifests,
// and the scripts one lists, resolved as the extension resolves them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isManifestArg, manifestScripts } from '../../../lib/harness/checks.js';

test('a manifest is a script_manifest.json, as a path or a URL', () => {
  assert.equal(isManifestArg('tests/examples/script_manifest.json'), true);
  assert.equal(isManifestArg('https://x.io/a/script_manifest.json?t=1'), true);
  assert.equal(isManifestArg('file:///a/script_manifest.json'), true);
  assert.equal(isManifestArg('https://x.io/a.user.js'), false);
  assert.equal(isManifestArg('my_manifest.json'), false);
});

test('a local manifest lists paths for its file entries and URLs for web ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-manifest-'));
  try {
    const file = path.join(dir, 'script_manifest.json');
    fs.writeFileSync(file, JSON.stringify(['a.user.js', { path: 'sub/b.user.js' }, 'https://other.test/c.user.js', 'a.user.js']));
    assert.deepEqual(await manifestScripts(file), [
      path.join(dir, 'a.user.js'), path.join(dir, 'sub', 'b.user.js'), 'https://other.test/c.user.js',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a web manifest resolves its entries against its own URL', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/dir/script_manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ scripts: ['a.user.js', 'sub/b.user.js', 'https://other.test/c.user.js'] }));
    } else if (req.url === '/local/script_manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(['file:///etc/hosts.user.js']));
    } else if (req.url === '/bad/script_manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"scripts": "nope"}');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await manifestScripts(`${base}/dir/script_manifest.json`), [
      `${base}/dir/a.user.js`, `${base}/dir/sub/b.user.js`, 'https://other.test/c.user.js',
    ]);
    await assert.rejects(manifestScripts(`${base}/bad/script_manifest.json`), /can't be read: Manifest must be a JSON array/);
    await assert.rejects(manifestScripts(`${base}/none/script_manifest.json`), /The server answered 404/);
    // A manifest on the web doesn't reach this machine's files.
    await assert.rejects(manifestScripts(`${base}/local/script_manifest.json`), /a local file, which a manifest on the web can't/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('validate reports a manifest entry that is missing, and checks the rest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-manifest-'));
  try {
    const good = fileURLToPath(new URL('../../examples/headers-match-hash/match-exact.user.js', import.meta.url));
    fs.copyFileSync(good, path.join(dir, 'good.user.js'));
    fs.writeFileSync(path.join(dir, 'script_manifest.json'), JSON.stringify(['gone.user.js', 'good.user.js']));
    const cli = fileURLToPath(new URL('../../../lib/harness/cli.js', import.meta.url));
    // Read as plain text, whatever this environment asks for.
    const env = { ...process.env };
    delete env.FORCE_COLOR;
    const r = spawnSync(process.execPath, [cli, 'validate', 'script_manifest.json'], { cwd: dir, encoding: 'utf8', env });
    assert.equal(r.status, 1);
    const lines = r.stdout.split('\n');
    assert.equal(lines[0], 'INVALID  gone.user.js');
    assert.match(lines[1], /gone\.user\.js/);
    assert.equal(lines[2], 'ok       good.user.js');
    assert.equal(lines.at(-2), '1 ok, 1 invalid');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
