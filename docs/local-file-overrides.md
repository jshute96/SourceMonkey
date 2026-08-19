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
shorter suffixes of **`<host>/<path>`** of the declared URL under each
root, longest first. The first readable file wins.

```
root  /home/me/dev/mystuff
ref   https://cdn.example.com/lib/util.js
→     /home/me/dev/mystuff/cdn.example.com/lib/util.js
→     /home/me/dev/mystuff/lib/util.js
→     /home/me/dev/mystuff/util.js
```

- **The host is the outermost segment**, so a mirror-style tree — one
  directory per site, the layout `wget -x` and scraped-copy directories
  produce — matches, and matches first.
  - Written the way the URL has it, port included when there is a
    non-default one (`localhost:8080`).
  - An international host is therefore its **punycode** form
    (`xn--bcher-kva.de`), which is also what `wget` writes. A hand-made
    tree holding the Unicode name will not match.
  - A `file://` ref has no host, so it just yields the path suffixes.
- **Longest first**, so a deliberate `lib/` layout beats a loose
  `util.js` in the root.
- **First readable wins.** The probe and the real read are the same
  fetch, so a hit costs nothing extra. A miss costs one local read *per
  candidate*, i.e. one per path segment of the declared URL plus one for
  the host-qualified form — a `…/npm/jquery@3.6.0/dist/jquery.min.js`
  produces five.
- **A ref that names no file matches nothing.** A path that is empty or
  ends in `/` yields no candidates at all: the suffix would name a
  directory, and Chrome answers a directory read with a listing rather
  than a failure — which `@resource` and `@icon`, having no `.js` gate,
  would happily bind as the file's body.
- **No stand-in → the declared URL is fetched**, exactly as before.

The same-directory case is not a separate rule — it is this rule with an
implicit root of the script's own folder, where the file sitting next to
the script is the suffix that usually matches. One code path, so the two
can't drift.

### Where roots come from

In search order:

1. **The host script's own folder.** Implicit, always first, always
   present. A file sitting next to the script is the least surprising
   answer, so it wins over anything configured.
2. **The collection's own root.** Implicit too, for a local directory or
   manifest collection — the tree the user named, which the collection's
   scripts already sit at relative paths inside.
3. **Configured global roots.** The search-paths box on the options
   page, in the order typed.

Why the collection root: a repo of userscripts keeps its scripts nested
(`sites/example.com/foo.user.js`) and its libraries shared (`lib/util.js`
at the top). A root is a floor and the search never climbs, so without
it a nested script could never see the `lib/` its own repo ships.

Which directory a collection contributes:

- **Local directory** — itself.
- **Manifest** — the manifest file's own directory, which is what its
  relative entries already resolve against.
- **Containers** (`container:file` and friends) — none. Their scripts
  are individually added absolute paths sharing no tree; each script's
  own folder is all they have in common.
- **http(s) collections** — none, and their scripts get no roots at all
  (the `file://` gate).

A root that duplicates one already in the list is dropped — a script at
the top of its collection has its own folder *as* the collection root —
so the list reads as what it claims to be: the *additional* places
searched, each appearing once. (Duplicate candidates would be collapsed
anyway; the de-dupe is about the list, not the probing.)

### Configured roots

- Stored under `smLocalFileRoots` as an **ordered array of canonical
  `file://` directory URLs** — already parsed and validated. Text
  becomes roots once, at Save; nothing re-parses at resolve time.
- Each non-blank line of the box is an absolute path or a `file://`
  URL. Canonicalized to a `file://` URL with a trailing slash, with `.`
  and `..` resolved.
- Parsing is **all-or-nothing**, which is why Save is disabled while any
  line is malformed: the stored array is the parsed form, so there'd be
  no honest entry to write for a line that didn't parse.
- Save writes the canonical form back into the box, so what's shown is
  what's searched.
- Save then **refreshes every collection that supports local files**, for
  the same reason the per-collection switch refreshes its collection: roots
  only change what the *next* refresh resolves to. http(s) collections and
  the web / GitHub containers are skipped — they resolve over the
  network, so a root cannot change their outcome.
- Cached in a module variable in each context that resolves — service
  worker, collections page, viewer.
  - Loaded once at startup, then kept current via `storage.onChanged`,
    the same shape as `debug-log.ts`.
  - `localSearchRoots` is synchronous because render paths call it, so
    ordering is the caller's job: the resolve path and both page
    bootstraps `await localRootsReady()` first.
  - Without that await, a refresh racing SW startup would resolve as
    though no roots were set — and persist the result.
  - An initial read still in flight will not overwrite a newer value
    that landed while it waited.

#### Validation

Two kinds of complaint, both shown under the box, and only one blocks
Save:

