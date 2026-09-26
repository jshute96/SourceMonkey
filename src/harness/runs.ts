// The runs `sm-dev start` began on this machine, and how another shell
// reaches one: `sm-dev list`, `sm-dev stop`, and the commands sent to
// a run (`sm-dev status`, or `sm-dev send`).
//
// Each run that waits for commands writes a record file and listens on
// a socket of its own, both named by its id (`D1`). A run in the
// background, with no terminal to type into, is then still driven the
// same way as one in the foreground: a line sent over the socket runs
// as a typed command, and its output comes back.
//
// Node-only: no Playwright, so `list`, `send` and `stop` run anywhere.

import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** What `sm-dev list` shows for a run, as its record file holds it. */
export interface RunRecord {
  id: string;
  pid: number;
  /** When it started, in epoch milliseconds. */
  started: number;
  /** The browser: its CDP endpoint, or `launched` for `--launch`. */
  browser: string;
  /** The loaded scripts' paths, as the run names them. */
  scripts: string[];
  /** How many tabs it controls, where it keeps count. */
  tabs?: number;
  /** Started by `start --detach`, and so replaced by the next one. */
  detached?: boolean;
  /** A detached run's output file. */
  log?: string;
}

/**
 * Who the runs belong to, in the directory and pipe names, so two
 * users on one machine neither see nor clash with each other's runs:
 * the user name, kept to characters a file name can take. The uid when
 * there is no name: `os.userInfo()` throws for a uid with no passwd
 * entry, as in a container run with `--user`.
 */
export function owner(): string {
  let name: string | undefined;
  try {
    name = os.userInfo().username;
  } catch {
    name = process.env.USER ?? process.env.USERNAME;
  }
  const safe = name?.replace(/[^\w.-]/g, '_');
  if (safe) return safe;
  const uid = process.getuid?.();
  return uid !== undefined ? String(uid) : 'user';
}

// `SM_DEV_RUNS_DIR` moves it, for tests to keep out of real runs' way.
function runsDir(): string {
  return process.env.SM_DEV_RUNS_DIR || path.join(os.tmpdir(), `sm-dev-runs-${owner()}`);
}

function recordPath(id: string): string {
  return path.join(runsDir(), `${id}.json`);
}

