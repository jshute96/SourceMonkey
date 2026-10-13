// Styled output lines: sm-dev's text marked up by what each piece is
// (an ID, a URL, a command), shown in color at a terminal that has it
// and as plain text otherwise. Help has its own form (help-format.ts).
//
// The markup is XML-like tags naming roles, not looks: `<id>T1</id>`.
// A line holding markup starts with MARKUP; anything before it is
// plain text, so `'[sm-dev] ' + ui`...`` works, and a
// line without it is plain and passes through untouched. Plain text
// put in markup is escaped (`ui` and the role helpers do it), so a
// script name or page text holding `<` or `&` can't break a line.
//
// sm-dev's own messages need no markup to be told apart: a line
// starting with one of MESSAGE_PREFIXES is an error, a warning or a
// note by that prefix, and its `backticked` spans are commands (see
// `message`). So a run from an older build, sending plain text, still
// shows its errors in color.
//
// A run sends markup only to clients that ask for it; the log file and
// older clients get plain text (`plainLine`). The client paints each
// line for its own terminal (`paintOutput`).

/**
 * Starts a line's markup: a control character and a private-use one, a
 * pair page text won't hold by chance (icon fonts use U+E000 alone),
 * and invisible if it ever leaks.
 */
export const MARKUP = '\u0002\ue000';

/** What a piece of output is. Each has one style, in STYLES. */
export type Role =
  | 'prompt' | 'typed' | 'cmd' | 'code' | 'err' | 'warn'
  | 'h' | 'sel' | 'id' | 'dim' | 'url' | 'name';

type Look = 'bold' | 'dim' | 'italic' | 'underline' | 'red' | 'green' | 'magenta' | 'cyan';

// Each role's look in color. Palette colors, which terminal themes set
// to read on their own background, light or dark.
const STYLES: Record<Role, Look[]> = {
  prompt: ['bold', 'green'],
  typed: ['cyan'],
  cmd: ['cyan'],
  code: ['cyan'],
  err: ['bold', 'red'],
  warn: ['bold', 'magenta'],
  h: ['bold'],
  sel: ['bold'],
  id: ['green'],
  dim: ['dim'],
  url: ['underline'],
  name: ['italic'],
};

// Each look's SGR codes, on and off.
const SGR: Record<Look, [number, number]> = {
  bold: [1, 22], dim: [2, 22], italic: [3, 23], underline: [4, 24],
  red: [31, 39], green: [32, 39], magenta: [35, 39], cyan: [36, 39],
};

const ROLES = new Set(Object.keys(STYLES));

/**
 * A role's SGR codes, on and off, for text painted elsewhere (help's
 * code and headings). Off undoes only that role's looks, so it can
 * nest inside another (code in a bold heading), as long as the two
 * share no look: were `cmd` bold too, its off would end the heading's
 * bold.
 */
export function styleCodes(roleName: Role): [string, string] {
  const looks = STYLES[roleName];
  return [looks.map((look) => `\x1b[${SGR[look][0]}m`).join(''), [...new Set(looks.map((look) => `\x1b[${SGR[look][1]}m`))].join('')];
}

/**
 * Whether a code span keeps its backticks in plain text (help, and sm-dev's messages): one of several
 * words (`--lang zh-CN`), a lowercase word that reads as English (a
 * command, `all`), or punctuation (`{{`). A flag, ID, number, path or
 * name reads as code without them.
 */
export function keepsBackticks(span: string): boolean {
  // Spaces may be held as help-format.ts's KEPT_SPACE (U+0002) while wrapping. A capitalized name
  // (`Shift`, `Method`) or one letter (`N`) reads as code already.
  return /[\s\u0002]/.test(span) || /^[a-z][a-z-]+$/.test(span) || !/[A-Za-z0-9]/.test(span);
}


