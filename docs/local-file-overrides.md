# Local file overrides for `@require` / `@resource` / `@icon`

How a script keeps a portable, absolute-URL `@require` and still gets
developed against a copy on your own disk.

Owned by [`src/local-file-overrides.ts`](../src/local-file-overrides.ts).
Applied in two places — [`src/external-files.ts`](../src/external-files.ts)
for `@require` / `@resource`, and [`src/site-icon.ts`](../src/site-icon.ts)
for `@icon` (see [below](#every-file-a-script-declares-is-treated-alike)
for why they aren't one). See [requires.md](requires.md),
[resources.md](resources.md), and [site-icons.md](site-icons.md) for the
rest of the loading pipelines.

## The problem

- SourceMonkey accepts **relative** `@require` paths. Nothing else does
  — not Tampermonkey, not Violentmonkey, not Greasemonkey.
- So a script meant to run anywhere has to write the published absolute
  URL.
- But while you are *writing* that library, the published copy is stale,
  or doesn't exist yet.

## The rule

Given an ordered list of local root directories, try progressively
shorter **path suffixes** of the declared URL under each root, longest
first. The first readable file wins.

```
root  /home/me/dev/mystuff
ref   https://cdn.example.com/lib/util.js
→     /home/me/dev/mystuff/lib/util.js
→     /home/me/dev/mystuff/util.js
```

- **Longest first**, so a deliberate `lib/` layout beats a loose
  `util.js` in the root.
- **First readable wins.** The probe and the real read are the same
  fetch, so a hit costs nothing extra. A miss costs one local read *per
  candidate*, i.e. one per path segment of the declared URL — a
  `…/npm/jquery@3.6.0/dist/jquery.min.js` produces four.
- **No stand-in → the declared URL is fetched**, exactly as before.

The same-directory case is not a separate rule — it is this rule with an
implicit root of the script's own folder, where the only suffix that can
match is the bare filename. One code path, so the two can't drift.

### Roots today

Phase 1 produces at most one root: **the host script's own folder**.
Configured per-source and global search roots are a planned follow-on —
see [TODO.md](../TODO.md). The implicit folder always sorts first.

## What keeps it safe

Not which tag is being resolved, but **who the host script is**:

- **Inferred** substitution applies only when the host script's own URL
  is `file://`. Such a script already has ambient reach over its own
  folder — a relative `@require ./util.js` resolves there today — so a
  stand-in from that folder grants nothing new.
- An **http(s)-loaded script never gets inference**. That is the case
  where a hostile `@resource file:///home/you/.ssh/id_rsa` followed by
  `GM_getResourceText` would actually matter.
- Explicit per-file overrides (a path you typed for one specific ref)
  will be allowed for any host script, because naming the file *is* the
  authorization. Not built yet — see [TODO.md](../TODO.md).

Traversal is closed by construction:

- Candidates are built only from `URL.pathname` segments, which the URL
  parser has already normalized — no `..` and no `%2e%2e` survives into
  a segment.
- Every candidate is re-checked against its root prefix before being
  offered.
- A root is therefore a floor, not a starting point for climbing.

Existing gates still run on the **declared** URL, before any stand-in is
considered — so a local file can't launder a ref past them:

- the `@require` `.js` suffix gate;
- `resolveScriptResource`'s scheme and containment rules.

## Every file a script declares is treated alike

`@require`, `@resource`, and `@icon` all take overrides, under the same
rule and the same gate. The risk boundary is the host script's own
scheme, not the tag — and a local script can already read its own folder
via a relative ref of any of the three.

They do NOT share one call site, though:

- `@require` / `@resource` resolve in
  [`src/external-files.ts`](../src/external-files.ts).
- `@icon` resolves in [`src/site-icon.ts`](../src/site-icon.ts), which
  has its own bounded fetch, `image/*` gate, and caches.

Both call `localFileCandidates` and take the first candidate that reads.
The override is deliberately NOT pushed down into
[`src/file-loader.ts`](../src/file-loader.ts), which every file consumer
shares, for two reasons:

- The roots are per-script context that `file-loader` has no access to.
- **`@updateURL` / `@downloadURL` probes must never take an override.**
  Their whole job is reporting what is published upstream; a local
  stand-in would make them lie. Keeping the override one layer up makes
  each consumer opt in explicitly instead of inheriting it by accident.

### `@icon` caching

The icon path caches results in `chrome.storage.local` for 7 days
(24 hours for a miss). A local candidate deliberately skips that cache
and is memoized for the life of the page instead:

- A cached miss would mean an icon file created after the first paint
  didn't appear for a day — the same "why isn't my edit showing up" trap
  the require policy exists to avoid.
- Cost is one local read per icon per page load; repaints are free.
- A page reload always reflects the current state of the disk.

## Refresh policy

`@require` / `@resource` bodies are normally cached by URL and only
re-fetched on an explicit Refresh (see
[requires.md](requires.md#refresh-policy)). Local stand-ins are the
exception:

- **A stand-in is re-read on every refresh, including opportunistic
  ones.** Otherwise editing a library wouldn't surface until you clicked
  Refresh, which is the workflow the feature exists for.
- **Remote dependencies keep the cached-and-left-alone treatment**, so
  per-navigation cost stays bounded for a user with many requires.
- A prior entry that carries a `localUrl` is **never** preserved on the
  fast path: it describes a file that may since have been deleted, and
  keeping it would serve a stand-in that no longer exists.

Cost when enabled, for local-source scripts only: up to one local read
per path segment of each declared dependency's URL, per refresh. A hit
short-circuits the rest, and `ensureFetch` dedups within a pass. Note
that a script with local roots also skips the whole-list `preserve`
shortcut, so it re-runs resolution every opportunistic refresh — that is
the price of edits showing up without a Refresh click.

### A stand-in that appears later

The candidate probe runs every pass, so creating the local file is
picked up on the next opportunistic refresh — no Refresh click needed.
True for installed scripts, whose fetch cache lives for one refresh
pass. Not true in the install preview or for `@icon`, both of which
memoize for the life of the page — see the caveats under
[Surfacing it](#surfacing-it) and [`@icon` caching](#icon-caching).

## Storage

Both `StoredRequire` and `StoredResource` gain one field:

- `localUrl?` — the `file://` URL actually read, present only when a
  stand-in was used. Its presence *is* "this entry was overridden".
- `url` keeps the **declared** URL either way. It is the dedup key, it
  is what the script says it depends on, and it is what the entry falls
  back to when the local file goes away.

## Per-source opt-out

`StoredSource.localFiles` — only an explicit `false` disables it, so rows
persisted before the field existed read as enabled.

- Rendered as a **Local files** checkbox in the source's header on the
  sources page, next to Refresh / Remove.
- Shown only where it can do something: http(s) sources and the http /
  github containers are excluded, since every script under them loads
  over the network.
- Toggling it refreshes the source, because the flag only changes what
  the *next* refresh resolves to.
- Off is for a directory of scripts you didn't write, where a file
  sitting next to one should not quietly stand in for the library it
  names.

## Surfacing it

Running something other than what the `@require` line names must never
be silent, so several surfaces say so:

- **Viewer tab strip** — a `local` chip on the require's tab, plus a
  tooltip carrying both the declared URL and the file we read,
  blank-line separated:

  ```
  https://cdn.example.com/lib/util.js

  Loaded from file:///home/me/scripts/util.js
  ```

  - Both lines are URLs, so the pair reads as "asked for this, got
    that". Prose surfaces (the Log) use the bare path instead.
  - Every code tab has the URL tooltip, the main script's included:
    labels are bare basenames, so "which file is this" is a fair
    question on any of them. Only the chip is override-specific.
- **Details panel** — the `Loads libraries` / `Loads resources` rows
  annotate each declaration with its loaded size and, when overridden, a
  `local` chip whose tooltip is `Loaded from <url>`, the same wording and
  URL form as the tab tooltip.
- **`@icon` has no marker.** The favicon slot is a 16×16 image with no
  room for a chip, and an icon served from the wrong place is a cosmetic
  surprise rather than a code-execution one.
- **Log tab** — an `info` line (`… is loading from file://…`) when a
  stand-in starts, stops, or changes on disk. Gated on `contentHash`, so an unchanged stand-in stays quiet
  across the many opportunistic refreshes between edits.

The install preview does all of this too: the parse check resolves every
declared file anyway, and a not-yet-published `@require` is exactly the
case that bites before install. Two caveats there:

- Its fetch cache is **page-lifetime**, so a stand-in created after the
  page loaded needs a reload — unlike the installed path, which gets a
  fresh cache per refresh.
- When any declared file fails, `attachFiles` reports the failure with
  empty lists, so there are no per-file annotations to show at all. Every
  declaration still appears; none of them carries a size or a chip.

## Wording

Log lines follow [diagnostics.md](diagnostics.md#wording):

- `@require <ref> is loading from <file:// url>`
- `@require <ref> is no longer loading from a local file`

Same short form as the tab tooltip's second line, and the same `file://`
URL rather than a bare path, so one fact doesn't read two ways depending
on which surface you're looking at.

Every URL shown to a human — in a Log line, a tooltip, or a details row
— goes through `displayLocation` first, so a path carrying a script's
name reads as `my lib/my util.js` rather than `my%20lib/my%20util.js`.
And every declared reference goes through `stripSriFragment`, so a hash
tail never eats the width of the line.

## SRI hash fragments are stripped for display

A `@require` may carry its expected hash in the URL fragment, in
Tampermonkey's form (`#md5=…`, `#sha256=…`, comma-separated for
several). `stripSriFragment` in
[`src/file-loader.ts`](../src/file-loader.ts) drops it from every
human-facing surface — tab tooltip, Log lines, and the details panel's
`Loads libraries` / `Loads resources` rows.

- A 64-hex-digit tail is most of the width of a tooltip or a row and
  tells the reader nothing they can act on.
- Stripped only when **every** comma-separated part looks like a hash
  declaration, so an ordinary `#section` fragment survives.
- A malformed hash tail survives too — a reader wondering why validation
  didn't happen needs to see what they typed.
- Fetching, resolution, dedup, storage, and **error messages** all keep
  the verbatim ref: an error should name what the author wrote.
- SourceMonkey does not validate these hashes yet; see
  [TODO.md](../TODO.md).
