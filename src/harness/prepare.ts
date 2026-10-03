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
//      extension would register with `chrome.userScripts`, which give
//      the script its id and the line layout its stack frames map by.
//      The extension itself runs the scripts (sm-dev pushes their text);
//      this is for checking them up front and reading them back.
//
// Nothing here touches `chrome.*`. The two globals the pipeline reaches
// for are replaced once per process: `fetch`, which Node doesn't
// implement for `file://` URLs, and the parse checker, which the
// extension installs from a sandboxed page.

import { statSync } from 'node:fs';
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
import { explainUrlMatch, type UrlMatchExplanation } from '../url-match.js';
import { scriptBasename } from '../script-display.js';
import { representativeMatch } from '../match-targets.js';
import { bytesToBase64, sha256Hex } from '../bytes.js';
import type { PushedFile } from '../external-files.js';
import { stackLayout, type StackLayout } from '../composed-source.js';
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
  /**
   * Answers every `fetch` made while preparing (in practice, the
   * `@require` / `@resource` fetches) in place of the network and
   * disk, `file://` included. The corpus validator serves
   * dependencies out of a downloaded tree this way.
   */
  fetch?: (url: string) => Promise<Response>;
}

/**
 * Why the syntax check couldn't reach a verdict. The script stays `ok`
 * (the check fails open, see docs/parse-check.md), so this is a warning:
 *   - `inconclusive`: V8 threw something other than a SyntaxError.
 *   - `errored`: composing the text to check threw.
 */
