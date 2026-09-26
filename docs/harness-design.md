# Userscript development harness: design

The harness lets a userscript repo develop, probe, and test scripts
with SourceMonkey's real semantics. The user-facing side is in
[harness-guide.md](harness-guide.md).

## The problem

- Most userscript testing is **interactive**: an agent (or a person)
  probes a site, injects the script as it exists so far, watches what
  happens over Playwright or the Chrome DevTools Protocol (CDP), edits,
  and tries again. Fast iteration matters more than a green suite.
- A typical homemade harness strips the metadata block and runs the
  raw body in the page's own world. Nothing a manager does exists
  there: no `GM_*`, no `@match`, no `@run-at`, no isolation. A
  hand-written stub file fakes a few `GM_*` calls.
- Running the real extension is faithful but needs coordination: a
  collection registered in a profile, a refresh when headers change,
  other scripts in the same profile adding noise.
- SourceMonkey contains nearly everything needed to inject a script
  with real manager semantics **without** the extension. The harness
  packages that, and adds a way to push scripts into the real
  extension without persistent state for the cases that need Chrome
  itself.

## Vocabulary

Terms used below, for readers who don't work in this repo.

| Term | Meaning |
| --- | --- |
| `src/` | TypeScript source of the extension, plus the plain-JS files injected into web pages (`userscript-prelude.js`, `wrapper-gm-runtime.js`, `wrapper-bridge.js`). |
| `dist/` | The build output. It **is** the unpacked extension: `manifest.json`, the HTML pages, icons, the Prism highlighter, and one compiled ES module per extension `src/*.ts` file. There is no bundler, so any module that doesn't touch `chrome.*` is importable from Node as-is. Unit tests and the validate CLI import it the same way. The harness itself builds into `lib/` instead. |
| `dist/generated-wrappers.js` | The injected JS files, minified to one line each and exported as string constants (`WRAPPER_PRELUDE`, `WRAPPER_GM_RUNTIME`, `WRAPPER_BRIDGE`). |
| `scripts/` | Node scripts run by hand or by package scripts: the build, the validate CLI, the examples server, the cross-manager sync tool. |
| `tests/fixtures/` | Playwright fixtures for this repo's own e2e suite: launching Chromium with the extension, the typed service-worker API, the example-page server. |
| `tests/examples/` | One directory per `GM_*` API or header feature, each with a page, a userscript, and a spec. Doubles as a compliance suite that also runs under Tampermonkey and Violentmonkey. |
| Service worker (SW) | The extension's background script (`background.ts`). Owns storage, registration with `chrome.userScripts`, and the SW half of every `GM_*` call. |
| Test surface | `self.SourceMonkey`, an object the SW exposes so tests can call production functions directly. Reachable only by evaluating code inside the worker (Playwright's `serviceWorker.evaluate`, or CDP). |
| Worlds | Chrome runs injected code either in the page's **MAIN** world (shares the page's globals) or an isolated **USER_SCRIPT** world (own globals, shared DOM). SourceMonkey picks per script from `@grant` and `@inject-into`. |
| Prelude | The per-script harness code injected ahead of the script: waits for the SW's go-ahead, enforces `@run-at`, runs the in-page URL matcher when needed, and attributes errors to the script. |
| GM runtime | `window.__SM_GM__`, one per document per world. The page-side half of every `GM_*` API. Per-script `const GM_x = ...` bindings delegate to it. |
| Bridge | When the runtime has no `chrome.runtime` (MAIN world), it talks through DOM events (`sourcemonkey-bridge-sync` out, `window.postMessage` replies back). In the extension a USER_SCRIPT-world relay forwards those to the SW. |
| CDP | Chrome DevTools Protocol. Playwright is built on it; it can also be driven directly over a WebSocket. |

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
| Wrapper builder: world choice, `@run-at`, the ordered code entries Chrome registers | pure half of `src/injector.ts` (`buildRegistrationSpec` and friends) | Yes, as the harness calls it (`src/harness/prepare.ts`) |
| Compile-only parse check | `src/harness/parse-check-node.ts` | Yes |
| Stored-value codec, `@connect` gating | `src/gm-values.ts`, `src/gm-connect.ts` | `gm-connect` yes; `gm-values` with a storage stub |
| Injected code as strings | `dist/generated-wrappers.js` | Yes |
| Compliance pages and specs | `tests/examples/` | n/a |

Two facts make the no-extension path cheap:

- **The GM runtime picks its transport at init.** With a
  `chrome.runtime.id` it uses `chrome.runtime`; without one it uses the
  bridge. The harness host answers both, with a stand-in
  `chrome.runtime` in the isolated world, in place of the SW; nothing
  on the page side changes.
- **`buildRegistrationSpec` returns the exact entries Chrome would
  register.** Injecting those as init scripts runs the prelude, the
  bindings, the `@require` bodies, and the script unchanged.

## Two backends

The harness offers the same operations over two backends. Both take
script **text or a file path**, never a collection.

### Push backend (no extension)

- The test process builds the entries in Node, injects them into a page
  as init scripts, and hosts a stand-in SW that answers the bridge.
