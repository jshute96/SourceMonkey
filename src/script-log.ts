// Per-script event log.
//
// Each StoredScript gets its own log keyed by script ID and stored in
// chrome.storage.session (so logs survive SW restarts but are cleared
// when Chrome shuts down — same lifetime as the per-tab badge state).
//
// We chose a single per-script array (rather than one storage key per
// entry) because chrome.storage.session is a flat key-value store and
// scanning N keys to read N log lines would dominate the cost of
// rendering the log pane. The array IS a read/modify/write append, so
// concurrent appendScriptLog calls for the same id are serialized
// through an in-memory promise chain to keep them from clobbering each
// other. Cross-id appends still run concurrently.
//
// Entries are append-only with a fixed cap; once the count passes
// LOG_CAP the oldest entries are dropped. The cap is generous enough
// to cover a normal day of refreshes + a few crashy injections but
// small enough that a runaway error loop can't fill storage.
//
// Alongside the log we maintain a sibling `loglevel:<scriptId>` row
// recording the highest level any SCRIPT-ORIGINATED entry has carried
// so far — a runtime error, a refused `GM_download`, a parse-time
// diagnostic.
// Bumped only when an append carries a strictly higher level; cleared
// on `clearScriptLog`. Entries that record a load-state transition
// (`state` set — see `LogEntry.state`) never touch it: their badge
// comes from the row and clears with it. It lives in session storage
// (not on the StoredScript row) because:
//   - Lifetime matches the log itself — Chrome shutdown drops both
//     together, so a WARNING/ERROR badge can't outlive its entries.
//   - One bulk `get(null)` yields every script's level in O(scripts)
//     rather than O(scripts × entries) — the collections page needs this
//     to render the Status column cheaply.

import { validLocation, type DiagnosticLocation } from './diagnostic-location.js';
import { isPageContext } from './run-context.js';
import { isLoadState, type LoadState } from './script-display.js';

export type LogLevel = 'info' | 'warning' | 'error';

// Ordinal compare for LogLevel: error > warning > info. Used to decide
// whether an append should bump the stored max.
const LEVEL_RANK: Record<LogLevel, number> = { info: 1, warning: 2, error: 3 };
function isHigher(candidate: LogLevel, prior: LogLevel | undefined): boolean {
  if (prior === undefined) return true;
  return LEVEL_RANK[candidate] > LEVEL_RANK[prior];
}

export interface LogEntry {
  // Epoch ms when the event was recorded.
  timestamp: number;
  level: LogLevel;
  // Origin label: e.g. 'manual-refresh', 'script-wrapper'. Read by
  // users in the Log tab's Source column, so it names the thing that
  // produced the entry rather than the internal that emitted it. See
  // [docs/script-log.md] for the full set. Pairs with the optional
  // tabId so the log pane can render either "tab 17 — script-wrapper"
  // or just "manual-refresh" depending on what the entry carries.
  source: string;
  // Chrome tab ID, when the event originated from injected code in a
  // specific tab. Absent for SW-side and other background events.
  tabId?: number;
  // Human-readable message. Multiline is fine; the log pane preserves
  // newlines.
  message: string;
  // The display state this event moved the script into, when the entry
  // records a load-state / registration / probe transition rather than
  // something the script itself did: `refresh-failed`, `invalid`,
  // `missing`, `rejected`, `outdated`, or `ok` for the matching
  // recovery. The Log tab shows it in place of the level, in the same
  // words as the Status badge, so "the event that put the badge there"
  // and the badge read alike.
  //
  // Two separate things, deliberately: the row (`status`,
  // `refreshError`, the rejection map, the probes) is the durable
  // truth of what state the script is in; this is the session-scoped
  // record of when it got there. An entry with `state` never bumps the
  // `loglevel:` sentinel — the badge it explains already comes from the
  // row and clears with it, so the sentinel is left to script-originated
  // warnings and errors.
  state?: LoadState;
  // Where in the script's own files the entry is about, when it was
  // derived from their content (a bad header line, a syntax error).
  // The log pane renders it as a link into the matching code tab.
  //
  // Distinct from the `sourcemonkey://…:L:C` refs that appear INSIDE a
  // runtime stack trace: those are text the script itself produced and
  // are linkified by scanning the message, whereas this is a location
  // SourceMonkey derived and knows structurally.
  location?: DiagnosticLocation;
}

// Hard cap on retained entries per script. Older entries are dropped
// on append. 500 × ~200 bytes ≈ 100 KB per script — well inside the
// chrome.storage.session quota (10 MB total).
export const LOG_CAP = 500;

const logKey = (scriptId: string) => `log:${scriptId}`;
const levelKey = (scriptId: string) => `loglevel:${scriptId}`;
// Prefix used by the bulk-read path. Kept here so callers don't have
// to hardcode it.
export const LOG_LEVEL_KEY_PREFIX = 'loglevel:';

