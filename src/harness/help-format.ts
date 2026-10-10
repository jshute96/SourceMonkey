// Text layout for sm-dev's help, in a markdown-like form: `## headings`,
// `- ` bullets, `code` spans for whatever is typed or shown as is
// (commands, flags, IDs), and **bold** spans.
//
// Lines are laid out with their markup, then painted. In color (a
// terminal that has it), code becomes cyan, and headings and **bold**
// spans bold. Those are palette colors, which terminal themes set to
// read on their own background, light or dark. Plain, bold is dropped,
// and a code span keeps its backticks only where they help it read
// apart from the prose (`keepsBackticks`). A quiet span (`quiet`), for
// a list's terms and usage lines, has none.
//
// Widths are measured as the text will show in the mode it is laid out
// for, so columns line up and lines wrap to fit either way.

// Starts a line of a code block, after its indent: shown as is, all of
// it code.
const CODE_LINE = '\u0001';

// A quiet code span's ends.
const QUIET = '\u0003';
const QUIET_END = '\u0004';

// A space inside a span, kept while wrapping so the span stays on one
// line. (Not a no-break space: \s matches that.)
const KEPT_SPACE = '\u0002';

/** Text as a code span with no backticks in plain help: a list's term, a usage line. */
export const quiet = (text: string): string => QUIET + text + QUIET_END;

// Each span: code first, so `**` in one (a glob) is code, not bold.
const SPAN = new RegExp(`\`([^\`]*)\`|${QUIET}([^${QUIET_END}]*)${QUIET_END}|\\*\\*([^*]+)\\*\\*`, 'g');

/**
 * Whether a code span keeps its backticks in plain help: one of several
 * words (`--lang zh-CN`), a lowercase word that reads as English (a
 * command, `all`), or punctuation (`{{`). A flag, ID, number, path or
 * name reads as code without them.
 */
function keepsBackticks(span: string): boolean {
  // Spaces may be held as KEPT_SPACE while wrapping. A capitalized name
  // (`Shift`, `Method`) or one letter (`N`) reads as code already.
  return /[\s\u0002]/.test(span) || /^[a-z][a-z-]+$/.test(span) || !/[A-Za-z0-9]/.test(span);
}

// Text as it shows, plain or in color, before any color is added.
function shown(text: string): string {
  return text.replace(SPAN, (span, code?: string, quieted?: string, bold?: string) => {
    if (code !== undefined) return color || !keepsBackticks(code) ? code : span;
    return quieted ?? bold ?? '';
  });
}

const CYAN = '\x1b[36m';
const NO_COLOR = '\x1b[39m';
const BOLD = '\x1b[1m';
const NO_BOLD = '\x1b[22m';

// Whether the help being laid out is for color. Set for one rendering
// by `render`.
let color = false;

/** Lays out lines for color or not, then paints them: one string, ending in a newline. */
export function render(inColor: boolean, layout: () => string[]): string {
  const was = color;
  color = inColor;
  try {
    // A blank line once, where pieces laid out apart each bring one, and
    // none at the end.
    const lines = layout().filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== ''));
    while (lines.at(-1) === '') lines.pop();
    return lines.map(paint).join('\n') + '\n';
  } finally {
    color = was;
  }
}

/** How wide text shows. */
export function visibleLength(text: string): number {
  return shown(text).length;
}

/** Text padded with spaces to show `width` wide. */
export function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

function paint(line: string): string {
  const code = line.indexOf(CODE_LINE);
  if (code >= 0) {
    const rest = line.slice(code + 1);
    return line.slice(0, code) + (color && rest ? CYAN + rest + NO_COLOR : rest);
  }
  if (!color) return shown(line);
  const spans = line.replace(SPAN, (_span, code?: string, quieted?: string, bold?: string) => (
    bold !== undefined ? BOLD + bold + NO_BOLD : CYAN + (code ?? quieted) + NO_COLOR
  ));
  return line.startsWith('#') ? BOLD + spans + NO_BOLD : spans;
}

/** Text wrapped to `width`, by the width it shows. A span is never split. */
export function wrap(text: string, width: number): string[] {
  const kept = text.replace(SPAN, (span) => span.replace(/ /g, KEPT_SPACE));
  const lines: string[] = [];
  let line = '';
  for (const word of kept.split(/\s+/).filter(Boolean)) {
    if (line && visibleLength(line) + 1 + visibleLength(word) > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  // No last line of one word: the line above gives it one of its own,
  // where that still fits.
  const last = lines.length - 1;
  if (last > 0 && !lines[last].includes(' ') && lines[last - 1].split(' ').length > 2) {
    const cut = lines[last - 1].lastIndexOf(' ');
    const moved = `${lines[last - 1].slice(cut + 1)} ${lines[last]}`;
    if (visibleLength(moved) <= width) {
      lines[last] = moved;
      lines[last - 1] = lines[last - 1].slice(0, cut);
    }
  }
  return lines.map((l) => l.replaceAll(KEPT_SPACE, ' '));
}

/**
 * A line of text, wrapped to `width`. A bullet (`- `) or numbered item
 * (`1. `), after any spaces of its own, wraps under its text. Any other
 * line starting with spaces is a line of a code block, shown as is, two
 * spaces further in.
 */
export function textLines(text: string, width: number): string[] {
  if (text === '') return [''];
  const item = /^(\s*)(- |\d+\. )/.exec(text);
  if (item) {
    const lead = item[0];
    return wrap(text.slice(lead.length), width - lead.length)
      .map((line, i) => (i === 0 ? lead : ' '.repeat(lead.length)) + line);
  }
  if (text.startsWith(' ')) {
    const code = text.trimStart();
    return [`  ${text.slice(0, text.length - code.length)}${CODE_LINE}${code}`];
  }
  return wrap(text, width);
}
