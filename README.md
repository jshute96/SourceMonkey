# VibeMonkey

A userscript manager Chrome extension optimized for vibe-coding.

> **Status:** Early skeleton. The options page can register local
> directories and list the `*.user.js` files inside them, but nothing
> is injected into pages yet.

## Usage

Open the options page from `chrome://extensions` → VibeMonkey →
"Details" → "Extension options". Click **Add directory** and enter
the absolute path to a folder containing userscripts. Each added
directory is scanned for `*.user.js` files up to two subdirectory
levels deep, and each finding is listed as a clickable `file://`
link. Click **Remove** to drop a directory from the list.

For directory scanning to work, enable **"Allow access to file
URLs"** for VibeMonkey on `chrome://extensions`.

## Installation

Not yet released. To run a local development build, see
[Development](#development) below.

## Development

Requires Node.js 22 or newer.

### Setup

```sh
npm install
npx playwright install chromium
```

### Build

```sh
npm run build       # one-shot build into dist/
npm run watch       # rebuild on TS changes
```

The built extension is written to `dist/`. Load it into Chrome via
`chrome://extensions` → "Load unpacked" → select the `dist/`
directory.

### Test

```sh
npm test            # unit + e2e
npm run test:unit   # node --test, fast
npm run test:e2e    # Playwright with the extension loaded
npm run test:headed # e2e with a visible browser
```

### Code layout

- `src/` — extension source (TypeScript + manifest + HTML).
- `scripts/build.mjs` — bundler-free build script.
- `tests/unit/` — Node `--test` unit tests.
- `tests/e2e/` — Playwright tests that load the unpacked extension.
- `docs/` — design docs and `file-index.md`.

## License

MIT. See `LICENSE`.
