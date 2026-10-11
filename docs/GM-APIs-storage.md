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

Every storage-granting script awaits check-pending before its body,
whatever its @run-at (only scripts without storage may skip it, see
[injection.md](injection.md#skipping-the-check-at-document-start)), so
we have a guaranteed synchronous-to-the-body point where we can fetch
state from the SW. That's the only such point; nothing inside the body can pause
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

(When the SW gives no decision at all, no script runs, storage or
not: see [injection.md](injection.md#no-decision).)

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

- The SW's snapshot read threw. Logged on the SW console; rare in
  practice. The decision still stands, so a script told to run
  aborts here instead.
- For MAIN-world scripts: the SW's `bridgeMayActAs` gate refused
  to hand the values over the bridge. See
  [MAIN-world storage](#main-world-storage) below.

In every case the failure mode is a clear console message rather
than a silently-misbehaving script.

## MAIN-world storage

A script runs in the page's own world unless it asks for isolation
(see [injection.md](injection.md#execution-world)), and its storage
grants work there too. Same cache, same batching, same snapshot
contract; only the transport differs, and that has consequences.

- **The snapshot is gated.** MAIN world has no `chrome.runtime`, so
  the `sm:check-pending` request rides `wrapper-bridge.js`, where a
  hostile page could forge it. The SW hands `gmValues` back only for a
  script that actually runs in MAIN world on the sending page and
  granted a storage API — the set whose values that page can already
  read out of the MAIN-world `window.__SM_GM__`. A refusal is a missing snapshot, i.e. the hard
  abort above.
- **The page can read and write the cache.** `window.__SM_GM__` is a
  global in the page's realm. This is inherent to running a granted
  script in the page; it is also why the gate can concede the snapshot
  without conceding anything new. A script whose values the page must
  not see asks for isolation (`@inject-into content`).
- **Teardown flushes survive because the bridge path is synchronous.**
  - Every page→SW request is a DOM `CustomEvent`
    (`sourcemonkey-bridge-sync`, JSON in `detail`), whose listeners all
    run in the dispatching task — so the bridge's
    `chrome.runtime.sendMessage` is as durable as a USER_SCRIPT
    script's own.
  - With the `postMessage` this replaced, the bridge read the request
    on a later task that a document in `pagehide` never gets:
    `GM_setValue(); location.href = …` lost the write every time.
  - The `pagehide` / `visibilitychange → hidden` flush additionally
    skips the reply (`transportSendNow`), since nothing would be left
    to read it.
  - Pinned by `tests/e2e/gm-storage-teardown-main.spec.ts`; deferring
    the flush to a later task fails both of its tests.

Cross-tab broadcasts reach MAIN-world scripts too: the SW stamps each
push with the destination script's world and the bridge re-posts only
the MAIN-addressed ones, so an isolated script's writes never become
page-visible.

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

## Value type fidelity

Both hops to disk — `chrome.runtime.sendMessage`, then
`chrome.storage.local` — serialize JSON-style. Left alone that
rewrites values a userscript is entitled to store, with no error:

| stored | read back without the codec |
| --- | --- |
| `Date` | ISO string |
| `NaN` / `Infinity` | `null` |
| `Map` / `Set` | `{}` |
| `undefined` | key absent |
| `Uint8Array` etc. | `{"0":1,"1":2,…}` |
| `ArrayBuffer` / `DataView` | `{}` |
| `Error` | `{}` |
| `RegExp` | `{}` |
| `-0`, `BigInt` | `0`, throws on write |

### Where the codec lives

- **Page-side**, in `wrapper-gm-runtime.js` (`encodeValue` /
  `decodeValue`). It has to be: the message hop mangles the value
  before the SW ever sees it.
- `storage.set` encodes; `storage.init`, `applyRemoteUpdate` and
  `applyResyncSnapshot` decode.
- The SW and `gm-values.ts` treat the stored form as opaque JSON.

### The format

- A value JSON already round-trips exactly is stored **raw**.
- Anything else is wrapped once: `{ __smv__: 1, v: <node> }`.
- Inside the envelope every node is a `[tag, …payload]` **array**, so
  a tag can never collide with a userscript's object key.

#### Node tags

Every value inside `v` is one of these. An unrecognized tag decodes to
`undefined`, so a row written by a newer build degrades rather than
throwing.

| node | value |
| --- | --- |
| `["p", v]` | string, boolean, finite number, or `null` — carried as-is |
| `["u"]` | `undefined` |
| `["nan"]` / `["inf"]` / `["-inf"]` / `["-0"]` | `NaN`, `±Infinity`, `-0` |
| `["big", "123"]` | `BigInt`, as its decimal string |
| `["d", ms]` | `Date`; `ms` is `"nan"` for an Invalid Date |
| `["re", source, flags]` | `RegExp` |
| `["a", [node, …]]` | array |
| `["o", [[key, node], …]]` | object — entries, so key order survives |
| `["m", [[keyNode, valNode], …]]` | `Map` |
| `["s", [node, …]]` | `Set` |
| `["ab", base64]` | `ArrayBuffer` |
| `["dv", base64]` | `DataView` |
| `["ta", ctorName, base64]` | typed array, e.g. `["ta", "Uint8Array", …]` |
| `["err", name, message, stack, [[key, node], …]]` | `Error`; `stack` may be `null` |

#### Encoding notes

- Binary values carry their bytes as **base64** — JSON has no better
  option, and the ~33% growth beats the ~4x of an array of decimal
  numbers. `String.fromCharCode.apply` is chunked at 32k so a large
  buffer doesn't overflow the argument stack.
- An `["err", …]` node's trailing entries are the own enumerable
  properties the script attached (`err.code = 42`); `message` and
  `stack` are non-enumerable, hence their own slots. The standard
  error constructors are revived as themselves; a subclass name
  survives on a plain `Error`.
- A `["ta", …]` node with a constructor name this build doesn't know
  decodes to the raw `Uint8Array` bytes rather than to nothing.
- **Brand checks can't trust `Object.prototype.toString`** — it
  reports whatever `Symbol.toStringTag` says, so `{[Symbol.toStringTag]:
  'Map'}` claims to be a `Map`. Each tagged branch confirms the brand
  by calling a native accessor that needs the real internal slot
  (`RegExp.prototype.source`'s getter, `%TypedArray%.prototype.length`'s,
  and so on), and a failure falls through to the ordinary object walk
  — which is what such a value always got. `Error`, which has no such
  slot, is discriminated by its prototype.
- **Decoding is `__proto__`-safe.** A stored own `__proto__` key is
  reinstated with `Object.defineProperty`, so it becomes a property
  rather than replacing the decoded object's prototype.
- A row that fails to decode is handed back **as-is** rather than as
  `undefined`, so the script can inspect it — and so `GM_getValue`'s
  default isn't defeated by a key that is present.

### Why that is backwards compatible

- Old rows are plain values, and `decodeValue` returns anything
  without the `__smv__` marker untouched.
- New writes of plain values are byte-identical to what older builds
  wrote, so a downgrade still reads them.
- The one ambiguity — a raw value that itself contains a `__smv__`
  key — is closed by treating such a value as not-plain, so it goes
  through the wrapped path.

### Deliberate limits

- **Class instances** keep their own enumerable properties but lose
  their prototype. Nothing else is possible — the class isn't
  reachable from the codec at decode time. Structured clone has the
  same limit. Tagged types *nested inside* an instance still revive.
- **`Blob` / `File`** would need an async read, and `GM_setValue` is
  synchronous.
- **Object identity is not preserved.** Two references to one object
  decode as two objects; two typed arrays over one `ArrayBuffer`
  decode over two buffers. A `DataView`'s `byteOffset` is dropped —
  it decodes over a fresh, exactly-sized buffer.
- **Circular references throw**, at the `GM_setValue` call site.
  That is the case where copying-twice actually breaks the value
  rather than just duplicating it. They were previously lost
  silently in the async flush.
- **`toJSON` is still honoured** for anything without a tag, in the
  same position `JSON.stringify` would call it.
- **Encoding happens at `set` time**, so an unstorable value throws
  at the `GM_setValue` call site instead of vanishing in the async
  flush. It does *not* make mutating a stored object safe: a
  JSON-clean value encodes to itself, so the pending write still
  holds the live object. Mutating what you stored was already
  unsupported.

### Compared with Violentmonkey

Checked **2026-08-29** against Violentmonkey `master` @ `a3ed56b`
(nearest release v2.48.0) — specifically `dumpScriptValue` in
`src/common/util.js` @ `1b925f6` and `decodeValue` in
`src/injected/web/gm-values.js` @ `8667f7d`. VM may have moved since;
re-read those two functions before trusting the table.

VM's codec is a one-character tag — `s`, `n`, `b` — plus the raw
string for top-level primitives, and `o` + `JSON.stringify` for
everything else. Past that primitive/object split it round-trips
exactly what JSON does, by design — VM's API docs require the value to
be "JSON serializable".

Ours is a superset:

| | VM | SourceMonkey |
| --- | --- | --- |
| string / number / boolean / `null` / plain arrays & objects | yes | yes |
| top-level `NaN`, `±Infinity` | yes | yes |
| **nested** `NaN`, `±Infinity` | no — `null` | yes |
| `Date` | no — ISO string | yes |
| `RegExp` | no — `{}` | yes |
| `Map` / `Set` | no — `{}` | yes |
| `undefined` | no — not stored | yes |
| `-0` | no — `0` | yes |
| `BigInt` | no — throws | yes |
| typed arrays / `ArrayBuffer` / `DataView` | no — `{}` or `{"0":…}` | yes |
| `Error` | no — `{}` | yes |
| class instance prototype | no | no |
| `Blob` / `File` | no | no |
| object identity / cycles | no | no — cycles throw |

Two notes on the corners:

- VM *does* round-trip a **top-level** `NaN` / `Infinity`, because
  primitives are interpolated into a string rather than JSON-encoded:
  `"nNaN"` decodes via `+"NaN"`. Nested in an object it hits
  `JSON.stringify` and becomes `null`. We handle both positions.
- The stored formats are unrelated — VM writes a tagged string, we
  write a raw JSON value or a `{ __smv__: 1, … }` envelope — so
  neither manager can read the other's rows. That has always been
  true and isn't something we support.

## Cross-script isolation

Each script's `(scriptId, key)` namespace is independent —
`GM_listValues` from script A never returns script B's keys.