/** Starts sm-dev's own messages. */
export const SM_DEV_PREFIX = '[sm-dev] ';
/** Starts the client's line for a command given wrongly. */
export const ERROR_PREFIX = 'ERROR: ';
/** Starts a run's line for a command given wrongly (exit code 2). */
export const MISTAKE_PREFIX = `${SM_DEV_PREFIX}${ERROR_PREFIX}`;
/** Starts a warning about the browser. */
export const WARNING_PREFIX = 'Warning: ';
/** Starts a script's warning from preparing it (`warningLines`). */
export const WARNING_LEVEL = 'warn: ';
/** Starts a script's warning from preparing it, as a run prints it. */
export const SCRIPT_WARNING_PREFIX = `${SM_DEV_PREFIX}${WARNING_LEVEL}`;
/** Starts a failed `wait`. */
export const WAIT_FAILED = '[sm-dev] Wait failed: ';
/** Starts `validate`'s line for an invalid script, and a run's. */
export const INVALID_PREFIX = 'INVALID  ';

// sm-dev's own lines, by how they start, and the role of the whole line:
// none for a note.
const MESSAGE_PREFIXES: [string, Role | null][] = [
  [MISTAKE_PREFIX, 'err'], [WAIT_FAILED, 'err'], [SCRIPT_WARNING_PREFIX, 'warn'], [`${SM_DEV_PREFIX}${WARNING_PREFIX}`, 'warn'], [SM_DEV_PREFIX, null],
  [ERROR_PREFIX, 'err'], [INVALID_PREFIX, 'err'], [WARNING_PREFIX, 'warn'],
];

/**
 * Text in backticks, for a message: a command, flag or the user's input
 * (`` Use `tabs` ``). Shown as a command in color, and plain with its
 * backticks where they help it read (see keepsBackticks). Text holding a
 * backtick itself (a selector, say) goes in double ones, as Markdown
 * does: ``` `` a`b `` ```.
 */
export function quoted(text: unknown): string {
  const shown = String(text);
  return shown.includes('`') ? `\`\` ${shown} \`\`` : `\`${shown}\``;
}

