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
// recording the highest level any entry has carried so far. Bumped
// only when an append carries a strictly higher level; cleared on
// `clearScriptLog`. It lives in session storage (not on the
// StoredScript row) because:
//   - Lifetime matches the log itself — Chrome shutdown drops both
//     together, so a WARNING/ERROR badge can't outlive its entries.
//   - One bulk `get(null)` yields every script's level in O(scripts)
//     rather than O(scripts × entries) — the sources page needs this
//     to render the Status column cheaply.

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
  // Origin label: e.g. 'refresh', 'wrapper', 'injector'. Pairs with the
  // optional tabId so the log pane can render either "tab 17 — wrapper"
  // or just "refresh" depending on what the entry actually carries.
  source: string;
  // Chrome tab ID, when the event originated from injected code in a
  // specific tab. Absent for SW-side and other background events.
  tabId?: number;
  // Human-readable message. Multiline is fine; the log pane preserves
  // newlines.
  message: string;
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
  // Optional override for the timestamp (tests use this to keep output
  // deterministic). Production callers omit it and get Date.now().
  timestamp?: number;
}

export async function appendScriptLog(
  scriptId: string,
  input: AppendLogInput,
): Promise<void> {
  return enqueue(scriptId, () => writeEntry(scriptId, input, false));
}

// Append `input` only if the script's log doesn't already carry an
// entry with the same `message`. Runs inside the same per-script queue
// as `appendScriptLog`, so the read and the write are atomic with
// respect to other appends for this script.
//
// Deliberately matches on the message alone, ignoring `source` and
// `level`: the Log tab is a human-readable narrative, and two
// subsystems stating the identical sentence reads as a duplicate no
// matter which one got there first. That's exactly what the callers
// want — the boot replay and the add-source path both re-state facts a
// refresh may already have logged.
//
// Only for low-frequency paths (boot replay, initial add). The refresh
// hot path suppresses repeats from the *stored script state* instead
// (see `emitScriptOutcomeLog`), which is cheaper and survives the
// session-storage wipe that clears this log.
export async function appendScriptLogIfAbsent(
  scriptId: string,
  input: AppendLogInput,
): Promise<void> {
  return enqueue(scriptId, () => writeEntry(scriptId, input, true));
}

// Shared read-modify-write body. Always called from inside `enqueue`.
async function writeEntry(
  scriptId: string,
  input: AppendLogInput,
  skipIfMessagePresent: boolean,
): Promise<void> {
  const lk = logKey(scriptId);
  const mk = levelKey(scriptId);
  const got = await chrome.storage.session.get([lk, mk]);
  const prior: LogEntry[] = Array.isArray(got[lk]) ? (got[lk] as LogEntry[]) : [];
  if (skipIfMessagePresent && prior.some((e) => e.message === input.message)) return;
  const priorLevel = got[mk] as LogLevel | undefined;
  const entry: LogEntry = {
    timestamp: input.timestamp ?? Date.now(),
    level: input.level,
    source: input.source,
    message: input.message,
  };
  if (input.tabId !== undefined) entry.tabId = input.tabId;
  const next = prior.length >= LOG_CAP
    ? [...prior.slice(prior.length - LOG_CAP + 1), entry]
    : [...prior, entry];
  const toSet: Record<string, unknown> = { [lk]: next };
  if (isHigher(input.level, priorLevel)) toSet[mk] = input.level;
  await chrome.storage.session.set(toSet);
}

export async function getScriptLog(scriptId: string): Promise<LogEntry[]> {
  const key = logKey(scriptId);
  const got = await chrome.storage.session.get(key);
  return Array.isArray(got[key]) ? (got[key] as LogEntry[]) : [];
}

export async function clearScriptLog(scriptId: string): Promise<void> {
  return enqueue(scriptId, async () => {
    await chrome.storage.session.remove([logKey(scriptId), levelKey(scriptId)]);
  });
}

// Read the persisted "highest log level seen" sentinel for one script.
// Returns undefined only when the log is empty (no entries have ever
// been appended this session, or `clearScriptLog` ran). The sentinel
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
// sources page uses this to render the Status column without N
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

// Test/debug hook so unit tests can drain in-flight appends before
// asserting on the stored log.
export async function _flushScriptLogQueueForTests(scriptId: string): Promise<void> {
  const inFlight = queues.get(scriptId);
  if (inFlight) await inFlight.catch(() => {});
}
