// `--json` output: the shapes each command's result takes, and how a
// result travels from the run to the client that prints it.
//
// The types here are the spec's (docs/sm-dev-json.md): change them
// together. Field names and enum meanings are fixed once released;
// fields and enum values can be added.
//
// A result is a line like any other on its way to the client, marked
// by `JSON_RESULT` so the client can print it multi-line at a terminal
// and on one line into a pipe. A command's other lines in JSON mode
// are marked `STDERR_LINE`, so stdout keeps only the JSON.

/** Starts a line that carries one command's JSON result. */
export const JSON_RESULT = '\u0000sm-dev:json ';

/** How a result is laid out: on one line, or over several. */
export type JsonLayout = 'single' | 'multi';

/** The mistake in a `--json=` value, or null for none. */
export function jsonLayoutMistake(value: string): string | null {
  return value === 'single' || value === 'multi' ? null : 'The --json flag takes single or multi, e.g. --json=multi';
}

// A result line, and the layout its command's own `--json=` gave.
const RESULT_LINE = /^\u0000sm-dev:json(?::(single|multi))? /;

/** Whether a line carries a result. */
export function isJsonLine(line: string): boolean {
  return RESULT_LINE.test(line);
}

/**
 * A result line's data (the fields after `command`) and its command's
 * own layout, or null for another line.
 */
export function jsonResultData(line: string): { data: Record<string, unknown>; layout?: JsonLayout } | null {
  const result = RESULT_LINE.exec(line);
  if (!result) return null;
  const { command: _command, ...data } = JSON.parse(line.slice(result[0].length)) as Record<string, unknown>;
  return { data, ...(result[1] ? { layout: result[1] as JsonLayout } : {}) };
}

/** A result line marked with its command's own layout, which wins over the client's. */
export function withLayout(line: string, layout: JsonLayout): string {
  return line.replace(RESULT_LINE, `\u0000sm-dev:json:${layout} `);
}

/** Starts a line the client prints to stderr rather than stdout. */
export const STDERR_LINE = '\u0000sm-dev:stderr ';

/**
 * The commands with a JSON form, by name. `scripts`, `tabs` and `menu`
 * only when they list (see `onlyInspects`), not when they pick or fire;
 * `collection` and `script` only as `collection list` and `script list`.
 */
export const JSON_COMMANDS = [
  'list', 'status', 'scripts', 'tabs', 'values', 'get', 'match', 'validate', 'menu', 'logs', 'probe', 'collection', 'script',
];

/**
 * `JSON_COMMANDS` as help lists them: `a, b and c`, by the forms that
 * have one (`script list`, not `script`).
 */
export function jsonCommandList(): string {
  const forms = JSON_COMMANDS.map((c) => (c === 'collection' || c === 'script' ? `${c} list` : c));
  return `${forms.slice(0, -1).join(', ')} and ${forms.at(-1)}`;
}

/** The line carrying `command`'s result, `data`'s fields after `command`. */
export function jsonResult(command: string, data: object): string {
  return JSON_RESULT + JSON.stringify({ command, ...data });
}

/**
 * How a marked line prints: where it goes and its text, or null for a
 * plain line. A result is laid out as its command's `--json=` said,
 * else as `layout` (the client's), else multi-line when stdout is a
 * terminal and one line otherwise, so a program can split the output on
 * newlines.
 */
export function markedLine(line: string, layout: JsonLayout): { stderr: boolean; text: string } | null {
  const result = RESULT_LINE.exec(line);
  if (result) {
    const json = line.slice(result[0].length);
    const own = result[1] as JsonLayout | undefined;
    return { stderr: false, text: (own ?? layout) === 'multi' ? JSON.stringify(JSON.parse(json), null, 2) : json };
  }
  if (line.startsWith(STDERR_LINE)) return { stderr: true, text: line.slice(STDERR_LINE.length) };
  return null;
}

// ---------- Shared types ----------

/** Short form of a collection, inside other objects. */
export interface CollectionRef {
  /** `C2`, or a run's test collection's run (`D1`). */
  id?: string;
  name: string;
}

/** A collection in the manager. */
export interface Collection {
  /** `C2`, or a run's test collection's run (`D1`). */
  id?: string;
  /** Its id inside the manager (a UUID in SourceMonkey), not the extension's. */
  internalId: string;
  name: string;
  kind: 'container' | 'directory' | 'manifest';
  /** A directory's or manifest's location; none for a container. */
  location?: string;
  /** A run's test collection: the run's id (`D1`). */
  runCollection?: string;
  enabled: boolean;
  status: 'ok' | 'load-failed';
  /** Why it failed to load. */
  error?: string;
  scriptCount: number;
}

export interface Tab {
  /** `T1`. */
  id: string;
  url: string;
  /** The CDP target id. */
  targetId?: string;
  /** The tab the page commands act on. */
  selected: boolean;
  /** Opened with --noscript: it runs no scripts. */
  noScript?: boolean;
  /** The saved .html file it serves its URL from, with --from-saved. */
  savedFrom?: string;
  /** Serving a saved page with --offline. */
  offline?: boolean;
  /** The tab that opened it. */
  openedBy?: string;
  /** A dialog waiting for an answer. */
  dialog?: { kind: string; message: string };
  /** The ids of the run's scripts running in it. */
  scripts: string[];
}

