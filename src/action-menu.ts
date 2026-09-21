// Pure layout planner for the toolbar action's right-click menu.
//
// Chrome auto-collapses an action context menu into a parent submenu
// once it exceeds 6 top-level items, hiding our overflow under a label
// we don't control. We pre-empt that by capping the top level at 6
// ourselves: when the rendered items would exceed the limit we reserve
// one slot for a "More" parent and push the overflowing script groups
// (each script's row + all of its indented `GM_registerMenuCommand`
// rows) into it as a unit. Splitting a group across the two levels
// would orphan commands from their script in the UI.
//
// A fixed "Reload page with no userscripts" row closes the menu
// whenever at least one script row is shown. It counts against the
// same cap, so script groups get one slot fewer when it's present.

export const ACTION_MENU_LIMIT = 6;
export const ACTION_MENU_MORE_LABEL = 'More';
export const ACTION_MENU_RELOAD_LABEL = 'Reload page with no userscripts';

export interface ActionMenuCommand {
  commandId: string;
  // Visible label, already including any indent/glyph prefix.
  title: string;
}

export interface ActionMenuScript {
  scriptId: string;
  // Visible "<name> | <STATUS>" label for the script row itself.
  title: string;
  // True when the row is currently reporting a per-tab injection
  // ERROR (the wrapper sent sm:error this document). The dispatcher
  // uses this to route the click straight to the viewer's Log tab so
  // the user sees the failure reason instead of landing on the code tab
  // and having to switch tabs.
  errored?: boolean;
  commands: ActionMenuCommand[];
}

export interface ActionMenuPlan {
  top: ActionMenuScript[];
  // Empty when nothing overflowed. When non-empty, the renderer
  // creates a single "More" parent at the top level and nests these
  // groups beneath it.
  more: ActionMenuScript[];
  // True when the menu ends with the "Reload page with no userscripts"
  // row — i.e. whenever there is at least one script row. Rendered
  // after everything else, at the top level, never inside More.
  reloadWithoutScripts: boolean;
}

// Cost of a group in menu rows: one for the script + one per command.
function groupCost(g: ActionMenuScript): number {
  return 1 + g.commands.length;
}

// Greedy top-first packing. We keep groups in their incoming order so
// scripts the user sees on screen line up with the menu, and once
// any group spills we send every subsequent group to More — otherwise
// the visible order would scramble (e.g. a small later group jumping
// ahead of a big earlier one).
export function planActionMenu(scripts: ActionMenuScript[]): ActionMenuPlan {
  const reloadWithoutScripts = scripts.length > 0;
  // The reload row is fixed at the top level, so it takes one of the
  // slots before any script group is placed.
  const limit = ACTION_MENU_LIMIT - (reloadWithoutScripts ? 1 : 0);
  let total = 0;
  for (const g of scripts) total += groupCost(g);
  if (total <= limit) {
    return { top: scripts.slice(), more: [], reloadWithoutScripts };
  }
  // Reserve one more top slot for the "More" parent itself.
  const budget = limit - 1;
  const top: ActionMenuScript[] = [];
  const more: ActionMenuScript[] = [];
  let used = 0;
  let overflowing = false;
  for (const g of scripts) {
    const cost = groupCost(g);
    if (!overflowing && used + cost <= budget) {
      top.push(g);
      used += cost;
    } else {
      overflowing = true;
      more.push(g);
    }
  }
  return { top, more, reloadWithoutScripts };
}
