# Testing

SourceMonkey ships two test suites: fast unit tests for pure logic and a
real-browser end-to-end suite for everything that touches the
`chrome.*` API surface or the file system.

## Layout

- `tests/unit/*.test.mjs` — Node `--test` files. Import from
  `dist/*.js`, so `pnpm run build` is a prerequisite (the
  `test:unit` script runs it first).
- `tests/e2e/*.spec.ts` — Playwright specs. Launch headless Chromium
  with the unpacked extension loaded.
- `tests/fixtures/` — shared harness code.
- `tests/greasyfork-examples/` — not a test suite: tooling that builds a
  corpus of the top 2000 real-world GreasyFork scripts and analyses it
  (see its own `README.md`). Playwright's `testMatch` covers only
  `e2e/**` and `examples/**`, so nothing here runs as a test.

`pnpm run validate` is a fourth thing again — not a test runner, but it
does check scripts. It runs the install-time pipeline over files on
disk with no browser, across `tests/examples/`, `tests/bad-examples/`,
or the GreasyFork corpus. See
[offline-validation.md](offline-validation.md).

- The CLI itself is tested by `tests/unit/validate-userscripts.test.mjs`,
  which spawns it over both example suites.
- Its `tests/bad-examples/` expectations live in
  `tests/fixtures/bad-script-cases.mjs` and are shared with
  `tests/e2e/bad-scripts.spec.ts`, which asserts the same table against
  the real extension in Chromium. One table, two runners: they can't
  drift apart without a test failing.

## Running

- All tests: `pnpm test`
- Unit only: `pnpm run test:unit`
- E2E only: `pnpm run test:e2e`
- One unit file: `node --test tests/unit/<name>.test.mjs`
- One e2e file: `pnpm exec playwright test tests/e2e/<name>.spec.ts`
- The `sourcemonkey` project runs **in parallel** (`workers: '50%'`,
  `fullyParallel: true`). Each worker launches its own Chromium with its
  own `mkdtemp` profile, and the fixture HTTP server binds to port 0, so
  workers share nothing.
  - **The `tampermonkey` project must stay serial.** It attaches over
    CDP to one real browser with no per-test state reset, so the
    package scripts pass `--workers=1`. Invoking `playwright test
    --project=tampermonkey` directly skips that — pass it yourself.
- Typecheck: `pnpm run typecheck` — `tsconfig.json` builds the extension
  and covers `src/` only, so this runs `tsconfig.tests.json` over the
  tests as well. Playwright transpiles specs without checking types, so
  nothing else catches a type error in a test.
- SW console forwarding (debugging only): set
  `SM_FORWARD_SW_CONSOLE=1` — every SW `console.log` lands in test
  stderr. Off by default because it's noisy.

### Retries and traces

`retries: 1` (on the `sourcemonkey` project only) with
`trace: 'on-first-retry'`.

**Don't switch to `retain-on-failure`.**

- It records a trace for every test and discards it on pass.
- This suite shares one worker-scoped browser context across all its
  tests, and recording against a context that long-lived stalls the
  trace fixture past its 30s setup timeout.
- The victim is whichever test runs next, so the symptom is a moving
  target that never reproduces standalone.
- It also cost roughly a third of the suite's wall-clock.

**A *flaky* count is worth reading.** The retry exists to capture a
trace, not to make a run green.

- `playwright test` exits 0 when tests are flaky, so anything gating on
  the exit code needs `--fail-on-flaky-tests`.
- A test that only passes on retry is usually waiting on a proxy for
  what it asserts — the badge colour rather than the tooltip, a fixed
  pause rather than the log entry. Wait on the thing being asserted.
- If the worker itself dies (`worker process exited unexpectedly`), the
  retry's trace is of the *passing* run and won't show you anything.

**Diagnosing a failure from a full run**: use `--reporter=json` and read
`errors[].message`.

- The `list` reporter puts error detail in a trailing block that is
  easy to lose to a `tail` or a `grep`.
- "Expected X" without the received value is rarely enough to act on.

## Unit tests

- Plain `node:test`. No mocks, no fakes — modules under test are
  imported from `dist/` and exercised directly.
- Cover URL matching, header parsing, store helpers, badge
  classification, injector spec building, and the updater rate-limit
  gate.

## E2E tests

