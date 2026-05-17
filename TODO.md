# TODO

## Skeleton

- Injection follow-ups — see the **Limitations / future work**
  section of [docs/injection.md](docs/injection.md): `@grant` /
  `GM_*`, `@require` / `@resource`, `@noframes` / `allFrames`.
- Make an icon that works

## Local directory sources — follow-ups

- Watch for upstream changes to Chrome's `file://` directory-listing
  HTML format that could break `parseListing`.
- Editing path: if we ever want in-app edits, we'll need either FSA
  handles (re-introduces per-session re-grant) or a Native Messaging
  helper. `file://` URLs are read-only from the extension side.
- Cleanup of deleted-script entries. Refresh currently marks a
  vanished file as `status: 'missing'` and auto-disables it, but the
  row stays in `chrome.storage.local` forever so the viewer keeps
  working. Options to consider: a "Clear missing" button on each
  directory section; an age-out (drop rows that have been missing for
  N refreshes); or a one-click "remove from store" on the row itself.
