// Unit tests for the SW-side GM_download dispatcher.
//
// The module talks to `chrome.downloads` (download / cancel / search /
// onChanged), so we stub the whole surface here and drive the state
// machine by hand: start a download, then feed it the onChanged deltas
// Chrome would send.

import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';

const downloads = [];   // every chrome.downloads.download() options object
const canceled = [];    // every chrome.downloads.cancel() id
let nextDownloadId = 1;
let downloadShouldFail = null;
// id -> {bytesReceived, totalBytes, filename, finalUrl}
const items = new Map();
// When set, the next download() call registers an item in this state
// *before* it hands the id back — the "it finished before we could
// register the id" race the immediate first poll exists for.
let preseedItem = null;

globalThis.chrome = {
  downloads: {
    download: (options, callback) => {
      if (downloadShouldFail) {
        const msg = downloadShouldFail;
        downloadShouldFail = null;
        setTimeout(() => {
          globalThis.chrome.runtime.lastError = { message: msg };
          callback(undefined);
          globalThis.chrome.runtime.lastError = undefined;
        }, 0);
        return;
      }
      const id = nextDownloadId++;
      downloads.push({ id, options });
      if (preseedItem) {
        items.set(id, { id, ...preseedItem });
        preseedItem = null;
      }
      setTimeout(() => callback(id), 0);
    },
    cancel: (id, callback) => { canceled.push(id); setTimeout(callback, 0); },
    search: (query, callback) => {
      const item = items.get(query.id);
      setTimeout(() => callback(item ? [item] : []), 0);
    },
    onChanged: { addListener: () => {} },
  },
  runtime: { lastError: undefined },
};

const {
  abortGmDownload,
  dropOriginator,
  handleDownloadChanged,
  isAllowedDownloadUrl,
  startGmDownload,
  validateDownloadName,
} = await import('../../dist/extension/gm-download.js');

function payloadOf(over = {}) {
  return {
    scriptId: 's1',
    requestId: 'r-1',
    url: 'https://example.test/file.png',
    name: 'file.png',
    saveAs: false,
    timeout: 0,
    wantsProgress: false,
    ...over,
  };
}

// Collect emitted events into an array so a test can assert on them.
function collector() {
  const events = [];
  return { events, emit: (e) => events.push(e) };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// Every started download keeps a poll interval alive until it settles
// (that interval is the SW keep-alive + terminal-event backstop), so a
// test that leaves one in flight would hold node's event loop open.
// Shed every tab this file uses at the end.
const TAB_IDS = [7, 50, 60];
after(() => { for (const tabId of TAB_IDS) dropOriginator(tabId); });

// ---------- URL gating ----------

test('isAllowedDownloadUrl accepts http(s) and rejects everything else', () => {
  assert.equal(isAllowedDownloadUrl('http://example.test/a.png'), true);
  assert.equal(isAllowedDownloadUrl('https://example.test/a.png'), true);
  assert.equal(isAllowedDownloadUrl('file:///etc/passwd'), false);
  assert.equal(isAllowedDownloadUrl('chrome-extension://abc/x.js'), false);
  assert.equal(isAllowedDownloadUrl('javascript:alert(1)'), false);
  // blob:/data: are handled page-side and must never reach the SW path.
  assert.equal(isAllowedDownloadUrl('blob:https://example.test/uuid'), false);
  assert.equal(isAllowedDownloadUrl('data:text/plain,hi'), false);
  assert.equal(isAllowedDownloadUrl('not a url'), false);
});

// ---------- filename validation ----------

test('validateDownloadName accepts plain names and relative subdirs', () => {
  assert.deepEqual(validateDownloadName('cat.png'), { ok: true, filename: 'cat.png' });
  assert.deepEqual(validateDownloadName('pics/cat.png'), { ok: true, filename: 'pics/cat.png' });
  // Backslashes normalize to forward slashes.
  assert.deepEqual(validateDownloadName('pics\\cat.png'), { ok: true, filename: 'pics/cat.png' });
});

test('validateDownloadName treats an empty name as "let Chrome decide"', () => {
  assert.deepEqual(validateDownloadName(''), { ok: true });
  assert.deepEqual(validateDownloadName('   '), { ok: true });
});

test('validateDownloadName rejects traversal, absolute paths, and junk', () => {
  for (const bad of [
    '../escape.png',
    'a/../../escape.png',
    '/etc/passwd',
    'C:/Windows/system32/evil.exe',
    'C:\\Windows\\evil.exe',
    'dir/',
    'a//b.png',
    'bad\u0000name.png',
  ]) {
    const res = validateDownloadName(bad);
    assert.equal(res.ok, false, `${JSON.stringify(bad)} should be rejected`);
    assert.ok(res.reason, 'rejection carries a reason');
  }
});

// ---------- start / terminal events ----------

test('startGmDownload calls chrome.downloads.download and reports the id', async () => {
  downloads.length = 0;
  const { emit } = collector();
  const res = await startGmDownload(payloadOf({ requestId: 'r-start' }), 7, emit);
  assert.equal(res.ok, true);
  assert.equal(typeof res.downloadId, 'number');
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].options.url, 'https://example.test/file.png');
  assert.equal(downloads[0].options.filename, 'file.png');
  assert.equal(downloads[0].options.conflictAction, 'uniquify');
  assert.equal(downloads[0].options.saveAs, false);
  // No headers supplied -> the key is omitted entirely.
  assert.equal('headers' in downloads[0].options, false);
});

