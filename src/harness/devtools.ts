// `sm-dev start --devtools`: a Chrome DevTools background server for the
// run, and each controlled tab's page id in it.
//
// The DevTools command line (`chrome-devtools`, from the
// chrome-devtools-mcp package) drives pages well: clicks, keys, text
// snapshots, screenshots. It numbers pages its own way, though, and
// gives no id sm-dev could match to its tabs. So the run starts its own
// server, under the run's id as its session, and finds each tab there
// by a marker it puts on the page for a moment (see `map`).
//
// The server connects to the browser through a proxy that shows it
// only the run's tabs (cdp-proxy.ts): DevTools otherwise attaches to
// every tab in the browser, and one that doesn't answer stalls it.
//
// `chrome-devtools start` launches the server. After that the run talks
// to it over its socket, as the command itself does: a command process
// per call would cost a Node startup each time. That socket protocol is
// the package's own, not a documented one; this follows
// chrome-devtools-mcp 1.10.
//
// The server is the one an agent's own `chrome-devtools --sessionId=D1`
// calls reach.

import { execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { CdpProxy } from './cdp-proxy.js';
import type { ControlledTab } from './console-commands.js';

const CLI = 'chrome-devtools';

// `start` only launches the server; it connects to the browser on the
// first call.
const START_TIMEOUT_MS = 15_000;
// The first call connects to the browser, attaching to the run's tabs.
const FIRST_CALL_TIMEOUT_MS = 15_000;
// A later call that takes longer is most likely stuck behind one of the
// run's tabs not answering DevTools, which blocks every call.
const CALL_TIMEOUT_MS = 5000;
// Setting or deleting a tab's marker. Only a tab that just opened a
// dialog takes long, and it isn't waited for.
const MARKER_TIMEOUT_MS = 2000;

// A tab still unmapped after a pass (loading, on a dialog, or DevTools
// stuck) is tried again after this, a few times.
const RETRY_MS = 2000;
const RETRIES = 5;

// The marker's key on `window`. A symbol, so no enumeration of the
// page's own properties finds it.
const MARKER = 'sm-dev';

const NOT_INSTALLED = `The ${CLI} command wasn't found. Install it with npm i -g chrome-devtools-mcp.`;

// Whether an executable of that name is in a PATH directory.
async function onPath(name: string): Promise<boolean> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    try {
      await access(path.join(dir, name), constants.X_OK);
      return true;
    } catch {
      // Not in this one.
    }
  }
  return false;
}

/** Whether a run should start one: `--devtools`, `--nodevtools`, else `SM_DEV_DEVTOOLS`. */
export function devtoolsWanted(flag: boolean | undefined): boolean {
  return flag ?? process.env.SM_DEV_DEVTOOLS === '1';
}

// The server's socket for a session, as chrome-devtools-mcp names it.
function socketPath(session: string): string {
  const app = `chrome-devtools-mcp-${session}`;
  const runtime = process.env.XDG_RUNTIME_DIR;
  return runtime ? path.join(runtime, app, 'server.sock') : path.join('/tmp', `${app}-${process.getuid?.() ?? 0}.sock`);
}

// Its answer to a tool call, as the MCP protocol shapes it.
interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

class CallTimeout extends Error {}

export class DevToolsLink {
  /** Resolves true once the server is up, false if it never will be. */
  readonly ready: Promise<boolean>;
  private readonly socket: string;
  // Page ids already given to a tab, so no page is read twice.
  private readonly taken = new Set<number>();
  // Passes each tab has been left unmapped by, since its last page load.
  private readonly attempts = new WeakMap<ControlledTab, number>();
  // Tabs whose page loads start their retries over.
  private readonly watched = new WeakSet<ControlledTab>();
  // Calls in flight, so stopping can cut them off.
  private readonly sockets = new Set<net.Socket>();
  private starting: ChildProcess | null = null;
  // What the server connects to instead of the browser: it shows only
  // the run's tabs.
  private proxy: CdpProxy | null = null;
  private mapping: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private up = false;
  private calls = 0;
  // Said once per run, not on every pass that hits it.
  private saidStuck = false;

