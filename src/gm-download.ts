// SW-side `GM_download` dispatcher.
//
// Wraps `chrome.downloads` so a userscript can save a file to the
// user's download directory. The page side keeps the caller's
// `onload` / `onerror` / `onprogress` / `ontimeout` callbacks (they
// aren't serializable) and we ship terminal + progress events back to
// the originating tab keyed by the page-generated `requestId`.
//
// Wire protocol:
//
//   Page → SW: `sm:gm-download-start` { type, scriptId, requestId, ... }
//   Page → SW: `sm:gm-download-abort` { type, requestId }
//   SW → page: `sm:gm-download-event` { type, requestId, event }
//
// Only `http(s)` URLs reach this module. `blob:` / `data:` downloads
// are handled entirely page-side by the runtime (an `<a download>`
// click), because a page-minted `blob:` URL is not resolvable from the
// extension's own context and a `data:` URL of arbitrary size has no
// business crossing the message boundary. See docs/GM-APIs.md.
//
// Why `chrome.downloads` and not "fetch in the SW, then hand the bytes
// to an offscreen document": `chrome.downloads.download` already does
// the fetching, the Content-Disposition handling, the resume/retry, the
// progress accounting, the Save-As dialog and the Safe-Browsing danger
// prompt. Buffering a multi-GB video through the SW to rebuild a Blob
// elsewhere would burn memory for a strictly worse result.

import { dropEntriesForOriginator } from './gm-originator-map.js';

// TM's documented `onerror` reason set (`{error, details}`). We emit a
// subset — see docs/supported-GM-APIs.md for which ones can actually
// appear and why the other two are reserved.
export type GmDownloadErrorCode =
  // Reserved: TM's global "downloads are switched off" setting. We have
  // no such setting, so we never emit it.
  | 'not_enabled'
  // Reserved: TM's per-extension file-extension whitelist. We rely on
  // Chrome's own dangerous-download prompts instead — see TODO.md.
  | 'not_whitelisted'
  // Scheme we refuse to hand to the download manager, an unsafe
  // `name`, or the `downloads` permission missing at runtime.
  | 'not_permitted'
  // No route to the SW at all (e.g. a script running in MAIN world).
  | 'not_supported'
  // The download manager refused the request or the transfer was
  // interrupted. `details` carries Chrome's interrupt reason.
  | 'not_succeeded'
  // The script called `abort()` on the returned control object.
  | 'download_canceled';

export interface GmDownloadStartPayload {
  scriptId: string;
  requestId: string;
  url: string;
  // '' means "let Chrome derive the name from the URL /
  // Content-Disposition" — TM requires a name, we don't.
  name: string;
  headers?: Record<string, string>;
  saveAs: boolean;
  // Milliseconds. 0 = no timeout.
  timeout: number;
  // Only poll `chrome.downloads.search` when the caller actually
  // supplied an `onprogress`; polling is pure overhead otherwise.
  wantsProgress: boolean;
}

// `details` on an error event. Shaped like the `chrome.downloads`
// `onChanged` delta's `error` field (`{previous, current}`) because
// that is what TM passes through — real scripts branch on
// `err.details.current === 'USER_CANCELED'` (e.g. Twitter Media
// Downloader's retry logic). `message` is our own addition for
// failures that never reached the download manager.
export interface GmDownloadErrorDetails {
  current?: string;
  previous?: string;
  message?: string;
}

export type GmDownloadEvent =
  | {
      kind: 'load';
      downloadId: number;
      filename: string;
      finalUrl: string;
      totalBytes: number;
    }
  | { kind: 'error'; error: GmDownloadErrorCode; details: GmDownloadErrorDetails }
  | { kind: 'timeout' }
  | { kind: 'progress'; loaded: number; total: number; lengthComputable: boolean };

export type GmDownloadEmit = (event: GmDownloadEvent) => void;

export interface GmDownloadStartResult {
  ok: boolean;
  downloadId?: number;
  // Set when ok === false. The caller ships these back to the page as
  // an `error` event and logs them against the script.
  error?: GmDownloadErrorCode;
  details?: GmDownloadErrorDetails;
}

