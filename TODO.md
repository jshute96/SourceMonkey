# TODO

## Skeleton

- Set up the userscript storage model (chrome.storage.local schema).
- Add an options page UI listing installed scripts.
- Implement userscript injection via `chrome.scripting`.
- Decide on userscript-header support level (`@match`, `@grant`, `@require`, …).
- Make an icon that works

## Local directory sources — follow-ups

- Wire the userscript header parser (`src/userscript-header.ts`) into
  the scan/render flow so listings show `@name` / `@match` instead of
  just the relative path.
- Watch for upstream changes to Chrome's `file://` directory-listing
  HTML format that could break `parseListing`.
- Editing path: if we ever want in-app edits, we'll need either FSA
  handles (re-introduces per-session re-grant) or a Native Messaging
  helper. `file://` URLs are read-only from the extension side.