// Per-script promise chain. chrome.storage.session has no atomic
// append, so two concurrent appendScriptLog calls for the same id
// would both read the same prior array and the second .set would
// overwrite the first append. Chaining serializes them; the map entry
// is dropped once its chain drains so long-running sessions don't
// accumulate dead Promises.
//
// The map is module state, so the chain only orders writes made in THIS
// context — and both contexts write: the worker logs every injection
// and refresh event, while a page logs through the same `script-store`
// code it shares (an install's first-load line) and clears the log from
// the viewer's button. Two chains would interleave on one key and lose
// entries, or resurrect ones a clear had just removed. So every MUTATION
// from a page hops to the worker (`writeViaWorker`) and the worker's
// chain is the only one that touches the key. Reads don't hop: they
// aren't read-modify-write.
//
// What that guarantees is "the worker's chain orders everything that
// reaches it", NOT "a page's appends are ordered": two writes from one
// page are two messages, ordered by the IPC rather than by a chain, and
// a write that fell back to the local chain (see `writeViaWorker`) isn't
// ordered against the relayed ones at all.
const queues = new Map<string, Promise<unknown>>();
function enqueue<T>(scriptId: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(scriptId) ?? Promise.resolve();
  // .then(task, task) so a thrown task doesn't poison the chain — the
  // next queued task still runs against the post-throw state.
  const next = prev.then(task as () => Promise<unknown>, task as () => Promise<unknown>) as Promise<T>;
  queues.set(scriptId, next);
  void next.finally(() => {
    if (queues.get(scriptId) === next) queues.delete(scriptId);
  });
  return next;
}

export interface AppendLogInput {
  level: LogLevel;
  source: string;
  message: string;
  tabId?: number;
  // See `LogEntry.location`. Validated on the way in: entries are
  // persisted and later turned into click targets, so a malformed line
  // number is dropped here rather than discovered at render time.
  location?: DiagnosticLocation;
  // See `LogEntry.state`.
  state?: LoadState;
  // Optional override for the timestamp (tests use this to keep output
  // deterministic). Production callers omit it and get Date.now().
  timestamp?: number;
}

// Append an entry. Every caller that reaches here observed something,
// and the Log tab is a transcript of observations, so the entry is
// always written. A caller that fires on its own schedule rather than
// on an observation — the injector's per-sync registration pass — is
// responsible for deciding whether anything happened before it calls.
export async function appendScriptLog(
  scriptId: string,
  input: AppendLogInput,
): Promise<void> {
  if (isPageContext()) return writeViaWorker({ op: 'append', scriptId, input });
  return enqueue(scriptId, () => writeEntry(scriptId, input));
}

// ---------- Page → worker relay ----------

export const SCRIPT_LOG_WRITE_MESSAGE = 'sm:script-log-write';

export type ScriptLogWriteRequest =
  | { op: 'append'; scriptId: string; input: AppendLogInput }
  | { op: 'clear'; scriptId: string };

// Worker side. Runs the write on the worker's own per-script chain,
// which is the point of the hop.
export async function handleScriptLogWrite(req: ScriptLogWriteRequest): Promise<void> {
  if (req.op === 'append') return enqueue(req.scriptId, () => writeEntry(req.scriptId, req.input));
  return enqueue(req.scriptId, () => removeEntries(req.scriptId));
}

// Page side. Falls back to writing locally unless the worker
// ACKNOWLEDGED the write — a log line the user can see beats a lost one,
// and the interleaving it risks is what happened on every write before
// this relay existed.
//
// The ack has to be READ, not just awaited: a message nothing handled,
// and a handler that threw, both RESOLVE `sendMessage` (with
// `undefined`); only an unreachable worker rejects it. So `true` — sent
// by the listener once the write has landed — is the one answer that
// means "don't write this yourself".
//
// The fallback can duplicate an entry: a port that closes after the
// worker acted (the page navigating away mid-write) is indistinguishable
// from one that was never there, so the write may already be persisted.
// A doubled log line is the better failure of the two on offer.
async function writeViaWorker(req: ScriptLogWriteRequest): Promise<void> {
  try {
    const ack = await chrome.runtime.sendMessage({ type: SCRIPT_LOG_WRITE_MESSAGE, ...req });
    if (ack === true) return;
  } catch { /* no receiving end */ }
  if (req.op === 'append') {
    await enqueue(req.scriptId, () => writeEntry(req.scriptId, req.input));
    return;
  }
  await enqueue(req.scriptId, () => removeEntries(req.scriptId));
}

