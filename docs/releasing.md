# Releasing

A release is one version, tagged `vX.Y.Z`, of everything this repo
ships. All the parts share that version number.

## What a release contains

- **The extension**, in two zips built from the same `dist/`:
  - `SourceMonkey-vX.Y.Z.zip`, attached to the GitHub release, for
    people who install it with **Load unpacked**. Its manifest keeps
    `key`, so it gets the same extension ID as the store copy, which
    sm-dev relies on to find SourceMonkey in a person's own Chrome.
  - `SourceMonkey-vX.Y.Z-store.zip`, uploaded by hand to the Chrome Web
    Store. The store refuses a manifest with `key`, so this zip leaves
    it out.
- **The npm packages**, published to npm and also attached to the
  GitHub release as `.tgz` files:
  - `sourcemonkey`: sm-dev, the Playwright test fixture and the agent
    skills, for a userscript repo to install as a dev dependency.
  - `sm-dev`: a small wrapper that depends on `sourcemonkey`, so
    `npx sm-dev` works.
- **The GitHub release** itself, with notes giving the install
  commands.

`scripts/release.sh` builds all of these, checks them, tags the
commit and creates the GitHub release. Publishing to npm and uploading
to the store come after you've checked the release.

## Procedure

1. Bump the version in `package.json`, `src/manifest.json` and
   `packages/sm-dev/package.json` to the same value. Commit and push.
2. Build the release and create a draft GitHub release with its files:
   ```sh
   scripts/release.sh
   ```
3. Open the draft on GitHub (the script prints its URL), check it, and
   click **Publish release**.
4. Publish the release's packages to npm:
   ```sh
   scripts/release.sh --publish-npm vX.Y.Z
   ```
5. Upload `/tmp/SourceMonkey-vX.Y.Z-store.zip` in the Chrome Web Store
   developer dashboard and submit it for review.

`scripts/release.sh --help` describes each command, and the comment at
the top of the script each step it takes.

## Building without releasing

To build a distributable zip without releasing:

```sh
scripts/zip_extension.sh                   # writes /tmp/SourceMonkey.zip
scripts/zip_extension.sh --release X.Y.Z   # versioned zip, plus the store zip
```
