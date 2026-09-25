// Unit tests for `sm-dev run --devtools` (src/harness/devtools.ts,
// compiled to lib/harness/devtools.js): when it is on, and what a run
// says when the DevTools command line isn't installed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DevToolsLink, devtoolsWanted } from '../../lib/harness/devtools.js';

test('the flag wins over SM_DEV_DEVTOOLS, which is otherwise the default', () => {
  const saved = process.env.SM_DEV_DEVTOOLS;
  try {
    delete process.env.SM_DEV_DEVTOOLS;
    assert.equal(devtoolsWanted(undefined), false);
    assert.equal(devtoolsWanted(true), true);
    process.env.SM_DEV_DEVTOOLS = '1';
    assert.equal(devtoolsWanted(undefined), true);
    assert.equal(devtoolsWanted(false), false);
  } finally {
    if (saved === undefined) delete process.env.SM_DEV_DEVTOOLS;
    else process.env.SM_DEV_DEVTOOLS = saved;
  }
});

test('a missing chrome-devtools command is reported, and the run goes on', async () => {
  const savedPath = process.env.PATH;
  const savedRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.PATH = '/nonexistent';
  // So stopping it can't reach a live run's DevTools server of the same id.
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-devtools-test-'));
  process.env.XDG_RUNTIME_DIR = runtime;
  const out = [];
  try {
    const link = new DevToolsLink('D9', 'http://127.0.0.1:1', () => [], (l) => out.push(l));
    assert.equal(await link.ready, false);
    await link.stop();
  } finally {
    process.env.PATH = savedPath;
    if (savedRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = savedRuntime;
    rmSync(runtime, { recursive: true, force: true });
  }
  assert.deepEqual(out, ['[sm-dev] DevTools isn\'t available: The chrome-devtools command wasn\'t found. Install it with npm i -g chrome-devtools-mcp.']);
});
