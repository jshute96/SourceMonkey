# SW logging

How SourceMonkey identifies scripts in console output, and how to
quiet the noisy lines.

## Log IDs

Every script has a short, file-derived handle used everywhere a log
or UI surface refers to it.

- Default: the basename of the script's `relativePath` (e.g.
  `bold-on-hover.user.js`).
- Dupe basenames: each dupe gets a `#N` suffix
  (`foo.user.js#1`, `foo.user.js#2`, ...).
- Dupe ordering: sorted by stable UUID `id` lexicographically.
  Arbitrary but deterministic — the SW and the sources page agree.

### Where you see them

- SW console — every `[SourceMonkey] …` line that mentions a script
  uses its log ID. See [the message list below](#message-catalog).
- Sources page — a faint `#N` is rendered after the filename link
  whenever a script is part of a dupe group. No suffix for unique
  basenames.
- Userscript viewer — a `Log ID` row in the details panel, always
  visible.

### Implementation

`src/script-log-id.ts`:

- Pure: `basenameOf(path)`, `computeLogIds(scripts)` — used by the
  sources page + viewer at render time and unit-tested directly.
- SW runtime: a `Map<id, {id, relativePath}>` populated by one
  `chrome.storage.local.get(null)` scan at SW startup
  (`ensureLogIdsLoaded`) and kept fresh by `storage.onChanged`
  (`installScriptLogIdListener`).
- Sync getter: `getScriptLogLabel(id)` returns the log ID, or the
  first 8 chars of the UUID as a fallback (only seen during the
  brief window before the initial load resolves, or for late sm:*
  reports from scripts already removed).

### Dupe reshuffle behavior

Adding/removing a script in a dupe group can renumber siblings. The
sources page recomputes its `currentLogIds` after every
add/remove/refresh and walks `applyLogIdSuffixesToDom()` over OTHER
sections so their suffixes stay in sync after a partial re-render.

## Debug-logging gate

A few lifecycle messages fire on every click/navigation; useful when
diagnosing matcher or updater behavior but too noisy for default.
Gated through `dlog` / `dwarn` in `src/debug-log.ts`.

- Off by default.
- Toggle: "Enable debug logging" checkbox on the Options page
  (linked from the top of the sources page).
- Storage key: `chrome.storage.local.smDebugLogging` — set/clear
  from DevTools to flip without the UI.
- Live update: the SW listens via `storage.onChanged` so the change
  takes effect without reloading the extension.

## GitHub-token suffix

Source-refresh and per-script update-check log lines get an extra
` (with GitHub token)` suffix when the URL would carry the Options-
page GitHub PAT (`src/github-auth.ts`, host-gated):

- `source refresh (mode): <path> (with GitHub token)` — fires when
  the source is a github.com / raw.githubusercontent.com URL AND a
  token is configured.
- `update check (mode): <logId> (with GitHub token)` — same idea for
  per-script checks whose `fileUrl` is a GitHub URL.

Empty suffix when no token is set, or when the URL isn't GitHub —
non-GitHub sources stay quiet.

## Message catalog

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
| `update check: <logId>: error — <msg>` | no | info |
| `source refresh (mode): <path>` | no | log |
| `source refresh: <path>: <summary>` | no | log |
| `source refresh failed: <path>: <err>` | no | info |
| `refreshing all sources (mode)` | no | log |
| `start <logId> tab=<n> <url>` | no | log |
| `swapped <logId> tab=<n> <url> (loadedAt …)` | no | log |
| `abandoned <logId> tab=<n> <url> (reason=…)` | no | log |
| `error <logId> tab=<n> <url>: <msg>` | no | info |

Per-script `parser`-source rows (e.g. `unknown @grant entries dropped: <names>`) live in the viewer's Log tab, not the SW console — see "Page-console startup logs" below.

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
  `extractStartupLogs(header)` (`src/script-store.ts`). The resulting
  list is stored on `StoredScript.startupLogs` and persisted to
  `chrome.storage.local` alongside the rest of the script row.
- The injector reads `script.startupLogs` straight off the stored row
  and bakes it into the per-script config blob (`buildConfigBlob`,
  entry 0), which the prelude reads back as `cfg.startupLogs`. No
  rederivation at sync time — SW restarts produce the same config-blob
  bytes for the same script version, no log spam.
- Today's only producer is the unknown-`@grant` check (emits `warn`).
  Future detectors (partial `@resource` failures, header validation
  warnings, deprecation notices, etc.) extend `extractStartupLogs`.

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
  (on next sync) and the Log tab (on the next "loaded new content"
  event — see below).

### Mirror to the Log tab

When the refresh pipeline records a "loaded new content" entry for a
script (see `emitScriptOutcomeLog` in `src/script-updater.ts`), it
also walks `script.startupLogs` and appends one Log-tab entry per
diagnostic, with `source: 'parser'`. Result: every persisted version
of a script lands one diagnostic row immediately after its load row,
regardless of how many times the SW restarts in between.

### Boot replay

`chrome.storage.session` (where the Log tab lives) is cleared on
Chrome shutdown, so a fresh Chrome session starts with an empty Log
tab even though every script's `startupLogs` are still persisted in
`chrome.storage.local`. To repopulate without forcing a manual
refresh, `replayStartupLogsAtBoot()` (in `src/script-updater.ts`)
runs once at SW startup and emits one `parser` row per diagnostic
for every stored script.

- Gated by a sentinel key in `chrome.storage.session`. The sentinel
  is missing on first SW boot of a Chrome session and present on
  every subsequent SW restart within that session, so MV3's
  aggressive SW eviction doesn't produce duplicate rows.
- Idempotent within a session: SW restarts read the sentinel and
  bail. The sentinel auto-clears on Chrome shutdown (same lifecycle
  as the Log tab itself), so the next Chrome session always replays
  exactly once.
- Wired into `background.ts`'s top-level startup block — fires on
  every SW boot. On the cold-boot of a fresh Chrome session the
  sentinel is missing, so the replay runs; on SW restarts within the
  same session the sentinel is set and the replay bails. (Top-level
  rather than `chrome.runtime.onStartup` because that event isn't
  guaranteed to land before the SW's own first wake-up.)
- Also defensive against a cold-boot + concurrent-refresh race: the
  per-script append checks the existing log for a matching parser row
  before writing, so a refresh path that wrote the same diagnostic
  first won't get duplicated by replay. The inverse ordering (replay
  first, refresh second) is still possible and would produce one
  duplicate row per affected script per Chrome session — bounded and
  rare (requires the script's content to have changed between Chrome
  shutdown and the user's first navigation after restart).

See [script-log.md].

[script-log.md]: script-log.md
