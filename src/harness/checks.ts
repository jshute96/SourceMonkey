// `match` and `validate`'s shared half: finding the scripts they were
// pointed at (files, directories, or web addresses) and the lines each
// prints per script. The command line runs them on files alone; a run
// also offers its loaded scripts and open tabs (console-commands.ts).
// Both print the same lines, so an answer reads the same either way.

import { stat } from 'node:fs/promises';
import path from 'node:path';

import { isMarkupContentType, looksLikeMarkup, markupResponseMessage } from '../markup-response.js';
import { unusableMatchGroupKey } from '../url-match.js';
import { asError, asWarning, code, heading, id, INVALID_PREFIX, quoted, ui, url, WARNING_LEVEL } from './output-style.js';
import { HAS_SCHEME, globFiles, globMistake, isDirectory, isGlob, walkScripts } from './path-args.js';
import { jsonResult, type MatchPage, type ValidateData } from './json-output.js';
import { NO_RULE_COVERS_URL, explainMatch, isDirectoryMessage, noSuchFileMessage, parseCheckWarning, preparedNoframes, prepareScript, shownPath, warningLines, type PreparedScript } from './prepare.js';

// A mistake in how the command was typed, as opposed to a failure while
// carrying it out: the one kind that exits 2.
export class UsageError extends Error {}

/** Where a script's local `@require` copies are searched for. */
export interface ScriptRoots {
  collectionRoot: string;
  localRoots: string[];
}

// A `start` or `match` argument that names a script rather than a page
// (after expandPathArg: a directory there stands for its scripts).
export const SCRIPT_ARG = /\.user\.js$/i;

// A script named by a web address rather than a path: `validate` and
// `match` fetch it.
export const REMOTE_SCRIPT = /^https?:\/\//i;

// A script to check: read from disk, or already fetched from `url`.
// `label` is how the output names it.
export type ScriptSource = { label: string; file: string } | { label: string; url: string; text: string };

/**
 * `validate`'s arguments as scripts, in the order given: a web address
 * is fetched, a glob expanded, a directory searched for `*.user.js`
 * files.
 */
export async function validateSources(inputs: string[], cwd = process.cwd()): Promise<ScriptSource[]> {
  const sources: ScriptSource[] = [];
  for (const input of inputs) {
    if (REMOTE_SCRIPT.test(input)) {
      sources.push(...await scriptSources([input], cwd));
      continue;
    }
    for (const found of expandPathArg(input, cwd, { scripts: true })) {
      await statInput(found, cwd);
      const file = path.resolve(cwd, found);
      // Outside `cwd`, as the word gave it: a directory's files under
      // the directory as typed.
      sources.push({ label: shownPath(file, cwd, found), file });
    }
  }
  return sources;
}

// The script a command was pointed at, checked up front so a typo is
// reported as one rather than as the file system's `ENOENT` text.
export async function scriptFile(input: string, cwd = process.cwd()): Promise<string> {
  const info = await statInput(input, cwd);
  if (info.isDirectory()) throw new UsageError(isDirectoryMessage(input));
  return path.resolve(cwd, input);
}

function statInput(input: string, cwd: string): ReturnType<typeof stat> {
  return stat(path.resolve(cwd, input)).catch(() => {
    throw new UsageError(noSuchFileMessage(input));
  });
}

/**
 * A word as the paths it stands for, relative when it was: a glob's matches, sorted; with `scripts`, a directory's
 * `*.user.js` files, searched in full. Any other word as it is.
 */
export function expandPathArg(word: string, cwd = process.cwd(), opts: { scripts?: boolean } = {}): string[] {
  // Not the current directory, which an empty word would resolve to.
  if (word === '') return [word];
  if (isGlob(word)) {
    const mistake = globMistake(word);
    if (mistake) throw new UsageError(mistake);
    const found = globFiles(word, cwd);
    if (found.length === 0) throw new UsageError(`No files match ${quoted(word)}`);
    return found;
  }
  if (opts.scripts && !HAS_SCHEME.test(word) && isDirectory(path.resolve(cwd, word))) {
    const found: string[] = [];
    walkScripts(path.resolve(cwd, word), word, found);
    if (found.length === 0) throw new UsageError(`No .user.js files found under ${quoted(word)}`);
    return found;
  }
  return [word];
}

/** Each word expanded, in order, each path once. */
export function expandPathArgs(words: string[], cwd = process.cwd(), opts: { scripts?: boolean } = {}): string[] {
  return [...new Set(words.flatMap((word) => expandPathArg(word, cwd, opts)))];
}

