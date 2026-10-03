// Multi-line editing for the `--interactive` prompt. readline edits one
// line, but a `{{` block is several: here the whole block is one buffer
// holding newlines, typed and edited in place, and sent once complete.
//
// - Enter inserts a newline while the buffer holds an unclosed block,
//   and sends it otherwise. Alt-Enter always inserts one.
// - Lines after the first are drawn after `... `.
// - A buffer taller than the terminal is drawn as a window of rows
//   around the cursor, scrolled as it moves, and drawn whole once sent.
// - Up and Down move between the buffer's lines, and step through the
//   history from its first and last line. Once they have brought back
//   an entry, they step whole entries until another key is pressed, so
//   a block is passed over in one step. Ctrl-P / Ctrl-N always do.
// - Home / End and Ctrl-A / Ctrl-E go to the start and end of the line,
//   Ctrl-U and Ctrl-K delete to them (Ctrl-Y brings it back).
// - Esc clears the buffer, as Ctrl-C does.
//
// readline has no hooks for this. It calls these methods through the
// instance (`_ttyWrite` for each key, `_refreshLine` to redraw,
// `getCursorPos` for where the cursor is drawn), so they are replaced
// on it. Its undo and kill ring are only reachable by symbol. All are
// internal, kept by Node for compatibility; checked on Node 22.

import readline from 'node:readline';

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

// The parts of readline's Interface used here that its types don't list.
interface Internals {
  line: string;
  cursor: number;
  history: string[];
  prevRows?: number;
  columns: number;
  tabSize: number;
  isCompletionEnabled: boolean;
  output: NodeJS.WriteStream;
  crlfDelay: number;
  _ttyWrite(s: string | undefined, key: Key | undefined): void;
  _refreshLine(): void;
  _writeToOutput(text: string): void;
  _getDisplayPos(text: string): { rows: number; cols: number };
  getCursorPos(): { rows: number; cols: number };
  getPrompt(): string;
}

export interface PromptEditor {
  /** Empties the buffer, as Ctrl-C and Esc do. */
  clear(): void;
}

/**
 * Makes `rl` edit several lines as one buffer. `complete` says whether
 * a buffer is ready to send, rather than inside an unclosed block.
 * `cleared` gets the text of a buffer emptied by `clear`.
 */
