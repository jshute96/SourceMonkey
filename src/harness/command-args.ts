// Reading a command's words: its flags, a tab, its arguments, and a
// `{{` block. The one parser for every sm-dev command, sm-dev's own
// (start, stop, ...) and a run's (click, eval, ...), so flags and quotes
// mean the same thing everywhere.
//
// Each command declares its shape in its help entry (`syntax` in
// command-list.ts): what its arguments are, whether a tab can lead,
// whether it takes a block. Its flags, and which take a value, are its
// help's options (`--out FILE` takes one).
//
// - A flag is `--name`, or `--name value` / `--name=value` for one that
//   takes a value. One whose value is optional (`--script[=<script>]`)
//   takes it only as `--name=value`. An unknown flag, a value on one
//   that takes none, and a flag given twice are refused.
// - Flags can go anywhere, a command's free text (eval's JavaScript)
//   included: there, a word of its own shaped like one (`--name`,
//   `--name=...`) is a flag, and an unknown or global one is refused
//   rather than run as code. A `/regex/` starting the text is all text.
// - A quoted word is never a flag, so `'--x'` is an argument.
// - `--help`, where a flag can go, asks for the command's help, as
//   `help <command>` does, rather than running it.
// - Arguments a command doesn't take are refused.

import { commandSyntax, GLOBAL_FLAGS, globalFlagMistake, noSuchFlag, TIMEOUT_FLAG, TIMEOUT_NEEDS_SECONDS, timeoutSecondsMs, type ArgSyntax, type CommandSyntax } from './command-list.js';
import { TAB_ARG } from './tab-refs.js';
import { quoted } from './output-style.js';

/** A word of a line, where it is in the line, and whether it was quoted. */
export interface Word {
  text: string;
  start: number;
  end: number;
  /** Starts with a quote, so it's the word's content, never a flag. */
  quoted: boolean;
}

/**
 * Splits a typed line into words as a shell would: 'single' and
 * "double" quotes group words, a backslash in double quotes escapes the
 * next character. So a selector or text with spaces can be one word.
 * Unlike a shell, quotes that open inside a word stay in it (they still
 * keep its spaces together): they are the selector's own, as in
 * `a[href="x.html"]`, which means something else without them.
 */
export function splitWords(line: string): Word[] {
  const words: Word[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    const start = i;
    let text = '';
    while (i < line.length && !/\s/.test(line[i])) {
      const c = line[i];
      const keep = i > start;
      if (c === '\'') {
        const close = line.indexOf(c, i + 1);
        const stop = close < 0 ? line.length : close;
        text += keep ? line.slice(i, stop + 1) : line.slice(i + 1, stop);
        i = stop + 1;
      } else if (c === '"') {
        // To the next unescaped quote, a backslash escaping what follows.
        const open = i;
        i++;
        while (i < line.length && line[i] !== '"') {
          if (line[i] === '\\' && i + 1 < line.length) i++;
          text += keep ? '' : line[i];
          i++;
        }
        i++;
        if (keep) text += line.slice(open, Math.min(i, line.length));
      } else {
        text += c;
        i++;
      }
    }
    words.push({ text, start, end: i, quoted: line[start] === '\'' || line[start] === '"' });
  }
  return words;
}

/**
 * Text taken whole, as typed, spaces and all, unless it's one quoted
 * span, which is unquoted: 'a b' or "a b" (a backslash escaping in
 * double quotes). `single`: only single quotes, for JSON, whose strings
 * are double-quoted.
 */
export function unquoteWhole(text: string, which: 'any' | 'single' = 'any'): { text: string; quoted: boolean } {
  const trimmed = text.trim();
  const single = /^'([^']*)'$/.exec(trimmed);
  if (single) return { text: single[1], quoted: true };
  const double = which === 'any' ? /^"((?:[^"\\]|\\.)*)"$/.exec(trimmed) : null;
  if (double) return { text: double[1].replace(/\\(.)/g, '$1'), quoted: true };
  return { text: trimmed, quoted: false };
}

/** What a command's words hold, as its syntax reads them. */
export interface ParsedArgs {
  /** Each flag given, by name: its value, or true. */
  flags: Record<string, string | true>;
  /** The tab that led, as written (`T2`, `targetId=...`). */
  tab?: string;
  /** The keyword of the form it took (`wait log`), if any. */
  form?: string;
  /**
   * The word before the form's keyword, for a form that names what it
   * acts on first (`script E4 enable`): absent when it was left out.
   */
  subject?: string;
  /** Its arguments: all of them, or for text, the ones before it. */
  words: string[];
  /** For a text or selector syntax: the rest of the line, as its syntax unquotes it. */
  text?: string;
  /** The lines of a `{{` block, after the command's own. */
  block?: string;
  /** `--help` was given: show the command's help rather than run it. */
  help?: true;
}

