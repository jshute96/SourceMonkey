# Userscript examples

Interactive examples for SourceMonkey's `GM_*` APIs, other granted
APIs, and metadata headers. Each example lives in its own subdirectory
and pairs:

- `<api>.html` — a mostly-empty page with a heading, an APIs list,
  optional details, and placeholder outputs. The userscript fills in
  the content.
- `<api>.user.js` — a real userscript with the metadata header,
  `@match`-ed at `*://*/<api>/<api>.html` (and a `file:///` variant)
  so it picks up the page regardless of how it's served.
- `<api>.spec.ts` — the Playwright e2e coverage for this example.
  Lives next to the page + userscript so per-API work stays in one
  dir; Playwright is configured to discover it (see
  `playwright.config.ts`).

All three files share the directory's stem (e.g.
`gm-info/gm-info.html` + `gm-info/gm-info.user.js` +
`gm-info/gm-info.spec.ts`).

### Sibling: `../bad-examples/`

Deliberately-broken userscripts (zero-byte, unterminated marker,
malformed tag line, etc.) live in `tests/bad-examples/`, **outside**
this directory on purpose:

- The TM cross-manager sync walks `tests/examples/` only, so the
  malformed files stay invisible to TM (which would refuse most of
  them anyway).
- Add `tests/bad-examples/` as its own SourceMonkey collection if you
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
and negative-case pages (`xmlhttp-denied/`) follow a small variant
of the layout above:

- Still **one** `<dir>.html` and **one** `<dir>.spec.ts`.
- **Multiple** sibling `*.user.js` files, one per variant being
  demonstrated. All variants `@match` the same page.
- Each variant writes its own outcome into a shared
  `<ul id="log">` on the page, typically tagged with a
  `data-script="<variant>"` attribute the spec can target.
- Variant files are named by what they vary (`start.user.js`,
  `end.user.js`, `no-connect.user.js`, …), not by the directory
  stem.

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
open `tests/examples/gm-info/gm-info.html` (etc.) directly in the
browser. Every example userscript carries a
`@match file:///*/<api>/<api>.html` pattern so the script matches
the file:// URL without any server in the loop.

### Option B: serve over HTTP

To test against `http://`, run the bundled serve script from the
repo root:

```sh
# Serve tests/examples/ on http://127.0.0.1:8080 (default port).
node scripts/serve-examples.mjs

# Custom port:
node scripts/serve-examples.mjs --port 9000
```

Then visit `http://127.0.0.1:8080/index.html` for the index, or jump
straight to e.g. `http://127.0.0.1:8080/gm-info/gm-info.html`. The
`@match *://*/<api>/<api>.html` pattern matches under any host and
port.

The serve script is a static-file server plus one special route:
`/__slow/<file>?ms=N` answers after N ms. `headers-run-at/` uses it
to demonstrate how `@run-at` variants relate to the page's lifecycle
events.

### Installing the userscripts

- **SourceMonkey** — open the collections page, add a directory collection
  pointing at `tests/examples/`. The scanner picks up every nested
  `*.user.js` and the `@match` patterns route each one to its own
  page.
- **Other managers** — install each `*.user.js` individually via the
  manager's "install from URL" or paste-into-editor flow.

## Examples

| Directory                  | API(s)                                                            | Shape         |
| -------------------------- | ----------------------------------------------------------------- | ------------- |
| `gm-info/`                 | `GM_info`                                                         | pure read     |
| `gm-log/`                  | `GM_log`                                                          | button-driven |
| `gm-storage/`              | `GM_setValue` / `GM_getValue` / `GM_deleteValue` / `GM_listValues` | form-driven   |
| `gm-value-listeners/`      | `GM_addValueChangeListener` / `GM_removeValueChangeListener`       | form-driven   |
| `gm-dom/`                  | `GM_addStyle` / `GM_addElement`                                   | button-driven |
| `gm-clipboard/`            | `GM_setClipboard`                                                 | form-driven   |
| `gm-xmlhttp/`              | `GM_xmlhttpRequest`                                               | form-driven   |
| `gm-open-in-tab/`          | `GM_openInTab`                                                    | form-driven   |
| `gm-notification/`         | `GM_notification`                                                 | button-driven |
| `gm-download/`             | `GM_download`                                                     | button-driven |
| `window-onurlchange/`      | `@grant window.onurlchange` (the `urlchange` event)               | page-wired    |
| `window-close-focus/`      | `@grant window.close` / `@grant window.focus`                     | button-driven |
| `headers-run-at/`          | `@run-at` (`document-start` / `-end` / `-idle` variants)           | multi-script  |
| `headers-inject-into/`     | `@inject-into` (`page` MAIN-world vs `content` USER_SCRIPT-world)  | multi-script  |
| `headers-match-hash/`      | `#hash` in `@match` / `@include` / `@exclude`, per manager        | multi-script  |
| `headers-include-regex/`   | Regex `@include` / `@exclude`: slashes, flags, case, per manager   | multi-script  |
| `require-scope/`           | `@require` scope in both worlds (SM-only: relative ref)            | multi-script  |
| `xmlhttp-denied/`          | `GM_xmlhttpRequest` + `@connect` denial vs allow                  | multi-script  |

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
2. Use both `@match *://*/<api>/<api>.html` and
   `@match file:///*/<api>/<api>.html` so the script matches under
   any local server port and any host, plus direct file:// opens.
3. Follow the *Page conventions* layout above. Header-demo dirs
   may use `<h2>Header</h2>` in place of `<h2>APIs</h2>` since
   they demonstrate a userscript header, not a `GM_*` API.
4. Link `examples.css` (`../examples.css` from a per-api dir) for
   consistent styling.
5. Add a row to the table above and a link in `index.html`.
6. In `<api>.spec.ts`, import the fixture from
   `../../fixtures/manager` and call
   `await setup.installScriptsFrom(__dirname)` — that registers the
   dir's userscripts with whichever manager the run is targeting.
   See the existing specs for the template.

An example may also carry **auxiliary files** the userscript pulls in
by relative ref — `gm-resource/` has `resource.css` / `resource.json` /
`logo.svg` for `@resource`, `require-scope/` has `lib.js` for
`@require`. Two things follow:

- The TM sync only walks `*.user.js`, so these files are never
  installed on their own. They're fetched by the manager when it
  resolves the ref.
- Relative refs don't survive the trip to TM: TM and GM take absolute
  URLs only, and TM installs these examples from a local file, so it
  has no base URL to resolve against. VM does resolve them — the
  harness installs into VM from the fixture server's URL — so a spec
  relying on one needs
  `test.skip(setup.manager === 'tampermonkey', ...)` with the reason
  stated, not a blanket non-SM skip. The `*.user.js` still syncs to TM
  harmlessly.

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
when the installed version is older than the file. Without a bump,
the cross-manager sync (`scripts/sync-manager-scripts.mjs`) classifies
your edit as `SKIP` and TM keeps running the stale copy. SourceMonkey
re-reads source files directly so it doesn't care, but the cross-
manager workflow does.

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
`pnpm exec playwright test tests/examples/gm-info/gm-info.spec.ts`.
