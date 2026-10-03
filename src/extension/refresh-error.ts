// Per-collection record of a refresh that could not be SAVED.
//
// A distinct failure from `scanError`, and the distinction is the point:
//
//   - `scanError` (on the collection row) means we couldn't list the
//     collection. Nothing was fetched, every script row is left exactly
//     as it was, and the reason is written next to the collection it
//     belongs to.
//   - This map means the listing and every fetch SUCCEEDED and the
//     write at the end is what failed. The scripts on disk and the rows
//     in storage now disagree, and nothing in `chrome.storage.local`
//     records that — because the write to `chrome.storage.local` is
//     precisely what didn't work.
//
// The motivating case is an exhausted `chrome.storage.local` quota
// (10 MB, shared by the whole extension — see [docs/storage.md]). A
// collection large enough to blow the budget fails at the write on
// every refresh, and before this map the user got a Refresh button that
// went busy, came back, and said nothing at all.
//
// Why `chrome.storage.session`:
//   - It is a SEPARATE quota from `chrome.storage.local`, so it still
//     has room in the exact situation this exists to report. (A
//     rejected write also consumes nothing, so the budget the failed
//     refresh would have needed is still free either way — but not
//     sharing the failing bucket is what makes that reliable rather
//     than merely likely.)
//   - The lifetime is right. "Your last refresh didn't save" describes
//     this session's attempt, not a property of the collection. A new
//     browser session re-refreshes from scratch, and a stale banner
//     about a write that a later run may well have completed would be
//     worse than none.
//   - It outlives the service worker, which MV3 evicts freely.
//
// Shaped as one map key rather than a key per collection for the same
// reason as `injector-rejections` (`src/extension/script-rejection.ts`): the set
// is small, the readers want all of it, and a single key means one
// `storage.onChanged` event rather than a fan-out.

// Session-storage key holding the whole `RefreshErrorMap`.
export const REFRESH_ERRORS_KEY = 'refresh-errors';

// {collection id → why its last refresh could not be saved}.
export type RefreshErrorMap = Record<string, string>;

// The one sentence for a refresh that couldn't be saved, shared by the
// two surfaces that report the failure itself: the collection's section
// message on the collections page, and the Log row fanned out to every
// script under it (from either refresh entry point). One message per
// problem, so those can't drift.
//
// The page banner deliberately does NOT render this. It reports the
// aggregate — that some collection failed, and how full storage is —
// which is a different statement from what happened to one collection.
//
// Names the consequence rather than the mechanism: what matters to the
// reader is that the scripts they can see are not the scripts that are
// stored, and that retrying is the action.
export function describeRefreshError(reason: string): string {
  return `This collection was read but could not be saved, so its scripts are unchanged: ${reason}`;
}

// Coerce an unknown storage value into a RefreshErrorMap, dropping any
// entry whose reason isn't a string. Used for both the direct read and
// the `storage.onChanged` newValue, so the two paths can't disagree
// about what a well-formed record looks like.
export function coerceRefreshErrorMap(value: unknown): RefreshErrorMap {
  if (!value || typeof value !== 'object') return {};
  const out: RefreshErrorMap = {};
  for (const [id, message] of Object.entries(value as Record<string, unknown>)) {
    if (typeof message === 'string') out[id] = message;
  }
  return out;
}

// Every collection whose last refresh failed to save. Empty on a
// healthy profile, which is the overwhelmingly common case.
export async function readRefreshErrors(): Promise<RefreshErrorMap> {
  try {
    const got = await chrome.storage.session.get(REFRESH_ERRORS_KEY);
    return coerceRefreshErrorMap(got[REFRESH_ERRORS_KEY]);
  } catch {
    // Session storage being unavailable must not turn a reportable
    // failure into a thrown one — the caller is already handling an
    // error. Worst case the page doesn't show the banner.
    return {};
  }
}

// Record (or clear, with `reason: null`) one collection's write failure.
//
// Never throws. Every call site is already on a failure path or a
// success path that must not be derailed by bookkeeping, so a session
// write that fails leaves the map as it was and says so only to the
// console.
//
// Skips the write when nothing changes, so the overwhelmingly common
// case — a healthy refresh clearing an error that was never set — costs
// one read and no `storage.onChanged` fan-out to the open pages.
export async function setRefreshError(
  collectionId: string,
  reason: string | null,
): Promise<void> {
  try {
    const prior = await readRefreshErrors();
    if (reason === null && !(collectionId in prior)) return;
    if (reason !== null && prior[collectionId] === reason) return;
    const next = { ...prior };
    if (reason === null) delete next[collectionId];
    else next[collectionId] = reason;
    await chrome.storage.session.set({ [REFRESH_ERRORS_KEY]: next });
  } catch (err) {
    console.info('[SourceMonkey] could not record a refresh error', err);
  }
}

// Drop entries for collections that no longer exist, so a removed
// collection can't leave a banner counting a section that isn't on the
// page. Called after a removal rather than on a timer; `liveIds` is the
// authoritative set.
export async function pruneRefreshErrors(liveIds: Iterable<string>): Promise<void> {
  try {
    const prior = await readRefreshErrors();
    const live = new Set(liveIds);
    const next: RefreshErrorMap = {};
    for (const [id, reason] of Object.entries(prior)) {
      if (live.has(id)) next[id] = reason;
    }
    if (Object.keys(next).length === Object.keys(prior).length) return;
    await chrome.storage.session.set({ [REFRESH_ERRORS_KEY]: next });
  } catch (err) {
    console.info('[SourceMonkey] could not prune refresh errors', err);
  }
}