// Windows has no socket files; a named pipe stands in.
function socketPath(id: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\sm-dev-${owner()}-${id}`
    : path.join(runsDir(), `${id}.sock`);
}

// Runs are named D1, D2, as tabs are T1 and menu commands M1: the
// lowest number free when the run starts, so they stay short to type.
// A number is reused once its run has ended. `start --run` can name one
// instead: `D` and then letters, digits, `_` or `-`. Kept short, since
// the id is part of the socket's path, which has a length limit.
const RUN_ID = /^(?:[Dd](\d{1,32})|D([0-9A-Za-z_-]{1,32}))$/;

/** Where `start` records the tabs it opened, for a later run to reuse. */
export function runTabsPath(): string {
  return path.join(runsDir(), 'run-tabs.json');
}

/**
 * A typed run id in its usual form (`d2` is `D2`, `D02` is `D2`), or
 * null if it isn't one. Named ones are taken as typed.
 */
export function runIdOf(typed: string): string | null {
  const m = RUN_ID.exec(typed);
  if (!m) return null;
  return m[1] !== undefined ? `D${BigInt(m[1])}` : `D${m[2]}`;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, under another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The directory for sm-dev's state across runs, made private to its
 * user: the runs' records and sockets, and `start`'s tab records. Created
 * when missing.
 */
export async function ownRunsDir(): Promise<string> {
  const dir = runsDir();
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new Error(`Could not create the runs directory ${dir}: ${(err as Error).message}`);
  }
  await checkRunsDir();
  return dir;
}

/**
 * The directory, checked before anything in it is trusted, or null
 * when there is none yet. In a shared temp directory another user could
 * have made it first, or be able to write in it, and then plant records
 * whose pids `stop` would signal; such a directory is refused.
 */
export async function checkRunsDir(): Promise<string | null> {
  return checkPrivateDir(runsDir(), 'runs');
}

/**
 * `dir`, or null when it doesn't exist; refused when another user owns
 * it or can write in it. `what` names it in the message (`runs`, `log`).
 */
export async function checkPrivateDir(dir: string, what: string): Promise<string | null> {
  let info;
  try {
    info = await lstat(dir);
  } catch {
    return null;
  }
  const uid = process.getuid?.();
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) {
    throw new Error(`The ${what} directory ${dir} belongs to another user`);
  }
  if (uid !== undefined && (info.mode & 0o022) !== 0) {
    throw new Error(`The ${what} directory ${dir} can be written by other users. Remove it, and sm-dev makes a private one.`);
  }
  return dir;
}

/**
 * What a run does with a line another shell sent: `reply` receives the
 * output, until the returned promise settles. `hold` keeps the
 * connection open, and `reply` receiving, until the run closes it, as
 * `quit` does so the sender sees the run end.
 */
export type SentLineHandler = (
  line: string, reply: (line: string) => void, sent?: { cwd?: string; words?: string[] },
) => Promise<'done' | 'hold'>;

// How long a sender gets to take the last of the output once the run
// ends its connection, before the run drops it and exits anyway.
const CLOSE_WAIT_MS = 1000;

/** A run's end of the registry: its record file and its socket. */
export class RunControl {
  private readonly sockets = new Set<net.Socket>();
  // Record writes, one at a time, so an older one never lands last.
  private writes: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    private record: RunRecord,
    private readonly server: net.Server,
  ) {}

  /**
   * Takes the run's id, registers it and starts listening. Throws when
   * that fails; the run goes on without, but can't be reached from
   * another shell.
   */
  static async open(fields: Omit<RunRecord, 'id'>, handle: SentLineHandler, wanted?: string): Promise<RunControl> {
    await ownRunsDir();
    const server = net.createServer();
    const id = wanted === undefined ? await claimId(server) : await claimNamedId(server, wanted);
    const record = { id, ...fields };
    const control = new RunControl(record, server);
    server.on('connection', (socket) => control.serve(socket, handle));
    // Nothing keeps the process alive for a listener alone: the run
    // ends on its own terms.
    server.unref();
    try {
      await writeRecord(record);
    } catch (err) {
      server.close();
      throw new Error(`Could not write the run's record ${recordPath(record.id)}: ${(err as Error).message}`);
    }
    return control;
  }

  get id(): string {
    return this.record.id;
  }

  /** Records changed scripts or tabs, for `sm-dev list`. */
  update(changes: Partial<Pick<RunRecord, 'scripts' | 'tabs'>>): Promise<void> {
    this.record = { ...this.record, ...changes };
    this.writes = this.writes.then(() => (this.closed ? undefined : writeRecord(this.record))).catch(() => undefined);
    return this.writes;
  }

  /** Unregisters the run, and ends every connection still open. */
  async close(): Promise<void> {
    this.closed = true;
    await this.writes;
    await rm(recordPath(this.record.id), { force: true }).catch(() => undefined);
    for (const socket of this.sockets) socket.end();
    // Not waited on for good: a sender that never closes its end would
    // otherwise hold the run open.
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    const timer = setTimeout(() => {
      for (const socket of this.sockets) socket.destroy();
    }, CLOSE_WAIT_MS);
    await closed;
    clearTimeout(timer);
  }

  // One line per connection: the command, then its output back, then
  // the end of the connection.
  private serve(socket: net.Socket, handle: SentLineHandler): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    // A sender that goes away mid-reply is no concern of the run's.
    socket.on('error', () => undefined);
    let buffered = '';
    let taken = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      if (taken) return;
      buffered += chunk;
      const end = buffered.indexOf('\n');
      if (end < 0) return;
      taken = true;
      const reply = (line: string): void => {
        if (!socket.destroyed) socket.write(line + '\n');
      };
      // `{"line": ..., "cwd": ..., "words": [...]}` from `sendLine`: the
      // sender's directory, for the files the command names, and its own
      // words. A plain line is taken as it is.
      const text = buffered.slice(0, end).replace(/\r$/, '');
      let line = text;
      let sent: { cwd?: string; words?: string[] } | undefined;
      try {
        const message = JSON.parse(text) as { line?: unknown; cwd?: unknown; words?: unknown };
        if (typeof message.line === 'string') {
          line = message.line;
          sent = {
            cwd: typeof message.cwd === 'string' ? message.cwd : undefined,
            words: Array.isArray(message.words) && message.words.every((w) => typeof w === 'string') ? message.words as string[] : undefined,
          };
        }
      } catch {
        // A plain line.
      }
      handle(line, reply, sent).then(
        (outcome) => { if (outcome === 'done') socket.end(); },
        (err: Error) => {
          reply(`[sm-dev] ${err.message}`);
          socket.end();
        },
      );
    });
  }
}

