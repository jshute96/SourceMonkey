// Capturing a page's DOM as a file a test can serve back.
//
// Shared by `sm-dev snapshot` (browser-commands.ts) and the fixture's
// `saveSnapshot`, so what a developer records by hand and what a test
// records are the same file.

import { writeFile } from 'node:fs/promises';

import type { Page } from '@playwright/test';

/**
 * The page's current DOM as a standalone HTML document.
 *
 * A `<base>` keeps relative URLs pointing at the site. The site's own
 * scripts are disabled (`type="text/plain"`, which keeps them readable
 * while the browser skips them): served again they would re-fetch,
 * redirect to a login, or rebuild the DOM the snapshot was taken to
 * preserve. What a clone cannot carry (typed form values, canvas
 * pixels, shadow roots) is not in the file either.
 */
export function capturePage(page: Page): Promise<string> {
  return page.evaluate((base) => {
    const doc = document.documentElement.cloneNode(true) as HTMLElement;
    const head = doc.querySelector('head');
    if (head && !head.querySelector('base')) {
      const el = document.createElement('base');
      el.href = base;
      head.prepend(el);
    }
    for (const script of doc.querySelectorAll('script')) script.setAttribute('type', 'text/plain');
    const doctype = document.doctype;
    const dt = doctype
      ? `<!DOCTYPE ${doctype.name}${doctype.publicId ? ` PUBLIC "${doctype.publicId}"` : ''}${doctype.systemId ? ` "${doctype.systemId}"` : ''}>`
      : '';
    return (dt ? dt + '\n' : '') + doc.outerHTML;
  }, page.url());
}

/** `capturePage`, written to `file`. Returns the HTML. */
export async function savePageSnapshot(page: Page, file: string): Promise<string> {
  const html = await capturePage(page);
  await writeFile(file, html);
  return html;
}
