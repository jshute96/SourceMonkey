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

### The API explorer (`lib/api-explorer.js`)

Examples converted to the explorer (`gm-download/`, `gm-storage/`)
drive their API through a shared UI rather than hand-rolled buttons. One declarative spec per API fills three sections
of the page:

- **Examples** — a preset button per canned call. Each runs the call
  *and* fills the form with the arguments it used, so the next call is
  a small edit of one that worked. Hovering shows the exact call and
  what to expect.
- **API Explorer** — a form generated from the argument list, with
  Submit and Clear.
- **Log** — every call, its arguments, its return value, and whatever
  its callbacks reported.

The Examples section comes first: worked calls are what a reader wants
before an empty form. A page can hold several explorer boxes side by
side (`gm-storage/` has one per storage API), in which case the preset
rows are grouped and labeled by signature, and each preset fills its
own box.

Conventions the library fixes for every example:

- **Empty means absent.** A blank field is an argument that isn't
  passed, not one passed empty — managers treat those differently.
  Type `""` in a JSON-ish field to send a real empty string.
- **The form doesn't police arguments.** A blank field marked
  `(required)` still submits; the API's own refusal is what the page
  is there to show. The only thing refused in the form is text that
  can't be turned into a value at all (unparseable JSON), since there
  is then no argument to pass.
- **Field kinds are named, not coded**: `string`, `text`, `number`,
  `bool`, `json`, `jsonOrString`, `select`.
- **The spec's `call` is the only place a `GM_*` API is touched**, so
  each userscript reads as the API it demonstrates and nothing else.
- **Stable ids** for specs to target: `#btn-<preset>`,
  `#submit-<box>`, `#clear-<box>`, `#field-<box>-<field>`.

The library is not itself a userscript. Example scripts pull it in
with `@require ./api-explorer.js`, resolved through a per-directory
**symlink** back to `lib/api-explorer.js`:

- SourceMonkey's relative require rule confines a `file://` script's
  ref to its own folder, so `../lib/…` would be refused.
- The symlink is a stopgap; a shared-library layout is planned.
- Relative `@require` is not portable to Tampermonkey, so **every
  explorer example skips under TM** — its spec must
  `test.skip(setup.manager === 'tampermonkey', …)`. SM and VM run it
  (VM resolves the ref against the install URL). Same rule as
  `require-scope/` and `gm-resource/`.
- Editing `lib/api-explorer.js` doesn't surface on the next
  navigation: opportunistic refresh reuses cached require bodies. Hit
  **Refresh** on the script in SourceMonkey (see
  [docs/requires.md](../../docs/requires.md#refresh-policy)).

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
  string and fragment; without it a reload at the pushed URL would no
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
| `gm-storage/`              | `GM_setValue` / `GM_getValue` / `GM_deleteValue` / `GM_listValues` | explorer (SM+VM) |
| `gm-value-listeners/`      | `GM_addValueChangeListener` / `GM_removeValueChangeListener`       | form-driven   |
| `gm-dom/`                  | `GM_addStyle` / `GM_addElement`                                   | button-driven |
| `gm-clipboard/`            | `GM_setClipboard`                                                 | form-driven   |
| `gm-xmlhttp/`              | `GM_xmlhttpRequest`                                               | form-driven   |
| `gm-open-in-tab/`          | `GM_openInTab`                                                    | form-driven   |
| `gm-notification/`         | `GM_notification`                                                 | button-driven |
| `gm-download/`             | `GM_download`                                                     | explorer (SM+VM) |
| `window-onurlchange/`      | `@grant window.onurlchange` (the `urlchange` event)               | page-wired    |
| `window-close-focus/`      | `@grant window.close` / `@grant window.focus`                     | button-driven |
| `headers-run-at/`          | `@run-at` (`document-start` / `-end` / `-idle` variants)           | multi-script  |
| `headers-inject-into/`     | `@inject-into` (`page` MAIN-world vs `content` USER_SCRIPT-world)  | multi-script  |
| `require-scope/`           | `@require` scope in both worlds, plus a relative ref TM can't use  | multi-script  |
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
- **Interactive area** — normally two sections the library fills:
  `<h2>Examples</h2>` + `<div id="examples">` for the preset buttons,
  then `<h2>API Explorer</h2>` + `<div id="explorer">` for the forms.
  A call shape the form can't express — `GM_download`'s two-argument
  shorthand, or its `abort()` — goes under an `<h3>Other call
  shapes</h3>` at the end of the Examples section. Examples that
  predate the explorer still hand-roll buttons; those are labeled with
  the API name they call (`GM_setValue`, not `setValue`), or with the
  call shape.
- **Output area** — a `<pre id="output">` or `<ul id="log">` the
  userscript writes into.
- **Footer** — `← all examples` link back to the index, plus a
  `userscript source` link to the paired `<api>.user.js` so a reader
  can jump straight to the script, plus an `explorer library` link
  when the page uses one.

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
5. To use the API explorer, symlink it into the dir
   (`ln -s ../lib/api-explorer.js <api>/api-explorer.js`), add
   `@require ./api-explorer.js`, and skip the spec under TM. Copy
   `gm-download/` for a single box, `gm-storage/` for several.
6. Add a row to the table above and a link in `index.html`.
7. In `<api>.spec.ts`, import the fixture from
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
