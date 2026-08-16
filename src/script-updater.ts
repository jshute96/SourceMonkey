// Single entry point for every userscript refresh path.
//
// Two trigger modes share the same underlying work (refreshScript /
// refreshCollection / refreshAllCollections in script-store.ts):
//
//   - 'manual'        — the user clicked a Refresh button. Always runs.
//                       Awaited by the caller so the UI can show a
//                       spinner and react to the result.
//   - 'opportunistic' — the SW noticed a page that uses some scripts
//                       and wants to check whether their source files
//                       changed on disk. Fire-and-forget. Rate-limited
//                       to no sooner than UPDATE_MIN_INTERVAL_MS after
//                       the previous completion, and never concurrent
//                       for the same resource.
//
// In both modes a check that's currently in flight for a resource is
// shared — a manual click that lands while an opportunistic check is
// already running awaits that existing promise instead of starting a
// second pass. This holds PER gate key: the script gate
// (`updateScript`), the collection gate (`updateCollection`), and the
// all-collections gate (`updateAllCollections`) are independent maps,
// so an opportunistic `updateScript(X)` can still run alongside a
// manual `updateCollection(S⊇X)` or `updateAllCollections` that also
// rebuilds X. They fetch the same bytes, and their storage writes are
// serialized and re-read user-owned state by `script-store.ts`'s
// `mutate()` lock (see docs/storage.md "Write serialization"), so the
// overlap is idempotent rather than corrupting — but it is NOT deduped
// to a single fetch.
//
// We deliberately don't try to mark tabs stale from here. The actual
// stale propagation happens via chrome.storage.onChanged in
// background.ts so that ANY write that changes a script's content
// (this module, external tools poking storage, future paths we haven't
// imagined) triggers the same propagation.

import {
  getAllScripts,
  getScript,
  getCollections,
  getCollectionWithScripts,
  loadStateLogEntry,
  localFileLogMessages,
  refreshAllCollections,
  refreshScript,
  refreshCollection,
  setVersionProbes,
  type ParseCheckMode,
  type StartupLog,
  type StoredScript,
  type StoredCollection,
} from './script-store.js';
import {
  outdatedProbe,
  probeLabel,
  probeTargets,
  probesAreFresh,
  type ProbePolicy,
} from './version-probe.js';
import { probeVersions } from './version-probe-fetch.js';
import { mapWithConcurrency, PROBE_SCRIPTS_CONCURRENCY } from './concurrency.js';
import { describeRefreshError, readRefreshErrors } from './refresh-error.js';
import { getValue } from './userscript-header.js';
import { dlog } from './debug-log.js';
import { startPhaseTimer, resetPhaseTotals, reportPhaseTotals } from './phase-timing.js';
import { githubTokenLogSuffix } from './github-auth.js';
import { getScriptLogLabel } from './script-log-id.js';
import { appendScriptLog, logScriptEvent, type AppendLogInput } from './script-log.js';
import { describeDiagnostic } from './diagnostic-location.js';
import { retryRejectedRegistrations } from './injector.js';

export type UpdateMode = 'manual' | 'opportunistic';

// Minimum gap between opportunistic checks for the same resource. The
// 10s figure is a balance: short enough that a user editing a script
// and switching tabs sees the update within a click or two, long
// enough that the background work doesn't measurably affect navigation.
export const UPDATE_MIN_INTERVAL_MS = 10_000;

type Resource = string; // arbitrary key — see resource* helpers below

export interface GateSlot<T> {
  inFlight?: { promise: Promise<T> };
  lastCompletedAt?: number;
}

// Allow tests to swap the clock. Production uses Date.now.
let nowMsImpl: () => number = () => Date.now();
export function _setNowForTests(fn: () => number): void {
  nowMsImpl = fn;
}

// Pure-ish core: run `task` if and only if there isn't one already in
// flight for this resource, and (for opportunistic mode) the cooldown
// has elapsed. Returns the active promise either way. The state Map is
// mutated in place; callers pass in a stable per-resource-type map so
// independent resources can run concurrently.
//
// Exported so tests can exercise the concurrency/rate-limit logic
// without touching chrome.storage.
export function gate<T>(
  state: Map<Resource, GateSlot<T>>,
  key: Resource,
  mode: UpdateMode,
  task: () => Promise<T>,
  skipResult: T,
): Promise<T> {
  let slot = state.get(key);
  if (!slot) {
    slot = {};
    state.set(key, slot);
  }
  // Coalesce onto any in-flight work for this resource regardless of
  // mode. A manual click during a background check shouldn't start a
  // second fetch; it should wait for the running one.
  if (slot.inFlight) return slot.inFlight.promise;
  if (mode === 'opportunistic') {
    const last = slot.lastCompletedAt ?? 0;
    if (nowMsImpl() - last < UPDATE_MIN_INTERVAL_MS) {
      return Promise.resolve(skipResult);
    }
  }
  const promise = (async () => {
    try {
      return await task();
    } finally {
      const s = state.get(key);
      if (s) {
        s.inFlight = undefined;
        s.lastCompletedAt = nowMsImpl();
      }
    }
  })();
  slot.inFlight = { promise };
  return promise;
}

