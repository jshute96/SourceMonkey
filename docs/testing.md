# Testing

VibeMonkey ships two test suites: fast unit tests for pure logic and a
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
  `VM_FORWARD_SW_CONSOLE=1` — every SW `console.log` lands in test
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
    `tests/fixtures/pages/`.
  - `getServiceWorker` — re-resolves a live SW handle each call (MV3
    workers idle out).
  - `extensionId` — the deterministic ID of the unpacked extension.
  - `vm` — typed proxy over `self.VibeMonkey`; see *SW test surface*
    below. Wipes storage and unregisters userscripts at test start.
- `extension-id.ts` — computes Chrome's deterministic
  unpacked-extension ID (SHA-256 of the path, first 16 bytes, mapped
  `0`–`f` → `a`–`p`). Needed because we have to write Preferences for
  a specific extension ID before launch.
- `scripts-dir.ts` — tmp-dir helper. `ScriptsDir.create()` makes one,
  `.write({ relativePath, meta, body })` writes a real `*.user.js`,
  `.rewriteBody(path, body)` simulates an external edit, `.cleanup()`
  removes the dir.
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

### SW test surface

`src/background.ts` exposes `self.VibeMonkey` so Playwright can invoke
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

The contract is: **always call `await vm.syncNow()` after any
state-changing operation and before the navigation that depends on
it.** `syncNow()` cancels the pending debounce so no late-firing sync
can paint over the test's expected state.

### Writing tests

- Spin up a fresh `ScriptsDir` in `beforeEach`; `cleanup()` it in
  `afterEach`.
- Use `vm.addSource(scriptsDir.path)` to register the directory via
  the real pipeline.
- Chrome match patterns may include `:port` (we follow Chrome's
  matcher, not its docs). A port-less pattern matches any port — use
  that form when the test's port assignment is random.
- Wait for badge / state changes with `waitForTabState(vm, tabId,
  predicate)` — `getTabState` is async and chrome.webNavigation
  events arrive on their own clock.
- Use `activeTabId(getServiceWorker)` to discover the numeric tab ID
  for the page you just opened (Playwright doesn't expose it
  directly).

### What's not yet covered

- The bridge code path for MAIN-world scripts.
- `@require` / `@resource` loading.
- The viewer page's render path (covered by unit tests for the
  helpers but not by an e2e click-through).
