// Worker side of worker-client.ts: the operations extension pages ask
// the service worker to run, since only it writes storage
// (docs/worker-writes.md).
//
// Each entry is the function a page would have called itself, or an
// adapter where that function's own arguments or result can't cross as
// JSON (a timer, a Map) or carry more than the page uses (script
// bodies).

import {
  backfillCollectionDisplayNames, createCollection, describeError, ensureCollectionKeysMigrated, markFirstRunComplete,
  moveCollection, moveScript, reconcileScriptMembership, removeCollection, removeScript, setCollectionOptions,
  setScriptsEnabled,
} from './script-store.js';
import {
  enableWithin, setAllScriptsEnabled, setCollectionEnabledExclusive, setScriptEnabledExclusive,
} from './script-enablement.js';
import { turnOffOtherCopies } from './script-identity.js';
import { forgetDeniedHost, revokeConnectHost } from './connect-grants.js';
import { clearScriptLog } from './script-log.js';
import { DEBUG_LOGGING_KEY } from '../debug-log.js';
import { GITHUB_AUTH_TOKEN_KEY } from '../github-auth.js';
import { LOCAL_ROOTS_KEY } from '../local-file-overrides.js';
import { INSTALL_CAPTURE_KEY } from './install-capture.js';
import { DOWNLOADS_COPIES_KEY } from './local-copy.js';
import { startPhaseTimer } from '../phase-timing.js';
import { WORKER_OP_PORT, type WorkerOpReply, type WorkerOpRequest } from './worker-client.js';

// The settings a page may change: Options, and the local copy's
// Downloads folder. Each a whole value, not a read-modify-write, so
// writing it is all the worker does.
const SETTING_KEYS: readonly string[] = [
  INSTALL_CAPTURE_KEY, DEBUG_LOGGING_KEY, LOCAL_ROOTS_KEY, GITHUB_AUTH_TOKEN_KEY, DOWNLOADS_COPIES_KEY,
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
  moveScript,
  createCollection,
  setCollectionOptions,
  revokeConnectHost,
  forgetDeniedHost,
  clearScriptLog,
  markFirstRunComplete,
  // `null` removes the setting.
  async writeSetting(key: string, value: unknown): Promise<void> {
    if (!SETTING_KEYS.includes(key)) throw new Error(`Internal error: ${key} is not a setting a page may change`);
    if (value === null) await chrome.storage.local.remove(key);
    else await chrome.storage.local.set({ [key]: value });
  },

  // ---------- Repairs the collections page asks for ----------
  backfillCollectionDisplayNames,
  // From the worker's own read of the rows, not the page's.
  async reconcileScriptMembership(): Promise<number> {
    return await reconcileScriptMembership();
  },
  // A page that finds rows in the old spelling waits for this before
  // reading.
  ensureCollectionKeysMigrated,
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
