// Syntax errors are caught at install / refresh time and reported as
// `invalid`, instead of being discovered at injection time on some page
// the script happened to match.
//
// The mechanism is covered by `parse-check.spec.ts`; this is about what
// a user sees. Before this, a `@require` with a syntax error made the
// whole concatenated entry fail to parse, and the only signal was a
// run-time log line ("a @require or the script body has a syntax
// error") that appeared once you visited a matching page — and named
// neither file.
//
// The asymmetry is what most of these cases are about. A false
// "didn't parse" would disable a working script, so the accept-side
// cases matter at least as much as the reject-side ones.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer } from '../fixtures/userscript-server';

test.describe('parse check at install time', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  async function installAndRead(sm: {
    addSource: (p: string) => Promise<unknown>;
    getSources: () => Promise<{ id: string }[]>;
    getSourceWithScripts: (id: string) => Promise<{ scripts: {
      id: string; status: string; errorMessage?: string; relativePath: string;
    }[] } | null>;
  }) {
    await sm.addSource(scriptsDir.path);
    const sources = await sm.getSources();
    const withScripts = await sm.getSourceWithScripts(sources[0].id);
    return withScripts!.scripts;
  }

  test('a @require with a syntax error flips the script to invalid at install', async ({ sm }) => {
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), 'function ok() {\n/* unterminated');
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'BadRequire', match: ['https://example.com/*'], extra: ['// @require     lib.js'] },
      body: 'ok();',
    });
    const scripts = await installAndRead(sm);
    expect(scripts).toHaveLength(1);
    expect(scripts[0].status).toBe('invalid');
    expect(scripts[0].errorMessage).toMatch(/syntax error/i);
  });

  test('a syntax error in the script body itself is caught too', async ({ sm }) => {
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'BadBody', match: ['https://example.com/*'] },
      body: 'const x = (;',
    });
    const scripts = await installAndRead(sm);
    expect(scripts[0].status).toBe('invalid');
    expect(scripts[0].errorMessage).toMatch(/syntax error/i);
  });

  test('a collision between two @requires is caught, though each parses alone', async ({ sm }) => {
    // The case that per-file checking would miss, and the reason the
    // check runs against the composed program. Each library is valid
    // JavaScript; concatenating them is a duplicate `const`.
    fs.writeFileSync(path.join(scriptsDir.path, 'a.js'), 'const shared = 1;');
    fs.writeFileSync(path.join(scriptsDir.path, 'b.js'), 'const shared = 2;');
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'Collide',
        match: ['https://example.com/*'],
        extra: ['// @require     a.js', '// @require     b.js'],
      },
      body: 'void shared;',
    });
    const scripts = await installAndRead(sm);
    expect(scripts[0].status).toBe('invalid');
    expect(scripts[0].errorMessage).toMatch(/already been declared/i);
  });

  test('a healthy script with @requires stays ok', async ({ sm }) => {
    // The accept side. A false rejection here disables working code,
    // so this is the case that must never regress.
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), 'const greet = (n) => `hi ${n}`;');
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'Good', match: ['https://example.com/*'], extra: ['// @require     lib.js'] },
      body: 'void greet("world");',
    });
    const scripts = await installAndRead(sm);
    expect(scripts[0].status).toBe('ok');
    expect(scripts[0].errorMessage).toBeUndefined();
  });

  test('a granted script is checked in the scope it actually runs in', async ({ sm }) => {
    // The GM bindings are `const` declarations in the same scope as the
    // user program, so a library redeclaring one is a genuine parse
    // failure at injection time. Checking the user source alone would
    // call this healthy.
    fs.writeFileSync(
      path.join(scriptsDir.path, 'lib.js'),
      'const unsafeWindow = window.wrappedJSObject || window;',
    );
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'Collides with a binding',
        match: ['https://example.com/*'],
        extra: ['// @grant       unsafeWindow', '// @require     lib.js'],
      },
      body: 'void unsafeWindow;',
    });
    const scripts = await installAndRead(sm);
    expect(scripts[0].status).toBe('invalid');
    expect(scripts[0].errorMessage).toMatch(/already been declared/i);
  });

  test('a top-level return is accepted — the entry is a function body', async ({ sm }) => {
    // Legal where the code actually lands, and a SyntaxError if judged
    // as a standalone program. A checker that got this backwards would
    // disable working scripts; real userscripts use it to bail early.
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'EarlyReturn', match: ['https://example.com/*'] },
      body: 'if (!document.body) return;\nvoid 0;',
    });
    const scripts = await installAndRead(sm);
    expect(scripts[0].status).toBe('ok');
  });

  test('a broken script recovers to ok when the source is fixed', async ({ sm }) => {
    // The verdict is cached by content fingerprint, so the recovery
    // path is where a stale cache would show up as a script that stays
    // broken after being fixed.
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'Recovers', match: ['https://example.com/*'] },
      body: 'const x = (;',
    });
    await sm.addSource(scriptsDir.path);
    const sources = await sm.getSources();
    let scripts = (await sm.getSourceWithScripts(sources[0].id))!.scripts;
    expect(scripts[0].status).toBe('invalid');

    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'Recovers', match: ['https://example.com/*'] },
      body: 'const x = 1;\nvoid x;',
    });
    await sm.updateSource(sources[0].id, 'manual');
    scripts = (await sm.getSourceWithScripts(sources[0].id))!.scripts;
    expect(scripts[0].status).toBe('ok');
    expect(scripts[0].errorMessage).toBeUndefined();
  });

  test('an http refresh that returns a broken body keeps the prior good copy running', async ({ sm }) => {
    // Existing soft-failure policy, which the parse check now feeds:
    // an http 200 that doesn't parse is usually a login or error page
    // served in place of the script, not a real content change. The
    // working copy must keep running, flagged as REFRESH FAILED.
    const server = await UserscriptServer.start();
    try {
      const good = [
        '// ==UserScript==',
        '// @name        HttpParse',
        '// @match       https://example.com/*',
        '// ==/UserScript==',
        'const v = 1;',
        '',
      ].join('\n');
      server.setRoute('/main.user.js', good);
      const source = await sm.addSource(`${server.baseUrl}/main.user.js`);
      let scripts = (await sm.getSourceWithScripts(source!.id))!.scripts;
      expect(scripts[0].status).toBe('ok');

      server.setRoute('/main.user.js', `${good}\nconst broken = (;`);
      await sm.updateSource(source!.id, 'manual');
      scripts = (await sm.getSourceWithScripts(source!.id))!.scripts;
      expect(scripts[0].status).toBe('ok');
      expect(scripts[0].refreshError).toMatch(/not a valid userscript|syntax/i);
    } finally {
      await server.stop();
    }
  });
});