// Separate maps per result type so type inference stays clean.
const scriptState = new Map<Resource, GateSlot<StoredScript | null>>();
const collectionState = new Map<Resource, GateSlot<{ collection: StoredCollection; scripts: StoredScript[] } | null>>();
const allCollectionsState = new Map<Resource, GateSlot<unknown>>();

// "all collections" is one global slot, but reuse the same shape so the
// concurrency/rate-limit logic stays uniform.
const ALL_COLLECTIONS_KEY = '*';

// Public API ---------------------------------------------------------

// `probe` is separate from `mode` on purpose. `manual` means "not
// rate-limited as a refresh", and the reload fast-path uses it for
// every matched script on every explicit tab reload — so treating
// `manual` as "the user asked, check upstream now" would fire a
// third-party request per script per reload. Only a genuine Refresh
// click passes `'force'`.
//
// `parseCheck` follows one rule, and it is deliberately not the same
// axis as `mode`: **a navigation-triggered check never waits for a
// parse verdict; a user-initiated one does.** Both of this module's
// navigation callers therefore pass 'defer' — the reload fast path,
// which has a wrapper in the page blocked on the answer, and the
// opportunistic sweep, which has nobody waiting at all.
//
// The rule has to be uniform because `gate()` coalesces regardless of
// mode, and both of those callers are queued off the same
// `onCommitted`. If one of them waited for the verdict, whichever
// reached the gate first would decide for both — so the fast path
// would silently pay the check on exactly the first reload after an
// idle gap, which is the ordinary edit-save-reload loop.
//
// The same coalescing would let a user-initiated check inherit a
// verdict-less row. What stops it today is context, not the gate:
// every user-initiated single-script check runs in the page that
// clicked (see docs/parse-check.md on where checkers are installed),
// and that page has its own `scriptState` map. Add an SW-side Refresh
// entry point and this stops being true — a caller that must have the
// verdict would then need it enforced here rather than assumed.
export function updateScript(
  scriptId: string,
  mode: UpdateMode,
  probe: ProbePolicy = 'if-stale',
  parseCheck: ParseCheckMode = 'await',
): Promise<StoredScript | null> {
  return gate(
    scriptState, scriptId, mode,
    () => runScriptCheck(scriptId, mode, probe, parseCheck), null,
  );
}

// Only ever reached from a Refresh button, so probes force by default.
export function updateCollection(
  collectionId: string,
  mode: UpdateMode,
  probe: ProbePolicy = 'force',
): Promise<{ collection: StoredCollection; scripts: StoredScript[] } | null> {
  return gate(collectionState, collectionId, mode, () => runCollectionCheck(collectionId, mode, probe), null);
}

// Only ever reached from Refresh All, so probes force by default.
export function updateAllCollections(
  mode: UpdateMode,
  probe: ProbePolicy = 'force',
): Promise<Map<string, { collection: StoredCollection; scripts: StoredScript[] }>> {
  // We have to do the cast dance because gate is generic over a single
  // result type and the skip result for "no work done" is just an empty
  // map, not null.
  return gate<unknown>(
    allCollectionsState,
    ALL_COLLECTIONS_KEY,
    mode,
    () => runAllCollectionsCheck(mode, probe) as Promise<unknown>,
    new Map(),
  ) as Promise<Map<string, { collection: StoredCollection; scripts: StoredScript[] }>>;
}

// ---------- Task wrappers that log lifecycle to the SW console -------
//
// Each user-visible check goes through these so the SW console tells
// the story: "checking X", then either "no change", "loaded new
// content", or "failed: <err>". Without this it's hard to tell
// whether the opportunistic refresh is even running.
//
// We do a getScript / getCollectionWithScripts read BEFORE the refresh
// so we have the prior loadedAt to compare against the post-refresh
// row. One extra storage read per check — cheap.

// `@require` + `@resource` policy by trigger mode. Manual clicks
// rebuild deps from scratch so users can pick up remote updates
// without touching the main script. Opportunistic background checks
// preserve the cached entries verbatim and only fetch newly-declared
// refs — keeping page-load cost bounded.
function fileRecheckMode(mode: UpdateMode): 'all' | 'preserve' {
  return mode === 'manual' ? 'all' : 'preserve';
}

