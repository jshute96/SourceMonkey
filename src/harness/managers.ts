// The userscript managers sm-dev knows: SourceMonkey, Tampermonkey (TM)
// and Violentmonkey (VM). `--manager` picks one for the whole line,
// and each command says which it works with (command-list.ts).
//
// It imports only json-output.ts, which imports nothing, so
// command-list.ts can load it for help.

import type { ManagerName } from './json-output.js';

export type { ManagerName };

export interface ManagerInfo {
  name: ManagerName;
  /** `sm`, `tm`, `vm`: what `--manager` takes, besides the full name. */
  short: string;
  label: string;
  /**
   * Its Chrome Web Store id, which `manager fetch` downloads by. The
   * same as in tests/fixtures/managers.mjs, which can't import this.
   * SourceMonkey comes with sm-dev instead.
   */
  storeId?: string;
}

export const MANAGERS: Record<ManagerName, ManagerInfo> = {
  sourcemonkey: { name: 'sourcemonkey', short: 'sm', label: 'SourceMonkey' },
  tampermonkey: { name: 'tampermonkey', short: 'tm', label: 'Tampermonkey', storeId: 'dhdgffkkebhmkfjojejmpbldmpobfkfo' },
  violentmonkey: { name: 'violentmonkey', short: 'vm', label: 'Violentmonkey', storeId: 'jinjaccalgkegednnccohejagnlnfdag' },
};

export const MANAGER_NAMES = Object.keys(MANAGERS) as ManagerName[];

/** The default, when `--manager` isn't given. */
export const DEFAULT_MANAGER: ManagerName = 'sourcemonkey';

/** The manager `value` names (`tm`, `Tampermonkey`, any case), or null. */
export function managerNamed(value: string): ManagerName | null {
  const v = value.trim().toLowerCase();
  return MANAGER_NAMES.find((name) => name === v || MANAGERS[name].short === v) ?? null;
}

/** What `--manager` says of a value it doesn't take. */
export function managerMistake(value: string): string {
  return `There is no manager ${value}. The --manager flag takes sm, tm or vm, or sourcemonkey, tampermonkey or violentmonkey`;
}

/** `--manager tm`, the flag that picks it, for a command to show. */
export function managerFlag(name: ManagerName): string {
  return `--manager ${MANAGERS[name].short}`;
}