The e2e suite proves the extension actually injects scripts, that the
badge reflects reality, and that the storage-driven update path works.
It runs against real headless Chromium with `chrome.userScripts`,
`chrome.webNavigation`, and `file://` access all enabled.

### Fixtures

- `extension.ts` — Playwright `test` extended with:
  - `extensionContext` (worker-scoped) — persistent Chromium with the
    extension loaded and Preferences pre-seeded.
  - `fixtureServer` (worker-scoped) — local HTTP server serving
    `tests/fixtures/pages/` first, with `tests/examples/` mounted as
    a fallback root so example pages are reachable at
    `${baseUrl}/<api>/page.html`. Two routes are not files:
    - `/__slow/<name>?ms=N` — delays a tiny JS/PNG response.
    - `/__echo?delay=N` — reflects the request's method, target and
      headers back as JSON, so a test can see what actually went on the
      wire (forbidden headers are invisible from the page that asked
      for the request, and the target shows whether the per-request URL
      tag stayed inside the browser). `delay` holds the whole response,
      which is how the header-surgery tests keep two same-URL requests
      overlapping.
  - `getServiceWorker` — re-resolves a live SW handle each call (MV3
    workers idle out).
  - `extensionId` — the deterministic ID of the unpacked extension.
  - `sm` — typed proxy over `self.SourceMonkey`; see *SW test surface*
    below. Wipes storage and unregisters userscripts at test start.
- `extension-id.ts` — computes Chrome's deterministic
  unpacked-extension ID (SHA-256 of the path, first 16 bytes, mapped
  `0`–`f` → `a`–`p`). Needed because we have to write Preferences for
  a specific extension ID before launch.
- `scripts-dir.ts` — tmp-dir helper. `ScriptsDir.create()` makes one,
  `.write({ relativePath, meta, body })` writes a real `*.user.js`,
  `.rewriteBody(path, body)` simulates an external edit, `.cleanup()`
  removes the dir. `UserscriptMeta` supports `grant`, `connect`,
  `match`, `include`, `exclude`, `injectInto`, `runAt`, plus a raw
  `extra: string[]` escape hatch for header lines the typed fields
  don't cover.
- `capture-nav.ts` — the two waits both `.user.js`-capture specs
  need. `startCapturedNavigation(page, url)` kicks off the
  navigation the capture aborts, with a bounded timeout so a stuck
  first leg can't eat the whole test budget and report a bare
  "Test timeout exceeded"; `waitForInstallPrompt(page)` then waits
  for the preview.
- `sw-api.ts` — `makeSwApi(getServiceWorker)` returns a typed proxy
  over the SW's test surface; `waitFor(read, predicate)` polls a
  SW-side query until a condition is met (or throws with the last
  observed value).

### Chrome flags / Preferences

Two Chrome capabilities the e2e harness needs:

- **`file://` access** — already granted in headless mode for
  unpacked extensions, so no extra setup. Production users still have
  to flip the per-extension toggle.
- **User scripts** (Chrome ≥138) — `chrome.userScripts` is gated
  behind a per-extension toggle. The harness pre-writes
  `extensions.settings.<extensionId>.user_scripts_enabled = true`
  into `<userDataDir>/Default/Preferences` before launch so the API
  is callable without UI clicks.

**Pitfall: extension ID must match Chrome's actual ID.** Our
`src/manifest.json` ships a `"key"` field, which makes Chrome
derive the extension ID from the key bytes rather than the
filesystem path. `tests/fixtures/extension-id.ts` reads the manifest
and computes the ID from the key when present, falling back to the
path-based derivation when it isn't. Writing the per-extension
toggle to the wrong ID silently no-ops — `chrome.userScripts` ends
up undefined, the SW boots fine, and every userscript registration
is dropped. If you change `src/manifest.json`'s key (or rename the
fixture entry point), re-verify both the key-based and path-based
derivations still resolve correctly.

### SW test surface

`src/background.ts` exposes `self.SourceMonkey` so Playwright can invoke
SW functions via `serviceWorker.evaluate(...)`. Methods relevant to
tests:

- Collection mgmt: `addCollection(path)`, `removeCollection(id)`, `getCollections()`,
  `getCollectionWithScripts(id)`, `setCollectionEnabled(id, on)`,
  `setScriptEnabled(id, on)`.
