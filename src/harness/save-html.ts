// Saving a page's DOM as a file, with a header saying where it came
// from; and reading that header back (see saved-pages.ts for serving
// the file).
//
// Shared by the `savehtml` run command (page-commands.ts) and the
// fixture's `saveHtml`, so a developer recording a page by hand and a
// test recording one produce the same file.

import { writeFile } from 'node:fs/promises';

import type { Page } from '@playwright/test';

import { preparedScriptName, type PreparedScript } from './prepare.js';

// The header lines a saved file starts with, after its doctype. The
// URL line is the "saved from" comment Internet Explorer's Mark of the
// Web introduced, and Chrome's Save Page As still writes, so a page
// saved from the browser's menu is read the same way. The number is
// the URL's length, which nothing here relies on.
const SAVED_FROM = /<!--\s*saved from url=\(\d+\)(\S+?)\s*-->/i;
const USERSCRIPT_PREFIX = 'SourceMonkey: userscript active: ';
const USERSCRIPT_LINE = new RegExp(`<!-- ${USERSCRIPT_PREFIX}(.*?) -->`, 'g');

/** How a userscript is named in a saved file's header: its @name and @version. */
export function userscriptLabel(script: PreparedScript): string {
  const version = (script.script.header?.tags ?? []).find((t) => t.tag === 'version')?.value;
  return version ? `${preparedScriptName(script)} ${version}` : preparedScriptName(script);
}

/**
 * The page's current DOM as a standalone HTML document.
 *
 * A `<base>` keeps relative URLs pointing at the site. The page's own
 * JavaScript is disabled (`type="text/plain"`, which keeps it readable
 * while the browser skips it): served again it would re-fetch,
 * redirect to a login, or rebuild the DOM the file was saved to
 * preserve. What a clone cannot carry (typed form values, canvas
 * pixels, shadow roots) is not in the file either.
 *
 * The header records the page's URL, for `--from-saved` to serve it
 * there, and each of `userscripts` (see `userscriptLabel`), the ones
 * running in the page, whose changes are in the file.
 */
export async function pageHtml(page: Page, userscripts: string[] = []): Promise<string> {
  const url = page.url();
  const { doctype, body } = await page.evaluate((base) => {
    const doc = document.documentElement.cloneNode(true) as HTMLElement;
    const head = doc.querySelector('head');
    if (head && !head.querySelector('base')) {
      const el = document.createElement('base');
      el.href = base;
      head.prepend(el);
    }
    for (const script of doc.querySelectorAll('script')) script.setAttribute('type', 'text/plain');
    const dt = document.doctype;
    return {
      doctype: dt
        ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ''}${dt.systemId ? ` "${dt.systemId}"` : ''}>`
        : '',
      body: doc.outerHTML,
    };
  }, url);
  return [...(doctype ? [doctype] : []), ...savedHeaderLines(url, userscripts), body].join('\n');
}

/**
 * The header comment lines for a page saved from `url` with
 * `userscripts` running. Only `-->` (or `--!>`) ends a comment, and a
 * URL the browser reports has any `>` percent-encoded, so the URL goes
 * in as it is (`xn--` hosts included). A name gets its `>` escaped
 * after `--`, which no real name has.
 */
export function savedHeaderLines(url: string, userscripts: string[]): string[] {
  return [
    `<!-- saved from url=(${String(url.length).padStart(4, '0')})${url} -->`,
    ...userscripts.map((name) => `<!-- ${USERSCRIPT_PREFIX}${name.replace(/--(!?)>/g, '--$1&gt;')} -->`),
  ];
}

/** `pageHtml`, written to `file`. Returns the HTML. */
export async function savePageHtml(page: Page, file: string, userscripts: string[] = []): Promise<string> {
  const html = await pageHtml(page, userscripts);
  await writeFile(file, html);
  return html;
}

/** What a saved file's header says: its URL, if any, and the userscripts that were active. */
export interface SavedPageHeader {
  url: string | null;
  userscripts: string[];
}

/**
 * Reads a saved file's header. Only what comes before `<html` is
 * looked at, so a comment in the page's own content never counts.
 */
export function readSavedHeader(html: string): SavedPageHeader {
  const end = html.search(/<html[\s>]/i);
  const head = end >= 0 ? html.slice(0, end) : html;
  return {
    url: SAVED_FROM.exec(head)?.[1] ?? null,
    userscripts: [...head.matchAll(USERSCRIPT_LINE)].map((m) => m[1]),
  };
}
