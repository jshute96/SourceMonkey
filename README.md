# VibeMonkey

A userscript manager Chrome extension optimized for vibe-coding.

> **Status:** Early skeleton. The options page can register local
> directories, list the `*.user.js` files inside them, and open each
> in an in-extension viewer with syntax highlighting. Nothing is
> injected into pages yet.

## Usage

Open the options page from `chrome://extensions` → VibeMonkey →
"Details" → "Extension options". Enter the absolute path of a folder
containing userscripts and click **Add directory**. Each added
directory is scanned for `*.user.js` files up to two subdirectory
levels deep, and each finding is listed as a link. Clicking a link
opens a viewer in a new tab that shows the file's name and contents
with JavaScript syntax highlighting. Click **Remove** to drop a
directory from the list.

**One-time setup:** enable **"Allow access to file URLs"** for
VibeMonkey on `chrome://extensions`. Without it the options page
can't read your local directories. The toggle is persistent — once
on, it stays on across browser restarts.

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
