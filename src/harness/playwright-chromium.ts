// Playwright's own Chromium, and what to say when it isn't installed.
//
// - Each Playwright version wants one Chromium build, downloaded apart
//   from the package (`pnpm install` doesn't fetch it) into a folder
//   named for the build: `~/.cache/ms-playwright/chromium-1248/`.
// - sm-dev uses whatever Playwright the repo has (a peer dependency),
//   so updating it there leaves sm-dev wanting a build that isn't
//   there yet, while the old one still is.

import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { quoted } from './output-style.js';

const INSTALL = 'pnpm exec playwright install chromium';

function playwrightVersion(): string | null {
  try {
    return (createRequire(import.meta.url)('@playwright/test/package.json') as { version: string }).version;
  } catch {
    return null;
  }
}

/**
 * Why Playwright's Chromium at `executable` can't start, when it isn't
 * installed: the Playwright version, the build it wants, the builds
 * that are installed, and the command that installs it. Null when it's
 * there.
 */
export function missingChromium(executable: string): string | null {
  if (existsSync(executable)) return null;
  const version = playwrightVersion();
  const using = version ? `Playwright ${version}` : 'Playwright';
  // The folder named for the build, above the executable.
  let dir = path.dirname(executable);
  while (!/^chromium-\d+$/.test(path.basename(dir)) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const build = /^chromium-(\d+)$/.exec(path.basename(dir))?.[1];
  if (!build) return `${using} needs Chromium at ${executable}, which isn't installed. Install it with ${quoted(INSTALL)}.`;
  let installed: string[] = [];
  try {
    installed = readdirSync(path.dirname(dir)).map((name) => /^chromium-(\d+)$/.exec(name)?.[1])
      // The wanted build's folder can be there without its executable,
      // after an install that was cut off.
      .filter((b): b is string => !!b && b !== build);
  } catch { /* No browsers folder yet. */ }
  const have = installed.length ? `(Installed builds: ${installed.join(', ')}.)` : '(No Chromium builds are installed.)';
  return `${using} needs Chromium build ${build}, which isn't installed. ${have} `
    + `Install it with ${quoted(INSTALL)}. Run that again after each Playwright update.`;
}
