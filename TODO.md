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
- Consider a "clear missing" affordance to drop `status: 'missing'`
  rows from storage rather than leaving them in the table.
