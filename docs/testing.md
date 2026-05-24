# Testing

SourceMonkey ships two test suites: fast unit tests for pure logic and a
real-browser end-to-end suite for everything that touches the
`chrome.*` API surface or the file system.

## Layout

- `tests/unit/*.test.mjs` — Node `--test` files. Import from
  `dist/*.js`, so `npm run build` is a prerequisite (the
  `pretest:unit` script handles it).
- `tests/e2e/*.spec.ts` — Playwright specs. Launch headless Chromium
  with the unpacked extension loaded.
- `tests/fixtures/` — shared harness code.

## Running

- All tests: `npm test`
- Unit only: `npm run test:unit`
- E2E only: `npm run test:e2e`
- One unit file: `node --test tests/unit/<name>.test.mjs`
- One e2e file: `npx playwright test tests/e2e/<name>.spec.ts`
- SW console forwarding (debugging only): set
  `SM_FORWARD_SW_CONSOLE=1` — every SW `console.log` lands in test
  stderr. Off by default because it's noisy.

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
    `${baseUrl}/<api>/page.html`.
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

- Source mgmt: `addSource(path)`, `removeSource(id)`, `getSources()`,
  `getSourceWithScripts(id)`, `setSourceEnabled(id, on)`,
  `setScriptEnabled(id, on)`.
- Updates: `updateScript(id, mode)`, `updateSource(id, mode)`,
  `updateAllSources(mode)`. `mode` is `'manual'` or `'opportunistic'`.
- Inspection: `getTabState(tabId)` returns the current badge text,
  background color, tooltip, and the structured `TabRecord` from
  session storage. `debugMatchIndex(url)` returns the matcher cache.
- Lifecycle: `syncNow()` cancels the debounced sync timer and runs
  `syncRegistrations` synchronously, returning the post-sync
  registration list. `resetAllState()` clears storage and unregisters
  every userscript.

These mirror production functions — they don't add test-only logic to
the SW.

### The syncNow contract

`addSource` / `updateSource` / `setSourceEnabled` (etc.) only set
storage; the chrome.userScripts re-registration happens asynchronously
via a `storage.onChanged → onCacheChanged → scheduleSync` chain with a
50 ms debounce. A test that does `addSource` → `page.goto(...)` will
out-race the registration and the navigation will see the OLD set.

The contract is: **always call `await sm.syncNow()` after any
state-changing operation and before the navigation that depends on
it.** `syncNow()` cancels the pending debounce so no late-firing sync
can paint over the test's expected state.

### Writing tests

- Spin up a fresh `ScriptsDir` in `beforeEach`; `cleanup()` it in
  `afterEach`.
- Use `sm.addSource(scriptsDir.path)` to register the directory via
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
  broadcast: a write in tab A is observable in tab B.
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
- `tests/e2e/gm-connect.spec.ts` — `@connect` URL gating, including
  the strict-by-default "no @connect → blocked" case.
- `tests/e2e/gm-log.spec.ts` — `GM_log` prefixes log lines with the
  per-script id and forwards the rest verbatim; ungranted access is
  gated.
- `tests/e2e/gm-open-in-tab.spec.ts` — `GM_openInTab` opens at the
  right URL, both options-object and positional call shapes work,
  `onclose` fires when the opened tab is closed.
- `tests/e2e/gm-notification.spec.ts` — `GM_notification` resolves
  with a notification id; details and positional call shapes; the
  GM4 alias returns a Promise; empty `text` rejects.

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

- Each example dir holds its own `<api>.spec.ts` next to the page
  + userscript. Playwright is configured (`testMatch:
  examples/**/*.spec.ts` in `playwright.config.ts`) to discover them
  alongside the main `tests/e2e/` suite. Specs cover the same
  ground as the targeted GM_* specs above but through the public,
  installable userscript surface.
- Userscripts `@match *://*/<api>/page.html` so the same patterns
  work whether served at `${fixtureServer.baseUrl}` (random port) or
  by a developer's local `http-server`.

### What's not yet covered

- The bridge code path for MAIN-world scripts.
- `@resource` loading (depends on the deferred `GM_getResource*`
  surface; the `@require` pipeline is covered).
- The viewer page's render path (covered by unit tests for the
  helpers but not by an e2e click-through).
- XHR header surgery — deferred along with the implementation.
- `GM_notification` click / done callback dispatch in production
  Chrome — headless tests cover the SW round-trip and Promise
  resolution but Chrome's notification UI is suppressed in
  headless, so we can't drive a click; the unit test covers the
  page-side dispatcher logic instead.
- `GM_registerMenuCommand` / `GM_cookie` — bindings exist but
  stubbed as not-implemented.
