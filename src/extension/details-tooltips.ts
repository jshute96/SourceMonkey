// Tooltip text for the details panel's row labels.
//
// Why the rows carry tooltips at all: the panel is a curated set, not a
// dump of the metadata block, so several rows report something the
// label alone can't convey — what we checked but deliberately didn't
// act on (`Version at update URL`), what a value is NOT (`Homepage` is
// an unverified claim), or where a name shows up outside this page
// (`Log ID`). The tooltip's job is to correct the likely misreading,
// not to restate the label.
//
// Wording rules, matching the rest of the UI:
//   - Capitalized, and no trailing period on a ONE-sentence tooltip.
//   - A two-sentence tooltip ends BOTH sentences with a period and puts
//     a newline between them, so the second reads as a separate remark
//     rather than a run-on. `title` renders `\n` as a line break.
//
// Kept in one table rather than beside each `appendRow` call so the
// whole set can be read — and copy-edited — as a unit.

// Row labels whose text is fixed. `Version` is absent on purpose: it
// depends on which mode is rendering (see `rowTooltip`), because a
// preview has nothing installed to describe.
const FIXED: Readonly<Record<string, string>> = {
  Name: "The script's @name",
  Description: "The script's @description",

  'Version at update URL': "The version published at the script's @updateURL",
  'Version at download URL': "The version published at the script's @downloadURL",

  Collection:
    'The collection this script was added from.\n'
    + 'Click through to manage it on the Collections page.',
  Location: 'Where this script file lives, and where a refresh re-reads it from',
  Homepage: "The script's @homepage",
  'Log ID':
    'How SourceMonkey labels this script in the Chrome console and in stack traces.\n'
    + 'The #E number distinguishes it from other scripts with the same filename.',

  Match: "Pages the script runs on, from its @match rules",
  Include: "Pages the script runs on, from its @include rules",
  Exclude: "Pages the script is blocked from, from its @exclude rules",
  // Spell out the "as you" part: the grant is closer to "may act as
  // you there" than to "may fetch a URL".
  'Network access':
    'Other sites the script may contact.\n'
    + 'Warning: The requests carry your cookies, so the script can act as you on these sites.',

  'Local overrides':
    '@require / @resource files being read from your disk '
    + 'instead of the URL the script declares',
  Size: 'Size of the script, plus any libraries or resources it loads',

  Status:
    'Status from loading and executing this script.\n'
    + 'Click to open the Log.',
};

// The `Version` row describes different things in the two modes: an
// installed script has a copy that is actually running, a preview is
// just a file making a claim. One string for both would have to be
// vague enough to be true of a file on disk, which throws away the more
// useful reading on the page people spend their time on.
const VERSION_INSTALLED = 'The @version of the script that is installed and running';
const VERSION_PREVIEW = "The script's @version";

// The hosting-site row's label is the site's own name — `Greasy Fork
// page`, `OpenUserJS page`, `GitHub Gist page` — so it can't be a key.
// Matched on the shape those labels share; `Homepage` is a separate
// entry above and doesn't end in ` page`.
const SITE_PAGE_SUFFIX = ' page';
const SITE_PAGE_TOOLTIP = "The hosting site's page where this script is published";

export type DetailsMode = 'installed' | 'preview';

export function rowTooltip(label: string, mode: DetailsMode): string | undefined {
  if (label === 'Version') {
    return mode === 'preview' ? VERSION_PREVIEW : VERSION_INSTALLED;
  }
  if (label.endsWith(SITE_PAGE_SUFFIX)) return SITE_PAGE_TOOLTIP;
  return FIXED[label];
}
