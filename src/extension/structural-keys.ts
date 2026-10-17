// The storage key layout of the structural rows (the collection index,
// collection rows, script rows), and the active-times key the worker's
// row cache keeps beside them. Split from script-store.ts, which owns
// those rows, so a page that only watches for changes to them (the
// toolbar popup) doesn't load the store and everything it imports.

export const COLLECTIONS_INDEX_KEY = 'collections';
export const COLLECTION_PREFIX = 'collection:';
export const SCRIPT_PREFIX = 'script:';
export const collectionKey = (id: string) => `${COLLECTION_PREFIX}${id}`;
export const scriptKey = (id: string) => `${SCRIPT_PREFIX}${id}`;

// Every script's active times (`writeEnablement` in script-store.ts). Not
// a structural row, so `isStructuralKey` leaves it out; here so the
// worker's row cache can keep it without importing the store.
export const ENABLEMENT_TIMES_KEY = 'enablementTimes';

// Does a `chrome.storage.local` change touch the structural rows — the
// collection index, a collection, or a script? Pages watching for
// "something I display moved" ask the module that owns the key layout
// instead of re-deriving the prefixes, where a rename here would leave
// them silently watching keys that no longer exist.
export function touchesStructuralRows(keys: Iterable<string>): boolean {
  for (const key of keys) {
    if (isStructuralKey(key)) return true;
  }
  return false;
}

export function isStructuralKey(key: string): boolean {
  return key === COLLECTIONS_INDEX_KEY || key.startsWith(collectionKey('')) || key.startsWith(scriptKey(''));
}
