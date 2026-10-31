// Launches Chromium with SourceMonkey and Tampermonkey (TM),
// Violentmonkey (VM) or both loaded, for checking how their `.user.js`
// captures get along (tests/all-managers/).
//
// - TM and VM are the copies `sm-dev --manager tm|vm manager fetch`
//   keeps in its cache, fetched by manager-launch.ts's `ensureFetched`
//   when missing.
// - Each extension gets "Allow User Scripts" in the profile up front, as
//   the single-manager launches do.
// - Chrome grants file access to every `--load-extension` extension,
//   whatever the profile says, so VM's "Allow access to file URLs" can't
//   be turned off for real. `vmFileAccess: false` runs a copy of VM whose
//   worker is patched to behave as Chrome makes it without that access:
//   `isAllowedFileSchemeAccess` answers false, and its `webRequest`
//   listener isn't given `file://` requests. That follows how VM checks
//   today, so a VM update can make it stop working silently, and Chrome
//   still grants the access for anything VM does without asking.

import { chromium, type BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchedId, prepareProfile, EXTENSION_DIR } from '../../lib/harness/extension-launch.js';
import { sourceMonkeyExtensionId } from '../../lib/harness/extension-backend.js';
import { fetchedDir } from '../../lib/harness/manager-fetch.js';
import { ensureFetched } from './manager-launch';

export interface AllManagersOptions {
  /** The managers loaded beside SourceMonkey. */
  others: ('tm' | 'vm')[];
  /** VM's "Allow access to file URLs" (simulated when false; see above). On by default. */
  vmFileAccess?: boolean;
  /** VM's `helpForLocalFile` option: its help page for a local file it can't read. On by default. */
  vmLocalFileHelp?: boolean;
}

export interface AllManagers {
  ctx: BrowserContext;
  ids: { sm: string; tm: string; vm: string };
  close(): Promise<void>;
}

// Prepended to the VM copy's worker for `vmFileAccess: false`.
const NO_FILE_ACCESS_PATCH = `
chrome.extension.isAllowedFileSchemeAccess = (cb) => { cb?.(false); return Promise.resolve(false); };
{
  const ev = chrome.webRequest.onBeforeRequest;
  const add = ev.addListener.bind(ev);
  ev.addListener = (fn, filter, ...rest) =>
    add(fn, { ...filter, urls: filter.urls.filter((u) => !u.startsWith('file:')) }, ...rest);
}
`;

export async function launchAllManagers(options: AllManagersOptions): Promise<AllManagers> {
  const withTm = options.others.includes('tm');
  const withVm = options.others.includes('vm');
  if (withTm) await ensureFetched('tampermonkey');
  if (withVm) await ensureFetched('violentmonkey');
  const tmDir = fetchedDir('tampermonkey');
  let vmDir = fetchedDir('violentmonkey');
  const ids = {
    sm: await sourceMonkeyExtensionId(),
    tm: withTm ? fetchedId(tmDir, 'tampermonkey') : '',
    vm: withVm ? fetchedId(vmDir, 'violentmonkey') : '',
  };
  const temp: string[] = [];
  if (withVm && options.vmFileAccess === false) {
    // The copy keeps the manifest's `key`, so VM keeps its ID.
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-all-managers-vm-'));
    temp.push(copy);
    fs.cpSync(vmDir, copy, { recursive: true });
    const sw = path.join(copy, 'sw.js');
    fs.writeFileSync(sw, NO_FILE_ACCESS_PATCH + fs.readFileSync(sw, 'utf8'));
    vmDir = copy;
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-all-managers-profile-'));
  temp.push(profile);
  // SourceMonkey's settings and first-run flag, then the managers' grants
  // beside them.
  await prepareProfile(profile);
  const prefsPath = path.join(profile, 'Default', 'Preferences');
  const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
  prefs.extensions ??= {};
  prefs.extensions.settings ??= {};
  for (const id of [ids.sm, ids.tm, ids.vm].filter(Boolean)) {
    prefs.extensions.settings[id] = { ...prefs.extensions.settings[id], user_scripts_enabled: true, newAllowFileAccess: true };
  }
  fs.writeFileSync(prefsPath, JSON.stringify(prefs));

  const dirs = [EXTENSION_DIR, ...(withTm ? [tmDir] : []), ...(withVm ? [vmDir] : [])].join(',');
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${dirs}`, `--load-extension=${dirs}`],
  });
  const close = async (): Promise<void> => {
    await ctx.close().catch(() => undefined);
    for (const dir of temp) fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const worker = async (id: string) => {
      const ours = (w: { url(): string }) => w.url().startsWith(`chrome-extension://${id}/`);
      return ctx.serviceWorkers().find(ours) ?? ctx.waitForEvent('serviceworker', { predicate: ours, timeout: 15_000 });
    };
    // TM opens an "installed" page shortly after each start; its
    // `notification_showUpdate` setting turns that off.
    if (withTm) await (await worker(ids.tm)).evaluate(async () => {
      const key = '!extdb.#config';
      const config = (await chrome.storage.local.get(key))[key] ?? { origin: 'normal', value: {} };
      config.value.notification_showUpdate = 'off';
      await chrome.storage.local.set({ [key]: config });
    });
    // VM's options go through its own `SetOptions` command, sent from one
    // of its pages. (Restarting it to reread storage would stop it: a
    // reloaded `--load-extension` copy doesn't come back.)
    if (withVm && options.vmLocalFileHelp === false) {
      const page = await ctx.newPage();
      await page.goto(`chrome-extension://${ids.vm}/options/index.html`);
      await page.evaluate(() => chrome.runtime.sendMessage({ cmd: 'SetOptions', data: { helpForLocalFile: false } }));
      await page.close();
    }
    // Let the managers settle, then close whatever they opened.
    await new Promise((r) => setTimeout(r, 1500));
    const fresh = await ctx.newPage();
    for (const page of ctx.pages()) if (page !== fresh) await page.close().catch(() => undefined);
    return { ctx, ids, close };
  } catch (err) {
    await close();
    throw err;
  }
}
