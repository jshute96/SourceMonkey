// The comment sm-dev adds as the last line of a script it installs in
// another manager (Violentmonkey, Tampermonkey), saying where
// it came from, and for a run's script, which run:
//
//   // sm-dev: run=D1 started=2026-10-04T12:00:00.000Z file=/home/me/foo.user.js
//
// In the script's own text, since that's what every manager keeps as
// given, so no manager's internals are relied on. Last, so it moves no
// line numbers. See docs/sm-dev-violentmonkey.md.

/** What the comment says. */
export interface ScriptMark {
  /** A run's script: the run's id (`D1`). */
  run?: string;
  /** A run's script: when the run started, which tells it from an older run with the same id. */
  started?: string;
  /** The file it was installed from. */
  file?: string;
}

const PREFIX = '// sm-dev: ';

/** `text` with `mark` as its last line, in place of any it had. */
export function markedText(text: string, mark: ScriptMark): string {
  const body = withoutMark(text);
  // The file last, since a path can hold spaces.
  const fields = [
    ...(mark.run !== undefined ? [`run=${mark.run}`] : []),
    ...(mark.started !== undefined ? [`started=${mark.started}`] : []),
    ...(mark.file !== undefined ? [`file=${mark.file}`] : []),
  ];
  if (fields.length === 0) return body;
  return `${body}${body.endsWith('\n') || body === '' ? '' : '\n'}${PREFIX}${fields.join(' ')}\n`;
}

// The last line that has anything on it, and where it starts.
function lastLine(text: string): { line: string; start: number } {
  const trimmed = text.replace(/\s+$/, '');
  const start = trimmed.lastIndexOf('\n') + 1;
  return { line: trimmed.slice(start), start };
}

/** What the comment in `text` says, or null when it has none. */
export function readMark(text: string): ScriptMark | null {
  const { line } = lastLine(text);
  if (!line.startsWith(PREFIX)) return null;
  const mark: ScriptMark = {};
  const rest = line.slice(PREFIX.length);
  const file = /(?:^| )file=(.*)$/.exec(rest);
  if (file) mark.file = file[1];
  for (const [, key, value] of (file ? rest.slice(0, file.index) : rest).matchAll(/(\w+)=(\S*)/g)) {
    if (key === 'run') mark.run = value;
    else if (key === 'started') mark.started = value;
  }
  return mark;
}

/** `text` without the comment, as it was before it was added. */
export function withoutMark(text: string): string {
  const { line, start } = lastLine(text);
  return line.startsWith(PREFIX) ? text.slice(0, start) : text;
}

/** Whether two texts are the same script, the comment and trailing white space aside. */
export function sameScript(a: string, b: string): boolean {
  return withoutMark(a).trimEnd() === withoutMark(b).trimEnd();
}
