// The development harness's front door: a userscript on disk (or as
// text) in, an injectable script out.
//
// This runs SourceMonkey's real install pipeline under Node — the same
// functions the extension calls when it installs or refreshes a script:
//
//   1. `buildScriptFromText` splits the metadata block, parses and
//      validates the header, and derives the matching rules.
//   2. `applyFiles` resolves and fetches every `@require` / `@resource`,
//      with the same local-file overrides the extension applies to a
//      script loaded from disk (a `@require https://…/lib/x.js` reads
//      the local `lib/x.js` when one sits under a search root).
//   3. The parse check compiles the composed program without running
//      it, so a syntax error is reported against the file and line it
//      was written in — under Node's V8 rather than Chrome's, which is
//      the one piece that differs (see parse-check-node.ts).
//   4. `buildRegistrationSpec` produces the exact code entries the
//      extension would register with `chrome.userScripts`: the config
//      blob, the prelude, the combined `@require` + body entry, and the
//      seal. The harness injects those entries as init scripts, so the
//      prelude's `@run-at` gate, the in-page matcher, the `GM_*`
//      bindings, and error attribution all run unchanged.
//
// Nothing here touches `chrome.*`. The two globals the pipeline reaches
// for are replaced once per process: `fetch`, which Node doesn't
// implement for `file://` URLs, and the parse checker, which the
// extension installs from a sandboxed page.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  applyFiles,
  buildScriptFromText,
  setParseChecker,
  type StoredScript,
  type ScriptMatching,
  type StartupLog,
} from '../script-store.js';
import {
  buildParseCheckSource,
  buildRegistrationSpec,
  grantedSubsystems,
  needsGmRuntime,
  normalizeDeclaredRunAt,
  resolveScriptWorld,
  type RegistrationSpec,
} from '../injector.js';
import { attachParseLocation } from '../parse-location.js';
import { describeDiagnostic, type DiagnosticLocation } from '../diagnostic-location.js';
import { setConfiguredLocalRoots } from '../local-file-overrides.js';
import { getValue, hasTag } from '../userscript-header.js';
import { includePattern, matchPattern } from '../url-match.js';
import { scriptBasename } from '../script-display.js';
import { sha256Hex } from '../bytes.js';
import type { ApiSubsystem } from '../gm-api-catalog.js';
import { checkParseNode } from './parse-check-node.js';

export type InjectionWorld = 'MAIN' | 'USER_SCRIPT';
export type RunAt = 'document-start' | 'document-body' | 'document-end' | 'document-idle';

// The registration `buildRegistrationSpec` produces, in the harness's
// own words so a consumer needs no `@types/chrome` to read it.
export interface RegistrationEntries {
  id: string;
  /** The code entries, in injection order. */
  js: { code: string }[];
  matches?: string[];
  includeGlobs?: string[];
  excludeGlobs?: string[];
  world: InjectionWorld;
}

export interface PrepareOptions {
  /** Absolute path of the `.user.js` file. Either this or `text`. */
  file?: string;
  /** The script's source, when it isn't read from disk. */
  text?: string;
  /**
   * Where the script lives, as a URL. Relative `@require`s resolve
   * against it, and only a `file://` script gets local overrides.
   * Defaults to the file's own URL, or a placeholder `file://` URL
   * next to `collectionRoot` when only `text` was given.
   */
  sourceUrl?: string;
  /**
   * The directory the script's repo is rooted at. Searched for local
   * stand-ins of remote `@require` / `@resource` URLs, so a script deep
   * in `sites/` can reach a `lib/` at the top. The script's path is
   * reported relative to it, as the extension would.
   */
  collectionRoot?: string;
  /** Extra directories to search for local stand-ins. */
  localRoots?: string[];
  /** Turn local stand-ins off entirely. Default on. */
  localFiles?: boolean;
  /**
   * The `GM_info.scriptHandler` version to bake in. Defaults to the
   * package version.
   */
  handlerVersion?: string;
  /**
   * The label devtools and stack traces show for the script. Defaults
   * to the file's basename.
   */
  logLabel?: string;
  /**
   * Tells two loads of the same file apart, so both can run on one
   * page as two installed copies would: each gets its own script id,
   * its own storage, and its own wrapper. Without it a second load of
   * a path replaces the first.
   */
  copy?: string;
}