async function runScriptCheck(
  scriptId: string,
  mode: UpdateMode,
  probe: ProbePolicy,
  parseCheck: ParseCheckMode = 'await',
): Promise<StoredScript | null> {
  const prior = await getScript(scriptId);
  const label = getScriptLogLabel(scriptId);
  // Manual checks fire on a deliberate user click and are infrequent;
  // their start + "no change" outcome stays at console.log so the user
  // gets unconditional confirmation that the click did something.
  // Opportunistic checks fire on every navigation and are gated by the
  // debug flag.
  const checkLog = mode === 'manual' ? console.log : dlog;
  const tokenSuffix = prior?.fileUrl ? githubTokenLogSuffix(prior.fileUrl) : '';
  checkLog(`[SourceMonkey] update check (${mode}): ${label}${tokenSuffix}`);
  // No Log-tab row before the work: `emitScriptOutcomeLog` writes the
  // whole story afterwards, as one line when there is nothing to report
  // and a `Checking for updates` preamble when there is. The SW console
  // above still brackets the work for anyone watching it live.
  let next: StoredScript | null;
  try {
    next = await refreshScript(scriptId, { recheckFiles: fileRecheckMode(mode), parseCheck });
  } catch (err) {
    const msg = describe(err);
    console.info(`[SourceMonkey] update check failed: ${label}: ${msg}`);
    // Stands alone — it names the check and its failure in one line,
    // so it needs no preamble.
    logScriptEvent(scriptId, {
      level: 'error',
      source: refreshLogSource(mode),
      message: `Could not check for updates: ${msg}`,
    });
    throw err;
  }
  logScriptOutcome(label, prior, next, mode);
  emitScriptOutcomeLog(scriptId, prior, next, mode);
  // Deliberately NOT awaited. This promise is what the reload
  // fast-path races against a 500 ms window (see
  // docs/injection.md#reload-fast-path) — folding a third-party fetch
  // into it would blow that budget and drop the reload back to running
  // the old body. The probe's own storage write repaints any open
  // viewer via storage.onChanged when it lands.
  if (next) void runVersionProbes([next], probe);
  // Not awaited, same as the probe above: it must not sit in the
  // fast-path window. No-ops unless this script is currently rejected,
  // in which case a refresh that changed nothing would otherwise never
  // re-offer it to Chrome. See `retryRejectedRegistrations`.
  //
  // `probe === 'force'` is the only signal we have for "the user
  // clicked Refresh" — `mode: 'manual'` means "not rate-limited" and
  // the reload fast-path uses it for every matched script on every
  // reload. A click retries immediately; a navigation-driven check
  // takes the rate limit, so one page load can't produce a burst of
  // identical rows.
  void retryRejectedRegistrations([scriptId], { userInitiated: probe === 'force' });
  return next;
}

async function runCollectionCheck(
  collectionId: string,
  mode: UpdateMode,
  probe: ProbePolicy,
): Promise<{ collection: StoredCollection; scripts: StoredScript[] } | null> {
  const priorData = await getCollectionWithScripts(collectionId);
  const prior: SourceSnapshot | undefined = priorData
    ? { collection: priorData.collection, scripts: new Map(priorData.scripts.map((s) => [s.id, s])) }
    : undefined;
  const label = priorData?.collection.path ?? collectionId;
  // Suffix the start line with "(with GitHub token)" when the
  // collection URL would carry the GitHub auth header on fetch. Lets
  // the user confirm from the SW console that their Options-page token
  // is actually in play for this collection (otherwise a silent "still
  // hitting unauthenticated rate limits" is hard to diagnose).
  const tokenSuffix = prior?.collection.path ? githubTokenLogSuffix(prior.collection.path) : '';
  console.log(`[SourceMonkey] collection refresh (${mode}): ${label}${tokenSuffix}`);
  // Sits OUTSIDE refreshCollection's own timer rather than extending it:
  // the probes and the rejection retry are this layer's work, and the
  // question "is the refresh slow or is the annotation pass slow?" is
  // exactly what the split answers.
  const timer = startPhaseTimer(`collection check (${mode})`);
  resetPhaseTotals();
  let result: { collection: StoredCollection; scripts: StoredScript[] } | null;
  try {
    result = await refreshCollection(collectionId, { recheckFiles: fileRecheckMode(mode) });
  } catch (err) {
    const msg = describe(err);
    console.info(`[SourceMonkey] collection refresh failed: ${label}: ${msg}`);
    // A throw out of refreshCollection leaves every script under this
    // collection unrefreshed. Say so in each one's Log rather than
    // letting the failure live only in the SW console.
    logCollectionEventToScripts(
      [...(prior?.scripts.values() ?? [])], mode,
      await collectionFailureMessage(collectionId, msg),
    );
    throw err;
  }
  timer.mark('refresh');
  if (result) {
    summarizeCollectionOutcome(label, prior, result, mode);
    await runVersionProbes(result.scripts, probe);
    timer.mark('probes');
    timer.note(() => `${probedCount(result.scripts)} of ${result.scripts.length} scripts have a probe target`);
    // Retry any script under this collection that Chrome is refusing —
    // refreshing a collection is one of the places a user goes to say
    // "try again". See `retryRejectedRegistrations`.
    await retryRejectedRegistrations(
      result.scripts.map((s) => s.id), { userInitiated: probe === 'force' },
    );
    timer.mark('retry-rejected');
  }
  timer.done();
  reportPhaseTotals('collection check');
  return result;
}

// How many of these scripts a probe pass would actually fetch for.
// Reported alongside the probe phase because a `0ms` probe leg means
// two very different things — nothing to check, or everything already
// fresh — and only the count separates them.
function probedCount(scripts: readonly StoredScript[]): number {
  return scripts.filter(
    (s) => s.status === 'ok' && probeTargets(s.header, s.fileUrl).length > 0,
  ).length;
}

