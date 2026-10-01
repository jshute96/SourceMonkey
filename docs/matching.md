# URL matching and the per-tab badge

How SourceMonkey decides which scripts apply to a URL, and how that
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
  subdomain), exact domain, or empty (for `file://`). May include a
  `:port` suffix — Chrome's docs disallow ports but its matcher
  accepts them, and we follow that so the badge stays in step with
  what Chrome actually injects. Port-less patterns match any port.
- **path**: glob with `*`. `*` matches any chars including `/`. The
  glob runs against `pathname + search`, so `?id=*` works.
  - Not the `#hash`, as in Chrome's matcher: a URL's fragment never
    stops a match, and a `@match` naming a `#hash` matches no URL (see
    [Patterns Chrome refuses](#patterns-chrome-refuses)).
  - `@include` / `@exclude` do see the hash (below). Tampermonkey
    ignores it there too; see `tests/examples/headers-match-hash/`.

Host comparison is case-insensitive.

#### Lenient readings (`canonicalMatchPatterns`)

Two shapes Chrome's parser refuses have one obvious reading, and real
scripts are full of them. Both are rewritten into Chrome's spelling
before anything else looks at them:

| Written | Read as | Why |
|---------|---------|-----|
| `*.example.com/*` | `*://*.example.com/*` | Scheme omitted |
| `//example.com/*` | `*://example.com/*` | Protocol-relative |
| `://example.com/*` | `*://example.com/*` | Empty scheme |
| `*//example.com/*` | `*://example.com/*` | `*://` missing its colon |
| `http*://example.com/*` | `*://example.com/*` | Scheme glob |
| `*s://example.com/*` | `https://example.com/*` | Scheme glob |

- A scheme containing `*` is **globbed against the supported schemes**
  (`http`, `https`, `file`, `ftp`), and one pattern comes back per
  scheme it names — the glob is enumerated, not approximated.
  - `http*://` names http + https, which is exactly what `*` means, so
    it comes back as `*://` — the same set said shorter.
  - Every other expansion comes back as concrete schemes: `*s://` →
    `https://` alone, `*t*://` → `http://` + `https://` + `ftp://`.
  - So there is **no scheme re-check afterwards, and none is needed**.
    Nothing is ever rounded up to `*`: a `*s://` pattern is registered
    as `https://` and never sees an http page in the first place. That
    matters because Chrome does the matching — a pattern registered
    wider than the author's would inject before any wrapper-side
    filter could run.
- A glob naming **no** supported scheme (`chrome-*://…`) is left alone,
  so it is still reported as an unsupported scheme rather than
  silently widened.
- The rewrite runs ahead of the matcher, the validator, and the
  registration, so all three see one pattern. In particular Chrome
  registers the rewritten form — an unrewritten pattern would be
  dropped, and the script would stop running where its author said.
- `userscript-prelude.js` carries the same rewrite, because the
  wrapper-side matcher has to agree with what the SW registered.
- A rewritten pattern is honored **as written**, host wildcard and
  all: `http*://*/forum.php` becomes `*://*/forum.php` and the script
  runs on every site with that path. It ran nowhere before, so this is
  a widening — but to the scope its author asked for, and 45 corpus
  patterns are of that shape.
- `*//example.com/*` is the one shape read as a typo rather than
  literally. Taken at face value it means "any host, path beginning
  `//example.com/`" — a different site from the one written, which the
  bullet above would then widen to. Chrome refuses it either way.

Why bother:

- Over the Greasy Fork corpus these two shapes are nearly every
  `@match` Chrome refuses — 710 scheme-less and 202 globbed, out of
  1,035 (see below). The rewrite makes **877** of them usable; the
  remainder fail for a second reason as well.
- Those are the site's most-installed scripts, so they work under
  whatever manager their authors and users run. Only Chrome's parser
  can't spell what they wrote.
- **Not** measured against a real Tampermonkey: that needs the
  cross-manager browser profile, which is set up by hand (see
  [cross-manager-testing.md](cross-manager-testing.md)).
- Safe without that measurement anyway — every pattern the rewrite
  touches is one Chrome refused outright, so a lenient reading can
  only add pages a script runs on, never take one away.

#### `*` beside a numeric port

The one place the rewrite has to say `*` the long way. Chrome's parser
refuses `*://localhost:3000/*` with `Invalid port`, but accepts:

- `http://localhost:3000/*` — a named scheme beside the same port;
- `*://localhost:*/*` — `*` beside a wildcard port.

So `*://host:3000/*` is registered as the pair `http://host:3000/*` +
`https://host:3000/*` — what `*` means anyway.

- Applies to patterns written that way, not just to the lenient
  rewrites: a port-pinned `*://` pattern used to be a
  [REJECTED](injection.md#rejected-registrations) registration.
- Probed against Chrome 148; the lenient-match cases in
  `tests/e2e/injection.spec.ts` pin it against a real browser.

#### Patterns Chrome refuses

`matchPatternProblem` checks each `@match` against the same grammar at
parse time, because Chrome refuses a **registration as a whole** over
one malformed pattern — the script's good patterns die with the bad
one, and the complaint comes back in Chrome's coordinates
(`matches[1]: Empty path`).

It judges the **canonical** form, so the lenient shapes above are
accepted, and a problem the rewrite doesn't cure is reported against
the pattern the author actually wrote.

What it flags that Chrome names in its own refusal:

- no path (`https://example.com`) — the common one, and the one other
  managers accept;
- a scheme outside `*` / `http` / `https` / `file` / `ftp` (after glob
  expansion, so `chrome-*://` is flagged and `http*://` is not);
- an empty host, for a scheme that has one;
- a host holding a character no hostname can (`https?:\/\/weibo.com/p/*`
  — a regex in an `@match`, which the scheme-less reading would
  otherwise turn into a pattern with a host of `https?:\`);
- `*` anywhere in the host but as the whole host or its first label.

One more that Chrome accepts, but which can never match:

- a `#` in the path (`https://app.example/#/settings*`). Chrome
  matches without the URL's `#hash`. Violentmonkey does match it, so
  a script written there would otherwise never run, with no word why.
  The warning points to `@include`.

What happens to one:

- **Dropped** from the registration spec (`buildRegistrationSpec`), so
  the script still runs everywhere its other patterns say.
- **Warned about** in the Log, on the header line that declared it —
  one row per pattern, since each has its own reason and line.
- **Fatal** only when it leaves the script with no `@match` and no
  `@include` that could ever match: `validateHeader` then stores the
  row INVALID with that pattern's own reason.

Deliberately narrower than Chrome's parser — a false positive would
drop a pattern that works. A malformed port, say, still reaches Chrome
and still comes back as
[REJECTED](injection.md#rejected-registrations), which remains the
backstop for everything this doesn't reproduce.

Dropping is safe because the two agree: every pattern flagged here is
one `matchPattern` could never have matched either, so no page loses a
script it was getting.

How common this is, measured over the Greasy Fork corpus
(`tests/greasyfork-examples/corpus.db`, 1,991 scripts, 9,003 `@match`
patterns):

- **158 patterns** still fail the check, and **34 scripts** are left
  with nothing usable.
- Before the lenient readings it was 1,035 and 81 — the rewrite is
  what closed the gap.
- What is left is mostly a bare origin with no path (92) and a `*` in
  the middle of a host (62). Neither has a single obvious reading;
  TODO.md tracks them. The rest is a scheme nothing supports and one
  regex pasted into an `@match`.

None of these can run under Chrome either way — it refuses their
registrations — but the patterns exist because other managers match
with their own engines rather than Chrome's.

### `@include` — free-form glob

A `*`-glob anchored to the whole URL string, `#hash` included, as
Chrome's `include_globs` are. `*` matches any run of characters. If the
pattern is wrapped in `/.../` it is treated as a JavaScript regex instead.

- A glob is case-sensitive: Chrome evaluates it.
- A regex ignores case, as in Tampermonkey and Violentmonkey. Chrome
  has no regex rules, so the wrapper's in-page matcher applies it.
- Slashes inside a regex need no escaping. A flag after the closing
  slash (`/.../i`) makes the pattern a glob, which matches nothing, as
  in the other managers.
- Tampermonkey and Violentmonkey also ignore case in a glob, since they
  match every rule themselves. See `tests/examples/headers-include-regex/`.

### `@exclude` — same syntax as `@include`

Same grammar (`*`-glob or `/regex/`). **Excludes always win** — if any
`@exclude` pattern matches the URL, the script does not match, even if
a `@match` or `@include` would have hit.

### `.tld` hosts

Tampermonkey's suffix for "this name under any public suffix":
`*://www.google.tld/*` runs on www.google.com, www.google.de and
www.google.co.uk. Read the same way in `@match`, `@include` and
`@exclude`.

- **Where it counts**: only as a host's last label (`www.google.tld`,
  `*.imdb.tld`, with or without a `:port`). `.tld` anywhere else, or
  inside a `/regex/`, is literal text.
  - An `@include` glob may run the host straight into a `*` with no
    `/` (`http://www.google.tld*`); the `.tld` still ends the host.
  - `*.tld` with no name in front stays literal in all three tags.
- **What it matches**: any suffix in the ICANN section of the Public
  Suffix List (PSL, publicsuffix.org), the suffixes under which
  domain registries hand out names. That includes multi-level ones a
  registry keeps (`co.uk`, `com.au`), and not ordinary names
  (`com.de`, `evil.com`).
  - The PSL's private section (`blogspot.com`, `github.io`) is left
    out: a name under one belongs to whoever registered it there, and
    `www.google.blogspot.com` isn't Google's. Violentmonkey includes
    it; Tampermonkey uses its own fixed, ICANN-only list.
  - Names no registry hands out (`.local`, `.lan`) don't match: the
    PSL's implicit "any unknown label" rule isn't applied.
- **How it's tested**: each public suffix the URL's own host ends in
  is put in place of `.tld`, and the result tested as an ordinary
  pattern. So `.tld` can only ever stand for the host's real suffix.
- **The list**: `src/public-suffixes.ts`, generated by
  `node scripts/update-public-suffixes.mjs` and committed, so the
  build stays offline. Rerun it now and then; the diff shows what
  changed.
- **Where it's decided**: the list (about 75 KB) stays out of pages.
  - Registration: Chrome's grammars can't say `.tld`, so a `.tld`
    `@match` or `@include` registers a coarse glob: `.tld` becomes `.*`
    (`*://www.google.*/*`), and a `@match`'s leading `*.` becomes `*`
    (`tldCoarseGlob`). See [injection.md](injection.md#regex-pattern-forms).
  - In the page, the wrapper's matcher reads `.tld` loosely, as any
    labels, and ignores a `.tld` `@exclude` (a loose one would exclude
    too much).
  - The exact reading comes from the service worker (sm-dev's host,
    under sm-dev): the wrapper's `sm:check-pending` carries `tld: true`,
    and the reply is `skip` with reason `no-match` where the exact
    reading says no. The wrapper treats that like its own matcher
    saying no, and reports nothing.
  - With no reply (the worker never answered), a `.tld` script skips
    rather than runs: the loose reading alone would also take hosts
    like `www.google.evil.com`.
- **Site icons and links** for a `.tld` `@match` use `.com`.
- Pinned by `tests/unit/url-match.test.mjs`, the prelude cases in
  `tests/unit/injector.test.mjs`, and in a real browser
  `tests/e2e/tld-hosts.spec.ts` and `tests/harness/inject.spec.ts`.

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
flag and its parent collection's `enabled` flag are true. The two toggles
compose: turning the collection off blanks the count for every script
under it, but each script's individual choice is preserved so flipping
the collection back on restores the prior state.

## In-memory match index

`src/match-index.ts` keeps an in-memory `Map<scriptId, MatchedScript>`
of every injectable script so the background SW never hits
`chrome.storage.local` on the navigation hot path. Injectable means
`status: 'ok'`.

Lifecycle:

- **Startup**: `ensureLoaded()` reads all `script:*` and `collection:*`
  rows once, populates the cache, and records which collections are
  disabled.
- **Updates**: `installStorageListener()` registers a
  `chrome.storage.onChanged` listener that mutates the cache in place
  on every `set`/`remove` of a `script:*` or `collection:*` key. `ok`
  scripts are kept; `error` entries get evicted. The per-script
  `enabled` flag is checked in `findMatchesForUrl`, not at cache
  build. Collection changes
  flip an in-memory `disabledCollections` set, which lets a collection toggle
  re-evaluate every script under it in O(1).
- **Subscribers**: `onCacheChanged(fn)` lets the background SW re-badge
  every open tab when the script set itself changes (e.g. after a
  directory Refresh on the collections page or a per-collection / per-script
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
  (sm:start / sm:error reports — see below).

### Badge view (expected ∪ actual)

`src/tab-status.ts` derives the badge from the combined state:

- **Count** — size of the union of expected and actual script IDs.
- **Color**:
  - **RED** (`#d32f2f`) — any script reported an error, or is one
    Chrome refuses to register (see
    [injection.md](injection.md#rejected-registrations)).
  - **PURPLE** (`#d500f9`) — no errors, but at least one running
    script's source file on disk has changed since the wrapper for
    this document ran. Reload the page to pick up the new version.
  - **ORANGE** (`#f57c00`) — no errors or stale rows, but the
    expected set and the actual set diverge (MISSING or UNEXPECTED).
  - **GREY** (`#757575`) — nothing else to report, and the user loaded
    this document with "Reload page with no userscripts" (rows show
    NOT LOADED). Nothing is wrong; nothing ran.
    - Also in a tab an sm-dev run controls, for the scripts its claim
      kept out, when no script ran there. See
      [sm-dev-extension.md](sm-dev-extension.md#the-toolbar-badge-in-a-claimed-tab)
      for that tab's count, icon marker and menu row.
  - **GREEN** (`#2e7d32`) — expected and actual line up exactly with
    no errors.
- **Tooltip** — `"SourceMonkey"` followed by one line per script,
  formatted `"<name> | <STATUS>"`, sorted by name. `<STATUS>` is one
  of:
  - `OK` — expected and the wrapper sent `sm:start` with no error.
  - `ERROR` — wrapper sent `sm:error` (regardless of expected).
  - `REJECTED` — expected by the matcher, no `sm:start`, and Chrome
    refused the registration, so none is coming. A refinement of
    `MISSING`: both mean "expected here, never reported", but `MISSING`
    is provisional (the wrapper may still be in flight) while this is
    settled, which is why it takes the error colour. Same word the
    collections page and the viewer use for the row.
  - `NOT LOADED` — expected by the matcher, no `sm:start`, and none
    is coming because the document was loaded with "Reload page with
    no userscripts" (`scriptsSkipped` on the document's state). Also
    a refinement of `MISSING`, settled by the user rather than by
    Chrome, so it outranks `REJECTED` for the row and takes grey.
  - `MISSING` — expected by the matcher but no `sm:start` yet.
  - `UNEXPECTED` — wrapper sent `sm:start` but the matcher didn't
    predict it (e.g. Chrome's matching disagrees with ours, or a race
    against a script-store change).
  - `Reload to update` — the script is running here but its collection
    on disk has changed since. The verbose label is rendered in place
    of the raw enum so the tooltip tells the user what to do.
- **Action context menu** — same `"<name> | <STATUS>"` lines as
  additional entries under the right-click menu on the toolbar icon
  (below Chrome's built-in items). Clicking one opens that script's
  viewer page in a new tab. Rows whose status is `ERROR` (the wrapper
  sent `sm:error` for this document) open the viewer with `#Log` so
  the user lands on the Log pane with the failure detail in view;
  every other status routes to the default (main script) tab.
  - `chrome.contextMenus` action items are global to the action, so
    we keep them synced to the active tab.
  - **Clicks act on the tab Chrome names in `onClicked`**, not on the
    tracked active tab, and the viewer opens in that tab's window.
    - The tracked id comes from focus events, which can name a window
      the user left earlier when several windows (or virtual desktops)
      are open. The click itself can't be stale.
    - The menu *contents* are still built for the tracked active tab.
      When the two disagree, a clicked command isn't registered on the
      clicked tab and does nothing; the SW console says so.
    - Same reason a toolbar click opens the collections page in the
      clicked window instead of letting `openOptionsPage` focus a copy
      in whatever window Chrome last recorded. The trade is one
      collections tab per window rather than one overall.
  - Rebuilt on `chrome.tabs.onActivated`,
    `chrome.windows.onFocusChanged`, and any `renderBadge` for the
    active tab. Also rebuilt when a userscript registers or
    unregisters a menu command (see below).
  - **Nested menu commands** — entries created via
    `GM_registerMenuCommand` appear indented (`↳ <name>`) directly
    under their script's row. Clicking one routes
    `sm:gm-menu-fire` to that tab so the wrapper invokes
    the registered callback. See [GM-APIs.md](GM-APIs.md) for the
    full lifecycle.
  - **"Reload page with no userscripts"** — the last row, present
    whenever the menu has at least one script row. See
    [Reload with no userscripts](#reload-with-no-userscripts).
  - **"Page under sm-dev control"** — a disabled first row, in a tab
    whose page loaded under an sm-dev run's claim. It takes a slot of
    the cap too.
  - **6-item cap + "More" submenu** — Chrome skips action
    context menus after 6 top-level rows. We pre-empt that by capping
    the top level ourselves:
    - Total rows = sum over groups of `1 (script row) + N commands`.
    - The reload row takes one of the 6 slots, so script groups get 5.
    - If the total fits, everything renders top-level.
    - Otherwise we reserve one more top slot for a "More" parent, pack
      script groups into the remaining 4 in incoming order, and
      push any group that doesn't fit (plus every later group, to
      preserve visible order) into the submenu.
    - A script's row and its menu commands always travel as a unit —
      no group is split between the top level and "More".
    - The layout decision lives in `src/action-menu.ts` and is
      reflected by the SW test surface `getActionContextMenuPlan(tabId)`.

### Reload with no userscripts

The action menu's last row reloads the tab once with every script
skipped.

- Registrations are untouched — other tabs on the same site keep
  running their scripts, and the tab's next navigation runs them again.
- Needs `chrome.webNavigation`; the row is withheld without it.

- **Mechanism** — every wrapper asks the SW `sm:check-pending` before
  running its body, and `skip` is an answer it already honours (see
  [injection.md](injection.md#sm-check-pending-handler)). A skip
  reload is a per-tab marker that handler consults first, ahead of
  the reload fast path (which isn't set up for a skip reload).
- **Lifecycle**, keyed on main-frame commits, in `src/background.ts`:
  - click → the tab is *armed*, then `chrome.tabs.reload`.
  - reload commit → armed becomes *skipping* for that document. Every
    wrapper in the tab gets `skip` — subframes too, whose documentIds
    are their own, which is why the marker is per tab.
  - the commit after that, or the tab closing → cleared.
  - Only a `reload` commit within a few seconds consumes *armed*; any
    other commit disarms. A reload the page cancels (`beforeunload`)
    must not make the next link click skip.
- **Timing** — the commit listener settles the marker synchronously,
  before the queued tab work: a `document-start` wrapper's
  check-pending can arrive before that work runs.
- **In memory, not persisted.** The marker normally lives for the
  milliseconds between click and commit. A reload slow enough for the
  SW to idle out in between just runs scripts as usual; a SW restart
  mid-document only affects subframes injected afterwards.
- **Badge** — `updateTabMatches` stamps `scriptsSkipped` on the fresh
  document's `TabMatchState` (persisted, so the badge survives a SW
  restart); a bfcache return keeps it while the document is still in
  the per-tab LRU. Rows render `NOT LOADED` in grey.
- **Log** — each wrapper's `sm:abandoned` lands on its script's Log
  as `info` (not `warning`, the level for any other skip) with the
  reason `reload with no userscripts`.
- **Click target** — the tab Chrome names in `onClicked`, like the
  other rows.

### Actual reports from injected wrappers

Every wrapper sends `sm:start` on activation and `sm:error` on a
synchronous throw. The SW listens on
`chrome.runtime.onUserScriptMessage` (NOT the regular
`runtime.onMessage`) and merges each report into the tab's `actual`
map keyed by script ID. See [injection.md](injection.md#message-flow)
for the wrapper-side payloads.

### Scripts that never start

A MISSING row says a script matched but never reported. Once the page
has loaded, the script's Log says so too, with what we can tell about
why (`src/missing-scripts.ts`):

- **When**: `webNavigation.onCompleted` for the top frame, plus a 3s
  grace period for document-idle scripts still waiting on their
  check-pending reply. At most once per document (`missingChecked`).
- **Which scripts**: those that matched when the document was first
  seen (`loadMatchIds`), with no report, and not already explained by
  REJECTED or NOT LOADED.
  - Not ones that matched only a later pushState URL, or were installed
    after the document committed. Those are MISSING on the badge but
    were never going to be injected.
- **What the document's other reports add**: every wrapper report
  carries `opaqueOrigin` (`self.origin === 'null'`), and the SW knows
  its world from `__viaBridge`. Both are kept per document as
  `reportedWorlds` / `opaqueOrigin`.
- **The hint**, for a MAIN-world script:
  - Another MAIN-world script reported → the page isn't blocking that
    world.
  - Else an opaque origin on an http(s) page → the page is sandboxed.
    A CSP `sandbox` header without `allow-scripts` turns off script in
    the page's own world, so Chrome silently skips MAIN-world
    registrations there. Suggests `@inject-into content`.
  - Else nothing to go on → names the possibility and what header to
    check. Left off on file:// pages, which have no headers.
- **For a USER_SCRIPT-world script**, it only notes whether other
  USER_SCRIPT-world scripts started.
- No probing: the extension doesn't refetch the page or inject test
  code to find out more. sm-dev, which sees the response headers, says
  it directly (see `docs/sm-dev-design.md`).
- Pinned by `tests/e2e/sandbox-csp.spec.ts`.

### documentId is the lifecycle key

`chrome.userScripts` injects exactly once per document. Fragment
changes, SPA pushState, and bfcache restores all keep the same
document — no re-injection, no new `sm:start`. Resetting `actual` on
every URL change would falsely flag those scripts as MISSING. So we
key state by `documentId`:

- **Known `documentId`** (script-set refresh, SPA URL change in the
  current doc, **or bfcache restore returning to a doc we still
  remember**): keep `actual` untouched. Union the new URL's matches
  into the stored `matches` list — a script that matched any URL
  during this document's life is "expected to have injected by now,"
  and surfaces as MISSING if `sm:start` never came.
- **Unknown `documentId`** (full document load to a doc we've never
  tracked, or one that aged out of the LRU): reset `actual` to `{}`
  and start a fresh expected set from this URL's matches.
- **Bootstrap race** — if a `sm:*` arrives before
  `webNavigation.onCommitted` has set the tab state (cold SW start or
  pure ordering race), the SW synthesises state from `sender.url` and
  `sender.documentId`. A follow-up `onCommitted` for the same
  documentId will hit the same record and preserve `actual`.
- **Errors are sticky** for the same script ID on the same document —
  a later `sm:start` doesn't silently flip ERROR back to OK.

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
  current one — used by the message handler so a late `sm:*` from a
  doc we already navigated away from updates its slot (so it survives
  another bfcache visit later) but doesn't steal the badge from the
  on-screen doc.
- Eviction drops the oldest non-current doc when the cap is exceeded.
  Five slots covers normal back/forward chains; deeper history loses
  state but Chrome's bfcache itself has comparable limits.

### Per-tab serialization

All mutations for a given tab — navigation events, sm:* reports,
removals, refresh-driven recomputes — go through a per-tab promise
queue (`enqueueTabWork`). Without it, two `sm:start` messages that
arrive in the same event-loop turn each do their own get/modify/set
against `chrome.storage.session` and the second write loses the first
update.

## Stale-tab notification

When a script's on-disk content changes — whether from a manual
Refresh, a Refresh All, or a background opportunistic check (see
[storage.md](storage.md#updater)) — every open tab whose current
document is running the OLD version flips to PURPLE/RELOAD.

For a **local** script the check that finds the change is usually the
[focus-triggered one](updates.md#focus-triggered-refresh), which runs
when the user switches to the tab. Persistent purple is then up
*before* they reload, and the reload that follows is clean rather than
a race. An http(s) script is not checked on focus, so its purple still
arrives on the navigation that noticed the update.

How it works:

- All refresh paths go through `script-updater.ts`, which writes via
  `script-store.ts` to `chrome.storage.local`. Fresh content bumps the
  row's `loadedAt`.
- `background.ts` installs a `chrome.storage.onChanged` listener on
  `script:*` keys; whenever `oldValue.loadedAt !== newValue.loadedAt`
  the script id goes on a "changed" list.
- The listener walks every persisted `tab:<tabId>` record's CURRENT
  doc. For each changed id with any actual report (`started` OR
  `error`), `markScriptStale` adds it to that doc's
  `staleScriptIds`; `computeBadge` re-renders.
- A stale ERROR row promotes to RELOAD/purple — the error came from
  the OLD content, and the fix on disk may already address it, so
  "Reload to update" is more actionable than continuing to show red.
- A new document load (new `documentId`) creates a fresh state, so
  reload naturally clears the stale flag. The wrapper for the new
  document runs the freshly-stored content.
- A reload that triggers the [fast-path](injection.md#reload-fast-path)
  may land the new body on THIS navigation via `sm:swapped`;
  `clearScriptStale` removes the id from `staleScriptIds` so the badge
  doesn't keep nagging.
- That same reload paints purple *briefly* while the swap lands, so a
  successful update is visible rather than silent — see
  [Purple flash while a swap lands](injection.md#purple-flash-while-a-swap-lands).
  Persistent purple keeps its meaning here: reload to update.

### Closing the report-after-change race

- **Symptom**: the storage write can land before the wrapper's
  `sm:start` does, leaving `actual` empty when the listener walks the
  tab — so nothing gets flagged.
- **Mitigation**: every wrapper carries the `StoredScript.loadedAt`
  it was registered with in `sm:start` / `sm:error` payloads.
- **Comparison**: `recordScriptReport` compares the wrapper's
  `loadedAt` against the current stored row's `loadedAt`. If the
  stored one is newer, the wrapper ran OUTDATED code and the script
  id is marked stale right there, ahead of the listener path.
- **Both orderings covered**: listener-then-report goes through the
  listener path; report-then-listener (the SW-startup or storage-fast
  case) goes through the wrapper-loadedAt comparison.

### Opportunistic checks only fire on real navigation

- **Refresh path** (`refreshAllOpenTabs`, driven by `onCacheChanged`)
  passes `trigger: 'refresh'` to `updateTabMatches` and skips the
  opportunistic file-system check.
- **Navigation path** (`webNavigation.onCommitted` /
  `onHistoryStateUpdated`, plus the `chrome.tabs.onUpdated` fallback)
  passes `trigger: 'navigation'` and runs the check.
- **Why**: without this, editing one script would fan out into a
  stat-and-fetch on every script on every other open tab on every
  script-set change.

Why match by `loadedAt` rather than `bodyText`:

- `loadedAt` bumps iff the load pipeline built from fresh fetched
  content. The size+mtime skip path preserves the prior row's
  `loadedAt`, so a no-op refresh produces no badge flap.
- `bodyText` comparison would also fire for byte-identical re-saves
  triggered by the unchanged-skip-not-applying corner case (e.g. when
  a directory listing doesn't include mtime).

## What this doesn't do (yet)

- **Per-tab match override.** There is no UI yet to disable a matching
  script for one specific tab.