- Works in any Chromium Playwright can reach, including the manually
  launched, CDP-attached browser a repo needs for sites with a login
  (a browser Playwright launched is refused Google sign-in).
- Deterministic: the caller knows exactly what was injected and when.
  No storage, no debounce, no other scripts.
- This is the default for interactive work and for specs.

### Extension backend (real SourceMonkey)

- The browser runs the real extension. The harness talks to the SW test
  surface, over Playwright when it launched the browser, over CDP when
  it attached to one.
- Test-surface calls write **scratch scripts**, whose only copy is
  their text in storage (see
  [storage.md](storage.md#container-collections) for the rows):
  - `writeScratchScript({ text, name? })` installs the text into a
    built-in **Scratch** collection and returns the row's id, status, and
    diagnostics, after registration has completed (the wrapper names
    the changed rows to the sync itself rather than waiting for the
    storage event to). The name (one the caller gives, else the
    `@name`; `sm-dev` passes the file's basename) is the identity:
    rewriting it replaces the text in place, keeping the row's id and
    GM values, so the next reload runs the new version. Names that
    differ only in punctuation collapse into one identity.
  - `clearScratchScripts()` drops that collection's rows and their
    `GM_*` values.
  - `soloMode(on)` disables every other collection while on and
    restores the previous enabled set when off, so a scratch script runs
    alone without touching the user's real collections. For a
    throwaway profile, `resetAllState()` wipes everything instead.
- `sm-dev start --extension` reaches the worker through Playwright, which
  lists an extension's service worker on a CDP-connected browser as
  well as a launched one. The
  worker's URL is known up front, since the manifest's fixed `key`
  fixes the extension id; an idle worker is woken by opening the
  collections page. Reports are the script's own Log tab entries,
  polled, and only those added after the push are printed. `--solo`
  turns solo mode on for the run and off after; `sm-dev clear
  --extension` drops the scratch scripts.
- Use this backend for what only Chrome can answer: CSP, real world
  registration, Chrome's own match gating, cross-tab broadcast, and the
  real identity of a `GM_xmlhttpRequest` (extension cookies, no
  `Origin`, `Sec-Fetch-Site: none`).

## Components

### Package plumbing

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

### `src/harness/`

Compiled to `lib/harness/`. Node-side except for the strings they send
into pages.

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
  - `scripts/validate-userscripts.mjs` has its own driver (it has an
    offline dependency root the harness doesn't) and shares the Node
    parse checker in `src/harness/parse-check-node.ts`.
- **`host.ts`**: the stand-in SW.
  - Answers every message type the SW handles for injected code:
    `sm:check-pending` (with a values snapshot when the script needs
    one), `sm:start` / `sm:error` / `sm:abandoned` (recorded), batch
    writes and resync for storage, XHR start and abort, tab open and
    close, downloads, notifications, menu register and unregister, log,
    focus.
  - Pushes back what the SW pushes: value updates to the other pages
    running the script (attached, holding it, URL matching), XHR events, tab
    closed, menu fired, notification events, download events, and
    `urlchange` from CDP's `Page.navigatedWithinDocument`.
  - `pageOf(record)` says which attached page sent a report. It is kept
    in a `WeakMap` rather than on the record, so records stay plain
    data a test can compare.
  - `GM_openInTab` opens a real page in the same browser context (so a
    test can wait for it), `window.close` and `window.focus` act on the
    page, and `GM_download` fetches the bytes from Node into a
    directory the host names, reporting the extension's event shapes.
    `GM_notification` records the call and resolves with an id; a test
    delivers the click or close.
  - Uses the real pieces where they exist: the value codec, the
    `@connect` gate, and `runXhr` itself, the extension's request
    driver, run on Node's `fetch`. The browser context's cookies for
    the target are copied onto the request unless it is `anonymous`,
    and forbidden headers pass straight through (`runXhr`'s
    `forbiddenHeaders: 'passthrough'`) where the extension would use a
    declarativeNetRequest rule. No CORS limit, but not the extension's
    request identity either.
  - Exposes state to tests: seed and read values, the recorded tab
    opens, menu commands (and `fireMenuCommand`), notifications (and
    `clickNotification` / `closeNotification`), downloads, requests,
    window calls, and the start / error / skipped reports.
- **`inject.ts`**: attaches a prepared script to a Playwright `Page`.
  - Gives each world its own channel, so the page sees only what it
    would in the extension:
    - **Isolated world**: an init script installs a stand-in
      `chrome.runtime` (`id`, `sendMessage`, `onMessage`). It calls a
      CDP binding (`Runtime.addBinding`) exposed only in that world,
      and replies and pushes come back by `Runtime.evaluate` into it.
      The page can neither read nor forge this traffic. A request
      nobody answers rejects after 30 seconds, as the MAIN bridge's do.
    - **MAIN world**: a top-frame init script forwards bridge events to
      its own binding, captured before page scripts run so the page
      can't swap it out; replies and pushes are posted with
      `postMessage`, as the extension's relay does.
  - Treats MAIN-world traffic as possibly forged, as the worker does:
    - `host.ts`'s `pageMayActAs` honors a bridge request only for a
      MAIN-world script on this page, matching its URL, that granted
      an API the request uses (the worker's `bridgeMayActAs`).
    - Pushes reach MAIN world only when addressed to a MAIN-world
      script (`smWorld`) or carrying nothing script-scoped.
  - Uses one CDP session rather than Playwright's own init scripts, so
    registration order (channels first, then the entries) is the
    execution order.
  - Adds the entries as init scripts in the script's world with
    `Page.addScriptToEvaluateOnNewDocument`, naming a `worldName` for
    USER_SCRIPT, which Playwright's own init scripts cannot do. Each
    entry is wrapped in a top-frame guard, since CDP init scripts run
    in every frame and `chrome.userScripts` registrations do not.
  - Always attaches the in-page matcher block to the prelude config
    (`buildRegistrationSpec`'s `inPageMatcher` option), so the prelude
    decides per document where Chrome's registration `matches` would
    have. The prelude's miss is silent, so the host evaluates the same
    rules on every navigation and records the rule that kept the script
    off the page.
  - Survives reloads (init scripts persist), so the interactive loop
    costs one keystroke. Re-injecting a script removes its
    old entries first.
- **`tab-badge.ts`**: the badge `sm-dev start` draws over each
  controlled tab's favicon. Harness mode only; under `--extension` the
  toolbar badge does this job.
  - Count and color follow the extension's toolbar badge
    (`computeBadge`): the scripts matching the document's URL, plus any
    that started or failed there. Red for an error, orange while
    expected and started disagree, else green. No purple: the run
    reloads the tabs a change affects.
  - Reports count for the document they arrived during. The attachment
    keeps recent documents by loader id, with the times each was
    showing, so one restored from the back/forward cache keeps its own.
  - Drawn in the isolated world, top frame only, on a canvas over the
    site's icon.
    - The site's icon links get their `rel` renamed, since Chrome
      doesn't reliably pick the last of several icon links.
    - A site changing its icon later is followed, including code that
      finds the badge's link as "the" icon and sets its `href`.
    - Only `<head>` is watched, and only icon links are looked at.
  - Same-origin icons load in the page. A cross-origin one would taint
    the canvas, so the page asks the run through a binding; the run
    fetches it with the browser context's cookies and hands back a
    `data:` URL. Images only, so the binding can't be used to read
    pages past `@connect`. A small cache keeps successes only.
  - The run pings every 2 seconds, through one pair of host listeners
    for all tabs. On dispose it greys the badge at once.
  - After 6 seconds without a ping (a killed run), the page greys it
    itself. A hidden tab's timers are slowed, so there it can take up
    to a minute. A late timer in a showing tab (a dialog, a restore)
    restarts the wait instead of flashing grey.
  - A tab taken over from an earlier run shares that run's isolated
    world, so the old badge code carries on with the new pings. An
    owner mark on the root element keeps a second copy from drawing.
  - Opt-in (`PageAttachment.showBadge`), and best effort, so specs
    using the fixture see the site's own icon, and a failed badge
    doesn't fail a tab.
- **`fixture.ts`**: the `@playwright/test` extension consumers import.
  Wraps the three above into `loadUserscript`, `gm`, `reports`, and a
  `serveHtml` helper that routes a saved HTML file at its original
  URL so `@match` and relative URLs still hold. HAR replay is left to
  Playwright's own `routeFromHAR`. `tests/harness/fixture.spec.ts`
  drives it from `lib/` the way a consumer would.
- **`wait.ts`**: the `wait` command, and when a tab has settled, for
  it and the waits after `start`, loads and actions. The guide's
  "Waiting" section lists the signals; here, where each comes from:
  - The quiet window counts from the later of the last change and when
    the wait began, so what an action sets off a moment later on a
    quiet page is waited for.
  - The DOM: a `MutationObserver` the attachment (`inject.ts`) adds to
    each top-frame document at its start, in the isolated world,
    recording when the DOM last changed and where. The favicon badge's
    own `data-sm-*` edits don't count.
  - The page's requests: Playwright's request events, tracked per page
    by the attachment from the start, so a wait on a quiet page returns
    at once.
  - The scripts: the host's start/skip/error reports since the
    document first started, from the scripts it runs (`scriptsInDocument`:
    injected before it started, or into it directly) whose rules match
    its URL. One that doesn't match may never report, as on
    `about:blank`. A document the back/forward cache restored doesn't
    run its scripts again, so its first start counts.
  - The scripts' `GM_xmlhttpRequest` records, for the current
    document.
  - A look into the page that takes over a second counts as busy (a
    long script); a dialog ends the wait, since the page stops on it.
  - `wait log` reads the run's output history (`OutputHistory`, kept
    by `Remote` in `run.ts`, the last few thousand lines), from where
    the previous command began (`previousStart`, kept by
    `commandRunner`, and not moved by a command that only looks or
    waits).
    - Only what the page and scripts printed goes in it. A command
      runs inside `inCommand` (an `AsyncLocalStorage`, Node's per-call
      context), and its own replies are kept out; page and script lines
      arrive through events outside it.
  - A command fails in a way that stops a line when an explicit `wait`
    gave up (`runConsoleCommand` returns false) or it printed an
    `ERROR:` line (a typing mistake). The run then ends its reply with a
    marker line (`COMMAND_FAILED` in `runs.ts`) that `sendLine` turns
    into a failure, not output.
  - A tab whose load already gave up (`stalled`, set by `loadInTab`)
    isn't waited on again after it.
- **`tab-refs.ts`**: naming and picking a run's tabs (`T2`, target and
  DevTools page ids), the current tab, and the dialog message, shared
  by `console-commands.ts` and `wait.ts`.
- **`page-commands.ts`**: the run commands that drive and read a tab's
  page (`click`, `type`, `key`, `eval`, `snapshot`, `screenshot`,
  `savehtml`, `probe`, `logs`), on the run's own Playwright connection.
  - Real input comes from Playwright's locators and keyboard; the
    accessibility tree from `ariaSnapshot`.
  - Actions then wait for the page to settle: a navigation they
    started to reach its DOM, then a MutationObserver in the page quiet
    for 100ms, within 3 seconds.
  - `eval` goes through the tab's own CDP session
    (`PageAttachment.evaluate`), in the page's default context or the
    isolated world the harness keeps for scripts. Results print as
    JSON, or as the DevTools console describes an element or function.
  - Each command's flags are listed in `COMMAND_FLAGS`, and any other
    `--` word is refused before the command runs (`commandFlagMistake`).
    For the commands that end in free text, only the words before it
    are looked at. `sm-dev`'s up-front check uses the same function.
  - Typed lines are split into words as a shell would, except that a
    quote opening inside a word stays in it (`a[href="x"]`); a command
    from another shell passes that shell's own words and directory
    instead, so its quoting and relative paths hold.
  - Every console line and page error is kept per page (the newest
    thousand) for `logs`, beside the filtered stream.
  - A command that opens a dialog would wait on it for good (the page
    is stopped), and hold up the `accept` queued behind it. So each
    action races the tab's dialog tracker (`untilDialog`, as `menu`
    does), and returns once a dialog is up. The settle wait's limit is
    kept in Node too, since a stopped page's own timer never fires.
  - Keys sent over CDP go to the renderer, so Chrome's own shortcuts
    never fire. The one that matters for scripts is Escape leaving
    fullscreen: after an Escape, `key` checks `fullscreenElement` and
    says how to exit when the page is still fullscreen.
- **`snapshot.ts`**: what `snapshot` adds to Playwright's tree.
  - Refs: the tree is taken in Playwright's `ai` mode, where Playwright
    gives each element a ref, `(f<n>)?e<n>`.
    - `e<n>` counts elements within a document. An element keeps its
      ref in later snapshots unless its role or name changes.
    - `f<n>` is the number of the document's frame on the run's
      connection; frame 0 goes without. Each new document takes the
      next number: a reload, a navigation, each iframe, and other tabs
      too, so the numbers only go up, with gaps.
    - A page restored from the browser's back/forward cache brings its
      old document back, and with it the old number.
    - The numbers start again with each `sm-dev start`.
  - A ref is looked up through the iframes the latest snapshot showed
    it in, each step `:root >> aria-ref=…`, never by its prefix.
    - Playwright finds a ref's frame by that number, and a page restored
      by Back keeps refs numbered for a frame Playwright has since
      renumbered ("Invalid frame in aria-ref selector").
  - Each ref's line gives the label commands say back for it
    (`link "past"`), noted with the frames it's in.
  - Each page's latest snapshot is noted with its document's
    `performance.timeOrigin`, new with each load. A ref used after a
    load says so, not that no element has it, since Playwright's own
    record of the snapshot went with the old document.
  - `[cursor=pointer]` (the mouse shows a hand) is dropped from links
    and buttons, which always have it.
  - Playwright resolves refs against the latest snapshot only. So a
    snapshot of part of the page is followed by a quiet one of the
    whole, which keeps the rest's refs working (an element keeps its
    ref across snapshots).
  - `--visible` takes the tree with boxes and keeps lines whose box
    meets the viewport, plus their parents. A frame's boxes are offset
    by the frame's, and clipped to it.
  - The quiet snapshot doubles the cost of `snapshot <selector>` on a
    large page. It's skipped for `body`, and a failure only costs refs.
  - `--css` works out a selector in the page for each ref, one
    Playwright call each (about 2ms), so large trees are slow.
    - Uniqueness is counted across open shadow roots too, as
      Playwright's CSS engine matches there.
    - Elements in frames or shadow roots get none, since the commands'
      selectors can't reach into either.
- **`save-html.ts`**: a page's DOM as a standalone file, for the
  `savehtml` command and the fixture's `saveHtml`.
- **`cli.ts`** (`sm-dev`) and **`run.ts`**: the interactive tool,
  built on the same modules and Playwright's `connectOverCDP` (or a
  launched Chromium with `--launch`). Commands are listed in the guide.
  `run.ts` is its own module so the Node-only commands never load
  Playwright. The `--extension` flag switches it to the extension
  backend.
  - A line can hold several commands, split on `--` before anything
    else is parsed. Each has `--run` taken out first, which carries on
    to later commands, as does the id a `start` gets.
  - `--help` anywhere on the line is found first: the help for each
    command named, and nothing run or checked.
  - `start` is refused anywhere but first, before anything runs. So a
    `start` never inherits another command's `--run` (which would make
    it replace that run), and a line never has a run it will stop at
    the end alongside an interactive one.
  - A name that isn't an `sm-dev` command but is a typed one goes to
    the run, as `send` would send it.
  - A connected browser is attached with `noDefaults`, which keeps
    Playwright's test overrides off the developer's own profile:
    - downloads rerouted to a temp folder that is deleted on disconnect;
    - every tab reporting focus;
    - a forced light color scheme.
  - Tab reuse (`openRunTab`): the tabs runs opened are recorded in a
    file in the runs directory (see `runs.ts` below) with the owning
    pid, so a later run can take over a finished run's selected tab. A
    tab carries no mark a page couldn't fake, hence the file.
  - Opened tabs (`FollowedTabs`): a tab the run's tab opens (link,
    `window.open`, `GM_openInTab`), and any tab those open, gets its
    own attachment on the same host with every loaded script.
    - Found by Playwright's `popup` event, plus a hook on the
      attachment for `GM_openInTab`, whose tab has no opener.
    - Tabs the person opens have no opener, so they are left alone.
    - Playwright reports a tab only once its document has committed,
      so the scripts also run in that document (`runImmediately`). An
      earlier run-at than idle may run late there, and the run says so.
    - Link and `window.open` tabs stay open when the run ends, as
      under the extension. `GM_openInTab` ones still close with the
      opener's attachment.
    - It also holds T1, the run's own tab, and hands the commands the
      list of open tabs. With `--notab` there is none at first, and
      the first tab `newTab` opens becomes T1.
    - `newTab` opens a tab for `newtab` and `--all`, attached before
      its first page loads. It takes the tab's number before awaiting
      anything, so tabs opened together are numbered in call order.
    - Host output from a followed tab gets its `[T<n>]` prefix through
      `host.pageOf`, and a map of numbers that outlives the tab, so a
      late report (a request finishing) still names it.
    - The close listener goes on before any await, so a tab that closes
      during setup is dropped, not listed forever.
  - Changing scripts (`load`, `update`, a `--watch` save) all go
    through `FollowedTabs.apply`:
    - Every open tab gets the new set, in load order, so run order
      stays the same.
    - Only the tabs a changed script affects are reloaded: it was
      running there (`host.isRunning`), or its new rules match the
      tab's URL. They reload together; one waiting on a dialog is
      skipped and named, since its reload would hang.
    - Scripts before the first changed one stay attached, so a tab
      that isn't reloaded never loses them; the rest are re-added.
    - The file watcher restarts on the new set, so a loaded script,
      or a new local `@require`, is watched too.
  - `load`, `update` and `--watch` saves run one at a time through one
    queue in `runInHarness`, since each reads the script list, awaits,
    and replaces it. A tab still being set up is left out of `apply`
    until its setup has caught up with the latest set.
  - `update` skips a script whose files' modification times haven't
    changed since it was read, so a touch still forces one.
  - Tabs without scripts (`newtab --noscript`) are attached and
    followed like any, but get no injection, no badge, and no part in
    `load` / `update`; tabs they open inherit that. The harness's
    bridge is still attached to them, so a page could tell.
  - `open` / `reload` `--noscript` / `--script` switch a tab's mode for
    good (`FollowedTabs.setNoScript`):
    - Its scripts come off or go back on (the current set), and so
      does its badge, whose page script is unregistered too
      (`hideBadge`).
    - In turn with `load` / `update` / `--watch` saves (the `serial`
      queue), since they change what a tab has too. Refused while the
      tab is still being set up.
    - The page showing keeps its scripts until the load that follows;
      if that load fails, they run on there.
    - A tab switched off counts as running no script, whatever the
      host last heard from it.