// The one sentence a collection-level refresh failure gets in every
// affected script's Log, whichever entry point caught it. Both callers
// route through here so the same failure can't read two ways.
//
// Which sentence depends on WHERE it failed, and the recorded map is the
// evidence: `refreshCollection` records only when its write throws, so
// an entry means the collection was read fine and couldn't be stored.
// A throw with nothing recorded came from earlier in the pipeline — a
// storage read, a hash, a rebuild — and must not claim the read
// succeeded, so it gets the generic wording.
async function collectionFailureMessage(
  collectionId: string,
  fallbackReason: string,
): Promise<string> {
  const recorded = (await readRefreshErrors())[collectionId];
  return recorded
    ? describeRefreshError(recorded)
    : `Could not refresh this collection: ${fallbackReason}`;
}

async function runAllCollectionsCheck(
  mode: UpdateMode,
  probe: ProbePolicy,
): Promise<Map<string, { collection: StoredCollection; scripts: StoredScript[] }>> {
  console.log(`[SourceMonkey] refreshing all collections (${mode})`);
  // Same split as runCollectionCheck: each collection times its own
  // refresh, so what this adds is the work Refresh All does AROUND
  // them — the prior snapshot, and the probe + retry pass that runs
  // once over every script in every collection rather than per
  // collection.
  const timer = startPhaseTimer(`all-collections check (${mode})`);
  resetPhaseTotals();
  // Snapshot priors BEFORE the refresh; reading after would just give
  // back the post-refresh state and the summary would always say 0
  // updated / 0 added.
  const priorByCollectionId = await snapshotAllCollectionScripts();
  timer.mark('snapshot');
  let result: Map<string, { collection: StoredCollection; scripts: StoredScript[] }>;
  try {
    result = await refreshAllCollections({ recheckFiles: fileRecheckMode(mode) });
  } catch (err) {
    const msg = describe(err);
    console.info(`[SourceMonkey] refresh all failed: ${msg}`);
    // Reached only when the PASS itself broke — a per-collection failure
    // is recorded and skipped inside `refreshAllCollections`, and handled
    // below. Nothing was summarized here, so every script hears the same
    // reason. Same fan-out as runCollectionCheck so the two paths can't
    // drift.
    for (const snapshot of priorByCollectionId.values()) {
      logCollectionEventToScripts(
        [...snapshot.scripts.values()], mode, `Could not refresh this collection: ${msg}`,
      );
    }
    throw err;
  }

  // Collections that were refreshed but couldn't be saved are absent
  // from `result` without the pass having failed. They still owe their
  // scripts a Log entry — a Refresh All that silently skipped this would
  // say less than refreshing the same collection on its own, which does
  // log (see runCollectionCheck).
  //
  // Keyed off the recorded map so each collection gets ITS reason, and so
  // a collection absent for the other reason — removed mid-refresh, which
  // clears its entry — stays quiet.
  timer.mark('refresh');
  const refreshErrors = await readRefreshErrors();
  for (const [id, snapshot] of priorByCollectionId) {
    if (result.has(id)) continue;
    const reason = refreshErrors[id];
    if (!reason) continue;
    logCollectionEventToScripts(
      [...snapshot.scripts.values()], mode, describeRefreshError(reason),
    );
  }
  for (const [, refreshed] of result) {
    summarizeCollectionOutcome(
      refreshed.collection.path,
      priorByCollectionId.get(refreshed.collection.id),
      refreshed,
      mode,
    );
  }
  const allScripts = [...result.values()].flatMap((r) => r.scripts);
  timer.mark('summarize');
  await runVersionProbes(allScripts, probe);
  timer.mark('probes');
  // Counted, not just timed: each probe result is its own storage write,
  // and a write is what schedules a registration re-sync. The number of
  // probed scripts is therefore the number of re-syncs this pass can
  // provoke, which is not something the elapsed time shows.
  timer.note(() => `${probedCount(allScripts)} of ${allScripts.length} scripts have a probe target`);
  // Refresh All is the other "try again" button, so it retries every
  // refused registration it just re-read. See
  // `retryRejectedRegistrations`.
  await retryRejectedRegistrations(
    allScripts.map((s) => s.id), { userInitiated: probe === 'force' },
  );
  timer.mark('retry-rejected');
  timer.done();
  reportPhaseTotals('all-collections check');
  return result;
}

// ---------- Update probes ----------
//
// Runs after the refresh, against the rows it produced. Deliberately
// downstream of everything above: a probe can't change a status, can't
// set a refreshError, and a probe host that's down or slow must leave
// the refresh's own outcome exactly as it was. See src/version-probe.ts
// for what "probe" means here and [docs/updates.md] for why we don't
// simply update from the probed URL.
//
// Awaited by the collection-level entry points (a Refresh button click,
// where the user is watching a spinner and expects the row to be
// current when it stops) but not by the per-script one, which sits on
// the navigation hot path — see runScriptCheck.
async function runVersionProbes(
  scripts: readonly StoredScript[],
  probe: ProbePolicy,
): Promise<void> {
  // Bounded for the same reason the refresh fan-out is (see
  // src/concurrency.ts): "Refresh All" hands this every script in every
  // collection, and each one expands into its own pool of probe fetches.
  // Unbounded here would put the product in flight at once.
  await mapWithConcurrency(scripts, PROBE_SCRIPTS_CONCURRENCY, (s) =>
    probeOneScript(s, probe).catch(() => {
      // A probe is an annotation. Nothing downstream depends on it, so a
      // failure that escaped runProbe's own handling dies here rather
      // than propagating into the refresh the user actually asked for.
    }));
}

