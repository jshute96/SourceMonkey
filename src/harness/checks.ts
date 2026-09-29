// `match` and `validate`'s shared half: finding the scripts they were
// pointed at (files, directories, or web addresses) and the lines each
// prints per script. The command line runs them on files alone; a run
// also offers its loaded scripts and open tabs (console-commands.ts).
// Both print the same lines, so an answer reads the same either way.

import { stat } from 'node:fs/promises';
import path from 'node:path';

import { isMarkupContentType, looksLikeMarkup, markupResponseMessage } from '../markup-response.js';
import { unusableMatchGroupKey } from '../url-match.js';
import { HAS_SCHEME, globFiles, globMistake, isDirectory, isGlob, walkScripts } from './path-args.js';
import { NO_RULE_COVERS_URL, explainMatch, isDirectoryMessage, noSuchFileMessage, parseCheckWarning, prepareScript, shownPath, warningLines, type PreparedScript } from './prepare.js';

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
    if (found.length === 0) throw new UsageError(`No files match ${word}`);
    return found;
  }
  if (opts.scripts && !HAS_SCHEME.test(word) && isDirectory(path.resolve(cwd, word))) {
    const found: string[] = [];
    walkScripts(path.resolve(cwd, word), word, found);
    if (found.length === 0) throw new UsageError(`No .user.js files found under ${word}`);
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
    throw new Error(`Could not fetch ${url}: ${why}`);
  }
  if (!response.ok) throw new Error(`Could not fetch ${url}: The server answered ${response.status} ${response.statusText}`.trimEnd());
  const text = await response.text();
  // A login page or a forge's page about the file, not the file.
  const contentType = response.headers.get('content-type') ?? '';
  if (isMarkupContentType(contentType) || looksLikeMarkup(text)) {
    throw new Error(`Could not fetch ${url}: ${markupResponseMessage(isMarkupContentType(contentType) ? { contentType } : {})}`);
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
export function validateLines(label: string, prepared: PreparedScript): { lines: string[]; verdict: ValidateVerdict } {
  const warnings = warningLines(prepared, { parseCheck: false }).map((line) => `    ${line}`);
  if (prepared.status !== 'ok') {
    return { lines: [`INVALID  ${label}`, `    ${prepared.diagnostic}`, ...warnings], verdict: 'invalid' };
  }
  if (prepared.parseCheckNote) {
    return { lines: [`UNCHECKED ${label}`, `    ${parseCheckWarning(prepared.parseCheckNote)}`, ...warnings], verdict: 'unchecked' };
  }
  return { lines: [`ok       ${label}`, ...warnings], verdict: 'ok' };
}

/**
 * `validate` over `sources`: each script's lines, then the counts.
 * Exits 1 when any is invalid.
 */
export async function validateAll(sources: ScriptSource[], roots: ScriptRoots, out: (line: string) => void): Promise<number> {
  const counts: Record<ValidateVerdict, number> = { ok: 0, invalid: 0, unchecked: 0 };
  for (const source of sources) {
    const { lines, verdict } = validateLines(source.label, await prepareSource(source, roots));
    counts[verdict]++;
    for (const line of lines) out(line);
  }
  out('');
  out(validateSummary(counts));
  return counts.invalid === 0 ? 0 : 1;
}

/** The line after `validate`'s scripts. */
function validateSummary(counts: Record<ValidateVerdict, number>): string {
  return `${counts.ok} ok, ${counts.invalid} invalid${counts.unchecked ? `, ${counts.unchecked} unchecked` : ''}`;
}

/**
 * `match`'s lines for one script against each page, and how many pages
 * it doesn't match (all of them, for a script that can't run at all).
 * `pages` are URLs, each with an optional name (a tab's) shown after
 * it. `label` names the script where there is no heading to.
 */
export function matchLines(
  prepared: PreparedScript,
  pages: { url: string; name?: string }[],
  label?: string,
): { lines: string[]; misses: number } {
  // A script whose @match rules can never match is stored invalid,
  // but the answer per URL is still exact: no match. Anything else
  // invalid never runs at all; `validate` says why.
  const unmatchable = prepared.errorMessage !== undefined && unusableMatchGroupKey(prepared.errorMessage) !== null;
  if (prepared.status !== 'ok' && !unmatchable) {
    return { lines: [label === undefined ? 'INVALID script' : `INVALID  ${label}`], misses: pages.length };
  }
  const lines: string[] = [];
  let misses = 0;
  for (const { url, name } of pages) {
    const verdict = explainMatch(prepared.matching, url);
    if (!verdict.matches) misses++;
    // Every rule that covers the URL, not only the deciding one, so a
    // miss shows what an @exclude overrode.
    const rules = [
      ...verdict.excludedBy.map((rule) => `Excluded by: ${rule}`),
      // Padded so its rules line up with the excludes'.
      ...verdict.matchedBy.map((rule) => `Matched by:  ${rule}`),
    ];
    if (rules.length === 0) rules.push(NO_RULE_COVERS_URL);
    lines.push(`${verdict.matches ? 'match   ' : 'no match'} ${url}${name ? ` (${name})` : ''}`, ...rules.map((r) => `    ${r}`));
  }
  return { lines, misses };
}
