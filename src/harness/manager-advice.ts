// Advice for a manager that can't be used in the browser: the commands
// that fix it, and a temp browser as the way out. Shared by all
// managers' messages, so they read the same.

import { DEFAULT_MANAGER, managerFlag, MANAGERS, type ManagerName } from './managers.js';
import { quoted } from './output-style.js';

/**
 * The way out of a browser the run connects to, for advice: `does` is
 * what a temp browser does for it (`loads it`).
 */
export function useTempBrowser(does: string): string {
  return `use ${quoted('--temp-browser')} (which ${does} automatically)`;
}

/**
 * A `manager` command for `name`, for advice, unquoted: `--manager tm
 * manager install`. `withFlag`: name the manager even when it's the
 * default, for advice about a manager other than the one in use.
 */
export function managerFixCommand(name: ManagerName, verb: 'install' | 'enable' | 'disable', withFlag = name !== DEFAULT_MANAGER): string {
  return `${withFlag ? `${managerFlag(name)} ` : ''}manager ${verb}`;
}

/**
 * Why the manager in the browser can't be used: it isn't installed
 * there, or it's turned off. The same for all managers. `forRun`: a
 * run, which a temp browser could do instead.
 */
export function managerUnusable(name: ManagerName, state: 'absent' | 'disabled', forRun = true): string {
  const { label } = MANAGERS[name];
  const temp = forRun ? `, or ${useTempBrowser('loads it')}` : '';
  return state === 'absent'
    ? `${label} is not installed in this browser. Install it with ${quoted(managerFixCommand(name, 'install'))}, or install the extension manually${temp}.`
    : `${label} is turned off in this browser. Turn it on with ${quoted(managerFixCommand(name, 'enable'))}${temp}.`;
}