- **Format**, decided locally and instantly. **Blocks Save.**
- **Existence**, which needs a `file://` read, so it is debounced and
  cached per page. A *warning* only: the directory can appear later (a
  repo you haven't cloned), and saving it costs nothing, since
  resolution simply finds no candidate under it.

How the existence test works:

- A root is tested by **reading its directory URL**. Chrome serves a
  listing for a directory and fails for a plain file, so one read
  distinguishes "missing" from "that's a file".
- That is why the canonical form's trailing slash matters, and why a
  root carrying a fragment or query is rejected outright — both are
  stripped before the filesystem sees them, which would make the probe
  read a file and call it a directory.
- With *Allow access to file URLs* off every read fails identically, so
  the page shows the shared file-access banner instead of labelling
  every root missing.

## What keeps it safe

Not which tag is being resolved, but **who the host script is**:

- **Inferred** substitution applies only when the host script's own URL
  is `file://`. Its **own folder** grants nothing new: a relative
  `@require ./util.js` resolves there today, and `file-loader.ts`
  confines a relative ref to exactly that folder.
- An **http(s)-loaded script never gets inference**. That is the case
  where a hostile `@resource file:///home/you/.ssh/id_rsa` followed by
  `GM_getResourceText` would actually matter. The gate covers the
  collection root and configured roots too — a script installed from the
  web resolves nothing out of a development directory.
- The **collection root and a configured root are reach the script
  didn't otherwise have** — a relative ref cannot climb into either —
  and the script picks the path suffix it looks for. So every file under
  one is readable by any locally-loaded script in it, `@resource` +
  `GM_getResourceText` included.
  - What justifies each is that the user named that directory: a
    configured root on the options page, a collection root by adding the
    collection.
  - Both say so where they're set — the options page's note, and the
    per-collection **Local files** toggle's tooltip.
  - So point either at a directory of script content, not at a home
    directory. Turning **Local files** off for a collection takes the
    whole mechanism away for it.
- Explicit per-file overrides (a path you typed for one specific ref)
  will be allowed for any host script, because naming the file *is* the
  authorization. Not built yet — see [TODO.md](../TODO.md).

Traversal is closed:

- **Path segments** come from `URL.pathname`, which the parser has
  already normalized — no `..` and no `%2e%2e` survives into one.
- **The host segment is not normalized.** `new URL('https://../x.js')`
  really does have a host of `..`, so for that one segment the prefix
  re-check below is the enforcement, not a second opinion.
- **An encoded separator** (`%2F`, `%5C`) in any segment, host included,
  makes the whole URL ineligible: the parser leaves those alone and the
  filesystem layer may not.
- **Every candidate is re-checked** against its root prefix before being
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

Cost when enabled, for scripts in a local collection only: up to one
local read **per root** per path segment of each declared dependency's
URL, plus one for the host-qualified form, per refresh. A nested script
has two implicit roots (its own folder and its collection's), so a miss
costs roughly twice what it did before the collection root existed. A
hit short-circuits the rest, and `ensureFetch` dedups within a pass. Note that a script with local
roots also skips the whole-list `preserve`
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

`chrome.storage.local` key `smLocalFileRoots` holds the configured
roots as an ordered array of canonical `file://` directory URLs — see
[Configured roots](#configured-roots).

Both `StoredRequire` and `StoredResource` gain one field:

- `localUrl?` — the `file://` URL actually read, present only when a
  stand-in was used. Its presence *is* "this entry was overridden".
- `url` keeps the **declared** URL either way. It is the dedup key, it
  is what the script says it depends on, and it is what the entry falls
  back to when the local file goes away.

## Per-collection opt-out

`StoredCollection.localFiles` — only an explicit `false` disables it, so rows
persisted before the field existed read as enabled.

- Rendered as a **Local files** checkbox in the collection's header on the
  collections page, next to Refresh / Remove. (Distinct from the viewer's
  **Local overrides** row below — this switches the feature on for a
  collection, that lists what it actually substituted for one script.)
- Shown only where it can do something: http(s) collections and the http /
  github containers are excluded, since every script under them loads
  over the network.
- Toggling it refreshes the collection, because the flag only changes what
  the *next* refresh resolves to.
- Off disables **all** roots for that collection, configured ones included
  — it's the whole mechanism's off-switch, not just the implicit
  folder's.
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
- **Details panel `Local overrides` row** — one entry per overridden file,
  naming the kind (`@require` / `@resource`), the local path we read,
  and a copy button for it. The declaration it replaced is the entry's
  tooltip.
  - Absent when nothing was overridden, so the row's presence is
    itself the disclosure.
  - This is the surface that covers `@resource`, which gets **no code
    tab** in either mode. Before it, a resource stand-in was reported
    only by the Log line below — and in the install preview, which has
    no Log tab, not at all.
  - The stand-in's bytes also land in the `Size` row's
    `(plus N @require files: …)` tail, though nothing there names it.
- **`@icon` has no marker**, including in the `Local overrides` row,
  whose name would otherwise read as exhaustive — it lists `@require`
  and `@resource` only. The favicon slot is a 16×16 image with no room
  for a chip, and an icon served from the wrong place is a cosmetic
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
  empty lists, so there is nothing resolved to annotate: every
  declaration still gets its tab, but none carries a chip, and the
  `Size` row shows no dependency total.

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
human-facing surface — tab tooltips, Log lines, and the `Stands in for
<url>` tooltip on a `Local overrides` entry.

- A 64-hex-digit tail is most of the width of a tooltip or a log line
  and tells the reader nothing they can act on.
- Stripped only when **every** comma-separated part looks like a hash
  declaration, so an ordinary `#section` fragment survives.
- A malformed hash tail survives too — a reader wondering why validation
  didn't happen needs to see what they typed.
- Fetching, resolution, dedup, storage, and **error messages** all keep
  the verbatim ref: an error should name what the author wrote.
- SourceMonkey does not validate these hashes yet; see
  [TODO.md](../TODO.md).
