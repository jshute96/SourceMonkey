// Finding the real SourceMonkey in sm-dev's browser: whether it is
// installed and turned on, and its service worker, which every call
// into it goes through (extension-link.ts). Playwright exposes the
// worker on a CDP-connected browser as well as a launched one, so the
// same `worker.evaluate` reaches it either way.

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
  const manifest = await readManifest();
  if (typeof manifest.key !== 'string') throw new Error('Internal error: the manifest has no key to derive the extension id from');
  cachedId = extensionIdFromKey(manifest.key);
  return cachedId;
}

/** The origin of the extension's pages and worker: `chrome-extension://<id>`. */
export async function sourceMonkeyOrigin(): Promise<string> {
  return `chrome-extension://${await sourceMonkeyExtensionId()}`;
}

/**
 * Whether `url` is the extension's service worker. Matched by origin,
 * not path: an extension has one worker, and its path differs between
 * builds (it moved into extension/), so a browser's older build is still
 * found and told it is too old rather than timing out.
 */
export function isSourceMonkeyWorker(url: string, origin: string): boolean {
  return url.startsWith(`${origin}/`);
}

async function readManifest(): Promise<{ key?: unknown }> {
  return JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
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
  const origin = await sourceMonkeyOrigin();
  const listed = (): Worker | undefined => ctx.serviceWorkers().find((w) => isSourceMonkeyWorker(w.url(), origin));
  const found = listed();
  if (found) return found;
  const page = await ctx.newPage();
  try {
    const deadline = Date.now() + timeoutMs;
    // A navigation to a page of an extension that isn't installed is
    // refused at once; that is the "not installed" answer.
    try {
      await page.goto(`${origin}/collections.html`);
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
