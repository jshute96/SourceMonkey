// Plain-text view of a fetched userscript. Opened in a new tab by the
// preview page's "View raw source" button; the text arrives through
// a `chrome.storage.session` row named in `?key=` (see raw-view.ts).
//
// The file is rendered with `textContent` into a `<pre>`, so nothing in
// it is ever parsed as markup — the whole point of this page existing
// rather than a `text/html` blob.

import { getRawView, isRawViewKey } from './raw-view.js';

const pre = document.getElementById('raw') as HTMLPreElement;
const titleEl = document.getElementById('raw-title') as HTMLSpanElement;

const params = new URLSearchParams(location.search);
const key = params.get('key') ?? '';

// Name the page NOW, from the URL — the row behind `?key=` is an async
// read, and a heading that waited for it would be visibly filled in
// after the page had already been drawn.
//
// The key check is the same one `getRawView` makes, so a URL this page
// will refuse to read content for doesn't get to name it either. It is
// a shape check, not proof the row exists: a hand-made `rawview:<junk>`
// still names the page and then says there is nothing to show. That
// costs nothing — the manifest declares no `web_accessible_resources`,
// so no web page can navigate here, and the name goes in through
// `textContent`.
if (!isRawViewKey(key) || !setName(params.get('name') ?? '')) {
  // No filename to be had from the URL. The heading would otherwise
  // stay blank for good, so it falls back to naming the page.
  fallbackName();
}

void hydrate();

// The tab and the header bar name the same file, wrapped differently:
// the tab strip gets the page-name shape (architecture.md, "Page
// names"), the bar gets the bare name — it already says SourceMonkey to
// the left of it.
// Returns whether there was a name to set, so the caller can fall back.
function setName(name: string): boolean {
  if (!name) return false;
  document.title = `${name} | SourceMonkey`;
  titleEl.textContent = name;
  return true;
}

// What the page is, when it can't say which file it is holding: a row
// written before the name travelled in the URL, or a key we won't read.
// The page name goes AFTER the product here, not before it like a
// filename does — it names the page, not a script (architecture.md,
// "Page names").
function fallbackName(): void {
  document.title = 'SourceMonkey | Raw source';
  titleEl.textContent = 'Raw source';
}

async function hydrate(): Promise<void> {
  const view = await getRawView(key);
  if (!view) {
    // The row is dropped when the preview page that wrote it goes
    // away, so a reload after closing the prompt lands here.
    pre.className = 'notice';
    pre.textContent = 'Nothing to show. Reopen this from the SourceMonkey script preview.';
    return;
  }
  // The row is authoritative; normally this is the name the URL already
  // supplied, so nothing on screen changes.
  if (!setName(view.name)) fallbackName();
  pre.textContent = view.text;
}
