// Naming and picking a run's tabs, for the commands that take one
// (console-commands.ts, wait.ts): `T2`, its target or DevTools page id,
// the current tab, and what to say when one is stopped on a dialog.

import type { Dialog } from '@playwright/test';

import type { ConsoleContext, ControlledTab } from './console-commands.js';

/** Where the page commands have no tab to act on; also `start --notab`'s start. */
export const NO_TABS = '[sm-dev] No tabs are active. Use newtab to open one.';

// A tab named before a page command's own words: `T2`, or an id as the
// output shows one. A bare hex prefix isn't taken, since it could be a
// selector.
export const TAB_ARG = /^(\[?(targetId|pageId)=\S+|[Tt]\d+)$/i;

export function tabName(tab: ControlledTab): string {
  return `T${tab.n}`;
}

// The tab the page commands act on. One that has closed gives way to
// T1, said once so a command doesn't land somewhere unexpected.
export function currentTab(ctx: ConsoleContext): ControlledTab | undefined {
  const open = ctx.tabs();
  if (ctx.tab && !open.includes(ctx.tab)) {
    // With none left, the command's own reply says so.
    if (open[0]) ctx.out(`[sm-dev] ${tabName(ctx.tab)} has closed, so the page commands now act on ${tabName(open[0])}`);
    ctx.tab = undefined;
  }
  // Remembered, so the tab closing later is noted as above.
  ctx.tab ??= open[0];
  return ctx.tab;
}

// Enough of a target id to be taken for one rather than a slip.
const MIN_TARGET_ID_PREFIX = 6;

/**
 * The tab a typed argument names: `T2`, or its CDP target id (or the
 * start of one, if only one open tab's id starts that way), bare or as
 * the output shows it (`[targetId=...]`), or its DevTools page id as
 * `pageId=4`.
 */
export function pickTab(ctx: ConsoleContext, input: string): ControlledTab | null {
  // Both ids as `tabs` shows them, `[targetId=... pageId=4]`: the target
  // id names the tab.
  const typed = input.replace(/^\[(targetId=[0-9a-f]+)\s+pageId=\d+\]$/i, '$1');
  const page = /^\[?pageId=(\d+)\]?$/i.exec(typed);
  if (page) {
    const tab = ctx.tabs().find((t) => t.pageId === Number(page[1]));
    if (!tab) ctx.out(`[sm-dev] No open tab is DevTools page ${page[1]}. Use tabs to list them.`);
    return tab ?? null;
  }
  // As copied from the output: `targetId=ABC...`, brackets and all.
  const arg = typed.replace(/^\[?targetId=([0-9a-f]+)\]?$/i, '$1');
  if (arg.length >= MIN_TARGET_ID_PREFIX && /^[0-9a-f]+$/i.test(arg)) {
    const upper = arg.toUpperCase();
    const hits = ctx.tabs().filter((t) => t.targetId?.toUpperCase().startsWith(upper));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      ctx.out(`[sm-dev] Several tabs' target ids start with ${arg} (${hits.map(tabName).join(', ')}). Type more of it.`);
      return null;
    }
    // Only a number could still be a tab slip (`2` for `T2`).
    if (!/^\d+$/.test(arg)) {
      ctx.out(`[sm-dev] No open tab's target id starts with ${arg}. Use tabs to list them.`);
      return null;
    }
  }
  const m = /^[Tt](\d+)$/.exec(arg);
  if (!m) {
    // A bare number is the likely slip, and has an obvious fix.
    ctx.out(/^\d+$/.test(arg)
      ? `[sm-dev] ERROR: Tabs are named T1, T2 and so on. Did you mean T${arg}?`
      : `[sm-dev] ERROR: ${arg} is not a tab. Tabs are named T1, T2 and so on; use tabs to list them.`);
    return null;
  }
  const tab = ctx.tabs().find((t) => t.n === Number(m[1]));
  if (!tab) ctx.out(`[sm-dev] There is no open tab T${m[1]}. Use tabs to list them.`);
  return tab ?? null;
}

export function dialogKind(dialog: Dialog): string {
  const type = dialog.type();
  return `${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}`;
}

/**
 * What to say when `waiting` has a dialog open and a command can't go
 * on until it's answered. `accept` and `dismiss` act on the current tab
 * (`current`), so another tab's needs picking first.
 */
export function dialogWaitingMessage(waiting: ControlledTab, current: ControlledTab | undefined): string {
  const kind = dialogKind(waiting.dialogs!.current!);
  return waiting === current
    ? `The page is waiting on ${kind} dialog. Type accept or dismiss first.`
    : `${tabName(waiting)} is waiting on ${kind} dialog. Type tabs ${tabName(waiting)}, then accept or dismiss.`;
}