async function probeOneScript(
  script: StoredScript,
  policy: ProbePolicy,
): Promise<void> {
  // Only rows that are actually running get probed. An `invalid` row's
  // header may not have parsed at all, and a `missing` one has no
  // upstream question worth asking — the local copy is the problem.
  // Their stored probes are left alone rather than cleared: MISSING and
  // INVALID both outrank OUTDATED so nothing stale is on screen, and a
  // row that recovers gets its annotation back without a refetch.
  if (script.status !== 'ok') return;
  const targets = probeTargets(script.header, script.fileUrl);
  if (targets.length === 0) {
    // The script no longer names an upstream we don't already fetch
    // from (or never did). Clear any annotation left from when it did,
    // so a removed `@updateURL` doesn't strand an OUTDATED badge.
    if (script.versionProbes) await setVersionProbes(script.id, []);
    return;
  }
  const now = nowMsImpl();
  // Everything but an explicit Refresh click respects the interval —
  // including the reload fast-path, which runs in `manual` mode on
  // every tab reload.
  if (policy === 'if-stale' && probesAreFresh(script.versionProbes, targets, now)) return;

  const loadedVersion = script.header ? getValue(script.header, 'version') : undefined;
  const before = outdatedProbe(loadedVersion, script.versionProbes);
  const probes = await probeVersions(targets, now, script.versionProbes);
  await setVersionProbes(script.id, probes);

  // Report the transition, not the state: an upstream that has been
  // ahead of us for a month shouldn't add a Log entry every interval.
  const after = outdatedProbe(loadedVersion, probes);
  if (!after || after.version === before?.version) return;
  const message =
    `Newer version ${after.version} at ${probeLabel(after.kinds)} ` +
    `(running ${loadedVersion}) — ${after.url}`;
  console.info(`[SourceMonkey] ${getScriptLogLabel(script.id)}: ${message}`);
  // Not split by trigger mode like the refresh labels: this entry
  // reports a transition ("an upstream copy just moved ahead of us"),
  // and whether a click or a navigation noticed it tells the user
  // nothing they'd act on.
  logScriptEvent(script.id, { level: 'warning', source: 'version-probe', message });
}

interface SourceSnapshot {
  collection: StoredCollection;
  scripts: Map<string, StoredScript>;
}

// Pre-refresh state per collection: the collection row (for its
// `scanError`, so a still-down collection doesn't re-log) plus its
// scripts by ID.
async function snapshotAllCollectionScripts(): Promise<Map<string, SourceSnapshot>> {
  const collections = await getCollections();
  const entries = await Promise.all(collections.map(async (s) => {
    const data = await getCollectionWithScripts(s.id);
    const scripts = new Map((data?.scripts ?? []).map((sc) => [sc.id, sc]));
    return [s.id, { collection: s, scripts }] as const;
  }));
  return new Map(entries);
}

// ---------- Logging helpers ----------

function logScriptOutcome(
  label: string,
  prior: StoredScript | undefined,
  next: StoredScript | null,
  mode: UpdateMode,
): void {
  if (!next) {
    console.info(`[SourceMonkey] update check: ${label}: row vanished`);
    return;
  }
  if (next.status === 'invalid') {
    console.info(
      `[SourceMonkey] update check: ${label}: invalid — ` +
      `${describeDiagnostic(next.errorMessage ?? 'unknown', next.errorLocation)}`,
    );
    return;
  }
  // Refresh failed but the cached good copy keeps running. Log once on
  // the transition (or when the reason changes) so a collection that
  // stays down doesn't spam the console on every opportunistic check.
  if (next.refreshError && prior?.refreshError !== next.refreshError) {
    console.info(`[SourceMonkey] refresh failed: ${label}: ${next.refreshError}`);
    return;
  }
  if (!prior || prior.loadedAt !== next.loadedAt) {
    // loadedAt bumps iff the load pipeline actually built from fresh
    // content. Same loadedAt means the size+mtime skip caught it.
    const size = next.size != null ? ` (${formatBytes(next.size)})` : '';
    console.log(`[SourceMonkey] loaded new content: ${label}${size}`);
  } else {
    // "no change" pairs with the entry log: visible on manual, gated
    // on opportunistic. Otherwise a Refresh click could log "update
    // check" with nothing following.
    const outcomeLog = mode === 'manual' ? console.log : dlog;
    outcomeLog(`[SourceMonkey] no change: ${label}`);
  }
}

