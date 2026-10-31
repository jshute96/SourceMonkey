// Launches Chromium with Tampermonkey (TM) or Violentmonkey (VM) in a
// new temporary profile, for the cross-manager examples suite. The
// counterpart of sourcemonkey-launch.ts, and like it a thin layer over
// sm-dev's own launcher (`launchExtensionBrowser`).
//
// - The manager is the unpacked copy `sm-dev --manager tm|vm manager
//   fetch` keeps in its cache, fetched here when there is none. Its
//   manifest carries the Web Store's `key`, so it keeps the store's
//   extension ID.
// - Nothing carries over between runs: each worker starts from an empty
//   manager, so stale or renamed copies of the examples can't build up.
// - What a person would otherwise click is written into the profile
//   before the browser starts (see `launchExtensionBrowser`): "Allow
//   User Scripts", "Allow access to file URLs", and, for TM, Chrome's
//   `downloads` permission. TM asks for that one at the first
//   GM_download, through Chrome's own grant bubble, which a headless
//   browser can't show.

import type { BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fetchedId, launchExtensionBrowser } from '../../lib/harness/extension-launch.js';
import { fetchManager, fetchedDir, fetchedVersion, managerCacheDir } from '../../lib/harness/manager-fetch.js';
import type { ExternalManagerName } from './manager';
import { managerConfig } from './managers.mjs';

export interface LaunchedManager {
  ctx: BrowserContext;
  /** The loaded copy's extension ID, which the drivers look it up by. */
  extensionId: string;
  close(): Promise<void>;
}

/** Launches a browser with `name` loaded; `headed` shows its window. */
export async function launchManagerContext(name: ExternalManagerName, headed: boolean): Promise<LaunchedManager> {
  await ensureFetched(name);
  const launched = await launchExtensionBrowser({
    manager: name,
    headed,
    fileAccess: true,
    permissions: managerConfig(name).preGrantDownloads ? ['downloads'] : [],
  });
  return { ctx: launched.context, extensionId: fetchedId(fetchedDir(name), name), close: launched.close };
}

// A lock older than this is taken as left by a run that was killed
// while fetching.
const STALE_LOCK_MS = 5 * 60_000;

// Fetches the manager when sm-dev's cache has none. Workers start
// together, so the first takes a lock and the others wait for its
// copy rather than downloading over it.
export async function ensureFetched(name: ExternalManagerName): Promise<void> {
  if (fetchedVersion(name)) return;
  fs.mkdirSync(managerCacheDir(), { recursive: true });
  const lock = path.join(managerCacheDir(), `.${name}.fetching`);
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) fs.rmSync(lock, { recursive: true, force: true });
  } catch { /* no lock */ }
  let mine = false;
  try {
    fs.mkdirSync(lock);
    mine = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  if (mine) {
    try {
      await fetchManager(name, (line) => console.log(line));
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
    return;
  }
  while (fs.existsSync(lock)) await new Promise((r) => setTimeout(r, 500));
  if (!fetchedVersion(name)) {
    throw new Error(`${managerConfig(name).label} could not be fetched. Fetch it with \`scripts/sm-dev --manager ${managerConfig(name).scriptSuffix} manager fetch\`, then run the tests again.`);
  }
}
