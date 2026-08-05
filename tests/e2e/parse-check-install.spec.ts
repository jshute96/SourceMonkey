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

  test('the error names the @require it is in, and the line', async ({ sm }) => {
    // The point of the whole location machinery. The reported line is
    // a line of the CONCATENATED program, which is not a file anyone
    // can open; this asserts it comes back as a line of the library
    // the user would actually go and edit.
    fs.writeFileSync(
      path.join(scriptsDir.path, 'lib.js'),
      'function ok() {\n  return 1;\n}\nlet broken = ;\n',
    );
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'BadRequire', match: ['https://example.com/*'], extra: ['// @require     lib.js'] },
      body: 'ok();',
    });
    const scripts = await installAndRead(sm);
    expect(scripts[0].status).toBe('invalid');
    expect(scripts[0].errorMessage).toMatch(/lib\.js/);
    expect(scripts[0].errorMessage).toMatch(/line 4\b/);
  });

  test('the error names the script itself when the body is at fault', async ({ sm }) => {
    // The no-`@require` layout, where the composed program is just the
    // body behind our preamble. Line 1 is the `// ==UserScript==`
    // marker, so a body error's line is offset by the whole header —
    // getting this wrong by even one line would be invisible without a
    // case that has a real header in front of it.
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'BadBody', match: ['https://example.com/*'] },
      body: 'var a = 1;\nvar b = 2;\nlet c = ;\n',
    });
    const scripts = await installAndRead(sm);
    expect(scripts[0].status).toBe('invalid');
    expect(scripts[0].errorMessage).toMatch(/main\.user\.js/);
    // Header + body: the `let c = ;` line, counted in the file the
    // user opens rather than in the program we built.
    const source = fs.readFileSync(path.join(scriptsDir.path, 'main.user.js'), 'utf8');
    const expected = source.split('\n').findIndex((l) => l.includes('let c = ;')) + 1;
    expect(expected).toBeGreaterThan(1);
    expect(scripts[0].errorMessage).toMatch(new RegExp(`line ${expected}\\b`));
  });

  test('a collision is blamed on the file that redeclares, not the first one', async ({ sm }) => {
    // Attribution across two `@require`s. V8 reports the duplicate at
    // the SECOND declaration, so the location has to resolve into
    // b.js — naming a.js would send the user to the innocent file.
    fs.writeFileSync(path.join(scriptsDir.path, 'a.js'), 'const shared = 1;\n');
    fs.writeFileSync(path.join(scriptsDir.path, 'b.js'), '// pad\nconst shared = 2;\n');
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
    expect(scripts[0].errorMessage).toMatch(/b\.js/);
    expect(scripts[0].errorMessage).not.toMatch(/a\.js/);
    expect(scripts[0].errorMessage).toMatch(/line 2\b/);
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

  test('an unchanged refresh reuses the verdict instead of re-compiling', async ({ sm }) => {
    // Re-compiling every script on every refresh would cost a round
    // trip each, so a passing verdict is cached against the content it
    // was made about. Counting actual compiles is the only assertion
    // that distinguishes a cache hit from a re-check — the row carries
    // a fingerprint either way.
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), 'const greet = 1;');
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'Cached', match: ['https://example.com/*'], extra: ['// @require     lib.js'] },
      body: 'void greet;',
    });
    await sm.addSource(scriptsDir.path);
    const sources = await sm.getSources();
    const afterInstall = await sm.getParseCheckRuns();
    expect(afterInstall, 'installing should compile once').toBeGreaterThan(0);

    // Nothing changed on disk, so neither refresh should compile.
    for (const mode of ['opportunistic', 'manual'] as const) {
      await sm.updateSource(sources[0].id, mode);
      expect(await sm.getParseCheckRuns(), `${mode} refresh re-compiled unchanged content`)
        .toBe(afterInstall);
      const after = (await sm.getSourceWithScripts(sources[0].id))!.scripts[0];
      expect(after.status).toBe('ok');
      expect(after.parseCheckedHash, `${mode} refresh should keep the fingerprint`).toBeTruthy();
    }

    // ...but a real edit must be re-checked, or the cache would hide
    // a newly-introduced syntax error forever.
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'Cached', match: ['https://example.com/*'], extra: ['// @require     lib.js'] },
      body: 'void greet; const added = 2; void added;',
    });
    await sm.updateSource(sources[0].id, 'manual');
    expect(await sm.getParseCheckRuns(), 'a changed body must be re-compiled')
      .toBeGreaterThan(afterInstall);
  });

  test('an opportunistic refresh checks a newly-broken body', async ({ sm }) => {
    // The opportunistic path short-circuits the dependency work when
    // the `@require` list is unchanged — which is the common case, and
    // says nothing about the BODY. If the check sits after that
    // short-circuit, a background refresh silently stores a body with
    // a syntax error and reports the script healthy until someone
    // visits a page it matches.
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), 'const greet = 1;');
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'OppEdit', match: ['https://example.com/*'], extra: ['// @require     lib.js'] },
      body: 'void greet;',
    });
    await sm.addSource(scriptsDir.path);
    const sources = await sm.getSources();
    expect((await sm.getSourceWithScripts(sources[0].id))!.scripts[0].status).toBe('ok');

    // Body edited, `@require` list untouched.
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'OppEdit', match: ['https://example.com/*'], extra: ['// @require     lib.js'] },
      body: 'void greet; const broken = (;',
    });
    await sm.updateSource(sources[0].id, 'opportunistic');
    const after = (await sm.getSourceWithScripts(sources[0].id))!.scripts[0];
    expect(after.status).toBe('invalid');
    expect(after.errorMessage).toMatch(/syntax error/i);
  });

  test('a @require edit alone invalidates the cached verdict', async ({ sm }) => {
    // The fingerprint covers each require's content hash, not just the
    // body's. A cache keyed on the body alone would keep calling this
    // script healthy after its library broke.
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), 'const greet = 1;');
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'ReqEdit', match: ['https://example.com/*'], extra: ['// @require     lib.js'] },
      body: 'void greet;',
    });
    await sm.addSource(scriptsDir.path);
    const sources = await sm.getSources();
    expect((await sm.getSourceWithScripts(sources[0].id))!.scripts[0].status).toBe('ok');

    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), 'const greet = (;');
    await sm.updateSource(sources[0].id, 'manual');
    const after = (await sm.getSourceWithScripts(sources[0].id))!.scripts[0];
    expect(after.status).toBe('invalid');
    expect(after.errorMessage).toMatch(/syntax error/i);
  });

  test('an invalid row records no fingerprint, so a fix is always re-checked', async ({ sm }) => {
    // A cached pass on a broken row would be a script that stays
    // broken after being fixed; a cached FAIL would be worse still.
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'NoStaleCache', match: ['https://example.com/*'] },
      body: 'const x = (;',
    });
    await sm.addSource(scriptsDir.path);
    const sources = await sm.getSources();
    const broken = (await sm.getSourceWithScripts(sources[0].id))!.scripts[0];
    expect(broken.status).toBe('invalid');
    expect(broken.parseCheckedHash).toBeUndefined();
  });

  test('an inconclusive check leaves the script alone', async ({ sm }) => {
    // The invariant, at the level that matters: only V8 saying
    // "SyntaxError" may disable a script. This body is valid
    // JavaScript that exhausts the parser's recursion budget in the
    // sandbox — a budget the real injection doesn't share — so the
    // check comes back `unknown` and the row must stay `ok`.
    //
    // The same path covers the failure that can't be tested for: a
    // sandbox that lost its CSP would throw EvalError on EVERY script,
    // and treating that as a syntax error would disable all of them at
    // once.
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'DeeplyNested', match: ['https://example.com/*'] },
      body: `void ${'('.repeat(100_000)}1${')'.repeat(100_000)};`,
    });
    const scripts = await installAndRead(sm);
    expect(scripts[0].status).toBe('ok');
    expect(scripts[0].errorMessage).toBeUndefined();
    // ...and an inconclusive verdict must not be cached as a pass, or
    // the script would never be re-checked once the cause cleared.
    expect(scripts[0].parseCheckedHash).toBeUndefined();
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
