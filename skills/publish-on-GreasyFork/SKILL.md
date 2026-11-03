---
name: publish-on-GreasyFork
description: Publish or update userscripts on Greasy Fork from the command line. Import from GitHub, post a standalone copy, publish libraries, update descriptions and screenshots, and look up published script IDs, optionally recording them in the repo's script_manifest.json. Use only when the person asks to publish or update something on Greasy Fork.
---

Greasy Fork (<https://greasyfork.org>) is a userscript repository site.
This skill drives its forms from the command line: each command opens a
prefilled page in the person's browser, and they submit it themselves.

## Rules

* **Only run this when the person asks for it.** Publishing is
  outward-facing and hard to take back; never do it as a side effect of
  writing or fixing a script.
* **Never submit a form.** Every command here *opens a prefilled page*
  in the person's browser. They read it over and click Greasy Fork's
  own button. Ask them to say when they've submitted, then continue.
* **Never run a git command with side effects here**: no `push`, no
  `commit`, no `tag`. Read-only ones (`status`, `log`, `diff`,
  `rev-parse`) are fine, and are how you check whether a push is
  needed. If one is, say what's unpushed and ask the person to push;
  don't do it for them.
* **The script has to be on GitHub first** for anything that imports or
  syncs from a raw URL. Greasy Fork fetches the file from
  `raw.githubusercontent.com`, so an unpushed commit imports the *old*
  content (or 404s).

## Setup

### The scripts

They're in this skill's `scripts/` directory. Run any of them with
`--help` for the full flag list; only the typical commands are repeated
here. Some repos also keep symlinks to them (for example in their own
`scripts/`), for running by hand.

| Script | Job |
| --- | --- |
| `greasyfork-scripts.py` | Look up what's published; match it to local files; record IDs in the manifest; print the GitHub raw URL a local script file lands at. Read-only against Greasy Fork (a JSON API, no login). |
| `greasyfork-url.py` | Build and open a prefilled Greasy Fork form URL (`new`, `update`, `import`). |
| `extract-description.py` | Pull the publishable description and the screenshot list out of a script's `.md` doc. |

They work on the repo holding the working directory (its git root), so
run them from inside the repo whose scripts you're publishing. Script
paths given to `import`, `match`, `link` and `raw-url` are read relative
to that root, the way the manifest spells them. File options
(`--code-file`, `--extract-from-doc`, `--library` and the like) are
ordinary paths, read relative to the working directory, so the examples
below assume you're at the repo root.

### The prefill userscript

`greasyfork-url.py` puts the form values in the URL hash, for the
[prefill-forms-from-hash](https://github.com/jshute96/SourceMonkey/blob/main/userscripts/greasyfork/prefill-forms-from-hash.md)
userscript to read and type into the form. **It has to be installed and
enabled** in the browser the URL opens in. Install it from
<https://jshute96.github.io/SourceMonkey/userscripts/greasyfork/prefill-forms-from-hash.user.js>
(open it in the userscript manager's browser), or from a SourceMonkey
checkout's `userscripts/greasyfork/`. Its doc has the full parameter
table and the form selectors, if a field stops filling.

### The Greasy Fork user

`list`, `match` and `link` read one user's published scripts. They take
the user from `--user`, else the `GREASYFORK_USER` environment variable,
else the manifest's top-level `greasyfork.user` (see below). The value is
the `<id>-<slug>` from the user page's URL, like `1234567-jane-doe`.

## Recording IDs: with or without a manifest

**Use a manifest when the repo has a `script_manifest.json`** at its
root, or its instructions say to keep one. `link` then records each
published script's id and URL there, and `--code-file` reads it to
rewrite library `@require`s. Without one, everything except `link` and
that rewrite still works: `match` prints each script's id, for you to
record wherever the repo keeps such things (or nowhere; the id is also
in the script's Greasy Fork URL).

### The manifest's Greasy Fork fields

`script_manifest.json` is the list of scripts the SourceMonkey userscript
manager loads from a repo (the `userscript-collections` skill, if
installed, describes its other fields). SourceMonkey reads each entry's
`path` and ignores every other field, which is where the Greasy Fork
details go:

```json
{
  "greasyfork": { "user": "1234567-jane-doe" },
  "scripts": [
    { "path": "sites/example.com/unpublished.user.js" },
    {
      "path": "sites/example.com/published.user.js",
      "greasyfork": {
        "id": 590960,
        "url": "https://greasyfork.org/scripts/590960-example-published"
      }
    }
  ],
  "libraries": [
    {
      "path": "lib/shared-helper.js",
      "github_url": "https://raw.githubusercontent.com/me/userscripts/main/lib/shared-helper.js",
      "greasyfork": {
        "id": 592123,
        "url": "https://greasyfork.org/scripts/592123-shared-helper",
        "latest_version_url": "https://update.greasyfork.org/scripts/592123/1907419/shared-helper.js"
      }
    }
  ]
}
```

* **Top-level `greasyfork.user`:** the Greasy Fork user, as above.
* **A script's `greasyfork`:** its id and URL. A script without one
  hasn't been published. Don't add the field by hand; `link` writes it
  from what Greasy Fork reports, and a hand-typed id that's wrong is
  worse than a missing one.
* **`libraries`:** shared `@require` helpers (plain `.js` files, no
  metadata block) that are published on Greasy Fork as libraries.
  - `github_url` is the raw URL scripts `@require` the library by,
    written by hand.
  - `greasyfork.latest_version_url` is its Greasy Fork counterpart.
    Greasy Fork mints a new URL for every version posted, and a
    `@require` has to name one exact version, so this is the URL a
    posted script points at. It goes stale as soon as a new version is
    posted; `match` flags that, `link` refreshes it.

`link` changes only these fields, and keeps everything else in the file
as it was.

### How library IDs are found

Greasy Fork leaves libraries out of the user page's JSON, so `list`
won't show one. They *are* on the HTML user page, in a "Libraries"
section under the scripts, with each one's id in a `data-` attribute. So
`match` and `link` read the ids from there for any library that hasn't
got one recorded yet, pairing by name: a library is expected to be
published under its filename without `.js`. Only the id comes from that
page; what gets recorded still comes from the library's own JSON page,
`https://api.greasyfork.org/en/scripts/<id>.json`.

A library published under some other name won't pair, and takes the id
by hand once: `link --library-id <path> <id or URL>`.

## Actions

### Check what's published

```bash
"${CLAUDE_SKILL_DIR}/scripts/greasyfork-scripts.py" list     # id, version, name, URL
"${CLAUDE_SKILL_DIR}/scripts/greasyfork-scripts.py" match    # local file <-> published script
```

`match` pairs them by the id recorded in the manifest, falling back to
`@name`, the only field both sides carry verbatim. It marks with `*` any
script whose local `@version` differs from the posted one (that is,
there are changes that were never posted). It also lists local scripts
that were never published, and published scripts with no local match.
Without a manifest it checks every tracked `.user.js` in the repo, or
just the paths given (where a `.js` file that isn't a `.user.js` is
taken as a library, looked up by name).

With a manifest, it finishes with the libraries, marking with `*` any
whose stored URLs no longer match what Greasy Fork reports (almost
always a new version posted since the last `link`), or whose local file
has changes that were never posted.

Renaming a script's `@name` breaks the name match. With a manifest, run
`link` before a rename, so the recorded id keeps it straight.

### Publish by importing from GitHub (preferred)

The imported script keeps syncing from the raw URL, so later pushes
update it on Greasy Fork automatically, with no re-upload per version.
Multiple scripts can go in one import. Scripts that `@require` a GitHub
URL can't be imported; see [Scripts with library
`@require`s](#scripts-with-library-requires).

1. **Check the scripts are pushed**, read-only:

   ```bash
   git status --short <script>...          # uncommitted changes?
   git log --oneline origin/main..HEAD     # committed but unpushed? (use the --branch given to import)
   ```

   If either shows something, stop and ask the person to commit and
   push, naming the files, and continue once they say it's done. Greasy
   Fork fetches whatever is on GitHub at submit time, not what's on
   disk.

   `origin/main` is only as current as the last fetch, so treat a clean
   result as "probably fine", not proof. When it matters, ask rather
   than fetching.

2. **Open the import form**, prefilled:

   ```bash
   "${CLAUDE_SKILL_DIR}/scripts/greasyfork-url.py" import \
       sites/example.com/first.user.js \
       sites/example.com/second.user.js \
       --sync-type automatic
   ```

   Each path becomes the GitHub raw URL that serves it, built from the
   `origin` remote and the branch (`--branch`, default `main`). Nothing
   checks that the push landed; that's step 1.
   `greasyfork-scripts.py raw-url <path>` prints the same URL on its own.

3. **Wait for the person** to review the page, submit it, and say
   they're done.
4. **Record the IDs.** With a manifest, run `greasyfork-scripts.py link`:
   it re-reads the user page, finds the new IDs, and records them
   on the manifest entries. Confirm every script just imported now shows
   an ID; if one is missing, say so rather than carrying on. (`link`
   refuses to record an ID for a script that isn't listed in the
   manifest; add it there first.) Without a manifest, run `match` and
   report the new IDs.
5. **Set the descriptions.** The import form has no description field,
   so every script that just landed has a blank one. Run [Update the
   description and screenshots](#update-the-description-and-screenshots)
   once per script, with the ID from step 4. The import isn't finished
   until that's done.

   When importing multiple scripts at once, **open all their
   description forms in one go**, one `greasyfork-url.py update` call
   per script. They land in separate browser tabs, and the person can
   go through them all without a round trip for each.

### Publish a standalone copy

Use this when the script shouldn't sync from GitHub, or can't (see
below). The code is inlined into the URL, so nothing needs to be pushed,
but every future version has to be posted by hand.

```bash
"${CLAUDE_SKILL_DIR}/scripts/greasyfork-url.py" new \
    --code-file sites/example.com/my-script.user.js \
    --extract-from-doc sites/example.com/my-script.md
```

This form *does* have a description field, so `--extract-from-doc`
fills it here and there's no follow-up pass. Once the person has
submitted, record the ID as in step 4 of the import.

### Update the description and screenshots

Greasy Fork keeps the description on the version form, so this is the
"post a new version" page with the code left alone (a synced script
takes its code from GitHub regardless).

```bash
"${CLAUDE_SKILL_DIR}/scripts/greasyfork-url.py" update 590960 \
    --extract-from-doc sites/example.com/my-script.md
```

* Take the ID from the manifest entry, or from `match`.
* `--extract-from-doc` takes the description and images from the script's
  doc; see [Descriptions from a doc](#descriptions-from-a-doc). Without
  such a doc, pass `--info-file` (Markdown or HTML, by extension) or
  `--info-text`, and `--image-files`.
* To see what will be posted before opening the page, run
  `extract-description.py --no-images` / `--images` on the doc, or add
  `--print` to print the URL instead of launching a browser.
* Screenshots need nothing extra: the command above uploads them as
  they are. See [Images](#images) before reaching for a workaround.

### Post a new version by hand

Only for standalone (unsynced) scripts: a synced one picks up the new
code from GitHub on its own, once the person pushes. Bump `@version`
first.

**Send the description every time**, not just the code:

```bash
"${CLAUDE_SKILL_DIR}/scripts/greasyfork-url.py" update 590960 \
    --code-file sites/example.com/my-script.user.js \
    --extract-from-doc sites/example.com/my-script.md \
    --changelog-text "What changed in this version."
```

Greasy Fork keeps the description on the version form, so a run
without it silently leaves the old text posted, though the doc may have
changed.

### Scripts with library `@require`s

Greasy Fork only accepts a `@require` from Greasy Fork itself or an
allowlisted CDN. It rejects a `raw.githubusercontent.com` one, including
in the copy an import-from-GitHub would fetch, so **scripts that
`@require` a GitHub URL can't be imported, and don't get auto-update.**
Publish them as a standalone copy (or `update` for a new version) and
post each version by hand.

`--code-file` handles the URLs: before inlining the code it rewrites
every GitHub `@require` to the matching library's `latest_version_url`,
by its `github_url` in the manifest. It prints each rewrite, and stops
with an error if a GitHub `@require` has no library entry to map it to
(or there's no manifest). The fix is to publish the library and record
it (see below), not to post the file as it stands.

Nothing on disk changes: the checked-in scripts keep their GitHub
`@require`s, which a local install needs. `--no-rewrite-requires` posts
the file verbatim, unchecked.

**A `@require` with a relative path can't be published at all**: it
only resolves against a local install's directory. Publishing such a
script means inlining the helper into the posted copy.

#### The `@require` check

`import`, `--code-upload` and `--code-file` all refuse to build a URL
for a local script whose `@require` lines Greasy Fork wouldn't accept:
`import` and `--code-upload` on the file as it is, `--code-file` after
its rewrite. An import names files by URL and can't rewrite anything,
so for a script with a GitHub `@require` the check is the whole answer:
it will never be importable.

### Publishing a library

A library goes on the same two forms as a script: you pick the
`Library` script type, and the form then shows a Name and a Description
of its own, since a library file has no metadata block to read them
from. `--library` fills all of it from the file:

```bash
# First version.
"${CLAUDE_SKILL_DIR}/scripts/greasyfork-url.py" new --library lib/shared-helper.js

# A later version.
"${CLAUDE_SKILL_DIR}/scripts/greasyfork-url.py" update 592124 \
    --library lib/shared-helper.js \
    --changelog-text 'Fix the thing.'
```

What it derives:

| Field | From |
| --- | --- |
| Script type | `Library` |
| Name | the file's basename without `.js` (also the slug in its URL) |
| Description | the file's first `//` comment line |
| Additional info | the sibling `.md`, if there is one, via `--extract-from-doc` |
| Code | the file, `@require`-checked the way `--code-file` is |

Each is only a default: pass `--name`, `--description` or an explicit
info flag to override one. It prints what it derived, so check that
line before submitting.

There's **no import-from-GitHub for libraries**, so every version is
posted this way, and a library never auto-updates from the repo.

With a manifest, run `link` afterwards, whether it was a first publish
or a new version. It finds a first-time library's id on the user page
and records it with the URLs; for a new version it refreshes
`latest_version_url`. The library has to be in the manifest's
`libraries` list already, with its `github_url`; `link` won't add the
entry itself.

#### When a library has changed

A library edit reaches people only when a new *version* of the library
is posted and every script that needs it is re-posted pointing at that
new version URL. None of it is automatic.

`match` flags this: it compares the posted code with the local file and
marks a library whose local file has changes that were never published
(ignoring trailing-newline differences, which Greasy Fork introduces on
every library).

```
  * 592124  posted v0.0.1…  lib/shared-helper.js   [local file has
      unpublished changes; post a new library version]
```

Publish the library first, then `link` to record its new version URL,
and only then build the script's form. `--code-file` reads that URL
from the manifest, so a form built earlier pins the old version and the
script ships without the change.

Watch for it when one commit touches both a library and a script, which
is the usual shape, since the library changes *because* the new script
needs it.

Already-published scripts stay pinned to whatever version they were
posted with. They keep working, so re-post them only when they need the
change.

## Descriptions from a doc

`--extract-from-doc` (and `extract-description.py`) expect a Markdown doc
for the script with a `## Summary` section: the user-facing description.
Greasy Fork strips images out of a description and shows them in a
gallery below it, so the tool splits the two:

* `extract-description.py --no-images <doc>` gives the text to post:
  the Summary with its images, their labels, any `<table>` layout around
  them, and any heading left empty all removed.
* `extract-description.py --images <doc>` lists the image files to
  upload, in doc order, as full paths.

Stripping the images drops their labels, which leaves a gallery of
multiple images unlabeled. Such a doc names its gallery in a comment
line above its images, which is invisible in the doc and appended to the
`--no-images` text, where it lands right above the gallery:

```markdown
<!-- image-gallery-heading: **Search page before and after:** -->
```

A doc with a single image needs no comment: its one label already reads
as the gallery's heading. The tool warns about a multi-image doc without
one.

## Images

Image uploads can't be inlined into the URL; the browser has to fetch
the file. By default `greasyfork-url.py` passes a `file://` URL, and
that works under SourceMonkey. So just run the plain command and it
handles images.

### If images don't attach

A `file://` fetch may fail in userscript managers that run the request
from a service worker. If (and only if) the images come out missing,
serve the repo over HTTP and point at that instead:

```bash
python3 -m http.server 8765 --directory .      # from the repo root; leave running
"${CLAUDE_SKILL_DIR}/scripts/greasyfork-url.py" update 590960 --http-base http://localhost:8765 …
```

Local paths under the repo root (or `--http-root`) are then rewritten
to `http://localhost:8765/…`.

## After publishing

* With a manifest, run `link` again if anything new was posted. It edits
  the manifest; leave the change in the working tree and tell the
  person. Committing is their call.
* A published script's `@name` and `@description` are what people see
  in Greasy Fork search results. If either changed, the description
  update above is what carries it over.