// A quoted span: in double backticks (with a space inside each), or in single ones.
const QUOTED_SPAN = /(``\s.*?\s``|`[^`\n]+`)/;

// A quoted span's text, its backticks taken off.
const unquoted = (span: string): string => (span.startsWith('``') ? span.slice(3, -3) : span.slice(1, -1));

/** Text escaped for markup. */
export function escapeMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A line's markup: plain text before MARKUP escaped, markup after it as is.
function markupOf(text: string): string {
  const at = text.indexOf(MARKUP);
  if (at < 0) return escapeMarkup(text);
  return escapeMarkup(text.slice(0, at)) + text.slice(at + MARKUP.length).replaceAll(MARKUP, '');
}

/** A table cell: its text, and the same as markup. Columns line up by the text. */
export interface Cell {
  plain: string;
  styled: string;
}

/** A cell of plain text. */
export const textCell = (text: string): Cell => ({ plain: text, styled: escapeMarkup(text) });

/** A cell in a role: `roleCell(url, 'https://x/')`. */
export const roleCell = (style: (text: string) => string, text: string): Cell => ({ plain: text, styled: style(text) });

/**
 * Rows as lines: columns two spaces apart, each as wide as its widest
 * cell. The last column isn't padded, so no line ends in spaces. As
 * markup, or with `markup: false`, as plain text.
 */
export function tableLines(rows: Cell[][], { markup = true }: { markup?: boolean } = {}): string[] {
  const widths = (rows[0] ?? []).map((_, i) => Math.max(...rows.map((row) => row[i].plain.length)));
  return rows.map((row) => {
    const line = (text: (cell: Cell) => string): string => row.map((cell, i) => text(cell) + (i < row.length - 1 ? ' '.repeat(widths[i] - cell.plain.length) : '')).join('  ').trimEnd();
    return markup ? MARKUP + line((cell) => cell.styled) : line((cell) => cell.plain);
  });
}

/** Text as a role: `role('id', 'T1')`. Text that is markup already stays markup. */
export function role(name: Role, text: string | number): string {
  return `${MARKUP}<${name}>${markupOf(String(text))}</${name}>`;
}

export const id = (text: string | number): string => role('id', text);
export const name = (text: string): string => role('name', text);
export const url = (text: string): string => role('url', text);
export const cmd = (text: string): string => role('cmd', text);
export const code = (text: string): string => role('code', text);
export const heading = (text: string): string => role('h', text);
export const selected = (text: string): string => role('sel', text);
export const dim = (text: string): string => role('dim', text);
/** A message we wrote, as an error: its `backticked` spans are commands (see `message`). */
export const err = (text: string): string => role('err', message(text));
/** A message we wrote, as a warning. */
export const warn = (text: string): string => role('warn', message(text));
/** Text we didn't write (a script's console line, a page's error), as an error, taken as it is. */
export const asError = (text: string): string => role('err', text);
/** Text we didn't write, as a warning. */
export const asWarning = (text: string): string => role('warn', text);

/**
 * A line of markup, from a template: what is put in is escaped, unless
 * it is markup already (from `ui` or a role helper).
 */
export function ui(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = escapeMarkup(strings[0]);
  values.forEach((value, i) => {
    out += markupOf(String(value)) + escapeMarkup(strings[i + 1]);
  });
  return MARKUP + out;
}

/**
 * A message we wrote, as markup: each `backticked` span is a command
 * (`Use `tabs` to list them`), shown in color, or with its backticks
 * where they help it read (see keepsBackticks). Text that is markup
 * already stays as it is.
 */
export function message(text: string): string {
  const at = text.indexOf(MARKUP);
  const plain = at < 0 ? text : text.slice(0, at);
  const marked = plain.split(QUOTED_SPAN).map((part, i) => (i % 2 === 1 ? `<cmd>${escapeMarkup(unquoted(part))}</cmd>` : escapeMarkup(part))).join('');
  return MARKUP + marked + (at < 0 ? '' : text.slice(at + MARKUP.length).replaceAll(MARKUP, ''));
}

// A markup line's pieces: text, and roles opening and closing. Anything
// that is not a known tag or entity is text, so a stray `<` shows as is.
type Piece = { text: string } | { open: Role } | { close: Role };

function pieces(markup: string): Piece[] {
  const out: Piece[] = [];
  for (const m of markup.matchAll(/<(\/?)([a-z]+)>|&(lt|gt|amp);|[^<&]+|[<&]/g)) {
    if (m[2] !== undefined && ROLES.has(m[2])) out.push(m[1] ? { close: m[2] as Role } : { open: m[2] as Role });
    else if (m[3] !== undefined) out.push({ text: { lt: '<', gt: '>', amp: '&' }[m[3]]! });
    else out.push({ text: m[0] });
  }
  return out;
}

// A line as markup, with sm-dev's own messages told by their prefix;
// null for plain text that is none.
function markupLine(line: string): string | null {
  const at = line.indexOf(MARKUP);
  if (at >= 0) {
    const head = line.slice(0, at);
    const rest = line.slice(at + MARKUP.length).replaceAll(MARKUP, '');
    // A prefix before an error or warning (`[sm-dev] ` + err(...)) is part of it.
    const whole = /^<(err|warn)>/.exec(rest);
    return whole ? `<${whole[1]}>${escapeMarkup(head)}${rest.slice(whole[0].length)}` : escapeMarkup(head) + rest;
  }
  const kind = MESSAGE_PREFIXES.find(([prefix]) => line.startsWith(prefix));
  if (!kind) return null;
  const text = message(line).slice(MARKUP.length);
  return kind[1] ? `<${kind[1]}>${text}</${kind[1]}>` : text;
}

/**
 * A line as shown: painted for a terminal with color, or plain. Plain
 * text that is not one of sm-dev's messages is returned as it is.
 */
export function paintOutput(line: string, color: boolean): string {
  const markup = markupLine(line);
  return markup === null ? line : paintMarkup(markup, color);
}

function paintMarkup(markup: string, color: boolean): string {
  const roles: Role[] = [];
  const on = (rs: Role[]): string => rs.flatMap((r) => STYLES[r]).map((look) => `\x1b[${SGR[look][0]}m`).join('');
  let out = '';
  // Plain, a command keeps its backticks where they help it read.
  let cmdText = '';
  for (const piece of pieces(markup)) {
    if ('text' in piece) {
      if (!color && roles.includes('cmd')) cmdText += piece.text;
      else out += piece.text;
    } else if ('open' in piece) {
      roles.push(piece.open);
      if (color) out += on([piece.open]);
    } else {
      const i = roles.lastIndexOf(piece.close);
      if (i >= 0) roles.splice(i, 1);
      if (color) out += `\x1b[0m${on(roles)}`;
      else if (piece.close === 'cmd' && !roles.includes('cmd')) {
        out += keepsBackticks(cmdText) ? quoted(cmdText) : cmdText;
        cmdText = '';
      }
    }
  }
  return out + cmdText + (color && roles.length > 0 ? '\x1b[0m' : '');
}

/**
 * Output that may span lines (a stack trace in one error) as lines that
 * each stand alone, for a reader that paints line by line. A role open
 * at a line break is closed there and opened again on the next line, so
 * every line is markup of its own; without that, the lines after the
 * first would show their tags and escapes as text.
 * - Plain text before the markup stays as it is at the start of its
 *   line, where readers look for a prefix (`[sm-dev] `).
 * - Plain text with no markup is just split: each line is read on its
 *   own, by its own prefix.
 */
export function markupLines(line: string): string[] {
  if (!line.includes('\n')) return [line];
  const at = line.indexOf(MARKUP);
  if (at < 0) return line.split('\n');
  const headLines = line.slice(0, at).split('\n');
  const out = headLines.slice(0, -1);
  const markup = line.slice(at + MARKUP.length).replaceAll(MARKUP, '');
  const open: Role[] = [];
  let current = '';
  let prefix = headLines[headLines.length - 1];
  const reopen = (): string => open.map((r) => `<${r}>`).join('');
  const close = (): string => [...open].reverse().map((r) => `</${r}>`).join('');
  for (const piece of pieces(markup)) {
    if ('open' in piece) {
      open.push(piece.open);
      current += `<${piece.open}>`;
    } else if ('close' in piece) {
      const i = open.lastIndexOf(piece.close);
      if (i >= 0) open.splice(i, 1);
      current += `</${piece.close}>`;
    } else {
      const parts = piece.text.split('\n');
      parts.forEach((part, i) => {
        if (i > 0) {
          out.push(prefix + MARKUP + current + close());
          prefix = '';
          current = reopen();
        }
        current += escapeMarkup(part);
      });
    }
  }
  out.push(prefix + MARKUP + current);
  return out;
}

/** A line as plain text: for the log file, and for clients that didn't ask for markup. */
export function plainLine(line: string): string {
  return paintOutput(line, false);
}

/**
 * Whether output to `stream` is painted: at a terminal that has color.
 * FORCE_COLOR asks for it anyway (or, as 0 or false, not), as Node
 * reads it; NO_COLOR is honored by hasColors.
 */
export function streamHasColor(stream: NodeJS.WriteStream): boolean {
  const forced = process.env.FORCE_COLOR;
  if (forced !== undefined) return forced !== '0' && forced !== 'false';
  return stream.isTTY === true && stream.hasColors();
}

/** A command echoed before its output, as the prompt shows it: `arg > status`. */
export function echoLine(mark: string, text: string): string {
  return `${MARKUP}<prompt>${escapeMarkup(mark)}</prompt> <typed>${escapeMarkup(text)}</typed>`;
}

/** Text painted as one role, for a terminal with color: the prompt and typed commands. */
export function paintAs(roleName: Role, text: string): string {
  if (!text) return text;
  return STYLES[roleName].map((look) => `\x1b[${SGR[look][0]}m`).join('') + text + '\x1b[0m';
}
