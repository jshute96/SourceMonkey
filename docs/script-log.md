# Per-script event log

- Each `StoredScript` gets its own event log.
- Entries are structured records about things that happened TO the
  script: refresh attempts, wrapper runtime errors, etc.
- Surfaced through the viewer's **Log tab**.
- NOT a general-purpose `console.log` capture for the userscript's
  own page output.

## Storage

- Backed by `chrome.storage.session` (cleared on Chrome shutdown).
- One key per script: `log:<scriptId>`.
- Value is a flat array of `LogEntry` records in append order.
- Hard cap: `LOG_CAP` (currently 500). Oldest entries are dropped on
  overflow.
- Sibling key `loglevel:<scriptId>` records the **highest level any
  entry in this log has carried so far** (`'info' | 'warning' |
  'error'`). Bumped on `appendScriptLog` only when the new entry's
  level is strictly higher than the stored one; cleared on
  `clearScriptLog` alongside the entries. Lives next to the log
  (rather than on the `StoredScript` row) so its lifetime exactly
  matches the entries that back it — Chrome shutdown drops both
  together. The sources page reads every script's row in one bulk
  `storage.session.get(null)` to drive the Status column without N
  per-script reads.

Notes on the storage shape:

- Single-array (rather than one-key-per-entry) keeps the log-pane
  render cheap — no scan-all-keys on open.
- Concurrent appends for the **same script** are serialized through
  an in-memory promise chain in `src/script-log.ts` so the
  read/modify/write window doesn't lose writes.
- Cross-script appends still run concurrently.

## Entry shape

```ts
interface LogEntry {
  timestamp: number;       // epoch ms
  level: 'info' | 'warning' | 'error';
  source: string;          // origin label, e.g. 'refresh-manual', 'wrapper'
  tabId?: number;          // present when the event originated from injected code
  message: string;         // human-readable; multiline OK
}
```

The viewer's table renders `tabId · source` together when `tabId` is
present, and just `source` otherwise.

## API

`src/script-log.ts` exports the public surface:

- `appendScriptLog(scriptId, input)` — async write. Promise resolves
  once the entry is persisted. Also bumps `loglevel:<scriptId>` when
  the new entry's level exceeds the stored max.
- `logScriptEvent(scriptId, input)` — fire-and-forget convenience.
  Swallows errors because the log isn't load-bearing.
- `getScriptLog(scriptId)` — async read.
- `clearScriptLog(scriptId)` — async wipe. Removes the log AND the
  `loglevel:` sentinel.
- `getMaxLogLevel(scriptId)` — async read of the persisted max
  level. Used by the userscript viewer to seed the Status row.
- `getAllMaxLogLevels()` — bulk read returning a `Map<scriptId,
  LogLevel>`. Used by the sources page to drive every row's Status
  column in one storage round trip.

## Status column promotion

