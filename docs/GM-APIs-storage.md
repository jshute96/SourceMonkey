# GM_* storage APIs

`GM_setValue` / `GM_getValue` / `GM_deleteValue` / `GM_listValues`
(and their `GM.*` promised aliases). Background and high-level GM_*
docs live in [`GM-APIs.md`](GM-APIs.md); this file covers the storage
subsystem in depth.

## The synchronous-read constraint

`GM_getValue(key, defaultValue)` is **synchronous** in the
TM/VM/Greasemonkey contract. A userscript routinely calls it on
the very first line of its body:

```js
const config = GM_getValue('config', DEFAULTS);
```

That call has to return on the same line — we can't turn it into
an SW round-trip:

- USER_SCRIPT world doesn't have direct access to
  `chrome.storage.*`.
- `chrome.runtime.sendMessage` is async, and JavaScript can't make
  a sync function pause for an async IPC.

Implication:

> By the time the user body starts, the document's in-memory cache
> must already contain the script's stored values.

That's the load-bearing constraint. It says nothing about whether
the wrapper itself can do async work — it just says the *body*
can't.

`GM_setValue` is the other half of the contract: it must also
return synchronously. We satisfy that by writing into the same
in-memory cache and queueing a debounced flush to the SW.

## How the cache gets seeded

Each document is its own realm — when a navigation happens, the
old document's cache dies with it, and the new document boots up
empty. Something in the wrapper has to seed the new realm before
the body runs.

The prelude brackets the main-body wrap function with an awaited
round-trip:

```
prelude initScript
  ├─ install error listeners, run the matcher
  ├─ AWAIT sm:check-pending  (reload fast-path machinery; injection.md)
  ├─ AWAIT waitForRunAt      (gate on @run-at lifecycle event)
  └─ runMain → fn(entry)     ← main-body wrap function fires here
      ├─ __SM_GM__.storage.init(scriptId, snapshot)   ← GM prelude
      └─ user body runs
```

The check-pending await is unconditional — it happens for every
script load regardless of @run-at — so we have a guaranteed
synchronous-to-the-body point where we can fetch state from the
SW. That's the only such point; nothing inside the body can pause
for an async call.

The SW's reply to `sm:check-pending` therefore carries the
snapshot:

- The wrapper sends `needsValues: true` in its payload iff it
  @grants a storage API (resolved at register time).
