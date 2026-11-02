---
name: install-in-sourcemonkey
description: Interact with the SourceMonkey chrome extension for installing or editing userscripts.
---

## Target page

SourceMonkey's control page is at the URL below. Every command in this
skill is written against `$SM`, so set it first in the same shell:

```sh
SM=chrome-extension://cgeoigcimmclmhiamjicgccmojfdgkkd/collections.html
```

The host is the extension ID. It's the same for the Chrome Web Store
install and for unpacked builds, which set a fixed key. If it ever
changes, this one line is the only place to update.

The commands below open the page with `google-chrome`, the Linux
command. On macOS, use `open -a "Google Chrome" "<url>"`.

## Pushing a script for a quick try

Installing is for a script the person keeps. While iterating, run it
with `pnpm sm-dev start <script> --detach` instead (see the
`SourceMonkey-dev` skill): it pushes the file's text into a test
collection of the run's own, which only the run's tabs use and which
is removed when the run ends. Nothing on disk is scanned for it, so no
refresh command applies.

## Available actions

* `dashboard`: List existing scripts
  - Run `google-chrome "$SM"`

* `install`: Add a new script, pointing at an individual script's file.
  - Run `google-chrome "$SM?add=/path/file.user.js"`
  - Point the filename at the absolute path.
  - Update the manifest file if it exists (see below).

* `install-directory`: Add a directory source. SourceMonkey will add all scripts under that directory (up to two levels down).
  - Run `google-chrome "$SM?add=/path/directory"`
  - Point the filename at the absolute path.
  - Typically run once, for the directory holding the repo's scripts.
  - After adding or removing scripts under this directory, use the
    `refresh-file` command, naming the new/removed file or the directory
    itself, so SourceMonkey picks up the change.

* `refresh-file`: Re-scan only what covers one file or directory:
  **the default refresh.**
  - Run `google-chrome "$SM?refresh_file=/abs/path"`
  - The path is a file or a directory, as an absolute path.
  - It refreshes every local collection whose scanned directory overlaps
    the path, plus any individually-added local script pointing at it.
    Overlapping collections are re-scanned whole, which notices files
    added, renamed, or deleted.

* `refresh-local`: Re-scan every local collection, skipping the web ones.
  - Run `google-chrome "$SM?refresh_local"`
  - Use when the change spans several unrelated local directories and
    naming one path wouldn't cover it.

* `refresh`: Re-scan **everything**, including every http(s) and GitHub
  collection.
  - Run `google-chrome "$SM?refresh"`
  - Only when you actually want remote collections re-fetched.

All three open a browser tab, so don't fire them speculatively: one
refresh once the change is complete, not one per edit. **None is needed
after editing an existing script's body**; only when *which* scripts run
where has changed.

## Picking up edits to a script

SourceMonkey re-reads local script files on every page load, so for a
page the script *already* targets, the person just reloads the page. No
`refresh`, and nothing for us to do after an edit.

A refresh is needed only when the set of scripts, or where they run,
changes, and then `refresh-file` on the affected path is enough.

That covers local `@require` files too, including a local file
overriding a remote URL (see below): reloading the page re-reads them
as well. A `@require` actually fetched over http(s) is *not* re-checked
on reload, so editing what it points at needs a refresh.

## Local overrides for remote `@require`s

For library development, SourceMonkey **reads local files in place of
http references**. For a script run from a local file, if a file exists
under the script's own directory (or under the directory of the
collection it came from) whose path matches any suffix of the
requested `@require` host and path, that local file is read instead of 
fetching the URL. So a shared `lib/` at the top of a scripts directory is
reachable from a script nested anywhere inside it.

Extra directories can be added to the search path on SourceMonkey's
Options page.

The effect is that a script can keep its published `@require
https://…/lib/foo.js` line unchanged and still be developed against the
local `lib/foo.js`, with no path juggling between development and
publishing. Since the resolved file is local, edits to it are picked up
by a plain page reload.

## Manifest files (`script_manifest.json`)

* SourceMonkey uses `script_manifest.json` files as an alternative way to find and load userscripts.
* **Write it as an object with a `scripts` array, one entry per script,
  each with a `path` relative to the manifest's own location:**

  ```json
  {
    "scripts": [
      { "path": "sub/one.user.js" },
      { "path": "sub/two.user.js", "greasyfork": { "id": 590960 } }
    ]
  }
  ```

  A bare array (just the `scripts` value, with no wrapper) also works,
  and is what older manifests look like.

  SourceMonkey ignores every field but `path`, so a repo can keep its
  own metadata on each entry (like `greasyfork` above, recording where
  a script is published).
* SourceMonkey also ignores keys beside `scripts`, so a repo can keep
  its own lists there (shared `@require` libraries, say).
* If `script_manifest.json` exists, update it after adding a new userscript,
  following its current format.
