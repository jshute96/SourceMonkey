// Worker side of worker-client.ts: the operations extension pages ask
// the service worker to run, since only it writes storage
// (docs/worker-writes.md).
//
// Each entry is the function a page would have called itself, or an
// adapter where that function's own arguments or result can't cross as
// JSON (a timer, a Map) or carry more than the page uses (script
// bodies).

import {
  addCollection, backfillCollectionDisplayNames, createCollection, describeError, importScripts, installScript, migrateCollectionKeysForPage, withoutBodies,
  type AddCollectionResult, type InstallTarget, type ScriptMeta, type StoredScript,
  moveCollection, moveScript, reconcileScriptMembership, removeCollection, removeScript, setCollectionOptions,
  setScriptsEnabled,
} from './script-store.js';
import {
  enableWithin, setAllScriptsEnabled, setCollectionEnabledExclusive, setScriptEnabledExclusive,
} from './script-enablement.js';
import { turnOffOtherCopies } from './script-identity.js';
import { syncRegistrations } from './injector.js';
import {
  probeInstalledScript, updateAllCollections, updateCollection, updateScript, type UpdateMode,
} from './script-updater.js';
import type { ProbePolicy } from '../version-probe.js';
import { forgetDeniedHost, revokeConnectHost } from './connect-grants.js';
import { clearScriptLog } from './script-log.js';
import { peekValues } from './value-store.js';
import { DEBUG_LOGGING_KEY } from '../debug-log.js';
import { GITHUB_AUTH_TOKEN_KEY, setGithubAuthToken } from '../github-auth.js';
import { LOCAL_ROOTS_KEY, readRootsSetting, setConfiguredLocalRoots } from '../local-file-overrides.js';
import { INSTALL_CAPTURE_KEY } from './install-capture.js';
import { DOWNLOADS_COPIES_KEY, registerLocalCopy } from './local-copy.js';
import { SHOW_SUGGESTIONS_KEY } from '../suggestions.js';
import { deleteAllCachedIcons, deleteCachedIcon, ensureCachedIcon, refreshCachedIcon } from './site-icon.js';
import { startPhaseTimer } from '../phase-timing.js';
import { WORKER_OP_PORT, type WorkerOpReply, type WorkerOpRequest } from './worker-client.js';

// The settings a page may change: Options, the local copy's Downloads
// folder, and whether the collections page shows its suggestion box.
// Each a whole value, not a read-modify-write, so writing it is all
// the worker does.
const SETTING_KEYS: readonly string[] = [
  INSTALL_CAPTURE_KEY, DEBUG_LOGGING_KEY, LOCAL_ROOTS_KEY, GITHUB_AUTH_TOKEN_KEY, DOWNLOADS_COPIES_KEY,
  SHOW_SUGGESTIONS_KEY,
];

