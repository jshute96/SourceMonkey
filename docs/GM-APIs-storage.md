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
  iterates the in-memory openers table (`scriptId → Set<tabId>`)
  and broadcasts a `sm:gm-value-update` to every OTHER tab
  running the script.
- Each receiving runtime patches its cache and fires any
  `GM_addValueChangeListener` callbacks with `remote=true`.
- The originating tab is excluded — it already applied the write
  locally and would double-fire its listeners.

The broadcast only reaches realms that are still alive. As soon
as the tab navigates, its in-memory cache is gone — the next
document round-trips to the SW for a fresh seed, same as any
other new document.

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
does a `chrome.storage.local.get(null)` scan, filters to this
script's `gmval:*` rows, merges the overlay, and JSON-serializes
the result onto the reply.

What softens it:

- Scripts that don't `@grant` storage skip the snapshot read
  entirely via `needsValues: false`.
- The per-script row set is small in practice — most userscripts
  store a config object plus a few flags, so the JSON payload
  is small.
- The full-namespace `get(null)` is the most expensive piece. A
  prefix-scoped read (or a cached in-SW snapshot keyed by
  `scriptId`) would cut it further.

This sits on the document-start critical path and is paid by
every storage-granting script on every navigation. If a profile
shows it dominating page-init latency, a per-script in-memory
cache in the SW (invalidated by gmval writes) would skip the
storage read entirely on cache hit. Tracked in TODO.md.

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
