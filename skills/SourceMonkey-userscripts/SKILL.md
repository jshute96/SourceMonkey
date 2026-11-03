---
name: SourceMonkey-userscripts
description: How to write, change and fix userscripts so they hold up on real sites. The workflow from a request to a working, installed script, triage when a script stops working, script conventions, and per-topic references on things sites do that break scripts (such as single-page navigation or React). Use when writing, changing, reviewing or debugging a userscript. Pairs with SourceMonkey-dev, which covers running and testing it.
---

# Writing userscripts

This skill covers writing a userscript, from the person's request to a
script that works in their browser, plus conventions and tips for
things sites do that break scripts.

## Related skills and instructions

- **The `SourceMonkey-dev` skill:** how to run, drive, inspect and test a
  script with `sm-dev` and the Playwright harness. Load it before
  running a script in a browser or writing a spec.
- **`install-in-SourceMonkey` and `install-in-Tampermonkey`:** installing
  a script in the person's own browser, and what it takes for an edit
  to reach it.
- **`userscript-collections`** (optional): a layout for a repo of
  scripts, with a manifest, a doc per script, and generated README
  tables. Use it only in a repo that follows that layout, or asks to
  adopt it.
- **`publish-on-GreasyFork`** (optional): publishing and updating
  scripts on Greasy Fork. Use it only when the person asks to publish
  there.
- **The `tampermonkey` plugin skill**, when installed, has general
  references on userscript syntax, in its own `references/` directory:
  `common-pitfalls.md`
  (skim before writing a script, and when one misbehaves), `patterns.md`
  (waiting for elements, debounced observers, keyboard shortcuts),
  `url-matching.md`, and on demand `header-reference.md`,
  `sandbox-modes.md` and `browser-compatibility.md`. Use them rather
  than working from memory.
- **The repo's own instructions win** (`CLAUDE.md`, `AGENTS.md`): where
  scripts live, how they're named, documented, listed and published.

Links to `references/...` below are relative to this skill's directory
(where this `SKILL.md` is).

## Writing a new script

1. **Reproduce the starting state.** Open the page with `sm-dev`, and
   check you can see and inspect the controls the person wants
   changed.
   - Use a temp browser (the default) when the page needs no login.
   - For a page that needs a login, or a site that blocks the temp
     browser, use `--open-browser`. If it isn't signed in to the site,
     **stop and ask the person to sign in** there. Don't automate a
     login.
   - A saved page (`--from-saved`) works when the live page is out of
     reach.
