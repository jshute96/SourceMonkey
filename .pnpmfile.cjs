// pnpm's hook file for this repo: pnpm loads it itself and calls the
// functions under `hooks` at set points. Nothing here runs at build or
// test time.
//
// `beforePacking` runs when pnpm packs a package for npm (`pnpm pack`, as
// scripts/release.sh does, or `pnpm publish`), on that package's
// package.json. What it returns goes into the .tgz; package.json on disk
// is left as it is.
//
// It applies to both packages this repo publishes to npm:
// - `sourcemonkey`, from the root package.json, which holds sm-dev, the
//   harness and the extension;
// - `sm-dev`, from packages/sm-dev, the wrapper that makes `npx sm-dev`
//   work, which has no scripts to drop.
//
// What it changes:
// - It drops `scripts`: they build and test this checkout, and do nothing
//   in a repo that installs the package. One of them, `preinstall` (which
//   keeps people working here on pnpm), would even run there on each
//   install.
// - For `sourcemonkey`, it swaps in a description of the tools, for its npm
//   page. The root package.json's describes the extension.
//
// The npm page's text, packages/sourcemonkey/README.md, can't go in here:
// this hook sees only package.json. scripts/pack-npm.sh puts it in the
// packed file.
const NPM_DESCRIPTION = 'Developer tools for building and testing userscripts, using a real browser and the SourceMonkey extension: '
  + 'the sm-dev command-line tool, Playwright test fixture, and skills for agentic development';

module.exports = {
  hooks: {
    beforePacking(pkg) {
      delete pkg.scripts;
      if (pkg.name === 'sourcemonkey') pkg.description = NPM_DESCRIPTION;
      return pkg;
    },
  },
};
