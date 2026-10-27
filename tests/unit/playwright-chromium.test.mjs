// What sm-dev says when Playwright's Chromium build isn't installed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { missingChromium } from '../../lib/harness/playwright-chromium.js';

function browsersDir(t, ...builds) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pw-browsers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const b of builds) mkdirSync(path.join(dir, b), { recursive: true });
  return dir;
}

const wanted = (dir) => path.join(dir, 'chromium-1248', 'chrome-linux64', 'chrome');

test('null when the executable is there', (t) => {
  const dir = browsersDir(t, 'chromium-1248/chrome-linux64');
  writeFileSync(wanted(dir), '');
  assert.equal(missingChromium(wanted(dir)), null);
});

test('names the build wanted, the builds installed and the fix', (t) => {
  const dir = browsersDir(t, 'chromium-1100', 'chromium-1243', 'chromium_headless_shell-1248', 'ffmpeg-1011');
  const msg = missingChromium(wanted(dir));
  assert.match(msg, /^Playwright \d+\.\d+\.\d+ needs Chromium build 1248, which isn't installed\. \(Installed builds: (1100, 1243|1243, 1100)\.\) Install it with `pnpm exec playwright install chromium`\. /);
});

test('says when no builds are installed, leaving out a half-installed wanted one', (t) => {
  const dir = browsersDir(t, 'chromium-1248');
  assert.match(missingChromium(wanted(dir)), /isn't installed\. \(No Chromium builds are installed\.\) /);
  assert.match(missingChromium(wanted(path.join(dir, 'gone'))), /\(No Chromium builds are installed\.\) /);
});

test('gives the path when it has no build folder', () => {
  const msg = missingChromium('/nowhere/chrome');
  assert.match(msg, /needs Chromium at \/nowhere\/chrome, which isn't installed\. Install it with `pnpm exec playwright install chromium`\.$/);
});

test('gives the install command it is handed, as for sm-dev\'s own Playwright', (t) => {
  const dir = browsersDir(t);
  const msg = missingChromium(wanted(dir), 'npx playwright-core@1.64.1 install chromium');
  assert.match(msg, /Install it with `npx playwright-core@1\.64\.1 install chromium`\. /);
});
