# Userscript development harness: design

The harness lets a userscript repo develop, probe, and test scripts
with SourceMonkey's real semantics.

- User-facing side: [harness-guide.md](harness-guide.md).
- The `sm-dev` command-line tool's internals:
  [sm-dev-design.md](sm-dev-design.md).

## The problem

- Most userscript testing is **interactive**: an agent (or a person)
  probes a site, injects the script as it exists so far, watches what
  happens, edits, and tries again. Fast iteration matters more than a
  green suite.
- A typical homemade harness strips the metadata block and runs the
  raw body in the page's own world.
  - Nothing a manager does exists there: no `GM_*`, no `@match`, no
    `@run-at`, no isolation.
  - A hand-written stub file fakes a few `GM_*` calls.
- Running the real extension is faithful but needs coordination: a
  collection registered in a profile, a refresh when headers change,
  other scripts in the same profile adding noise.
- SourceMonkey contains nearly everything needed to inject a script
  with real manager semantics **without** the extension.
  - The harness packages that.
  - It also adds a way to push scripts into the real extension, with
    no persistent state, for the cases that need Chrome itself.

## Terms

Harness-specific terms, and the browser plumbing it leans on. For the
extension's own pieces, see [architecture.md](architecture.md#components)
and [injection.md](injection.md).

