// Shared shed-on-tab-close helper for the per-request maps in
// `gm-tab.ts` (GM_openInTab) and `gm-notification.ts` (GM_notification).
//
// Both keep an in-memory `Map<key, { originatorTabId, … }>` and, when a
// tab that originated requests is itself closed, drop every entry that
// points at it (the opened tabs / on-screen notifications stay; we just
// have nowhere left to route their eventual events). The iterate →
// match `originatorTabId` → per-entry cleanup → delete → collect-key
// loop is identical; only the per-entry cleanup differs (a secondary
// index vs. a timer). Factored here so the two dispatchers can't drift.

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
