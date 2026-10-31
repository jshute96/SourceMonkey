// The collections page's suggestion box: collections and scripts a new
// user may want to install. While it's on, it lists every suggestion
// that isn't installed, so one added by an update shows up there too.
//
// - Closing the box turns it off (`SHOW_SUGGESTIONS_KEY`), and only the
//   Options page's "Show suggested scripts" checkbox turns it back on.
//
// See [docs/suggestions.md].

import { getValue, type ParsedHeader } from './userscript-header.js';

// `chrome.storage.local` key: whether the box shows, a boolean. Absent
// means on.
export const SHOW_SUGGESTIONS_KEY = 'smShowSuggestions';

export interface Suggestion {
  // Names the suggestion's row on the page.
  id: string;
  // Also the name a suggested collection is added under.
  title: string;
  description: string;
  // A collection is added in place; a script opens its install page.
  kind: 'collection' | 'script';
  // Where the title links to, for more about it.
  infoUrl: string;
  // What installing it adds or opens.
  location: string;
  // Collection paths that count as this collection being installed.
  collectionPaths?: readonly string[];
  // The script's `@namespace` and any of its `@name`s, so a copy
  // installed from any location counts.
  scriptIdentity?: { namespace: string; names: readonly string[] };
}

const PAGES = 'https://jshute96.github.io/SourceMonkey/tests';
const REPO = 'https://github.com/jshute96/SourceMonkey/tree/main/tests';

export const SUGGESTIONS: readonly Suggestion[] = [
  {
    id: 'sourcemonkey-examples',
    title: 'SourceMonkey example scripts',
    description: 'Demo pages, with scripts showing the GM_* APIs and header tags SourceMonkey supports.',
    kind: 'collection',
    // On github.com, which renders it; GitHub Pages serves it as plain text.
    infoUrl: 'https://github.com/jshute96/SourceMonkey/blob/main/tests/examples/README.md',
    // The GitHub Pages copy, not the GitHub folder: listing a folder
    // goes through GitHub's API, which rate-limits unauthenticated use.
    location: `${PAGES}/examples/script_manifest.json`,
    collectionPaths: [
      'https://github.com/jshute96/SourceMonkey/tree/main/tests/examples',
      `${PAGES}/examples/script_manifest.json`,
    ],
  },
  {
    id: 'greasyfork-test-status',
    title: 'Show SourceMonkey test status on Greasy Fork',
    description: 'On Greasy Fork script pages, for scripts that have been tested with SourceMonkey, show the test results.',
    kind: 'script',
    // No page of its own yet: the corpus folder, whose README describes it.
    infoUrl: `${REPO}/greasyfork-examples`,
    location: `${PAGES}/greasyfork-examples/show-on-GreasyFork.user.js`,
    // Its @name before 0.8.1 too, for copies installed then.
    scriptIdentity: {
      namespace: 'https://github.com/jshute96/SourceMonkey',
      names: ['Show SourceMonkey test status on Greasy Fork', 'SourceMonkey test status on Greasy Fork'],
    },
  },
];

// The suggestions the box lists: every one that isn't installed. An
// empty list means no box.
export function pendingSuggestions(
  collectionPaths: readonly string[],
  headers: readonly (ParsedHeader | null)[],
): Suggestion[] {
  const paths = new Set(collectionPaths);
  const hasScript = (id: { namespace: string; names: readonly string[] }): boolean => headers.some((h) => (
    h !== null
    && id.names.includes(getValue(h, 'name')?.trim() ?? '')
    && (getValue(h, 'namespace')?.trim() ?? '') === id.namespace
  ));
  return SUGGESTIONS.filter((s) => (
    !s.collectionPaths?.some((p) => paths.has(p))
    && !(s.scriptIdentity && hasScript(s.scriptIdentity))
  ));
}
