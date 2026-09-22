// What a manager actually puts on the wire for a GM_xmlhttpRequest.
//
// Runs under the `sourcemonkey`, `tampermonkey`, and `violentmonkey`
// projects, so the same request is measured against each. The page
// can't see any of this: Origin, Referer and the `Sec-Fetch-*` set are
// forbidden to JS, so the fixture server's `/__echo` route reports
// them instead.
//
// This is the measurement behind issue #21 — endpoints that gate on
// `Sec-Fetch-Site` refuse anything a service worker sends, and the
// defaults we should adopt are whatever Tampermonkey adopted.
//
// The report is a test attachment (`wire-headers.txt`, visible in
// the HTML report) rather than console output, so a normal run stays
// quiet. Set `SM_PRINT_WIRE_HEADERS=1` to print it to the terminal.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Headers worth reporting: the forbidden ones a script can't set, plus
// the identity headers that reveal which context issued the request.
const OF_INTEREST = [
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
  'user-agent',
  'accept',
  'accept-language',
  'cookie',
];

test.describe('examples / gm-xmlhttp wire headers', () => {
  test('report the headers the manager sends', async ({
    extensionContext, fixtureServer, setup, manager,
  }) => {
    // The harness's request goes out from Node and carries none of the
    // browser's fetch metadata; what it sends is documented in
    // docs/harness-guide.md, and measuring it here would say nothing
    // about any manager.
    test.skip(manager === 'harness', 'The harness sends its request from Node, not from a browser context');
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gm-xmlhttp/gm-xmlhttp.html`);
    await page.waitForSelector('#runStatus');

    await page.locator('#url').fill(`${fixtureServer.baseUrl}/__echo`);
    await page.locator('#btn-send').click();
    // The body lands in the log entry; read it straight off the page
    // rather than parsing the panel's formatting.
    await page.waitForFunction(
      () => (document.querySelector('#log')?.textContent ?? '').includes('sec-fetch-site')
        || (document.querySelector('#log')?.textContent ?? '').includes('onerror'),
      undefined,
      { timeout: 15000 },
    );
    const text = (await page.locator('#log').textContent()) ?? '';
    const start = text.indexOf('{');
    const json = start >= 0 ? text.slice(start, text.lastIndexOf('}') + 1) : '';
    let headers: Record<string, string> = {};
    try {
      headers = (JSON.parse(json) as { headers: Record<string, string> }).headers;
    } catch {
      await page.close();
      // The values below are a report — they're whatever the manager
      // chose. Getting no readable answer at all is a failure, though:
      // a broken /__echo route or example page would otherwise show up
      // only as a line in a log nobody reads.
      throw new Error(`[${manager}] could not parse the echo body:\n${text.slice(0, 2000)}`);
    }
    expect(Object.keys(headers).length).toBeGreaterThan(0);
    const report = OF_INTEREST
      .map((h) => `  ${h}: ${headers[h] ?? '(absent)'}`)
      .join('\n');
    const body = `[${manager}] GM_xmlhttpRequest wire headers:\n${report}`;
    await test.info().attach('wire-headers.txt', { body, contentType: 'text/plain' });
    if (process.env.SM_PRINT_WIRE_HEADERS === '1') console.log(body);
    await page.close();
  });
});
