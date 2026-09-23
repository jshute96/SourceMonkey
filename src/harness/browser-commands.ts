// `sm-dev probe` and `sm-dev snapshot`: the two browser commands that
// need no userscript at all. Both connect the way `run` does (see
// run.ts) and print plain text.

import path from 'node:path';

import { savePageSnapshot } from './capture-page.js';
import { connectBrowser, type ConnectOptions } from './run.js';

export interface ProbeOptions extends ConnectOptions {
  url: string;
  selectors: string[];
  /** Print the first match's outer HTML (truncated). */
  html?: boolean;
  out: (line: string) => void;
}

// Which of a script's assumed selectors still resolve on a page. This
// is the triage step a broken script's doc asks for, in one call: the
// first selector that finds nothing is where the site changed.
export async function probe(opts: ProbeOptions): Promise<number> {
  const session = await connectBrowser(opts, opts.out);
  if (!session) return 1;
  const { page, done } = session;
  try {
    try {
      await page.goto(opts.url);
    } catch (err) {
      opts.out(`[sm-dev] navigation failed: ${(err as Error).message}`);
      return 1;
    }
    // Give a client-rendered page a moment; the developer can re-run
    // if the site is slower than this.
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    let missing = 0;
    for (const selector of opts.selectors) {
      // A rejection here is almost always a selector Chrome can't
      // parse; a page that went away mid-probe reads the same, which
      // is an acceptable blur for a triage tool.
      const count = await page.locator(selector).count().catch(() => -1);
      if (count < 0) {
        missing++;
        opts.out(`invalid  ${selector}`);
        continue;
      }
      if (count === 0) {
        missing++;
        opts.out(`missing  ${selector}`);
        continue;
      }
      opts.out(`found    ${selector}  (${count})`);
      if (opts.html) {
        const html = await page.locator(selector).first().evaluate((el) => el.outerHTML).catch(() => '');
        opts.out(`    ${html.length > 500 ? html.slice(0, 500) + '…' : html}`);
      }
    }
    return missing === 0 ? 0 : 1;
  } finally {
    // One-shot: the tab has no further use, unlike `run`'s, which is
    // left for the developer to look at.
    await page.close().catch(() => undefined);
    await done();
  }
}

export interface SnapshotOptions extends ConnectOptions {
  url: string;
  outFile: string;
  out: (line: string) => void;
}

// The live DOM as HTML, for a spec to serve back at the original URL
// (`serveSnapshot` in the fixture) so it needs no login. What the file
// holds, and what it cannot, is described on `capturePage`.
export async function snapshot(opts: SnapshotOptions): Promise<number> {
  const session = await connectBrowser(opts, opts.out);
  if (!session) return 1;
  const { page, done } = session;
  try {
    try {
      await page.goto(opts.url);
    } catch (err) {
      opts.out(`[sm-dev] navigation failed: ${(err as Error).message}`);
      return 1;
    }
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    let html: string;
    try {
      html = await savePageSnapshot(page, opts.outFile);
    } catch (err) {
      opts.out(`[sm-dev] could not write ${opts.outFile}: ${(err as Error).message}`);
      return 1;
    }
    const rel = path.relative(process.cwd(), opts.outFile);
    const shown = rel && !rel.startsWith('..') ? rel : opts.outFile;
    opts.out(`[sm-dev] wrote ${shown} (${html.length} chars) from ${page.url()}`);
    return 0;
  } finally {
    await page.close().catch(() => undefined);
    await done();
  }
}
