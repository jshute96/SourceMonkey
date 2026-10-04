// A run's log: every line the page, the scripts, SourceMonkey and the
// run's events produce, each tagged with its source, kept run-wide for
// `logs` and `wait log`, and streamed to the clients that asked for its
// source. See docs/sm-dev-logs.md.
//
// Node built-ins only: runs.ts (which the sm-dev client loads) takes
// the sources from here.

/**
 * Where a line came from, from narrowest to broadest:
 * - `sm`: SourceMonkey logs: the run's scripts' Log tab entries.
 * - `event`: script and tab events sm-dev saw: starts, page loads,
 *   errors, menu commands, dialog boxes, tabs opened.
 * - `script`: Chrome console logs that came from the run's scripts.
 * - `page`: full Chrome console logs, the scripts' included.
 */
export type LogSource = 'sm' | 'event' | 'script' | 'page';

export const LOG_SOURCES: readonly LogSource[] = ['sm', 'event', 'script', 'page'];

/** What the stream and `logs` show unless told otherwise: all but `page`. */
export const DEFAULT_LOG_SOURCES: ReadonlySet<LogSource> = new Set(['sm', 'event', 'script']);

export const ALL_LOG_SOURCES: ReadonlySet<LogSource> = new Set(LOG_SOURCES);

/** Whether a line belongs to any of `sources`. */
export function inSources(record: LogFields, sources: ReadonlySet<LogSource>): boolean {
  return sources.has(record.source) || (record.also ?? []).some((s) => sources.has(s));
}

/** A `--log-source` value: a source, several separated by commas, or `all`. */
export function parseLogSources(text: string): ReadonlySet<LogSource> | { error: string } {
  const words = text.split(',').map((w) => w.trim()).filter(Boolean);
  if (words.length === 1 && words[0] === 'all') return ALL_LOG_SOURCES;
  const wrong = words.find((w) => !LOG_SOURCES.includes(w as LogSource));
  if (words.length === 0 || wrong !== undefined) {
    return { error: `The --log-source flag takes ${LOG_SOURCES.join(', ')} or all, or several separated by commas${wrong !== undefined ? `, not ${wrong}` : ''}` };
  }
  return new Set(words as LogSource[]);
}

/** A line as it's logged, before it has an ID. */
export interface LogFields {
  /** The source its prefix names. */
  source: LogSource;
  /**
   * Other sources it belongs to, so asking for any one of them shows it:
   * a script's throw is an event, a Log entry, and the script's own.
   */
  also?: LogSource[];
  /** The console type (`log`, `warning`, ...), the Log entry's level, or the event's name. */
  kind: string;
  /** The tab it came from (`T<n>`'s n); none for a Log entry made outside a tab. */
  tab?: number;
  /** The run's script it's about (`PreparedScript.id`), when known. */
  scriptId?: string;
  /** The line after its prefix. Can run over several lines (a stack). */
  text: string;
  /** False for a line only `logs` and `wait log` see: a page load, which the stream says its own way. */
  streamed?: boolean;
  /** Streamed whatever sources were asked for: a dialog box, which holds up the page until answered. */
  always?: boolean;
}

/** A logged line. */
export interface LogRecord extends LogFields {
  /** Its log ID: when it arrived, in microseconds since the epoch, unique and increasing. */
  id: number;
}

// How many lines a run keeps, oldest dropped first, and how long each
// can be.
const KEPT_LINES = 5000;
const LINE_CHARS = 2000;

/**
 * Now, in microseconds since the epoch. By the wall clock, which
 * `--since` times are read by; `performance`'s drifts from it after a
 * sleep. RunLog keeps IDs increasing if the clock steps back.
 */
export function nowMicros(): number {
  return Date.now() * 1000;
}

// `text`'s first `chars` UTF-16 units, one fewer rather than half an
// emoji.
function cutAt(text: string, chars: number): string {
  const code = text.charCodeAt(chars - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? chars - 1 : chars);
}

