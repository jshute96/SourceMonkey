# Script docs, and describing a script

## Describing a script at three levels

Every script is described at three levels of increasing length, each
written for a reader who may never see the others. All three are
user-facing: they're what shows up in the userscript manager, in search
results, and on the script's page when it's published to a repository
site like [Greasy Fork](https://greasyfork.org/).

1. **`@name`**: follow the `SourceMonkey-userscripts` skill's
   `references/naming-and-describing.md`.
2. **`@description`**: the same reference.
3. **The doc's `Summary` section**: [below](#the-summary-section).

Write all three as a set, and keep them consistent: the doc's `#` title
must match the `@name` (after its icons), and the doc's `Summary`
should include more details on what's in the `@description`.

When any of them changes on an existing script, run `update_readme.py`
in the same edit (it rewrites the doc's title and the README row), and
bump the `@version`, so installed copies pick the new text up.

## The doc file

Each userscript has a sibling `.md` with the same basename
(`foo.user.js` and `foo.md`). Its first line is the `#` title: the
script's site icons followed by its `@name` (`update_readme.py` writes
it). It has three sections: `Summary`, `Visible changes`,
`Implementation`.

* **Summary**: the user-facing description. See
  [below](#the-summary-section).
* **Visible changes**: a short bulleted list of user-visible behavior
  changes. Brief: readers should be able to scan it. Group related
  points; don't over-explain.
* **Implementation**: the longer section, written for the future
  maintainer (likely whoever fixes the script after the site changes
  and it breaks). Cover:
  - What was observed about the page's DOM and behavior that the
    script depends on (selectors, attributes, structural anchors).
  - What it assumes will stay stable.
  - How it modifies the page to produce the visible changes.

  The point isn't exhaustive detail. It's enough context that someone
  can compare the doc to a future version of the site, see what's
  changed, and fix the script.

* Refer to the scripts as "userscripts", not "Tampermonkey scripts" or
  other branded names.

A library (a shared `@require` helper in the manifest's `libraries`
list) also has a sibling `.md`, in whatever shape suits it; it has no
title line for `update_readme.py` to rewrite.

## The Summary section

The `.md` file's first `##` section. This is what gets posted as the
script's description on repository sites, so write it for a stranger
who found the script in a search, not for the people who wrote it.

* Give a reader enough to decide whether they want the script: what the
  problem is (what was wrong, missing, or annoying before), and what the
  script adds or changes.
  - Don't explain all the exact details, exact wording of messages, and
    so on, or other details that become obvious as soon as someone uses
    the feature.
* Multiple paragraphs are fine, as are tables, lists, and links.
  Formatting is free, but keep it readable top to bottom.
* If the script needs usage instructions to be useful (key bindings, URL
  parameters, configuration options), put them here, under `###`
  subsections. Anything a *user* needs goes in `Summary`; anything only
  a *maintainer* needs goes in `Implementation`.
* Don't spell out consequences the reader can infer, and don't narrate
  what the screenshots already show.
* Don't explain trivially obvious motivations. For example, don't
  explain that popups are annoying and that's why the script closes
  them.
* Screenshots go at the **end** of `Summary`. See
  [screenshots.md](screenshots.md).
