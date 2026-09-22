# Userscript development harness: design

> **Status: proposal.** Nothing in this document is built yet. It
> describes what SourceMonkey would add so that a userscript repo (the
> author's `userscripts` repo first, a clonable template later) can
> develop, probe, and test scripts with SourceMonkey's real semantics.
> The user-facing side is in [harness-guide.md](harness-guide.md).

## The problem

- Most userscript testing is **interactive**: an agent (or a person)
  probes a site, injects the script as it exists so far, watches what
  happens over Playwright or the Chrome DevTools Protocol (CDP), edits,
  and tries again. Fast iteration matters more than a green suite.
- Today's harness in the `userscripts` repo strips the metadata block
  and runs the raw body in the page's own world. Nothing a manager does
  exists there: no `GM_*`, no `@match`, no `@run-at`, no isolation.
  A hand-written stub file fakes a few `GM_*` calls.
- Running the real extension is faithful but needs coordination: a
  collection registered in a profile, a refresh when headers change,
  other scripts in the same profile adding noise.
- SourceMonkey already contains nearly everything needed to inject a
  script with real manager semantics **without** the extension. This
  design packages that, and adds a way to push scripts into the real
  extension without persistent state for the cases that need Chrome
  itself.

## Vocabulary

Terms used below, for readers who don't work in this repo.

| Term | Meaning |
| --- | --- |
| `src/` | TypeScript source of the extension, plus three plain-JS files that are injected into web pages (`userscript-prelude.js`, `wrapper-gm-runtime.js`, `wrapper-bridge.js`). |
| `dist/` | The build output. It **is** the unpacked extension: `manifest.json`, the HTML pages, icons, the Prism highlighter, and one compiled ES module per `src/*.ts` file. There is no bundler, so any module that doesn't touch `chrome.*` is importable from Node as-is. Unit tests and the validate CLI already do this. |
| `dist/generated-wrappers.js` | The three injected JS files, minified to one line each and exported as string constants (`WRAPPER_PRELUDE`, `WRAPPER_GM_RUNTIME`, `WRAPPER_BRIDGE`). |
| `scripts/` | Node scripts run by hand or by package scripts: the build, the validate CLI, the examples server, the cross-manager sync tool. |
| `tests/fixtures/` | Playwright fixtures for this repo's own e2e suite: launching Chromium with the extension, the typed service-worker API, the example-page server. |
| `tests/examples/` | One directory per `GM_*` API or header feature, each with a page, a userscript, and a spec. Doubles as a compliance suite that also runs under Tampermonkey and Violentmonkey. |
| Service worker (SW) | The extension's background script (`background.ts`). Owns storage, registration with `chrome.userScripts`, and the SW half of every `GM_*` call. |
| Test surface | `self.SourceMonkey`, an object the SW exposes so tests can call production functions directly. Reachable only by evaluating code inside the worker (Playwright's `serviceWorker.evaluate`, or CDP). |
| Worlds | Chrome runs injected code either in the page's **MAIN** world (shares the page's globals) or an isolated **USER_SCRIPT** world (own globals, shared DOM). SourceMonkey picks per script from `@grant` and `@inject-into`. |
| Prelude | The per-script harness code injected ahead of the script: waits for the SW's go-ahead, enforces `@run-at`, runs the in-page URL matcher when needed, and attributes errors to the script. |
| GM runtime | `window.__SM_GM__`, one per document per world. The page-side half of every `GM_*` API. Per-script `const GM_x = ...` bindings delegate to it. |
| Bridge | When the runtime has no `chrome.runtime` (MAIN world), it talks through DOM events (`sourcemonkey-bridge-sync` out, `window.postMessage` replies back). In the extension a USER_SCRIPT-world relay forwards those to the SW. |
| CDP | Chrome DevTools Protocol. Playwright is built on it; it can also be driven directly over a WebSocket, which the `userscripts` repo already does when Playwright misbehaves. |

## What already exists

Nothing here needs writing; it needs packaging.

| Piece | Where | Chrome-free? |
| --- | --- | --- |
| Header split + parse | `src/userscript-header.ts` | Yes |
| Header validation, status, diagnostics | `validateHeader`, `buildScriptFromText` in `src/script-store.ts` | The functions are; the module also imports storage code |
| `@match` / `@include` / `@exclude` evaluator | `src/url-match.ts` | Yes |
| `@grant` catalog and resolution | `src/gm-api-catalog.ts` | Yes |
| `GM_*` binding emitter | `src/gm-bindings.ts` | Yes |
| `@require` / `@resource` resolution and fetch | `src/external-files.ts`, `src/file-loader.ts`, `src/local-file-overrides.ts` | Yes, given a `fetch` |
| Wrapper builder: world choice, `@run-at`, the ordered code entries Chrome registers | pure half of `src/injector.ts` (`buildRegistrationSpec` and friends) | Needs a small `chrome` stub for `getManifest` and storage; unit tests have one |
| Compile-only parse check | `src/harness/parse-check-node.ts` | Yes |
| Stored-value codec, `@connect` gating | `src/gm-values.ts`, `src/gm-connect.ts` | `gm-connect` yes; `gm-values` with a storage stub |
| Injected code as strings | `dist/generated-wrappers.js` | Yes |
| Whole install pipeline in Node | `scripts/validate-userscripts.mjs` | Yes; swaps `fetch` and the parse checker |
| Launch Chromium with the extension, Preferences seeding, typed SW API | `tests/fixtures/sourcemonkey-launch.ts`, `sw-api.ts`, `extension-id.ts` | n/a (Playwright) |
| Compliance pages and specs | `tests/examples/` | n/a |

Two facts make the no-extension path cheap:

- **The GM runtime picks its transport at init.** With no
  `chrome.runtime.id` it uses the bridge. A test host that answers
  bridge events is a complete stand-in for the SW; nothing on the page
  side changes. Unit tests already instantiate the runtime under Node.
- **`buildRegistrationSpec` returns the exact entries Chrome would
  register.** Feeding those into init scripts runs the prelude, the
  bindings, the `@require` bodies, and the script unchanged.

## Two backends

The harness offers the same operations over two backends. Both take
script **text or a file path**, never a collection.

### Push backend (no extension)

- The test process builds the entries in Node, injects them into a page
  as init scripts, and hosts a stand-in SW that answers the bridge.
- Works in any Chromium Playwright can reach, including the manually
  launched, CDP-attached browser the `userscripts` repo insists on
  (Playwright must not launch it, or Google refuses sign-in).
- Deterministic: the caller knows exactly what was injected and when.
  No storage, no debounce, no other scripts.
- This is the default for interactive work and for specs.

### Extension backend (real SourceMonkey)

- The browser runs the real extension. The harness talks to the SW test
  surface, over Playwright when it launched the browser, over CDP when
  it attached to one.
- New test-surface calls make scripts **ephemeral**:
  - `pushScript({ text, sourceUrl?, name? })` installs the text into a
    built-in **Pushed scripts** collection and returns the row's id,
    status, and diagnostics, after registration has completed (it calls
    the sync itself, so no `syncNow` dance). Re-pushing the same
    `sourceUrl` updates in place, so the next reload hot-swaps it via
    the existing reload fast-path.
  - `clearPushedScripts()` drops that collection's rows and their
    `GM_*` values.
  - `soloMode(on)` disables every other collection while on and
    restores the previous enabled set when off, so a pushed script runs
    alone without touching the user's real collections. `resetAllState()`
    already exists for a throwaway profile, where wiping everything is
    fine.
- The push transport reaches the SW from a command line by CDP:
  `Target.getTargets`, pick the `service_worker` target whose URL is
  the extension's `background.js`, `Target.attachToTarget`,
  `Runtime.evaluate`. An idle MV3 worker has no target; opening any
  extension page wakes it, so the tool does that first when needed.
- Use this backend for what only Chrome can answer: CSP, real world
  registration, Chrome's own match gating, cross-tab broadcast, and the
  real identity of a `GM_xmlhttpRequest` (extension cookies, no
  `Origin`, `Sec-Fetch-Site: none`).

## Components to build

### Package plumbing

- `package.json`: remove `private`; add `exports` (`./harness` for the
  harness entry, and `./*` mapping to `dist/*.js` so the pure modules
  such as `url-match` and `userscript-header` are importable too),
  `files: ["dist"]`, `bin: { "sm-dev": ... }`, a `prepare` script that
  runs the build so a git install produces `dist/`, and
  `@playwright/test` as an optional peer dependency used only by the
  harness entry. `tsconfig.json` emits declarations so a TypeScript
  consumer gets types.
- The package name is `sourcemonkey`. Consumers pin a git tag; npm
  publishing can come later without changing the import paths.

### `src/harness/`

Compiled to `dist/harness/` by the existing `tsc` run (`src/**/*.ts` is
already the include). Four modules, all Node-side except for the strings
they send into pages.

- **`prepare.ts`**: file or text in, an injectable script out.
  - Runs the real install pipeline: `buildScriptFromText`, then
    `applyFiles` for `@require` and `@resource` with a Node `fetch`
    plus SourceMonkey's local-override rules (so a `@require` pointing
    at a raw GitHub URL reads the local `lib/` copy, exactly as the
    extension would).
  - Emits bindings and calls `buildRegistrationSpec`.
  - Returns a `PreparedScript`: the stored row, the registration
    entries, world, `@run-at`, matching rules, startup logs, and the
    diagnostic when the script is invalid. An `invalid` script is
    returned with its diagnostics, not thrown, so a tool can print the
    same message the viewer shows.
  - The script's id is derived from its source URL, so re-preparing the
    same file keeps its id (and its GM values in the host) while two
    files sharing a basename stay distinct.
  - Calls are serialized: the local-roots setting the override
    resolver reads is process-wide.
  - `scripts/validate-userscripts.mjs` keeps its own driver (it has an
    offline dependency root the harness doesn't) and shares the Node
    parse checker, which moved to `src/harness/parse-check-node.ts`.
- **`host.ts`**: the stand-in SW.
  - Answers every message type the SW handles for injected code:
    `sm:check-pending` (with a values snapshot when the script needs
    one), `sm:start` / `sm:error` / `sm:abandoned` (recorded), batch
    writes and resync for storage, XHR start and abort, tab open and
    close, downloads, notifications, menu register and unregister, log,
    focus.
  - Pushes back what the SW pushes: value updates to every attached
    page (cross-tab broadcast within the context), XHR events, tab
    closed, menu fired, `urlchange` from Playwright's same-document
    navigation events.
  - Uses the real pieces where they exist: the value codec, the
    `@connect` gate. `GM_xmlhttpRequest` runs through Playwright's
    request API, which has no CORS limit; this is closer to the
    extension than page `fetch` but not the extension's cookie jar.
  - Exposes state to tests: seed and read values, the recorded tab
    opens, menu commands (and a way to fire one), notifications,
    requests, and the start / error reports.
- **`inject.ts`**: attaches a prepared script to a Playwright `Page`.
  - Installs a MAIN-world init script that listens for bridge events
    and forwards them to Node through `page.exposeBinding`, posting
    replies and pushes back. DOM events and `postMessage` cross worlds,
    so one transport serves both.
  - Adds the entries as init scripts in the script's world. MAIN goes
    through `page.addInitScript`. USER_SCRIPT goes through a CDP session
    and `Page.addScriptToEvaluateOnNewDocument` with a `worldName`,
    which Playwright's own init scripts cannot do. An isolated world has
    no `chrome.*`, so the runtime there uses the bridge too.
  - Always attaches the in-page matcher block to the prelude config, so
    the prelude decides per document exactly as Chrome's registration
    would. A miss reports `abandoned` instead of silently running, and
    the tool prints why.
  - Honors `@noframes` by having the injected config bail in subframes.
  - Survives reloads (init scripts persist), which is what makes the
    interactive loop one keystroke.
- **`fixture.ts`**: the `@playwright/test` extension consumers import.
  Wraps the three above into `loadUserscript`, `gm`, `reports`, and a
  `serveSnapshot` helper that routes a saved HTML file at its original
  URL so `@match` and relative URLs still hold. HAR replay is left to
  Playwright's own `routeFromHAR`.
- **`cli.ts`** (`sm-dev`): the interactive tool, built on the same
  modules and `playwright-core`'s `connectOverCDP`. Commands are listed
  in the guide. The `--extension` flag switches it to the extension
  backend.

### Service-worker additions

- `pushScript`, `clearPushedScripts`, `soloMode` on the test surface,
  as above. The Pushed scripts collection is a normal `scripts`
  collection with a flag, so the collections page and viewer show it
  like any other and the Log tab works unchanged.
- No new message transport into the extension. CDP attach to the worker
  is enough for a command-line tool, and Playwright-launched browsers
  already have `serviceWorker.evaluate`.

### Compliance check for the host

- Add a `harness` project to `playwright.config.ts` that runs
  `tests/examples/` through the push backend, beside the `sourcemonkey`,
  `tampermonkey`, and `violentmonkey` projects. Each example directory
  already exercises one API through the public surface.
- The stand-in SW is then measured against the real one by the same
  specs, and a divergence fails a test instead of surprising a script
  author. Cases that only Chrome can satisfy (real downloads,
  notification clicks) are skipped there as they are under VM.

## How the `userscripts` repo consumes it

Details are in the guide; the shape is:

- `pnpm add -D github:jshute96/SourceMonkey#<tag>`, with `sourcemonkey`
  allowlisted under `pnpm.onlyBuiltDependencies` so the `prepare` build
  runs. `link:../SourceMonkey2` while developing both.
- Its `test/fixtures.js` keeps the CDP connection logic (a repo policy,
  not a harness concern) and re-exports `test` / `expect` from
  `sourcemonkey/harness` instead of stripping headers itself. The
  `gm-stubs.js` file goes away.
- SourceMonkey is written as ES modules (ESM, `import` / `export`)
  while that repo's specs are CommonJS (`require()`), so its specs move
  to `.mjs` or the repo sets `"type": "module"`.
- Its `CLAUDE.md` and skills change to: run `sm-dev run` while
  iterating; write a spec on the harness fixture once the human
  confirms the script; use `--extension` for the request-identity and
  Chrome-only checks. No template repo for now.

## Sequencing

1. Package plumbing and `prepare.ts`, extracted from the validate CLI.
2. `host.ts` and `inject.ts`, proven by the `harness` project over
   `tests/examples/`.
3. `sm-dev` and `fixture.ts`, thin once the library works.
4. `pushScript` / `clearPushedScripts` / `soloMode` and the
   `--extension` backend.
5. Update the `userscripts` repo's fixtures, `CLAUDE.md`, and skills.

## Resolved questions

Checked before building, in throwaway scripts:

- **Isolated-world init scripts over CDP work beside Playwright.**
  `Page.addScriptToEvaluateOnNewDocument` with a `worldName` runs in
  its own world (separate globals, no `chrome`), fires again on reload,
  can be evaluated into from a CDP session by its context id, and a DOM
  event it dispatches is heard by a MAIN-world listener. Playwright's
  own `addInitScript` keeps working on the same page.
- **pnpm builds a git dependency's `prepare` script**, but only when
  the consumer allowlists it under `allowBuilds` in
  `pnpm-workspace.yaml`. The key is matched against
  `<name>@git+https://…#<sha>`, so a bare name does not match and the
  glob `sourcemonkey@git+https*` is the form to document. The build
  runs in pnpm's clone, with the package's dev dependencies installed
  there.

## Open questions

- Whether Playwright exposes the extension's service worker through
  `context.serviceWorkers()` on a `connectOverCDP` connection. If not,
  the extension backend uses raw CDP for the worker in both cases.
- How much of the SW's `urlchange` and `window.close` / `window.focus`
  behavior the host should emulate versus report as unsupported.