export type ScriptStatus = 'ok' | 'invalid';

/**
 * What a script is doing on one tab. The run's scripts are `running`
 * or `not-running`; a SourceMonkey-managed script has the toolbar
 * badge's states.
 */
export type TabState =
  | 'running'
  | 'not-running'
  | 'error'
  | 'refused'
  | 'not-started'
  | 'unexpected'
  | 'changed'
  | 'kept-out';

export interface TabActivity {
  tab: string;
  state: TabState;
}

/** A script: one the run loaded (`1`), or one installed in SourceMonkey (`E1`). */
export interface Script {
  /** Absent in `script list` for a run's script: only its run knows its number. */
  id?: string;
  kind: 'run' | 'installed';
  name: string;
  /** The run's scripts: the path it was loaded from. */
  file?: string;
  /** Installed scripts: the collection holding it. */
  collection?: CollectionRef;
  /** Installed scripts, in `script list`: its id inside the manager (a UUID in SourceMonkey). */
  internalId?: string;
  namespace?: string;
  version?: string;
  /** Installed scripts, in `script list`: where it is loaded from. */
  location?: string;
  enabled?: boolean;
  /** The run's scripts, and installed ones in `script list`. */
  status?: ScriptStatus;
  /** Why it is invalid. */
  error?: string;
  /** Why its last refresh failed, while its last good copy still runs. */
  refreshError?: string;
  /** The script `get` and `set` act on. */
  selected?: boolean;
  /** In `scripts` and `status`: what it is doing on each tab. */
  tabs?: TabActivity[];
}

/** `status`'s extra per-script facts, for the run's scripts. */
export interface StatusScript extends Script {
  /** On the selected tab, where there is one. */
  menuCommands?: number;
  values?: number;
  /** On the selected tab, or every tab when there is none. */
  errors?: number;
  lastError?: string;
  /** Its permission prompts waiting for an answer (`connect`). */
  permissionPrompts?: { host: string; method: string; url: string }[];
}

// ---------- Each command's result ----------

export interface RunSummary {
  /** `D1`. */
  id: string;
  pid: number;
  /** ISO 8601. */
  started?: string;
  browser: { address: string; owned: boolean; headless: boolean };
  tabCount?: number;
  /** The loaded scripts' paths. */
  scriptFiles?: string[];
}

export interface ListData {
  runs: RunSummary[];
}

export interface StatusData {
  run?: RunSummary & {
    /** Whether the browser has SourceMonkey; absent when it couldn't be told. */
    sourceMonkey?: 'installed' | 'disabled' | 'absent';
    /** The run's test collection, once a script was pushed. */
    testCollection?: string;
    /** The run's log file. */
    log?: string;
    /** Where a `--temp-browser` saves downloads. */
    downloads?: string;
  };
  tabs: Tab[];
  /** The selected tab, whose states `scripts` gives first. */
  tab?: string;
  scripts: StatusScript[];
}

/** `status` with no run picked (no --run, start or attach): every run's. */
export interface StatusRunsData {
  runs: StatusData[];
}

export interface TabsData {
  tabs: Tab[];
}

export interface ScriptsData {
  /** The selected tab. */
  tab?: string;
  /** The run's scripts, then the installed scripts on the selected tab. */
  scripts: Script[];
}

export interface ValuesData {
  /** With a tab named (`values T2`): only the scripts running there. */
  tab?: string;
  scripts: { script: string; name: string; values: Record<string, unknown> }[];
}

export interface GetData {
  script: string;
  key: string;
  found: boolean;
  value?: unknown;
}

export interface MatchPage {
  url: string;
  tab?: string;
  matches: boolean;
  /** The rules that matched it. */
  matchedBy: string[];
  /** The rules that excluded it; absent for none. */
  excludedBy?: string[];
}

export interface MatchData {
  results: {
    /** The script's id in a run, else its file or URL. */
    script: string;
    name: string;
    /** False for a script that can't run anywhere. */
    valid: boolean;
    /** Why it can't. */
    error?: string;
    pages: MatchPage[];
  }[];
}

export interface ValidateData {
  results: {
    /** The script's file or URL. */
    script: string;
    verdict: 'ok' | 'invalid' | 'unchecked';
    /** Why it is invalid, or couldn't be checked. */
    error?: string;
    /** Absent when there are none. */
    warnings?: string[];
  }[];
}

export interface MenuData {
  tabs: {
    tab: string;
    url: string;
    commands: { id: string; script: string; name: string }[];
  }[];
}

export interface LogsData {
  tab: string;
  /** Each page load in the tab, oldest first. */
  pages: { url?: string; lines: string[] }[];
}

export interface ProbeData {
  /** The tab probed, and its page. */
  tab: string;
  url: string;
  selectors: {
    selector: string;
    /** Absent when the selector is invalid. */
    count?: number;
    /** Why the selector is invalid. */
    error?: string;
    /** With --css or --html: the first matches. */
    matches?: { css?: string; html?: string }[];
  }[];
}

export interface CollectionListData {
  collections: Collection[];
}

export interface ScriptListData {
  /** When one was named. */
  collection?: CollectionRef;
  scripts: Script[];
}
