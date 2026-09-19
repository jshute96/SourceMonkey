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
  script-originated entry in this log has carried so far** (`'info' |
  'warning' | 'error'`). Bumped on `appendScriptLog` only when the new
  entry's level is strictly higher than the stored one **and the entry
  carries no `state`** (see [Entry shape](#entry-shape)); cleared on
  `clearScriptLog` alongside the entries, and by an entry with
  `resetsLogLevel` (see
  [A new version starts the badge over](#a-new-version-starts-the-badge-over)).
  Lives next to the log
  (rather than on the `StoredScript` row) so its lifetime exactly
  matches the entries that back it — Chrome shutdown drops both
  together. The collections page reads every script's row in one bulk
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
  source: string;          // origin label, e.g. 'manual-refresh', 'script-wrapper'
  tabId?: number;          // present when the event originated from injected code
  message: string;         // human-readable; multiline OK
  location?: DiagnosticLocation;  // a place in the script's own files
  state?: LoadState;       // the Status-badge state this event moved the script into
  resetsLogLevel?: boolean;  // clears `loglevel:` as it is written — a fresh start
}
```

`state` is set on entries that record a **state transition** rather
than something the script did. Type `LoadState` (`script-display.ts`):
`refresh-failed`, `invalid`, `rejected`, `outdated`, and
`ok` for the matching recovery — `warning` / `error` are excluded
because they are derived *from* the sentinel. It drives two things:

- The Log tab's Status column shows the badge word (`REFRESH FAILED`,
  `OK`) instead of the level, so the entry that put a badge there reads
  like the badge.
- The entry never bumps `loglevel:`.
  - The badge for a state comes from the row (`status`,
    `refreshError`, the rejection map, the probes) and clears when the
    row recovers.
  - WARNING / ERROR are left to mean "the script itself did something":
    a runtime error, a parse-time diagnostic, a refused `GM_download`.
  - A transient refresh failure therefore leaves no residue once it
    recovers.

### A new version starts the badge over

`resetsLogLevel` is set on the `Loaded new content` row, and clearing
`loglevel:` rides on that entry's own queued write:

- The old version's runtime errors are not evidence about the new one,
  and a developer who just fixed one needs the badge to answer "did
  that work?", not "did it ever fail?".
- Earlier entries stay in the Log; only the sentinel resets. The row
  shows `OK` in the Status column, since that is what the badge reads
  once it lands.
- Ordering matters and is guaranteed by the queue: the new version's
  `parser` diagnostics are appended right after and bump the sentinel
  afresh, so a fix that introduces a header warning still reads
  WARNING.
- Not set on a recovery row (`Refresh succeeded again`, the rejection
  clearing): the same code is still running there, and its errors still
  stand.
- A tab still running the old version keeps reporting for as long as
  it is open, and a report landing after the reset re-badges the
  script. Reloading that tab stops the reports but does not reset
  again (the bytes haven't changed); the badge then stays until the
  next new version or Clear log. Noted in TODO.md.

Row vs. entry, deliberately separate:

- The row is the durable, persisted truth of what state the script is
  in.
- The entry is the session-scoped record of when it got there.
- Every write that moves the row into a load state (or back) appends
  the entry with that `state` in the same step.
- Across a restart, `replayScriptLogsAtBoot` restates whatever is
  still badged — `invalid` / `refreshError` rows and a
  persisted OUTDATED probe — so a badge never outlives its line.

The viewer's table renders `tabId · source` together when `tabId` is
present, and just `source` otherwise.

`location` is a place SourceMonkey *derived* — a bad header line, a
syntax error — and the Log tab renders it as a link into the matching
code tab. Distinct from the `sourcemonkey://…:L:C` refs that appear
inside a runtime stack trace: those are text the script itself
produced and are found by scanning the message. See
[diagnostics.md](diagnostics.md).

### Source labels

`source` is a free-form string, not a union — the set below is just
what the code emits today. These are **read by users** in the Log
tab's Source column, so each names the thing that produced the entry,
not the internal that emitted it.

Load pipeline (service-worker side, never carries a `tabId`):

| Source | Emitted by | Means |
| --- | --- | --- |
| `manual-refresh` | `emitScriptOutcomeLog` | The user clicked Refresh / Refresh All. |
| `background-refresh` | same | An opportunistic check, triggered by a page navigation. |
| `add` | `emitInitialLoadLog` | Failed on its first load, when the script was added. |
| `extension-startup` | `ensureLoadStateInLogTab`, `ensureOutdatedInLogTab` | Restated after a browser restart — see below. |
| `parser` | `ensureStartupLogsInLogTab`, and the refresh paths | Parse-time diagnostics from `script.startupLogs`: when new content lands, restated on a manual no-change refresh, and replayed at boot. |
| `version-probe` | `probeOneScript` | An `@updateURL` / `@downloadURL` elsewhere declares a newer `@version`. |

Registration:

| Source | Emitted by | Means |
| --- | --- | --- |
| `chrome-injector` | `registerWithFallback` | Chrome refused the script's spec, so it silently never runs. |

Runtime — always carries a `tabId`, so these render as `tab 17 · …`:

| Source | Emitted by | Means |
| --- | --- | --- |
| `script-wrapper` | the `sm:*` handlers in `background.ts` | Start, reload-swap, abandon, and uncaught script errors. |
| `gm-log` | the `SM_GM_LOG_MSG` handler | A `GM_log()` call from the script itself. |
| `gm-dom` | the `SM_GM_DOM_BLOCKED_MSG` handler | The page's CSP refused a style `GM_addStyle` / `GM_addElement` added — only possible for a script running in the page (MAIN world). Once per script per document. |
| `gm-download` | `sendDownloadEvent` in `background.ts` | A `GM_download()` call that was refused, interrupted, or timed out. Successful downloads are not logged — a batch downloader would flood the capped log. |
| `gm-window` | `handleWindowControl` in `background.ts` | A granted `window.close()` / `window.focus()` the browser refused. A successful close takes the page (and its console) with it, so only failures land here. |

Two naming notes worth keeping:

- **`extension-startup`, not `startup`.** Bare "startup" would read as
  the *script's* startup, which is what `parser` already covers.
- **`background-refresh`, not `refresh-opportunistic`.** Both refresh
  labels are spelled out per mode rather than composed as
  `refresh-${mode}`: "opportunistic" names our scheduling policy, not
  anything the user did or would recognise.
- **`version-probe` is not split by mode**, unlike the refresh labels.
  It reports a transition — an upstream copy just moved ahead of us —
  and whether a click or a navigation noticed that tells the user
  nothing they would act on.

## API

`src/script-log.ts` exports the public surface:

- `appendScriptLog(scriptId, input)` — async write. Promise resolves
  once the entry is persisted. Also bumps `loglevel:<scriptId>` when
  the new entry's level exceeds the stored max, or clears it when the
  entry `resetsLogLevel`.
- `logScriptEvent(scriptId, input)` — fire-and-forget convenience.
  Swallows errors because the log isn't load-bearing.
- `getScriptLog(scriptId)` — async read.
- `clearScriptLog(scriptId)` — async wipe. Removes the log AND the
  `loglevel:` sentinel.
- `getMaxLogLevel(scriptId)` — async read of the persisted max
  level. Used by the userscript viewer to seed the Status row.
- `getAllMaxLogLevels()` — bulk read returning a `Map<scriptId,
  LogLevel>`. Used by the collections page to drive every row's Status
  column in one storage round trip.

### The worker owns the writes

`log:<id>` is read-modify-written and the per-script promise chain that
serializes those writes is module state — so it only orders the writes
made in one JS context.

- Both contexts write. The worker logs injection, refresh and probe
  events; a page logs through the `script-store` code it shares with the
  worker (an install's first-load line), and the viewer's Clear log
  button removes the key.
- Two chains on one key lose entries, and let an append that was already
  in flight resurrect a log the user just cleared.
- So a page hands every **mutation** to the worker
  (`SCRIPT_LOG_WRITE_MESSAGE`, handled in `background.ts`) and the
  worker's chain is the only one that touches the key. Reads don't hop —
  they aren't read-modify-write.
- The page falls back to writing locally unless the worker answers
  `true`: a visible entry is worth more than the ordering, and a handler
  that threw resolves the message rather than rejecting it, so the ack
  has to be read and not just awaited.
- What the chain guarantees is that the worker's chain orders everything
  reaching it — not that one page's appends are ordered. Two writes from
  a page are two messages, and a write that fell back is on a different
  chain entirely.

## Status column promotion

The persisted `StoredScript.status`, the `refreshError` annotation, the
update probes, and the per-script max log level together drive the
Status column. Rules + priority order live in
[storage.md → Displayed status](storage.md#displayed-status-ui-level).

Plumbing notes specific to logging:

- The collections page listens for `chrome.storage.session.onChanged` on
  `loglevel:` keys and repaints affected rows without a full re-render.

## Every surfaced failure lands in the Log

Rule: if a script's status column or viewer pane shows a failure, that
script's Log explains it. A badge the user can't click through to a
reason is worse than no badge.

`loadStateLogEntry` (`src/script-store.ts`) is the single mapping from
a row's persisted state to the entry it warrants:

| Row state | `state` | Level | Message |
| --- | --- | --- | --- |
| `status: 'invalid'` | `invalid` | error | the row's `errorMessage` |
| `refreshError` (status still `ok`) | `refresh-failed` | warning | `Refresh failed: <reason>` |
| otherwise | — | — | nothing to say |

Why those levels:

- `invalid` means **the script cannot run** — such rows are never
  injected. Error matches what the badge already claims.
- `refreshError` means the script **is** running, from its
  last-known-good copy; only the update failed. Warning, not error.
- The level never reaches the badge: these entries carry a `state`, so
  they leave the `loglevel:` sentinel alone. The badge is INVALID /
  REFRESH FAILED straight from the row while the failure lasts, and OK the moment the row recovers.

Every caller shares that mapping, so the same failure reads the same
way whichever path reported it:

- `emitScriptOutcomeLog` (`script-updater.ts`) — every refresh path.
- `emitInitialLoadLog` (`script-store.ts`) — the `addCollection` /
  add-to-container path, which bypasses the updater.
- `replayScriptLogsAtBoot` (`script-updater.ts`) — restates whatever
  is still broken after a Chrome restart wiped the log.

Beyond the load pipeline:

- **Rejected registration** (`registerWithFallback` in
  `src/injector.ts`, source `chrome-injector`) — Chrome refused the
  script's spec, so it never runs even though its row loaded fine.
  Error level, `state: 'rejected'`. The status cell says REJECTED for
  as long as the refusal stands; the Log is where the reason gets a
  timestamp and a permanent home. See
  [injection.md](injection.md#rejected-registrations).
- **Outdated** (`probeOneScript` in `src/script-updater.ts`, source
  `version-probe`) — an upstream copy moved ahead of ours. Warning
  level, `state: 'outdated'`; the probe going quiet again logs
  `Up to date again` with `state: 'ok'`. Restated at boot with source
  `extension-startup`, since the probe persists while the log doesn't.

### Collection-level failures

`logCollectionEventToScripts` fans these out to every script under the
collection. They are always **info**, never warning/error:

- The badge for a collection-level problem belongs on the collection row,
  which already renders `scanError`. These entries exist so a user
  reading one script's Log can see why it wasn't checked.
- WARNING / ERROR via the `loglevel:` sentinel are reserved for things
  the script itself did; a listing failure is not that.

What gets fanned out:

- **Scan failure** (`scanError`: unreadable listing / manifest / bad
  URL) — `This collection did not load: <reason> — still running the
  cached copy`. `refreshCollection` deliberately leaves every script row
  untouched in this case, so without this the per-script outcome pass
  would report no change for rows that were never actually checked.
- **A refresh that read fine but couldn't be saved** — the shared
  `describeRefreshError` sentence (see
  [diagnostics.md](diagnostics.md#refreshes-that-could-not-be-saved)).
  Both entry points reach it through `collectionFailureMessage`, which
  picks the wording from the recorded map rather than from the caught
  error, so each collection names its own reason and the two paths
  cannot word the same failure differently.
- **A throw with nothing recorded** — `Could not refresh this
  collection: <reason>`. `refreshCollection` records only when its write
  fails, so an unrecorded throw came from earlier in the pipeline and
  must not claim the read succeeded. Same fallback in both paths.
- **A throw that takes down a whole pass** — the same generic sentence,
  fanned out to every script in every collection. Only for a failure
  outside the per-collection handling, where nothing was summarized and
  there is one reason to give.

## When the log stays quiet

Every caller that observed something writes an entry. Nothing is
dropped for repeating an earlier message — the Log tab is a transcript,
and a line that vanishes because the same sentence appeared before
stops being one.

One thing stays quiet, and it is about **whether anything happened**:

- **A no-op refresh on a valid script.** `Checked for updates — no
  change` is manual-only, so background polling doesn't announce that a
  healthy script is still healthy.

A **registration rejection is not** one of those, and used to be. Every
refused attempt writes a row, including a re-sync that gets the same
reason for the same content:

- The retry is the thing being reported. A suppressed retry looks
  exactly like no retry, and "Clear log" followed by a Refresh left a
  REJECTED row with an empty Log explaining it.
- Every path that re-checks a script also **re-attempts the
  registration** (`retryRejectedRegistrations`), so each row records a
  real attempt rather than a replayed memory. Without that forcing
  step a Refresh finding no new content wouldn't reach Chrome at all —
  see [injection.md](injection.md#rejected-registrations).
- **Volume is controlled by attempting less, not by logging less.** One
  navigation fans out into many checks of the same script, so the retry
  itself is rate-limited to one automatic attempt per 10 s (a Refresh
  click bypasses that). A page load produces one row, not ten.
  - Not literally one row per action: a Refresh that **changes the
    script's content** also triggers a full sync through
    `onCacheChanged`, and that sync makes its own attempt. Two real
    attempts, two rows.
- The remaining cost is that a script Chrome keeps refusing accumulates
  rows in its own log, and `LOG_CAP` rotation will eventually evict that
  script's other entries. Only that script's log is affected, and every
  row in it says the same actionable thing.

Everything else emits, including:

- A failure identical to the one already in the log, on every check.
  Each check refetches and re-runs split + parse + validate — an
  `invalid` row can't take the size+mtime skip (`canSkip` in
  `script-store.ts` requires `status === 'ok'`) — so it is a fresh
  verdict on a fresh read.
- The startup replay's restatement of a failure a refresh may have
  already logged. Worst case is a duplicate pair of rows, once per
  script per Chrome session; the `source` column tells them apart.
- A collection that stays unreadable, once per pass. That path is only
  reachable from a Refresh / Refresh All click, so each repeat is one
  the user asked for.

Poll volume is a real cost — tracked in `TODO.md` — but the lever is
running or announcing fewer checks, not letting a check that started go
silent.

### How a check frames itself

One row when nothing happened, two when something did. Every refresh
path goes through `emitScriptOutcomeLog`, which writes both.

| Outcome | Rows |
| --- | --- |
| Nothing to report | `Checked for updates — no change` |
| Anything else | `Checking for updates`, then the outcome |

- The uneventful case is **one self-describing line**, so a routine
  poll costs a single row rather than a start/outcome pair.
- A check with news gets the preamble because its outcome is a line in
  its own right — it carries its own severity and is what the status
  badge links to, so it can't also be the thing that says a check ran.
- Which case applies is `hasReportableOutcome`: failing now, failing
  before, vanished, or content changed. A healthy unchanged row took
  the size+mtime skip.
- Both rows are written **after** the work, so they land together. The
  SW console is where a check is bracketed live (`update check
  (<mode>): <label>` before, outcome after); the Log tab is the record
  of what happened.
- `Could not check for updates: <reason>` stands alone — it names the
  check and its failure in one line.

## Recovery is logged too

Without this the last word on a script would be a failure that is no
longer true. So the transition back to healthy gets an info entry
naming what recovered:

- `Loads cleanly again (was invalid)`
- `Refresh succeeded again (collection is reachable)`
- `This collection is readable again`
- `Chrome accepted this script's registration — it runs again`
  (`logRecoveries` in `src/injector.ts`, source `chrome-injector`)

This matters most when the bytes didn't change — e.g. a `@require`
host that starts answering again clears the failure without bumping
`loadedAt`, so there's no `Loaded new content` row to explain the
badge going green.

Every recovery row carries `state: 'ok'`, and the failure it answers
carried its own `state`, so neither touched the `loglevel:` sentinel:
the Status cell reads OK again as soon as the row does, with nothing to
clear.

## Opportunistic vs manual

Both trigger modes log failures. A background check exists precisely to
notice a failure the user hasn't gone looking for, so a badge that
turns amber on its own must come with a matching Log line.

Trigger mode still gates the **non**-events: `Checked for updates — no
change` is manual-only.

Caveat on what "manual" means: it is "not rate-limited as a refresh",
not "the user clicked". The
[reload fast-path](injection.md#reload-fast-path) runs in `manual`
mode for every matched script on every tab reload, so a healthy script
*does* accumulate `Checked for updates — no change` rows from ordinary
browsing. That is the remaining source of poll noise in the cap —
tracked in `TODO.md`.

## What gets logged today

- **Refresh paths** (`src/script-updater.ts`):
  - `Checking for updates` (info) — ahead of any outcome worth
    reporting; omitted when the check has nothing to say (see
    [How a check frames itself](#how-a-check-frames-itself)).
  - `Loaded new content (<size>)` (info) — when the new build has a
    different `loadedAt` from the prior.
  - `Checked for updates — no change` (info) — only on manual refresh,
    to mirror the SW console behaviour. Opportunistic background checks
    stay silent to keep the log from filling with poll noise.
  - Load failures (error) — the row's `errorMessage` when it lands
    `invalid`, covering metadata-block parse failures, header
    validation, fetch failures with no good copy to fall back on, and
    `@require` / `@resource` resolve or fetch failures.
  - `Refresh failed: <reason>` (warning) — a script that's still
    running from its cached copy but whose latest refresh failed
    (`status: ok` + `refreshError`; see
    [storage.md](storage.md#refresh-failures-keep-the-good-copy-running)).
    Covers hard fetch failures, an http(s) 200 that parsed as a login
    page, and dependency fetch failures.
  - `This collection did not load: <reason> — still running the cached
    copy` (info), the `describeRefreshError` sentence (info), and
    `Could not refresh this collection: <reason>` (info) — collection-level
    failures, fanned out to every script under the collection. See
    [Collection-level failures](#collection-level-failures) for why info.
  - `Could not check for updates: <reason>` (error) — `refreshScript`
    itself threw (a storage failure, not a load failure).
  - Recovery entries (info) — see
    [Recovery is logged too](#recovery-is-logged-too).
  - All of the rows above are outcomes of a real check, so they are
    appended unconditionally — see
    [When the log stays quiet](#when-the-log-stays-quiet).
  - A row that went away during its check (deleted by the user, or
    dropped by the check itself because the directory no longer lists
    its file) gets **no entry**: its Log was cleared with the row, and
    an entry would be an orphan. The service-worker console line is the
    record.
  - Collection / refresh-all paths route per-script outcomes through the
    same helper so each affected script gets one entry.
- **Injector** (`registerWithFallback` in `src/injector.ts`, source
  `chrome-injector`):
  - `Chrome rejected this script's registration, so it will not
    run: <reason>` (error) — the spec was refused, so the script never
    runs even though nothing about its *load* failed. `<reason>` is
    Chrome's own wording, verbatim, because it names the offending
    header value.
    - The sentence is built by `describeRejection`
      (`src/script-rejection.ts`), shared with the viewer's message
      bar so one problem keeps one wording.
    - Written on every refused attempt, not just when the state
      changes — see
      [injection.md](injection.md#rejected-registrations).
- **Add** (`emitInitialLoadLog` in
  `src/script-store.ts`, source `add`):
  - The same load-failure entry, for a script that lands broken on its
    very first load. The add path bypasses the updater, so without
    this a brand-new INVALID row would have an empty Log.
- **Boot replay** (`replayScriptLogsAtBoot`, source `extension-startup`):
  - The same load-failure entry, restated once per Chrome session for
    any row that is *still* broken. `chrome.storage.session` is wiped
    on shutdown while the row that explains the badge is not, and the
    refresh paths only log on a state change — so without this a
    long-broken script would show a red badge over an empty Log.
  - The OUTDATED row too, for a row whose persisted probe is still
    ahead of it — same reasoning, same wording as the probe's own row.
- **Update probes** (`src/script-updater.ts`, source `version-probe`):
  - `Newer version <v> at <update|download> URL (running <v>) — <url>`
    (warning) — an `@updateURL` / `@downloadURL` declares a version
    ahead of the copy we run. Emitted only when the newer version
    *changes*, so an upstream that's been ahead for a month doesn't
    add a row every check. Nothing is logged for a probe that fails,
    finds nothing newer, or is skipped as still-fresh. See
    [updates.md](updates.md).
- **Parser** (`extractStartupLogs` in `src/script-store.ts`, replayed
  by `emitScriptOutcomeLog` in `src/script-updater.ts`):
  - `Ignoring @grant <names> — unsupported APIs` (warning) — emitted
    once per loaded content version, immediately after the
    `Loaded new content` row. Detection happens at parse time and is
    persisted on `StoredScript.startupLogs`, so SW restarts don't
    re-fire the row. Also mirrored into the page DevTools console via
    the wrapper's [startup-log channel](logging.md#page-console-startup-logs)
    on every matching page load.
  - A **manual** refresh that finds no change restates them, after
    its `Checked for updates — no change` line. They describe the
    installed content, not an event, so they stay true until it
    changes; logging them only when content lands left a permanently
    misconfigured script with no Log line at all once that row
    scrolled away or `Clear log` wiped it. A background check restates
    nothing, same as the no-change line itself.
  - On the first SW boot of a fresh Chrome session, a
    [boot-replay pass](logging.md#boot-replay) appends parser rows
    for every persisted script — without this the Log tab would be
    empty after a browser restart even though the diagnostics still
    apply.
- **GM_log fan-out** (handled in `installScriptMessageListener`):
  - `<rendered args>` (info, `source: 'gm-log'`, `tabId` attached) —
    one entry per `GM_log(...)` call. The script's own
    `console.log` line in the page DevTools still happens too; this
    is just the SW-side mirror so users browsing the collections page
    see what their script said without opening DevTools. Args are
    rendered page-side (primitives via `String()`, objects via
    `JSON.stringify`, joined by spaces) because
    `chrome.runtime.sendMessage` can't carry non-cloneable values
    and the Log tab is text-only.
- **window.close / window.focus failures** (`handleWindowControl` in
  `src/background.ts`, source `gm-window`, `tabId` attached):
  - `window.close — <reason>` / `window.focus — <reason>` (warning) —
    the tab was already gone, or `chrome.windows` was unavailable. A
    window manager that declines to raise the window is NOT a failure
    Chrome reports, so it doesn't appear here either.
  - Warning rather than error, for the same reason as `gm-download`
    below: the browser's own rules said no, SourceMonkey didn't fail.
  - Successes are **not** logged: the page console gets the same
    failure line from the runtime, but a close that worked takes that
    console with it — the Log tab is the only place a user can look
    afterwards.
- **GM_download failures** (`sendDownloadEvent` in
  `src/background.ts`, source `gm-download`, `tabId` attached):
  - `GM_download <reason> — <url>` (warning) — a download that was
    refused (`not_permitted`), interrupted (`not_succeeded`, with
    Chrome's interrupt reason), or timed out. A file that silently
    never appears is otherwise invisible to the user, and the reason
    lives in the SW where no page console can show it.
  - Warning rather than error: a refused or interrupted download is a
    script/page-level outcome the script can handle (many retry), not
    a SourceMonkey malfunction.
  - Successful downloads are **not** logged — a batch downloader fires
    hundreds and would push everything else past `LOG_CAP`.
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
- `Checked for updates — no change` on opportunistic checks
  (manual-only, as above).
- Update probes that fail, find nothing newer, or are skipped as
  still-fresh. A probe is an annotation; it can't change what runs.
- Anything for a collection with **no scripts under it**. A collection whose
  very first scan fails has nothing to write to — the reason lives on
  the collection row's `scanError` and the collections page renders it there.

## Viewer Log tab

- Always present as the last tab in the tab strip.
- Selected → swaps the code pane for a log table. Switching back to
  any code tab restores the highlighted code view.
- Newest entries first. Sticky header row and a sticky toolbar:
  **Save**, **Copy**, **Clear log** (see [Export](#export)).
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

## Export

The Log tab's **Save** and **Copy** buttons hand out the same CSV text,
built by `formatLogCsv` in `src/log-format.ts`.

Format:

- Header row `Time,Status,Source,Message`, then one row per entry.
- **Newest first**, matching the table — an export is a copy of what
  the reader is looking at.
- Columns carry the table's cells:
  - `Time` — local wall clock, `2026-08-05 14:03:22.017`.
  - `Status` — the badge word for a state-carrying entry
    (`REFRESH FAILED`, `OK`), else the level (`info` / `warning` /
    `error`).
  - `Source` — `tab 17 · script-wrapper` when the entry names a tab.
  - `Message` — as rendered, not as stored:
    - a derived `location` is flattened into the text as
      `… (in file.user.js, line 12)`; in the table that part is a link;
    - stack refs are **source-mapped and decoded first**, the same way
      the table shows them (see below). Exporting the stored text would
      name the `.user.js` at a generated line inside the combined
      injected entry — the coordinate the Log tab exists to correct.
  - `Time` / `Source` come from `src/log-format.ts`; the mapped
    `Message` needs the viewer's tabs and the script's current layout,
    so `formatLogCsv` takes that renderer as an argument.
- Quoted when the value contains the separator, a quote, or any
  whitespace; embedded quotes are doubled.
- **One entry per line.** A message that spans lines (a stack trace)
  is folded with `\n` / `\r` escapes rather than left as a quoted
  multi-line field.
  - CSV would allow the raw newline and a spreadsheet would read it
    back, but the file is a `.log`: `grep` should return whole records,
    `wc -l` should count events not frames, and `tail -n` shouldn't cut
    an entry in half.
  - Backslash is escaped too (`\` → `\\`), so the folding is
    reversible — log messages carry Windows paths and regex sources,
    where a literal `\n` already appears in the text.
- Rows are `\n`-separated, with a trailing newline.

Behavior:

- Suggested filename: the script's log ID with its `.user.js` / `.js`
  extension swapped for `.log`, keeping any `#N` dedup suffix —
  `bold-on-hover.user.js#2` → `bold-on-hover#2.log`.
- Save opens a real save dialog (`showSaveFilePicker`) so the user
  picks the name and folder, rather than dropping a file into the
  downloads folder behind their back.
  - Cancelling the dialog writes nothing — a declined save is a
    decision, not a failure to work around.
  - A write that fails after the user picked a destination reports
    `Save failed`. It does **not** fall back to a download: they chose
    a place, and a second file elsewhere would read as success.
  - Where the picker isn't available, Save falls back to a plain
    download (`Blob` + object URL + `<a download>`) under the same
    name, which the browser announces itself.
- Nothing leaves the browser on any path.
- Both buttons report their outcome by relabelling themselves
  (`Saved` / `Save failed`, `Copied` / `Copy failed`) for ~1.2s.
  - A clipboard write can be refused, and the log is not selectable
    text the user could fall back to copying by hand, so silence would
    read as success.
  - The label survives a repaint, so an entry arriving mid-feedback
    doesn't erase it, and is dropped by Clear log.
- Both are disabled while the log is empty.
- The exported log is the **click-time snapshot** — entries arriving
  while a save dialog sits open are not added to it.

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

### Refs are decoded for display

- `script-source-url.ts` percent-encodes the log label into
  `//# sourceURL=`, so a second `foo.user.js` reaches the log as
  `foo%232`. That encoding is required — a bare `#` starts a fragment,
  and a space or paren ends the run `parseStackRefs` matches.
- The Log tab decodes it at paint time, matching the display-decodes /
  functional-stays-encoded rule the rest of the viewer follows. Tab
  lookup and the click target still use the raw URL.
- **Only our own `sourcemonkey://SourceMonkey/…` refs decode.** A ref
  is a coordinate, not a name: an `http(s)` or `file` ref gets compared
  against devtools or a `@require` line, so it keeps the bytes that
  were really in the URL.
- The raw form stays as the ref's `title`, so it is one hover away —
  which is also the name devtools' Sources tree indexed the file under.
  See [names-and-paths.md](names-and-paths.md).

### Why recompute rather than persist

- The inputs (require bodies, body text, log label) are already on
  the `StoredScript` row the viewer loaded.
- Recomputing is memoised on the script's `loadedAt`, so an unrelated
  storage change doesn't re-concatenate megabytes of libraries.
- Both run paths agree on the layout, so there is one answer to "which
  file is generated line N?" — `wrapCombinedEntry` and
  `buildSwapEvalBody` produce the same arrangement for both the
  with-requires and the no-requires case. The viewer never has to know
  which one ran. See `src/composed-source.ts` for the two layouts.

### The log outlives the layout

- Nothing clears a script's log on refresh — only the user's **Clear
  log** button, or browser shutdown.
- So a refresh that changes a `@require`'s line count leaves older
  entries whose generated line numbers were produced by the *previous*
  arrangement. Mapping those with today's segments would turn an
  obviously-generated number into a confidently wrong file and line.
- **They are mapped anyway, and stay clickable.** Best effort beats a
  dead end: leaving the ref at its generated coordinate is not the
  cautious option it resembles — that number indexes the concatenated
  program, so it is wrong too, just less legibly, and it points into
  the `.user.js` at an offset that includes every preceding `@require`.
- Entries older than the current `loadedAt` carry a tooltip saying so,
  so a line that doesn't match reads as expected rather than as a bug.
- The previous layout cannot be recovered to do better. A refresh
  overwrites `bodyText` and every `requires[].source` in place on the
  same row, and a `LogEntry` stores only timestamp / level / source /
  tabId / message.
- The staleness signal is not airtight: a tab still running the
  previous body can log an entry with a fresh timestamp, which reads as
  current. Closing that would need the wrapper to stamp each report
  with the `loadedAt` it actually ran under.

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
- Line numbers are counted the way V8 counts them (`\r`, `\r\n`,
  U+2028, U+2029 all end a line), but the code pane's gutter comes from
  Prism, which splits on `\n` only. A `@require` with CR-only endings
  or a raw U+2028 will map to a line the gutter numbers differently.
  Devtools is unaffected — it counts like V8.

## Lifecycle and reset

- `chrome.storage.session` is cleared by Chrome on shutdown, so logs
  do not persist across browser restarts. This is deliberate — the
  log is for "what just happened", not historical telemetry.
- `SourceMonkey.resetAllState()` (test surface) wipes session storage,
  which clears every script's log.
- Per-script wipes go through `clearScriptLog(scriptId)` (Log tab's
  Clear button calls this).
