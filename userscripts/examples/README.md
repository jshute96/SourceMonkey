# Userscript examples

Interactive examples for SourceMonkey's `GM_*` APIs, other granted
APIs, and metadata headers.

These examples also work as a compliance test suite: their specs run against
SourceMonkey, Tampermonkey and Violentmonkey. See the
[cross-manager test results](../../docs/cross-manager-test-results.md)
for what passes under each, and where the managers behave differently.

## Trying the examples

1. Add the example scripts to SourceMonkey: on the collections page,
   add `https://github.com/jshute96/SourceMonkey/tree/main/userscripts/examples`.
   - A new install of SourceMonkey adds this collection on its first
     run, so it may be there already.
   - In another manager, install the `*.user.js` files you want one by
     one, from their GitHub Pages URLs
     (`https://jshute96.github.io/SourceMonkey/userscripts/examples/<dir>/<file>.user.js`).
2. Open the [examples index page](https://jshute96.github.io/SourceMonkey/userscripts/examples/index.html)
   and pick an example. Each example's page runs its scripts and
   shows what they did.

Or try them in a fresh browser with `sm-dev`, under any manager, with
no checkout needed. The scripts come from the directory's
`script_manifest.json`:

```sh
# Run with SourceMonkey
npx sm-dev@latest start \
  https://jshute96.github.io/SourceMonkey/userscripts/examples/script_manifest.json \
  https://jshute96.github.io/SourceMonkey/userscripts/examples/index.html

# Run with Tampermonkey
npx sm-dev@latest --manager tm start \
  https://jshute96.github.io/SourceMonkey/userscripts/examples/script_manifest.json \
  https://jshute96.github.io/SourceMonkey/userscripts/examples/index.html
```

Two examples need parts github.io can't serve: the slow route in
`headers-run-at/`, and a second host for `frames/` (on github.io, its
Frame B is on the page's own origin). For those, serve the examples
locally ([Running locally](#running-locally)).

## How an example is built

Each example lives in its own subdirectory and pairs:

- `<api>.html` — a mostly-empty page with a heading, an APIs list,
  optional details, and placeholder outputs. The userscript fills in
  the content.
- `<api>.user.js` — a real userscript with the metadata header,
  `@match`-ed at `*://*/*<api>/<api>.html` (and a `file:///` variant)
  so it picks up the page regardless of how it's served.
  - Its first `@match` names the page's GitHub Pages URL, which a
    manager shows as the script's link and site. (A script that
    names its page with `@include` instead puts it in an `@include`.)
  - Its `@icon` is SourceMonkey's icon on GitHub Pages.
- `<api>.spec.ts` — the Playwright e2e coverage for this example.
  Lives next to the page + userscript so per-API work stays in one
  dir; Playwright is configured to discover it (see
  `playwright.config.ts`).

All three files share the directory's stem (e.g.
`gm-info/gm-info.html` + `gm-info/gm-info.user.js` +
`gm-info/gm-info.spec.ts`).

### Sibling: `../bad-examples/`

Deliberately-broken userscripts (zero-byte, unterminated marker,
malformed tag line, etc.) live in `userscripts/bad-examples/`, **outside**
this directory on purpose:

- The TM cross-manager sync walks `userscripts/examples/` only, so the
  malformed files stay invisible to TM (which would refuse most of
  them anyway).
- Add `userscripts/bad-examples/` as its own SourceMonkey collection if you
  want to toggle the whole bad-script corpus on or off without
  touching the good examples.

`tests/e2e/bad-scripts.spec.ts` covers them end-to-end (expected
status per file + byte-for-byte viewer round-trip).

### Page-wired directories

`window-onurlchange/` inverts the usual split: the page wires its own
buttons in an inline `<script>` and the userscript only observes.

- That's the whole point of the API under test — `urlchange` reports
  navigations the **page** performs, which an isolated-world script
  cannot cause or intercept on its own.
- Its `@match` patterns carry a trailing `*`
  (`.../window-onurlchange.html*`) because the demo changes the query
  string; without it a reload at the pushed URL would no
  longer match.

### Multi-script directories

Header-variation pages (`headers-run-at/`, `headers-inject-into/`)
and the `@connect` page (`xmlhttp-connect/`) follow a small variant
of the layout above:

- Still **one** `<dir>.html` and **one** `<dir>.spec.ts`.
- **Multiple** sibling `*.user.js` files, one per variant being
  demonstrated. All variants `@match` the same page.
- Each variant writes its own outcome into a shared
  `<ul id="log">` on the page, typically tagged with a
  `data-script="<variant>"` attribute the spec can target.
- Variant files are named by what they vary (`start.user.js`,
  `end.user.js`, `connect-none.user.js`, …), not by the directory
  stem.
- Variants a manager can't install go in a subdirectory the spec
  installs separately, so it can skip them there:
  `require-scope/relative/` holds a script whose relative `@require`s
  TM can't take.

The aim is double-purpose:

- **Manual exploration** — open a page in a real browser with the
  matching userscript installed and click around to see what each API
  does and how it feels.
- **Cross-manager comparison / compliance** — install the same
  `*.user.js` files into Tampermonkey, Violentmonkey, etc., and
  compare observable behavior on the same pages. (Nothing here
  depends on SourceMonkey internals — the scripts only use the
  documented `GM_*` surface.)

## Running locally

### Option A: open with file:// URLs

If your userscript manager has `file://` access (in SourceMonkey
that's the per-extension "Allow access to file URLs" toggle), just
open `userscripts/examples/gm-info/gm-info.html` (etc.) directly in the
browser. Every example userscript carries a
`@match file:///*/<api>/<api>.html` pattern so the script matches
the file:// URL without any server in the loop.

### Option B: serve over HTTP

To test against `http://`, run the bundled serve script from the
repo root:

```sh
# Serve userscripts/examples/ on http://127.0.0.1:8080 (default port).
node scripts/serve-examples.mjs

# Custom port:
node scripts/serve-examples.mjs --port 9000
```

Then visit `http://127.0.0.1:8080/index.html` for the index, or jump
straight to e.g. `http://127.0.0.1:8080/gm-info/gm-info.html`. The
`@match *://*/*<api>/<api>.html` pattern matches under any host and
port, and at any depth under the server root (the leading `*` in the
path covers a prefix like `/SourceMonkey/userscripts/examples/`).

The serve script is a static-file server plus one special route:
`/__slow/<file>?ms=N` answers after N ms. `headers-run-at/` uses it
to demonstrate how `@run-at` variants relate to the page's lifecycle
events.

### Installing the userscripts

- **SourceMonkey** — open the collections page, add a directory collection
  pointing at `userscripts/examples/`. The scanner picks up every nested
  `*.user.js` and the `@match` patterns route each one to its own
  page.
- **Other managers** — install each `*.user.js` individually via the
  manager's "install from URL" or paste-into-editor flow.

## Scripts

All the example userscripts, by directory, generated from this directory's
`script_manifest.json` (see
[Updating the tables](../README.md#updating-the-tables)).

<!-- update_readme.py category=default -->
| Script | Description |
| --- | --- |
| [SourceMonkey example: frames: every frame](frames/every-frame.user.js) | Runs in the page and each of its frames, sharing a counter across them. |
| [SourceMonkey example: frames: Frame B only](frames/frame-b-only.user.js) | Matches only Frame B, so it runs on a page it doesn't match. |
| [SourceMonkey example: frames: top frame only](frames/top-only.user.js) | Matches the page and its frames, but @noframes keeps it to the top frame. |
| [SourceMonkey example: gm-clipboard: GM_setClipboard](gm-clipboard/gm-clipboard.user.js) | Copy a text value to the system clipboard. |
| [SourceMonkey example: gm-dom: GM_addStyle / GM_addElement](gm-dom/gm-dom.user.js) | Inject styles and elements into the page via DOM helpers. |
| [SourceMonkey example: gm-download: GM_download](gm-download/gm-download.user.js) | Click buttons to download files with various GM_download call shapes. |
| [SourceMonkey example: gm-info: GM_info](gm-info/gm-info.user.js) | Hand GM_info to the page, which renders it. |
| [SourceMonkey example: gm-log: GM_log](gm-log/gm-log.user.js) | Demonstrate GM_log against several arg shapes. |
| [SourceMonkey example: gm-menu: GM_registerMenuCommand](gm-menu/gm-menu.user.js) | Register and unregister entries in the toolbar action's right-click menu. |
| [SourceMonkey example: gm-notification: GM_notification](gm-notification/gm-notification.user.js) | Click buttons to fire various GM_notification call shapes. |
| [SourceMonkey example: gm-open-in-tab: GM_openInTab](gm-open-in-tab/gm-open-in-tab.user.js) | Open new tabs via every GM_openInTab call shape. |
| [SourceMonkey example: gm-resource: GM_getResourceText / GM_getResourceURL](gm-resource/gm-resource.user.js) | Read prefetched @resource files as text and as URLs. |
| [SourceMonkey example: gm-return-values: GM_ vs GM. return values](gm-return-values/gm-return-values.user.js) | Call the GM_ and GM. forms of some APIs and show what each returns. |
| [SourceMonkey example: gm-storage: GM storage](gm-storage/gm-storage.user.js) | Set/get/delete/list per-script GM storage values via a form, one key or many at once. |
| [SourceMonkey example: gm-tab: GM_getTab / GM_saveTab / GM_getTabs](gm-tab/gm-tab.user.js) | Count this page's loads per tab and list every tab's object with the per-tab APIs. |
| [SourceMonkey example: gm-value-listeners: GM value-change listeners](gm-value-listeners/gm-value-listeners.user.js) | Register/remove GM_addValueChangeListener callbacks. |
| [SourceMonkey example: gm-xmlhttp: GM_xmlhttpRequest](gm-xmlhttp/gm-xmlhttp.user.js) | Issue cross-origin HTTP requests via GM_xmlhttpRequest. |
| [SourceMonkey example: headers-include-regex: /i flag](headers-include-regex/regex-flag-i.user.js) | A regex @include with an i flag after it. This doesn't match. |
| [SourceMonkey example: headers-include-regex: @exclude with /i flag](headers-include-regex/exclude-flag-i.user.js) | @match names this page, and so does an @exclude regex with an i flag after it. This matches. |
| [SourceMonkey example: headers-include-regex: escaped slashes](headers-include-regex/regex-escaped.user.js) | A regex @include with escaped slashes (\/). This matches. |
| [SourceMonkey example: headers-include-regex: unescaped slashes](headers-include-regex/regex-slashes.user.js) | A regex @include with unescaped slashes inside it. This matches. |
| [SourceMonkey example: headers-include-regex: uppercase glob](headers-include-regex/glob-case.user.js) | An uppercase glob @include, on a lowercase URL. This matches. |
| [SourceMonkey example: headers-include-regex: uppercase regex](headers-include-regex/regex-case.user.js) | An uppercase regex @include, on a lowercase URL. This matches. |
| [SourceMonkey example: headers-inject-into: @inject-into content](headers-inject-into/content.user.js) | Runs in an isolated USER_SCRIPT world; can't see page globals. |
| [SourceMonkey example: headers-inject-into: @inject-into page](headers-inject-into/page.user.js) | Runs in the page's MAIN world; can see page globals. |
| [SourceMonkey example: headers-match-hash: @exclude of the hash](headers-match-hash/exclude-hash.user.js) | @match names the page, and @exclude *#part names it with #part. This matches except with #part.* |
| [SourceMonkey example: headers-match-hash: @include with the hash](headers-match-hash/include-hash.user.js) | @include names the page with #part. This matches with #part only.* |
| [SourceMonkey example: headers-match-hash: @include without the hash](headers-match-hash/include-exact.user.js) | @include names the page without a hash. This matches with no hash only.* |
| [SourceMonkey example: headers-match-hash: @match plus a regex @include](headers-match-hash/match-regex.user.js) | @match names the page without a hash, plus a regex @include that matches nothing. This matches, with any hash or none. |
| [SourceMonkey example: headers-match-hash: @match with the hash](headers-match-hash/match-hash.user.js) | @match names the page with #part. This doesn't match.* |
| [SourceMonkey example: headers-match-hash: @match without the hash](headers-match-hash/match-exact.user.js) | @match names the page without a hash. This matches, with any hash or none. |
| [SourceMonkey example: headers-run-at: @run-at document-end](headers-run-at/end.user.js) | Demonstrates @run-at document-end (after DOMContentLoaded). |
| [SourceMonkey example: headers-run-at: @run-at document-idle](headers-run-at/idle.user.js) | Demonstrates @run-at document-idle (default; once readyState is complete, just before load). |
| [SourceMonkey example: headers-run-at: @run-at document-start](headers-run-at/start.user.js) | Demonstrates @run-at document-start (runs before DOM parses). |
| [SourceMonkey example: require-scope: @require in the content (USER_SCRIPT) world](require-scope/content-world.user.js) | The same @require'd library reaches an isolated-world script, alongside its GM_* bindings. |
| [SourceMonkey example: require-scope: @require in the page (MAIN) world](require-scope/page-world.user.js) | A @require'd library's top-level class/const/function reach a MAIN-world script. |
| [SourceMonkey example: require-scope: relative @require paths](require-scope/relative/relative-require.user.js) | Loads two @require libraries by relative path, in order. |
| [SourceMonkey example: run-at-context-menu: @run-at context-menu](run-at-context-menu/run-at-context-menu.user.js) | Runs only when asked: each run adds a line to the page. |
| [SourceMonkey example: unsafe-window: unsafeWindow](unsafe-window/unsafe-window.user.js) | Reads and writes the page's real window through unsafeWindow, while still using GM storage. |
| [SourceMonkey example: unsafe-window: unsafeWindow outside the page](unsafe-window/isolated.user.js) | The other corner: @inject-into content keeps the script out of the page, so unsafeWindow is not the page's window. |
| [SourceMonkey example: unsafe-window: unsafeWindow with no grant](unsafe-window/ungranted.user.js) | Uses unsafeWindow without granting it, the way many real scripts do, and reports what the manager hands over. |
| [SourceMonkey example: use-strict: 'use strict' with a @require (own-after-lib)](use-strict/with-require/own-after-lib.user.js) | Reports whether the script runs in strict mode when it has a @require. |
| [SourceMonkey example: use-strict: 'use strict' with a @require (strict-lib)](use-strict/with-require/strict-lib.user.js) | Reports whether the script runs in strict mode when it has a @require. |
| [SourceMonkey example: use-strict: top-level 'use strict' in the content (USER_SCRIPT) world](use-strict/strict-content.user.js) | Reports whether a 'use strict' at the very top of the script puts it in strict mode. |
| [SourceMonkey example: use-strict: top-level 'use strict' in the page world](use-strict/strict-page.user.js) | Reports whether a 'use strict' at the very top of the script puts it in strict mode. |
| [SourceMonkey example: window-close-focus: window.close / window.focus](window-close-focus/window-close-focus.user.js) | Close the current tab and raise the browser window through the manager's window.* grants. |
| [SourceMonkey example: window-onurlchange: window.onurlchange](window-onurlchange/window-onurlchange.user.js) | Watch SPA navigations (pushState / replaceState / hash / back) through the urlchange event. |
| [SourceMonkey example: xmlhttp-connect: GM_xmlhttpRequest with @connect *](xmlhttp-connect/connect-any.user.js) | Declares @connect *, so requests to any site go without asking. |
| [SourceMonkey example: xmlhttp-connect: GM_xmlhttpRequest with @connect example.com](xmlhttp-connect/connect-example-com.user.js) | Declares @connect example.com, so requests there go without asking, and SourceMonkey asks before the others. |
| [SourceMonkey example: xmlhttp-connect: GM_xmlhttpRequest with no @connect lines](xmlhttp-connect/connect-none.user.js) | Declares no @connect lines, so SourceMonkey asks before each request to another site. |

## Page conventions

Each example page follows the same skeleton so they're easy to scan
side-by-side. From the top:

- **`<h1>` title** — `Userscript examples for <API name(s)>` (e.g.
  *"Userscript examples for GM storage APIs"* when several related
  APIs are bundled together).
- **`<h2>APIs`** — bullet list of the actual API names exercised by
  this example, each with a one-line description. Use the real
  identifier (`GM_setValue`, not "setValue") and include the
  signature where it adds clarity.
- **`<h2>Details`** — optional bullets covering anything
  page-specific: call-shape variants, browser quirks, scope rules.
  Skip the section if there's nothing to say.
- **Interactive area** — buttons / forms that trigger the APIs. Each
  button is labeled with the API name it calls
  (`GM_setValue`, not `setValue`), or with the call shape when one
  API has several variants on the page.
- **Output area** — a `<pre id="output">` or `<ul id="log">` the
  userscript writes into.
- **Footer** — `← all examples` link back to the index, plus a
  `userscript source` link to the paired `<api>.user.js` so a reader
  can jump straight to the script.

Hard rule for the `Details` and `APIs` sections: bullets, not
prose paragraphs. Mirrors the project-wide doc convention.

## Adding a new example

1. Create `<api>/<api>.html`, `<api>/<api>.user.js`, and
   `<api>/<api>.spec.ts`.
2. Use both `@match *://*/*<api>/<api>.html` and
   `@match file:///*/<api>/<api>.html` so the script matches under
   any local server port and any host, plus direct file:// opens.
   Put `@match https://jshute96.github.io/SourceMonkey/userscripts/examples/<api>/<api>.html`
   before them, so managers link to the published page. Add
   `@icon https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png`.
3. Follow the *Page conventions* layout above. Header-demo dirs
   may use `<h2>Header</h2>` in place of `<h2>APIs</h2>` since
   they demonstrate a userscript header, not a `GM_*` API.
4. Link `examples.css` (`../examples.css` from a per-api dir) for
   consistent styling.
5. Name each userscript `SourceMonkey example: <dir>: <what it shows>`,
   so a directory's scripts sort together in a manager's list.
6. Add a link in `index.html`.
   Update `script_manifest.json` here, which lists every example
   script: `pnpm sm-dev manifest userscripts/examples --prune` from the
   repo root. Do the same for `userscripts/bad-examples` when adding a
   script there. Then update `../script_manifest.json` and the README
   tables, as in [Updating the tables](../README.md#updating-the-tables).
7. In `<api>.spec.ts`, import the fixture from
   `../../fixtures/manager` and call
   `await setup.installScriptsFrom(__dirname)` — that registers the
   dir's userscripts with whichever manager the run is targeting.
   See the existing specs for the template.

An example may also carry **auxiliary files** the userscript pulls in
with `@require`, `@resource` or `@icon`: `gm-resource/` has
`resource.css` / `resource.json` / `logo.svg`, `require-scope/` has
`lib.js`. Refer to them by their GitHub Pages URL
(`https://jshute96.github.io/SourceMonkey/userscripts/examples/<dir>/<file>`),
not a relative path:

- TM takes absolute URLs only, and installs these examples from a
  local file, so it has nothing to resolve a relative path against.
- SourceMonkey loads the examples from this directory, so it reads the
  file beside the script instead of fetching the URL (a
  [local file override](../../docs/local-file-overrides.md)). The SM
  tests need no network.
- TM and VM fetch the URL, so they get the copy on `main` as GitHub
  Pages serves it. Push a change to an auxiliary file before running
  the TM or VM suites against it.
- The TM sync only walks `*.user.js`, so these files are never
  installed on their own.
- The exception is `require-scope/relative/`, whose script shows
  relative `@require` paths on purpose. It's a subdirectory so its
  test can install it on its own and skip it under TM.

For a **multi-script directory** (see above): replace step 1 with
a single `<dir>.html` + single `<dir>.spec.ts` + one
`<variant>.user.js` per variant. Every variant userscript should
share the same `@match` patterns, write its outcome into a shared
`<ul id="log">` with a `data-script="<variant>"` attribute, and
the spec targets each row through that attribute.

## Editing an existing example

When you change the body or metadata of an existing `*.user.js`,
**bump its `@version`**. Version-sensitive managers (Tampermonkey,
Violentmonkey, …) install by `@namespace`+`@name` and only update
when the installed version is older than the file. Without a bump, a
browser that already has the script installed keeps running the stale
copy. SourceMonkey re-reads source files directly so it doesn't care,
and the TM and VM test runs start from an empty manager, but a
person's own TM or VM does.

Pick the smallest bump that conveys the change (patch for tweaks,
minor for new behaviour). The values are not user-facing — they only
exist to gate updates.

## Testing

Each `<api>/<api>.spec.ts` is auto-discovered by Playwright
(`testMatch: examples/**/*.spec.ts` in `playwright.config.ts`). Run
all examples specs with:

```sh
pnpm exec playwright test examples
```

or run an individual one with its path, e.g.
`pnpm exec playwright test userscripts/examples/gm-info/gm-info.spec.ts`.
