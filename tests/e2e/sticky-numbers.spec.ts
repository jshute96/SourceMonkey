// Collection numbers (sm-dev's `C3`): the service worker hands them out,
// keeps them as other collections come and go, and holds a dropped
// collection's number back. The reconcile rules themselves are
// unit-tested (tests/unit/sticky-numbers.test.mjs); this checks the
// worker runs them on real collection rows.

import path from 'node:path';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('collection numbers', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('stay put as collections come and go, and a dropped one is not reused at once', async ({ sm }) => {
    const meta = { name: 'S', match: ['https://example.com/*'] };
    for (const dir of ['a', 'b', 'c']) scriptsDir.write({ relativePath: `${dir}/s.user.js`, meta, body: '' });
    const add = async (dir: string) => (await sm.addCollection(path.join(scriptsDir.path, dir)))!.id;

    const b = await add('b');
    expect(await sm.collectionNumbers()).toEqual({ [b]: 1 });
    // Sorting before `b` doesn't take its number.
    const a = await add('a');
    expect(await sm.collectionNumbers()).toEqual({ [b]: 1, [a]: 2 });

    // Dropped, `b`'s number is held, so the next collection skips it.
    await sm.removeCollection(b);
    const c = await add('c');
    expect(await sm.collectionNumbers()).toEqual({ [a]: 2, [c]: 3 });
  });
});