The persisted `StoredScript.status` plus the per-script max log level
drive the five-label Status column (`OK | INVALID | MISSING | WARNING
| ERROR`). Rules + priority order live in
[storage.md → Displayed status](storage.md#displayed-status-ui-level).

Plumbing notes specific to logging:

- The sources page listens for `chrome.storage.session.onChanged` on
  `loglevel:` keys and repaints affected rows without a full re-render.
- For scripts that land `invalid` / `missing`, refresh paths
  (`emitScriptOutcomeLog` in `script-updater.ts`) and the initial
  `addSource` path (`emitInitialLoadLogIfBroken` in `script-store.ts`)
  append an error-level entry so the Log tab always carries the
  detail behind the badge.

## What gets logged today

- **Refresh paths** (`src/script-updater.ts`):
  - `update check started` (info) — on every `runScriptCheck` entry.
  - `loaded new content (<size>)` (info) — when the new build has a
    different `loadedAt` from the prior.
  - `no change` (info) — only on manual refresh, to mirror the SW
    console behaviour. Opportunistic background checks don't append a
    "no change" row to keep the log from filling with poll noise.
  - Refresh errors (error) — `errorMessage` from the script-store
    pipeline (covers `@require` resolve/fetch failures too).
  - `refresh failed: <reason>` (warning) — a script that's still
    running from its cached copy but whose latest refresh failed
    (`status: ok` + `refreshError`; see
    [storage.md](storage.md#refresh-failures-keep-the-good-copy-running)).
    Emitted only on the transition (or when the reason changes), so a
    persistently-down source doesn't flood the log from background
    polling.
  - Source / refresh-all paths route per-script outcomes through the
    same helper so each affected script gets one entry.
- **Update probes** (`src/script-updater.ts`, source
  `probe-manual` / `probe-opportunistic`):
  - `newer version <v> at <update|download> URL (running <v>) — <url>`
    (warning) — an `@updateURL` / `@downloadURL` declares a version
    ahead of the copy we run. Emitted only when the newer version
    *changes*, so an upstream that's been ahead for a month doesn't
    add a row every check. Nothing is logged for a probe that fails,
    finds nothing newer, or is skipped as still-fresh. See
    [updates.md](updates.md).
- **Parser** (`extractStartupLogs` in `src/script-store.ts`, replayed
  by `emitScriptOutcomeLog` in `src/script-updater.ts`):
  - `unknown @grant entries dropped: <names>` (warning) — emitted
    once per loaded content version, immediately after the
    `loaded new content` row. Detection happens at parse time and is
    persisted on `StoredScript.startupLogs`, so SW restarts don't
    re-fire the row. A refresh that doesn't change the bytes adds
    nothing. Also mirrored into the page DevTools console via the
    wrapper's [startup-log channel](logging.md#page-console-startup-logs)
    on every matching page load.
  - On the first SW boot of a fresh Chrome session, a
    [boot-replay pass](logging.md#boot-replay) appends parser rows
    for every persisted script — without this the Log tab would be
    empty after a browser restart even though the diagnostics still
    apply.
- **GM_log fan-out** (handled in `installScriptMessageListener`):
  - `<rendered args>` (info, `source: 'gm-log'`, `tabId` attached) —
    one entry per `GM_log(...)` call. The script's own
    `console.log` line in the page DevTools still happens too; this
    is just the SW-side mirror so users browsing the sources page
    see what their script said without opening DevTools. Args are
    rendered page-side (primitives via `String()`, objects via
    `JSON.stringify`, joined by spaces) because
    `chrome.runtime.sendMessage` can't carry non-cloneable values
    and the Log tab is text-only.
- **Wrapper reports** (`src/background.ts`'s `recordScriptReport`):
  - `sm:start` (info) — wrapper reached its body in a tab.
  - `sm:swapped` (info) — reload fast-path swapped in newer content.
  - `sm:abandoned` (warning) — wrapper skipped because the SW told it
    to (rare).
  - `sm:error` (error) — runtime throw from the userscript itself.
    Details:
    - Wrapper captures `err.stack` on all three send-sites: sync-catch
      tail, async-error attribution listeners, reload-swap eval path.
    - Log entry's `message` carries the full stack when available.
    - V8 / SpiderMonkey prepend the summary line to the stack already;
      we only prepend the message ourselves when the stack doesn't
      already contain it.
    - The Log pane renders multi-line text via `white-space: pre-wrap`.

## What is NOT logged

- The userscript's own `console.log` output. We deliberately don't
  patch global console in the injected world; the user can open
  DevTools on the host page if they want that.
- Per-tab badge transitions. Those are noisy and already visible.

## Viewer Log tab

- Always present as the last tab in the tab strip.
- Selected → swaps the code pane for a log table. Switching back to
  any code tab restores the highlighted code view.
- Newest entries first. Sticky header row and a sticky "Clear log"
  toolbar button.
- Live updates: a `chrome.storage.onChanged` listener on the session
  area repaints the table whenever the script's log key changes —
  but only while the Log tab is the currently selected one.
- **Clickable stack refs:** every `<scheme>://…:L:C` reference in
  the message column whose URL matches a code tab's `sourceUrl`
  becomes a clickable anchor.
  - Clicking switches to that tab and jumps to gutter line `L`,
    with an accent bar at column `C`.
  - Matching is naive — V8's URL is trusted as-is.
  - `parseStackRefs` (`src/stack-link.ts`) is a pure URL extractor:
    it splits the message into plain-text and `{url, line, col}`
    ref runs for any URL with a recognized scheme (`sourcemonkey`,
    `http`/`https`, `file`). The viewer filters by matching URLs
    against its tabs.
  - The main tab carries `sourceUrl = buildSourceUrl(logLabel)`
    (`src/script-source-url.ts`) — the same string the injector
    hands to `//# sourceURL=` on the main-body entry.
  - Each `@require` tab carries `sourceUrl = buildRequireSourceUrl(logLabel, r.url)`
    (a synthetic `sourcemonkey://SourceMonkey/<folder>/<host>/<path>`
    URL) — the same string the injector puts in the entry's source
    map for that require. The require tab's `fileUrl` keeps the
    original fetched URL for display.
  - Raw frames never carry that require URL; see **Stack refs are
    source-mapped first** below.
  - Line 1 IS linkable, but its column-accent bar is suppressed —
    the wrap prefix (the `self.__smRun(id, function(__smE){…`
    + GM bindings + declaration preamble emitted by `wrapCombinedEntry`)
    shares that physical line, so the reported column points into
    the wrap, not user code.

## Stack refs are source-mapped first

### The problem

- `@require` bodies and the script body are concatenated into one
  injected entry (Mode A — see [injection-modes.md](injection-modes.md)).
- V8 stamps every frame from that entry with the script's own
  `//# sourceURL=`, at a **generated** line.
- It source-maps that for the devtools UI, but **not** for
  `err.stack` — and `err.stack` is the string the wrapper sends us.
- So an unmapped log line blames the `.user.js` at a line that
  typically falls inside its own metadata header.

### What the Log tab does

- Recomputes the entry's segment layout from the stored script, via
  the shared `composeSource` in `src/composed-source.ts`.
- Applies it with `remapStackRef` (`src/source-map.ts`) to each ref
  `parseStackRefs` found.
- Re-renders the ref text with the mapped URL and line, so the string
  the user reads names the real file. The generated number is an
  artifact of our injection and means nothing to the script's author.
- Routes the click to the tab that owns the mapped URL — which is how
  a stack ref reaches a `@require` tab at all.

### Why recompute rather than persist

- The inputs (require sources, body text, log label) are already on
  the `StoredScript` row the viewer loaded.
- A persisted map would be one more thing to invalidate on refresh.
- Both run paths share one layout, so there is one answer to
  "which file is generated line N?": `wrapCombinedEntry` and
  `buildSwapEvalBody` both put their whole preamble on generated
  line 0 and start user source at `USER_SOURCE_START_LINE`. The
  viewer never has to know which one ran.

### What is left unmapped, deliberately

- Frames from another file — the page, a sibling userscript,
  `__prelude.js`. They pass through untouched.
- Generated lines that belong to our wrap rather than to user code:
  the head, the `// @require` marker lines, the `;` ASI guards, the
  closing `});`. Guessing at a neighbouring line would point the user
  at unrelated code.
- Scripts with no `@require`. Nothing was concatenated, so nothing
  moved, and the reported lines are already original.
- Columns are passed through rather than mapped, and that is exact:
  composition moves whole lines and never code within a line.

## Lifecycle and reset

- `chrome.storage.session` is cleared by Chrome on shutdown, so logs
  do not persist across browser restarts. This is deliberate — the
  log is for "what just happened", not historical telemetry.
- `SourceMonkey.resetAllState()` (test surface) wipes session storage,
  which clears every script's log.
- Per-script wipes go through `clearScriptLog(scriptId)` (Log tab's
  Clear button calls this).
