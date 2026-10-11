# CLAUDE.md

This file provides guidance to agents when working with code in this
repository. See `README.md` for setup instructions and available commands.

## Workflow Rules

- **Documentation**:
  - Keep `docs/*.md` design documents in sync with behavioral changes.
  - Update `docs/file-index.md` when adding, renaming, or removing source files, or when their description should change. The index is a navigation aid meant to describe what the files are now.
  - **`docs/file-index.md` is a one-line-per-file index, NOT a place for design summaries.** Each row gets a single short sentence (≈ 80–120 chars). If you find yourself wanting to explain *how* a file works, that belongs in `architecture.md` or other docs, not the index.
  - **`docs/architecture.md`** is a high-level overview of the system and components, not details on all the parts. Make separate docs about specific components where there are details worth describing.
  - **No prose blobs in design docs.** Hard rule: any block of text longer than ~4 lines must be broken up into bullets, sub-sections, or smaller paragraphs. Reviewers should be able to scan the page without reading any single chunk top-to-bottom.
    - If a single concept needs multiple sentences, split it across bullets.
    - If a doc section grows past ~8 lines, give it sub-headings.
    - Prefer bullets to paragraphs; prefer short bullets to long bullets.
  - When adding a new feature, you can add new sections in the relevant design doc rather than appending to an existing one.
  - **Avoid stating counts of list elements in comments or docs.** If there are more than 2-3 items, don't say the count before listing them. That requires unnecessary edits when the list changes.
- **Commit Preparation**:
  - Ensure `README.md` is updated if setup, commands, or high-level user-visible features change.
    - README contains
      - A high-level user-facing product overview - what it is, what the main UI pages are, but not every feature or capability on those pages.
      - Setup instructions for users.
      - Developer instructions - building, testing, tools, etc.
    - README should be concise and easy to read, without excessive details. It shouldn't list every feature or behavior, or implementation details of how things work.
    - Use other `docs/*.md` files for more details.
  - Always update `docs/file-index.md` when the file set changes or file descriptions become stale.
  - When changing `sm-dev` or the harness (commands, flags, output, behavior), update the `skills/SourceMonkey-dev/` instructions (`SKILL.md`, `references/*.md`) to match, where they cover it.
  - Include all significant changes in the commit message.

## Development Conventions

### Code Logic
- **Documentation**: Where code has subtle or surprising logic, add comments to explain the "why" and intended behavior.
- **Never use `console.warn` / `console.error` in any extension context** (service worker, extension pages, AND injected wrapper / prelude / GM-runtime code). Chrome forwards both into `chrome://extensions/?errors`, which makes SourceMonkey look broken even when the failure is in user-supplied script code or an expected fallback. Use `console.info` instead — it stays in the relevant DevTools console only.
  - This applies to diagnostics emitted into the **page** console too (e.g. the startup-log channel and the injected error shims in `userscript-prelude.js`): injected `.error`/`.warn` from a `chrome.userScripts`-registered script still surface in the extensions Errors panel.
  - Capturing error/warning *severity* for the viewer's Log tab is a separate path (the per-script log's `level` field + the `sm:*` reports) and is unaffected — keep logging the real level there; just don't escalate the `console` method.

