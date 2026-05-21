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

export type LogLevel = 'info' | 'warning' | 'error';

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
  return enqueue(scriptId, async () => {
    const key = logKey(scriptId);
    const got = await chrome.storage.session.get(key);
    const prior: LogEntry[] = Array.isArray(got[key]) ? (got[key] as LogEntry[]) : [];
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
    await chrome.storage.session.set({ [key]: next });
  });
}

export async function getScriptLog(scriptId: string): Promise<LogEntry[]> {
  const key = logKey(scriptId);
  const got = await chrome.storage.session.get(key);
  return Array.isArray(got[key]) ? (got[key] as LogEntry[]) : [];
}

export async function clearScriptLog(scriptId: string): Promise<void> {
  return enqueue(scriptId, async () => {
    await chrome.storage.session.remove(logKey(scriptId));
  });
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
