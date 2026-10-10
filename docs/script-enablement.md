# Script enablement

How SourceMonkey keeps one copy of each script active, and which copy
it offers when none is.

- Rules: [`src/extension/script-enablement.ts`](../src/extension/script-enablement.ts)
- Preference order: [`src/extension/copy-preference.ts`](../src/extension/copy-preference.ts)
- Active times: `writeEnablement` in [`src/extension/script-store.ts`](../src/extension/script-store.ts)
- "Copies of one script" means what [script-identity.md](script-identity.md)
  says: the same location, or the same `@namespace` + `@name`.

## Terms

- **Enabled**: one flag, the script's own or its collection's.
- **Ticked**: the copy's own flag is on, whatever its collection's is.
- **Active**: the copy's own flag and its collection's flag are both on,
  so it fires on the pages it matches.
  - Whether it loaded (`ok` or `invalid`) doesn't count here.
- **Running**: actually running in a page. A copy can be active without
  running anywhere: no page it matches is open, it failed to load, or
  the page hasn't reloaded since.

## The invariant

In normal use, at most one copy of a script is active.

- Every action that makes a copy active turns the other active copies
  off.
- **Ctrl/Cmd-click** opts out, on any enable checkbox or the "Enable
  all" button. It changes only what was clicked, so two copies can be
  active together on purpose (say, two `@match`-disjoint edits).
- A copy in a disabled collection is never turned off by this. It
  isn't active, and its flag is the person's intent for when that
  collection comes back.
- Ticking a copy in a disabled collection turns nothing off: it doesn't
  make the copy active.
