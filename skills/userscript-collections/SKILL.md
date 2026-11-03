---
name: userscript-collections
description: Keep a repo of userscripts organized as a collection: a directory per site, a script_manifest.json that SourceMonkey loads, generated README tables with site icons, and a doc file per script with a user-facing Summary and screenshots. Not every repo uses this layout; use the skill only in one that does (or asks to adopt it), when adding, renaming, removing or documenting a script, or regenerating the README.
---

# Userscript collections

A *collection* is a repo of userscripts laid out so that SourceMonkey
(the userscript manager) can load all of it, and so that a person
browsing it on GitHub finds every script with a description and a doc.
This skill covers that layout and the tools that keep it current.

It's optional. A repo with its own arrangement doesn't need any of
it; the `SourceMonkey-userscripts` skill covers writing the scripts
themselves either way. The repo's own instructions (`CLAUDE.md`,
`AGENTS.md`) win where they differ, and say which categories it uses.

## Layout

```
script_manifest.json        # the list of scripts; see below
README.md                   # with generated tables
site-icons/                 # generated
lib/                        # shared @require helpers, if any
  shared-helper.js
  shared-helper.md
sites/
  example.com/
    fix-the-thing.user.js
    fix-the-thing.md        # the script's doc
    fix-the-thing.spec.js   # its Playwright spec, if any
    screenshots/
      fix-the-thing-before.png
```

* Put scripts for the domain `example.com` in `sites/example.com/`.
  Name the file for its main purpose.
* Every script and library has a sibling `.md` doc with the same
  basename. See [references/script-docs.md](references/script-docs.md).

## When a script is added, renamed or removed

1. **The manifest:** add, change or remove its entry in
   `script_manifest.json`, in site order. Only set a `category` if the
   person asks for one. `sm-dev manifest --dir . <script>` adds a new
   entry in place; `sm-dev manifest --dir . sites --prune` adds all new
   ones and drops deleted ones.
2. **Its doc:** write or update the sibling `.md`, with `@name`,
   `@description` and the doc's Summary written as a set. See
   [references/script-docs.md](references/script-docs.md).
3. **Icons:** for a new script, or a changed `@icon` or `@match`, run
   `update_site_icons.py <script>`.
4. **README:** run `update_readme.py`. It also rewrites the doc's `#`
   title line.
5. **Installed copies:** in SourceMonkey, a new, renamed or removed
   script needs a refresh (see `install-in-SourceMonkey`).

A change to `@name` or `@description` also needs steps 2 and 4, and a
`@version` bump so installed copies pick it up.

Paths in these steps are relative to the collection root.

## The scripts

They're in this skill's `scripts/` directory:

| Script | Job |
| --- | --- |
| `update_readme.py` | Regenerate the README tables and each doc's `#` title line from the manifest. `--check` only reports. |
| `update_site_icons.py` | Save each script's icons into `site-icons/` and list them on its manifest entry. Starts an `sm-dev` run in a temp browser (see below). |

```bash
"${CLAUDE_SKILL_DIR}/scripts/update_readme.py"
"${CLAUDE_SKILL_DIR}/scripts/update_site_icons.py" sites/example.com/fix-the-thing.user.js
```

Both act on the git checkout holding the working directory (or the
directory itself, outside git), or on the collection `--root` names.

`update_site_icons.py` uses `sm-dev`, SourceMonkey's development tool
(see the `SourceMonkey-dev` skill), to load each script in a temp
browser: a fresh, logged-out browser profile it launches and closes.
That needs `pnpm sm-dev` working in the checkout it's run from. Some repos keep symlinks to them (for
example in their own `scripts/`), for running by hand.

## Multiple collections

A person may keep more than one collection with this layout, for
example a public one and a private one. Each has its own manifest,
README, `site-icons/` and docs, and SourceMonkey loads each as a
separate collection. Run the scripts with `--root <collection>` to
update one in another directory; `update_site_icons.py` then runs
`sm-dev` from the current checkout, so the other collection doesn't
need `sm-dev` of its own.

## Starting a collection

* Create `script_manifest.json` with
  `sm-dev manifest --dir . sites --create --format object`, which lists
  each script under `sites/`. Add a `"libraries": []` list beside
  `scripts` if there are libraries.
* In `README.md`, add a `<!-- update_readme.py category=default -->`
  line where the table should go, followed by a blank line, plus one
  per other category and a `<!-- update_readme.py libraries -->` line
  if there are libraries.
* Give each script a doc, then run `update_site_icons.py` and
  `update_readme.py`.
* Install the collection in SourceMonkey (see `install-in-SourceMonkey`).

## References

| Reference | Load when |
| --- | --- |
| [manifest-and-readme.md](references/manifest-and-readme.md) | Editing the manifest, adding a category, or a script's README row or icons look wrong |
| [script-docs.md](references/script-docs.md) | Writing or updating a script's doc, `@name` / `@description` and Summary |
| [screenshots.md](references/screenshots.md) | Adding screenshots to a doc |
