# Shared code, cooperating scripts, and duplicate installs

## Sharing helpers with `@require`

A helper is a plain `.js` file with no UserScript header, loaded with
`@require`. Each `@require` runs in the userscript's own sandbox, in
order, immediately before the body:

- Top-level `function`s and `const`s in the helper are visible to the
  script body.
- A later `@require` can call one loaded earlier.
- The helper's state is per script: two scripts requiring it get two
  separate copies.

Two ways to reference it:

- **A relative path** (`// @require installed-list.js`) for helpers
  shared by scripts in one directory. It resolves against the URL the
  script was installed from, so it works for a script installed from a
  local directory or a raw GitHub URL, but not for one pasted into a
  manager's editor, which has no URL. Repository sites such as Greasy Fork
  can't host it: a copy installed from there never loads its helper.
- **A full URL** (`// @require https://raw.githubusercontent.com/<user>/<repo>/main/lib/foo.js`)
  for helpers shared across sites. SourceMonkey reads a local copy in
  place of the URL for a local install (see "Local overrides for remote
  `@require`s" in `install-in-SourceMonkey`), so one line serves
  development and a copy installed from GitHub. Greasy Fork rejects
  GitHub `@require`s: a script published there has to name the library
  by a URL Greasy Fork allows (its own library hosting, or an
  allowlisted CDN).

`sm-dev` and the spec harness resolve `@require` the same way
SourceMonkey does, reading local copies, so there's nothing to stub.

## Scripts that cooperate on one page

Each script is sandboxed: two scripts on a page can't see each other's
variables, even ones from the same library. What they share is the
document.

- Have whoever loads first create a hidden host element, idempotently,
  with one child per script keyed by `GM_info.script.name`, carrying
  JSON metadata.
- Only serializable data crosses. Live closures (predicates, handlers)
  stay in their own sandbox, so design the feature to need only data
  from the other scripts.
- `GM_info` is available even under `@grant none`.
- **Hang the shared host off `document.documentElement`, not
  `document.body`.** Scripts register once at load and stay resident
  across in-app navigation. If the site replaces `<body>`, the host goes
  with it and nothing rebuilds it.
- Some pages remove extra children of `<html>` too (see
  [react-sites.md](react-sites.md)); re-create the host when it's
  removed, as
  [keyboard-shortcuts.js](https://github.com/jshute96/userscripts/blob/main/lib/keyboard-shortcuts.js) does
  for its registry.

## Two installed copies of one script

Two installed copies get two separate GM storages. That's easy to end
up with (two managers, or a manager copy plus a local-file pointer) and
normally invisible, since idempotent inserters just find the other
copy's elements.

- **It shows when the copies disagree about stored state** and each
  "corrects" the DOM: one adds a marker, the other's observer removes
  it, forever. If DOM changes flap in a steady alternating rhythm, count
  the `init` log lines before debugging the logic.
- **Guard scripts that write persistent state** by claiming the page at
  startup with a marker in the live document, which is all the
  sandboxes share: a `data-<script-slug>` attribute on `<html>`, or an
  element of your own on a site whose framework drops `<html>`
  attributes (see [react-sites.md](react-sites.md)). Later copies stand down
  *with an on-screen error*: which copy wins is load order, decided per
  tab, so state can still land in a storage the other tab isn't reading
  until one copy is uninstalled.
- The spec harness can test this: `loadUserscript(path, { copy: 'second' })`
  beside a plain `loadUserscript(path)` (see the `SourceMonkey-dev`
  skill's `references/specs.md`).