- Updates: `updateScript(id, mode, probe?)`, `updateCollection(id, mode)`,
  `updateAllCollections(mode)`. `mode` is `'manual'` or `'opportunistic'`.
  `probe` is `'force'` for a genuine Refresh **click** — `mode:
  'manual'` only means "not rate-limited" and the reload fast-path uses
  it too, so behaviours that key off a real click (upstream version
  probes, retrying a refused registration immediately) need `'force'`.
- Inspection: `getTabState(tabId)` returns the current badge text,
  background color, tooltip, and the structured `TabRecord` from
  session storage. `debugMatchIndex(url)` returns the matcher cache.
  `getRejections()` returns the registrations Chrome refused on the
  last attempt — what the UI renders as REJECTED.
- Lifecycle: `syncNow()` cancels the debounced sync timer and runs
  `syncRegistrations` synchronously, returning the post-sync
  registration list and which path it took (`kind`). It *flushes* the
  pending sync rather than replacing it — same accumulated scope, so
  tests exercise the same incremental path production takes, and a
  scope the debounce already drained stays empty rather than becoming
  a full reconcile. `resetAllState()` clears storage and unregisters
  every userscript.
- Per-script log: `getScriptLog(id)`, `appendScriptLog(id, entry)`,
  `clearScriptLog(id)`, `getScriptLogLabel(id)`.