// The lowest free id, taken by listening on its socket: only one
// process can, so two runs starting together never get the same one.
// The record is written after, so `list` never shows a run it can't
// reach yet.
async function claimId(server: net.Server): Promise<string> {
  for (let n = 1; ; n++) {
    const id = `D${n}`;
    if (await listenOn(server, socketPath(id))) return id;
    // In use, or a socket file a killed run left, which nothing listens
    // on. Windows pipes leave no such file.
    if (process.platform !== 'win32' && await takeStale(server, id)) return id;
  }
}

// `start --run`'s id: taken as the lowest free one is, or refused when
// a run holds it still.
async function claimNamedId(server: net.Server, id: string): Promise<string> {
  if (await listenOn(server, socketPath(id))) return id;
  if (process.platform !== 'win32' && await takeStale(server, id)) return id;
  throw new Error(`Run ${id} is running already`);
}

// Listens on `where`: false when something already holds it.
async function listenOn(server: net.Server, where: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(where, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') return false;
    throw new Error(`Could not listen on ${where}: ${(err as Error).message}`);
  }
}

// Clears a killed run's socket file and listens there instead. Under a
// lock held until the listen, since between one run finding the file
// dead and deleting it, another could clear it and start listening,
// and then lose its live socket to the delete. A lock already held, or
// left by a run killed while holding it, only means trying the next
// number.
async function takeStale(server: net.Server, id: string): Promise<boolean> {
  const lock = path.join(runsDir(), `${id}.clearing`);
  try {
    await mkdir(lock);
  } catch {
    return false;
  }
  try {
    if (await listening(id) !== false) return false;
    await rm(socketPath(id), { force: true });
    return await listenOn(server, socketPath(id));
  } finally {
    await rmdir(lock).catch(() => undefined);
  }
}

// Written whole under a name of its own and renamed into place, so
// `list` never reads half a file.
async function writeRecord(record: RunRecord): Promise<void> {
  const file = recordPath(record.id);
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(record) + '\n', { mode: 0o600 });
  await rename(temp, file);
}

// Deletes an ended run's files. Each is checked first, since a new run
// may have taken the id meanwhile: the record only if it still names
// the old pid, the socket only if nothing listens on it.
async function forget(id: string, pid: number): Promise<void> {
  try {
    const record = JSON.parse(await readFile(recordPath(id), 'utf8')) as RunRecord;
    if (record.pid === pid) await rm(recordPath(id), { force: true });
  } catch {
    // Gone already, or unreadable: nothing to delete.
  }
  if (process.platform !== 'win32' && await listening(id) === false) {
    await rm(socketPath(id), { force: true }).catch(() => undefined);
  }
}

// Nothing listens on the run's socket: it has ended, even if its pid
// has since gone to another process.
function goneCode(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

// Whether a run's socket takes a connection. A connection that sends no
// line runs nothing in the run.
function listening(id: string): Promise<boolean | 'unknown'> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath(id));
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', (err) => resolve(goneCode(err) ? false : 'unknown'));
  });
}

/**
 * The runs active now, oldest first. A record whose process has gone
 * (killed, or its machine rebooted), or whose socket nothing listens on
 * (its pid reused since), is deleted on the way.
 */
export async function liveRuns(): Promise<RunRecord[]> {
  const dir = await checkRunsDir();
  if (!dir) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const runs: RunRecord[] = [];
  // Only runs' records: the directory holds other state too.
  await Promise.all(names.filter((n) => n.endsWith('.json') && runIdOf(n.slice(0, -'.json'.length)) === n.slice(0, -'.json'.length)).map(async (name) => {
    const id = name.slice(0, -'.json'.length);
    let record: RunRecord;
    try {
      record = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as RunRecord;
    } catch {
      // Unreadable is as good as gone: nothing could reach it.
      return;
    }
    if (processAlive(record.pid) && await listening(id) !== false) runs.push(record);
    else await forget(id, record.pid);
  }));
  return runs.sort((a, b) => a.started - b.started);
}

/** `sendLine`'s failure when the run has ended. */
export class RunGoneError extends Error {}

/**
 * Sends one command to a run (one line, or an eval block's several),
 * passing each line of its output to `out` as it arrives. Resolves
 * once the run closes the connection. `signal` drops the connection,
 * for a sender done waiting.
 */