// Local ones checked, remote ones fetched, all up front, so a mistyped
// name or a dead link is reported before any output.
export async function scriptSources(inputs: string[], cwd = process.cwd()): Promise<ScriptSource[]> {
  return Promise.all(inputs.map(async (input): Promise<ScriptSource> => {
    if (!REMOTE_SCRIPT.test(input)) {
      const file = await scriptFile(input, cwd);
      return { label: shownPath(file, cwd, input), file };
    }
    // Its final URL, past any redirect, for relative @requires to resolve against.
    const { url, text } = await fetchScript(input);
    return { label: input, url, text };
  }));
}

// Long enough for a slow server, short enough that a stuck one doesn't
// hold the command for minutes.
const FETCH_TIMEOUT_MS = 30_000;

async function fetchScript(url: string): Promise<{ url: string; text: string }> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    const error = err as Error & { cause?: { code?: string; message?: string } };
    const why = error.name === 'TimeoutError' ? `The server didn't answer within ${FETCH_TIMEOUT_MS / 1000} seconds`
      : error.cause?.code === 'ENOTFOUND' ? 'No such host'
        : error.cause?.code === 'ECONNREFUSED' ? 'The server refused the connection'
          // Node's own message is only "fetch failed"; the cause says why.
          : capitalize(error.cause?.message ?? error.message);
    throw new Error(`Could not fetch ${quoted(url)}: ${why}`);
  }
  if (!response.ok) throw new Error(`Could not fetch ${quoted(url)}: The server answered ${response.status} ${response.statusText}`.trimEnd());
  const text = await response.text();
  // A login page or a forge's page about the file, not the file.
  const contentType = response.headers.get('content-type') ?? '';
  if (isMarkupContentType(contentType) || looksLikeMarkup(text)) {
    throw new Error(`Could not fetch ${quoted(url)}: ${markupResponseMessage(isMarkupContentType(contentType) ? { contentType } : {})}`);
  }
  return { url: response.url || url, text };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function prepareSource(source: ScriptSource, roots: ScriptRoots): Promise<PreparedScript> {
  return 'file' in source
    ? prepareScript({ file: source.file, ...roots })
    // Relative @requires resolve against the script's own URL.
    : prepareScript({ text: source.text, sourceUrl: source.url, ...roots });
}

/**
 * `validate`'s verdict on a script. `unchecked` is valid as far as the
 * checks went, but the syntax check couldn't decide: the script still
 * loads, as it does in the extension, so it doesn't fail the command.
 */
export type ValidateVerdict = 'ok' | 'invalid' | 'unchecked';

/**
 * `validate`'s lines for one script, and its verdict: the verdict and
 * why, then every warning, each with the line it's about.
 */
export function validateLines(label: string, prepared: PreparedScript): { lines: string[]; verdict: ValidateVerdict; error?: string; warnings: string[] } {
  const warnings = warningLines(prepared, { parseCheck: false });
  // A warning's line in color, as when a run loads the script.
  const indented = warnings.map((line) => (line.startsWith(WARNING_LEVEL) ? asWarning(`    ${line}`) : `    ${line}`));
  if (prepared.status !== 'ok') {
    const error = prepared.diagnostic ?? '';
    return { lines: [`${INVALID_PREFIX}${label}`, asError(`    ${error}`), ...indented], verdict: 'invalid', error, warnings };
  }
  if (prepared.parseCheckNote) {
    const error = parseCheckWarning(prepared.parseCheckNote);
    return { lines: [ui`UNCHECKED ${url(label)}`, `    ${error}`, ...indented], verdict: 'unchecked', error, warnings };
  }
  return { lines: [ui`ok       ${url(label)}`, ...indented], verdict: 'ok', warnings };
}

/**
 * `validate` over `sources`: each script's lines, then the counts.
 * Exits 1 when any is invalid.
 */
export async function validateAll(sources: ScriptSource[], roots: ScriptRoots, out: (line: string) => void, json = false): Promise<number> {
  const counts: Record<ValidateVerdict, number> = { ok: 0, invalid: 0, unchecked: 0 };
  const results: ValidateData['results'] = [];
  for (const source of sources) {
    const { lines, verdict, error, warnings } = validateLines(source.label, await prepareSource(source, roots));
    counts[verdict]++;
    if (json) {
      results.push({ script: source.label, verdict, ...(error ? { error } : {}), ...(warnings.length > 0 ? { warnings } : {}) });
    } else {
      for (const line of lines) out(line);
    }
  }
  if (json) {
    out(jsonResult('validate', { results } satisfies ValidateData));
    return counts.invalid === 0 ? 0 : 1;
  }
  out('');
  out(validateSummary(counts));
  return counts.invalid === 0 ? 0 : 1;
}

/** The line after `validate`'s scripts. */
function validateSummary(counts: Record<ValidateVerdict, number>): string {
  return `${counts.ok} ok, ${counts.invalid} invalid${counts.unchecked ? `, ${counts.unchecked} unchecked` : ''}`;
}

