# GM API examples

Interactive examples for SourceMonkey's `GM_*` APIs. Each example lives
in its own subdirectory and pairs:

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

If you want to test against `http://` instead,
run a static server in `tests/examples/`:

```sh
# Serve tests/examples/ as the document root on http://localhost:8080.
cd tests/examples && npx http-server -p 8080 -c-1
```

Then visit `http://localhost:8080/index.html` for the index, or jump
straight to e.g. `http://localhost:8080/gm-info/gm-info.html`. The
`@match *://*/<api>/<api>.html` pattern matches under any host and
port.

### Installing the userscripts

- **SourceMonkey** — open the options page, add a directory source
  pointing at `tests/examples/`. The scanner picks up every nested
  `*.user.js` and the `@match` patterns route each one to its own
  page.
- **Other managers** — install each `*.user.js` individually via the
  manager's "install from URL" or paste-into-editor flow.

## Examples

| Directory          | API                                               | Shape         |
| ------------------ | ------------------------------------------------- | ------------- |
| `gm-info/`         | `GM_info`                                         | pure read     |
| `gm-notification/` | `GM_notification`                                 | button-driven |
| `gm-storage/`      | `GM_setValue` / `GM_getValue` / `GM_deleteValue` / `GM_listValues` | form-driven   |

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
3. Follow the *Page conventions* layout above.
4. Link `examples.css` (`../examples.css` from a per-api dir) for
   consistent styling.
5. Add a row to the table above and a link in `index.html`.
6. In `<api>.spec.ts`, import the fixture from
   `../../fixtures/extension` and use `__dirname` directly as the
   argument to `sm.addSource` — see the existing specs for the
   template.

## Testing

Each `<api>/<api>.spec.ts` is auto-discovered by Playwright
(`testMatch: examples/**/*.spec.ts` in `playwright.config.ts`). Run
all examples specs with:

```sh
npx playwright test examples
```

or run an individual one with its path, e.g.
`npx playwright test tests/examples/gm-info/gm-info.spec.ts`.
