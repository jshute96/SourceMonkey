# Writing specs with the harness fixture

What you did by hand with sm-dev, captured as a Playwright spec.

```js
import { test, expect } from 'sourcemonkey/harness';

test('adds the button', async ({ page, loadUserscript, gm, reports }) => {
  await loadUserscript('sites/x/y.user.js', { values: { units: 'metric' } });
  await page.goto('https://x.com/items/42');
  await reports.waitForStart();                 // on a timeout (10s), says why it was skipped
  await page.click('#add-button');
  await expect(page.locator('.added')).toBeVisible();
  expect(await gm.get('lastItem')).toBe('42');
  expect(reports.errors()).toEqual([]);
});
```

- Run it with `pnpm exec playwright test sites/x/y.spec.mjs`, using the
  repo's own `playwright.config`. The script runs in the real
  SourceMonkey: by default a hidden browser per worker with the
  package's build loaded. A repo's fixture file may connect to its own
  browser instead, which needs SourceMonkey loaded.
- Call `loadUserscript` before the `page.goto` that should see it.
- What you did by hand maps over: `menu` → `gm.fireMenu(label)`,
  `values` / `get` / `set` → `gm.list()` / `gm.get()` / `gm.set()`,
  `--from-saved` → `serveHtml`, `match` →
  `loadUserscript(path, { url })` (throws on a miss).
- Specs are ES modules (`.mjs`, or `"type": "module"`).
- A `GM_xmlhttpRequest` really goes out unless the spec answers it:
  `await gm.interceptRequests(fn)`, or `await gm.failHosts('api.x.com')`
  for a 503 to exercise a fallback. Say at the top of a spec that depends on
  a live service.
- Check the script's side effects (`gm.openedTabs()`, `downloads()`,
  `requests()`, `notifications()`) with `expect.poll`: they arrive a
  moment after the call.
- A request to a host the script's `@connect` lines don't cover waits on
  SourceMonkey's prompt: answer it with
  `gm.answerConnectPrompt(gm.connectPrompts()[0].promptId, 'allow')`.
- `page.route` can serve made-up URLs (`https://x.test/big.png`) for
  tests with no site behind them. `loadUserscript(path, { url })` alone
  tests matching with no page load at all.
- Fixture reference:
  [harness-guide.md](https://github.com/jshute96/SourceMonkey/blob/main/docs/harness-guide.md#writing-specs-the-playwright-fixture)
  has the rest: `serveHtml` options, `copy`, `saveHtml`.
