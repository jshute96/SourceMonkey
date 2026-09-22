// The extension backend of `sm-dev run`: the real SourceMonkey in the
// connected browser, with the script pushed in as text rather than
// injected by the harness.
//
// The service worker's test surface (`self.SourceMonkey` in
// src/background.ts) does the work: `pushScript` installs the text into
// the Pushed scripts collection and registers it before it answers, a
// re-push replaces it in place, `soloMode` silences the user's other
// collections for the run, and the per-script log is what `run` prints
// as the script's reports. Playwright exposes the worker on a
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

// The extension's worker in this context. An idle worker is not
// listed, so when it is missing an extension page is opened to wake
// it: any page of the extension will do, and the collections page has
// the least side effects.
export async function findExtensionWorker(ctx: BrowserContext, timeoutMs = 10000): Promise<Worker> {
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
      throw new Error('SourceMonkey is not installed in this browser');
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
      ([t, n]) => (self as unknown as { SourceMonkey: { pushScript(a: { text: string; name?: string }): Promise<PushResult> } })
        .SourceMonkey.pushScript({ text: t, name: n }),
      [text, name] as const,
    );
  }

  clear(): Promise<number> {
    return this.worker.evaluate(() =>
      (self as unknown as { SourceMonkey: { clearPushedScripts(): Promise<number> } }).SourceMonkey.clearPushedScripts());
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
