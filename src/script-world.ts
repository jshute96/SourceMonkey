// Which execution world a script runs in, from its header. Its own
// module so the harness can ask without loading the injector.

import { getValue, getValues, type ParsedHeader } from './userscript-header.js';
import { resolveGrants } from './gm-api-catalog.js';
import type { StoredScript } from './script-build.js';

export type InjectionWorld = 'MAIN' | 'USER_SCRIPT';

// Decide which execution world a script should run in. Like
// Tampermonkey and Violentmonkey, every script starts in the page's own
// world (MAIN) and leaves it only when its header asks:
//
//   - `@inject-into page`      → MAIN
//   - `@inject-into content`   → USER_SCRIPT (isolated)
//   - `@sandbox raw`           → MAIN
//   - `@sandbox JavaScript`    → MAIN (TM's choice on Chrome too; only
//                                Firefox has a separate world for it)
//   - `@sandbox DOM`           → USER_SCRIPT
//   - anything else, unset, `@inject-into auto` → MAIN
//
// `@inject-into` (VM's) is read first when a script has both.
//
// Why the page by default: scripts written against TM and VM read the
// page's globals (its `$`, an app's state, `customElements`) without
// `unsafeWindow`, since there they are in the page. In USER_SCRIPT world
// those read as `undefined` and the script silently breaks. A granted
// script still keeps its writes off the page's `window`: it runs in a
// sandbox `window` (`runsSandboxed` below).
//
// What the page costs a script, and why `@inject-into content` exists:
// see docs/injection.md, "Execution world".
//
// `@inject-into content` with `unsafeWindow` (by grant or by use) gets
// that world's own `window` as `unsafeWindow`, matching Violentmonkey's
// content mode, plus a startup-log warning; see `extractStartupLogs`.
export function resolveWorld(
  header: ParsedHeader | null | undefined,
): InjectionWorld {
  if (!header) return 'MAIN';
  const injectInto = (getValue(header, 'inject-into') ?? '').trim().toLowerCase();
  if (injectInto === 'page') return 'MAIN';
  if (injectInto === 'content') return 'USER_SCRIPT';
  const sandbox = (getValue(header, 'sandbox') ?? '').trim().toLowerCase();
  if (sandbox === 'dom') return 'USER_SCRIPT';
  return 'MAIN';
}

// The world for a stored row, the form every production caller uses:
// the spec build, the match index and the reload-swap world check all
// have to agree.
export function resolveScriptWorld(
  script: Pick<StoredScript, 'header'>,
): InjectionWorld {
  return resolveWorld(script.header);
}

// Whether the script's user program runs inside a sandbox `window`
// (the prelude's `sandbox`): a page-world script that grants anything.
// That's how Tampermonkey and Violentmonkey run a granted script in the
// page: reads reach the page's globals, but the script's own writes,
// a `@require`d library's `window.jQuery = …` included, stay off the
// page's `window`. A `@grant none` or grantless script gets the page's
// `window` itself, as it does under both. See docs/injection.md, "The
// sandbox window".
export function runsSandboxed(
  script: Pick<StoredScript, 'header'>,
): boolean {
  if (!script.header || resolveScriptWorld(script) !== 'MAIN') return false;
  const grants = getValues(script.header, 'grant');
  return grants.length > 0 && !resolveGrants(grants).hasNone;
}
