# Suggestion Box

The collections page shows a "Suggested scripts" box of collections
and scripts to install, above the collections. It is how a new install
finds the example scripts: nothing is installed until the user asks.

The list is `SUGGESTIONS` in `src/suggestions.ts`. Each title
links to more about it (`infoUrl`):

- **SourceMonkey example scripts**: the `tests/examples` manifest on
  GitHub Pages. Add collection adds it in place, named after the
  suggestion, with no dialog.
  - Not the GitHub folder: listing one goes through GitHub's API, which
    rate-limits unauthenticated use.
- **Show SourceMonkey test status on Greasy Fork**: the corpus status
  script on GitHub Pages. Install opens its install page in a new tab.

## What shows

- **Installed suggestions are left out.**
  - A collection counts as installed when a collection has one of its
    `collectionPaths` (the GitHub folder, or the GitHub Pages manifest).
  - A script counts when any installed script has its `@namespace` and
    `@name` (or an earlier `@name`), from wherever it was installed.
- **No box when nothing is left.** When every suggestion is installed,
  or the box is off, the page shows no box.
- The box repaints with the page, so it updates as installs land, from
  this tab or another.
- A suggestion added by an update shows in the box like the others,
  while the box is on.

## Closing it

- The × button turns the box off: it stores `"smShowSuggestions": false`
  through the worker's `writeSetting`.
- The box stays off until the Options checkbox "Show suggested scripts",
  the same setting, turns it back on. Updates don't change it.

## First run

A new install opens the collections page once (see
[storage.md](storage.md#first-run)), so the box is what the user sees
first.

## sm-dev

Browsers sm-dev starts have the box off: `"smShowSuggestions": false`
is set with `firstRunComplete` when the profile is prepared
(`primeFirstRun` in `src/harness/extension-launch.ts`).
