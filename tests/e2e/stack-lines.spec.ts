// Stack lines from a script with a `@require`, as the extension logs
// them and `sm-dev --extension` prints them: the raw frames count lines
// in the injected entry (requires, then the script); the layout the
// service worker hands out maps them back to each file's own lines.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitFor } from '../fixtures/sw-api';
import { ExtensionBackend } from '../../lib/harness/extension-backend.js';
import { remapStackText } from '../../lib/stack-link.js';

test.describe('stack lines with @require', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('a logged throw maps to the require and the script line', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    // Line 2 of the library calls back into the script.
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), '// a library\nfunction libCall(fn) { return fn(); }\n');
    scriptsDir.write({
      relativePath: 'stacky.user.js',
      meta: {
        name: 'Stacky',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        extra: ['// @require     lib.js'],
      },
      // The metadata block is lines 1-6, so `throw` is on line 9.
      body: '\nlibCall(function thrown() {\n  throw new Error("thrown");\n});\n',
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const [scriptId] = (await sm.getCollections()).flatMap((c) => c.scriptIds);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const log = await waitFor(
      () => sm.getScriptLog(scriptId),
      (entries) => entries.some((e) => e.level === 'error' && e.message.includes('thrown')),
      { label: 'the throw reaches the script log' },
    );
    const raw = log.find((e) => e.level === 'error' && e.message.includes('thrown'))!.message;

    const backend = new ExtensionBackend(await getServiceWorker());
    const layout = await backend.stackLayout(scriptId);
    expect(layout).not.toBeNull();
    const mapped = remapStackText(raw, [layout!]);
    const root = 'sourcemonkey://SourceMonkey/stacky';
    expect(mapped, raw).toContain(`at thrown (${root}/stacky.user.js:9:`);
    expect(mapped, raw).toMatch(/at libCall \(sourcemonkey:\/\/SourceMonkey\/stacky\/file\/.*\/lib\.js:2:\d+\)/);
    // The raw frames really were off: that's what the mapping is for.
    expect(raw).not.toContain(`${root}/stacky.user.js:9:`);
    await page.close();
  });
});