export type ParseResult = ParsedArgs | { error: string; flag?: string };

/**
 * A command's words read by its syntax, or what's wrong with them.
 * `line`: the words after the command's name as typed (a block's lines
 * after a line break), split here. `words`: the same as a sender's shell
 * split them, for which quotes are already gone.
 */
export function parseCommandArgs(command: string, input: { line: string } | { words: string[] }): ParseResult {
  const syntax = commandSyntax(command);
  let head: string;
  let block: string | undefined;
  let list: Word[];
  const typed = 'line' in input;
  if (typed) {
    const at = input.line.indexOf('\n');
    head = at < 0 ? input.line : input.line.slice(0, at);
    block = at < 0 ? undefined : input.line.slice(at + 1);
    list = splitWords(head);
  } else {
    head = input.words.join(' ');
    list = input.words.map((text) => ({ text, start: -1, end: -1, quoted: false }));
  }
  const parsed: ParsedArgs = { flags: {}, words: [] };
  if (block !== undefined) {
    if (!syntax.base.block) return { error: `The ${quoted(command)} command takes no {{ block` };
    parsed.block = block;
  }

  // Flags anywhere; the rest are arguments.
  let shape: ArgSyntax = syntax.base;
  const args: Word[] = [];
  // The arguments so far that are the command's own, past a tab, a
  // form's keyword, and the subject before it.
  const ownCount = (): number => args.length - (parsed.tab !== undefined ? 1 : 0) - (parsed.form !== undefined ? 1 : 0)
    - (parsed.subject !== undefined ? 1 : 0);
  // Once the text has started (its first word after the ones before
  // it), only a word shaped like a flag is one, and none in a `/regex/`
  // that starts it: up to word `regexEnd`.
  let inText = false;
  let regexEnd = -1;
  for (let i = 0; i < list.length; i++) {
    const word = list[i];
    // In a command that takes text, only a flag-shaped word (the text's
    // first word could be code); elsewhere any `--` word.
    const flagShaped = shape.args === 'text' ? i > regexEnd && FLAG_WORD.test(word.text) : /^--./.test(word.text);
    if (!word.quoted && flagShaped) {
      if (word.text === '--help') {
        parsed.help = true;
        continue;
      }
      const taken = takeFlag(command, syntax, parsed, list, i);
      if (typeof taken === 'object') return taken;
      i = taken;
      continue;
    }
    // A tab first, before any other argument.
    if (shape.tab && args.length === 0 && parsed.tab === undefined && !word.quoted && TAB_ARG.test(word.text)) {
      parsed.tab = word.text;
      args.push(word);
      continue;
    }
    // The form's keyword, first among the arguments after a tab, or
    // second, after the subject, for a form that names one first.
    if (parsed.form === undefined && !word.quoted && Object.hasOwn(syntax.forms, word.text)
      && (ownCount() === 0 || (ownCount() === 1 && syntax.subjectForms.has(word.text)))) {
      if (ownCount() === 1) parsed.subject = args[args.length - 1].text;
      parsed.form = word.text;
      shape = syntax.forms[word.text];
      args.push(word);
      continue;
    }
    if (shape.args === 'text' && ownCount() >= (shape.before ?? 0) && !inText) {
      inText = true;
      // Text starting with a regex (`wait log /a --b/`): its words are
      // its own, to the first word that closes it. Flags can follow it.
      if (!word.quoted && word.text.startsWith('/')) {
        for (let j = i; j < list.length; j++) {
          const span = typed ? head.slice(word.start, list[j].end) : list.slice(i, j + 1).map((w) => w.text).join(' ');
          if (REGEX_TEXT.test(span)) {
            regexEnd = j;
            break;
          }
        }
      }
    }
    args.push(word);
  }
  const own = args.slice((parsed.tab !== undefined ? 1 : 0) + (parsed.form !== undefined ? 1 : 0) + (parsed.subject !== undefined ? 1 : 0));

  // The verb first and what it acts on after (`script enable E4`), the
  // other way round from how a subject form is written.
  const max = shape.args === 'none' ? 0 : shape.args === 'words' ? shape.max : undefined;
  if (parsed.form !== undefined && parsed.subject === undefined && syntax.subjectForms.has(parsed.form) && max !== undefined && own.length > max) {
    return { error: `Name the ${command} before the verb: ${quoted(`${command} ${own[0].text} ${parsed.form}${own.length > 1 ? ' ...' : ''}`)}` };
  }
  switch (shape.args) {
    case 'none':
      if (own.length > 0) return { error: `The ${quoted(command)} command takes ${shape.tab ? 'nothing besides a tab' : 'no arguments'}` };
      break;
    case 'words':
      if (shape.max !== undefined && own.length > shape.max) {
        const count = COUNTS[shape.max] ?? String(shape.max);
        return { error: `The ${quoted(command)} command takes at most ${count} argument${shape.max === 1 ? '' : 's'}${shape.tab ? ' besides a tab' : ''} (${syntax.usage.join(' | ')})` };
      }
      parsed.words = own.map((w) => w.text);
      break;
    case 'selector': {
      // As typed, less its flags and the words before it: quotes inside
      // a selector are its own (`a[href="x"]`).
      parsed.text = typed ? unquoteWhole(rawOf(head, own, list)).text : own.map((w) => w.text).join(' ');
      break;
    }
    case 'text': {
      const before = shape.before ?? 0;
      parsed.words = own.slice(0, before).map((w) => w.text);
      const rest = own.slice(before);
      let text = typed ? rawOf(head, rest, list) : rest.map((w) => w.text).join(' ');
      if (typed && shape.unquote !== 'none') text = unquoteWhole(text, shape.unquote).text;
      parsed.text = text;
      break;
    }
  }
  return parsed;
}