export interface PreparedScript {
  /** The row the extension would have stored. */
  script: StoredScript;
  status: 'ok' | 'invalid';
  /** The extension's own message, when `status` is `invalid`. */
  errorMessage?: string;
  errorLocation?: DiagnosticLocation;
  /** `errorMessage` rendered with its location, as the viewer shows it. */
  diagnostic?: string;
  /** Non-fatal parse-time notes: an unknown `@grant`, an ignored `@match`. */
  startupLogs: readonly StartupLog[];
  /** The registration Chrome would get, entries in order. Null when invalid. */
  spec: RegistrationEntries | null;
  world: InjectionWorld;
  runAt: RunAt;
  matching: ScriptMatching;
  noframes: boolean;
  /** Whether the shared `__SM_GM__` runtime has to be on the page. */
  needsGmRuntime: boolean;
  /** The GM subsystems the script's `@grant` lines reach. */
  grantedSubsystems: Set<ApiSubsystem>;
  /** The `@require` URLs, resolved, with where each was read from. */
  requires: { url: string; localUrl?: string }[];
}

let handlerVersionDefault: string | null = null;

async function packageVersion(): Promise<string> {
  if (handlerVersionDefault) return handlerVersionDefault;
  try {
    const raw = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
    handlerVersionDefault = String(JSON.parse(raw).version ?? '0.0.0');
  } catch {
    handlerVersionDefault = '0.0.0';
  }
  return handlerVersionDefault;
}

// ---------- The two process-wide seams ----------

let seamsInstalled = false;

// `file-loader.ts` reads every dependency through the global `fetch`,
// which Node doesn't implement for `file://`. Wrap it once; http(s)
// passes straight through to the real one.
function installNodeSeams(): void {
  if (seamsInstalled) return;
  seamsInstalled = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : input.url;
    if (!url.startsWith('file:')) return realFetch(input, init);
    let body: ArrayBuffer;
    try {
      const buf = await readFile(fileURLToPath(url));
      body = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    } catch {
      return new Response(null, { status: 404 });
    }
    // No Content-Type, as Chrome's own `file://` fetch has none: the
    // loader's markup sniff is the gate for local files either way, and
    // a header invented here would make the stored row differ from the
    // extension's.
    return new Response(body, {
      status: 200,
      headers: { 'content-length': String(body.byteLength) },
    });
  };
  // Same two steps the extension's checkers perform: compose the exact
  // text the injected entry compiles, then map the reported position
  // back to the file it was written in. Only the compile is Node's.
  setParseChecker(async (script) => {
    const checked = await buildParseCheckSource(script, await packageVersion());
    return attachParseLocation(checkParseNode(checked.text), checked);
  });
}

// ---------- Preparing ----------

// Calls are serialized: the override resolver's configured roots and
// the parse checker are process-wide, and two overlapping prepares with
// different `localRoots` would otherwise read each other's. A spec that
// prepares several scripts with `Promise.all` still gets each one
// resolved against its own roots.
let chain: Promise<unknown> = Promise.resolve();

export function prepareScript(opts: PrepareOptions): Promise<PreparedScript> {
  const run = chain.then(() => prepareScriptNow(opts));
  chain = run.catch(() => undefined);
  return run;
}