// Write a check's whole story into the per-script Log, mirroring the
// SW-console outcome line. The uneventful outcome is manual-only, so
// background polling doesn't fill the log with rows saying a healthy
// script is still healthy — those still get debug-gated console output
// via dlog.
//
// Every failure the UI surfaces on a script row also lands here, so
// clicking a red/amber badge always leads to an explanation:
// `invalid` and `missing` (error), and `refreshError` (warning) — see
// `loadStateLogEntry` for the phrasing and the level rationale.
//
// **One row per uneventful check, two when there's news.** A check
// that finds nothing writes a single `Checked for updates — no change`
// line. A check with something to report writes `Checking for updates`
// and then the outcome, which carries its own severity and is what the
// status badge links to.
//
// "Still broken" is a freshly computed verdict, not an echo: an
// `invalid` row can't take the size+mtime skip (`canSkip` requires
// `status === 'ok'`), so every check refetches and re-runs split +
// parse + validate.
//
// **Opportunistic checks log too.** They report the same facts a manual
// check would, and the whole point of a background check is to notice a
// failure the user hasn't gone looking for yet — a badge that turns
// amber on its own should have a matching Log line. (Trigger mode still
// gates the *non*-events: the uneventful row is manual-only.)
//
// Exported for unit tests — the public entry points would need the
// whole chrome.storage pipeline stubbed to reach it.
export function emitScriptOutcomeLog(
  scriptId: string,
  prior: StoredScript | undefined,
  next: StoredScript | null,
  mode: UpdateMode,
): void {
  const source = refreshLogSource(mode);
  // A check that found nothing to say is ONE line naming both the
  // check and its result — see `NO_CHANGE_MESSAGE`. Only a check with
  // something to report gets a preamble, because there the result is
  // its own line (and its own severity) and needs the check named
  // separately.
  //
  // Written after the work, so both halves land together. The SW
  // console is where a check is bracketed live; the Log tab is a
  // record of what happened.
  if (hasReportableOutcome(prior, next)) {
    logScriptEvent(scriptId, { level: 'info', source, message: 'Checking for updates' });
  }
  if (!next) {
    logScriptEvent(scriptId, {
      level: 'warning',
      source,
      message: 'This script was removed while it was being refreshed',
    });
    return;
  }
  // Before the state verdict, and not gated by it: a script can be
  // `invalid` for an unrelated reason and still have picked up a local
  // stand-in this pass, and that substitution is exactly what the user
  // needs to know about while debugging the failure.
  for (const message of localFileLogMessages(prior, next)) {
    logScriptEvent(scriptId, { level: 'info', source, message });
  }
  const nextState = loadStateLogEntry(next);
  const priorState = prior ? loadStateLogEntry(prior) : null;
  if (nextState) {
    // Written even when the failure is byte-identical to the one
    // already in the log: every check re-runs the full fetch + parse +
    // validate — an `invalid` row can't take the size+mtime skip, which
    // requires `status === 'ok'` — so this is a fresh verdict on a
    // fresh read, and the check that produced it has to end somewhere.
    logScriptEvent(scriptId, { ...nextState, source });
    return;
  }
  if (prior && priorState) {
    // The row is healthy again. Log the recovery so the Log explains
    // why the badge went back to OK — without this the last word on the
    // script would be a failure that is no longer true.
    logScriptEvent(scriptId, { level: 'info', source, message: recoveryMessage(prior) });
    // Recovering IS the outcome of this check. Falling through to the
    // uneventful line below would read as a contradiction when the
    // recovery didn't come with new bytes (a dependency host that
    // starts answering again clears the failure without touching the
    // script's own content, so `loadedAt` is preserved).
    if (prior.loadedAt === next.loadedAt) return;
  }
  if (!prior || prior.loadedAt !== next.loadedAt) {
    const size = next.size != null ? ` (${formatBytes(next.size)})` : '';
    logScriptEvent(scriptId, {
      level: 'info',
      source,
      message: `Loaded new content${size}`,
    });
    // Replay parse-time diagnostics whenever a new version lands. They
    // appear AFTER the "Loaded new content" line so it's clear which
    // version the warning belongs to. One entry per content version —
    // a refresh that doesn't change content adds nothing.
    for (const entry of next.startupLogs ?? []) {
      logScriptEvent(scriptId, startupLogEntry(entry));
    }
    return;
  }
  if (mode === 'manual') {
    logScriptEvent(scriptId, { level: 'info', source, message: NO_CHANGE_MESSAGE });
  }
}

// Fan a COLLECTION-level fact out into the Log of every script under
// that collection. Used for the failures that stop us from checking any
// of them (an unreadable listing, a throw out of the refresh) and for
// the matching recovery.
//
// **Always `info`, never warning/error.** These entries exist so a user
// reading one script's Log can see why it wasn't checked — the badge
// for a collection-level problem belongs on the collection row, which
// already renders `scanError` (see `renderCollectionSection` in
// collections.ts). Logging them higher would promote every script under
// a collection to WARNING via the `loglevel:` sentinel, which is
// monotonic within a session: one transient listing failure would leave
// N rows badged WARNING for the rest of the session, long after the
// collection came back.
//
// Plain append. A collection that stays unreadable re-logs on each pass,
// which is honest — every one of those passes really did try to read
// it. Only reachable from a Refresh / Refresh All click (see the
// `updateCollection` / `updateAllCollections` callers in
// collections.ts), so the user asked for each repeat.
function logCollectionEventToScripts(
  scripts: readonly StoredScript[],
  mode: UpdateMode,
  message: string,
): void {
  for (const s of scripts) {
    logScriptEvent(s.id, { level: 'info', source: refreshLogSource(mode), message });
  }
}

