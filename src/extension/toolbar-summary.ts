// Pure: the toolbar icon's badge (count and color) and its hover
// tooltip, summed up from the popup's view of the tab, so the icon and
// the popup can't disagree about a script's status. Painted by
// `renderBadge` in background.ts. Design: docs/matching.md#tooltip.

import {
  POPUP_NO_SCRIPTS,
  POPUP_NOT_INJECTABLE,
  type PopupRow,
  type PopupView,
} from './popup-view.js';
import {
  BADGE_GREEN,
  BADGE_GREY,
  BADGE_ORANGE,
  BADGE_PURPLE,
  BADGE_RED,
  SM_DEV_CONTROL_LABEL,
  countsOnBadge,
  type TabMatchState,
} from './tab-status.js';

export const TOOLBAR_CLICK_HINT = 'Click for details. Double-click for collections.';

export interface ToolbarSummary {
  // The badge's number. Can be 0 with a badge: an sm-dev run kept
  // every script out.
  count: number;
  // The badge's color, or null with no badge.
  color: string | null;
  // The tooltip: name, sm-dev note, status lines, click hint.
  title: string;
}

const noun = (n: number) => (n === 1 ? 'script' : 'scripts');
const scripts = (n: number) => `${n} ${noun(n)}`;
const has = (n: number) => (n === 1 ? 'has' : 'have');
const is = (n: number) => (n === 1 ? 'is' : 'are');

export function summarizeToolbar(view: PopupView, state: TabMatchState | null): ToolbarSummary {
  // An invalid script that isn't enabled is listed for reference only:
  // it wasn't going to run, so it's not this page's problem.
  const rows: PopupRow[] = [...view.enabled, ...view.manual, ...view.disabled]
    .flatMap((g) => g.rows)
    .filter((r) => r.status !== 'INVALID' || r.active);
  const count = (pred: (r: PopupRow) => boolean) => rows.filter(pred).length;
  const withStatus = (...statuses: string[]) => count((r) => r.status !== null && statuses.includes(r.status));

  const running = count((r) => state?.actual[r.id] != null);
  const errors = withStatus('ERROR');
  const rejected = withStatus('REJECTED');
  const invalid = withStatus('INVALID');
  // What a reload would change, each its own line: updated on disk,
  // enabled since the page loaded (or matching only the URL it moved
  // to), disabled or removed since but still running, or not known
  // because the page loaded before the extension started.
  const updated = withStatus('RELOAD');
  const added = withStatus('PENDING');
  const removed = withStatus('STILL_RUNNING');
  const untracked = withStatus('UNTRACKED');
  const missing = withStatus('MISSING');
  const unexpected = withStatus('UNEXPECTED');
  const warned = count((r) => r.warned);
  const skipped = withStatus('NOT_LOADED');
  // Manual scripts not run here yet are the normal state, and can be
  // many (an all-pages bookmarklet), so they get no line and no badge;
  // one counts once it has run. They still keep "No scripts match"
  // away, which would be untrue.
  const anyStatus = rows.some((r) => r.status !== null);
  const anyBadged = rows.some((r) => r.status !== null && r.status !== 'NOT_RUN');

  const lines: string[] = [];
  if (!view.injectable) lines.push(POPUP_NOT_INJECTABLE);
  else if (!anyStatus) lines.push(POPUP_NO_SCRIPTS);
  else {
    if (running > 0) lines.push(`${scripts(running)} running.`);
    if (errors > 0) lines.push(`${scripts(errors)} ${has(errors)} errors.`);
    if (rejected > 0) lines.push(`Chrome rejected ${scripts(rejected)}.`);
    if (invalid > 0) lines.push(`${scripts(invalid)} failed to load.`);
    if (updated > 0) lines.push(`Reload needed to update ${scripts(updated)}.`);
    if (added > 0) lines.push(`Reload needed to add ${scripts(added)}.`);
    if (removed > 0) lines.push(`Reload needed to remove ${scripts(removed)}.`);
    if (untracked > 0) {
      lines.push(`Page loaded before SourceMonkey started. Reload needed for ${scripts(untracked)}.`);
    }
    if (missing > 0) lines.push(`${missing} expected ${noun(missing)} ${is(missing)} not running.`);
    if (unexpected > 0) lines.push(`${unexpected} unexpected ${noun(unexpected)} ${is(unexpected)} running.`);
    if (warned > 0) lines.push(`${scripts(warned)} ${has(warned)} warnings.`);
    if (skipped > 0) lines.push(`${scripts(skipped)} skipped on this load.`);
  }

  // Red, purple, orange or grey, the first that applies, else green.
  // Warnings have none: a header warning would otherwise keep the badge
  // off green for good.
  let color: string | null = null;
  if (anyBadged) {
    if (errors + rejected + invalid > 0) color = BADGE_RED;
    else if (updated + added + removed + untracked > 0) color = BADGE_PURPLE;
    else if (missing + unexpected > 0) color = BADGE_ORANGE;
    // Grey says nothing ran: not for a tab where some scripts were kept
    // out (an sm-dev claim) and the rest ran.
    else if (skipped > 0 && running === 0) color = BADGE_GREY;
    else color = BADGE_GREEN;
  }

  const head = view.smDev ? ['SourceMonkey', SM_DEV_CONTROL_LABEL] : ['SourceMonkey'];
  // The rows the popup gives a status, so the count and the lines
  // agree: a script disabled or deleted since load that never started
  // has none, and one enabled since that hasn't run yet does.
  const counted = count((r) => r.status !== null && r.status !== 'NOT_RUN' && (state === null || countsOnBadge(state, r.id)));
  return { count: counted, color, title: [...head, ...lines, TOOLBAR_CLICK_HINT].join('\n') };
}
