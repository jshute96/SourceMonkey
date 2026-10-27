# SourceMonkey developer tools for userscripts

Develop, test and debug userscripts in a real browser, running in the
real [SourceMonkey](https://github.com/jshute96/SourceMonkey) extension,
using real `GM_*` APIs and other features.

Use these tools with coding agents (like Claude Code) to enable fully agentic
userscript development.

This package includes:

- **`sm-dev` command-line tool**
  - Run a userscript against a live page and watch what it does.
  - Or run against a saved page snapshot (for example, on pages that require login).
  - Drive and inspect the page, and read userscript state and stored values.
  - Run and manage scripts under Tampermonkey or Violentmonkey too.
- **A Playwright test fixture**
  - Write tests that load userscripts on a page, and check for expected results.
  - Test against live pages or snapshots.
  - Catch changes on the live page that break your scripts.
- **Agent skills**
  - Use with coding agents, so they can develop, test and debug
    userscripts using `sm-dev`, against live pages or snapshots.

## Install

Needs Node 22 or newer.

In a repo of userscripts, install it with Playwright, and the Chromium
build Playwright drives:

```sh
pnpm add -D sourcemonkey @playwright/test
pnpm exec playwright install chromium
pnpm sm-dev --help
```

Or run `sm-dev` without installing anything:

```sh
npx sm-dev --help
```

Commands that launch a browser require Chromium. They'll report the command
to install the required version, if it's not already installed.

## Run a script

```sh
pnpm sm-dev start path/script.user.js [http://example.com]
```

This launches a browser with SourceMonkey loaded, loads the script,
and opens the given URL (or the script's `@match` target page, by default).
This streams the page's console, and lets you interact with the
page and the loaded userscripts.

At the prompt:

```
> status              # Browser info, loaded scripts, and tab status
> snapshot --visible  # What's on screen, with element refs (e12)
> click e12           # Click one, and wait for the page to settle
> menu                # The script's menu commands
> values              # What the script stored
> help                # See other commands
```

## Write a test

```js
import { test, expect } from 'sourcemonkey/harness';

test('adds the button to the toolbar', async ({ page, loadUserscript, gm, reports }) => {
  await loadUserscript('sites/example.com/add-button.user.js');
  await page.goto('https://example.com/items/42');
  await reports.waitForStart();
  await expect(page.locator('#add-button')).toBeVisible();
  expect(await gm.get('lastItem')).toBe('42');
});
```

## More

- [The SourceMonkey extension](https://github.com/jshute96/SourceMonkey):
  the default userscript manager these tools use.
- [Harness guide](https://github.com/jshute96/SourceMonkey/blob/main/docs/harness-guide.md):
  details on setup, browsers, all `sm-dev` commands, and the test fixture.
