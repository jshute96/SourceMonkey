// Shared shed-on-tab-close helper for the per-request maps in
// `gm-tab.ts` (GM_openInTab), `gm-notification.ts` (GM_notification),
// and `gm-download.ts` (GM_download).
//
// Each keeps an in-memory `Map<key, { originatorTabId, … }>` and, when
// a tab that originated requests is itself closed, drops every entry
// that points at it (the opened tabs / on-screen notifications /
// running downloads stay; we just have nowhere left to route their
// eventual events). The iterate → match `originatorTabId` → per-entry
// cleanup → delete → collect-key loop is identical; only the per-entry
// cleanup differs (a secondary index vs. timers). Factored here so the
// dispatchers can't drift.

export function dropEntriesForOriginator<K, V extends { originatorTabId: number }>(
  map: Map<K, V>,
  originatorTabId: number,
  cleanup: (entry: V) => void,
): K[] {
  const dropped: K[] = [];
  for (const [key, entry] of map) {
    if (entry.originatorTabId !== originatorTabId) continue;
    cleanup(entry);
    map.delete(key);
    dropped.push(key);
  }
  return dropped;
}
