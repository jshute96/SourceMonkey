# TODO

## Skeleton

- Implement userscript injection via `chrome.scripting` (read
  `script-store` → match `@match`/`@exclude` against the active tab →
  inject body).
- Decide on `@grant` / `@require` / `@resource` support level.
- Make an icon that works

## Local directory sources — follow-ups

- Watch for upstream changes to Chrome's `file://` directory-listing
  HTML format that could break `parseListing`.
- Editing path: if we ever want in-app edits, we'll need either FSA
  handles (re-introduces per-session re-grant) or a Native Messaging
  helper. `file://` URLs are read-only from the extension side.
- Consider a "clear missing" affordance to drop `status: 'missing'`
  rows from storage rather than leaving them in the table.