export interface ParseCheckNote {
  kind: 'inconclusive' | 'errored';
  message: string;
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
  /** Set when the syntax check couldn't decide; the script stays `ok`. */
  parseCheckNote?: ParseCheckNote;
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
  /**
   * How the injected entry's lines map back to the script and its
   * `@require`s, for rewriting stack traces (`remapStackText`). No
   * segments when nothing moved: no `@require`s, or an invalid script.
   */
  stackLayout: StackLayout;
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

// Per-call state the seams read. Safe as module state only because
// `prepareScript` serializes calls.
let fetchOverride: PrepareOptions['fetch'] | undefined;
let parseCheckNote: ParseCheckNote | undefined;

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
    if (fetchOverride) return fetchOverride(url);
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
  //
  // The pipeline swallows a check that couldn't decide (it fails
  // open), so the note is kept here for `validate` to show.
  setParseChecker(async (script) => {
    let checked;
    try {
      checked = buildParseCheckSource(script);
    } catch (err) {
      parseCheckNote = { kind: 'errored', message: String((err as Error)?.message ?? err) };
      throw err;
    }
    const verdict = attachParseLocation(checkParseNode(checked.text), checked);
    if (verdict?.status === 'unknown') parseCheckNote = { kind: 'inconclusive', message: verdict.message ?? '' };
    return verdict;
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
  const run = chain.then(async () => {
    fetchOverride = opts.fetch;
    parseCheckNote = undefined;
    try {
      return await prepareScriptNow(opts);
    } finally {
      fetchOverride = undefined;
    }
  });
  chain = run.catch(() => undefined);
  return run;
}

async function prepareScriptNow(opts: PrepareOptions): Promise<PreparedScript> {
  installNodeSeams();
  if (!opts.file && opts.text === undefined) {
    throw new Error('Pass prepareScript a file or text');
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
    ? asEntries(await buildRegistrationSpec(script, handlerVersion, logLabel))
    : null;

  const out: PreparedScript = {
    script,
    status: script.status,
    startupLogs: script.startupLogs ?? [],
    ...(parseCheckNote && { parseCheckNote }),
    spec,
    world: resolveScriptWorld(script),
    runAt: normalizeDeclaredRunAt(script.header ? getValue(script.header, 'run-at') : undefined) as RunAt,
    matching: script.matching,
    noframes: script.header ? hasTag(script.header, 'noframes') : false,
    needsGmRuntime: needsGmRuntime(script.header),
    grantedSubsystems: grantedSubsystems(script.header),
    requires: (script.requires ?? []).map((r) => ({ url: r.url, localUrl: r.localUrl })),
    stackLayout: spec ? stackLayout(script, logLabel) : { entryUrl: '', segments: [], lineCount: 0 },
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
// it, so sm-dev's output reads the same as the extension's Log tab.
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

/** What a `ParseCheckNote` means for the person reading it. */
export function parseCheckWarning(note: ParseCheckNote): string {
  const why = note.message ? ` (${note.message})` : '';
  return `The syntax check could not finish${why}, so syntax errors were not checked. The script still loads.`;
}

/**
 * Every warning from preparing the script, as `<level>: <message>`
 * with the line each is about: the load-time notes the viewer's Log
 * tab shows, then (unless `parseCheck` is false) a syntax check that
 * couldn't decide.
 */
export function warningLines(prepared: PreparedScript, { parseCheck = true } = {}): string[] {
  const lines = prepared.startupLogs.map((l) => `${l.level}: ${describeDiagnostic(l.message, l.location)}`);
  if (parseCheck && prepared.parseCheckNote) lines.push(`warn: ${parseCheckWarning(prepared.parseCheckNote)}`);
  return lines;
}

// ---------- Matching ----------

export type MatchExplanation = UrlMatchExplanation;

/** The reason to give when no header rule names a URL at all. */
export const NO_RULE_COVERS_URL = 'No @match or @include covers this URL';

/**
 * Whether the script runs on `url`, and which header rule decided: an
 * exclude wins over everything, then the first `@match`, then the
 * first `@include`. Also every rule that matched or excluded it
 * (`matchedBy`, `excludedBy`). The extension's own matcher, so the
 * answer is the one the extension would give.
 */
export function explainMatch(matching: ScriptMatching, url: string): MatchExplanation {
  return explainUrlMatch(url, matching);
}

/** A script path that names nothing, for `start` and the typed `load`. */
export function noSuchFileMessage(input: string): string {
  return `No such file or directory: ${input}`;
}

/** A script path that names a directory, for `start` and the typed `load`. */
export function isDirectoryMessage(input: string, remedy = 'Name a .user.js file.'): string {
  return `${input} is a directory. ${remedy}`;
}

/** Why a script has no default page, as `--all` and `newtab all` report it. */
export const NO_DEFAULT_PAGE = 'Its @match names no page to open';

/**
 * The page a script is opened on when no URL is given: the first one
 * its `@match` implies. Null when none names a page, as with a
 * match-everything pattern.
 */
export function defaultPageUrl(script: PreparedScript): string | null {
  return representativeMatch(script.matching)?.linkUrl ?? null;
}

/**
 * A typed URL with `http://` added when it has no scheme, so
 * `example.com/x` works. Only a word that starts with a host reads so:
 * one with a dot, `localhost`, a port (`localhost:8080/x`) or an IPv6
 * address (`[::1]/x`). Any other is a path, made a `file://` URL: one
 * starting `/` or `.`, one naming a file that exists in `cwd`, or one
 * whose first part has no dot (`pages/x.html`), existing or not. `host:port` would
 * otherwise read as a scheme, so only a scheme followed by `//`, or one
 * of the kinds that never have it, counts.
 */
export function withDefaultScheme(url: string, cwd = process.cwd()): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  if (/^(about|blob|data|file|javascript|mailto|view-source):/i.test(url)) return url;
  if (/^[./]/.test(url) || isLocalPath(url, cwd)) return pathToFileURL(path.resolve(cwd, url)).toString();
  return `http://${url}`;
}

// A scheme-less word that is a file in `cwd`, or doesn't start with a
// host. A web address's host has a dot, except `localhost`; and a
// directory is rarely named with one, so a first part with a dot reads
// as a host even when a repo has a folder by that name (`example.com/`).
function isLocalPath(input: string, cwd: string): boolean {
  try {
    if (statSync(path.resolve(cwd, input)).isFile()) return true;
  } catch {
    // Not a file here; the first part decides.
  }
  const first = input.split('/')[0];
  return !(first.includes('.') || /^localhost$/i.test(first) || /:\d+$/.test(first) || first.startsWith('['));
}

/**
 * A path to show: relative to `cwd` when it's inside it, else
 * `outside` (by default the full path). Never one climbing out with
 * `../`, which is harder to read than either.
 */
export function shownPath(file: string, cwd = process.cwd(), outside = file): string {
  const relative = path.relative(cwd, file);
  const inside = relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  return inside ? relative : outside;
}

/**
 * Where a loaded script is, to show beside its name (`shownPath`).
 * Its `relativePath` stays what identifies it, as in the extension.
 */
export function preparedScriptPath(script: PreparedScript): string {
  const url = script.script.fileUrl;
  return url.startsWith('file:') ? shownPath(fileURLToPath(url)) : script.script.relativePath;
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

/**
 * The `@require` / `@resource` bodies a run pushes into SourceMonkey with
 * the script's text, by the ref its header declares: those read from
 * disk, a relative ref's file or a local stand-in for a remote URL,
 * which the extension couldn't read itself. Remote ones it fetches.
 */
export function pushedFiles(prepared: PreparedScript): Record<string, PushedFile> {
  const out: Record<string, PushedFile> = {};
  const add = (ref: string, file: { url: string; localUrl?: string; contentType?: string }, bytesBase64: string): void => {
    if (!file.localUrl && !file.url.startsWith('file:')) return;
    out[ref] = { url: file.url, ...(file.localUrl ? { localUrl: file.localUrl } : {}), bytesBase64, contentType: file.contentType ?? '' };
  };
  for (const r of prepared.script.requires ?? []) add(r.ref, r, bytesToBase64(new TextEncoder().encode(r.source)));
  for (const r of prepared.script.resources ?? []) add(r.ref, r, r.bytesBase64);
  return out;
}