interface DownloadEntry {
  originatorTabId: number;
  scriptId: string;
  requestId: string;
  url: string;
  // Assigned once chrome.downloads.download resolves.
  downloadId: number | null;
  // Set when abort() lands before the download id exists; the start
  // path cancels as soon as it has one. Same shape as gm-tab.ts's
  // `closeRequested`.
  cancelRequested: boolean;
  emit: GmDownloadEmit;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  progressTimer: ReturnType<typeof setInterval> | null;
}

const byRequestId = new Map<string, DownloadEntry>();
const byDownloadId = new Map<number, string>();

// How often we ask the download manager for byte counts when the
// caller supplied `onprogress`. `chrome.downloads.onChanged` does NOT
// carry `bytesReceived` (the delta only reports state/filename/error/
// totalBytes changes), so progress has to be polled. 500 ms is fine
// for a progress bar and cheap enough to leave running.
const PROGRESS_POLL_MS = 500;

// Schemes we hand to the download manager. The URL comes from a
// page-supplied message, so without this gate a script could ask the
// privileged SW to pull `file:///etc/passwd` (or a `chrome-extension://`
// resource) onto disk under a name of its choosing. `blob:` / `data:`
// never reach here — the page-side runtime handles those itself.
export function isAllowedDownloadUrl(url: string): boolean {
  try {
    const scheme = new URL(url).protocol;
    return scheme === 'http:' || scheme === 'https:';
  } catch {
    return false;
  }
}

// Validate the caller's `name` and turn it into the `filename` we pass
// to `chrome.downloads.download`.
//
// Chrome already rejects absolute paths and `..` traversal, but it
// does so by throwing a generic error; validating here lets the script
// see a clean `not_permitted` instead of a `not_succeeded` with an
// opaque message, and keeps the rule in one testable place.
//
// Relative subdirectories ARE allowed (`pics/cat.png`) — Chrome
// resolves them under the user's download directory and TM allows the
// same. Backslashes are normalized to `/` first so a Windows-style
// name doesn't slip a segment past the `..` check.
export function validateDownloadName(
  name: string,
): { ok: true; filename?: string } | { ok: false; reason: string } {
  const raw = (name ?? '').trim();
  if (raw === '') return { ok: true };
  const normalized = raw.replace(/\\/g, '/');
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    return { ok: false, reason: 'name contains control characters' };
  }
  if (normalized.startsWith('/')) {
    return { ok: false, reason: 'name must be a relative path' };
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    return { ok: false, reason: 'name must be a relative path' };
  }
  if (normalized.endsWith('/')) {
    return { ok: false, reason: 'name must not be a directory' };
  }
  const segments = normalized.split('/');
  if (segments.some((s) => s === '..')) {
    return { ok: false, reason: 'name must not traverse out of the download directory' };
  }
  if (segments.some((s) => s === '')) {
    return { ok: false, reason: 'name has an empty path segment' };
  }
  return { ok: true, filename: normalized };
}

// chrome.downloads.download in the Promise form the installed
// @types/chrome doesn't declare consistently across versions. Wrap the
// callback form and surface chrome.runtime.lastError as a rejection —
// same shape as gm-notification.ts's create wrapper.
function downloadViaChrome(options: chrome.downloads.DownloadOptions): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    try {
      chrome.downloads.download(options, (downloadId) => {
        const lastError = chrome.runtime.lastError;
        if (lastError || downloadId === undefined) {
          reject(new Error(lastError?.message ?? 'downloads.download failed'));
          return;
        }
        resolve(downloadId);
      });
    } catch (e) {
      reject(e);
    }
  });
}