- **`runs.ts`**: the runs active on this machine, for `sm-dev list`,
  `stop` and the commands sent to a run. Node-only, so those commands never load
  Playwright.
  - A run's id is the lowest free `D<n>`. It takes one by listening on
    its socket, which only one process can. The record is written
    after, so `list` never shows a run it can't reach yet.
    - A socket file nothing listens on (a killed run's) is cleared and
      listened on under a `D<n>.clearing` lock directory, held until
      the listen. Otherwise a second run could delete the first's
      freshly bound socket.
    - A lock already held means trying the next number, so one left by
      a killed run costs a number, never a hang.
    - `start --run Dname` takes that id the same way, or fails if a run
      holds it; `cli.ts` stops that run first.
  - A run waiting for commands writes a record file (id, pid, start
    time, browser, scripts) and listens on a Unix socket (a named pipe
    on Windows), both in a per-user temp directory (`sm-dev-runs-<user>`,
    by user name, or uid where there is none).
  - A record is deleted when listed if its pid is gone, or its socket
    refuses connections (the pid may have been reused). The run deletes
    its own on the way out.
    - The delete re-checks first, since a new run may have taken the
      id: the record only if it names the same pid, the socket only if
      nothing listens on it.
  - The directory is created `0700`. Before anything in it is trusted
    (records, sockets, tab records), it is refused if another user owns
    it or can write in it, since `stop` signals the pids its records
    name. `SM_DEV_RUNS_DIR` moves it, for tests.
  - `start --detach` (in `cli.ts`) starts the same `start` command
    again as a detached child process, and returns once the child is
    ready.
    - `start` followed by other commands on the line does the same
      without `--detach`, and stops the run once they are done. Its
      output stays out of theirs that way.
    - The child's stdout and stderr go to a log file
      (`detached-log.ts`); the parent prints the file as it grows,
      without the line timestamps.
      - Named `sm-dev-<timestamp>.log` in `/tmp/sm-dev-logs-<user>`
        (`SM_DEV_LOGS_DIR` moves it, for tests), with SeeWhatISee's
        timestamp format.
      - Created exclusively; a name already taken moves the timestamp
        on a millisecond.
      - The child stamps each line it writes, by wrapping
        `process.stdout.write` and `process.stderr.write`.
      - `Remote` in `run.ts` marks a sent command that changes
        something there as `> command`, for where it happened in the
        stream. A foreground run marks it as from another shell
        instead, since its own are typed at its prompt.
      - `sm-dev stop` sends `stop`, which the run takes as `quit`, so
        the log says what was typed.
      - Kept after the run ends.
      - Once the run has its id, `sm-dev-<id>.log` is pointed at it: a
        relative symlink, made under a temp name and renamed over the
        old one.
    - The child learns it is detached from `SM_DEV_DETACHED_LOG`, and
      says it is ready over the Node IPC channel (`onReady`, called
      where sent commands start being taken). The parent then exits;
      a child that exits first passes on its exit code.
    - Its record carries `detached` and `log`. The next `--detach`
      (unless `--new`) stops runs marked `detached`.
      - The old run is stopped before the new one starts, so its tab
        is free to reuse. A new run that then fails leaves neither.
    - The parent handles Ctrl-C, SIGTERM and SIGHUP (sent when the
      terminal closes) while the child starts, by ending the child and
      exiting 130. A line-scoped run is stopped on the same signals.
    - A child whose parent has gone (a tool timeout) still becomes
      ready; with no channel to report on, it just runs on.
    - The idle timer is restarted as each sent command starts and ends
      (`onActivity`), and stops the run as `quit` would.
  - `stop` expects the run's `Stopping run D1` line first. With it, it
    waits a minute for the teardown before `SIGTERM`; without it (no
    answer in 15 seconds, or a close without it), it signals at once.
    Its connection is dropped either way, so `stop` itself never
    hangs.
  - One line per connection: the command goes in, its output comes
    back, and the run ends the connection.
  - In `run.ts`, `Remote` feeds sent lines through the same
    `commandRunner` queue as typed ones, so they never interleave.
    - The reply ends when the command does, with no wait after it.
      Commands wait out what they set off that has a known end instead.
    - Every page load a command or `--watch` save makes (`loadInTab`)
      waits for each script in the tab to report starting, being
      skipped or throwing in the new document
      (`HarnessHost.untilReported`), or for a dialog.
      - Only reports stamped at or after the new document's start
        count, so late ones from the old document don't end it.
      - A hash-only change loads no document, and waits for nothing.
      - A 10-second backstop, counted from the load, covers a script
        that never reports. It is not how the end is found.
    - `drain` (in `inject.ts`) then makes a round trip through each CDP
      session, after a `setTimeout(0)` in the page.
      - Needed because a script reports its start before its body runs,
        and a MAIN-world menu handler runs a task after its push.
      - Console lines come on Playwright's session and reports on the
        harness's, so each gets its own round trip.
      - Used after page loads, `menu` fires and `eval`.
    - Inspecting commands (`onlyInspects`: `status`, `values`,
      `snapshot`, `logs`, `tabs` / `menu` listings and so on) answer
      the sender alone. Their lines go through the `commandOutput`
      async-local store, so the run's stream never shows them.
    - Commands that change things are echoed in the run's stream and
      print there. Their sender also gets what the page and scripts
      print during the command's turn.
    - `quit` is held open until the run has ended, so `stop` prints its
      end line and knows it's done.
    - Lines arriving before the page has loaded wait for it.
    - Once the run starts tearing down, sent lines are refused.
  - A closed stdout (`EPIPE`) ends a run through the same stop as
    Ctrl-C; other commands just exit.
  - `stop` falls back to `SIGTERM`, which `start` handles like Ctrl-C
    (on Windows it kills outright, with no cleanup).
    Either signal drops both handlers, as `quit` does, so a second one
    during teardown kills the run.
- **Dialogs in other tabs**: `run.ts` gives every page of a connected
  browser a dialog listener that does nothing.
  - Why: Playwright dismisses any dialog nobody listens for, in every
    tab it's attached to, the person's own included.
  - And when that dialog is gone before the dismiss lands, the error is
    unhandled, and ends the run.
  - The run's own tabs also get the dialog tracker, which answers them.
- **`stuck-tabs.ts`**: before `start` connects over CDP, finds tabs
  whose page doesn't answer, and waits for them.
  - Why: Playwright's connection isn't ready until it has set up every
    tab, and a tab showing a dialog answers nothing, so it hangs until
    Playwright's 30-second timeout.
  - No CDP call reports a dialog that opened before the connection, or
    answers one: `Page.enable` stalls too, and
    `Page.handleJavaScriptDialog` says none is showing.
  - So each tab is sent `Runtime.evaluate('1')` on a side connection,
    and one quiet for 2 seconds is named: a dialog, or a busy page. (A
    page paused in the debugger still answers.)
  - The stuck tabs are asked again each second.
  - `sm-dev` handles Ctrl-C and SIGTERM only once the run has connected,
    so during the wait they end it at once, with nothing to clean up.
- **`cdp-proxy.ts`**: a CDP endpoint that shows a client only the run's
  tabs, for the `--devtools` server to connect to.
  - Why: DevTools' Puppeteer attaches to every tab in the browser, and
    its connection isn't ready until each has reported the page inside
    it. One of the person's tabs that never answers (seen with frozen
    background tabs, and tabs on a dialog) stalls every DevTools call.
  - Each client gets its own connection to the browser. Traffic passes
    through, except events about other tabs, which are dropped, and
    `Target.getTargets`, which is filtered. Tabs the browser attaches
    to that connection anyway are let run (if paused) and detached.
  - A tab is shown when the page inside it is one the run allowed.
    Chrome lists a tab and its page under unrelated ids, and doesn't
    keep a tab's own URL up to date as its page navigates, so the page
    is found on a side connection: attach to the tab, let it report its
    page, detach (3 seconds).
    - Tabs are asked when a page is allowed whose tab isn't known yet,
      a few at a time, each once. A tab that doesn't answer (a frozen
      one) is asked again only while an allowed page's tab is unknown.
    - Asking is done by the proxy alone; the client never sees those
      tabs.
  - Knowing the run's tabs before the client connects keeps them in
    the client's initial attach, which Puppeteer waits for, rather than
    arriving after it.
  - A tab not allowed yet is held for 30 seconds, not dropped, since
    the run only claims a tab its page opened once it's loading. One
    claimed after it was let go is attached again. Tabs the client
    opens itself (`new_page`) are allowed at once.
  - A held tab runs meanwhile: a person's new tab can't sit paused
    waiting for a claim. So a tab claimed later loses its
    pause-on-start, and the client may miss the start of its first
    load.
  - Attaches the client asks for itself (Puppeteer's extra session per
    page) pass through, with their sessions.
  - Workers, service workers (extensions' included) and the browser
    target are hidden too; the client still reaches a page's own frames
    and workers through the page's session.
  - The client side is a small WebSocket server of its own (handshake
    and text frames), since the harness has no WebSocket library; the
    browser side uses Node's WebSocket client.
- **`devtools.ts`**: `start --devtools`, a Chrome DevTools background
  server per run, and each tab's page id in it.
  - The server connects through `cdp-proxy.ts`, not to the browser.
  - Started with the `chrome-devtools` command, under the run's id as
    its session, so an agent's own calls reach the same server.
  - Then called over the server's socket directly: a JSON request and
    reply, each ended by a NUL, as the command itself does. A command
    per call would cost a Node startup each time. The protocol is the
    package's own (followed as of 1.10), not a documented one.
    - Calling over the socket also never starts a new server, where the
      command would start one with its own Chrome if the run's had
      died.
  - Each call gets 5 seconds, the first 15: it is when the server
    connects to the browser. DevTools runs one call at a time, so one
    of the run's tabs not answering it holds up everything; the run
    says so once, naming both causes, since a slow connect looks the
    same.
  - On the way out it is stopped before the tabs are let go, so a
    lookup in flight has its calls cut off and can still delete its
    markers. The server is then killed (`SIGTERM`), not asked to stop,
    which would mean waiting behind a stuck call. It cleans up its own
    socket and pid file on `SIGTERM`.
    - The pid is the one the server reports over its socket (`status`),
      not its pid file's: a server that died uncleanly leaves a file
      whose pid may be another process's by now.
  - Not on Windows: the server's files and signals are only followed
    as they are on Linux and macOS.
  - DevTools gives no id sm-dev can match to its tabs: its page ids are
    a counter in the server, in the order it first sees pages, and its
    `list_pages` has only id, URL and title. So each unmapped tab gets
    a marker in its page's main world (the only world `evaluate_script`
    reads), the pages with a matching URL are read for it, and the
    markers are deleted.
  - The marker is `<run>:<random token>:<tab number>`, so a leftover
    from another run or pass never matches.
  - Mapping runs a moment after tabs open (batched), and again every
    two seconds while tabs are left unmapped (loading, on a dialog, a
    stuck call), a few times per tab. A tab out of tries is named; its
    next page load gives it its tries again.
  - Started with Google's usage statistics, CrUX lookups (Chrome's
    field-performance API) and update checks turned off.
  - Off by default: DevTools emulates focus in the pages it sees (the
    run's), and `evaluate_script` answers dialogs.
- A page stopped on a dialog answers no CDP call until it is answered.
  So `load` / `update` refuse while one is open, and
  `PageAttachment.dispose` gives up on the page after a second; detaching
  the session drops what it registered anyway.
- **`console-commands.ts`**: the commands typed while `start` streams,
  and the terminal prompt output is drawn around.
  - Each kind of thing has its own style of name: scripts `1`, tabs
    `T1`, menu commands `M1`, with `T2.` in front to name one on
    another tab. A bare number only ever means a script; one typed
    where a tab or menu command belongs gets a "Did you mean T2?" hint.
  - A `T<n>.` split only happens before a number or `M<n>` (or, for
    `menu`, a label), so a file name like `t1.user.js` stays a script.
  - Per-tab state (started or skipped, menu commands, errors) is the
    host's reports filtered by `pageOf`. A script counts as running on
    a tab when its last report there is a start rather than a skip.
  - Menu commands fire by record (`fireMenuEntry`), not by id, since
    two tabs can register the same custom id.
  - A script's default page (`defaultPageUrl` in `prepare.ts`) is
    the one `start` opens when given no URL; `open`, `newtab` and
    `--all` use the same one.
  - `DialogTracker` listens for page dialogs, because Playwright
    dismisses any dialog nobody listens for, which answers a script's
    `prompt()` with Cancel. Dialogs stay open for the person or a typed
    `accept` / `dismiss`.
- **`command-lines.ts`**: turns input lines into commands, for the
  prompt, piped input, and a list sent in one go (`parseCommandList`).
  - `eval ... {{` opens a multi-line block and a line of just `}}`
    closes it. Not `{` / `}`: a line of just `}` ends any JavaScript
    function.
  - The block reaches `eval` as its first line, a newline, then the
    code with its line breaks kept, so `//` comments still work.
  - Outside a block, blank lines and `#` comments are skipped.
  - A list is checked in full before any of it runs, so a `{{` after
    another command, or a block never closed, runs none of it.
  - `sm-dev send` sends a list's commands one connection at a time, in
    order. `send -` feeds stdin through a `CommandAssembler` instead,
    sending each command as it completes rather than checking the list
    first. A block's newlines survive the trip, since the message is
    JSON.

### Service-worker additions

- `writeScratchScript`, `clearScratchScripts`, `soloMode` on the test
  surface, as above. The Scratch collection is a normal `scripts`
  collection at a fixed path, so the collections page and viewer show
  it like any other and the Log tab works unchanged.
- No new message transport into the extension: Playwright's worker
  handle serves both a launched and a CDP-connected browser.

### Compliance check for the host

- A `harness` project in `playwright.config.ts` runs `tests/harness/`
  (the harness's own specs) and `tests/examples/` on a plain Chromium,
  beside the `sourcemonkey`, `tampermonkey`, and `violentmonkey`
  projects. The manager fixture's `harness` backend prepares every
  script under the example directory and injects them into each page
  the spec opens (`tests/fixtures/manager.ts`). Each example directory
  exercises one API through the public surface.
- The stand-in SW is measured against the real one by the same
  specs, and a divergence fails a test instead of surprising a script
  author. One example is skipped there: the wire-header report, which
  measures a browser's request and says nothing about a request sent
  from Node. The two examples that check SourceMonkey-specific values
  (`GM_info` fields, the `@connect` refusal message) run, since the
  harness produces them with the extension's own code.

## How a userscript repo uses it

Details are in the guide; the shape is:

- It installs `github:jshute96/SourceMonkey#<tag>` as a dev dependency,
  with `sourcemonkey` allowlisted under `allowBuilds` in
  `pnpm-workspace.yaml` so the `prepare` build runs. While developing
  both, it uses `file:../SourceMonkey` with
  `dependenciesMeta.injected`.
- Its own fixture file keeps any browser-connection logic (a repo
  policy, not a harness concern) and re-exports `test` / `expect` from
  `sourcemonkey/harness`.
- Its specs are ES modules (`.mjs`, or `"type": "module"`), since
  SourceMonkey is written as ESM.
- Its agent instructions: run `sm-dev start` while iterating, write a
  spec on the harness fixture once the script is confirmed, and use
  `--extension` for the request-identity and Chrome-only checks.

## Platform behavior the design relies on

Each was checked in a throwaway script before the harness was built:

- **Isolated-world init scripts over CDP work beside Playwright.**
  `Page.addScriptToEvaluateOnNewDocument` with a `worldName` runs in
  its own world (separate globals, no `chrome`), fires again on reload,
  can be evaluated into from a CDP session by its context id, and a DOM
  event it dispatches is heard by a MAIN-world listener. Playwright's
  own `addInitScript` keeps working on the same page.
- **pnpm builds a git dependency's `prepare` script**, but only when
  the consumer allowlists it under `allowBuilds` in
  `pnpm-workspace.yaml`. The key is matched against
  `<name>@git+https://…#<sha>`, so a bare name does not match; the
  full key does, and so does the glob `sourcemonkey@git+https*`. The build
  runs in pnpm's clone, with the package's dev dependencies installed
  there.
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

- Whether opened tabs should get exact `document-start` timing, via
  a raw CDP connection of our own that holds each new tab until the
  scripts are in.
- Whether the Playwright fixture should follow opened tabs too, as an
  opt-in.
- Whether the package should be published to npm, which would remove
  the consumer's `injected` workaround and the build allowlist.