async function prepareScriptNow(opts: PrepareOptions): Promise<PreparedScript> {
  installNodeSeams();
  if (!opts.file && opts.text === undefined) {
    throw new Error('prepareScript needs a file or text');
  }
  const text = opts.text ?? await readFile(opts.file as string, 'utf8');
  const sourceUrl = opts.sourceUrl
    ?? (opts.file ? pathToFileURL(path.resolve(opts.file)).toString()
      : pathToFileURL(path.join(opts.collectionRoot ?? process.cwd(), 'pushed.user.js')).toString());
  const relativePath = relativePathFor(opts, sourceUrl);
  const now = Date.now();

  // The configured roots are process-wide state in the override
  // resolver (the extension reads them from storage once), so they are
  // set on every call; `prepareScript` serializes calls for the same
  // reason.
  setConfiguredLocalRoots((opts.localRoots ?? []).map(dirUrl));
  const built = await buildScriptFromText({
    // Stable across re-prepares of the same file, so the host can keep
    // that script's GM values under one key, and distinct for two
    // scripts sharing a basename, so their prelude entries don't
    // collide when both are injected into one page.
    id: `harness-${scriptBasename(relativePath)}-${(await sha256Hex(sourceUrl + (opts.copy ?? ''))).slice(0, 12)}`,
    collectionId: 'harness',
    relativePath,
    fileUrl: sourceUrl,
    text,
    now,
  });
  // A fresh install: no prior row, every dependency refetched. The
  // collection root joins the search roots the way it does for a
  // directory collection in the extension.
  const script = await applyFiles(built, undefined, 'all', new Map(), now, {
    enabled: opts.localFiles !== false,
    collectionPath: opts.collectionRoot ? dirUrl(opts.collectionRoot) : undefined,
  });

  const handlerVersion = opts.handlerVersion ?? await packageVersion();
  const logLabel = opts.logLabel ?? scriptBasename(relativePath);
  const spec = script.status === 'ok'
    ? asEntries(await buildRegistrationSpec(script, handlerVersion, logLabel, { inPageMatcher: true }))
    : null;

  const out: PreparedScript = {
    script,
    status: script.status,
    startupLogs: script.startupLogs ?? [],
    spec,
    world: resolveScriptWorld(script),
    runAt: normalizeDeclaredRunAt(script.header ? getValue(script.header, 'run-at') : undefined) as RunAt,
    matching: script.matching,
    noframes: script.header ? hasTag(script.header, 'noframes') : false,
    needsGmRuntime: needsGmRuntime(script.header),
    grantedSubsystems: grantedSubsystems(script.header),
    requires: (script.requires ?? []).map((r) => ({ url: r.url, localUrl: r.localUrl })),
  };
  if (script.errorMessage) {
    out.errorMessage = script.errorMessage;
    out.errorLocation = script.errorLocation;
    out.diagnostic = describeDiagnostic(script.errorMessage, script.errorLocation);
  }
  return out;
}

// The path the extension would store for this script: relative to the
// collection root when it sits under one, else just its name. The
// diagnostics, the composed-source segments, and `GM_info` all carry
// it, so a harness run reads the same as the extension's Log tab.
function relativePathFor(opts: PrepareOptions, sourceUrl: string): string {
  if (!opts.file) return scriptBasename(sourceUrl);
  const file = path.resolve(opts.file);
  if (opts.collectionRoot) {
    const rel = path.relative(path.resolve(opts.collectionRoot), file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return path.basename(file);
}

function asEntries(spec: RegistrationSpec | null): RegistrationEntries | null {
  if (!spec) return null;
  const out: RegistrationEntries = {
    id: spec.id,
    js: (spec.js ?? []).map((e) => ({ code: e.code ?? '' })),
    world: (spec.world ?? 'USER_SCRIPT') as InjectionWorld,
  };
  if (spec.matches) out.matches = [...spec.matches];
  if (spec.includeGlobs) out.includeGlobs = [...spec.includeGlobs];
  if (spec.excludeGlobs) out.excludeGlobs = [...spec.excludeGlobs];
  return out;
}

// A directory as the `file://` URL the override resolver wants, with
// the trailing slash it keys on.
function dirUrl(dir: string): string {
  const url = pathToFileURL(path.resolve(dir)).toString();
  return url.endsWith('/') ? url : url + '/';
}

// ---------- Matching ----------

export interface MatchExplanation {
  matches: boolean;
  /** Which header line decided, e.g. `@exclude *://example.com/admin*`. */
  rule: string | null;
}

// `urlMatchesScript` says yes or no; a developer wants to know which
// rule answered. Same order as the evaluator: an exclude wins over
// everything, then the first `@match`, then the first `@include`.
export function explainMatch(matching: ScriptMatching, url: string): MatchExplanation {
  for (const ex of matching.excludes) {
    if (includePattern(ex, url)) return { matches: false, rule: `@exclude ${ex}` };
  }
  for (const m of matching.matches) {
    if (matchPattern(m, url)) return { matches: true, rule: `@match ${m}` };
  }
  for (const inc of matching.includes) {
    if (includePattern(inc, url)) return { matches: true, rule: `@include ${inc}` };
  }
  return { matches: false, rule: null };
}

/** The script's `@name`, else the path it was loaded from. */
export function preparedScriptName(script: PreparedScript): string {
  const tags = script.script.header?.tags ?? [];
  const name = tags.find((t) => t.tag === 'name' && !t.locale)?.value;
  return name || script.script.relativePath;
}

/**
 * Whether `name` picks out this script: the path it was loaded from,
 * its basename, or its `@name`. How a test or a typed command names
 * one script among several.
 */
export function preparedScriptMatches(script: PreparedScript, name: string): boolean {
  return script.script.relativePath === name
    || path.basename(script.script.relativePath) === name
    || script.script.header?.tags.some((t) => t.tag === 'name' && !t.locale && t.value === name) === true;
}