const WORKER_OPS = {
  // ---------- Enable toggles ----------
  setScriptEnabledExclusive,
  setCollectionEnabledExclusive,
  setAllScriptsEnabled,
  // The viewer's versions table: `scope` is the copies it shows.
  async enableWithin(id: string, scope: string[]): Promise<void> {
    const timer = startPhaseTimer('enable script');
    await enableWithin(id, scope, timer);
    timer.done();
  },
  async setScriptsEnabled(updates: { id: string; enabled: boolean }[]): Promise<void> {
    await setScriptsEnabled(updates);
  },
  async turnOffOtherCopies(scriptId: string): Promise<void> {
    await turnOffOtherCopies(scriptId);
  },

  // ---------- Small writes ----------
  removeScript,
  removeCollection,
  moveCollection,
  // The moved row, without the bodies a refresh of it would carry.
  async moveScript(scriptId: string, target: InstallTarget): Promise<ScriptMeta | null> {
    const moved = await moveScript(scriptId, target);
    return moved && 'bodyText' in moved ? withoutBodies(moved as StoredScript) : moved;
  },
  createCollection,
  setCollectionOptions,
  revokeConnectHost,
  forgetDeniedHost,
  clearScriptLog,
  // `null` removes the setting.
  async writeSetting(key: string, value: unknown): Promise<void> {
    if (!SETTING_KEYS.includes(key)) throw new Error(`Internal error: ${key} is not a setting a page may change`);
    if (value === null) await chrome.storage.local.remove(key);
    else await chrome.storage.local.set({ [key]: value });
    // Settings the worker keeps in memory take the new value now, not
    // when the change event arrives: a page saving the roots refreshes
    // straight after.
    if (key === LOCAL_ROOTS_KEY) setConfiguredLocalRoots(readRootsSetting(value));
    if (key === GITHUB_AUTH_TOKEN_KEY) setGithubAuthToken(typeof value === 'string' ? value : '');
  },

  // ---------- Repairs the collections page asks for ----------
  backfillCollectionDisplayNames,
  // From the worker's own read of the rows, not the page's.
  async reconcileScriptMembership(): Promise<number> {
    return await reconcileScriptMembership();
  },
  // A page that finds rows in the old spelling waits for this before
  // reading.
  migrateCollectionKeys: migrateCollectionKeysForPage,
  // The collections page saw "Allow User Scripts" turned on. Chrome
  // tells the worker nothing when that happens, and the syncs that ran
  // while it was off registered nothing, so this places the whole set.
  async syncAfterUserScriptsAllowed(): Promise<void> {
    await syncRegistrations();
  },

  // ---------- Refresh, add, install ----------
  // The page reads storage for what changed, so these answer with no
  // rows: a refresh's carry every body it loaded.
  //
  // Whether the script is still there afterwards: a refresh drops a
  // row whose file is gone.
  async updateScript(scriptId: string, mode: UpdateMode, probe?: ProbePolicy): Promise<boolean> {
    return (await updateScript(scriptId, mode, probe)) !== null;
  },
  async updateCollection(collectionId: string, mode: UpdateMode, probe?: ProbePolicy): Promise<void> {
    await updateCollection(collectionId, mode, probe);
  },
  async updateAllCollections(mode: UpdateMode, probe?: ProbePolicy): Promise<void> {
    await updateAllCollections(mode, probe);
  },
  // A single script installed (or a `.user.js` added) is checked for a
  // newer version at once, without the page waiting for it.
  async addCollection(rawPath: string): Promise<AddCollectionResult> {
    const result = await addCollection(rawPath);
    probeInstalledScript(result);
    return result;
  },
  async installScript(rawLocation: string, target: InstallTarget): Promise<AddCollectionResult> {
    const result = await installScript(rawLocation, target);
    probeInstalledScript(result);
    return result;
  },
  // A backup file the page read and planned (docs/import.md).
  importScripts,

  // ---------- Reads ----------
  // GM values come from the worker's value store, which can hold writes
  // not yet saved to storage, so a page reads them here rather than
  // from storage (the backup export).
  async readScriptValues(scriptIds: string[]): Promise<Record<string, Record<string, unknown>>> {
    const read = await Promise.all(scriptIds.map((id) => peekValues(id)));
    return Object.fromEntries(scriptIds.map((id, i) => [id, read[i]]));
  },

  // ---------- Local copy and site icons ----------
  // After the page has written the files: it alone can download.
  registerLocalCopy,
  // One icon row's data URL: cached if still usable, else fetched and
  // cached. `refreshCachedIcon` always fetches (the debug icons page).
  ensureCachedIcon,
  refreshCachedIcon,
  deleteCachedIcon,
  deleteAllCachedIcons,
};

export type WorkerOps = typeof WORKER_OPS;
export type WorkerOpName = keyof WorkerOps;

function isWorkerOp(name: string): name is WorkerOpName {
  return Object.hasOwn(WORKER_OPS, name);
}

async function run(request: { op: string; args: unknown[] }): Promise<unknown> {
  if (!isWorkerOp(request.op) || !Array.isArray(request.args)) {
    throw new Error(`Internal error: There is no worker operation named ${request.op}`);
  }
  const fn = WORKER_OPS[request.op] as (...args: unknown[]) => Promise<unknown>;
  return await fn(...request.args);
}

// Answer pages' calls. `fromPage` is background.ts's sender check: only
// our own pages may ask, as for every page relay.
export function installWorkerOps(fromPage: (sender: chrome.runtime.MessageSender) => boolean): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== WORKER_OP_PORT || !port.sender || !fromPage(port.sender)) return;
    let started = false;
    port.onMessage.addListener((message: WorkerOpRequest) => {
      // Later messages are the page's heartbeat: receiving them is what
      // keeps this worker alive.
      if (started || 'beat' in message) return;
      started = true;
      const reply = (answer: WorkerOpReply): void => {
        try { port.postMessage(answer); } catch { /* the page closed */ }
      };
      run(message).then(
        (result) => reply({ ok: true, result: result ?? null }),
        (err: unknown) => reply({ ok: false, error: describeError(err) }),
      );
    });
  });
}