/** A run's log lines, for `logs` and `wait log`, and a way to hear new ones. */
export class RunLog {
  private readonly records: LogRecord[] = [];
  private lastId = 0;
  // The newest line dropped for space, if any.
  private droppedUpTo = 0;
  private readonly watchers = new Set<(record: LogRecord) => void>();

  /** Logs a line: its ID given, its text cut past a length. */
  add(fields: LogFields): LogRecord {
    this.lastId = Math.max(nowMicros(), this.lastId + 1);
    const text = fields.text.length > LINE_CHARS ? `${cutAt(fields.text, LINE_CHARS)}…` : fields.text;
    const record: LogRecord = { ...fields, text, id: this.lastId };
    this.records.push(record);
    if (this.records.length > KEPT_LINES) this.droppedUpTo = this.records.shift()!.id;
    for (const watcher of [...this.watchers]) watcher(record);
    return record;
  }

  /** The lines kept, oldest first. */
  all(): readonly LogRecord[] {
    return this.records;
  }

  /** The lines after `id`, oldest first. */
  since(id: number): LogRecord[] {
    // From the end: usually only the last few are wanted.
    let i = this.records.length;
    while (i > 0 && this.records[i - 1].id > id) i--;
    return this.records.slice(i);
  }

  /**
   * The position reached: the newest line's ID, or now when there's
   * none yet. Any line after it gets a higher ID.
   */
  position(): number {
    if (this.lastId === 0) this.lastId = nowMicros();
    return this.lastId;
  }

  /** When lines after `id` were dropped for space: the oldest kept line's ID. */
  lostAfter(id: number): number | undefined {
    return id < this.droppedUpTo ? this.records[0]?.id : undefined;
  }

  /** Calls `listener` with each new line, until the returned function is called. */
  watch(listener: (record: LogRecord) => void): () => void {
    this.watchers.add(listener);
    return () => { this.watchers.delete(listener); };
  }
}

// ---------- Positions and spans ----------

const SINCE_FORMS = 'a log ID, an ISO 8601 time such as 2026-10-03T14:05:12Z, or a time of day such as 14:05:12';

/**
 * A `--since` value as a log ID: a log ID itself, an ISO 8601 time
 * (local without a zone), or a time of day today, local.
 */
export function parsePosition(text: string, now = new Date()): number | { error: string } {
  if (/^\d+$/.test(text)) return Number(text);
  const time = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/.exec(text);
  if (time) {
    const [, h, m, s = '0', frac = ''] = time;
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(h), Number(m), Number(s));
    if (Number(h) > 23 || Number(m) > 59 || Number(s) > 59) return { error: `The --since flag takes ${SINCE_FORMS}, not ${text}` };
    return day.getTime() * 1000 + Number(frac.padEnd(6, '0'));
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) {
    const ms = Date.parse(text);
    if (!Number.isNaN(ms)) return ms * 1000;
  }
  return { error: `The --since flag takes ${SINCE_FORMS}, not ${text}` };
}

/** A `--tail` value: a number of lines, or a stretch of time (`30s`, `5m`). */
export function parseTail(text: string): { lines: number } | { micros: number } | { error: string } {
  if (/^\d+$/.test(text) && Number(text) > 0) return { lines: Number(text) };
  const span = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(text);
  if (span) return { micros: Math.round(Number(span[1]) * { ms: 1e3, s: 1e6, m: 6e7, h: 3.6e9 }[span[2] as 'ms' | 's' | 'm' | 'h']) };
  return { error: `The --tail flag takes a number of lines, or a time such as 500ms, 30s, 5m or 1h, not ${text}` };
}

