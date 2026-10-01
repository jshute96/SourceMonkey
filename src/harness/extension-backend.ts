// The extension backend of `sm-dev start`: the real SourceMonkey in the
// connected browser, with the script pushed in as text rather than
// injected by the harness.
//
// The service worker's test surface (`self.SourceMonkey` in
// src/background.ts) does the work: `writeScratchScript` installs the
// text into the Scratch collection and registers it before it answers,
// a rewrite replaces it in place, `soloMode` silences the user's other
// collections for the run, and `start` prints the per-script log as the
// script's reports. Playwright exposes the worker on a
// CDP-connected browser as well as a launched one, so the same
// `worker.evaluate` reaches it either way.

import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { BrowserContext, Worker } from '@playwright/test';

export interface PushResult {
  scriptId: string;
  collectionId: string;
  status: 'ok' | 'invalid';
  errorMessage?: string;
  errorLocation?: { file: string; line?: number; column?: number };
  replaced: boolean;
}

export interface LogEntry {
  timestamp: number;
  level: string;
  source: string;
  message: string;
  tabId?: number;
}

// SourceMonkey's extension id. The manifest carries a fixed `key`, so
// Chrome derives the same id for every install of it, unpacked or not:
// the SHA-256 of the key bytes, first sixteen bytes, each hex digit
// mapped to a letter. Read from the package's own manifest so a
// changed key follows along.
let cachedId: string | null = null;

export function extensionIdFromKey(base64Key: string): string {
  const digest = crypto.createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('hex');
  return digest.slice(0, 32).split('').map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}

export async function sourceMonkeyExtensionId(): Promise<string> {
  if (cachedId) return cachedId;
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  if (typeof manifest.key !== 'string') throw new Error('Internal error: the manifest has no key to derive the extension id from');
  cachedId = extensionIdFromKey(manifest.key);
  return cachedId;
}

/** Whether SourceMonkey is in a browser, as `sourceMonkeyState` finds it. */
export type ExtensionState = 'installed' | 'disabled' | 'absent';

type CdpReply = { result?: Record<string, unknown>; error?: { message: string } };

/**
 * Whether SourceMonkey is installed and enabled in the browser at
 * `endpoint` (its CDP address), for `status` and the run's first lines.
 * Null when it couldn't be told. Over a WebSocket of its own, since
 * Playwright's browser session can't reach the target the fallback
 * makes. It can't see "Allow User Scripts".
 *
 * - `Extensions.getExtensions` lists the unpacked extensions, enabled
 *   or not, which is how SourceMonkey is usually loaded.
 * - Otherwise (a Web Store install, or a Chrome without that call), a
 *   hidden target (no tab in the tab strip) is sent to the extension's
 *   manifest.json. It loads only when the extension is installed and
 *   enabled, and runs none of its code. So a disabled Web Store install
 *   reads as absent.
 */