// A script stored invalid because its @match rules can never match:
// the answer per URL is still exact (no match). Anything else invalid
// never runs at all, and `validate` says why.
function unmatchableScript(prepared: PreparedScript): boolean {
  return prepared.errorMessage !== undefined && unusableMatchGroupKey(prepared.errorMessage) !== null;
}

/** A page `match` checks: a URL, or a tab's, with its iframes for `--frames`. */
export interface MatchTarget {
  url: string;
  /** The tab's id, shown after the URL. */
  name?: string;
  /** Its iframes, each after its parent (`depth` 1 in the top frame). */
  frames?: { id: string; parent: string; url: string; depth: number }[];
}

// A script's verdict for an iframe: as for a page, but `@noframes`
// keeps it out whatever its rules say.
function frameVerdict(prepared: PreparedScript, url: string): ReturnType<typeof explainMatch> & { noframes: boolean } {
  const verdict = explainMatch(prepared.matching, url);
  const noframes = verdict.matches && preparedNoframes(prepared);
  return { ...verdict, matches: verdict.matches && !noframes, noframes };
}

/**
 * `match`'s verdict for one script against each page, as JSON: what
 * `matchLines` prints.
 */
export function matchJson(prepared: PreparedScript, pages: MatchTarget[]): { valid: boolean; error?: string; pages: MatchPage[] } {
  const error = prepared.status === 'ok' ? {} : { error: prepared.diagnostic ?? prepared.errorMessage ?? '' };
  if (prepared.status !== 'ok' && !unmatchableScript(prepared)) return { valid: false, ...error, pages: [] };
  return {
    valid: prepared.status === 'ok',
    ...error,
    pages: pages.map(({ url, name, frames }) => {
      const verdict = explainMatch(prepared.matching, url);
      return {
        url, ...(name ? { tab: name } : {}), matches: verdict.matches, matchedBy: verdict.matchedBy,
        // Rarely any, so left out when none, as warnings are.
        ...(verdict.excludedBy.length > 0 ? { excludedBy: verdict.excludedBy } : {}),
        ...(frames ? {
          frames: frames.map((frame) => {
            const v = frameVerdict(prepared, frame.url);
            return {
              id: frame.id, parent: frame.parent, url: frame.url, matches: v.matches, matchedBy: v.matchedBy,
              ...(v.excludedBy.length > 0 ? { excludedBy: v.excludedBy } : {}),
              ...(v.noframes ? { noframes: true as const } : {}),
            };
          }),
        } : {}),
      };
    }),
  };
}

/**
 * `match`'s lines for one script against each page, and how many pages
 * it doesn't match (all of them, for a script that can't run at all).
 * `pages` are URLs, each with an optional name (a tab's) shown after
 * it, and its iframes under it, which don't count as misses: a script
 * isn't expected in every frame. `label` names the script where there
 * is no heading to.
 */
export function matchLines(
  prepared: PreparedScript,
  pages: MatchTarget[],
  label?: string,
): { lines: string[]; misses: number } {
  if (prepared.status !== 'ok' && !unmatchableScript(prepared)) {
    return { lines: [label === undefined ? 'INVALID script' : `${INVALID_PREFIX}${label}`], misses: pages.length };
  }
  const lines: string[] = [];
  let misses = 0;
  // Every rule that covers the URL, not only the deciding one, so a
  // miss shows what an @exclude overrode.
  const rulesOf = (verdict: ReturnType<typeof explainMatch>): string[] => {
    const rules = [
      ...verdict.excludedBy.map((rule) => ui`${heading('Excluded by')}: ${code(rule)}`),
      // Padded so its rules line up with the excludes'.
      ...verdict.matchedBy.map((rule) => ui`${heading('Matched by')}:  ${code(rule)}`),
    ];
    if (rules.length === 0) rules.push(NO_RULE_COVERS_URL);
    return rules;
  };
  for (const { url: page, name, frames } of pages) {
    const verdict = explainMatch(prepared.matching, page);
    if (!verdict.matches) misses++;
    lines.push(ui`${verdict.matches ? 'match   ' : 'no match'} ${url(page)}${name ? ui` (${id(name)})` : ''}`, ...rulesOf(verdict).map((r) => `    ${r}`));
    for (const frame of frames ?? []) {
      const v = frameVerdict(prepared, frame.url);
      const pad = '  '.repeat(frame.depth);
      const rules = [...(v.noframes ? [ui`${heading('Kept out by')}: ${code('@noframes')}`] : []), ...rulesOf(v)];
      lines.push(ui`${pad}${v.matches ? 'match   ' : 'no match'} ${id(frame.id)}: ${url(frame.url)}`, ...rules.map((r) => `${pad}    ${r}`));
    }
  }
  return { lines, misses };
}