/** A log ID's time of day, local: `14:05:12.678`. */
export function timeOfDay(id: number): string {
  const d = new Date(Math.floor(id / 1000));
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** A log ID as ISO 8601, for JSON. */
export function isoTime(id: number): string {
  return new Date(Math.floor(id / 1000)).toISOString();
}

// The end-of-logs lines, which say where to pick up with --since.
const at = (id: number): string => `${id} (${timeOfDay(id)})`;
export const logsUpTo = (id: number): string => `[sm-dev] Logs up to ${at(id)}`;
export const foundAt = (id: number): string => `[sm-dev] Found at ${at(id)}`;
export const searchedUpTo = (id: number): string => `[sm-dev] Searched up to ${at(id)}`;
export const linesLost = (oldest: number): string => `[sm-dev] Lines before ${timeOfDay(oldest)} are no longer kept`;
/** `tab`: the tab asked for (`T4`), or none for all of them. */
export const noLogLines = (tab?: string): string => `[sm-dev] No log lines match ${tab ? `on tab ${tab}` : 'on any tab'}`;

// ---------- Text to find ----------

/**
 * What `--find` (or `wait log`'s text) matches: a plain substring, or
 * `/regex/flags`. `shown`: how a message names it.
 */
export function textMatcher(text: string, flag = '--find'): { matches: (line: string) => boolean; shown: string } | { error: string } {
  const regex = /^\/(.+)\/([a-z]*)$/.exec(text);
  if (!regex) return { matches: (line) => line.includes(text), shown: JSON.stringify(text) };
  let pattern: RegExp;
  try {
    pattern = new RegExp(regex[1], regex[2]);
  } catch (err) {
    return { error: `${text} is not a valid regular expression${flag ? ` for ${flag}` : ''}: ${(err as Error).message}` };
  }
  // Each line from its start: g and y otherwise carry on from where the
  // last match ended, which would skip matches.
  return {
    matches: (line) => {
      pattern.lastIndex = 0;
      return pattern.test(line);
    },
    shown: text,
  };
}

// ---------- How lines read ----------

/** `[event]`, `[script log]`, `[sm error]`, `[page warning]`. */
export function sourcePrefix(record: LogFields): string {
  return record.source === 'event' ? '[event]' : `[${record.source} ${record.kind}]`;
}

// Longer console lines are cut in the stream, so one huge value (a
// fetched page, a cache) doesn't bury the rest. `logs` shows them whole.
const CONSOLE_SHOWN_CHARS = 1000;

/** A console line as the stream shows it: cut past CONSOLE_SHOWN_CHARS. */
export function shortConsoleText(text: string): string {
  if (text.length <= CONSOLE_SHOWN_CHARS) return text;
  // By code point, so an emoji isn't cut in half.
  return `${Array.from(text).slice(0, CONSOLE_SHOWN_CHARS).join('')}... (${text.length} chars; logs shows ${text.length > LINE_CHARS ? `the first ${LINE_CHARS}` : 'it all'})`;
}

/**
 * A line as the stream prints it: `[T2] ` for a tab after T1, its
 * prefix, then its text, a console line cut past a length unless
 * `whole` (`wait log` matches it whole).
 */
export function streamText(record: LogFields, whole = false): string {
  const console = record.source === 'script' || record.source === 'page';
  const text = console && !whole ? shortConsoleText(record.text) : record.text;
  return `${record.tab !== undefined && record.tab > 1 ? `[T${record.tab}] ` : ''}${sourcePrefix(record)} ${text}`;
}

/**
 * Lines as `logs` prints them: the time and tab, then the prefix and
 * text, each run of identical lines once, marked `(N times)`.
 */
export function logsLines(records: readonly LogRecord[]): string[] {
  const width = Math.max(0, ...records.map((r) => (r.tab === undefined ? 0 : `T${r.tab}`.length)));
  const body = (r: LogRecord): string => `${(r.tab === undefined ? '' : `T${r.tab}`).padEnd(width)}${width > 0 ? ' ' : ''}${sourcePrefix(r)} ${r.text}`;
  const lines: string[] = [];
  for (let i = 0; i < records.length;) {
    const text = body(records[i]);
    let end = i + 1;
    while (end < records.length && body(records[end]) === text) end++;
    lines.push(`${timeOfDay(records[i].id)} ${text}${end - i > 1 ? ` (${end - i} times)` : ''}`);
    i = end;
  }
  return lines;
}