export async function sourceMonkeyState(endpoint: string, timeoutMs = 3000): Promise<ExtensionState | null> {
  // Ends the check however it ends: the fetch, and the socket, which
  // may be opened after the time is up.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const probe = async (): Promise<ExtensionState> => {
    const url = /^wss?:/.test(endpoint) ? endpoint
      : ((await (await fetch(`${endpoint}/json/version`, { signal: abort.signal })).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
    abort.signal.throwIfAborted();
    const socket = new WebSocket(url);
    const waiting = new Map<number, (reply: CdpReply) => void>();
    // Closing answers every call still waiting, so none is left hanging.
    const close = (): void => {
      socket.close();
      for (const answer of waiting.values()) answer({ error: { message: 'The check ended' } });
      waiting.clear();
    };
    abort.signal.addEventListener('abort', close);
    try {
      await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = () => reject(new Error('The browser\'s CDP socket could not be opened'));
        abort.signal.addEventListener('abort', () => reject(new Error('The check took too long')));
      });
      let last = 0;
      socket.onmessage = (event) => {
        const reply = JSON.parse(String(event.data));
        waiting.get(reply.id)?.(reply);
        waiting.delete(reply.id);
      };
      const send = async (method: string, params: object, sessionId?: string): Promise<Record<string, unknown>> => {
        const id = ++last;
        const reply = await new Promise<CdpReply>((resolve) => {
          waiting.set(id, resolve);
          socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
        if (reply.error) throw new Error(`${method} failed: ${reply.error.message}`);
        return reply.result ?? {};
      };
      const id = await sourceMonkeyExtensionId();
      const listed = await send('Extensions.getExtensions', {}).then(
        (r) => (r.extensions as { id: string; enabled: boolean }[] | undefined)?.find((e) => e.id === id),
        () => undefined,
      );
      if (listed) return listed.enabled ? 'installed' : 'disabled';
      abort.signal.throwIfAborted();
      const { targetId } = await send('Target.createTarget', { url: 'about:blank', hidden: true }) as { targetId: string };
      try {
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
        const loaded = await send('Page.navigate', { url: `chrome-extension://${id}/manifest.json` }, sessionId);
        return loaded.errorText ? 'absent' : 'installed';
      } finally {
        // Closing the socket would close it too: the target belongs to
        // this connection.
        if (!abort.signal.aborted) await send('Target.closeTarget', { targetId }).catch(() => undefined);
      }
    } finally {
      close();
    }
  };
  try {
    return await probe();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** How `status` and the run's first lines say it. Empty when not known. */
export function extensionLabel(state: ExtensionState | null): string {
  return state === null ? '' : { installed: 'has SourceMonkey', disabled: 'SourceMonkey disabled', absent: 'no extension' }[state];
}

/** `findExtensionWorker` finding no SourceMonkey in the browser. */
export class ExtensionMissingError extends Error {}

const NOT_INSTALLED = 'SourceMonkey is not installed in this browser. Load it there as an unpacked extension, with Allow User Scripts on '
  + '(see https://github.com/jshute96/SourceMonkey/blob/main/docs/harness-guide.md#setting-it-up), or use --temp-browser, which loads it.';

// The extension's worker in this context, once its `self.SourceMonkey`
// surface is there. A worker can be listed before its module has run
// that far, most likely just after the browser starts.
export async function findExtensionWorker(ctx: BrowserContext, timeoutMs = 10000): Promise<Worker> {
  const deadline = Date.now() + timeoutMs;
  const worker = await listedWorker(ctx, timeoutMs);
  const ready = (): Promise<boolean> => worker.evaluate(() => typeof (self as unknown as { SourceMonkey?: unknown }).SourceMonkey !== 'undefined');
  while (!await ready()) {
    if (Date.now() > deadline) throw new Error(`SourceMonkey did not respond within ${Math.round(timeoutMs / 1000)} seconds`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return worker;
}

// The extension's worker, as listed. An idle worker is not listed, so
// when it is missing an extension page is opened to wake it: any page
// of the extension will do, and the collections page has the least
// side effects.
async function listedWorker(ctx: BrowserContext, timeoutMs: number): Promise<Worker> {
  const workerUrl = `chrome-extension://${await sourceMonkeyExtensionId()}/background.js`;
  const listed = (): Worker | undefined => ctx.serviceWorkers().find((w) => w.url() === workerUrl);
  const found = listed();
  if (found) return found;
  const page = await ctx.newPage();
  try {
    const deadline = Date.now() + timeoutMs;
    // A navigation to a page of an extension that isn't installed is
    // refused at once; that is the "not installed" answer.
    try {
      await page.goto(workerUrl.replace(/background\.js$/, 'collections.html'));
    } catch {
      throw new ExtensionMissingError(NOT_INSTALLED);
    }
    while (Date.now() < deadline) {
      const w = listed();
      if (w) return w;
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    await page.close().catch(() => undefined);
  }
  throw new Error(`SourceMonkey did not respond within ${Math.round(timeoutMs / 1000)} seconds`);
}

export class ExtensionBackend {
  constructor(private readonly worker: Worker) {}

  static async connect(ctx: BrowserContext): Promise<ExtensionBackend> {
    return new ExtensionBackend(await findExtensionWorker(ctx));
  }

  push(text: string, name?: string): Promise<PushResult> {
    return this.worker.evaluate(
      ([t, n]) => (self as unknown as { SourceMonkey: { writeScratchScript(a: { text: string; name?: string }): Promise<PushResult> } })
        .SourceMonkey.writeScratchScript({ text: t, name: n }),
      [text, name] as const,
    );
  }

  clear(): Promise<number> {
    return this.worker.evaluate(() =>
      (self as unknown as { SourceMonkey: { clearScratchScripts(): Promise<number> } }).SourceMonkey.clearScratchScripts());
  }

  solo(on: boolean): Promise<void> {
    return this.worker.evaluate(
      (flag) => (self as unknown as { SourceMonkey: { soloMode(o: boolean): Promise<void> } }).SourceMonkey.soloMode(flag),
      on,
    );
  }

  /** The script's Log tab entries. */
  log(scriptId: string): Promise<LogEntry[]> {
    return this.worker.evaluate(
      (id) => (self as unknown as { SourceMonkey: { getScriptLog(i: string): Promise<LogEntry[]> } }).SourceMonkey.getScriptLog(id),
      scriptId,
    );
  }
}
