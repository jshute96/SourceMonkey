// Userscript injection via the chrome.userScripts API.
//
// Chrome owns the actual matching + injection at navigation time. Our
// job is to keep its registration set in sync with our "effectively
// enabled ok scripts" view of the world. Whenever the script-store
// cache changes we re-sync (cheap full wipe + re-register at our
// scale).
//
// Each script's body is wrapped in a tiny prelude/postlude:
//   - logs "[VibeMonkey] script "<name>" running on <url>" to the page
//     console on activation,
//   - catches synchronous throws from the body and logs them as
//     "[VibeMonkey] script "<name>" threw: <message>",
//   - posts vm:start / vm:error messages to the SW so the SW can log
//     activity centrally.
//
// We deliberately do NOT install a global `unhandledrejection`
// listener — it would catch the page's own promise rejections (and
// every other userscript's) and falsely attribute them to whichever
// script happened to register the handler. Async failures from inside
// a body escape our try/catch as a known limitation; documented in
// docs/injection.md.
//
// Requirements: manifest must include the "userScripts" permission AND
// the user must enable the "Allow User Scripts" toggle (Chrome ≥138) or
// developer mode (Chrome 120–137) on chrome://extensions. If the toggle
// is off, chrome.userScripts.register throws; we surface that via
// getLastError() so the options page can prompt the user.
//
// Handling /regex/ @include / @exclude: the User Scripts API has no
// equivalent for these. We work around it by:
//   (a) registering broadly enough that Chrome will hand the page to
//       us — if a script has only regex @includes (no @match, no glob
//       @include), we register `<all_urls>` so Chrome injects
//       everywhere, and let the wrapper filter; otherwise the script
//       already has Chrome-understandable patterns, and we just need
//       the wrapper to apply the regex @excludes.
//   (b) re-running urlMatchesScript inside the wrapper before the
//       body runs, bailing silently if the current URL doesn't
//       actually match. This keeps badge count and actual injection
//       in sync without divergence.
// The runtime filter is only emitted when a script actually contains
// a regex pattern; pure @match / glob-only scripts skip it.

import {
  isScriptEnabled,
  isSourceEnabled,
  type StoredScript,
  type StoredSource,
} from './script-store.js';
import { getValue } from './userscript-header.js';
import {
  WRAPPER_HEAD,
  WRAPPER_MATCHER,
  WRAPPER_TAIL,
} from './generated-wrappers.js';

const SCRIPT_PREFIX = 'script:';
const SOURCE_PREFIX = 'source:';

// Match the runtime-message types we use between injected scripts and
// the SW. Keep these in sync with the strings the wrapper sends.
export const VM_START_MSG = 'vm:start';
export const VM_ERROR_MSG = 'vm:error';

export type RunAt = chrome.userScripts.RunAt;
export type RegistrationSpec = chrome.userScripts.RegisteredUserScript;

// Map @run-at to the User Scripts API's runAt enum. document-body has
// no exact equivalent; treat it as document_start (it fires before
// DOMContentLoaded in Tampermonkey too).
export function mapRunAt(value: string | undefined): RunAt {
  switch ((value ?? '').toLowerCase()) {
    case 'document-start':
    case 'document-body':
      return 'document_start';
    case 'document-end':
      return 'document_end';
    default:
      return 'document_idle';
  }
}

function isRegexLiteral(s: string): boolean {
  return s.length >= 2 && s.startsWith('/') && s.endsWith('/');
}

