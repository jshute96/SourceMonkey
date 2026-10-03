// Which execution world a script runs in, from its header. Its own
// module so the harness can ask without loading the injector.

import { getValue, getValues, type ParsedHeader } from './userscript-header.js';
import { resolveGrants } from './gm-api-catalog.js';
import type { StoredScript } from './script-build.js';

export type InjectionWorld = 'MAIN' | 'USER_SCRIPT';

// Decide which execution world a script should run in. Mirrors
// Violentmonkey's `@inject-into` semantics (and Tampermonkey's default
// for `@grant none`):
//
//   - `@inject-into page`        → MAIN  (page context — sees the page's
//                                          window.X globals)
//   - `@inject-into content`     → USER_SCRIPT (isolated)
//   - default / `auto` / unset   → MAIN when there are no @grant entries
//                                  or a `none` line is present, MAIN when
//                                  `unsafeWindow` is granted, and MAIN
//                                  when the body names `unsafeWindow`
//                                  with no grant for it; otherwise
//                                  USER_SCRIPT.
//
// Why `@grant none` defaults to MAIN: scripts that opt out of GM_* (the
// `@grant none` convention) expect direct page access — `window.map`,
// `window.jQuery`, page-defined functions. Putting them in USER_SCRIPT
// silently breaks any script that touches a page global. Tampermonkey
// runs `@grant none` scripts in page context for the same reason.
//
// `none` wins over other grants here for the same reason it does in
// `resolveGrants`: one rule, applied in both places. A script mixing
// `none` with `GM_setValue` gets no bindings AND runs in MAIN — a plain
// `@grant none` script, which is how Tampermonkey reads it ("`@grant
// none` disables the sandbox"). The old rule (MAIN only when every
// line was `none`) left such a script isolated with nothing.
// `extractStartupLogs` warns so the author sees why the grants are gone.
//
// Why `@grant unsafeWindow` also defaults to MAIN: same reason, one
// level down. The whole point of the grant is reaching the page's
// globals, and USER_SCRIPT world cannot do that at all. Running such a
// script isolated hands it a `window` that merely *looks* right, so the
// failure is silent. GM_* still works in MAIN — the runtime is
// registered there too and routes SW traffic over `wrapper-bridge.js`.
//
// `@inject-into content` still wins, because it is an explicit request
// for isolation. Such a script gets `unsafeWindow === window` (the
// isolated realm's), matching Violentmonkey's content mode, plus a
// startup-log warning so the mismatch is visible rather than silent —
// see `extractStartupLogs` in script-store.ts.
//
// Why an UNGRANTED `unsafeWindow` does the same: TM and VM both expose
// the name with no grant line, so a script written against either has
// no reason to declare one — 112 of the GreasyFork top 2000 use it
// ungranted. Honoring only the grant leaves those scripts with a
// ReferenceError on a name their author saw working. The reference is
// found by a text scan of the body at load time
// (`sourceUsesUnsafeWindow`, persisted as `StoredScript
// .usesUnsafeWindow`), not by parsing — see src/unsafe-window-use.ts
// for what that can and can't see.
//
// `@inject-into content` and `@inject-into page` both still win, and a
// script already headed for MAIN (`@grant none`, no grants) just gains
// the binding.
export function resolveWorld(
  header: ParsedHeader | null | undefined,
  // `StoredScript.usesUnsafeWindow` — the body names the name, grant or
  // no grant, per the note above. Production callers go through
  // `resolveScriptWorld` so they can't forget it.
  usesUnsafeWindow = false,
): InjectionWorld {
  if (!header) return 'MAIN';
  const injectInto = (getValue(header, 'inject-into') ?? '').trim().toLowerCase();
  if (injectInto === 'page') return 'MAIN';
  if (injectInto === 'content') return 'USER_SCRIPT';
  const grants = getValues(header, 'grant');
  if (grants.length === 0) return 'MAIN';
  const { granted, hasNone } = resolveGrants(grants);
  if (hasNone) return 'MAIN';
  if (granted.has('unsafeWindow')) return 'MAIN';
  if (usesUnsafeWindow) return 'MAIN';
  return 'USER_SCRIPT';
}

// The world for a stored row — the form every production caller uses.
// One function, one input: the spec build, the match index and the
// reload-swap world check all have to agree, and a call site that read
// the header alone would silently answer USER_SCRIPT for a script the
// other two put in MAIN.
export function resolveScriptWorld(
  script: Pick<StoredScript, 'header' | 'usesUnsafeWindow'>,
): InjectionWorld {
  return resolveWorld(script.header, script.usesUnsafeWindow === true);
}