export function editMultiLine(
  rl: readline.Interface,
  continuation: string,
  complete: (text: string) => boolean,
  cleared?: (text: string) => void,
): PromptEditor {
  const r = rl as unknown as Internals;
  const ttyWrite = r._ttyWrite.bind(r);
  const beforeEdit = internal(r, '_beforeEdit');
  const pushToKillRing = internal(r, '_pushToKillRing');
  const shown = (text: string): string => text.replaceAll('\n', '\n' + continuation);

  // Screen columns, by readline's own measure of one character.
  const widths = new Map<string, number>();
  const charWidth = (ch: string, col: number): number => {
    if (ch === '\t') return r.tabSize - (col % r.tabSize);
    let width = widths.get(ch);
    if (width === undefined) widths.set(ch, (width = r._getDisplayPos(ch).cols));
    return width;
  };
  const textWidth = (text: string): number => {
    let width = 0;
    for (const ch of text) width += charWidth(ch, width);
    return width;
  };

  // The screen rows `text` takes from column 0, as the terminal wraps
  // it, and the row and column just after it. A full row is followed by
  // an empty one, where the cursor goes, as readline counts it. A wide
  // character that doesn't fit at a row's end starts the next row.
  const layout = (text: string): { rows: string[]; row: number; col: number } => {
    const width = r.columns;
    const rows = [''];
    let col = 0;
    for (const ch of text) {
      if (ch === '\n') {
        rows.push('');
        col = 0;
        continue;
      }
      const w = charWidth(ch, col);
      if (col + w > width) {
        rows.push('');
        col = 0;
      }
      rows[rows.length - 1] += ch;
      col += w;
      if (col >= width) {
        rows.push('');
        col = 0;
      }
    }
    return { rows, row: rows.length - 1, col };
  };

  // The first buffer row drawn, when it is taller than the terminal.
  let top = 0;
  // Set while a sent buffer is drawn whole.
  let whole = false;
  const cursorAt = () => layout(r.getPrompt() + shown(r.line.slice(0, r.cursor)));

  // Rows count from the top row drawn, as readline and writeOutputLine
  // take them.
  r.getCursorPos = () => {
    const at = cursorAt();
    return { rows: at.row - top, cols: at.col };
  };
  // readline's own redraw, of the shown text and only the rows that fit.
  r._refreshLine = () => {
    const all = layout(r.getPrompt() + shown(r.line));
    const at = cursorAt();
    // One row spare, so the window never scrolls the terminal itself.
    const height = whole ? Infinity : Math.max(1, (r.output.rows || 24) - 1);
    if (all.rows.length <= height) top = 0;
    else {
      if (at.row < top) top = at.row;
      if (at.row >= top + height) top = at.row - height + 1;
      top = Math.min(top, all.rows.length - height);
    }
    const rows = all.rows.slice(top, top + height);
    const out = r.output;
    if (r.prevRows) readline.moveCursor(out, 0, -r.prevRows);
    readline.cursorTo(out, 0);
    readline.clearScreenDown(out);
    // Rows are ended here rather than wrapped by the terminal, so where
    // each starts doesn't depend on how the terminal wraps.
    r._writeToOutput(rows.join('\r\n'));
    readline.cursorTo(out, at.col);
    const below = rows.length - 1 - (at.row - top);
    if (below > 0) readline.moveCursor(out, 0, -below);
    r.prevRows = at.row - top;
  };

  const set = (text: string, cursor = text.length): void => {
    r.line = text;
    r.cursor = cursor;
    r._refreshLine();
  };
  // A change readline's undo (Ctrl-_) can take back, and deleted text
  // its Ctrl-Y can bring back, as with its own edits.
  const edit = (text: string, cursor: number, deleted?: string): void => {
    beforeEdit(r.line, r.cursor);
    if (deleted) pushToKillRing(deleted);
    set(text, cursor);
  };
  const insert = (text: string): void => edit(r.line.slice(0, r.cursor) + text + r.line.slice(r.cursor), r.cursor + text.length);
  // The start and end of the line holding `at` in the buffer.
  const lineStart = (at = r.cursor): number => (at === 0 ? 0 : r.line.lastIndexOf('\n', at - 1) + 1);
  const lineEnd = (at = r.cursor): number => {
    const i = r.line.indexOf('\n', at);
    return i < 0 ? r.line.length : i;
  };
  // The prompt's width before the line starting at `start`.
  const promptWidth = (start: number): number => textWidth(start === 0 ? r.getPrompt() : continuation);

  // Up or Down a line, keeping the cursor's column on screen, and
  // between characters. False when there is no line that way.
  const moveLine = (up: boolean): boolean => {
    const start = lineStart();
    if (up ? start === 0 : lineEnd() === r.line.length) return false;
    // Measured with the prompt, as tabs stop at screen columns.
    const column = textWidth((start === 0 ? r.getPrompt() : continuation) + r.line.slice(start, r.cursor));
    const target = up ? lineStart(start - 1) : lineEnd() + 1;
    let at = target;
    let col = promptWidth(target);
    for (const ch of r.line.slice(target, lineEnd(target))) {
      const w = charWidth(ch, col);
      if (col + w > column) break;
      col += w;
      at += ch.length;
    }
    set(r.line, at);
    return true;
  };

  // The history, browsed here rather than by readline, which would
  // replace a buffer with the text before the cursor when no older
  // entry starts with it, and can't give back what was being typed.
  // `index` is the entry shown, -1 for what was being typed (`draft`).
  // Any other key makes the buffer, edited or not, the draft again. As
  // readline does, a one-line draft only finds entries starting with
  // its text before the cursor.
  let index = -1;
  let draft = '';
  let prefix = '';
  // Up / Down last brought back an entry, or the draft, and no other
  // key since.
  let browsing = false;
  const browse = (older: boolean): void => {
    const entries = r.history;
    if (index === -1) {
      if (!older) return;
      draft = r.line;
      prefix = draft.includes('\n') ? '' : draft.slice(0, r.cursor);
    }
    for (let i = index + (older ? 1 : -1); older ? i < entries.length : i >= 0; i += older ? 1 : -1) {
      if (entries[i].startsWith(prefix) && entries[i] !== r.line) {
        index = i;
        browsing = true;
        edit(entries[i], entries[i].length);
        return;
      }
    }
    if (!older) {
      index = -1;
      browsing = true;
      edit(draft, draft.length);
    }
  };

  function clear(): void {
    if (r.line) cleared?.(r.line);
    index = -1;
    browsing = false;
    edit('', 0);
  }

  // When the last key was Enter, for the \n of a \r\n pair.
  let returnAt = 0;
  // Pasted text put in the buffer but not yet drawn.
  let undrawn = false;
  r._ttyWrite = (s, key) => {
    const name = key?.name;
    if (name === 'enter' && returnAt && Date.now() - returnAt <= r.crlfDelay) {
      returnAt = 0;
      return;
    }
    returnAt = name === 'return' ? Date.now() : 0;
    const enter = name === 'return' || name === 'enter';
    // Shift is let through: readline's own Shift-Up would browse the
    // history its way.
    const plain = !key?.ctrl && !key?.meta;
    const arrow = (name === 'up' || name === 'down') && plain;
    const historyKey = arrow || (key?.ctrl && !key.meta && (name === 'p' || name === 'n'));
    if (!historyKey) {
      browsing = false;
      index = -1;
    }

    // readline turns `isCompletionEnabled` off for all but the last key
    // of pasted text, and then writes each character straight out with
    // no redraw, even when the line wraps, so its record of the rows
    // drawn (`prevRows`) goes stale. So pasted text, and the newlines
    // within a block, go in the buffer here, drawn once at the end.
    const typed = typeof s === 'string' && s !== '' && !/[\x00-\x08\x0a-\x1f\x7f]/.test(s) && plain;
    if (!r.isCompletionEnabled && (typed || (enter && plain && !complete(r.line)))) {
      if (!undrawn) beforeEdit(r.line, r.cursor);
      const text = enter ? '\n' : (s as string);
      r.line = r.line.slice(0, r.cursor) + text + r.line.slice(r.cursor);
      r.cursor += text.length;
      undrawn = true;
      return;
    }
    if (undrawn) {
      undrawn = false;
      r._refreshLine();
    }

    if (enter) {
      if (key?.meta || !complete(r.line)) {
        insert('\n');
        return;
      }
      // Drawn whole, cursor at the end, so the terminal's scrollback
      // keeps all of what was sent.
      whole = true;
      r.cursor = r.line.length;
      r._refreshLine();
      ttyWrite(s, key);
      whole = false;
      top = 0;
      return;
    }
    if (arrow) {
      if (browsing || !moveLine(name === 'up')) browse(name === 'up');
      return;
    }
    if (historyKey) {
      browse(name === 'p');
      return;
    }
    if (name === 'escape') {
      clear();
      return;
    }
    if ((name === 'home' && plain) || (key?.ctrl && name === 'a')) {
      set(r.line, lineStart());
      return;
    }
    if ((name === 'end' && plain) || (key?.ctrl && name === 'e')) {
      set(r.line, lineEnd());
      return;
    }
    if (key?.ctrl && name === 'u') {
      const start = lineStart();
      edit(r.line.slice(0, start) + r.line.slice(r.cursor), start, r.line.slice(start, r.cursor));
      return;
    }
    // At a line's end, Ctrl-K joins the next line onto it, as in Emacs.
    if (key?.ctrl && name === 'k') {
      const end = r.cursor === lineEnd() && r.cursor < r.line.length ? r.cursor + 1 : lineEnd();
      edit(r.line.slice(0, r.cursor) + r.line.slice(end), r.cursor, r.line.slice(r.cursor, end));
      return;
    }
    ttyWrite(s, key);
  };

  return { clear };
}

// A readline method kept under a symbol, found by its name, or one that
// does nothing should a Node version not have it.
function internal(rl: object, name: string): (...args: unknown[]) => void {
  for (let proto = Object.getPrototypeOf(rl); proto; proto = Object.getPrototypeOf(proto)) {
    const symbol = Object.getOwnPropertySymbols(proto).find((s) => s.description === name);
    if (symbol) return (...args) => (rl as Record<symbol, (...a: unknown[]) => void>)[symbol](...args);
  }
  return () => undefined;
}
