// Which installed copy of a script is preferred, when only one of them
// should run or be shown: the order behind "Enable all" picking one
// copy per script in a collection, and the toolbar popup picking the
// copy that stands for a script none of whose copies is active.
//
// Pure, so popup-view.ts can use it in the service worker and the
// rules can be unit tested. Design: docs/script-enablement.md.

import { compareScriptNames } from '../script-display.js';
import { compareVersions } from '../version-compare.js';

// What the order reads about one copy.
export interface CopyFacts {
  // The copy's own flag, not its collection's.
  enabled: boolean;
  collectionOn: boolean;
  // The collection's shown name.
  collectionName: string;
  // The copy's active times (`enablementTimes` in script-store.ts).
  activeSince?: number;
  inactiveSince?: number;
  version: string | null;
  // The copy's absolute location (`StoredScript.fileUrl`).
  location: string;
}

function isActive(c: CopyFacts): boolean {
  return c.enabled && c.collectionOn;
}

// Most recently active first: an active copy before any inactive one
// (the later `activeSince` first between two active), then by when it
// went inactive. A copy with no recorded times gives no signal and
// comes last.
function compareRecency(a: CopyFacts, b: CopyFacts): number {
  const ra = isActive(a);
  const rb = isActive(b);
  if (ra !== rb) return ra ? -1 : 1;
  const ta = (ra ? a.activeSince : a.inactiveSince) ?? 0;
  const tb = (rb ? b.activeSince : b.inactiveSince) ?? 0;
  return tb - ta;
}

// The order between copies in one collection: most recently active, then
// the highest `@version` (a copy without one last), then location.
export function compareInCollection(a: CopyFacts, b: CopyFacts): number {
  const recency = compareRecency(a, b);
  if (recency !== 0) return recency;
  if (a.version !== b.version) {
    if (a.version === null) return 1;
    if (b.version === null) return -1;
    const v = compareVersions(b.version, a.version);
    if (v !== 0) return v;
  }
  return a.location < b.location ? -1 : a.location > b.location ? 1 : 0;
}

// How close a copy is to active: in an enabled collection (so only its
// own box is off), ticked in a disabled collection, unticked in one.
function closeness(c: CopyFacts): number {
  if (c.collectionOn) return 0;
  return c.enabled ? 1 : 2;
}

// The order between copies anywhere: closest to active, then most
// recently active, then collection name, then `compareInCollection`.
export function comparePreferred(a: CopyFacts, b: CopyFacts): number {
  return closeness(a) - closeness(b)
    || compareRecency(a, b)
    || compareScriptNames(a.collectionName, b.collectionName)
    || compareInCollection(a, b);
}

// The first of `copies` by `compare`, or undefined when there are none.
export function preferredCopy<T>(
  copies: readonly T[],
  facts: (copy: T) => CopyFacts,
  compare: (a: CopyFacts, b: CopyFacts) => number = comparePreferred,
): T | undefined {
  let best: T | undefined;
  for (const copy of copies) {
    if (best === undefined || compare(facts(copy), facts(best)) < 0) best = copy;
  }
  return best;
}
