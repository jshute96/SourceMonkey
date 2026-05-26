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
  once the entry is persisted.
- `logScriptEvent(scriptId, input)` — fire-and-forget convenience.
  Swallows errors because the log isn't load-bearing.
- `getScriptLog(scriptId)` — async read.
- `clearScriptLog(scriptId)` — async wipe.

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
  - Source / refresh-all paths route per-script outcomes through the
    same helper so each affected script gets one entry.
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
    is just the SW-side mirror so users browsing the options page
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

## Lifecycle and reset

- `chrome.storage.session` is cleared by Chrome on shutdown, so logs
  do not persist across browser restarts. This is deliberate — the
  log is for "what just happened", not historical telemetry.
- `SourceMonkey.resetAllState()` (test surface) wipes session storage,
  which clears every script's log.
- Per-script wipes go through `clearScriptLog(scriptId)` (Log tab's
  Clear button calls this).