// The Log tab's Source label for a refresh pass. Spelled out per mode
// rather than composed from the mode name: these strings are read by
// users, and "opportunistic" describes our scheduling policy rather
// than anything they did or would recognise.
function refreshLogSource(mode: UpdateMode): string {
  return mode === 'manual' ? 'manual-refresh' : 'background-refresh';
}

// The single line a check writes when it has nothing to report: names
// the check AND its result, so a routine poll costs one row rather than
// a start/outcome pair. Manual-only (see `emitScriptOutcomeLog`).
const NO_CHANGE_MESSAGE = 'Checked for updates — no change';

// Whether this check has anything to say beyond that one line — i.e.
// whether there was something to check for this script in the first
// place.
//
// Mirrors the branches of `emitScriptOutcomeLog` below, in the same
// order, and is only ever read by it. Kept as its own predicate so the
// "should we announce the check?" decision and the "what do we report?"
// decision are written once each rather than twice.
//
// True when: the row vanished mid-refresh, it's failing now, it was
// failing before (so this pass genuinely re-fetched and re-validated —
// an `invalid` row can't take the size+mtime skip), or the content
// changed. False only for the healthy-and-unchanged case, whose whole
// outcome is the one self-describing `NO_CHANGE_MESSAGE` row.
function hasReportableOutcome(
  prior: StoredScript | undefined,
  next: StoredScript | null,
): boolean {
  if (!next) return true;
  if (loadStateLogEntry(next)) return true;
  if (prior && loadStateLogEntry(prior)) return true;
  // A local stand-in that appeared, vanished, or changed on disk is an
  // outcome even when the script's own bytes didn't move — that's the
  // common shape while editing a required library.
  if (localFileLogMessages(prior, next).length > 0) return true;
  return !prior || prior.loadedAt !== next.loadedAt;
}

// How to phrase "the failure we last logged for this row is over".
// Keyed off the prior row's state so the line names what recovered —
// a bare "ok again" wouldn't tell the user whether the file came back,
// the parse started succeeding, or the server did.
function recoveryMessage(prior: StoredScript): string {
  if (prior.status === 'invalid') return 'Loads cleanly again (was invalid)';
  if (prior.status === 'missing') return 'Script file is back';
  return 'Refresh succeeded again (collection is reachable)';
}

// Map a StartupLog level (page-console-flavored: log/info/warn/error)
// to the per-script LogEntry level (info/warning/error). 'log' and
// 'info' both land as 'info' because the Log tab doesn't render a
// separate 'log' level.
function startupLogLevelToLogLevel(level: StartupLog['level']): 'info' | 'warning' | 'error' {
  if (level === 'warn') return 'warning';
  if (level === 'error') return 'error';
  return 'info';
}

// A `StartupLog` as the Log tab's own entry shape. Both replay paths —
// the new-content one in `emitScriptOutcomeLog` and the once-per-session
// one in `ensureStartupLogsInLogTab` — go through here so a field added
// to StartupLog can't reach one of them and not the other. `location`
// is exactly such a field.
function startupLogEntry(sl: StartupLog): AppendLogInput {
  return {
    level: startupLogLevelToLogLevel(sl.level),
    source: 'parser',
    message: sl.message,
    ...(sl.location ? { location: sl.location } : {}),
  };
}

// Sentinel key in chrome.storage.session that records "we've already
// replayed the persisted per-script state for THIS Chrome session."
// session storage is cleared on Chrome shutdown, so a fresh Chrome
// session always misses the sentinel; SW restarts within a session
// always hit it.
//
// The key name predates the load-state leg and now under-describes what
// it gates. Kept as-is deliberately: renaming it would make one Chrome
// session miss its existing sentinel and replay a second time, which
// buys nothing.
const BOOT_REPLAY_SENTINEL_KEY = 'sm:startup-logs-replayed-at';

// Refill the Log tab from persisted state, once per Chrome session, at
// SW startup. Two things get replayed, both for the same reason: the
// facts live in `chrome.storage.local` and outlive the Chrome shutdown
// that wipes the session-scoped log, so without this a fresh session
// shows a red or amber badge over an empty Log until the user manually
// refreshes.
//
//   - **Load state** — a row that is currently `invalid` / `missing` /
//     carrying a `refreshError`. Nothing re-checks a script until it is
//     refreshed or its page is visited, so without this a script broken
//     since before the restart shows a badge over an empty Log.
//   - **Parse-time diagnostics** — `script.startupLogs`.
//
// The sentinel makes it idempotent: SW restarts within the same Chrome
// session bail out immediately. Both replays reuse the exact message
// text the refresh paths use, so the Log tab is visually uniform.
//
// The sentinel is written AFTER the walk, not before: MV3 can evict the
// worker mid-loop, and claiming it up front would mark the session
// replayed while most scripts still had empty logs — the exact state
// this exists to prevent. A torn-down replay simply runs again on the
// next SW wake-up, duplicating a row for the scripts the first pass
// reached. Rare and bounded to one Chrome session.
export async function replayScriptLogsAtBoot(): Promise<void> {
  const got = await chrome.storage.session.get(BOOT_REPLAY_SENTINEL_KEY);
  if (got[BOOT_REPLAY_SENTINEL_KEY]) return;

  // Single chrome.storage.local.get(null) scan via getAllScripts —
  // cheaper than per-collection reads when most scripts won't have
  // anything to replay anyway. Per-script work runs concurrently;
  // `appendScriptLog`'s own queue keeps each script's appends ordered.
  const scripts = await getAllScripts();
  await Promise.all(scripts.map(async (script) => {
    await ensureLoadStateInLogTab(script);
    await ensureStartupLogsInLogTab(script);
  }));

  await chrome.storage.session.set({ [BOOT_REPLAY_SENTINEL_KEY]: Date.now() });
}

