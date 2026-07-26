// Plain-text view of a fetched userscript. Opened in a new tab by the
// preview page's "View raw source" button; the text arrives through
// a `chrome.storage.session` row named in `?key=` (see raw-view.ts).
//
// The file is rendered with `textContent` into a `<pre>`, so nothing in
// it is ever parsed as markup — the whole point of this page existing
// rather than a `text/html` blob.

import { getRawView } from './raw-view.js';

const pre = document.getElementById('raw') as HTMLPreElement;

void hydrate();

async function hydrate(): Promise<void> {
  const key = new URLSearchParams(location.search).get('key') ?? '';
  const view = await getRawView(key);
  if (!view) {
    // The row is dropped when the preview page that wrote it goes
    // away, so a reload after closing the prompt lands here.
    pre.className = 'notice';
    pre.textContent = 'Nothing to show — reopen this from the SourceMonkey script preview.';
    return;
  }
  if (view.title) document.title = view.title;
  pre.textContent = view.text;
}
