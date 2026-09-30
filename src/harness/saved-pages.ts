// Serving a saved page (from save-html.ts, or a browser's own Save Page
// As) back at the URL it was saved from, so scripts match and run on it
// as on the live site.
//
// Shared by `--from-saved` on `start`, `open` and `newtab`
// (console-commands.ts, run.ts, cli.ts) and the fixture's `serveHtml`,
// so both serve one the same way.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CDPSession, Page, Request } from '@playwright/test';

import { UsageError } from './checks.js';
import { isDirectoryMessage, noSuchFileMessage } from './prepare.js';
import { readSavedHeader, type SavedPageHeader } from './save-html.js';

/**
 * The browser reports `https://example.test` as `https://example.test/`
 * and never reports a fragment, so both sides are normalized the same
 * way before comparing.
 */
export function comparableUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    return u.href;
  } catch {
    return raw;
  }
}

/** What `routeSavedPage` serves, as it stands when a request is made. */
export interface SavedPageServe {
  /** The URL the page answers, matched exactly, query string included, fragment ignored. */
  url: string;
  /** The page's HTML. Read per request, so an edited file is served on the next load. */
  html: () => Promise<string>;
  /** Other requests to abort, rather than send on. */
  block?: (request: Request) => boolean;
  /** How the file is named when it can't be read. */
  name: string;
  /** Told why, when the file can't be read; the page shows it too. */
  onError?: (message: string) => void;
  /** The files saved beside the page, served from disk (see `companionFiles`). */
  companion?: CompanionFiles;
}

/**
 * The folder a browser's "Webpage, Complete" save puts beside the page
 * (Chrome and Firefox both name it `<name>_files`), and the URL its
 * files are asked for at: the page links them relatively
 * (`./<name>_files/app.css`), so they resolve against the page's URL.
 */
export interface CompanionFiles {
  /** The folder's URL path, decoded, on `origin`. */
  origin: string;
  path: string;
  dir: string;
}

/** The companion folder for a saved `file` served at `url`, whether or not it exists. */
export function companionFiles(file: string, url: string): CompanionFiles | undefined {
  const stem = path.basename(file).replace(/\.x?html?$/i, '');
  let at: URL;
  try {
    // Built by the URL parser, so it's encoded as the browser encodes
    // the page's own relative links.
    at = new URL(`./${stem}_files/`, url);
  } catch {
    return undefined;
  }
  // Resolved, so the check that a request stays inside it compares like with like.
  return { origin: at.origin, path: decodedPath(at) ?? at.pathname, dir: path.resolve(path.dirname(file), `${stem}_files`) };
}

// Where on disk a request for a companion file is, or null when it
// isn't one. Never outside the folder, whatever `..` the URL has.
function companionPath(companion: CompanionFiles, raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const wanted = decodedPath(url);
  if (url.origin !== companion.origin || !wanted?.startsWith(companion.path)) return null;
  const file = path.resolve(companion.dir, wanted.slice(companion.path.length));
  return file.startsWith(companion.dir + path.sep) ? file : null;
}