test('headers object is converted to chrome downloads name/value pairs', async () => {
  downloads.length = 0;
  const { emit } = collector();
  // Only headers XHR is allowed to set survive Chrome's own filter, so
  // the fixture uses ones a script can actually send.
  await startGmDownload(payloadOf({
    requestId: 'r-headers',
    headers: { Authorization: 'Bearer x', 'X-Requested-With': 'SourceMonkey' },
  }), 7, emit);
  assert.deepEqual(downloads[0].options.headers, [
    { name: 'Authorization', value: 'Bearer x' },
    { name: 'X-Requested-With', value: 'SourceMonkey' },
  ]);
});

test('a non-http(s) URL is refused with not_permitted before any download starts', async () => {
  downloads.length = 0;
  const { emit } = collector();
  const res = await startGmDownload(payloadOf({
    requestId: 'r-file', url: 'file:///etc/passwd',
  }), 7, emit);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_permitted');
  assert.match(res.details.message, /non-http/);
  assert.equal(downloads.length, 0);
});

test('an unsafe name is refused with not_permitted', async () => {
  downloads.length = 0;
  const { emit } = collector();
  const res = await startGmDownload(payloadOf({
    requestId: 'r-bad-name', name: '../../escape.png',
  }), 7, emit);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_permitted');
  assert.equal(downloads.length, 0);
});

test('a chrome.downloads.download failure surfaces as not_succeeded', async () => {
  downloadShouldFail = 'Invalid filename';
  const { emit } = collector();
  const res = await startGmDownload(payloadOf({ requestId: 'r-fail' }), 7, emit);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_succeeded');
  assert.match(res.details.message, /Invalid filename/);
});

test('state complete emits load with the filename and size from the item', async () => {
  const { events, emit } = collector();
  const res = await startGmDownload(payloadOf({ requestId: 'r-complete' }), 7, emit);
  items.set(res.downloadId, {
    id: res.downloadId,
    filename: '/home/u/Downloads/file.png',
    finalUrl: 'https://cdn.example.test/file.png',
    totalBytes: 1234,
    bytesReceived: 1234,
  });
  handleDownloadChanged({ id: res.downloadId, state: { previous: 'in_progress', current: 'complete' } });
  await tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'load');
  assert.equal(events[0].filename, '/home/u/Downloads/file.png');
  assert.equal(events[0].finalUrl, 'https://cdn.example.test/file.png');
  assert.equal(events[0].totalBytes, 1234);
  // Terminal: a second delta for the same id is ignored.
  handleDownloadChanged({ id: res.downloadId, state: { previous: 'complete', current: 'interrupted' } });
  await tick();
  assert.equal(events.length, 1);
});

test('state interrupted emits not_succeeded with Chrome\'s interrupt reason', async () => {
  const { events, emit } = collector();
  const res = await startGmDownload(payloadOf({ requestId: 'r-interrupted' }), 7, emit);
  handleDownloadChanged({
    id: res.downloadId,
    state: { previous: 'in_progress', current: 'interrupted' },
    error: { previous: null, current: 'NETWORK_FAILED' },
  });
  await tick();
  assert.deepEqual(events, [{
    kind: 'error',
    error: 'not_succeeded',
    details: { current: 'NETWORK_FAILED' },
  }]);
});

test('a user cancel from Chrome\'s UI reports details.current USER_CANCELED', async () => {
  // Real scripts (e.g. Twitter Media Downloader) branch on this exact
  // field to stop retrying, so it has to survive verbatim.
  const { events, emit } = collector();
  const res = await startGmDownload(payloadOf({ requestId: 'r-user-cancel' }), 7, emit);
  handleDownloadChanged({
    id: res.downloadId,
    state: { previous: 'in_progress', current: 'interrupted' },
    error: { previous: null, current: 'USER_CANCELED' },
  });
  await tick();
  assert.equal(events[0].details.current, 'USER_CANCELED');
});

