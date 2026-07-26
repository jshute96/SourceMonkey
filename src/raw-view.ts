// Hand-off for the script preview's "View raw source" tab.
//
// The prompt has already fetched the script; the raw view just needs
// to show that text. It can't travel in the URL (scripts are far too
// big for a query param), so it goes through a `chrome.storage.session`
// row that the new tab reads by key.
//
// Why not a `blob:` URL — the obvious alternative:
//   - a `text/plain` blob has nowhere to put a document title, so the
//     tab is labelled with the opaque blob URL, and
//   - giving it a title means serving HTML, which would mean building
//     markup out of fetched script text on the extension's own origin.
//     A real page setting `textContent` has no such exposure.
//
// See [docs/install-capture.md].

export const RAW_VIEW_PREFIX = 'rawview:';

export const RAW_VIEW_PAGE = 'raw.html';

export interface RawView {
  title: string;
  text: string;
}

// True for keys shaped like one of ours. The raw page checks this
// before reading, so a hand-edited `?key=` can't be used to dump an
// arbitrary session-storage row into the page.
export function isRawViewKey(key: string): boolean {
  return key.startsWith(RAW_VIEW_PREFIX) && key.length > RAW_VIEW_PREFIX.length;
}

// Stash a view and return the extension URL that renders it.
export async function putRawView(view: RawView): Promise<string> {
  const key = `${RAW_VIEW_PREFIX}${crypto.randomUUID()}`;
  await chrome.storage.session.set({ [key]: view });
  return `${chrome.runtime.getURL(RAW_VIEW_PAGE)}?key=${encodeURIComponent(key)}`;
}

// Read a stashed view. Returns null for a missing / malformed row —
// including the case where the writing page has already dropped it.
export async function getRawView(key: string): Promise<RawView | null> {
  if (!isRawViewKey(key)) return null;
  const got = await chrome.storage.session.get(key);
  const row = got[key] as Partial<RawView> | undefined;
  if (!row || typeof row.text !== 'string') return null;
  return { title: typeof row.title === 'string' ? row.title : '', text: row.text };
}

export async function dropRawView(key: string): Promise<void> {
  if (!isRawViewKey(key)) return;
  await chrome.storage.session.remove(key);
}
