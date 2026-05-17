# TODO

## Skeleton

- Set up the userscript storage model (chrome.storage.local schema).
- Add an options page UI listing installed scripts.
- Implement userscript injection via `chrome.scripting`.
- Decide on userscript-header support level (`@match`, `@grant`, `@require`, …).
- Make an icon that works

## Local directory sources — follow-ups

- Replace `window.prompt` with an inline path-entry form on the
  options page.
- Parse userscript headers (name, `@match`, etc.) from scanned files
  instead of just listing the relative path.
- Detect when "Allow access to file URLs" is disabled and show a
  prominent setup hint instead of the generic fetch error.
- Watch for upstream changes to Chrome's `file://` directory-listing
  HTML format that could break `parseListing`.