- The SW reads the script's `gmval:*` rows from
  `chrome.storage.local`, merges in the in-flight write overlay
  (see [Closing the persist race](#closing-the-persist-race-in-flight-overlay)),
  and attaches the merged map as `gmValues` on the reply.
- The prelude reads that off `__smDecision` and calls
  `storage.init(scriptId, gmValues)`.

This is the **single source of truth**. There is no baked literal
in the wrapper source — every fresh document round-trips to the
SW to get its initial cache contents.

### Seeding a hot-swapped body

The [reload fast-path](injection.md#reload-fast-path) can answer
check-pending with `run-new`, which evals the new body instead of
calling the main-body wrap function — so the GM prelude's
`storage.init` never runs. The swap path seeds the cache itself:

- The SW computes "does this body grant storage" from the **new**
  script row and returns it as `seedValues` on the `run-new` reply,
  alongside the same `gmValues` snapshot.
- `runMain` (in `userscript-prelude.js`) calls
  `storage.init(scriptId, gmValues)` before the eval — the decision
  object is in its scope, which is exactly what the eval'd body
  lacks.
- No snapshot, or an init that throws → **no swap**. The prelude
  logs and runs the baked-in body, which keeps its own seeding path
  and its own hard abort.
- Because the flag comes from the new row, a refresh that **adds**
  `@grant GM_getValue` is seeded correctly even though the
  registered wrapper never requested a snapshot. A refresh that
  **removes** it leaves nothing to seed.

## Hard abort when the SW snapshot is missing

If `__smDecision.gmValues` is missing or falsy at prelude time,
the script doesn't run. The prelude:

1. Logs a clear `console.info` so the user can see why nothing
   happened (`console.info`, not `.error` — injected `.error`/`.warn`
   leak into chrome://extensions/?errors; see [logging.md](logging.md)).
2. Sends `sm:error` to the SW so the failure surfaces on the
   per-script log and the badge.
3. `return`s out of the main-body wrap function so the user body
   never executes.

Why hard abort rather than degrading gracefully:

- A read-modify-write userscript that started with empty storage
  would silently overwrite the user's real data with defaults the
  next time it ran `GM_setValue`. That's silent data loss.
- A hard abort surfaces as an obvious error and is recoverable by
  reloading the page. Almost any other failure mode hides the
  bug.
- Trade-off to be aware of: the user's stored data is safe (still
  on disk) but **inaccessible until the next page load** that
  succeeds in talking to the SW. Reload to recover.

When could this trigger:

- The prelude's 2-second safety timeout in `awaitDecision` fires
  because the SW didn't reply in time. MV3 SW wake-up is
  typically well under 50 ms; 2 s leaves plenty of headroom for
  cold-start under load (e.g. Chrome window restore with many
  tabs warming up at once). If 2 s isn't enough, the user's
  recovery is "reload the page."
- `handleCheckPending` threw in the SW. Logged on the SW console;
  rare in practice.
- For MAIN-world scripts: the wrapper-bridge round-trip didn't
  reply (page navigated away mid-handshake, bridge wasn't
  installed yet, etc.).

In every case the failure mode is a clear console error rather
than a silently-misbehaving script.

## Propagating writes to other live documents

A `GM_setValue` in tab A reaches new documents through the same
check-pending mechanism above — when they boot, the SW already
has the new value (either persisted or in the overlay).

For documents that are alive *right now*, we patch their in-page
caches directly via a broadcast:

- The page-side runtime debounces a burst of `GM_setValue` calls
  by 150 ms (1 s hard cap) and ships a single `sm:gm-batch-write`
  to the SW. `pagehide` / `visibilitychange → hidden` force-flush
  so bfcache eviction doesn't drop in-flight writes.
- The SW persists the batch to `chrome.storage.local`, then
  iterates the openers table (`scriptId → Set<tabId>`) and
  broadcasts a `sm:gm-value-update` to every OTHER tab running
  the script.
- Each receiving runtime patches its cache and fires any
  `GM_addValueChangeListener` callbacks with `remote=true`.
- The originating tab is excluded — it already applied the write
  locally and would double-fire its listeners.

The broadcast only reaches realms that are still alive. As soon
as the tab navigates, its in-memory cache is gone — the next
document round-trips to the SW for a fresh seed, same as any
other new document.

### The openers table survives a worker restart

Why an in-memory-only table doesn't work:

- It is filled at document start, from the `sm:start` /
  `sm:swapped` report.
- An MV3 service worker is evicted after ~30 s idle.
- Nothing re-reports for a document that is already running.
- So the table is empty on the next wake, and every broadcast for
  a tab that has been open a while is dropped.

What we do instead:

- Mirror the table into `chrome.storage.session` on every change,
  and restore it on the first read after a worker start.
- Prune rows for tabs that no longer exist while restoring (a tab
  closed while the worker was asleep never fired `onRemoved`).
- Nothing to migrate across a browser restart: session storage
  dies with the Chrome session, which is also when its tabs die.

Why it matters more than a normal dropped message:

- A page-side `GM_getValue` is a pure cache read, so a document
  that misses a broadcast has no way to notice or recover.
- It bit a real userscript handing a file between two tabs
  (issue #19).

### Resync: recovering a document that missed one

Delivery is best-effort, so the runtime also has a way back:

- `sm:gm-resync` asks the worker for the script's whole value map
  (the same snapshot a fresh document gets) and diffs it against
  the cache, firing value-change listeners for what moved.
- The request re-registers the sender as an opener, which also
  repairs the table for a document the worker had lost.
- Bridge-relayed requests are refused, same as the check-pending
  value read — a MAIN-world page can forge the `scriptId`.

A reply is only authoritative for keys that haven't moved since
the request went out. Skipped:

- keys with an unflushed local write (the worker hasn't seen
  them);
- keys changed — by a local write or an arriving broadcast —
  after the request was sent. The runtime stamps each key with a
  per-store change counter and compares against its value at
  send time.

Triggered by:

- `sm:gm-resync-hint`, which the worker sends to every tab after
  it starts — the one moment its delivery state was just rebuilt.
  Rate limited to once a minute across worker restarts.
- The document becoming visible again.

Who answers, and why not everyone:

- Only scripts with a live `GM_addValueChangeListener`, at most
  once every 5 s per store.
- Without listeners, the cache is only observable through the
  script's own reads.
- Answering costs the worker a storage scan.

## Closing the persist race: in-flight overlay

`chrome.storage.local.set` is async. A write-then-navigate flow
can finish the new document's `sm:check-pending` while the prior
document's `sm:gm-batch-write` is still being persisted — a
naive snapshot read would land one write behind.

The overlay closes that gap:

- The SW keeps a per-script in-memory map of writes that have
  been received but not yet confirmed persisted.
- `handleBatchWrite` installs writes into the overlay BEFORE
  awaiting persistence, then evicts only its own entries (by
  reference identity) after `chrome.storage.local.set` resolves.
- A later overwrite has its own install/evict pair, so a fast
  sequence of writes can't race itself out of the overlay.
- `loadSnapshotForCheckPending` reads `chrome.storage.local` and
  overlays the bucket on top — overlay wins on conflict because
  it's strictly newer than the persisted row.

The overlay's eviction-by-identity scheme relies on
`chrome.storage.local.set` being FIFO per area (so two concurrent
batch-writes for the same key land in the store in start-order).
Chrome documents this; if it ever changes, the persisted state
could disagree with the overlay's last-installed value and the
scheme would need revisiting.

## Cost on the document-start critical path

Every storage-granting script's `sm:check-pending` blocks its
body on an SW round-trip that includes a snapshot read. The SW
lists this script's `gmval:*` keys, reads those rows, merges the
overlay, and JSON-serializes the result onto the reply.

What softens it:

- Scripts that don't `@grant` storage skip the snapshot read
  entirely via `needsValues: false`.
- The per-script row set is small in practice — most userscripts
  store a config object plus a few flags, so the JSON payload
  is small.
- **The read is narrow.** `loadAllValues` uses
  `chrome.storage.local.getKeys()` (Chrome 130+) and then reads
  only the matching rows.

### Why the read must stay narrow

It did not start narrow, and the difference is the whole point:

- The old shape was `get(null)`, which returns every row the
  extension owns.
- The read is only half the cost. **Deserializing** the result
  occupies the worker's single thread, so it delayed not just this
  reply but every callback waiting alongside it.
- Measured at **155 ms** on a 266-row profile, spent inside the
  reload fast path's 500 ms window.
- [diagnostics.md](diagnostics.md#storage-scans) has the log line
  that would catch a regression here.

### Still on the critical path

The narrow read is smaller, not free — `getKeys()` alone measured
~40 ms on that profile, paid by every storage-granting script on
every navigation.

A per-script in-memory cache in the SW, invalidated by `gmval:`
writes, would skip the storage read entirely on a hit. Tracked in
TODO.md.

## Backing store and write batching

Implementation details below the freshness layer:

- **Backing store.** SW-side, `chrome.storage.local` with
  `gmval:<scriptId>:<key>` rows per value. Per-key rows so a
  write doesn't churn sibling rows and so we don't bump the
  per-row size ceiling on a large value.
- **Batched writes.** `GM_setValue` / `GM_deleteValue` update the
  page-side cache synchronously and queue a write. The runtime
  debounces 150 ms after each write with a 1 s hard cap, then
  ships a single `sm:gm-batch-write` envelope to the SW.
- **Last-write-wins** semantics inside one batch — same as a
  sequence of `set` / `delete` calls run one after the other.
- **Deletion sentinel.** Page-side `DELETED_SENTINEL` is a
  private reference; on the wire it travels as `{key, deleted:
  true}` so the JSON round-trip preserves intent. The SW
  translates back to its own symbol when calling
  `applyBatchValues`.
- **GM4 promise forms.** `GM.setValue` / `GM.getValue` / etc are
  emitted by the binding emitter as Promise wrappers around the
  legacy `GM_x` calls — same behavior, async return.

## Cross-script isolation

Each script's `(scriptId, key)` namespace is independent —
`GM_listValues` from script A never returns script B's keys.