test('a download that finished before its id was registered still reports load', async () => {
  // The onChanged delta fires against the download id, which we only
  // learn when download() resolves. A tiny/cached file can settle in
  // that window, and the delta for an unregistered id is dropped — the
  // poll's first tick is what keeps the script from waiting forever.
  preseedItem = {
    state: 'complete',
    filename: '/home/u/Downloads/instant.png',
    finalUrl: 'https://example.test/instant.png',
    totalBytes: 9,
    bytesReceived: 9,
  };
  const { events, emit } = collector();
  await startGmDownload(payloadOf({ requestId: 'r-instant' }), 7, emit);
  await tick(20);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'load');
  assert.equal(events[0].filename, '/home/u/Downloads/instant.png');
});

test('a download that failed before its id was registered still reports the error', async () => {
  preseedItem = { state: 'interrupted', error: 'SERVER_FORBIDDEN' };
  const { events, emit } = collector();
  await startGmDownload(payloadOf({ requestId: 'r-instant-fail' }), 7, emit);
  await tick(20);
  assert.deepEqual(events, [{
    kind: 'error',
    error: 'not_succeeded',
    details: { current: 'SERVER_FORBIDDEN' },
  }]);
});

test('the poll does not double-report a download the delta already settled', async () => {
  preseedItem = {
    state: 'complete', filename: 'dupe.png', finalUrl: 'u', totalBytes: 1, bytesReceived: 1,
  };
  const { events, emit } = collector();
  const res = await startGmDownload(payloadOf({ requestId: 'r-dupe' }), 7, emit);
  // The real delta lands in the same turn as the poll's search.
  handleDownloadChanged({ id: res.downloadId, state: { previous: 'in_progress', current: 'complete' } });
  await tick(20);
  assert.equal(events.length, 1);
});

test('non-terminal deltas (paused, filename) emit nothing', async () => {
  const { events, emit } = collector();
  const res = await startGmDownload(payloadOf({ requestId: 'r-noop' }), 7, emit);
  handleDownloadChanged({ id: res.downloadId, paused: { previous: false, current: true } });
  handleDownloadChanged({ id: res.downloadId, filename: { previous: '', current: '/tmp/x' } });
  await tick();
  assert.equal(events.length, 0);
});

test('deltas for an unknown download id are ignored', async () => {
  handleDownloadChanged({ id: 999999, state: { previous: 'in_progress', current: 'complete' } });
  await tick();
  // No throw is the assertion.
  assert.ok(true);
});

// ---------- timeout ----------

test('timeout cancels the download and emits exactly one timeout event', async () => {
  canceled.length = 0;
  const { events, emit } = collector();
  const res = await startGmDownload(payloadOf({ requestId: 'r-timeout', timeout: 10 }), 7, emit);
  await tick(40);
  assert.deepEqual(events, [{ kind: 'timeout' }]);
  assert.deepEqual(canceled, [res.downloadId]);
  // The interrupted delta Chrome sends after our cancel must not
  // produce a second terminal event.
  handleDownloadChanged({
    id: res.downloadId,
    state: { previous: 'in_progress', current: 'interrupted' },
    error: { previous: null, current: 'USER_CANCELED' },
  });
  await tick();
  assert.equal(events.length, 1);
});

test('a completed download clears its timeout timer', async () => {
  const { events, emit } = collector();
  const res = await startGmDownload(payloadOf({ requestId: 'r-timeout-clear', timeout: 15 }), 7, emit);
  handleDownloadChanged({ id: res.downloadId, state: { previous: 'in_progress', current: 'complete' } });
  await tick(40);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'load');
});

// ---------- abort ----------

test('abortGmDownload cancels the transfer and drops the entry', async () => {
  canceled.length = 0;
  const { events, emit } = collector();
  const res = await startGmDownload(payloadOf({ requestId: 'r-abort' }), 7, emit);
  await abortGmDownload('r-abort');
  assert.deepEqual(canceled, [res.downloadId]);
  // The page settles its own callbacks on abort, so the SW emits
  // nothing — and the interrupt delta that follows finds no entry.
  handleDownloadChanged({
    id: res.downloadId,
    state: { previous: 'in_progress', current: 'interrupted' },
    error: { previous: null, current: 'USER_CANCELED' },
  });
  await tick();
  assert.equal(events.length, 0);
});