### Error messages
Applies to any string a user can read (`errorMessage`, `refreshError`, Log
entries, banners). Full rules in [docs/diagnostics.md](docs/diagnostics.md#wording).

- **No internal vocabulary** (`SW`, `opaque response`, `fetch threw`).
- **Name what failed**, and the fix where there is one.
- **Friendly is not vague.** Plain wording still has to leave something to
  debug with: name the step that failed, not just the subsystem it was in.
- **Capitalized, no trailing period, subject included** — the same string
  appears alone and after prefixes like `This file cannot be installed: `.
  A capital after that colon is intended.
  - A tail after a `: ` is a message too, so it takes a capital. If it
    can't grammatically (`is empty`), give it a subject (`The file is
    empty`) rather than exempting it.
  - Only a splice *inside* a sentence we wrote stays lowercase —
    `LOCATION_SHAPES`, which completes `Location must be a …`.
  - A message of two or more sentences punctuates all of them, the
    last included: `This location is a manifest. Choose Manifest as
    the type.`
- **One message per problem**; wrap the shared string rather than writing a
  second copy for another surface.
  - That covers code that *recognizes* a message too: import the shared
    constant or predicate, never pattern-match the wording.
- **Don't guess between causes** — say which, or state the possibilities and
  file the plumbing in TODO.md.
- **`Internal error:` prefix** when the user can't act on it.

### sm-dev output markup (color)
sm-dev's output and help are marked up by role and painted at a
terminal. How it works:
[docs/sm-dev-design.md](docs/sm-dev-design.md#output-color-output-stylets).
- **The roles and their looks** are `STYLES` in
  `src/harness/output-style.ts`, the one place colors are set. Help's
  own markup is in `src/harness/help-format.ts`, which maps its spans
  onto those roles.
- **Mark output by what it is** (`id`, `name`, `url`, `code`,
  `heading`, `selected`) with `ui` and the role helpers, which escape
  what goes in.
- **Recognized prefixes stay plain, before any markup**: write
  ``'[sm-dev] ' + ui`...` ``, and build `[sm-dev] ERROR: `, `ERROR: `,
  `Warning: `, `INVALID  ` from the constants in `output-style.ts`.
- **In messages we write, put commands, flags and the user's own input
  in backticks** (`` Use `tabs` to list them ``). In a template literal,
  write them with `quoted()` (`` `The ${quoted(flag)} flag` ``) rather
  than escaped backticks. Text a script or page wrote goes in through
  `ui` or `asError`, so its own backticks stay text.
- **Never put markup in** Error messages, JSON, or strings code
  compares. Plain output (pipes, tests) must read right with no color.
- In help text (`command-list.ts`), commands, flags and values go in
  backticks.

### Storage writes and the worker's row cache
Only the service worker writes storage and places registrations. Why,
and how it is built: [docs/worker-writes.md](docs/worker-writes.md).
- **Pages read storage to paint, and ask the worker for any change**
  through `src/extension/worker-client.ts`. A new write is an operation
  in `worker-ops.ts` plus a client export of the same name.
  - Writers call `assertWorkerContext`, and
    `tests/unit/page-writes.test.mjs` checks what pages import.
  - Code running in the worker calls the store directly, never
    `worker-client.ts`.
- **Worker reads of collection rows, script rows and active times go
  through the row cache** (the store's reads, `sharedRows`), not a scan
  of their own.
  - Rows from `sharedRows` are frozen: copy one before changing it.
- **Write script rows inside the store's lock (`mutate`)**, awaited
  before the section returns. The blob cleanup relies on it, and the
  worker refuses a script row written outside the lock.
- **What crosses the port is JSON**: no Maps or Sets, and no script
  bodies when the page only needs the row.
- **Anything new that changes Chrome's registration set** calls
  `markRecordStale` first and `scheduleRecordSave` after, so a new
  worker doesn't take a stale session record.
- Tests that seed script rows use `sm.seedStorage`, which writes under
  the lock.

### sm-dev protocol version
`SM_DEV_PROTOCOL` in `src/sm-dev-protocol.ts` versions what sm-dev and
the extension exchange (the calls and events `ExtensionLink` uses),
since each side can come from a different build. The e2e-only parts of
`self.SourceMonkey` are always the same build, so they don't count.
When changing that surface:
- **Bump the major** when a change needs both sides updated: a run
  refuses an extension whose major differs.
- **Bump the minor** for anything else new, including a new sm-dev
  feature that needs a newer extension.
  - An extension ahead by a minor must keep working with the older
    sm-dev.
  - An sm-dev feature that needs the new minor calls
    `ExtensionLink.requireMinor` before using it. With an older
    extension, the person then gets an error saying to update it,
    rather than a failed call.
- Reset the minor to 0 on a major bump.

## Planning vs Implementation
When the user asks you to implement something, start coding quickly. Do NOT
spend the entire session planning unless explicitly asked for a plan. If a plan
is needed, keep it concise (bullet points, not paragraphs) and confirm with the
user before elaborating further. Default to action over planning.

## Git & Commits
- Do not commit or push changes without getting user instructions to do so.
- When committing, include ALL relevant changed files — check `git status` before committing to avoid missing files like TODO.md, documentation, or new files.

## Reference material
- **Tampermonkey/userscript details**: the `tampermonkey` plugin skill
  ships a reference library covering header tags, URL matching, `GM_*`
  APIs, sandbox modes, browser quirks, and more. Invoke it via
  `/tampermonkey:tampermonkey` (or load the on-disk files under
  `~/.claude/plugins/cache/wookstar-claude-plugins/tampermonkey/<ver>/skills/tampermonkey/references/`)
  when implementing anything that touches userscript semantics.

## Working on userscripts with our tools
- When developing, debugging or testing userscripts with `sm-dev` or the
  harness (not when changing the tools themselves), use the
  `SourceMonkey-dev` skill for how to work with them.
- Apply the `SourceMonkey-friction` skill too: when that work is
  finished (committed or abandoned) and ran into friction with the
  tools or the skill, log it as the skill describes.

## Code Changes
- Use the file index to help find relevant files.
- When changing behavior, read existing design docs to understand previous designs and intentions. Ask questions if unsure if we should change those requirements.
- When the user asks for a change, apply it consistently to ALL similar patterns.
- Do NOT drop or overwrite existing content in files like README.md — preserve what's there and add to it.
- When similar logic occurs on multiple parallel paths, use common helper methods when possible, to ensure the logic stays consistent.
- **Where a module goes** (see [docs/architecture.md](docs/architecture.md#source-layout)):
  - `src/extension/` if only the extension loads it, `src/harness/` if
    only the harness does, directly in `src/` if both do.
  - A shared module in `src/` must not import from `src/extension/`,
    not even `import type`: tsc would then compile that module into
    `lib/`.
  - When the harness needs something from an extension-only module,
    move that piece into a shared module in `src/` (splitting the file
    if needed) rather than importing it.
  - Pages, CSS, icons and the manifest stay directly in `src/`, so
    their URLs have no folder in them. A page's `<script src>` points
    into `extension/`.
  - From the service worker, pass Chrome absolute URLs
    (`chrome.runtime.getURL`): it runs from `extension/`, so a relative
    path resolves there.
  - `tests/unit/source-layout.test.mjs` checks this.

## Running tests
- See `docs/testing.md` for the full layout and harness details.
- To run a single test file:
  - Unit: `node --test tests/unit/<file>.test.mjs`
  - E2E: `pnpm exec playwright test tests/e2e/<file>.spec.ts`
- To narrow a package script to one file, append the path (pnpm forwards
  trailing args to the script; don't use `--`, pnpm passes it through
  literally):
  - `pnpm run test:e2e tests/e2e/injection.spec.ts`
  - `pnpm run test:e2e:tm tests/examples/headers-run-at/headers-run-at.spec.ts`
    (and `test:e2e:vm` for the Violentmonkey project)
  - Playwright treats the trailing arg as a path filter; useful when
    you want the script's env/config (e.g. `--project=tampermonkey`)
    without retyping it.
- When you do need a full run, start it with Bash `run_in_background: true` so it doesn't block the turn.

## Writing tests
- **Unit vs e2e**: unit tests (`tests/unit/`) exercise pure logic against
  the compiled `dist/**/*.js`. Use them for matcher/parser/store helpers.
  E2E tests (`tests/e2e/`) drive a real headless Chromium with the
  unpacked extension loaded; use them for anything that touches the
  chrome.* APIs or end-to-end injection.
- **E2E harness** (see `docs/testing.md` for the full picture):
  - `tests/fixtures/extension.ts` exposes `extensionContext`,
    `fixtureServer`, `extensionId`, `getServiceWorker`, and `sm`. The
    `sm` fixture is a typed proxy over the SW's `self.SourceMonkey` test
    surface (see `src/extension/background.ts`).
  - `tests/fixtures/scripts-dir.ts` builds a tmp directory of real
    `*.user.js` files on disk so `sm.addCollection(dir.path)` runs the
    production file:// scan + fetch pipeline.
  - The fixture pre-writes `extensions.settings.<id>.user_scripts_enabled
    = true` into Chrome's Preferences so `chrome.userScripts` is callable
    in headless mode (Chrome ≥138 normally requires a manual toggle).
- **Always call `sm.syncNow()`** after any state-changing operation
  (addCollection, updateCollection, setCollectionEnabled, setScriptEnabled) and
  BEFORE the navigation that should see the new state. The production
  storage→sync path has a 50ms debounce that a fast-following navigation
  will out-race; `syncNow` flushes it.
- **Reset between tests**: the `sm` fixture calls `sm.resetAllState()`
  before each test (wipes storage + unregisters every userscript). Tests
  should clean up their tmp dirs in `afterEach`.
- **No SW-console output by default**. Set `SM_FORWARD_SW_CONSOLE=1` to
  stream the SW's `console.log` calls to test stderr while debugging.
- **Prefer fresh test files for new feature areas**, with one file per
  concern (see `tests/e2e/` for the current split).

## Editing example userscripts
- When adding an example under `tests/examples/`, follow the page
  skeleton and the "Adding a new example" checklist in
  `tests/examples/README.md`: the footer, the `@name` prefix, the
  README table row and the `index.html` link are easy to miss.
  `tests/unit/examples.test.mjs` checks them.
- When changing the body of any `tests/examples/**/*.user.js`, bump
  its `@version` header. `scripts/sync-manager-scripts.mjs` (and the
  cross-manager specs) compares local `@version` against the installed
  copy with dotted-numeric ordering — without a bump the manager keeps
  the old body cached and `pnpm run test:e2e:tm` / `:vm` exercises
  stale code. Same goes for any other manager whose update story
  depends on `@version`.
- A patch-level bump (e.g. `1.1.0` → `1.1.1`) is enough; just make sure
  the new value compares strictly greater than the installed one.
