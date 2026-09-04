// The viewer's heading: the shared vocabulary for it, the DOM that
// paints its leading terms, and the early paint that puts a name in the
// header bar before the rest of the page arrives.
//
// Why this is its own module, loaded from `userscript.html` ahead of
// `userscript.js`:
//   - `userscript.js` is a large module graph that used to sit behind
//     blocking Prism scripts. The browser's first paint landed well
//     before any of it evaluated, so the header bar drew with an icon
//     and nothing else and filled in a beat later — the one thing on
//     the page that is supposed to say what the page IS.
//   - This module has NO static imports, which is the point: a module
//     does not evaluate until everything it imports has been fetched,
//     so even one small import would put its first line behind another
//     round trip and back after the first paint. Everything the early
//     paint needs beyond the prefix is pulled in with a dynamic
//     `import()`, after the prefix is already on screen.
//   - `userscript.ts` imports it as well. A module runs once, so the
//     early paint happens exactly once and the constants below have a
//     single home rather than a copy per entry point.
//
// `import type` is fine here — it is erased, so it costs no fetch.

import type { StoredScript } from './script-store.js';

// What every heading's leading terms are joined by — the same `|` the
// tab titles use (architecture.md, "Page names").
export const HEADING_SEPARATOR = ' | ';
// The product run, which every heading opens with and which the header
// bar paints in the brand colour.
const BRAND_PREFIX = `SourceMonkey${HEADING_SEPARATOR}`;
export const INSTALLED_HEADING = BRAND_PREFIX;
// The verb is a page name beside the product's, not a word governing
// the script's — so it takes its own separator rather than running
// straight into the favicon and the name.
export const PREVIEW_HEADING = `${BRAND_PREFIX}Install${HEADING_SEPARATOR}`;
// The installed title takes no prefix — a tab strip has little room,
// and the script's own name is what the reader is scanning for. The
// preview spends that room: "which of my tabs is asking to install
// something" is the question a preview tab has to answer.
export const INSTALLED_TITLE = '';
export const PREVIEW_TITLE = 'Install script: ';

// Stands in for the label when there is no script to name.
export const MISSING_LABEL = 'Not available';

// Same spelling as script-store's own (which is module-private), and as
// the copies in background.ts / injector.ts / script-log-id.ts. Reading
// one row is all this module does; importing the store to get the key
// would pull its whole graph in and undo the point of being early.
const SCRIPT_PREFIX = 'script:';

// The heading's leading run of product text. Shared with `showMissing`,
// which draws a heading with no script in it — the class, the constant
// and the ordering must not be written twice and drift.
//
// The product name and every separator wear `.brand` and take the
// header bar's colour (src/styles.css); the page names between them
// read in the heading's own. So the preview's heading is a brown
// "SourceMonkey | … | " skeleton with a dark "Install" set into it,
// which is the same shape the other pages' headings have — theirs just
// have no middle term.
export function headingPrefixEl(prefix: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  // A prefix always ends in a separator, so the last part is empty and
  // contributes nothing but its own `|`.
  const [product, ...rest] = prefix.split(HEADING_SEPARATOR);
  frag.appendChild(prefixSpan(product, true));
  for (const part of rest) {
    frag.appendChild(prefixSpan(HEADING_SEPARATOR, true));
    if (part) frag.appendChild(prefixSpan(part, false));
  }
  return frag;
}

function prefixSpan(text: string, brand: boolean): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = brand ? 'heading-prefix brand' : 'heading-prefix';
  el.textContent = text;
  return el;
}

// `<label> | SourceMonkey`, with the preview's own prefix in front so a
// tab strip full of viewer tabs says which is an install question and
// which is a script already installed.
export function setPageTitle(prefix: string, label: string): void {
  document.title = `${prefix}${label} | SourceMonkey`;
}

// The favicon's fixed-width slot, empty. `renderHeading` fills it with
// the real thing later; drawing it now is what keeps the name from
// shifting sideways when that lands.
function emptyIconSlot(): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'site-icon';
  return el;
}

// Whether the full page has drawn this heading yet. The early paint is
// a placeholder for exactly as long as that hasn't happened, and it must
// never land on top of the real thing — `userscript.ts` calls
// `notePainted` from every path that writes the heading, and its storage
// reads can finish either side of ours.
//
// A flag rather than an inspection of the heading's own contents: the
// markup's brand run and a finished heading are both just spans and
// text, so any test on the DOM comes down to matching bytes that the
// markup is free to change without failing anything.
let painted = false;

export function notePainted(): void {
  painted = true;
}

// ---------- The early paint ----------

// Everything above is also used by `userscript.ts`; the rest of this
// module is the side effect that makes loading it early worth doing.
//
// The prefix goes on synchronously, before any `await` or `import()`,
// because it is the half we can know without reading anything: which of
// the two pages this is. Only the script's name needs a storage read.
const headingEl = document.getElementById('filename');
const searchParams = new URLSearchParams(location.search);
const earlyScriptId = searchParams.get('script');
if (headingEl) {
  // The install page's own name for itself. The installed page's prefix
  // is already in the markup, but it is repainted here anyway so both
  // modes leave the heading in the same shape — prefix, then the
  // favicon's fixed-width slot, so the name doesn't shift sideways when
  // the real favicon lands.
  const prefix = earlyScriptId ? INSTALLED_HEADING : PREVIEW_HEADING;
  if (earlyScriptId || searchParams.get('preview')) {
    headingEl.replaceChildren(headingPrefixEl(prefix), emptyIconSlot());
  }
}

void paintEarlyName();

// The script's name, which needs the one `script:<id>` row plus the
// helpers that turn it into a label. A preview has no name to paint:
// its script's `@name` is inside a file that hasn't been fetched, and
// naming it from the URL would only move the flash — the location it
// would show is usually not what the finished heading says.
async function paintEarlyName(): Promise<void> {
  if (!headingEl || !earlyScriptId) return;
  const key = `${SCRIPT_PREFIX}${earlyScriptId}`;
  const [got, display] = await Promise.all([
    chrome.storage.local.get(key),
    import('./script-display.js'),
  ]);
  const script = got[key] as StoredScript | undefined;
  if (!script) return;
  // Bail if the full page beat us to it while we were reading.
  if (painted) return;
  const label = display.scriptLabel(script.header, script.relativePath);
  // The same slash-aware wrap `renderHeading` uses, so the finished
  // heading breaks its lines exactly where this one did.
  display.appendWithSlashBreaks(headingEl, label);
  setPageTitle(INSTALLED_TITLE, label);
}
