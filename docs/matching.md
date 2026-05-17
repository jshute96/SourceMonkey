# URL matching and the per-tab badge

How VibeMonkey decides which scripts apply to a URL, and how that
result becomes the toolbar badge + tooltip you see on a tab.

Related modules:

- [storage.md](storage.md) — the underlying `StoredScript` shape and
  where `matching` comes from.
- [script-viewer.md](script-viewer.md) — header parsing (`@match`,
  `@include`, `@exclude` originate here).

## Pattern semantics

Three pattern flavours, all implemented in `src/url-match.ts`:

### `@match` — Chrome match-pattern grammar

`<scheme>://<host>/<path>` plus the literal `<all_urls>`.

- **scheme**: `*` (http or https only), `http`, `https`, `file`, `ftp`.
- **host**: `*` (any host), `*.example.com` (base domain OR any
  subdomain), exact domain, or empty (for `file://`).
- **path**: glob with `*`. `*` matches any chars including `/`. The
  glob runs against `pathname + search + hash` so `?id=*` works.

Host comparison is case-insensitive.

### `@include` — free-form glob

A `*`-glob anchored to the whole URL string. `*` matches any run of
characters. If the pattern is wrapped in `/.../` it is treated as a
JavaScript regex instead.

### `@exclude` — same syntax as `@include`

Same grammar (`*`-glob or `/regex/`). **Excludes always win** — if any
`@exclude` pattern matches the URL, the script does not match, even if
a `@match` or `@include` would have hit.

### Combined rule (`urlMatchesScript`)

A script matches a URL iff:

1. No `@exclude` pattern matches, AND
2. At least one `@match` OR `@include` pattern matches.

A script with zero `@match` and zero `@include` patterns never matches
anything — but those scripts are also rejected by `validateHeader`
upstream, so they never make it into the match index in the first
place.

### Effective enabled

A script participates in matching only if **both** its own `enabled`
flag and its parent source's `enabled` flag are true. The two toggles
compose: turning the source off blanks the count for every script
under it, but each script's individual choice is preserved so flipping
the source back on restores the prior state.

## In-memory match index

`src/match-index.ts` keeps an in-memory `Map<scriptId, MatchedScript>`
of every `status: 'ok'` script so the background SW never hits
`chrome.storage.local` on the navigation hot path.

Lifecycle:

- **Startup**: `ensureLoaded()` reads all `script:*` and `source:*`
  rows once, populates the cache, and records which sources are
  disabled.
- **Updates**: `installStorageListener()` registers a
  `chrome.storage.onChanged` listener that mutates the cache in place
  on every `set`/`remove` of a `script:*` or `source:*` key. Only `ok`
  scripts are kept; `error`/`missing` entries get evicted. Source
  changes flip an in-memory `disabledSources` set, which lets a
  source toggle re-evaluate every script under it in O(1).
- **Subscribers**: `onCacheChanged(fn)` lets the background SW re-badge
  every open tab when the script set itself changes (e.g. after a
  directory Refresh on the options page or a per-source / per-script
  enabled toggle).

Per-navigation cost is one `Map` iteration + the pattern checks for
each cached script. No I/O.

## Per-tab badge + tooltip

`src/background.ts` reacts to navigation via `chrome.webNavigation`
(main frame only):

- **`webNavigation.onCommitted`** — fresh document load OR bfcache
  restore. The `documentId` distinguishes the two — Chrome reuses the
  ID across bfcache restores.
- **`webNavigation.onHistoryStateUpdated`** — SPA pushState /
  replaceState. Same `documentId` as the underlying page.
- **`chrome.tabs.onRemoved`** — drop the tab's row from session
  storage.
- **Cache-changed callback** — when the script set itself changes
  (Refresh, toggles), recompute expected for every open tab without
  bumping `documentId`, so running-script reports survive.

A fallback `chrome.tabs.onUpdated` listener kicks in only if
`chrome.webNavigation` isn't available (older Chromes / permission
revoked).

For each tab we:

- Skip URLs whose scheme isn't one we could conceivably inject into
  (anything besides `http`, `https`, `file`, `ftp`). The badge is
  cleared for those tabs.
- Log matches to the SW console (one line per matching navigation).
- Persist a `TabRecord` (`{currentDocId, docOrder, byDoc}`) to
  `chrome.storage.session` under `"tab:<tabId>"` — see *Per-tab
  document LRU* below for why this isn't a single state. Session
  storage survives SW restarts (MV3 workers idle out aggressively)
  but is dropped when Chrome shuts down.