test('abort before the download id exists still cancels once it arrives', async () => {
  canceled.length = 0;
  const { events, emit } = collector();
  const started = startGmDownload(payloadOf({ requestId: 'r-race' }), 7, emit);
  // Abort while chrome.downloads.download is still in flight.
  await abortGmDownload('r-race');
  const res = await started;
  assert.equal(res.ok, false);
  assert.equal(res.error, 'download_canceled');
  assert.equal(canceled.length, 1);
  assert.equal(events.length, 0);
});

test('abortGmDownload on an unknown request is a no-op', async () => {
  await abortGmDownload('r-nope');
  assert.ok(true);
});

test('a tab closing mid-start does not re-register the request or its timers', async () => {
  // dropOriginator can land while chrome.downloads.download is still in
  // flight. Re-registering the entry afterwards would leave a poll
  // interval nobody can ever clear (and a stale byDownloadId row).
  const { events, emit } = collector();
  const started = startGmDownload(payloadOf({
    requestId: 'r-tab-closed-mid-start', wantsProgress: true,
  }), 50, emit);
  const dropped = dropOriginator(50);
  assert.deepEqual(dropped, ['r-tab-closed-mid-start']);
  const res = await started;
  // The transfer itself keeps running (we don't cancel downloads a tab
  // close orphans) — we just stop tracking it, so nothing is emitted...
  assert.equal(res.ok, true);
  await tick(700);
  assert.equal(events.length, 0);
  // ...and the delta for it finds no entry.
  handleDownloadChanged({
    id: res.downloadId, state: { previous: 'in_progress', current: 'complete' },
  });
  await tick();
  assert.equal(events.length, 0);
  // A second sweep finds nothing left over.
  assert.deepEqual(dropOriginator(50), []);
});

// ---------- progress ----------

test('progress polling emits loaded/total while the download runs', async () => {
  const { events, emit } = collector();
  const res = await startGmDownload(payloadOf({
    requestId: 'r-progress', wantsProgress: true,
  }), 7, emit);
  items.set(res.downloadId, {
    id: res.downloadId, bytesReceived: 512, totalBytes: 2048, filename: 'f', finalUrl: 'u',
  });
  await tick(700);
  const progress = events.filter((e) => e.kind === 'progress');
  assert.ok(progress.length >= 1, 'at least one progress event');
  assert.equal(progress[0].loaded, 512);
  assert.equal(progress[0].total, 2048);
  assert.equal(progress[0].lengthComputable, true);
  // Completing stops the polling.
  handleDownloadChanged({ id: res.downloadId, state: { previous: 'in_progress', current: 'complete' } });
  await tick();
  const afterComplete = events.length;
  await tick(700);
  assert.equal(events.length, afterComplete, 'no progress events after the terminal event');
});

test('no progress EVENTS when the caller supplied no onprogress', async () => {
  const { events, emit } = collector();
  const res = await startGmDownload(payloadOf({ requestId: 'r-no-progress' }), 7, emit);
  items.set(res.downloadId, {
    id: res.downloadId, bytesReceived: 10, totalBytes: 20, filename: 'f', finalUrl: 'u',
  });
  await tick(700);
  assert.equal(events.filter((e) => e.kind === 'progress').length, 0);
});

// ---------- originator cleanup ----------

test('dropOriginator sheds every request from a closing tab (and leaves others)', async () => {
  const a = collector();
  const b = collector();
  const resA = await startGmDownload(payloadOf({ requestId: 'r-tab-a1' }), 50, a.emit);
  await startGmDownload(payloadOf({ requestId: 'r-tab-a2' }), 50, a.emit);
  const resB = await startGmDownload(payloadOf({ requestId: 'r-tab-b1' }), 60, b.emit);
  const dropped = dropOriginator(50);
  assert.deepEqual(dropped.sort(), ['r-tab-a1', 'r-tab-a2']);
  // The dropped transfers keep running in Chrome — we just stopped
  // listening, so their deltas emit nothing.
  handleDownloadChanged({ id: resA.downloadId, state: { previous: 'in_progress', current: 'complete' } });
  await tick();
  assert.equal(a.events.length, 0);
  // The surviving tab's download still reports.
  handleDownloadChanged({ id: resB.downloadId, state: { previous: 'in_progress', current: 'complete' } });
  await tick();
  assert.equal(b.events.length, 1);
});

test('startGmDownload reports not_permitted when chrome.downloads is missing', async () => {
  const real = globalThis.chrome.downloads;
  globalThis.chrome.downloads = undefined;
  try {
    const { emit } = collector();
    const res = await startGmDownload(payloadOf({ requestId: 'r-no-perm' }), 7, emit);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'not_permitted');
    assert.match(res.details.message, /downloads permission/);
  } finally {
    globalThis.chrome.downloads = real;
  }
});