// Restate a script's current load failure, if it has one.
//
// `source: 'extension-startup'` rather than a `*-refresh` label so the
// Log reads honestly: nothing was re-checked, we're just carrying the
// last known verdict forward across a browser restart. Not plain
// 'startup' either — that would read as the *script's* startup, which
// is what the `parser` source already covers.
//
// Plain append. The session sentinel already makes this run once per
// Chrome session, which is the only thing keeping the volume down that
// needs to.
async function ensureLoadStateInLogTab(script: StoredScript): Promise<void> {
  const entry = loadStateLogEntry(script);
  if (!entry) return;
  await appendScriptLog(script.id, { ...entry, source: 'extension-startup' });
}

// Replay `script.startupLogs` into the Log tab as `parser`-source rows.
//
// Plain append, like everything else here. A refresh that races this
// replay can leave a duplicate pair of rows — bounded to once per
// script per Chrome session, and a visible duplicate is a cheaper
// problem than a rule that has to explain when a line is dropped.
async function ensureStartupLogsInLogTab(script: StoredScript): Promise<void> {
  for (const sl of script.startupLogs ?? []) {
    await appendScriptLog(script.id, startupLogEntry(sl));
  }
}

// Roll a collection-level refresh up into one SW-console line, and fan
// the per-script outcomes out into the Log tab.
//
// The scan-failure case is handled separately from the per-script loop.
// `refreshCollection` deliberately leaves every script row untouched
// when the listing can't be read (see [docs/storage.md]) — so the
// per-script loop would report no change for every one of them, which
// is a lie: nothing was checked. Instead the reason is fanned out to
// each script (see `logCollectionEventToScripts` for why that's
// `info`).
//
// Exported for unit tests.
export function summarizeCollectionOutcome(
  label: string,
  prior: SourceSnapshot | undefined,
  next: { collection: StoredCollection; scripts: StoredScript[] },
  mode: UpdateMode,
): void {
  const nextScripts = next.scripts;
  const scanError = next.collection.scanError;
  if (scanError) {
    logCollectionEventToScripts(
      nextScripts, mode,
      // Same no-echo phrasing as the collections page's banner, since
      // `scanError` usually starts with its own `Could not read …`.
      `This collection did not load: ${scanError} — still running the cached copy`,
    );
    console.log(`[SourceMonkey] collection refresh: ${label}: scan failed: ${scanError}`);
    return;
  }
  if (prior?.collection.scanError) {
    logCollectionEventToScripts(nextScripts, mode, 'This collection is readable again');
  }
  const priorBy = prior?.scripts ?? new Map<string, StoredScript>();
  let changed = 0;
  let added = 0;
  let unchanged = 0;
  let errored = 0;
  let refreshFailed = 0;
  for (const n of nextScripts) {
    const prior = priorBy.get(n.id);
    emitScriptOutcomeLog(n.id, prior, n, mode);
    if (n.status === 'invalid') { errored++; continue; }
    // A still-running row whose latest refresh failed counts as its own
    // bucket, not "unchanged" — the content is unchanged but the outcome
    // wasn't a clean check.
    if (n.refreshError) { refreshFailed++; continue; }
    if (!prior) { added++; continue; }
    if (prior.loadedAt !== n.loadedAt) changed++;
    else unchanged++;
  }
  const parts: string[] = [`${nextScripts.length} script(s)`];
  if (added) parts.push(`${added} new`);
  if (changed) parts.push(`${changed} updated`);
  if (unchanged) parts.push(`${unchanged} unchanged`);
  if (refreshFailed) parts.push(`${refreshFailed} refresh-failed`);
  if (errored) parts.push(`${errored} error`);
  console.log(`[SourceMonkey] collection refresh: ${label}: ${parts.join(', ')}`);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Convenience: kick off opportunistic checks for a batch of script IDs
// without awaiting. Each id gates independently; ids whose check is
// rate-limited or already in flight are dropped silently. Used by the
// background SW when a navigation matches one or more scripts.
export function requestOpportunisticScriptChecks(scriptIds: string[]): void {
  for (const id of scriptIds) {
    // Swallow rejections — opportunistic work shouldn't ever surface a
    // user-visible error; the failure was already logged by the fetch.
    //
    // `'defer'`: navigation-triggered, so it doesn't wait for the parse
    // verdict — and this call and the reload fast path's coalesce onto
    // whichever of them reaches the gate first. See `updateScript`.
    updateScript(id, 'opportunistic', 'if-stale', 'defer').catch(() => {});
  }
}

// Test/debug hook so tests can reset the rate-limiter without
// timing-mock gymnastics.
export function _resetUpdaterStateForTests(): void {
  scriptState.clear();
  collectionState.clear();
  allCollectionsState.clear();
}
