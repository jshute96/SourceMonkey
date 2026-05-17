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

`src/background.ts` reacts to tab navigation:

- **`chrome.tabs.onUpdated`** — when `changeInfo.url` is set (or the
  tab enters `'loading'` with a URL), compute matches for that URL.
- **`chrome.tabs.onRemoved`** — drop the tab's row from session storage.
- **Cache-changed callback** — recompute matches for every open tab,
  so changes on the options page show up immediately.

For each tab we:

- Skip URLs whose scheme isn't one we could conceivably inject into
  (anything besides `http`, `https`, `file`, `ftp`). The badge is
  cleared for those tabs.
- Log matches to the SW console (one line per matching navigation).
- Set `chrome.action.setBadgeText` to the match count (per `tabId`)
  with `#f57c00` (Tampermonkey-ish orange) as the background.
- Set `chrome.action.setTitle` to a multi-line tooltip:
  `"VibeMonkey"` followed by one line per matching script name
  (sorted alphabetically for stable ordering).
- Persist `{url, matches}` to `chrome.storage.session` under
  `"tab:<tabId>"`. Session storage means it survives SW restarts (MV3
  workers idle out aggressively) but is dropped when Chrome shuts
  down — exactly what we want for per-tab state.

## What this doesn't do (yet)

- **Actual injection.** The matches are computed and surfaced, but no
  code is run on the page. `chrome.scripting` wiring is the next chunk
  of work (tracked in `TODO.md`).
- **SPA navigation.** `tabs.onUpdated` doesn't always fire for History
  API navigation in single-page apps. Adding
  `chrome.webNavigation.onHistoryStateUpdated` would cover that, at the
  cost of a `webNavigation` permission prompt on install.
- **Per-tab match override.** There is no UI yet to disable a matching
  script for one specific tab.