- Render the badge from the union of `matches` (expected) and `actual`
  (vm:start / vm:error reports — see below).

### Badge view (expected ∪ actual)

`src/tab-status.ts` derives the badge from the combined state:

- **Count** — size of the union of expected and actual script IDs.
- **Color**:
  - **RED** (`#d32f2f`) — any script reported an error.
  - **ORANGE** (`#f57c00`) — no errors, but the expected set and the
    actual set diverge (MISSING or UNEXPECTED entries).
  - **GREEN** (`#2e7d32`) — expected and actual line up exactly with
    no errors.
- **Tooltip** — `"VibeMonkey"` followed by one line per script,
  formatted `"<name> | <STATUS>"`, sorted by name. `<STATUS>` is one
  of:
  - `OK` — expected and the wrapper sent `vm:start` with no error.
  - `ERROR` — wrapper sent `vm:error` (regardless of expected).
  - `MISSING` — expected by the matcher but no `vm:start` yet.
  - `UNEXPECTED` — wrapper sent `vm:start` but the matcher didn't
    predict it (e.g. Chrome's matching disagrees with ours, or a race
    against a script-store change).

### Actual reports from injected wrappers

Every wrapper sends `vm:start` on activation and `vm:error` on a
synchronous throw. The SW listens on
`chrome.runtime.onUserScriptMessage` (NOT the regular
`runtime.onMessage`) and merges each report into the tab's `actual`
map keyed by script ID. See [injection.md](injection.md#message-flow)
for the wrapper-side payloads.

### documentId is the lifecycle key

`chrome.userScripts` injects exactly once per document. Fragment
changes, SPA pushState, and bfcache restores all keep the same
document — no re-injection, no new `vm:start`. Resetting `actual` on
every URL change would falsely flag those scripts as MISSING. So we
key state by `documentId`:

- **Known `documentId`** (script-set refresh, SPA URL change in the
  current doc, **or bfcache restore returning to a doc we still
  remember**): keep `actual` untouched. Union the new URL's matches
  into the stored `matches` list — a script that matched any URL
  during this document's life is "expected to have injected by now,"
  and surfaces as MISSING if `vm:start` never came.
- **Unknown `documentId`** (full document load to a doc we've never
  tracked, or one that aged out of the LRU): reset `actual` to `{}`
  and start a fresh expected set from this URL's matches.
- **Bootstrap race** — if a `vm:*` arrives before
  `webNavigation.onCommitted` has set the tab state (cold SW start or
  pure ordering race), the SW synthesises state from `sender.url` and
  `sender.documentId`. A follow-up `onCommitted` for the same
  documentId will hit the same record and preserve `actual`.
- **Errors are sticky** for the same script ID on the same document —
  a later `vm:start` doesn't silently flip ERROR back to OK.

### Per-tab document LRU (bfcache restore)

`webNavigation` doesn't fire a distinct "restored from bfcache" event:
`onCommitted` fires with the original `documentId` reused (and
`transitionQualifiers` includes `'forward_back'`). The only reliable
restore signal is "this documentId is one we've already tracked for
this tab."

So per tab we keep a small LRU of `(documentId → TabMatchState)`,
capped at `MAX_DOCS_PER_TAB` (currently 5):

- On navigation we look up the incoming `documentId` in the LRU. Hit
  → restore path (preserve `actual`, accumulate matches). Miss →
  fresh doc.
- `setCurrentDoc()` promotes the doc to most-recent and marks it as
  what the badge displays.
- `writeDocState()` updates a doc's stored state WITHOUT changing the
  current one — used by the message handler so a late `vm:*` from a
  doc we already navigated away from updates its slot (so it survives
  another bfcache visit later) but doesn't steal the badge from the
  on-screen doc.
- Eviction drops the oldest non-current doc when the cap is exceeded.
  Five slots covers normal back/forward chains; deeper history loses
  state but Chrome's bfcache itself has comparable limits.

### Per-tab serialization

All mutations for a given tab — navigation events, vm:* reports,
removals, refresh-driven recomputes — go through a per-tab promise
queue (`enqueueTabWork`). Without it, two `vm:start` messages that
arrive in the same event-loop turn each do their own get/modify/set
against `chrome.storage.session` and the second write loses the first
update.

## What this doesn't do (yet)

- **Per-tab match override.** There is no UI yet to disable a matching
  script for one specific tab.
