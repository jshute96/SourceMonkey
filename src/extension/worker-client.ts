// Page side of the worker's operations: every write an extension page
// makes goes through here, to run in the service worker
// (docs/worker-writes.md). Each export has the name and arguments of the
// worker function it runs, so a call site only changes its import.
//
// One port per call:
//   - The page sends the operation's name and arguments, then a
//     heartbeat while it waits. A port's messages keep the worker alive,
//     which a long refresh needs (Chrome stops an idle worker after
//     30 s).
//   - The worker answers once, with the result or the error's message,
//     which is thrown here as a new Error with that message.
//   - Closing the page doesn't stop the work: the worker carries on and
//     drops the answer.
//
// Arguments and results cross as JSON: no Maps, Sets or functions, and
// an `undefined` argument or array entry arrives as `null`.
// worker-ops.ts adapts any function whose own signature has them.

import type { WorkerOpName, WorkerOps } from './worker-ops.js';
import { isPageContext } from '../run-context.js';

export const WORKER_OP_PORT = 'sm:op';

// Under Chrome's 30 s idle limit, with room to spare.
export const WORKER_OP_HEARTBEAT_MS = 20_000;

export type WorkerOpRequest = { op: string; args: unknown[] } | { beat: true };
export type WorkerOpReply = { ok: true; result: unknown } | { ok: false; error: string };

// The worker went away mid-call: it crashed, or Chrome stopped it.
// It may have saved the change first.
export const WORKER_STOPPED =
  'Internal error: SourceMonkey\'s background worker stopped before answering. The change may not have been saved.';

type Args<K extends WorkerOpName> = Parameters<WorkerOps[K]>;
type Result<K extends WorkerOpName> = Awaited<ReturnType<WorkerOps[K]>>;

export function callWorker<K extends WorkerOpName>(op: K, ...args: Args<K>): Promise<Result<K>> {
  // A port the worker opens reaches no listener of its own: code running
  // in the worker calls the store directly.
  if (!isPageContext()) return Promise.reject(new Error(`Internal error: The background worker called its own ${op} through a port`));
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: WORKER_OP_PORT });
    let settled = false;
    const beat = setInterval(() => {
      try { port.postMessage({ beat: true } satisfies WorkerOpRequest); } catch { /* port gone */ }
    }, WORKER_OP_HEARTBEAT_MS);
    const finish = (): void => {
      settled = true;
      clearInterval(beat);
      try { port.disconnect(); } catch { /* already gone */ }
    };
    port.onMessage.addListener((message: WorkerOpReply) => {
      if (settled) return;
      finish();
      if (message.ok) resolve(message.result as Result<K>);
      else reject(new Error(message.error));
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      finish();
      reject(new Error(WORKER_STOPPED));
    });
    port.postMessage({ op, args } satisfies WorkerOpRequest);
  });
}

// Trailing `undefined` arguments are left off, so the worker's default
// parameters apply: JSON would send them as `null`.
function op<K extends WorkerOpName>(name: K): (...args: Args<K>) => Promise<Result<K>> {
  return (...args) => {
    let n = args.length;
    while (n > 0 && args[n - 1] === undefined) n--;
    return callWorker(name, ...(args.slice(0, n) as Args<K>));
  };
}

// ---------- Enable toggles ----------
export const setScriptEnabledExclusive = op('setScriptEnabledExclusive');
export const setCollectionEnabledExclusive = op('setCollectionEnabledExclusive');
export const setAllScriptsEnabled = op('setAllScriptsEnabled');
export const enableWithin = op('enableWithin');
export const setScriptsEnabled = op('setScriptsEnabled');
export const turnOffOtherCopies = op('turnOffOtherCopies');

// ---------- Small writes ----------
export const removeScript = op('removeScript');
export const removeCollection = op('removeCollection');
export const moveCollection = op('moveCollection');
export const moveScript = op('moveScript');
export const createCollection = op('createCollection');
export const setCollectionOptions = op('setCollectionOptions');
export const revokeConnectHost = op('revokeConnectHost');
export const forgetDeniedHost = op('forgetDeniedHost');
export const clearScriptLog = op('clearScriptLog');
export const markFirstRunComplete = op('markFirstRunComplete');
export const writeSetting = op('writeSetting');
export const backfillCollectionDisplayNames = op('backfillCollectionDisplayNames');
export const reconcileScriptMembership = op('reconcileScriptMembership');
export const syncAfterUserScriptsAllowed = op('syncAfterUserScriptsAllowed');

// ---------- Refresh, add, install ----------
export const updateScript = op('updateScript');
export const updateCollection = op('updateCollection');
export const updateAllCollections = op('updateAllCollections');
export const addCollection = op('addCollection');
export const importCollection = op('importCollection');
export const installScript = op('installScript');

// ---------- Reads ----------
export const readScriptValues = op('readScriptValues');

// ---------- Site icons (the debug icons page) ----------
export const refreshCachedIcon = op('refreshCachedIcon');
export const deleteCachedIcon = op('deleteCachedIcon');
export const deleteAllCachedIcons = op('deleteAllCachedIcons');