| Term | Meaning |
| --- | --- |
| CDP | Chrome DevTools Protocol: the JSON-over-WebSocket protocol DevTools and Playwright use to drive Chrome. The harness uses it directly where Playwright has no API. |
| Init script | Code a CDP client registers (`Page.addScriptToEvaluateOnNewDocument`) to run at the start of every new document in a page, before the page's own scripts. |
| CDP binding | A function a CDP client installs in a page (`Runtime.addBinding`). Calling it sends a message to the client; the page can't see who's listening. |
| Worlds | Chrome runs injected code in the page's **MAIN** world (shares the page's globals) or an isolated **USER_SCRIPT** world (own globals, shared DOM). |
| Prelude, GM runtime | The extension's injected code: the prelude runs ahead of each script (`@run-at`, URL check, error attribution); the GM runtime (`window.__SM_GM__`) is the page half of the `GM_*` APIs. |
| Bridge | How the GM runtime talks to the SW from the MAIN world, which has no `chrome.runtime`: DOM events out, `postMessage` replies back. |
| Test surface | `self.SourceMonkey`, functions the SW exposes to code evaluated inside it (Playwright's `serviceWorker.evaluate`, or CDP). |
| Push backend | Running scripts without the extension: the test process injects them and answers their messages itself. |
| Extension backend | Running scripts in the real extension, pushed in as scratch scripts. |
| Host | `host.ts`: the stand-in for the service worker (SW) under the push backend. |
| Attachment | A `PageAttachment` (`inject.ts`): one Playwright page with scripts injected and wired to a host. |
| Run | A background `sm-dev` process that owns a browser connection and its tabs (see [sm-dev-design.md](sm-dev-design.md)). |

## Two backends

The harness offers the same operations over two backends. Both take
script **text or a file path**, never a collection.

### Push backend (no extension)

- The test process builds the registration entries in Node, injects
  them into a page as init scripts, and hosts a stand-in SW that
  answers the bridge.
- Works in any Chromium Playwright can reach.
  - That includes a manually launched, CDP-attached browser, which a
    repo needs for sites with a login: a browser Playwright launched
    is refused Google sign-in.
- Deterministic: the caller knows exactly what was injected and when.
  No storage, no debounce, no other scripts.
- This is the default for interactive work and for specs.

### Extension backend (real SourceMonkey)

- The browser runs the real extension. The harness talks to the SW's
  test surface (`self.SourceMonkey`).
- Use it for what only Chrome can answer:
  - CSP, real world registration, Chrome's own match gating.
  - Cross-tab broadcast between real tabs.
  - The real identity of a `GM_xmlhttpRequest`: extension cookies, no
    `Origin`, `Sec-Fetch-Site: none`.
- Details in [Extension backend](#extension-backend) below.

## Extension code the harness reuses

The harness writes little of its own semantics. It runs these pieces of
the extension under Node or in the page:

| Piece | Where | Chrome-free? |
| --- | --- | --- |
| Header split + parse | `src/userscript-header.ts` | Yes |
| Header validation, status, diagnostics | `validateHeader`, `buildScriptFromText` in `src/script-store.ts` | The functions are; the module also imports storage code |
| `@match` / `@include` / `@exclude` evaluator | `src/url-match.ts` | Yes |
| `@grant` catalog and resolution | `src/gm-api-catalog.ts` | Yes |
| `GM_*` binding emitter | `src/gm-bindings.ts` | Yes |
| `@require` / `@resource` resolution and fetch | `src/external-files.ts`, `src/file-loader.ts`, `src/local-file-overrides.ts` | Yes, given a `fetch` |
| Wrapper builder: world choice, `@run-at`, the ordered code entries Chrome registers | pure half of `src/injector.ts` (`buildRegistrationSpec` and friends) | Yes, as `src/harness/prepare.ts` calls it |
| Compile-only parse check | `src/harness/parse-check-node.ts` | Yes |
| Stored-value codec, `@connect` gating | `src/gm-values.ts`, `src/gm-connect.ts` | `gm-connect` yes; `gm-values` with a storage stub |
| `GM_xmlhttpRequest` driver | `runXhr` in `src/gm-xhr.ts` | Yes, on Node's `fetch` |
| Injected code as strings | `dist/generated-wrappers.js` | Yes |
| Compliance pages and specs | `tests/examples/` | n/a |

Two facts make the push backend cheap:

- **The GM runtime picks its transport at init.**
  - With a `chrome.runtime.id` it uses `chrome.runtime`; without one it
    uses the DOM-event bridge.
  - The host answers both, with a stand-in `chrome.runtime` in the
    isolated world, in place of the SW. Nothing on the page side
    changes.
- **`buildRegistrationSpec` returns the exact entries Chrome would
  register.** Injecting those as init scripts runs the prelude, the
  bindings, the `@require` bodies, and the script unchanged.

## Package and distribution

### The package

- The package is `sourcemonkey`, built by `tsconfig.lib.json` into
  `lib/` with declarations; `dist/` stays the extension alone. See
  [architecture.md](architecture.md#two-outputs-dist-and-lib).
- `package.json` carries:
  - `exports`: `./harness` for the harness entry, and `./*` mapping to
    `lib/*.js` so pure modules such as `url-match` and
    `userscript-header` are importable too.
  - `files: ["lib"]` and `bin: { "sm-dev": ... }`.
  - A `prepare` script that runs the build, so a git install produces
    `lib/`.
  - `@playwright/test` as an optional peer dependency, used only by the
    harness entry.
  - `private: true`. It only blocks `npm publish`; a git install works
    without publishing.
- Consumers pin a git tag. Publishing to npm later would not change the
  import paths.

### How a userscript repo uses it

Details are in the guide; the shape is:

- It installs `github:jshute96/SourceMonkey#<tag>` as a dev dependency.
  - `sourcemonkey` is allowlisted under `allowBuilds` in
    `pnpm-workspace.yaml`, so the `prepare` build runs.
  - While developing both, it uses `file:../SourceMonkey` with
    `dependenciesMeta.injected`.
- Its own fixture file keeps any browser-connection logic (a repo
  policy, not a harness concern) and re-exports `test` / `expect` from
  `sourcemonkey/harness`.
- Its specs are ES modules (`.mjs`, or `"type": "module"`), since
  SourceMonkey is written as ESM.
- Its agent instructions: run `sm-dev start` while iterating, write a
  spec on the harness fixture once the script is confirmed, and use
  `--extension` for the request-identity and Chrome-only checks.

## Push backend components

The core modules in `src/harness/`, compiled to `lib/harness/`. They
run in Node, except for the strings they send into pages.

### `prepare.ts`: script in, injectable script out

- Runs the real install pipeline:
  - `buildScriptFromText`, then `applyFiles` for `@require` and
    `@resource`.
  - Fetches with Node's `fetch`, plus SourceMonkey's local-override
    rules, so a `@require` pointing at a raw GitHub URL reads the local
    `lib/` copy, exactly as the extension would.
- Emits bindings and calls `buildRegistrationSpec`.
- Returns a `PreparedScript`: the stored row, the registration entries,
  world, `@run-at`, matching rules, startup logs, and the diagnostic
  when the script is invalid.
  - An `invalid` script is returned with its diagnostics, not thrown,
    so a tool can print the same message the viewer shows.
- The script's id is derived from its source URL.
  - Re-preparing the same file keeps its id (and its GM values in the
    host).
  - Two files sharing a basename stay distinct.
- Calls are serialized: the local-roots setting the override resolver
  reads is process-wide.
- `scripts/validate-userscripts.mjs` has its own driver (it has an
  offline dependency root the harness doesn't), and shares the Node
  parse checker in `parse-check-node.ts`.

### `host.ts`: the stand-in service worker

Messages it answers (every type the SW handles for injected code):

- `sm:check-pending`, with a values snapshot when the script needs one.
- `sm:start` / `sm:error` / `sm:abandoned`, recorded as reports.
- Storage batch writes and resync.
- XHR start and abort; tab open and close; downloads; notifications;
  menu register and unregister; log; focus.

Pushes it sends back (what the SW pushes):

- Value updates to the other pages running the script: attached,
  holding it, URL matching.
- XHR events, tab closed, menu fired, notification and download events.
- `urlchange`, from CDP's `Page.navigatedWithinDocument`.

How the APIs behave:

- Values go through the real codec (`gm-values.ts`).
- `GM_openInTab` opens a real page in the same browser context, so a
  test can wait for it.
- `window.close` and `window.focus` act on the page.
- `GM_download` fetches the bytes from Node into a directory the host
  names, reporting the extension's event shapes.
- `GM_notification` records the call and resolves with an id; a test
  delivers the click or close.
- `GM_xmlhttpRequest` runs `runXhr` itself on Node's `fetch`:
  - Gated by the real `@connect` code.
  - The browser context's cookies for the target are copied onto the
    request unless it is `anonymous`.
  - Forbidden headers pass straight through (`runXhr`'s
    `forbiddenHeaders: 'passthrough'`), where the extension would use a
    declarativeNetRequest rule.
  - No CORS limit, but not the extension's request identity either.

State exposed to tests:

- Seed and read values.
- The recorded tab opens, downloads, requests, window calls.
- Menu commands (and `fireMenuCommand`).
- Notifications (and `clickNotification` / `closeNotification`).
- The start / error / skipped reports.
- `pageOf(record)` says which attached page sent a report. It is kept
  in a `WeakMap` rather than on the record, so records stay plain data
  a test can compare.

### `inject.ts`: attaching scripts to a page

#### A channel per world

Each world gets its own channel to the host, so the page sees only
what it would in the extension:

- **Isolated world**:
  - An init script installs a stand-in `chrome.runtime` (`id`,
    `sendMessage`, `onMessage`).
  - It calls a CDP binding exposed only in that world; replies and
    pushes come back by `Runtime.evaluate` into it.
  - The page can neither read nor forge this traffic.
  - A request nobody answers rejects after 30 seconds, as the MAIN
    bridge's do.
- **MAIN world**:
  - A top-frame init script forwards bridge events to its own binding,
    captured before page scripts run so the page can't swap it out.
  - Replies and pushes are posted with `postMessage`, as the
    extension's relay does.

#### MAIN-world traffic is untrusted

As in the worker, anything from the MAIN world may be forged by the
page:

- `host.ts`'s `pageMayActAs` honors a bridge request only for a
  MAIN-world script on this page, matching its URL, that granted an API
  the request uses (the worker's `bridgeMayActAs`).
- Pushes reach MAIN world only when addressed to a MAIN-world script
  (`smWorld`) or carrying nothing script-scoped.

#### Registering the entries

- Uses one CDP session rather than Playwright's own init scripts, so
  registration order (channels first, then the entries) is the
  execution order.
- Adds the entries with `Page.addScriptToEvaluateOnNewDocument` in the
  script's world, naming a `worldName` for USER_SCRIPT, which
  Playwright's own init scripts cannot do.
- Wraps each entry in a top-frame guard, since CDP init scripts run in
  every frame and `chrome.userScripts` registrations do not.
- Survives reloads (init scripts persist), so the interactive loop
  costs one keystroke. Re-injecting a script removes its old entries
  first.

#### URL matching

- Always attaches the in-page matcher block to the prelude config
  (`buildRegistrationSpec`'s `inPageMatcher` option). The prelude
  decides per document, where Chrome's registration `matches` would
  have.
- The prelude's miss is silent, so the host evaluates the same rules on
  every navigation and records the rule that kept the script off the
  page.

### `fixture.ts`: the Playwright fixture

- The `@playwright/test` extension consumers import.
- Wraps the three above into `loadUserscript`, `gm`, `reports`, and
  `serveHtml` / `saveHtml`.
  - `serveHtml` routes a saved HTML file at its original URL so
    `@match` and relative URLs still hold (see
    [sm-dev-design.md](sm-dev-design.md#saved-pages) for the serving).
  - HAR replay is left to Playwright's own `routeFromHAR`.
- `tests/harness/fixture.spec.ts` drives it from `lib/` the way a
  consumer would.

## Extension backend

### Service-worker additions

Test-surface calls write **scratch scripts**, whose only copy is their
text in storage (see [storage.md](storage.md#container-collections)
for the rows):

- `writeScratchScript({ text, name? })` installs the text into a
  built-in **Scratch** collection.
  - Returns the row's id, status, and diagnostics, after registration
    has completed. (The wrapper names the changed rows to the sync
    itself rather than waiting for the storage event to.)
  - The name is the identity: the one the caller gives, else the
    `@name`. `sm-dev` passes the file's basename.
  - Rewriting a name replaces the text in place, keeping the row's id
    and GM values, so the next reload runs the new version.
  - Names that differ only in punctuation collapse into one identity.
- `clearScratchScripts()` drops that collection's rows and their
  `GM_*` values.
- `soloMode(on)` disables all other collections while on, and restores
  the previous enabled set when off. A scratch script runs alone
  without touching the user's real collections.
  - For a throwaway profile, `resetAllState()` wipes everything
    instead.
- The Scratch collection is a normal `scripts` collection at a fixed
  path, so the collections page and viewer show it like any other and
  the Log tab works unchanged.
- No new message transport into the extension: Playwright's worker
  handle serves both a launched and a CDP-connected browser.

### Driving it (`extension-backend.ts`)

- `sm-dev start --extension` reaches the worker through Playwright,
  which lists an extension's service worker on a CDP-connected browser
  as well as a launched one.
- The worker's URL is known up front, since the manifest's fixed `key`
  fixes the extension id. An idle worker is woken by opening the
  collections page.
- Reports are the script's own Log tab entries, polled. Only those
  added after the push are printed.
- `--solo` turns solo mode on for the run and off after.
- `sm-dev clear --extension` drops the scratch scripts.

## Compliance check for the host

- A `harness` project in `playwright.config.ts` runs `tests/harness/`
  (the harness's own specs) and `tests/examples/` on a plain Chromium,
  beside the `sourcemonkey`, `tampermonkey`, and `violentmonkey`
  projects.
- The manager fixture's `harness` backend (`tests/fixtures/manager.ts`)
  prepares every script under the example directory, and injects them
  into each page the spec opens.
- Each example directory exercises one API through the public surface.
  So the stand-in SW is measured against the real one by the same
  specs, and a divergence fails a test instead of surprising a script
  author.
- Exceptions:
  - Skipped: the wire-header report, which measures a browser's request
    and says nothing about a request sent from Node.
  - Run: the examples that check SourceMonkey-specific values
    (`GM_info` fields, the `@connect` refusal message), since the
    harness produces them with the extension's own code.

## Platform behavior the design relies on

Each was checked in a throwaway script before the harness was built.

- **Isolated-world init scripts over CDP work beside Playwright.**
  `Page.addScriptToEvaluateOnNewDocument` with a `worldName`:
  - runs in its own world (separate globals, no `chrome`);
  - fires again on reload;
  - can be evaluated into from a CDP session by its context id;
  - dispatches DOM events a MAIN-world listener hears.
  - Playwright's own `addInitScript` keeps working on the same page.
- **pnpm builds a git dependency's `prepare` script**, but only when
  the consumer allowlists it under `allowBuilds` in
  `pnpm-workspace.yaml`.
  - The key is matched against `<name>@git+https://…#<sha>`, so a bare
    name does not match. The full key does, and so does the glob
    `sourcemonkey@git+https*`.
  - The build runs in pnpm's clone, with the package's dev dependencies
    installed there.
- **Playwright lists an extension's service worker on a
  `connectOverCDP` connection** (`context.serviceWorkers()`), so the
  extension backend uses `worker.evaluate` in both cases.
- **A new tab can't be held before it loads from Playwright.** Found
  while adding opened-tab injection:
  - Playwright's `popup` event fires after the tab's document commits,
    so init scripts added then first reach its next document.
  - Holding the tab (`Target.setAutoAttach` with
    `waitForDebuggerOnStart`) needs a browser-level session in flat
    mode, whose child sessions Playwright's `CDPSession` can't address.
  - A page-level auto-attach doesn't cover popups.

## Open questions

- Whether opened tabs should get exact `document-start` timing, via a
  raw CDP connection of our own that holds each new tab until the
  scripts are in.
- Whether the Playwright fixture should follow opened tabs too, as an
  opt-in.
- Whether the package should be published to npm, which would remove
  the consumer's `injected` workaround and the build allowlist.