// Wrap a userscript body with our activation/error logging shim plus
// (optionally) the regex-aware match recheck. The wrapper runs in the
// USER_SCRIPT world; `chrome.runtime.sendMessage` works there because
// we call `configureWorld({ messaging: true })` before registering.
//
// The HEAD and TAIL come from src/wrapper-head.js + src/wrapper-tail.js
// pre-minified to a single line each by the build (see
// scripts/build.mjs). Placing the entire HEAD on physical line 1 with
// no trailing newline keeps the body's line N at physical line N, so
// user-facing stack traces report meaningful line numbers.
//
// If `matching` is provided, the wrapper embeds the matcher snippet
// (from src/wrapper-matcher.js) so the wrapper can re-check the URL
// against the full Tampermonkey match semantics — including /regex/
// forms that the User Scripts API can't express — and silently bail
// on a miss.
export function buildWrappedBody(args: {
  id: string;
  name: string;
  body: string;
  matching?: { matches: string[]; includes: string[]; excludes: string[] };
}): string {
  // Pass replacements as functions so `$&` / `$1` etc. inside our
  // generated wrappers aren't interpreted as String.prototype.replace
  // back-references (the matcher contains literal `$&` inside a
  // regex-escape helper, which would otherwise corrupt the output).
  const matcherBlock = args.matching
    ? WRAPPER_MATCHER.replace('"__VM_MATCHING__"', () => JSON.stringify(args.matching!))
    : '';
  const head = WRAPPER_HEAD
    .replace('"__VM_NAME__"', () => JSON.stringify(args.name))
    .replace('"__VM_ID__"', () => JSON.stringify(args.id))
    .replace('"__VM_MATCHER_BLOCK__";', () => matcherBlock);
  // No newline between head and body so body line N stays at physical
  // line N. Tail goes on its own line after the body for readability
  // when inspecting the registered code.
  return head + args.body + '\n' + WRAPPER_TAIL;
}

// Pure: build the spec we'll hand to chrome.userScripts.register for
// one script. Returns null only if validateHeader would have caught
// the script upstream (no matchable patterns at all).
//
// Strategy for regex patterns:
//   - /regex/ @includes have no Chrome equivalent; they go to the
//     wrapper-side filter. If a script's ONLY includes are regexes
//     (and it has no @match), we register with `<all_urls>` so Chrome
//     hands us every page and the wrapper does the real check.
//   - /regex/ @excludes likewise go to the wrapper. We can't tell
//     Chrome to skip them, so they always get an injection that the
//     wrapper aborts.
export function buildRegistrationSpec(script: StoredScript): RegistrationSpec | null {
  const matches = script.matching.matches.slice();
  const includeGlobs: string[] = [];
  const excludeGlobs: string[] = [];
  let hasRegexInclude = false;
  let hasRegexExclude = false;
  for (const inc of script.matching.includes) {
    if (isRegexLiteral(inc)) hasRegexInclude = true;
    else includeGlobs.push(inc);
  }
  for (const ex of script.matching.excludes) {
    if (isRegexLiteral(ex)) hasRegexExclude = true;
    else excludeGlobs.push(ex);
  }

  // If Chrome has nothing to pattern-match on, fall back to <all_urls>
  // (only when there's at least a regex @include to defer to — a
  // script with literally no match/include patterns shouldn't reach
  // here because validateHeader rejects it).
  if (matches.length === 0 && includeGlobs.length === 0) {
    if (hasRegexInclude) matches.push('<all_urls>');
    else return null;
  }

  const runAt = mapRunAt(script.header ? getValue(script.header, 'run-at') : undefined);
  const name = (script.header && getValue(script.header, 'name')) || script.relativePath;
  const needsWrapperFilter = hasRegexInclude || hasRegexExclude;

  const spec: RegistrationSpec = {
    id: script.id,
    js: [{ code: buildWrappedBody({
      id: script.id,
      name,
      body: script.bodyText,
      matching: needsWrapperFilter ? script.matching : undefined,
    }) }],
    runAt,
    world: 'USER_SCRIPT',
  };
  if (matches.length > 0) spec.matches = matches;
  if (includeGlobs.length > 0) spec.includeGlobs = includeGlobs;
  if (excludeGlobs.length > 0) spec.excludeGlobs = excludeGlobs;
  return spec;
}

// Pure: pick the scripts that should be registered right now. Both the
// script's own enabled flag and its parent source's flag must be true,
// and the script must be `status: 'ok'`.
export function collectActiveSpecs(
  scripts: StoredScript[],
  sources: Map<string, StoredSource>,
): RegistrationSpec[] {
  const out: RegistrationSpec[] = [];
  for (const s of scripts) {
    if (s.status !== 'ok') continue;
    if (!isScriptEnabled(s)) continue;
    const src = sources.get(s.sourceId);
    if (!src || !isSourceEnabled(src)) continue;
    const spec = buildRegistrationSpec(s);
    if (spec) out.push(spec);
  }
  return out;
}

// ---------- Runtime sync (uses chrome.userScripts) ----------

