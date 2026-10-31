# The service worker as the only writer

> **Status: done.** Every page write runs in the worker, and a page
> that tries to write throws. See [Stages](#stages) and [Open](#open).

Extension pages (the collections page, the viewer, the Options page,
the dialogs they open) used to write `chrome.storage.local` themselves,
through the same store functions the service worker uses. Now every
write, and every `chrome.userScripts` registration call, runs in the
service worker. Pages send requests and read storage to paint.

## Why

What a page writing for itself cost, and what moving the writes bought:

- **One lock instead of one per context.** `mutate()` serializes writes
  within a JS context only (see
  [storage.md](storage.md#one-lock-in-the-worker)). Races between a
  page and the worker were guarded case by case, or accepted: a remove
  against a refresh's write, two installs of one file, lost
  active-time stamps.
- **One cache that is right by construction.** With every write going
  through it, the worker keeps every script and collection row in
  memory, updated as it writes. Finding related copies on an enable
  click needs no storage read (it was a read of every row, about 70 ms
  on a 326-script profile).
- **Long work survives the tab.** Refresh All, adding a collection and
  installing ran in the page that started them, and closing it stopped
  them part-way.
- **One registration path.** A page's rejected-script retry built
  specs of its own, which could differ from the worker's.

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
- **A few reads go through it too**, where the worker holds state
  storage doesn't have yet: `readScriptValues` gives scripts' GM values
  from the value store, including writes not yet saved.
- **The client exports the worker functions' own names**
  (`setScriptEnabledExclusive`, `removeScript`, …), so a call site
  changes only its import.
- **Arguments and results cross as JSON.** The worker's table
  (`WORKER_OPS`) adapts a function whose signature has a timer, a Map,
  or script bodies the page doesn't need.
  - An import is the one call that sends bodies the other way: the
    page reads the backup file and hands `importScripts` each script's
    text, values and dependency files ([import.md](import.md)).
- No progress events: no page shows a refresh's progress. A page reads
  storage for the outcome, as before.

## The row cache

`row-cache.ts`: the worker's in-memory copy of the collection index,
the collection rows, the script rows (without bodies), and the active
times (`enablementTimes`), which every enable re-reads inside its lock.
It's the one copy of those rows in the worker; the match index and the
log labels keep tables derived from them.

- **Loaded** by the first read that wants every row. At a worker start
  that is the match index, the log labels, sticky numbers or the
  registration sync, which load it with one scan between them instead
  of a scan each. Until then, point reads go to storage.
  - A load that a write overlaps tries again, up to three times, then
    gives up: the caller reads storage itself, and the next read tries
    to load again.
  - So under constant writes (a Refresh All) each full read may cost a
    scan until the writes pause.
- **Read** by:
  - the store's row reads (`getRows`) for those keys; other keys in the
    same read still come from storage;
  - the registration sync, the match index, the log label table and
    sticky numbers (`sharedRows`), which used to scan storage
    themselves. They get the cached rows themselves, frozen, not
    copies: they only read, and a change would throw.
- **Indexes**, updated with the rows, so an enable reads only the rows
  it needs, not every row:
  - script ids by canonical location and by `@namespace` + `@name`:
    finding a copy's related copies (`relatedCopyIds`) is a lookup;
  - script ids by collection (`scriptIdsInCollection`), for collection
    toggles and Enable all.
- **Derived tables stay separate**: the match index and the log labels
  keep their own tables, updated from change events as before.
- **Kept current** by wrapping this context's `chrome.storage.local`
  `set`, `remove` and `clear`: whatever writes, the cache changes as
  storage does.
  - Each write to a cached key gets a number. It lands in the cache at
    its change event or when the call returns, whichever is first, so
    the worker's change listeners installed after it already read it.
  - An older write never replaces a newer one.
  - A load waits until no write to a cached key is in flight, so every
    write numbered before it is in what it reads.
- **Safety net**: a change event for a row this context didn't write
  drops the copy, and the next full read loads it again.
  - A write's own event is recognized by its value, compared without
    key order (Chrome sorts an object's keys).
  - A write that changes nothing gets no event, so what is waiting for
    one expires after 30 s.
  - A load that overlapped a write tries again (see **Loaded**).
- **Copies out**: the store's reads return copies, so a caller that
  changes a row can't change the cache; `sharedRows` returns the frozen
  rows.

## The value store

`value-store.ts` plays the same part for `GM_setValue` values
(`gmval:` rows): the one copy in the worker, which every read and
write of them goes through. Unlike the row cache, nothing else in
production writes those rows, so it needs no change-event safety net
(tests that do make it forget its maps). Details:
[GM-APIs-storage.md](GM-APIs-storage.md#the-workers-value-store).

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
| Add / install | collections Add field, the suggestion box, `?add=`, collection dialog; viewer preview Install | Port. Without the rejection retry; a single-script install probes, a whole-collection add doesn't (see [Open](#open)) |
| Local copy | viewer Make a copy | Page does the downloads (blob URLs), then `registerLocalCopy`: create or find the collection, refresh, enable |
| Repairs on load | collections `render`: display-name backfill, membership repair | Request: the backfill only when a row lacks a name, the repair without waiting |
| Legacy key migration | first store read in any context | A page that finds the old index asks the worker, and waits |
| Site icon cache | icon rendering on collections, viewer, compare; debug icons page | Request to fetch-and-cache (`ensureCachedIcon`; the debug icons page's `refreshCachedIcon` always fetches); pages read cached rows themselves |

The preview's parse check of a file not yet installed stays in the
page: it writes nothing.

## Costs

- **Parse checks move to the offscreen document** for refreshes the
  worker now runs. Pages used to compile in their own sandbox, which
  docs/parse-check.md credited with no worker wake, no copy of big
  scripts across contexts, and parallel compiles.
- **A message per write**, and a port per long operation. Small next to
  the reads they replace.
- **Every page write call site changes**, though mostly to an import
  from the client module.

## What got simpler

Now that no page writes:

- **Gone**:
  - `storeFormatReady`'s page path and the `sm:storeFormatReady`
    message.
  - The log write's local fallback: a page's entry the worker didn't
    take is dropped, with a console line.
  - The pages' parse checker for the store, and their own copies of the
    in-flight maps (folder listings, icon fetches) for writes.
  - The blob cleanup's two checks 2 minutes apart: a blob goes on the
    first check that finds it unused, run as soon as a change leaves
    one. Every script-row write takes the lock the check runs in, which
    the worker's wrapped write checks (`checkScriptRowWrite`).
- **Kept, with the reason updated**:
  - The injector's handling of a registration it didn't expect: the
    worker's record of what Chrome holds can still be wrong (a reset,
    a stopped worker).
  - `pruneEnablementTimes`, as a repair for times left from before.
- **One copy of the rows**: the registration sync, the match index,
  the log labels and sticky numbers read the row cache instead of
  scanning storage, and related copies come from its indexes. The match
  index and log labels still keep their own derived tables, updated
  from change events.

Not affected: re-reading inside the lock and merging concurrent edits
(`preserveConcurrentEdits`), since fetches still run outside the lock;
and the collections page's `writtenSinceRead`, since a write through the
worker is still asynchronous to the page's repaint.

## Enforcement

- `assertWorkerContext` (`run-context.ts`) throws in a page. The
  store's write funnels (`writeLocal`, `setLocal`, `removeLocal`), the
  injector's registration lock, and the session writers
  (`refresh-errors`, `injector-rejections`) call it.
- `callWorker` refuses to run in the worker, where a port would reach
  no listener: code there calls the store directly.
- The worker's wrapped `set` refuses a script row written outside the
  store's lock (`checkScriptRowWrite`), which the blob cleanup relies
  on. Tests that seed rows use `seedStorage` on the test surface.
- `tests/unit/page-writes.test.mjs` checks that no page-only module
  imports a writer from where it is defined, or writes storage itself.

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
5. **Done.** Enforce it ([Enforcement](#enforcement)), then remove
   what [What got simpler](#what-got-simpler) lists, and update
   storage.md, injection.md, script-log.md and architecture.md.

## Open

- **Add and install skip the rejection retry** a Refresh runs. A
  single-script install does run the version check, without waiting
  (`probeInstalledScript`); a whole-collection add leaves it to its
  first Refresh.
