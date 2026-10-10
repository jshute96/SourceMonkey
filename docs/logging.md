# SW logging

How SourceMonkey identifies scripts in console output, and how to
quiet the noisy lines.

## Log IDs

Every script has a short handle used everywhere a log or UI surface
refers to it: its basename and its script number.

- Format: `<basename>#E<number>` (e.g. `bold-on-hover.user.js#E4`).
  - The basename is the script's `relativePath`'s, or for a script
    added by URL, the URL's filename, percent-decoded and without the
    query string (`My Script.user.js`, not `My%20Script.user.js?v=2`).
    See [names-and-paths.md](names-and-paths.md).
  - The number is the one sm-dev names the script by (`E4`), the same
    in every run. See [storage.md](storage.md#sticky-numbers).
  - It keeps scripts sharing a basename apart, and never shifts when
    other scripts come and go.
- A script with no number yet has its basename alone, or `#1`, `#2`,
  ... among other unnumbered scripts sharing it, sorted by UUID:
  - one just added, for the moment before the service worker numbers
    it;
  - one in an sm-dev test collection, which isn't numbered.

### Where you see them

- SW console: every `[SourceMonkey] ...` line that mentions a script
  uses its log ID. See [the message list below](#message-catalog).
- Stack traces: a script's code is named by a `sourcemonkey://` URL
  with the log ID as its folder, encoded (`foo%23E4/foo.user.js`). See
  `script-source-url.ts`.
- Userscript viewer: a `Log ID` row in the details panel, always.
  Its tooltip ends with the number sm-dev uses. Absent in preview
  mode, which is showing a script that has never run.
- Not the collections page: a suffix after the name there was more
  confusing than useful. The name link's tooltip leads with the
  location, which tells two same-named rows apart.

### Implementation

`src/extension/script-log-id.ts`:

- Pure: `computeLogIds(scripts, numbers)` (over `scriptBasename` from
  `script-display.ts`), used by the injector and the viewer, and
  unit-tested directly.
- SW runtime: a `Map<id, {id, relativePath}>` and the script numbers,
  populated by one read of the script rows at SW startup
  (`ensureLogIdsLoaded`) and kept fresh by `storage.onChanged`
  (`installScriptLogIdListener`), including the `scriptNumbers` row.
- Sync getter: `getScriptLogLabel(id)` returns the log ID, or the
  first 8 chars of the UUID as a fallback (only seen during the
  brief window before the initial load resolves, or for late sm:*
  reports from scripts already removed).
- A script's label is baked into its registered `//# sourceURL=`, so
  the registration sync rebuilds every script whose label moved,
  including when it is first numbered (see `runIncrementalSync`).

## Debug-logging gate

A few lifecycle messages fire on every click/navigation; useful when
diagnosing matcher or updater behavior but too noisy for default.
Gated through `dlog` / `dwarn` in `src/debug-log.ts`.

- Off by default.
- Toggle: "Enable debug logging" checkbox on the Options page
  (linked from the top of the collections page).
- Storage key: `chrome.storage.local.smDebugLogging` — set/clear
  from DevTools to flip without the UI.
- Live update: the SW listens via `storage.onChanged` so the change
  takes effect without reloading the extension.

## GitHub-token suffix

Collection-refresh and per-script update-check log lines get an extra
` (with GitHub token)` suffix when the URL would carry the Options-
page GitHub PAT (`src/github-auth.ts`, host-gated):

- `collection refresh (mode): <path> (with GitHub token)` — fires when
  the collection is a github.com / raw.githubusercontent.com URL AND a
  token is configured.
- `update check (mode): <logId> (with GitHub token)` — same idea for
  per-script checks whose `fileUrl` is a GitHub URL.

Empty suffix when no token is set, or when the URL isn't GitHub —
non-GitHub collections stay quiet.

## Message catalog

These are **service-worker console** lines, and they deliberately stay
lowercase — the capitalization rule in
[diagnostics.md](diagnostics.md#wording) governs strings a *user* reads,
and none of these reach a surface. They are separate literals from the
Log-tab rows they resemble, so the two can be worded for their own
audience. The one shared string is the version-probe line, which
interpolates the same `message` the Log row uses.

| Message | Gated by debug flag? | Level |
|---|---|---|
| `N matching script(s) for <url> (doc=…): [<logIds>]` | yes | log |
| `update check (opportunistic): <logId>` | yes | log |
| `update check (manual): <logId>` | no | log |
| `no change: <logId>` (opportunistic mode) | yes | log |
| `no change: <logId>` (manual mode) | no | log |
| `loaded new content: <logId> (<size>)` | no | log |
| `update check failed: <logId>: <err>` | no | info |
| `update check: <logId>: row vanished` | no | info |
| `update check: <logId>: invalid: <msg>` | no | info |
| `refresh failed: <logId>: <reason>` (transition / reason change only) | no | info |
| `<logId>: Newer version <v> at <kind> URL (running <v>): <url>` (version change only) | no | info |
| `collection refresh (mode): <path>` | no | log |
| `collection refresh: <path>: <summary>` | no | log |
| `collection refresh failed: <path>: <err>` | no | info |
| `refreshing all collections (mode)` | no | log |
| `start <logId> tab=<n> <url>` | no | log |
| `swapped <logId> tab=<n> <url> (loadedAt …)` | no | log |
| `abandoned <logId> tab=<n> <url> (reason=…)` | no | log |
| `error <logId> tab=<n> <url>: <msg>` | no | info |
| `migrated N collections and M scripts to the collection:* key spelling` | no | log |
| `collection-key migration failed <err>` | no | info |

The last two fire at most once per JS context, and only on a profile
written before the August 2026 sources → collections rename — see
[storage.md](storage.md#legacy-key-migration-temporary).

Per-script `parser`-source rows (e.g. `Ignoring unsupported @grant <names>`) live in the viewer's Log tab, not the SW console — see "Page-console startup logs" below.

**No `console.warn` / `console.error` anywhere in the extension** —
not the SW, not extension pages, and not injected wrapper / prelude /
GM-runtime code. Chrome forwards both into chrome://extensions/?errors,
which should be reserved for actual extension bugs (not userscript
failures, fetch errors, or expected fallbacks). Injected diagnostics
matter here too: a `console.error`/`.warn` from a
`chrome.userScripts`-registered script still surfaces in the Errors
panel. All diagnostic chatter uses `console.info` so it stays in the
relevant DevTools console only. Severity for the viewer's Log tab is a
separate channel (the per-script log `level` + `sm:*` reports) and is
unaffected.

## Keeping the Errors panel clean

The `console.warn` / `.error` ban above is only the loudest route into
`chrome://extensions/?errors`. Other routes reach it without any
console call at all, and each has its own countermeasure:

- **Unhandled promise rejections in an extension page.** A dropped
  `chrome.*` promise is reported as an uncaught error against the
  extension. `chrome.tabs.create` on a `file://` URL rejects outright
  while "Allow access to file URLs" is off, so the viewer's
  open-in-a-tab paths return their promises and report the failure into
  the message bar (plus the file-access banner) instead of dropping
  them.
- **`chrome.*` calls cut off by service-worker shutdown.**
  - When Chrome destroys the SW — every reload of the unpacked
    extension, plus idle termination — each in-flight `chrome.*` call
    rejects with `Error: No SW`.
  - SW startup fires many `void someStorageRead()` calls, so a reload
    mid-startup would list one entry per read. Nothing is broken: the
    next wake starts over and redoes them.
  - `src/extension/sw-teardown.ts` installs an `unhandledrejection` handler
    (first thing in `background.ts`) that marks exactly that rejection
    handled and notes it at `console.info`. Every other rejection
    still surfaces.
  - `Unchecked runtime.lastError: No SW` with no context or stack is
    Chrome-internal for the same teardown and can't be caught.
- **A registered userscript entry that doesn't compile.** V8's
  `SyntaxError` is raised before any of our code runs, so nothing can
  catch it. The answer is to never register such an entry — the parse
  check ([parse-check.md](parse-check.md)) runs at install/refresh
  time, and `runSync` re-checks any candidate whose verdict is missing
  or stale before registering it.
- **Preload hints on a response an extension PAGE fetched.** Chrome
  applies a response's `Link: <…>; rel=preload; as=script` header to
  the document that asked, then refuses the preload under the page's
  `script-src 'self'`. Any site that preloads its bundles sends one, and
  we fetch site HTML (the site-icon probe) and arbitrary script URLs
  (Add / Refresh / the install preview) from pages. So a page hands its
  http(s) reads to the service worker, which has no document for the
  hint to apply to — `src/http-read.ts`, used by both `fetchHttpText`
  and `fetchResourceBytes`. See `tests/e2e/preload-hints.spec.ts`.

## Page-console "startup logs"

The SW console is hard for end users to find. For diagnostics the
script author should actually see, the prelude has a generic
**startup-log channel**: each script's `startupLogs: {level, message}[]`
list is fired once on activation by `emitStartupLogs` in
`userscript-prelude.js`, which emits one
`try { console.info("[SourceMonkey] " + cfg.name + ": " + msg) } catch {}`
per entry. `console.info` (not `console.<level>`) so warn/error
entries don't leak into chrome://extensions/?errors; the `level`
still drives the Log-tab mirror.

### Where startup logs come from

- Detection happens at **parse time**, in
  `extractStartupLogs(header)` (`src/script-build.ts`). The resulting
  list is stored on `StoredScript.startupLogs` and persisted to
  `chrome.storage.local` alongside the rest of the script row.
- The one exception is an `@icon` that can't be shown, which needs a
  download to find out (see
  [site-icons.md](site-icons.md#load-time-check)). It is added when the
  icon is checked, and carried over by the backfills that rebuild a
  row's logs from its header (`rederivedStartupLogs`).
- The injector reads `script.startupLogs` straight off the stored row
  and bakes it into the per-script config blob (`buildConfigBlob`,
  entry 0), which the prelude reads back as `cfg.startupLogs`. No
  rederivation at sync time — SW restarts produce the same config-blob
  bytes for the same script version, no log spam.
- Producers today: unknown `@grant` names, `@grant none` overriding
  other grants, a `@match` Chrome's grammar refuses, `unsafeWindow`
  pinned to the isolated world by `@inject-into content` (all `warn`),
  and an ungranted `unsafeWindow` reference moving the script into the
  page (`info`). Future detectors (partial `@resource` failures,
  deprecation notices, etc.) extend `extractStartupLogs`.

### Properties

- Fires in the page DevTools console on every matching page load
  (whichever world the script runs in).
- Always emitted via `console.info`, regardless of the entry's
  `level`. Escalating to `console.warn`/`.error` would leak the line
  into chrome://extensions/?errors (see the policy note above). The
  entry's real `level` still drives the Log-tab mirror.
- On a `skip` decision (file vanished, script disabled mid-refresh)
  the logs still fire before the wrapper sends `sm:abandoned`. The
  next navigation has no registration and stays quiet.
- Updated content (loadedAt bumps) re-runs `extractStartupLogs`, so
  fixing a typo'd `@grant` and saving silences both the page console
  (on next sync) and the Log tab (on the next "Loaded new content"
  event — see below).
  - A change to only a `@require` / `@resource` bumps `loadedAt` too,
    and logs `Loaded new content for its @require or @resource files`,
    without the script's size. Its warnings are replayed as for any new
    version: that line starts the badge over.

### Mirror to the Log tab

When the refresh pipeline records a "Loaded new content" entry for a
script (see `emitScriptOutcomeLog` in `src/extension/script-updater.ts`), it
also walks `script.startupLogs` and appends one Log-tab entry per
diagnostic, with `source: 'parser'`. Result: every persisted version
of a script lands one diagnostic row immediately after its load row,
regardless of how many times the SW restarts in between.

### Boot replay

`chrome.storage.session` (where the Log tab lives) is cleared on
Chrome shutdown, so a fresh Chrome session starts with an empty Log
tab even though the state that explains it is still persisted in
`chrome.storage.local`. To repopulate without forcing a manual
refresh, `replayScriptLogsAtBoot()` (in `src/extension/script-updater.ts`) runs
once at SW startup and walks every stored script, emitting:

- one `parser` row per `startupLogs` diagnostic,
- one `extension-startup` row for a script whose row is *currently*
  broken (`invalid` / `missing` / carrying a `refreshError`), and
- one `extension-startup` row for a script whose persisted probe still
  puts an upstream ahead of it (OUTDATED).

The refresh paths and the probe only log on a state *change*, so
without this a script that was already broken or outdated before the
restart would show a red or amber badge over an empty Log. See
[script-log.md](script-log.md#every-surfaced-failure-lands-in-the-log).

- Gated by a sentinel key in `chrome.storage.session`. The sentinel
  is missing on first SW boot of a Chrome session and present on
  every subsequent SW restart within that session, so MV3's
  aggressive SW eviction doesn't produce duplicate rows.
- Idempotent within a session: SW restarts read the sentinel and
  bail. The sentinel auto-clears on Chrome shutdown (same lifecycle
  as the Log tab itself), so the next Chrome session always replays
  exactly once.
- The sentinel is written **after** the walk finishes, not before.
  MV3 can evict the worker mid-replay, and claiming it up front would
  mark the session replayed while most scripts still had empty logs —
  the exact state the replay exists to prevent. A torn-down pass just
  runs again on the next wake-up, duplicating rows for the scripts the
  first pass reached — rare, bounded, and cheaper than a de-dupe rule.
- The key name (`sm:startup-logs-replayed-at`) predates the
  load-state leg. Kept as-is: renaming it would make one session miss
  its sentinel and replay twice, for no benefit.
- Wired into `background.ts`'s top-level startup block — fires on
  every SW boot. On the cold-boot of a fresh Chrome session the
  sentinel is missing, so the replay runs; on SW restarts within the
  same session the sentinel is set and the replay bails. (Top-level
  rather than `chrome.runtime.onStartup` because that event isn't
  guaranteed to land before the SW's own first wake-up.)
- A cold-boot + concurrent-refresh race can duplicate a row in either
  ordering: whichever path runs second states the fact again. Bounded
  to one duplicate per affected script per Chrome session, and the
  `source` column tells them apart (`extension-startup` vs a
  `*-refresh`).
  - For the load-state leg, only reachable when the content changed on
    disk between shutdown and the user's first navigation after
    restart.
  - For the OUTDATED leg, the replay reads its snapshot before the
    refresh lands, so a first-navigation refresh whose new content
    catches up can be followed by a stale `OUTDATED` restatement. Same
    bound; the `source` column is again the tell.

See [script-log.md].

[script-log.md]: script-log.md