- An sm-dev run's test collection is left out both ways (see
  [script-identity.md](script-identity.md#enabling-is-exclusive-disabling-is-not)).

### Where it applies

- Script checkboxes: the collections page, the viewer (controls row and
  "Other versions" panel), the toolbar popup.
- Collection toggles: the collections page, the popup's collection
  menu.
- "Enable all" on the collections page.
- Installs, local copies and moves
  ([script-identity.md](script-identity.md#enabling-is-exclusive-disabling-is-not)).
- sm-dev's `script enable`, `collection enable`, `install` and `move`.
- Adding a collection, and a refresh that finds a new file (see
  [New copies](#new-copies)).

### Decided at write time

Which copies to turn off is decided inside the store's write lock, from
their stored state at that moment (`writeEnablementFrom` in
`script-store.ts`).

- Two quick clicks on two copies: the second one's write waits for the
  first, sees that copy on, and turns it off.
- Which copies are related comes from the worker's index of the rows
  (by location and by `@namespace` + `@name`), looked up before the
  lock. Only those copies are re-read inside it.
- The viewer's versions table passes every copy it shows, so a click
  there turns off the copies it showed as turned off.

### A copy that can't run

A copy that becomes active (an install, a local copy, a move, a
collection turned on, "Enable all") may have landed `invalid`. It
still turns the other copies off, working ones included.

- **One rule everywhere.** It is the copy asked for, as with a click on
  its checkbox. Leaving a working copy on beside it would make two
  active copies, and each retry of a failing local copy one more.
- **Nothing runs until it is fixed.** The page shows it as invalid, and
  once a refresh loads it, it runs without another click.

### Turning things off

- **Unchecking a script** turns off only that copy. Nothing is
  promoted in its place.
- **Turning a collection off** brings back what its copies displaced
  (see [Bringing copies back](#bringing-copies-back)).
- **"Disable all"** turns every script in the collection off.

## Active times

Each copy records when it last became active and last went inactive:
`activeSince` and `inactiveSince`.

- Kept in one storage key, `enablementTimes` (script id → times), not
  on the script rows. A collection toggle changes the times of every
  copy in it, and stamping them on the rows would rewrite each full row,
  bodies included.
- Removing a script or a collection drops its entries. The membership
  check on each collections-page render drops any left behind for rows
  that no longer exist.
- Stamped by `writeEnablement`, the one store write behind every enable
  change: it compares active state before and after, and stamps each
  copy that changed. A refresh's new copies are stamped too
  ([New copies](#new-copies)).
- **One time per change.** Everything a change activates or
  deactivates gets the same timestamp. So when A displaces B,
  `B.inactiveSince === A.activeSince`.
  - An install or move is two writes: the row lands, then the sweep.
    The sweep re-stamps the new copy (`started`) so the two times
    still match.
  - Each stamp is later than the previous one in the same context, so
    two writes in one millisecond never share a time.
- Rows written before this existed have neither. That gives no signal,
  and the tiebreakers below decide.

## Turning a collection on

- Each ticked copy in it turns off the other active copies of its
  script in other collections (see
  [A copy that can't run](#a-copy-that-cant-run)).
- Two ticked copies of one script inside the collection both stay
  ticked, as their own boxes say.
  - They can come from a Ctrl/Cmd-click, or from a folder holding two
    files with the same `@name`.

## New copies

Copies a collection's scan finds for the first time. Settled inside the
refresh's write (`settleNewCopies` in script-store.ts), so they never
register first and get turned off after.

- **Adding a collection** counts as turning it on: each new active copy
  turns off the other active copies of its script elsewhere, stamped
  with one time, so turning the new collection off brings them back.
- **A later refresh** that finds a new file: if its script already has
  an active copy (here or elsewhere), the new copy lands unticked and
  the active one stays active. Otherwise it lands ticked, as before.
- Two new copies of one script in the same scan: only the first by
  `@version` (highest), then location, stays ticked.
- The full scan for copies elsewhere runs before the refresh takes its
  lock; inside it, only those rows are re-read.
- Installs and moves of single files have their own sweep
  ([script-identity.md](script-identity.md#enabling-is-exclusive-disabling-is-not)).
- The collection flag and every change land in one write.

## Bringing copies back

When a collection is turned off, each of its active copies A brings
back each copy B that:

- is unticked, in an enabled collection;
- went inactive at the moment A became active
  (`B.inactiveSince === A.activeSince`): A displaced it, and it hasn't
  been active since;
- and no other copy of the script is still active.

Notes:

- This applies whatever activated A: the collection toggle, a
  checkbox, an install. What matters is that A displaced B.
- A copy B that was active again in between has a later
  `inactiveSince`, so it stays off. The person has touched it since.
- Unchecking A on its own doesn't do this. Turning a single copy off is
  an ordinary thing to want.
- A later sweep by A (a re-enable through sm-dev, say) re-stamps
  `A.activeSince`. Copies A displaced before that no longer match, so
  they aren't brought back.

## "Enable all"

The collections page's bulk button. It is only usable while the
collection is on.

- Turns on **one copy per script** in the collection, the first by the
  [in-collection order](#within-one-collection). Other copies of that
  script in the collection go off.
  - That includes a second copy someone Ctrl/Cmd-clicked on.
- Each copy turned on then turns off the script's active copies in
  other collections.
- The button reads "Disable all" (`−`) once every script has a copy
  on, counting copies of one script together.
- Ctrl/Cmd-click turns every script on, with no sweep.

## Preference order

Two orders, in `copy-preference.ts`.

### Within one collection

`compareInCollection`, used by "Enable all":

1. Most recently active: an active copy first (later `activeSince`
   first), then by latest `inactiveSince`. No times = no signal.
2. Highest `@version` (`compareVersions`); a copy without one last.
3. Location (`fileUrl`), lowest first.

### Anywhere

`comparePreferred`, used by the popup:

1. Closest to active:
   - in an enabled collection (only its own box is off);
   - ticked in a disabled collection;
   - unticked in a disabled collection.
2. Most recently active, as above.
3. Collection name, lowest first.
4. The in-collection order.

## The popup's copy

The toolbar popup lists one row per script
([status-popup.md](status-popup.md)). When no copy of a script is
active or running on the page, it shows the first by
`comparePreferred`.

- So the copy someone just turned off is the one they see, and can
  turn back on from the same row.
- Only copies whose rules match the page are considered.
- An `invalid` copy can be the one shown. Its `Invalid` pill says that
  turning it on won't make it run.

## Limitations

- **Removing a copy brings nothing back.** Only turning a collection
  off does.
- **A fresh install that displaced nothing has no `activeSince`**, nor
  does a move into an enabled collection.
- **Moving a copy out of an enabled collection** into a disabled one
  doesn't stamp `inactiveSince`.
- **A copy that appears mid-write is missed.** One installed between
  an enable's lookup of related copies and its lock isn't turned off.
- Every enable runs in the service worker, under the store's one lock
  ([worker-writes.md](worker-writes.md)), so enables from different
  pages no longer race, and the active-time stamps come from one
  context.
- **The collections page's tooltips don't mention Ctrl/Cmd-click.** The
  viewer and the popup do, where other copies match the page.
