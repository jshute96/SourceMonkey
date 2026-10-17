// SW-side store for `GM_getTab` / `GM_saveTab` / `GM_getTabs`: one
// plain object per (tab, script), kept while the tab is open.
//
// Behavior, as observed in TM:
//   - `GM_getTab` gives this script's object for the sender's tab, `{}`
//     when it has saved nothing there. The call itself counts as
//     presence: the tab then shows in `GM_getTabs` with `{}`.
//   - `GM_saveTab(obj)` replaces the object with a shallow copy. A null
//     or undefined `obj` saves nothing.
//   - `GM_getTabs` gives this script's object for every tab that has
//     one, keyed by tab id.
//   - Frames share their tab's object; the key is the tab, not the
//     document.
//   - Closing the tab drops its objects (`dropTabData`, from
//     background.ts's `tabs.onRemoved`).
//
// Where it lives: in memory, mirrored to `chrome.storage.session` as one
// `gmtab:<tabId>` row per tab ({ [scriptId]: object }). The mirror is
// what keeps the data across the service worker being stopped while
// idle, which would otherwise lose it within a minute of quiet. Session
// storage also clears with the browser, the lifetime the API promises.
// The rows are first read on the first call after a worker start.
//
// Wire protocol (page → SW): `{ type: SM_TAB_DATA_MSG, scriptId,
// action: 'get' | 'save' | 'list', data? }` → `{ ok: true, value }` or
// `{ ok: false, error }`. Values cross as JSON, so they hold what JSON
// can.

export const SM_TAB_DATA_MSG = 'sm:gm-tab-data';

const KEY_PREFIX = 'gmtab:';

type TabObject = Record<string, unknown>;
type ByScript = Record<string, TabObject>;

let tabs: Map<number, ByScript> | null = null;
let loading: Promise<Map<number, ByScript>> | null = null;

function rowKey(tabId: number): string {
  return `${KEY_PREFIX}${tabId}`;
}

function load(): Promise<Map<number, ByScript>> {
  if (tabs) return Promise.resolve(tabs);
  if (!loading) {
    loading = (async () => {
      const all = await chrome.storage.session.get(null);
      const m = new Map<number, ByScript>();
      for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith(KEY_PREFIX)) continue;
        const tabId = Number(key.slice(KEY_PREFIX.length));
        if (!Number.isInteger(tabId) || !value || typeof value !== 'object') continue;
        m.set(tabId, value as ByScript);
      }
      tabs = m;
      return m;
    })().finally(() => { loading = null; });
  }
  return loading;
}

// Write one tab's row (or remove it once empty). On failure this
// script's entry is put back as it was, so memory and the row don't
// disagree; other scripts' entries, which may have changed since, stay.
async function persist(m: Map<number, ByScript>, tabId: number, scriptId: string, prev: TabObject | undefined): Promise<void> {
  const next = m.get(tabId);
  try {
    if (next && Object.keys(next).length > 0) {
      await chrome.storage.session.set({ [rowKey(tabId)]: next });
    } else {
      await chrome.storage.session.remove(rowKey(tabId));
    }
  } catch (err) {
    const { [scriptId]: _failed, ...rest } = m.get(tabId) ?? {};
    const restored: ByScript = prev ? { ...rest, [scriptId]: prev } : rest;
    if (Object.keys(restored).length > 0) m.set(tabId, restored);
    else m.delete(tabId);
    throw err;
  }
}

export async function getTabData(tabId: number, scriptId: string): Promise<TabObject> {
  const m = await load();
  const prev = m.get(tabId);
  const existing = prev?.[scriptId];
  if (existing) return existing;
  m.set(tabId, { ...prev, [scriptId]: {} });
  await persist(m, tabId, scriptId, undefined);
  return {};
}

export async function saveTabData(tabId: number, scriptId: string, data: unknown): Promise<void> {
  if (data == null) return;
  if (typeof data !== 'object') throw new Error('The tab object must be an object');
  const m = await load();
  const byScript = m.get(tabId);
  const prev = byScript?.[scriptId];
  m.set(tabId, { ...byScript, [scriptId]: { ...(data as TabObject) } });
  await persist(m, tabId, scriptId, prev);
}

export async function listTabData(scriptId: string): Promise<Record<string, TabObject>> {
  const m = await load();
  const out: Record<string, TabObject> = {};
  for (const [tabId, byScript] of m) {
    const obj = byScript[scriptId];
    if (obj) out[tabId] = obj;
  }
  return out;
}

// The tab closed. Waits out a first load already under way, which may
// have read the row before it goes.
export async function dropTabData(tabId: number): Promise<void> {
  const m = tabs ?? (loading ? await loading : null);
  m?.delete(tabId);
  await chrome.storage.session.remove(rowKey(tabId));
}

// For the test surface's `resetAllState`, which clears session storage:
// the memory copy came from it.
export function forgetTabDataForTests(): void {
  tabs = null;
}
