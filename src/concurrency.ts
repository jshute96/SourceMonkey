// Bounded-concurrency fan-out.
//
// Every fan-out over a collection's scripts runs through here, because
// the unbounded form is a crash rather than a slowdown. One promise per
// scanned file means one simultaneous fetch per script, each holding a
// decoded body plus any prefetched `@require` / `@resource` payloads;
// across a few thousand scripts that peak is enough to take the whole
// extension process down with an out-of-memory abort. Chrome surfaces
// that only as "this extension crashed", with no JavaScript error
// anywhere, so it is not a failure the logs will ever explain.
//
// Bounds the in-flight working set, not the total: callers still retain
// every result, so a large enough collection is still a large enough
// peak.

// ---------- Refresh limits ----------
//
// These nest, so read them as a product. Refreshing one collection uses
// only the inner limit; "Refresh All" runs the outer limit's worth of
// collections, each with its own inner set:
//
//   worst-case fetches in flight
//     = FETCH_COLLECTIONS_CONCURRENCY × FETCH_SCRIPTS_PER_COLLECTION_CONCURRENCY
//
// The balance leans on the inner one because that's the limit the
// common cases actually hit: most profiles have one or a few
// collections, and a per-collection Refresh button never engages the
// outer limit at all. Making the outer limit the larger of the two
// would only speed up a profile with many collections while capping the
// single-collection case that everyone hits.

// How many scripts a single collection's refresh fetches at once.
//
// Chosen for memory, not throughput: each in-flight entry can hold a
// script body plus its dependency payloads, so the cap is what keeps
// peak usage proportional to the limit instead of to the collection
// size. Large enough to keep the network and the file reader busy. (For
// an HTTP/1.1 host the browser's own ~6-per-host connection limit is a
// second backstop in the same range, but that is not something to lean
// on: an HTTP/2 host multiplexes and imposes no such bound, and file://
// reads have no per-host limit at all.)
export const FETCH_SCRIPTS_PER_COLLECTION_CONCURRENCY = 16;

// How many collections a "Refresh All" pass works on at once.
//
// Deliberately the smaller of the pair — see the note above. It exists
// to stop the product from exploding on a many-collection profile, not
// to make that profile fast.
export const FETCH_COLLECTIONS_CONCURRENCY = 2;

// ---------- Directory-scan limits ----------
//
// A scan lists a directory, then lists each subdirectory it found. Those
// siblings are independent, but walking them with an `await` in the loop
// made the whole scan one round trip per directory — measured at 195ms
// for a local tree of 78 directories, and 1151ms for a GitHub repo whose
// listing needs four API calls. The depth cap means these nest at most
// twice, so read each as a product with itself.

// Sibling `file://` directories listed at once.
//
// The larger of the pair: a local listing is a cheap read with no
// per-host connection limit to respect, and deep trees are the common
// shape (a userscripts folder organised by site).
export const SCAN_DIRS_CONCURRENCY = 12;

// Sibling GitHub directories listed at once.
//
// Deliberately small, and NOT for memory: every listing is a request
// against api.github.com, which applies a secondary limit to bursts of
// concurrent requests from one client on top of the hourly quota. Being
// throttled costs far more than the serialization this saves, and the
// win here is mostly the first fan-out anyway — a repo needing four
// calls goes from four round trips to two.
export const SCAN_GITHUB_DIRS_CONCURRENCY = 4;

// ---------- Update-probe limits ----------
//
// Their own pair rather than a reuse of the refresh limits above: the
// scripts handed to one probe pass can span every collection, so neither
// refresh limit describes the shape. Same nesting rule, though — read
// them as a product.

// How many scripts are probed for updates at once.
//
// This is the one that binds — a script yields at most two probe URLs,
// so the inner limit never does.
//
// It was 3, on the reasoning that a probe is an annotation nothing
// waits on. That is true of the per-script caller, which fires and
// forgets on the navigation path, and false of the collection ones: a
// Refresh / Refresh All awaits the probe pass so the row is current
// when the spinner stops. The limit sized for the caller that doesn't
// wait was being paid by the two that do — measured at 1772ms for 30
// probed scripts, ten serialized rounds of a couple-KB header fetch.
//
// So it is sized for the awaiting caller now. Still bounded, because
// the pass can span every collection at once and the nesting rule below
// still applies; a probe is also cheap in the way that matters here —
// it holds one small response, not a script body plus its dependency
// payloads, which is what forces the refresh limits to stay low.
export const PROBE_SCRIPTS_CONCURRENCY = 10;

// How many of ONE script's probe URLs are fetched at once.
//
// A guard rather than a working limit: `probeTargets` yields at most two
// entries per script (`@updateURL` and `@downloadURL`, deduped by URL),
// so the list never reaches this cap. It is here so that adding a third
// probe target kind can't quietly turn the per-script step into an
// unbounded fan-out — the failure this whole module exists to prevent.
export const PROBE_URLS_PER_SCRIPT_CONCURRENCY = 4;

// Run `fn` over `items` with at most `limit` calls outstanding.
//
// Results come back in `items` order regardless of completion order, so
// this is a drop-in replacement for `Promise.all(items.map(fn))`.
//
// Rejection behavior also matches `Promise.all`, in both halves — and
// the second half is the subtle one:
//
//   - The first rejection rejects the whole call immediately. The caller
//     does not wait out the rest of the list to hear about a failure.
//   - Every item still RUNS. No work is cancelled (there is nothing to
//     cancel it with); the pool keeps draining in the background after
//     the caller has been rejected, and those results are discarded.
//
// The second half is why a worker swallows its item's rejection instead
// of letting it break the loop. A throwing `fn` that killed its worker
// would be fine for a one-off failure — the other workers drain the
// list — but a SYSTEMIC failure (every item throws) would kill every
// worker in turn and silently skip the tail of the list. That is the
// case that matters here: an out-of-quota `chrome.storage.local` write
// fails for every collection, not just one.
//
// Callers that need per-item failures to be survivable should return a
// failure value rather than throwing, which is what the fetch paths do.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  // A limit at or above the item count has no work to do beyond
  // Promise.all, and a non-positive limit would deadlock the workers
  // below — treat both as "no bound".
  if (limit >= items.length || limit <= 0) {
    return await Promise.all(items.map((item, i) => fn(item, i)));
  }

  const out = new Array<R>(items.length);
  // Rejects the caller the moment the first item fails, while the pool
  // below carries on draining. Never resolves — on the success path the
  // drain is what settles the race.
  let failNow!: (err: unknown) => void;
  const firstFailure = new Promise<never>((_, reject) => { failNow = reject; });
  let failed = false;

  // Shared cursor: each worker repeatedly claims the next unstarted
  // index. Self-balancing — a worker that draws a slow item doesn't hold
  // up items a free worker could be running, which a fixed chunked split
  // would.
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i]!, i);
      } catch (err) {
        // Reported, not rethrown: a worker that died here would stop
        // claiming items, and if every item fails that skips the tail of
        // the list entirely. See the note on rejection above.
        if (!failed) {
          failed = true;
          failNow(err);
        }
      }
    }
  };

  const drained = Promise.all(Array.from({ length: limit }, () => worker()));
  // Workers never reject, so `drained` can only resolve — the race
  // settles on `firstFailure` for a failure and on `drained` otherwise,
  // and neither branch leaves an unhandled rejection behind.
  await Promise.race([drained, firstFailure]);
  return out;
}