  /**
   * Starts the server in the background, attached to the browser at
   * `browserUrl`, under `session` (the run's id). Its usage statistics,
   * update checks and CrUX lookups (Google's field-performance API)
   * are turned off.
   */
  constructor(
    private readonly session: string,
    browserUrl: string,
    private readonly tabs: () => ControlledTab[],
    private readonly out: (line: string) => void,
  ) {
    this.socket = socketPath(session);
    this.ready = this.start(browserUrl).then(() => {
      this.allowTabs();
      if (this.stopped) return false;
      this.up = true;
      this.out(`[sm-dev] DevTools: ${this.usage}`);
      this.schedule();
      return true;
    }, (err: Error) => {
      if (!this.stopped) this.out(`[sm-dev] DevTools isn't available: ${err.message}`);
      return false;
    });
  }

  /** Whether the server is up now. */
  get isUp(): boolean {
    return this.up && !this.stopped;
  }

  /** How to reach the server, for the run's output and `status`. */
  get usage(): string {
    return `${CLI} --sessionId=${this.session} <tool> <pageId> ...`;
  }

  /** Maps the tabs without a page id yet, shortly: tabs opening together are done in one pass. */
  schedule(delay = 300): void {
    if (this.stopped) return;
    this.allowTabs();
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.mapping = this.mapping.then(() => this.map()).catch(() => undefined);
    }, delay);
    this.timer.unref();
  }

  /**
   * Ends the link, before the run lets its tabs go: no more passes, and
   * a pass in flight has its calls cut off (and can start no more), so
   * it only has its markers to delete, which needs the tabs still
   * attached. Then the server is killed rather than asked to stop,
   * since asking means waiting behind a call that may be stuck; it
   * cleans up after itself on SIGTERM.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const socket of this.sockets) socket.destroy();
    await Promise.race([this.mapping, sleep(MARKER_TIMEOUT_MS)]);
    // A `start` still running would leave a server behind; it takes a
    // couple of seconds, so it gets a few to finish before the kill.
    if (this.starting) await Promise.race([this.ready, sleep(3000)]);
    this.starting?.kill();
    await this.killServer();
    await this.proxy?.close();
  }

  // The run's tabs, for the proxy to show: each as it's found.
  private allowTabs(): void {
    for (const tab of this.tabs()) if (tab.targetId) this.proxy?.allow(tab.targetId);
  }

  private async start(browserUrl: string): Promise<void> {
    // The server's files and signals are only followed as they are on
    // Linux and macOS.
    if (process.platform === 'win32') throw new Error('The --devtools flag isn\'t supported on Windows yet');
    // First, since it's the one a person can fix.
    if (!await onPath(CLI)) throw new Error(NOT_INSTALLED);
    try {
      this.proxy = await CdpProxy.start(browserUrl);
    } catch (err) {
      throw new Error(`DevTools couldn't connect to the browser: ${(err as Error).message}`);
    }
    // Stopped meanwhile, before there was a proxy for `stop` to close.
    if (this.stopped) {
      await this.proxy.close();
      return;
    }
    this.allowTabs();
    return new Promise((resolve, reject) => {
      const args = [`--sessionId=${this.session}`, 'start', '--browserUrl', this.proxy!.url, '--usageStatistics=false', '--performanceCrux=false'];
      this.starting = execFile(CLI, args, {
        timeout: START_TIMEOUT_MS,
        env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1', CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' },
      }, (err, _stdout, stderr) => {
        this.starting = null;
        if (!err) {
          resolve();
          return;
        }
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(NOT_INSTALLED));
        } else if (err.killed) {
          reject(new Error(`The DevTools server didn't start within ${START_TIMEOUT_MS / 1000} seconds`));
        } else {
          reject(new Error(`The DevTools server didn't start: ${failureLine(stderr) ?? err.message}`));
        }
      });
    });
  }

  // SIGTERM to the pid the server itself reports. Not its pid file
  // alone: a server that died without cleaning up leaves one naming a
  // pid that may be another process's by now.
  private async killServer(): Promise<void> {
    const status = await this.request({ method: 'status' }, 1000).catch(() => null);
    const pid = status ? (JSON.parse(status) as { pid?: number }).pid : undefined;
    if (!pid) return;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Gone meanwhile.
    }
  }

  /**
   * Finds each unmapped tab among the server's pages. Each gets a
   * marker (this run, this pass, its tab) in its page's main world,
   * the one world DevTools' `evaluate_script` reads. The pages whose
   * URL matches one of those tabs are read for it, and the markers
   * deleted again. Tabs on a dialog are left for a later pass, since
   * their JavaScript is stopped.
   */
  private async map(): Promise<void> {
    if (this.stopped || !await this.ready) return;
    const unmapped = this.tabs().filter((t) => t.pageId === undefined && !t.page.isClosed());
    for (const tab of unmapped) this.watch(tab);
    const ready = unmapped.filter((t) => !t.dialogs?.current);
    const prefix = `${this.session}:${randomBytes(4).toString('hex')}:`;
    const marked: ControlledTab[] = [];
    try {
      for (const tab of ready) {
        if (this.stopped) break;
        const set = await withTimeout(tab.page.evaluate(([key, value]) => {
          Object.defineProperty(window, Symbol.for(key), { value, configurable: true });
        }, [MARKER, `${prefix}${tab.n}`] as const), MARKER_TIMEOUT_MS).then(() => true, () => false);
        if (set) marked.push(tab);
      }
      if (marked.length > 0 && !this.stopped) await this.find(marked, prefix);
    } catch (err) {
      this.report(err as Error);
    } finally {
      for (const tab of marked) {
        await withTimeout(tab.page.evaluate((key) => {
          delete (window as unknown as Record<symbol, unknown>)[Symbol.for(key)];
        }, MARKER), MARKER_TIMEOUT_MS).catch(() => undefined);
      }
    }
    if (this.stopped) return;
    // Each tab gets its own few retries, so one that never maps (a
    // dialog nobody answers) doesn't use up the next tab's.
    let again = false;
    for (const tab of unmapped) {
      if (tab.pageId !== undefined || tab.page.isClosed()) continue;
      const n = (this.attempts.get(tab) ?? 0) + 1;
      this.attempts.set(tab, n);
      if (n <= RETRIES) again = true;
      else if (n === RETRIES + 1) this.out(`[sm-dev] T${tab.n}'s DevTools page id wasn't found. Reload the tab to try again.`);
    }
    if (again) this.schedule(RETRY_MS);
  }

  // A tab's page loads give it its retries again: the load may be what
  // it was waiting on.
  private watch(tab: ControlledTab): void {
    if (this.watched.has(tab)) return;
    this.watched.add(tab);
    tab.page.on('load', () => {
      if (tab.pageId !== undefined || this.stopped) return;
      this.attempts.delete(tab);
      this.schedule();
    });
  }

  // The pages whose URL matches a marked tab, read for its marker.
  private async find(marked: ControlledTab[], prefix: string): Promise<void> {
    const urls = new Set(marked.map((t) => t.page.url()));
    const listed = (await this.call('list_pages', {})).structuredContent?.pages as { id: number; url: string }[] | undefined;
    const pages = (listed ?? []).filter((p) => urls.has(p.url) && !this.taken.has(p.id));
    for (const page of pages) {
      if (this.stopped || marked.every((t) => t.pageId !== undefined)) return;
      const value = await this.readMarker(page.id).catch((err: Error) => {
        // A page that went away meanwhile is no one's; a stuck server
        // stops the pass.
        if (err instanceof CallTimeout || this.stopped) throw err;
        return null;
      });
      if (typeof value !== 'string' || !value.startsWith(prefix)) continue;
      const tab = marked.find((t) => t.n === Number(value.slice(prefix.length)));
      if (!tab) continue;
      tab.pageId = page.id;
      this.taken.add(page.id);
      this.out(`[sm-dev] T${tab.n} is DevTools page ${page.id}`);
    }
  }

  // A failed pass, said once: the next passes (and the agent's own
  // calls) would only fail the same way.
  private report(err: Error): void {
    if (this.stopped || this.saidStuck) return;
    this.saidStuck = true;
    this.out(err instanceof CallTimeout
      ? `[sm-dev] DevTools didn't answer in time, so some tabs have no page id yet. It may still be connecting, or one of the run's tabs may not be answering it, which holds up every DevTools call.`
      : `[sm-dev] DevTools page ids could not be looked up: ${err.message}`);
  }

  // The marker on a page, or null. `dismiss`: a dialog the page happens
  // to open during the read gets Cancel, the safer answer, rather than
  // DevTools' default of OK. Not waiting for the DOM to settle, which a
  // busy page may never quite do.
  private async readMarker(pageId: number): Promise<unknown> {
    const result = await this.call('evaluate_script', {
      function: `() => window[Symbol.for(${JSON.stringify(MARKER)})] ?? null`,
      pageId,
      dialogAction: 'dismiss',
      waitForStableDom: false,
    });
    // The value comes as JSON in a fenced block in its message.
    const message = String(result.structuredContent?.message ?? result.content?.[0]?.text ?? '');
    const fenced = /```json\n([\s\S]*?)\n```/.exec(message);
    return fenced ? JSON.parse(fenced[1]) as unknown : null;
  }

  // A tool call. The first gets longer: it is when the server connects
  // to the browser.
  private async call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const timeout = this.calls++ === 0 ? FIRST_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS;
    const result = JSON.parse(await this.request({ method: 'invoke_tool', tool, args }, timeout)) as ToolResult;
    if (result.isError) throw new Error(result.content?.map((c) => c.text ?? '').join(' ').trim() || `The DevTools ${tool} call failed`);
    return result;
  }

  // One request over the server's socket: JSON, ended by a NUL, and a
  // reply the same way, as the command sends them. Resolves to the
  // reply's `result`, itself JSON.
  private request(message: Record<string, unknown>, timeout: number): Promise<string> {
    if (this.stopped && message.method !== 'status') return Promise.reject(new Error('The run is ending'));
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.socket);
      this.sockets.add(socket);
      let buffered = '';
      let settled = false;
      const done = (err: Error | null, result?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.sockets.delete(socket);
        socket.destroy();
        if (err) reject(err);
        else resolve(result!);
      };
      const timer = setTimeout(() => done(new CallTimeout('The DevTools server didn\'t answer in time')), timeout);
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(JSON.stringify(message) + '\0'));
      socket.on('data', (chunk: string) => {
        buffered += chunk;
        const end = buffered.indexOf('\0');
        if (end < 0) return;
        try {
          const reply = JSON.parse(buffered.slice(0, end)) as { success: boolean; result?: string; error?: string };
          if (!reply.success) throw new Error(reply.error ?? 'The DevTools server refused the call');
          done(null, reply.result ?? '{}');
        } catch (err) {
          done(err as Error);
        }
      });
      socket.on('error', (err: NodeJS.ErrnoException) => {
        done(new Error(err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
          ? 'The DevTools server has stopped'
          : `The DevTools server couldn't be reached: ${err.message}`));
      });
      socket.on('close', () => done(new Error('The DevTools server closed the connection')));
    });
  }
}

// The line of a failed command's output that says what went wrong: the
// error, not the stack under it or Node's version line after.
function failureLine(output: string): string | undefined {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^\w*Error:/.test(l))
    ?? lines.find((l) => !l.startsWith('at ') && !/^Node\.js v/.test(l));
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([work, sleep(ms).then(() => { throw new Error('Timed out'); })]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
