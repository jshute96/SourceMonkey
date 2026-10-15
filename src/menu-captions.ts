// Which of a script's menu commands show, shared by the worker's
// registry (`gm-menu.ts`) and sm-dev's `menu` listing.
//
// As in TM: a script's commands with one caption show once in a tab,
// however many times it registered that caption (each with its own id)
// and in however many of the tab's frames. Picking the entry runs all of
// them (`menuCommandGroup` in `gm-menu.ts`). Every registration is kept,
// so unregistering one leaves the entry for the rest. The entry shows
// the caption's first registration, so the menu doesn't reorder.
//
// `key` says which commands share an entry: the caller's list may hold
// several scripts' commands, which never merge.
export function visibleCommands<T>(list: readonly T[], key: (command: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((command) => {
    const k = key(command);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
