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
  // The file's name, on its own — NOT a composed page title. The raw
  // page puts it in two places (the tab title and the header bar), and
  // each wraps it its own way; a value that already said
  // "… | SourceMonkey" came out saying it twice in the bar.
  name: string;
  text: string;
}

// True for keys shaped like one of ours. The raw page checks this
// before reading, so a hand-edited `?key=` can't be used to dump an
// arbitrary session-storage row into the page.
export function isRawViewKey(key: string): boolean {
  return key.startsWith(RAW_VIEW_PREFIX) && key.length > RAW_VIEW_PREFIX.length;
}

// Stash a view and return the extension URL that renders it.
//
// The name rides along in the URL as well as in the row. Reading the row
// is async, so a page that waited for it would paint its placeholder
// heading and tab title first and swap them a frame later — a visible
// flash on every raw tab. A query param is there synchronously, so the
// page can name itself before its first paint. The text can't travel
// this way (far too big); only the name.
export async function putRawView(view: RawView): Promise<string> {
  const key = `${RAW_VIEW_PREFIX}${crypto.randomUUID()}`;
  await chrome.storage.session.set({ [key]: view });
  const params = new URLSearchParams({ key, name: view.name });
  return `${chrome.runtime.getURL(RAW_VIEW_PAGE)}?${params}`;
}

// Read a stashed view. Returns null for a missing / malformed row —
// including the case where the writing page has already dropped it.
export async function getRawView(key: string): Promise<RawView | null> {
  if (!isRawViewKey(key)) return null;
  const got = await chrome.storage.session.get(key);
  const row = got[key] as Partial<RawView> | undefined;
  if (!row || typeof row.text !== 'string') return null;
  return { name: typeof row.name === 'string' ? row.name : '', text: row.text };
}

export async function dropRawView(key: string): Promise<void> {
  if (!isRawViewKey(key)) return;
  await chrome.storage.session.remove(key);
}