// Shared read-modify-write body. Always called from inside `enqueue`.
async function writeEntry(
  scriptId: string,
  input: AppendLogInput,
): Promise<void> {
  const lk = logKey(scriptId);
  const mk = levelKey(scriptId);
  const got = await chrome.storage.session.get([lk, mk]);
  const prior: LogEntry[] = Array.isArray(got[lk]) ? (got[lk] as LogEntry[]) : [];
  const priorLevel = got[mk] as LogLevel | undefined;
  const entry: LogEntry = {
    timestamp: input.timestamp ?? Date.now(),
    level: input.level,
    source: input.source,
    message: input.message,
  };
  if (input.tabId !== undefined) entry.tabId = input.tabId;
  const location = validLocation(input.location);
  if (location) entry.location = location;
  // Checked like `location`: the input may have crossed the page →
  // worker message boundary, and a bad value here would render an
  // empty badge.
  if (isLoadState(input.state)) entry.state = input.state;
  const next = prior.length >= LOG_CAP
    ? [...prior.slice(prior.length - LOG_CAP + 1), entry]
    : [...prior, entry];
  const toSet: Record<string, unknown> = { [lk]: next };
  // A load-state transition is badged by the row, not the sentinel —
  // otherwise a `refresh-failed` entry would leave WARNING behind for
  // the rest of the session after the row had already recovered.
  if (entry.state === undefined && isHigher(input.level, priorLevel)) toSet[mk] = input.level;
  await chrome.storage.session.set(toSet);
}

export async function getScriptLog(scriptId: string): Promise<LogEntry[]> {
  const key = logKey(scriptId);
  const got = await chrome.storage.session.get(key);
  return Array.isArray(got[key]) ? (got[key] as LogEntry[]) : [];
}

export async function clearScriptLog(scriptId: string): Promise<void> {
  if (isPageContext()) return writeViaWorker({ op: 'clear', scriptId });
  return enqueue(scriptId, () => removeEntries(scriptId));
}

// Shared removal body, the counterpart of `writeEntry`. Always called
// from inside `enqueue`.
async function removeEntries(scriptId: string): Promise<void> {
  await chrome.storage.session.remove([logKey(scriptId), levelKey(scriptId)]);
}

// Drop the logs of scripts whose rows are going away — otherwise an
// orphaned session-storage entry would outlive the script it described
// and confuse any later renderer that scans log levels. Goes through
// `clearScriptLog` (and therefore the per-script queue, in whichever
// context owns it), so an append still in flight can't land after the
// removal and resurrect the row.
// Best-effort: a script whose log was never written isn't an error, and
// nothing that deletes a row should fail because of its log.
export async function forgetScriptLogs(scriptIds: readonly string[]): Promise<void> {
  await Promise.all(scriptIds.map(
    (id) => clearScriptLog(id).catch(() => { /* best-effort */ }),
  ));
}

// Read the persisted "highest log level seen" sentinel for one script.
// Returns undefined when no script-originated entry has been appended
// this session (load-state entries don't count — see `LogEntry.state`)
// or `clearScriptLog` ran. The sentinel
// is monotonic within a session — LOG_CAP rotation does NOT decrease
// it. Once a script has hit ERROR, subsequent rotation that drops the
// only error entry leaves the badge at ERROR until the user clicks
// "Clear log" or Chrome shuts down. We accept that drift because
// recomputing on every rotation would dominate the cost of an append
// and the log itself is session-scoped anyway.
export async function getMaxLogLevel(
  scriptId: string,
): Promise<LogLevel | undefined> {
  const key = levelKey(scriptId);
  const got = await chrome.storage.session.get(key);
  const v = got[key];
  return v === 'info' || v === 'warning' || v === 'error' ? v : undefined;
}

// Read every script's max log level in one storage round trip. The
// collections page uses this to render the Status column without N
// per-script reads. Returns a Map keyed by scriptId.
export async function getAllMaxLogLevels(): Promise<Map<string, LogLevel>> {
  const all = await chrome.storage.session.get(null);
  const out = new Map<string, LogLevel>();
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(LOG_LEVEL_KEY_PREFIX)) continue;
    if (value === 'info' || value === 'warning' || value === 'error') {
      out.set(key.slice(LOG_LEVEL_KEY_PREFIX.length), value);
    }
  }
  return out;
}

// Convenience: fire-and-forget. Used by call sites that already have a
// console.log next to the event and don't want to await an extra
// promise. Errors swallow silently — the log itself isn't load-bearing
// and a chrome.storage.session failure shouldn't break the refresh
// path that's emitting the event.
export function logScriptEvent(scriptId: string, input: AppendLogInput): void {
  appendScriptLog(scriptId, input).catch(() => { /* best-effort */ });
}

// Test/debug hook to drain in-flight appends before asserting on the
// stored log. Used by unit tests directly, and by the SW's e2e
// `getScriptLog` accessor — both would otherwise race `logScriptEvent`,
// which returns before its write lands.
export async function _flushScriptLogQueueForTests(scriptId: string): Promise<void> {
  // Loop rather than awaiting once: an append that chains on while we
  // wait becomes the new tail, and returning after the old one would
  // leave exactly the entry the caller is about to read still unwritten.
  let awaited: unknown;
  for (let tail = queues.get(scriptId); tail && tail !== awaited; tail = queues.get(scriptId)) {
    awaited = tail;
    await tail.catch(() => {});
  }
}