- Work-sharing counters: `getDirectoryListingFetches()` and
  `getCollectionRowReads()`, each with a `reset*` twin. They count what
  a navigation's batched checks would otherwise duplicate (see
  [injection.md](injection.md#shared-work-across-the-batch)) — the
  sharing has no other observable signature. Both are per-JS-context and
  count *all* such reads in the worker, so reset around the window under
  test.
- GM values: `getGmValues(id)` returns every **persisted** value for a
  script, deliberately excluding the SW's in-flight overlay.
  `GM_setValue` batches its write 150ms after the last one, so a test
  waits on this rather than pausing — and because it reads only what
  survived, a predicate that passes has passed against durable state.

These mirror production functions. Two of them wait where production
deliberately doesn't, so a test can't observe a half-written state:

- `getScriptLog` drains that script's in-flight appends first.
  Production logging (`logScriptEvent`) is fire-and-forget — a refresh
  must not block on writing its own transcript — so `updateCollection()`
  can resolve before the entry it produced has landed.
- `getScriptLogLabel` is the awaited form, so a test never races the
  id table and gets a UUID prefix back.

### The syncNow contract

`addCollection` / `updateCollection` / `setCollectionEnabled` (etc.) only set
storage; the chrome.userScripts re-registration happens asynchronously
via a `storage.onChanged → onCacheChanged → scheduleSync` chain with a
50 ms debounce. A test that does `addCollection` → `page.goto(...)` will
out-race the registration and the navigation will see the OLD set.

The contract is: **always call `await sm.syncNow()` after any
state-changing operation and before the navigation that depends on
it.** `syncNow()` cancels the pending debounce so no late-firing sync
can paint over the test's expected state.

#### …and where `syncNow()` is the wrong tool

`syncNow()` forces the registration step. That is exactly what you want
before a navigation — and exactly what you must **not** do when the
behaviour under test *is* whether production reaches that step on its
own.

- A test asserting "a Refresh re-offers the script to Chrome" that
  calls `syncNow()` afterwards passes whether or not the production
  path works, because the test performed the missing step itself.
- This is not hypothetical: the first version of
  `rejected-registration.spec.ts` did exactly that, and passed for
  several full-suite runs while a Refresh silently never retried
  anything. (Chrome fires no `storage.onChanged` when a `set` writes an
  identical value, so a no-op refresh never reaches `scheduleSync` —
  see [injection.md](injection.md#rejected-registrations).)
- Rule of thumb: if the assertion is about *state after* a change, seed
  it with `syncNow()`. If the assertion is about *the trigger itself*,
  don't — poll (`expect.poll`) and let production get there.
- Worth confirming either way: break the production path on purpose and
  re-run. A test that still passes is testing the test.

### Writing tests

- Spin up a fresh `ScriptsDir` in `beforeEach`; `cleanup()` it in
  `afterEach`.
- Use `sm.addCollection(scriptsDir.path)` to register the directory via
  the real pipeline.
- Chrome match patterns may include `:port` (we follow Chrome's
  matcher, not its docs). A port-less pattern matches any port — use
  that form when the test's port assignment is random.
- Wait for badge / state changes with `waitForTabState(sm, tabId,
  predicate)` — `getTabState` is async and chrome.webNavigation
  events arrive on their own clock.
- Use `activeTabId(getServiceWorker)` to discover the numeric tab ID
  for the page you just opened (Playwright doesn't expose it
  directly).

### GM_* test coverage

Each phase of the `GM_*` implementation has both a unit-test layer
(catalog parsing, binding emission, storage helpers, `@connect`
matching) and an e2e spec (real userscript, real Chromium, real
fetch via the SW). Highlights:

- `tests/e2e/gm-grants.spec.ts` — `@grant` gating: granted APIs are
  callable, ungranted ones are `undefined`, `@grant none` emits no
  bindings.
- `tests/e2e/gm-storage.spec.ts` — `GM_setValue`/`getValue`/
  `deleteValue`/`listValues` round-trip, persistence across reloads,
  per-script namespace isolation, `GM.` promise forms.
- `tests/e2e/gm-broadcast.spec.ts` — cross-tab `GM_setValue`
  broadcast: a write in tab A is observable in tab B; delivery
  survives the SW losing its in-memory openers table; a document
  that missed a broadcast re-syncs on the SW's nudge, for both a
  changed value and a deleted one.
- `tests/e2e/gm-value-listeners.spec.ts` — value-change listeners
  fire with `remote=false` locally and `remote=true` on broadcasts.
- `tests/e2e/gm-dom.spec.ts` — `GM_addStyle` / `GM_addElement`.
- `tests/e2e/gm-clipboard.spec.ts` — `GM_setClipboard` round-trip
  through `navigator.clipboard` (requires
  `extensionContext.grantPermissions(['clipboard-read', 'clipboard-write'])`
  in the test that exercises it).
- `tests/e2e/gm-xhr.spec.ts` + `tests/e2e/gm-xhr-binary.spec.ts` —
  `GM_xmlhttpRequest` text + JSON, POST body, network failure,
  abort, timeout, binary types.
- `tests/e2e/gm-connect.spec.ts` — `@connect` rule matching (exact,
  wildcard, subdomain, mismatch) and the post-redirect re-check.
- `tests/e2e/gm-connect-default.spec.ts` — the default policy for a
  script with no `@connect`: same-origin allowed, cross-origin denied
  with a Log entry, and the post-redirect hop.
- `tests/e2e/gm-log.spec.ts` — `GM_log` prefixes log lines with the
  per-script id and forwards the rest verbatim; ungranted access is
  gated.
- `tests/e2e/gm-open-in-tab.spec.ts` — `GM_openInTab` opens at the
  right URL, both options-object and positional call shapes work,
  `onclose` fires when the opened tab is closed.
- `tests/e2e/gm-notification.spec.ts` — `GM_notification` resolves
  with a notification id; details and positional call shapes; the
  GM4 alias returns a Promise; empty `text` rejects.
- `tests/e2e/gm-download.spec.ts` — `GM_download` over http(s)
  (a real `chrome.downloads` transfer that completes headlessly),
  the in-page `blob:` / `data:` path, refusals (`file://` scheme,
  traversing `name`) including the Log-tab entry, `abort()`, and
  the deliberate contrast that `@connect` gates `GM_xmlhttpRequest`
  but not `GM_download`.
- `tests/e2e/window-onurlchange.spec.ts` — `@grant window.onurlchange`:
  page-initiated `pushState` / `replaceState` / hash / back all
  deliver a `urlchange`; the initial load doesn't, but a same-URL
  `replaceState` does; an ungranted script sees `undefined` and no
  events; the assignment form and `removeEventListener` work.
  History is driven from `page.evaluate` (MAIN world) so the calls
  really are the page's, not the isolated world's. Also pins the
  handler-slot / `addEventListener` non-aliasing contract and the
  known per-document (rather than per-script) grant leak.
- `tests/e2e/window-close-focus.spec.ts` — `@grant window.close` /
  `@grant window.focus`: a granted `window.close()` really removes the
  tab, an ungranted one hits Chrome's refusal and leaves it open, each
  grant installs only its own override, and the page's MAIN-world
  `window.close` / `.focus` stay native. `window.focus` is asserted by
  its tab-selection half (a second tab is opened, then the script is
  cued through the DOM to call `focus()`, and the active tab flips
  back) — the window-raising half isn't observable headlessly, since a
  headless browser reports every window as focused. Unit tests cover
  the SW driver's `chrome.tabs` / `chrome.windows` calls. Also pins the
  known per-document (rather than per-script) grant leak: an ungranted
  sibling script in the same document gets the working override.

The XHR tests use `UserscriptServer` (see
`tests/fixtures/userscript-server.ts`) to serve test endpoints
because they need mutable per-test routes that the shared
`fixtureServer` (static HTML only) doesn't provide.

### Examples / compliance suite

`tests/examples/<api>/` pairs a `page.html` with a `script.user.js`
for each demoed API. The pages double as a manual exploration tool
(serve them with `http-server` and click around) and as a
cross-manager compliance reference (install the same `*.user.js`
files into TM/VM, hit the same URLs, compare outcomes).

- The examples suite uses `tests/fixtures/manager.ts` instead of
  `extension.ts` so the same specs can run against either SM or TM.
  Tests destructure `setup` instead of `sm` and call
  `await setup.installScriptsFrom(__dirname)` to register the
  directory's userscripts with whichever manager is active. See
  `docs/cross-manager-testing.md` for the full picture.

- Each example dir holds its own `<api>.spec.ts` next to the page
  + userscript. Playwright is configured (`testMatch:
  examples/**/*.spec.ts` in `playwright.config.ts`) to discover them
  alongside the main `tests/e2e/` suite. Specs cover the same
  ground as the targeted GM_* specs above but through the public,
  installable userscript surface.
- Userscripts `@match *://*/<api>/page.html` so the same patterns
  work whether served at `${fixtureServer.baseUrl}` (random port) or
  by a developer's local `http-server`.
- A directory may also hold **multiple** sibling userscripts for
  header-variation pages (`headers-run-at/` runs one per value;
  `xmlhttp-denied/` runs one per `@connect` configuration). All
  variants share the same `<dir>.html` and the spec asserts on the
  cross-variant outcomes side-by-side.

### What's not yet covered

- The bridge code path for MAIN-world scripts.
- `@resource` loading (depends on the deferred `GM_getResource*`
  surface; the `@require` pipeline is covered).
- The viewer page's installed-script render path (covered by unit
  tests for the helpers, plus incidental click-through in
  `install-capture.spec.ts`; its preview mode has its own spec in
  `script-preview.spec.ts`).
- The XHR header-stall backstop firing (`XHR_HEADER_STALL_MS` is a
  module-private 2 minutes and no test waits that long). The surgery
  itself is covered by `gm-xhr-headers.spec.ts`.
- **Chrome's own enforcement of "Allow access to file URLs" OFF.**
  Chrome grants file access unconditionally to `--load-extension`
  builds, and writing `allow_file_access: false` into the pre-seeded
  Preferences does not override it, so the browser always behaves as
  if the toggle were on.
  - Still a manual check: that `.user.js` capture doesn't fire for a
    local file with the toggle really off.
  - Not a gap any more: the UI that *reacts* to the toggle.
    `file-access-banner.spec.ts` stubs
    `chrome.extension.isAllowedFileSchemeAccess` via `addInitScript`,
    which is the only thing the pages branch on, and
    `install-capture-file.spec.ts` covers the grant-ON side (a failed
    read must not raise the banner).
- `GM_notification` click / done callback dispatch in production
  Chrome — headless tests cover the SW round-trip and Promise
  resolution but Chrome's notification UI is suppressed in
  headless, so we can't drive a click; the unit test covers the
  page-side dispatcher logic instead.
- Real Chrome action context menu click-through for
  `GM_registerMenuCommand` — Playwright can't drive the toolbar
  right-click menu, so the SW exposes
  `getActionContextMenu` + `fireActionContextMenuItem` and
  `tests/e2e/gm-menu.spec.ts` covers the round-trip through them.
  The real UI render is exercised manually.
- `GM_cookie` and other catalog entries that remain stubbed as
  not-implemented.