2. **Capture the DOM you'll depend on**, in every state the script
   touches, before writing anything: closed, each menu open, each
   submenu, hover and focus states. See [Before writing](#before-writing).
3. **Write the script**, following the repo's layout and the
   [header defaults](#header-defaults) below.
4. **Run it against the page**, following `SourceMonkey-dev`'s core
   loop: `validate`, `start --watch --detach`, drive and check it,
   `stop`. If you get stuck, stop and report exactly where. Don't
   guess.
5. **Install it** in the person's browser with `install-in-SourceMonkey`
   (or `install-in-Tampermonkey`), so they can try it.
6. **Optionally, write a spec**, if the person asks for one or the repo
   keeps specs for its scripts. Wait until the person confirms the
   script works in their own browser, so the spec encodes a known-good
   state.

## Changing a script

- The install skills describe how an edit reaches the person's browser
  in each manager. In SourceMonkey, a reload is enough for a local
  script's body. Header changes, especially `@match` / `@include` /
  `@exclude`, may need a refresh or reinstall.
- None of that applies while iterating with `sm-dev start`, which
  injects the file as it is on disk.
- Bump `@version` (the last number) for a change people should get
  from an update URL, such as a GitHub raw URL or a published copy.
  Bump it once, before the commit or push that publishes the change.
- Keep the script's doc in step, if it has one: selectors it relies on,
  and its user-facing description.

## When a script stops working

Sites change. Triage in this order:

1. **Look for the script's `init` log** in the page console (or the run's
   output).
   - Present: the header matched and the script ran. Go to step 2.
   - Absent: an install, header or grant problem. `sm-dev match <script>
     <url>` shows whether the header covers the URL and which rule
     decided. Otherwise check the manager's installed-scripts page, and
     whether the header changed since the install.
   - Absent under Tampermonkey only, with a matching header: the page may
     block page-world scripts. See
     [references/worlds-and-csp-sandbox.md](references/worlds-and-csp-sandbox.md).
2. **Find the first log line that should fire but doesn't.** The gap
   between the last log present and the next one missing is where it
   broke. With only `init`, the failure is in the very next step,
   usually the first selector lookup or observer callback.
3. **Probe each selector the script assumes**, in one call:
   `sm-dev probe '.FeedPage' '.FeedPage header' 'button[aria-label="Mark as read"]'`.
   The first one missing is the answer. If the script has a doc listing
   what it assumes stays stable, that list is the checklist.
4. **Look for a more resilient anchor** near the changed one (see
   [Selectors](#selectors)). Prefer something on the element itself
   over its wrapper (`header.Header` is harder to break than
   `.SomeWrapper header`). Update the doc's assumptions to match.

A retry loop whose lookup returns null looks just like "page still
loading". If the script has no "still waiting" log (see
[Logging](#logging)), add it first: it makes the next break diagnose
itself.

## Header defaults

- **`@noframes`** by default. Sites embed hidden iframes, and without it
  the script runs in those too, with init logs from contexts you didn't
  expect. Drop it only when the script needs to run in frames.
- **Leave `@grant` out unless the script uses `GM_*` APIs**, then list
  just those. Don't add `@grant none` by default; it changes which
  `window` the script sees. See
  [references/worlds-and-csp-sandbox.md](references/worlds-and-csp-sandbox.md).
- **`@inject-into content` for an open-ended set of sites** (`*://*/*`,
  broad `@include` regexes, a URL shape on any host), unless the script
  needs page globals. Scripts for one known site don't need it.
- **`@match` on a single-page app covers the whole site**, and the
  script gates on the path itself. See
  [references/spa-navigation.md](references/spa-navigation.md).
- `@name` and `@description`: see
  [references/naming-and-describing.md](references/naming-and-describing.md).

## Before writing

Snapshot every state the script will walk. Common surprises:

- Submenus may *replace* the main menu rather than stack beside it.
- ARIA roles vary within one site (`role="menuitemradio"` in one popup,
  bare `role="checkbox"` in its sibling).
- Capitalization of visible text varies across surfaces. Match
  case-insensitively.
- Attributes like `aria-controls` often exist only while the popup is
  open. Leave them out of selectors meant to find the closed trigger.
- An id may be reused or carry a per-instance suffix. Match with
  `[id^="prefix"]`.

## Selectors

Prefer the most semantic selector available, best first:

1. Stable ids and `data-*` attributes the site's authors put there.
2. Meaningful class-name **prefixes** (`ActivitySettingsMenu_menuContainer__*`)
   and `aria-label` / `title` strings: they describe purpose, not
   drawing.
3. Role or tag selectors with text content to tell them apart
   (`[role="menuitem"]` matching `/^export to tcx$/i`).
4. Visual identifiers: SVG `<path d="...">` geometry, pixel positions,
   icon sizes. Last resort.

When the element you want looks generic but an ancestor carries a
semantic class, walk *up* to that container and find the element
relative to it. A long minified `<path d>` in a selector means look up
the tree instead.

## Script conventions

### Logging

Log with `console.log` and a short `[name]` prefix (two words at most):

- when the script initializes;
- when it finds the element or activity it's looking for;
- when it makes a change;
- on any failure.

If a `MutationObserver` or poll loop is also the normal startup path
(every early tick "not found yet" is expected), log once after a few
seconds of continued failure. Otherwise a renamed selector looks
identical to a slow page.

### Setting an option: check first

When the script's job is to set an option to a target value, read the
current state first and skip the change when it already matches.
Toggling an option that's already set often has side effects (focus
jumps, requests, animations, dirty flags), and the check gives a useful
"already set" log. Pure actions (download, navigate, submit) have no
state to compare.

### Idempotent changes

Anything that can run more than once (on URL changes, observer
callbacks, a second copy of the script) checks whether its work is
already done:

- Inserters bail if `document.getElementById(MY_ID)` exists.
- Rewrites skip what's already rewritten.
- Injected styles check for their own `<style>`, found by a
  `data-<script-slug>` marker.

### Other rules

- **No personal data** in scripts, specs or docs: no account ids, user
  content or names other than the script's author.
- **Write scripts as they ship**: no test-only branches.
- Register global listeners once, at startup, and have them gate
  themselves (on the path, or on what was clicked), rather than adding
  them per page.

## Topic references

Load the one that matches what the site does:

| Reference | Load when |
| --- | --- |
| [spa-navigation.md](references/spa-navigation.md) | The site changes pages without reloading (most modern sites): `@match`, URL-change events, gating by path |
| [react-sites.md](references/react-sites.md) | The page is React-rendered: clicking React menus, reading fiber state, rearranging React lists |
| [generated-class-names.md](references/generated-class-names.md) | Class names carry build hashes (CSS modules, JSS, MUI), or a new button should match the site's styling |
| [worlds-and-csp-sandbox.md](references/worlds-and-csp-sandbox.md) | Page globals read `undefined`, choosing `@grant` / `@inject-into`, or a script doesn't run on raw-file or upload URLs |
| [manager-portability.md](references/manager-portability.md) | Making a script work in Tampermonkey and Violentmonkey too, or it works in one manager and not another |
| [scrolling.md](references/scrolling.md) | The script scrolls the page or reads scroll position: inner scroll containers, pages that grow mid-scroll, sticky headers |
| [css-overrides.md](references/css-overrides.md) | A CSS override doesn't take effect, or the element to restyle is hard to find |
| [shared-code-and-collaboration.md](references/shared-code-and-collaboration.md) | Sharing helpers through `@require`, scripts that cooperate on one page, or two installed copies fighting |
| [requests.md](references/requests.md) | The script fetches from another site, or a request works from the page but fails from the script |
| [image-viewer-pages.md](references/image-viewer-pages.md) | The script runs on direct image URLs (Chrome's standalone image viewer) |
| [config-settings.md](references/config-settings.md) | Making a value user-configurable, stored in GM storage and edited from the script's menu |
| [naming-and-describing.md](references/naming-and-describing.md) | Writing `@name` and `@description` |
