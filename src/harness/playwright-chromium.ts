// Which Playwright sm-dev drives browsers with, its own Chromium, and
// what to say when that Chromium isn't installed.
//
// - sm-dev uses the Playwright the repo has (`@playwright/test`, an
//   optional peer dependency), so the fixture and the repo's own specs
//   share one copy.
// - With none, as under `npx sm-dev`, it falls back to the
//   `playwright-core` it depends on itself.
// - Each Playwright version wants one Chromium build, downloaded apart
//   from the package (`pnpm install` doesn't fetch it) into a folder
//   named for the build: `~/.cache/ms-playwright/chromium-1248/`.
//   Updating Playwright leaves sm-dev wanting a build that isn't there
//   yet, while the old one still is.

import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { quoted } from './output-style.js';

const REPO_INSTALL = 'pnpm exec playwright install chromium';

type Chromium = typeof import('@playwright/test')['chromium'];

interface Playwright {
  chromium: Chromium;
  /** The command that installs the Chromium build it wants. */
  install: string;
}

let loaded: Promise<Playwright> | null = null;

function isNotFound(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

function packageVersion(name: string): string | null {
  try {
    return (createRequire(import.meta.url)(`${name}/package.json`) as { version: string }).version;
  } catch {
    return null;
  }
}

/** The repo's Playwright when it has one, else sm-dev's own. */
export function loadPlaywright(): Promise<Playwright> {
  loaded ??= (async () => {
    try {
      const { chromium } = await import('@playwright/test');
      return { chromium, install: REPO_INSTALL };
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    const { chromium } = await import('playwright-core');
    // Pinned to the bundled version: a plain `npx playwright-core`
    // fetches the newest, which wants a different build.
    const version = packageVersion('playwright-core');
    return {
      chromium: chromium as unknown as Chromium,
      install: `npx playwright-core${version ? `@${version}` : ''} install chromium`,
    };
  })();
  return loaded;
}

function playwrightVersion(): string | null {
  return packageVersion('@playwright/test') ?? packageVersion('playwright-core');
}

/**
 * Why Playwright's Chromium at `executable` can't start, when it isn't
 * installed: the Playwright version, the build it wants, the builds
 * that are installed, and `install`, the command that installs it
 * (from `loadPlaywright`). Null when it's there.
 */
export function missingChromium(executable: string, install = REPO_INSTALL): string | null {
  if (existsSync(executable)) return null;
  const version = playwrightVersion();
  const using = version ? `Playwright ${version}` : 'Playwright';
  // The folder named for the build, above the executable.
  let dir = path.dirname(executable);
  while (!/^chromium-\d+$/.test(path.basename(dir)) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const build = /^chromium-(\d+)$/.exec(path.basename(dir))?.[1];
  if (!build) return `${using} needs Chromium at ${executable}, which isn't installed. Install it with ${quoted(install)}.`;
  let installed: string[] = [];
  try {
    installed = readdirSync(path.dirname(dir)).map((name) => /^chromium-(\d+)$/.exec(name)?.[1])
      // The wanted build's folder can be there without its executable,
      // after an install that was cut off.
      .filter((b): b is string => !!b && b !== build);
  } catch { /* No browsers folder yet. */ }
  const have = installed.length ? `(Installed builds: ${installed.join(', ')}.)` : '(No Chromium builds are installed.)';
  return `${using} needs Chromium build ${build}, which isn't installed. ${have} `
    + `Install it with ${quoted(install)}. Run that again after each Playwright update.`;
}