// Kick off a download. Resolves with the assigned download id, or with
// an error code the caller ships back to the page.
export async function startGmDownload(
  payload: GmDownloadStartPayload,
  originatorTabId: number,
  emit: GmDownloadEmit,
): Promise<GmDownloadStartResult> {
  if (!chrome.downloads) {
    // The `downloads` permission is declared in the manifest, so this
    // only happens if a future build makes it optional and the user
    // hasn't granted it. TM uses `not_permitted` for exactly that case.
    return {
      ok: false,
      error: 'not_permitted',
      details: { message: 'chrome.downloads unavailable (missing downloads permission)' },
    };
  }
  if (!isAllowedDownloadUrl(payload.url)) {
    return {
      ok: false,
      error: 'not_permitted',
      details: { message: `refusing to download non-http(s) URL: ${payload.url}` },
    };
  }
  const nameCheck = validateDownloadName(payload.name);
  if (!nameCheck.ok) {
    return { ok: false, error: 'not_permitted', details: { message: nameCheck.reason } };
  }
  const entry: DownloadEntry = {
    originatorTabId,
    scriptId: payload.scriptId,
    requestId: payload.requestId,
    url: payload.url,
    downloadId: null,
    cancelRequested: false,
    emit,
    timeoutTimer: null,
    progressTimer: null,
  };
  // Register before awaiting so an abort() that arrives while
  // chrome.downloads.download is still resolving finds the entry.
  byRequestId.set(payload.requestId, entry);
  const headers = headerPairs(payload.headers);
  let downloadId: number;
  try {
    downloadId = await downloadViaChrome({
      url: payload.url,
      ...(nameCheck.filename ? { filename: nameCheck.filename } : {}),
      saveAs: payload.saveAs,
      // Chrome's default anyway, but pin it: a script that downloads
      // 50 images named by the page shouldn't fail on the first
      // collision.
      conflictAction: 'uniquify',
      ...(headers ? { headers } : {}),
    });
  } catch (err) {
    releaseEntry(payload.requestId);
    return {
      ok: false,
      error: 'not_succeeded',
      details: { message: err instanceof Error ? err.message : String(err) },
    };
  }
  // The page aborted while we were starting. Cancel the download we
  // just created and report nothing — the page already settled its
  // callbacks locally when it sent the abort.
  if (entry.cancelRequested) {
    byRequestId.delete(payload.requestId);
    await cancelViaChrome(downloadId);
    return { ok: false, error: 'download_canceled', details: {} };
  }
  entry.downloadId = downloadId;
  byDownloadId.set(downloadId, payload.requestId);
  if (payload.timeout > 0) {
    entry.timeoutTimer = setTimeout(() => {
      // Timed out. Cancel the transfer, tell the page, and drop the
      // entry — the `interrupted` delta that follows finds no entry
      // and is ignored, so the script sees exactly one terminal event.
      const live = byRequestId.get(payload.requestId);
      if (!live) return;
      releaseEntry(payload.requestId);
      void cancelViaChrome(downloadId);
      live.emit({ kind: 'timeout' });
    }, payload.timeout);
  }
  if (payload.wantsProgress) {
    entry.progressTimer = setInterval(() => {
      void pollProgress(payload.requestId);
    }, PROGRESS_POLL_MS);
  }
  return { ok: true, downloadId };
}

// Convert the caller's `{name: value}` header object into the
// `[{name, value}]` array chrome.downloads.download wants. Returns
// null when there's nothing to send.
function headerPairs(
  headers: Record<string, string> | undefined,
): { name: string; value: string }[] | null {
  if (!headers || typeof headers !== 'object') return null;
  const pairs: { name: string; value: string }[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (typeof name !== 'string' || name === '') continue;
    pairs.push({ name, value: String(value) });
  }
  return pairs.length > 0 ? pairs : null;
}

async function cancelViaChrome(downloadId: number): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      chrome.downloads.cancel(downloadId, () => {
        // Reading lastError keeps Chrome from logging "Unchecked
        // runtime.lastError" when the download already finished.
        void chrome.runtime.lastError;
        resolve();
      });
    });
  } catch { /* already gone */ }
}

// Look up byte counts for one in-flight download and emit a progress
// event. Fires only while the entry is live.
async function pollProgress(requestId: string): Promise<void> {
  const entry = byRequestId.get(requestId);
  if (!entry || entry.downloadId == null) return;
  const id = entry.downloadId;
  let items: chrome.downloads.DownloadItem[] = [];
  try {
    items = await new Promise<chrome.downloads.DownloadItem[]>((resolve) => {
      chrome.downloads.search({ id }, (found) => {
        void chrome.runtime.lastError;
        resolve(found ?? []);
      });
    });
  } catch { return; }
  // Re-check liveness: the search is async and the download may have
  // completed (and released the entry) while it was in flight.
  if (!byRequestId.has(requestId)) return;
  const item = items[0];
  if (!item) return;
  const total = typeof item.totalBytes === 'number' ? item.totalBytes : 0;
  entry.emit({
    kind: 'progress',
    loaded: typeof item.bytesReceived === 'number' ? item.bytesReceived : 0,
    total,
    lengthComputable: total > 0,
  });
}

