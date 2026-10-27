# sm-dev

`sm-dev` is [SourceMonkey](https://github.com/jshute96/SourceMonkey)'s
command-line tool, for developing, debugging and testing userscripts in
a real browser.

This package only runs the `sm-dev` command from the
[`sourcemonkey`](https://www.npmjs.com/package/sourcemonkey) package, so
that `npx sm-dev` works:

```sh
npx sm-dev --help
```

In a repo of userscripts, install `sourcemonkey` instead. It gives the
same `sm-dev` command, plus the Playwright test fixture and the agent
skills for working with them:

```sh
pnpm add -D sourcemonkey
```

See the [harness guide](https://github.com/jshute96/SourceMonkey/blob/main/docs/harness-guide.md).
