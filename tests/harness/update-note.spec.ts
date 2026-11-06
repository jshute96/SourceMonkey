// `start` announces a newer sm-dev on stderr, once, and keeps it out of
// the run's output and log. The rest of the update check is covered by
// tests/unit/harness/update-check.test.mjs.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from '../fixtures/harness.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('start shows a newer version first, on stderr only', async ({ scriptsDir }) => {
  // A copy of the package marked as published, at an old version.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sm-update-note-'));
  try {
    const copy = path.join(dir, 'copy');
    mkdirSync(copy);
    cpSync(path.join(REPO_ROOT, 'lib'), path.join(copy, 'lib'), { recursive: true });
    symlinkSync(path.join(REPO_ROOT, 'dist'), path.join(copy, 'dist'));
    symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(copy, 'node_modules'));
    writeFileSync(path.join(copy, 'package.json'), JSON.stringify({ name: 'not-a-checkout', version: '0.0.1', type: 'module' }));
    writeFileSync(path.join(copy, 'lib', 'build-info.json'), '{"release":true}');
    const cache = path.join(dir, 'cache');
    mkdirSync(path.join(cache, 'sm-dev'), { recursive: true });
    const old = Date.now() - 48 * 60 * 60 * 1000;
    writeFileSync(path.join(cache, 'sm-dev', 'latest-version.json'), JSON.stringify({ checkedAt: Date.now(), latest: '9.9.9', publishedAt: old }));

    const file = scriptsDir.write({ relativePath: 'noted.user.js', meta: { name: 'Noted', match: ['*://*/none.html'] }, body: '' });
    const { CI, SM_DEV_NO_UPDATE_CHECK, ...rest } = process.env;
    const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
      ?? path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
    const sm = (...args: string[]) => spawnSync(process.execPath, [path.join(copy, 'lib', 'harness', 'cli.js'), ...args], {
      cwd: dir,
      encoding: 'utf8',
      // Playwright looks for its browsers under XDG_CACHE_HOME too.
      env: { ...rest, XDG_CACHE_HOME: cache, PLAYWRIGHT_BROWSERS_PATH: browsers },
    });

    const note = '[sm-dev] sm-dev 9.9.9 is available (current is 0.0.1). Update it the way you installed it.';
    const started = sm('--run', 'Dnoted', 'start', '--detach', file);
    try {
      expect(started.status, started.stdout + started.stderr).toBe(0);
      expect(started.stderr.split('\n')[0]).toBe(note);
      expect(started.stderr.split(note).length).toBe(2);
      expect(started.stdout).not.toContain('9.9.9');
      const log = /Output log: (\S+)/.exec(started.stdout + started.stderr)?.[1];
      expect(log).toBeTruthy();
      expect(readFileSync(log!, 'utf8')).not.toContain('9.9.9');
    } finally {
      sm('--run', 'Dnoted', 'stop');
    }

    // After `--version` on the same command line, it isn't repeated.
    const both = sm('--version', '--run', 'Dnoted', 'start', '--detach', file);
    try {
      expect(both.status, both.stdout + both.stderr).toBe(0);
      expect(both.stderr.split('9.9.9').length).toBe(2);
      expect(both.stderr).not.toContain('current is');
    } finally {
      sm('--run', 'Dnoted', 'stop');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