// Handle one `chrome.downloads.onChanged` delta. Terminal states emit
// the matching page event and free the entry; everything else (paused,
// filename determined, danger prompt) is ignored.
export function handleDownloadChanged(delta: chrome.downloads.DownloadDelta): void {
  const requestId = byDownloadId.get(delta.id);
  if (!requestId) return;
  const entry = byRequestId.get(requestId);
  if (!entry) return;
  const state = delta.state?.current;
  if (state === 'complete') {
    releaseEntry(requestId);
    void emitComplete(entry, delta.id);
    return;
  }
  if (state === 'interrupted') {
    releaseEntry(requestId);
    entry.emit({
      kind: 'error',
      error: 'not_succeeded',
      details: {
        // `delta.error` is Chrome's InterruptReason (NETWORK_FAILED,
        // USER_CANCELED, FILE_ACCESS_DENIED, …). Passing it through as
        // `{current, previous}` is what TM does and what real scripts
        // branch on.
        ...(delta.error?.current !== undefined ? { current: delta.error.current } : {}),
        ...(delta.error?.previous != null ? { previous: delta.error.previous } : {}),
      },
    });
  }
}

// Fill in the completed download's filename / size before emitting
// `load`. The onChanged delta doesn't carry them reliably, so we ask
// the download manager. A failed lookup still emits `load` — the
// download DID complete and the script shouldn't be told otherwise.
async function emitComplete(entry: DownloadEntry, downloadId: number): Promise<void> {
  let item: chrome.downloads.DownloadItem | undefined;
  try {
    item = await new Promise<chrome.downloads.DownloadItem | undefined>((resolve) => {
      chrome.downloads.search({ id: downloadId }, (found) => {
        void chrome.runtime.lastError;
        resolve(found?.[0]);
      });
    });
  } catch { /* fall through with no item */ }
  entry.emit({
    kind: 'load',
    downloadId,
    filename: item?.filename ?? '',
    finalUrl: item?.finalUrl ?? item?.url ?? entry.url,
    totalBytes: typeof item?.totalBytes === 'number' ? item.totalBytes : 0,
  });
}

// Cancel an in-flight download on the script's behalf. The page has
// already settled its own callbacks (matching `GM_xmlhttpRequest`'s
// synchronous abort), so we only tear down SW-side state here.
export async function abortGmDownload(requestId: string): Promise<void> {
  const entry = byRequestId.get(requestId);
  if (!entry) return;
  if (entry.downloadId == null) {
    // The download hasn't been created yet; flag it so the start path
    // cancels as soon as it has an id.
    entry.cancelRequested = true;
    return;
  }
  const downloadId = entry.downloadId;
  releaseEntry(requestId);
  await cancelViaChrome(downloadId);
}

// Timers + secondary index teardown for one entry. Shared by the
// single-request release path and the shed-on-tab-close sweep so the
// two can't drift.
function cleanupEntry(entry: DownloadEntry): void {
  if (entry.timeoutTimer != null) clearTimeout(entry.timeoutTimer);
  if (entry.progressTimer != null) clearInterval(entry.progressTimer);
  if (entry.downloadId != null) byDownloadId.delete(entry.downloadId);
}

// Drop an entry and clear its timers. Terminal-event handlers call
// this BEFORE emitting so a callback that immediately starts another
// download can't collide with the entry it just settled.
function releaseEntry(requestId: string): void {
  const entry = byRequestId.get(requestId);
  if (!entry) return;
  cleanupEntry(entry);
  byRequestId.delete(requestId);
}

// Drop every request that belongs to a tab that just closed. Unlike
// GM_openInTab we do NOT cancel the transfers: a download the user
// started is theirs to keep even if the page that asked for it is
// gone. We just stop tracking it (nobody is left to route events to).
// Returns the dropped requestIds for logging.
export function dropOriginator(originatorTabId: number): string[] {
  return dropEntriesForOriginator(byRequestId, originatorTabId, cleanupEntry);
}