let lastError: string | null = null;
export function getLastError(): string | null { return lastError; }

// Per-script registration errors from the last sync. Populated when the
// batch register() rejects and we fall back to per-script registration
// (see syncRegistrations). Cleared at the start of each sync.
const perScriptErrors = new Map<string, string>();
export function getPerScriptErrors(): Map<string, string> {
  return new Map(perScriptErrors);
}

// True if the API surface is present at all. The permission is required
// for chrome.userScripts to exist; if it's missing the sync no-ops.
export function isUserScriptsAvailable(): boolean {
  return typeof chrome !== 'undefined' && (chrome as { userScripts?: unknown }).userScripts != null;
}

async function readAll(): Promise<{ scripts: StoredScript[]; sources: Map<string, StoredSource> }> {
  const all = await chrome.storage.local.get(null);
  const scripts: StoredScript[] = [];
  const sources = new Map<string, StoredSource>();
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(SCRIPT_PREFIX)) scripts.push(v as StoredScript);
    else if (k.startsWith(SOURCE_PREFIX)) {
      const s = v as StoredSource;
      sources.set(s.id, s);
    }
  }
  return { scripts, sources };
}

let worldConfigured = false;
async function ensureWorldConfigured(): Promise<void> {
  if (worldConfigured) return;
  // configureWorld must be called before register; messaging: true is
  // what lets our wrapper call chrome.runtime.sendMessage from the
  // USER_SCRIPT world. Idempotent — Chrome accepts repeated calls but
  // we still guard so we don't issue them on every sync.
  await chrome.userScripts.configureWorld({ messaging: true });
  worldConfigured = true;
}

// Wipe Chrome's current registration set and replace it with `specs`.
// Cheap full resync — simpler than a diff and fine at the script counts
// we expect.
//
// Failure modes:
//   - User hasn't enabled "Allow User Scripts" → configureWorld /
//     getScripts / register throws. `lastError` carries the message.
//   - One spec has a malformed pattern → batch register() is all-or-
//     nothing, so we first wipe (`unregister`), then retry one-at-a-
//     time so a single bad pattern doesn't drop every other script.
//     Per-script failures land in `perScriptErrors` keyed by ID.
export async function syncRegistrations(): Promise<void> {
  if (!isUserScriptsAvailable()) {
    lastError = 'chrome.userScripts not available (permission missing?)';
    return;
  }
  perScriptErrors.clear();
  try {
    await ensureWorldConfigured();
    const { scripts, sources } = await readAll();
    const specs = collectActiveSpecs(scripts, sources);
    const existing = await chrome.userScripts.getScripts();
    if (existing.length > 0) {
      await chrome.userScripts.unregister({ ids: existing.map((e) => e.id) });
    }
    const registered = await registerWithFallback(specs);
    lastError = null;
    const failed = specs.length - registered;
    if (failed > 0) {
      console.warn(
        `[VibeMonkey] registered ${registered}/${specs.length} userscript(s); ${failed} rejected by chrome.userScripts (see per-script errors)`,
      );
    } else {
      console.log(`[VibeMonkey] registered ${registered} userscript(s) with chrome.userScripts`);
    }
  } catch (err) {
    lastError = describeError(err);
    // Common case: "Allow User Scripts" toggle is off. Log once per
    // sync so we don't bury the SW console.
    console.warn('[VibeMonkey] userScripts sync failed:', lastError);
  }
}

// Register a list of specs, falling back from batch to per-script on a
// batch failure so one malformed pattern doesn't take everything down.
// Returns the count of specs that actually registered. Per-spec failure
// reasons are recorded in `perScriptErrors`.
async function registerWithFallback(specs: RegistrationSpec[]): Promise<number> {
  if (specs.length === 0) return 0;
  try {
    await chrome.userScripts.register(specs);
    return specs.length;
  } catch {
    // Batch rejected — at least one spec is bad. Find the good ones.
  }
  let ok = 0;
  for (const spec of specs) {
    try {
      await chrome.userScripts.register([spec]);
      ok++;
    } catch (err) {
      const msg = describeError(err);
      perScriptErrors.set(spec.id, msg);
      console.warn(`[VibeMonkey] script ${spec.id} rejected: ${msg}`);
    }
  }
  return ok;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
