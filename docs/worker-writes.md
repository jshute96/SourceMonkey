# The service worker as the only writer

> **Status: in progress.** Stages 1 to 4 are done: every page write
> runs in the worker. See [Stages](#stages).

Today every extension page (the collections page, the viewer, the
Options page, the dialogs they open) writes `chrome.storage.local`
itself, through the same store functions the service worker uses. This
plan moves every write, and every `chrome.userScripts` registration
call, into the service worker. Pages send requests and read storage to
paint.

## Why

- **One lock instead of one per context.** `mutate()` serializes writes
  within a JS context only (see
  [storage.md](storage.md#the-lock-is-per-context)). Races between a
  page and the worker are guarded case by case, or accepted:
  - the blob cleanup waits two checks `SWEEP_GRACE_MS` apart;
  - pages ask the worker whether the format migration is done
    (`storeFormatReady`'s page path);
  - `pruneEnablementTimes` repairs times a removal in another context
    raced back in;
  - the injector expects registrations another context placed
    (`unregisterIds`' fallback, `placeSpec`'s duplicate handling);
  - the races storage.md lists as unguarded: a remove against a
    refresh's write, two installs of one file, lost active-time stamps.
- **One cache that is right by construction.** With every write going
  through it, the worker can keep every script and collection row in
  memory, updated as it writes. Finding related copies on an enable
  click then needs no storage read (today a read of every row, about
  70 ms on a 326-script profile).
- **Long work survives the tab.** Refresh All, adding a collection and
  installing run in the page that started them, and closing it stops
  them part-way.
- **One registration path.** A page's rejected-script retry builds
  specs with its own `mustAskForDecision`, which is always null there,
  so they can differ from the worker's while an sm-dev run is live.

## Rules

- **Only the worker writes `chrome.storage.local`** and calls
  `chrome.userScripts.register` / `update` / `unregister` /
  `configureWorld`.
- **Pages read storage directly** to paint, as now. A read can't
  corrupt anything, and moving reads isn't needed for any of the above.
  Pages keep repainting from `storage.onChanged`.
- **Pages may still do I/O the worker can't**, and send the result:
  the local copy's downloads, which need a blob URL (see
  [Checked](#checked-what-the-worker-can-do)).
- **Session storage** follows the same rule for keys the worker also
  writes: `refresh-errors`, `injector-rejections`, logs. The one-shot
  install bypass key (`markInstallBypass`) can stay a page write; the
  worker only consumes it.

## Checked: what the worker can do

Probed in the worker of the test profile, which has file access on, as
a real profile needs for local collections at all:

- **file:// reads work.** `fetch` of a file returns its text with
  status 200; a missing file rejects (`Failed to fetch`).
- **file:// directory listings work too.** `fetch` of a directory
  returns Chrome's listing page, readable (`type: basic`, status 0).
  - The comment in `directories.ts` saying it "answers opaquely" is
    wrong, and so is the reason it gives for `classifyLocation` being
    page-only. A file answers 200, a directory 0, a missing path
    rejects, so the worker can classify too.
  - So adding and refreshing local collections move whole; nothing
    needs splitting into page reads.
- **Favicons work.** `/_favicon/` answers from the worker (the
  `favicon` permission is in the manifest). The fetch-and-cache code
  uses only `fetch`, `arrayBuffer` and data URLs. `URL.createObjectURL`,
  which the worker lacks, is used only to display icons, in pages.
- **The worker has no** `XMLHttpRequest`, `DOMParser` or
  `URL.createObjectURL`. Only the local copy's downloads need the
  last, so the page keeps doing those.
- **Staying alive**, from Chrome's documentation (not testable here:
  the test harness's debugger connection keeps the worker alive):
  - The worker stops after 30 s with no events or extension API calls;
    each of those resets the timer (Chrome 110+).
  - A single event or API call taking over 5 minutes can stop it, and
    so can a `fetch` whose response takes over 30 s. Our fetches time
    out well before that.
  - Messages on a long-lived port keep it alive (Chrome 114+); opening
    one alone doesn't.
  - So a long operation shouldn't run as one long message handler.
    The page opens a port and sends a heartbeat every 20 s or so; the
    worker starts the work, returns from the handler at once, and
    reports progress and the result on the port. A refresh's own
    storage calls reset the timer as well.

## The message API

- **One port per call** (`worker-client.ts`, `worker-ops.ts`).
  - The page opens a port named `sm:op`, sends the operation's name and
    arguments, and while it waits, a heartbeat every 20 s. Those keep
    the worker alive through a long refresh.
  - The worker answers once: `{ ok: true, result }` or
    `{ ok: false, error }`, the error being the message the operation
    threw, which the page throws again.
  - The worker starts the work and returns from the port's handler at
    once. A page that closes doesn't stop it; the answer is dropped.
  - Only our own pages may connect (`fromExtensionPage`), as for every
    page relay.
- **The client exports the worker functions' own names**
  (`setScriptEnabledExclusive`, `removeScript`, …), so a call site
  changes only its import.
- **Arguments and results cross as JSON.** The worker's table
  (`WORKER_OPS`) adapts a function whose signature has a timer, a Map,
  or script bodies the page doesn't need.
- No progress events: no page shows a refresh's progress. A page reads
  storage for the outcome, as before.

## The row cache

`row-cache.ts`: the worker's in-memory copy of the collection index,
the collection rows and the script rows (without bodies).

- **Loaded** by the first read of every script row
  (`getAllScriptMetas`, the membership repair), which would scan
  storage anyway. Until then, point reads go to storage, so a worker
  that wakes for one row doesn't read them all.
- **Read** by the store's row reads (`getRows`) for those keys. Other
  keys in the same read (`enablementTimes`) still come from storage.
- **Kept current** by wrapping this context's `chrome.storage.local`
  `set`, `remove` and `clear`: whatever writes, the cache changes as
  storage does.
  - Each write to a cached key gets a number. It lands in the cache at
    its change event or when the call returns, whichever is first, so
    the worker's other change listeners already read it.
  - An older write never replaces a newer one.
  - A load waits until no write to a cached key is in flight, so every
    write numbered before it is in what it reads.
- **Safety net**: a change event for a row this context didn't write
  drops the copy, and the next full read loads it again.
  - A write's own event is recognized by its value, compared without
    key order (Chrome sorts an object's keys).
  - A write that changes nothing gets no event, so what is waiting for
    one expires after 30 s.
  - A load that overlapped another context's write tries again.
- **Copies out**: each read returns copies, so a caller that changes a
  row can't change the cache.

## What moves

| Area | Page entry points | How |
|---|---|---|
| Enable toggles | collections checkboxes and bulk toggle; viewer Enabled box and versions panel; `turnOffOtherCopies` after install, move, copy | Request. The worker finds related copies from its cache |
| Remove | collections trash cans, remove collection; viewer versions panel; delete local copy | Request |
| Move | viewer Move dialog; collection up/down | Request |
| Collection options | collection dialog (name, local files) | Request |
| Connect grants | viewer revoke / forget | Request |
| Settings | Options booleans, local roots, GitHub token, downloads folder | Request; low risk, moved for one rule |
| Refresh | collections Refresh, Refresh All, subsets, `?refresh_file`; viewer Refresh and versions update; Options local-roots Save | Port. Includes version probes and the rejection retry |
| Add / install | collections Add field, first-run seeding, `?add=`, collection dialog; viewer preview Install | Port. Still without the rejection retry and probes, which the direct `refreshCollection` path skips (see [Open](#open)) |
| Local copy | viewer Make a copy | Page does the downloads (blob URLs), then `registerLocalCopy`: create or find the collection, refresh, enable |
| Repairs on load | collections `render`: display-name backfill, membership repair | Request: the backfill only when a row lacks a name, the repair without waiting |
| Legacy key migration | first store read in any context | A page that finds the old index asks the worker, and waits |
| Site icon cache | icon rendering on collections, viewer, compare; debug icons page | Request to fetch-and-cache (`refreshCachedIcon`); pages read cached rows themselves |

The preview's parse check of a file not yet installed stays in the
page: it writes nothing.

## Costs

- **Parse checks move to the offscreen document** for refreshes the
  worker now runs. Pages compile in their own sandbox today, which
  docs/parse-check.md credits with no worker wake, no copy of big
  scripts across contexts, and parallel compiles.
- **A message per write**, and a port per long operation. Small next to
  the reads they replace.
- **Every page write call site changes**, though mostly to an import
  from the client module.

## What gets simpler

Once no page writes:

- The cleanup deletes an unused blob on one check, inside the lock; the
  grace period and `MISSING_BLOB_MESSAGE`'s race go.
- `storeFormatReady`'s page path and `sm:storeFormatReady` go.
- `pruneEnablementTimes`' cross-context repair, and the "install in
  another context" caveat in `writeEnablementFrom`.
- The injector's "another context placed it" handling, and the page
  retry's `mustAsk` divergence.
- The log write's local fallback.
- Per-context dedupe maps (parse checks in flight, folder listings,
  icon fetches) become one.
- The worker's row cache can replace the tables it rebuilds from change
  events (match index, log labels), as one source.

Not affected: re-reading inside the lock and merging concurrent edits
(`preserveConcurrentEdits`), since fetches still run outside the lock;
and the collections page's `writtenSinceRead`, since a write through the
worker is still asynchronous to the page's repaint.

## Stages

1. **Done.** Client module and port, then enable toggles: the hot
   path, and the worker cache for related copies.
2. **Done.** Small writes: remove, move, collection options, grants,
   settings, repairs on load, the legacy key migration.
   - Settings go through one `writeSetting` operation, which accepts
     only the keys Options and the local copy set.
   - The collections page asks for the membership repair without
     waiting; the display-name backfill only when a row lacks a name.
   - A page that finds rows in the pre-rename spelling asks the worker
     to move them, and waits.
3. **Done.** Long operations: refresh, add, install, and creating a
   location collection from the dialog (which adds and refreshes it).
   - The collections page's highlights still come from its own reads
     before and after: no result needs sending.
   - The viewer's Refresh is told whether the row is still there, and
     reads it itself.
   - Pages no longer install a parse checker for the store; the install
     preview keeps its own.
4. **Done.** Local copy and site icons.
5. **Enforce it**: `writeLocal`, `removeLocal` and the injector's
   placement calls throw outside the worker, and a unit test checks
   that no page bundle reaches them. Then remove what
   [What gets simpler](#what-gets-simpler) lists, and update
   storage.md, injection.md and architecture.md.

Each stage leaves both kinds of writer working, so it can ship alone.

## Open

- **Add and install skip the probes and the rejection retry** a
  Refresh runs (`script-updater.ts`), as before the move. Running them
  in the worker after an add is now easy; not done here.
- **The registration sync, sticky numbers and the match index** read
  storage themselves. They could read the row cache too.