export function sendLine(id: string, line: string, out: (line: string) => void, signal?: AbortSignal, words?: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath(id));
    signal?.addEventListener('abort', () => {
      socket.destroy();
      reject(new Error(`Stopped waiting on run ${id}`));
    }, { once: true });
    let connected = false;
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      connected = true;
      // With this shell's directory, for the files it names, and the
      // words as the shell gave them.
      socket.write(JSON.stringify({ line, cwd: process.cwd(), words }) + '\n');
    });
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop()!;
      for (const l of lines) out(l);
    });
    socket.on('end', () => {
      if (buffered) out(buffered);
      resolve();
    });
    socket.on('error', (err) => {
      if (connected) reject(new Error(`The connection to run ${id} was lost`));
      else if (goneCode(err)) reject(new RunGoneError(`Run ${id} has ended`));
      else reject(new Error(`Run ${id} could not be reached: ${err.message}`));
    });
  });
}

// How long a run gets to answer `quit`, and once it has, how long to
// finish ending (a tab stopped on a dialog takes a while to let go).
// Past either, it is sent SIGTERM, and given the first again to go.
const STOP_WAIT_MS = 15_000;
const TEARDOWN_WAIT_MS = 60_000;

/**
 * Ends a run as its `quit` would, passing on what it prints as it ends.
 * One that doesn't answer, or doesn't finish ending in time, is sent
 * SIGTERM: it ends one that never got the `quit` as Ctrl-C would, and
 * kills one stuck ending. A run found to have ended already is never
 * signalled, since its pid may be another process's by now. Resolves to
 * whether the run has gone.
 */
export async function stopRun(record: RunRecord, out: (line: string) => void): Promise<boolean> {
  const abort = new AbortController();
  // It answers `quit` with a line straight away, then ends.
  let answered = false;
  const sent = sendLine(record.id, 'quit', (line) => {
    answered = true;
    out(line);
  }, abort.signal).then(() => 'closed' as const, (err) => (err instanceof RunGoneError ? 'gone' as const : 'failed' as const));
  let outcome = await within(sent, STOP_WAIT_MS);
  if (outcome === 'timeout' && answered) outcome = await within(sent, TEARDOWN_WAIT_MS);
  // Closed without that first line: whatever took it, it wasn't a run
  // ending.
  if (outcome === 'closed' && !answered) outcome = 'failed';
  // So a connection still open can't keep this process alive.
  abort.abort();
  if (outcome === 'gone') {
    await forget(record.id, record.pid);
    out(`[sm-dev] Run ${record.id} had already ended`);
    return true;
  }
  if (outcome === 'closed' && await exited(record.pid, STOP_WAIT_MS)) return true;
  try {
    process.kill(record.pid, 'SIGTERM');
  } catch {
    // Gone meanwhile.
  }
  if (await exited(record.pid, STOP_WAIT_MS)) {
    out(`[sm-dev] Run ${record.id} ${answered ? 'did not finish ending' : 'did not answer'}, so it was sent SIGTERM, and has ended`);
    return true;
  }
  out(`[sm-dev] Run ${record.id} (pid ${record.pid}) has not ended, even after SIGTERM`);
  return false;
}

// `work`'s result, or `timeout` if it takes longer than `ms`.
async function within<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function exited(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (processAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Past this many, `list` names the first few and counts the rest.
const LISTED_SCRIPTS = 3;

/**
 * `sm-dev list`'s table: a heading row, then a row per run, in aligned
 * columns. Scripts are listed by file name, the first few and a count
 * of the rest, so the total shows without a column of its own. `-` is
 * none, or no tab count for a run that keeps none (`--extension`).
 */
export function runTable(records: RunRecord[], now = Date.now()): string[] {
  const rows = [
    ['Run', 'PID', 'Uptime', 'Browser', 'Tabs', 'Scripts'],
    ...records.map((r) => {
      const names = r.scripts.map((s) => path.basename(s));
      const shown = names.length > LISTED_SCRIPTS
        ? [...names.slice(0, LISTED_SCRIPTS), `(${names.length - LISTED_SCRIPTS} more)`]
        : names;
      return [
        r.id,
        String(r.pid),
        uptime(now - r.started),
        r.browser.replace(/^https?:\/\//, ''),
        r.tabs === undefined ? '-' : String(r.tabs),
        shown.length > 0 ? shown.join(', ') : '-',
      ];
    }),
  ];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  // The last column unpadded, so no line ends in spaces.
  return rows.map((row) => row.map((cell, i) => (i < row.length - 1 ? cell.padEnd(widths[i]) : cell)).join('  ').trimEnd());
}

function uptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}
