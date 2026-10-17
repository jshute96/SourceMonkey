// Explaining a script that matched a page but never started there.
//
// The badge shows such a script as MISSING. Once the page has loaded,
// the service worker also writes a Log warning for it, built here from
// what the document's other wrapper reports said (`reportedWorlds`,
// `opaqueOrigin` on TabMatchState). The main case it names:
//   - A CSP `sandbox` header without `allow-scripts` turns off script
//     in the page's own world, so Chrome silently skips MAIN-world
//     scripts there, while USER_SCRIPT-world ones still run. The
//     bridge then has them run isolated (`runBlockedMainScripts` in
//     background.ts), so this hint matters only when that didn't run.
//   - Such a page gets an opaque origin, which any wrapper that did run
//     there reports.
// See docs/matching.md#scripts-that-never-start.

import type { InjectionWorld } from '../script-world.js';
import type { MatchedScript } from './match-index.js';
import { skippedOnDocument, type TabMatchState } from './tab-status.js';
import { INJECT_INTO_CONTENT_FIX, SANDBOX_BLOCKS_PAGE_CONTEXT } from '../sandboxed-page.js';

// The scripts expected on this document from its first load that never
// reported, and aren't already explained by the badge (REJECTED, NOT
// LOADED). See `loadMatchIds` for why only the first load's.
export function findMissingScripts(
  state: TabMatchState,
  rejected: ReadonlySet<string> = new Set(),
): MatchedScript[] {
  // Nothing was injected, so no script on it is a mystery to explain.
  if (state.scriptsSkipped || state.loadedWithoutUserscripts) return [];
  const atLoad = state.loadMatchIds ? new Set(state.loadMatchIds) : null;
  return state.matches.filter((m) =>
    (!atLoad || atLoad.has(m.id)) && !state.actual[m.id] && !rejected.has(m.id) && !skippedOnDocument(state, m.id));
}

// Whether the document is sandboxed, going by the wrappers' reports.
// Only on http(s): a file:// page has an opaque origin too.
function sandboxed(state: TabMatchState): boolean {
  return state.opaqueOrigin === true && /^https?:/i.test(state.url);
}

function reportedFrom(state: TabMatchState, world: InjectionWorld): boolean {
  return (state.reportedWorlds ?? []).includes(world);
}

// The Log warning for one missing script.
export function describeMissingScript(script: MatchedScript, state: TabMatchState): string {
  const base = `Matched ${state.url} but never started there`;
  let hint: string;
  if (script.world === 'MAIN') {
    if (reportedFrom(state, 'MAIN')) {
      hint = 'Other scripts in the page\'s own context did start here, so the page isn\'t blocking that context.';
    } else if (sandboxed(state)) {
      hint = 'This page is sandboxed, usually by a sandbox directive in its Content-Security-Policy header. ' +
        `${SANDBOX_BLOCKS_PAGE_CONTEXT}. ${INJECT_INTO_CONTENT_FIX}.`;
    } else if (!/^https?:/i.test(state.url)) {
      // No response headers to point at.
      return base;
    } else {
      hint = 'The page may be blocking scripts in its own context. Check its Content-Security-Policy ' +
        `header for a sandbox directive without allow-scripts. If it has one, ${lowerFirst(INJECT_INTO_CONTENT_FIX)}.`;
    }
  } else if (reportedFrom(state, 'USER_SCRIPT')) {
    hint = 'Other scripts in the isolated context did start here.';
  } else {
    return base;
  }
  return `${base}. ${hint}`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