function decodedPath(url: URL): string | null {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

// By extension: a stylesheet or module script served with the wrong
// type is refused. Anything else is left for the browser to sniff.
const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.html': 'text/html', '.htm': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

/**
 * Serves `current()` on `page`: its URL gets its HTML, and every other
 * request falls through to the page's other routes and the network,
 * unless `block` says to abort it. Undefined serves nothing, so a
 * caller can change or end what is served without routing again.
 */
export async function routeSavedPage(page: Page, current: () => SavedPageServe | undefined): Promise<void> {
  await bypassServiceWorker(page);
  await page.route('**/*', async (route) => {
    const saved = current();
    const request = route.request();
    if (saved && comparableUrl(request.url()) === comparableUrl(saved.url)) {
      let body: string;
      try {
        body = await saved.html();
      } catch (err) {
        // Shown as the page too, where the person is looking.
        const message = savedReadMessage(saved.name, err as NodeJS.ErrnoException);
        saved.onError?.(message);
        await route.fulfill({ status: 500, contentType: 'text/plain; charset=utf-8', body: message });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
      return;
    }
    // A file saved beside the page, while it shows, even with
    // `--offline`. One that isn't there is a 404, not the live site's:
    // the site never had it at that URL.
    const showing = saved !== undefined && comparableUrl(page.url()) === comparableUrl(saved.url);
    const local = showing && saved.companion ? companionPath(saved.companion, request.url()) : null;
    if (local) {
      const body = await readFile(local).catch(() => null);
      const type = CONTENT_TYPES[path.extname(local).toLowerCase()];
      await route.fulfill(body ? { status: 200, body, ...(type ? { contentType: type } : {}) } : { status: 404, body: '' });
      return;
    }
    if (saved?.block?.(request)) {
      await route.abort();
      return;
    }
    // `fallback`, not `continue`: Playwright runs route handlers newest
    // first, and only `fallback` hands a request to the next one. That
    // lets a second saved page, or a HAR, sit beside this route.
    await route.fallback();
  });
}

/**
 * For `--offline`: blocks the requests a page makes while it shows the
 * saved page at `url`. A load of a new page is never blocked, so
 * following a link off it still works.
 */
export function offlineBlock(page: Page, url: string): (request: Request) => boolean {
  return (request) => {
    if (comparableUrl(page.url()) !== comparableUrl(url)) return false;
    try {
      return !(request.isNavigationRequest() && request.frame() === page.mainFrame());
    } catch {
      // A service worker's request has no frame.
      return true;
    }
  };
}

/**
 * A saved page as sm-dev serves it in a tab: `file` at `url`, `offline`
 * blocking the rest. `given`: the file as it was named, for messages.
 */
export interface SavedPageFile {
  file: string;
  given: string;
  url: string;
  offline: boolean;
}

/**
 * What `routeSavedPage` serves for `saved` in `page`, for `--from-saved`
 * with the harness or the extension: the file read fresh on each load,
 * and a read failure told to `out` as well as shown.
 */
export function savedPageServe(page: Page, saved: SavedPageFile, out: (line: string) => void): SavedPageServe {
  return {
    url: saved.url,
    html: () => readFile(saved.file, 'utf8'),
    block: saved.offline ? offlineBlock(page, saved.url) : undefined,
    name: saved.given,
    onError: (message) => out(`[sm-dev] ${message}`),
    companion: companionFiles(saved.file, saved.url),
  };
}

/** How `start`, `open` and `newtab` say a tab is loading a saved page. */
export function openingSavedLine(given: string, url: string, tab: string): string {
  return `[sm-dev] Opening ${given} as ${url} in ${tab}`;
}

/** `--offline` without `--from-saved`. */
export const OFFLINE_NEEDS_SAVED = 'The --offline flag goes with --from-saved';

/** `--url` without `--from-saved` and exactly one saved page. */
export const URL_NEEDS_ONE_SAVED = 'The --url flag gives the URL for one saved page, so it goes with --from-saved and a single .html file';

/** `--from-saved` with no page to open from a file. */
export const NO_SAVED_FILE = 'The --from-saved flag opens .html files, and none was given';

/** How sm-dev's commands say to give a URL for a saved page. */
export const GIVE_SAVED_URL = 'Open it by itself, with --url.';

/**
 * The URL to serve a saved page at: `url`, else the one its header
 * records. Or why there is none: no URL anywhere, or one a route
 * can't answer (`about:blank`, `file://`). `remedy` is a sentence
 * saying how to give one where it was named.
 */
export function savedPageUrl(given: string, header: SavedPageHeader, url: string | undefined, remedy: string): { url: string } | { problem: string } {
  const at = url ?? header.url;
  if (!at) return { problem: `${given} does not say what URL it was saved from. ${remedy}` };
  if (!/^https?:/i.test(at)) return { problem: `${given} can only be served at an http or https URL, not ${at}. ${remedy}` };
  return { url: at };
}

/** A saved page to open (`--from-saved`), with the userscripts its header lists. */
export type SavedPageStart = SavedPageFile & { userscripts: string[] };

/** One page a command opens: a URL, or with `saved`, a saved page served at it. */
export interface PageToOpen {
  url: string;
  saved?: SavedPageStart;
}

/** A page a command was given: the word as typed, and the URL it stands for. */
export interface PageWord {
  word: string;
  url: string;
}

/**
 * With `--from-saved` (`fromSaved`): each word naming a local `.html`
 * file is a saved page, at the URL it records or `--url`; the others
 * stay URLs. Without, `--url` and `--offline` are refused. Throws a
 * `UsageError` naming the file for any saved page that can't be opened,
 * before anything opens.
 */
export async function pagesToOpen(
  words: PageWord[], opts: { fromSaved: boolean; url?: string; offline: boolean }, cwd = process.cwd(),
): Promise<PageToOpen[]> {
  if (!opts.fromSaved) {
    if (opts.url !== undefined) throw new UsageError(URL_NEEDS_ONE_SAVED);
    if (opts.offline) throw new UsageError(OFFLINE_NEEDS_SAVED);
    return words.map(({ url }) => ({ url }));
  }
  const files = words.map((w) => savedPageFile(w, cwd));
  const count = files.filter(Boolean).length;
  if (count === 0) throw new UsageError(NO_SAVED_FILE);
  if (opts.url !== undefined && count > 1) throw new UsageError(URL_NEEDS_ONE_SAVED);
  return Promise.all(words.map(async ({ word, url }, i): Promise<PageToOpen> => {
    const file = files[i];
    if (!file) return { url };
    let header: SavedPageHeader;
    try {
      ({ header } = await loadSavedPage(file));
    } catch (err) {
      // A name that's no file is a mistake in the command; one that
      // can't be read for another reason isn't.
      const code = (err as NodeJS.ErrnoException).code;
      const message = savedReadMessage(word, err as NodeJS.ErrnoException);
      throw code === 'ENOENT' || code === 'EISDIR' ? new UsageError(message) : new Error(message);
    }
    const found = savedPageUrl(word, header, opts.url, GIVE_SAVED_URL);
    if ('problem' in found) throw new UsageError(found.problem);
    return { url: found.url, saved: { file, given: word, url: found.url, offline: opts.offline, userscripts: header.userscripts } };
  }));
}

// The file a page names, when it's a local `.html` file: what
// `--from-saved` serves. A word ending `.html` with no `://` is one
// even where it would read as a host (`pgae.html`), so a typo is
// said to be no file rather than opened live; `localhost:8080/x.html`
// keeps its port, and so its host.
function savedPageFile({ word, url }: PageWord, cwd: string): string | null {
  if (url.startsWith('file:')) return /\.x?html?$/i.test(url) ? fileURLToPath(url) : null;
  const first = word.split('/')[0];
  if (word.includes('://') || /:\d+$/.test(first) || !/\.x?html?$/i.test(word)) return null;
  return path.resolve(cwd, word);
}

// A site's service worker answers its requests before Playwright's
// routes see them, so a site that has one would get its live page
// instead of the saved one. Bypassing it takes the network domain
// enabled on a session of our own, kept for the page's life. Best
// effort: a browser that refuses still serves pages without one.
const bypassed = new WeakMap<Page, Promise<CDPSession | null>>();

function bypassServiceWorker(page: Page): Promise<CDPSession | null> {
  let session = bypassed.get(page);
  if (!session) {
    session = (async () => {
      try {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.setBypassServiceWorker', { bypass: true });
        return cdp;
      } catch {
        return null;
      }
    })();
    bypassed.set(page, session);
  }
  return session;
}

/** Reads a saved file for serving, with its header. */
export async function loadSavedPage(file: string): Promise<{ html: string; header: SavedPageHeader }> {
  const html = await readFile(file, 'utf8');
  return { html, header: readSavedHeader(html) };
}

/** Why a saved page named with `--from-saved` could not be read. */
export function savedReadMessage(given: string, err: NodeJS.ErrnoException): string {
  if (err.code === 'ENOENT') return noSuchFileMessage(given);
  if (err.code === 'EISDIR') return isDirectoryMessage(given, 'Name a saved .html file.');
  if (err.code === 'EACCES') return `The saved page ${given} could not be read: Permission denied`;
  return `The saved page ${given} could not be read: ${err.message}`;
}
