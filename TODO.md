# TODO

## Skeleton

- Set up the userscript storage model (chrome.storage.local schema).
- Add an options page UI listing installed scripts.
- Implement userscript injection via `chrome.scripting`.
- Decide on userscript-header support level (`@match`, `@grant`, `@require`, …).
- Make an icon that works

## Local directory sources — follow-ups

- Parse userscript headers (name, `@match`, etc.) from scanned files
  instead of just listing the relative path.
- Make the userscript viewer editable (switch from `<pre><code>` to
  a real editor like CodeMirror) and add a "Save" path that writes
  back through the directory handle.