// The flag at `list[i]`, recorded in `parsed`: the index of its last
// word, or what's wrong.
function takeFlag(command: string, syntax: CommandSyntax, parsed: ParsedArgs, list: Word[], i: number): number | { error: string; flag: string } {
  const text = list[i].text;
  const eq = text.indexOf('=');
  const name = eq > 0 ? text.slice(0, eq) : text;
  const kind = Object.hasOwn(syntax.flags, name) ? syntax.flags[name] : undefined;
  // Any command takes `--timeout-seconds`, unlisted where it waits for
  // nothing (`accept`), so a timeout given out of habit isn't a mistake.
  // Checked, then left out.
  if (!kind && name === TIMEOUT_FLAG) {
    const value = eq > 0 ? text.slice(eq + 1) : list[i + 1]?.text;
    if (value === undefined || timeoutSecondsMs(value) === null) return { error: TIMEOUT_NEEDS_SECONDS, flag: name };
    return eq > 0 ? i : i + 1;
  }
  if (!kind && GLOBAL_FLAGS.includes(name)) return { error: globalFlagMistake(name), flag: name };
  if (!kind) return { error: noSuchFlag(command, name, Object.keys(syntax.flags)), flag: name };
  if (Object.hasOwn(parsed.flags, name)) return { error: `The ${name} flag can be given once`, flag: name };
  if (kind === 'bool' || (kind === 'optional' && eq < 0)) {
    if (eq > 0) return { error: `The ${name} flag takes no value`, flag: name };
    parsed.flags[name] = true;
    return i;
  }
  const what = syntax.values[name];
  const needsValue = {
    error: `The ${quoted(name)} flag needs a value${what ? `: ${quoted(`${name}${kind === 'optional' ? '=' : ' '}${what}`)}` : ''}`,
    flag: name,
  };
  if (eq > 0) {
    // `--out=` gives none.
    if (eq === text.length - 1) return needsValue;
    parsed.flags[name] = text.slice(eq + 1);
    return i;
  }
  const value = list[i + 1];
  // Not the next flag taken for its value; a quoted one can be.
  if (value === undefined || value.text === '' || (!value.quoted && /^--./.test(value.text))) return needsValue;
  parsed.flags[name] = value.text;
  return i + 1;
}

// The typed line from the first of `words` to the last, as typed: its
// quotes and spaces kept, the flags among them taken out.
function rawOf(head: string, words: Word[], all: Word[]): string {
  if (words.length === 0) return '';
  const from = words[0].start;
  const to = words[words.length - 1].end;
  let text = '';
  let at = from;
  for (const word of all) {
    if (word.start < from || word.end > to || words.includes(word)) continue;
    // A flag (or its value) inside the span: left out, with the space
    // before it, so `a --flag b` leaves `a b`.
    text += head.slice(at, word.start).trimEnd();
    at = word.end;
  }
  return (text + head.slice(at, to)).trim();
}

// A word in a command's text that is a flag: `--name`, `--name=...`.
// Code rarely has one (`--i` alone, say); quoting it keeps it text.
const FLAG_WORD = /^--[A-Za-z][\w-]*(?:=[\s\S]*)?$/;

// A regex, `/.../flags`.
const REGEX_TEXT = /^\/.+\/[a-z]*$/;

// How a message says a small count.
const COUNTS = ['no', 'one', 'two', 'three'];
