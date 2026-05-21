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
  Arbitrary but deterministic — the SW and the options page agree.

### Where you see them

- SW console — every `[SourceMonkey] …` line that mentions a script
  uses its log ID. See [the message list below](#message-catalog).
- Options page — a faint `#N` is rendered after the filename link
  whenever a script is part of a dupe group. No suffix for unique
  basenames.
- Userscript viewer — a `Log ID` row in the details panel, always
  visible.

### Implementation

`src/script-log-id.ts`:

- Pure: `basenameOf(path)`, `computeLogIds(scripts)` — used by the
  options page + viewer at render time and unit-tested directly.
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
options page recomputes its `currentLogIds` after every
add/remove/refresh and walks `applyLogIdSuffixesToDom()` over OTHER
sections so their suffixes stay in sync after a partial re-render.

## Debug-logging gate

A few lifecycle messages fire on every click/navigation; useful when
diagnosing matcher or updater behavior but too noisy for default.
Gated through `dlog` / `dwarn` in `src/debug-log.ts`.

- Off by default.
- Toggle: "Enable debug logging" checkbox at the bottom of the
  options page.
- Storage key: `chrome.storage.local.smDebugLogging` — set/clear
  from DevTools to flip without the UI.
- Live update: the SW listens via `storage.onChanged` so the change
  takes effect without reloading the extension.

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

SW logs deliberately avoid `console.warn` / `console.error`: Chrome
forwards both into chrome://extensions/?errors, which should be
reserved for actual extension bugs (not userscript failures,
fetch errors, or expected fallbacks). Diagnostic chatter uses
`console.info` so it stays in the SW DevTools console only.
