// The small square "copy this to the clipboard" button the viewer puts
// beside a path.
//
// Shared because it appears on more than one row now — the Location
// row's resolved path, and each entry in the Local overrides row — and
// the two must not drift into different icons, different flash durations,
// or different failure behavior.
//
// The text is supplied as a callback rather than a string: a button
// can outlive the render that made it (the Location row's is one
// long-lived element moved between renders, so an in-flight "Copied"
// flash survives a repaint), and it must copy what the row says NOW,
// not what it said when the button was built.

// Static markup for the Lucide-style copy / check icons. Safe to embed
// via innerHTML because there's no interpolation; the strings ship as
// part of the extension bundle.
const COPY_ICON_SVG =
  '<svg class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
  '</svg>';
const CHECK_ICON_SVG =
  '<svg class="check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="20 6 9 17 4 12"/>' +
  '</svg>';

// How long the checkmark stays up after a successful copy.
const COPIED_FLASH_MS = 1200;

export interface CopyButtonOptions {
  // Tooltip + accessible name. Says what gets copied, since a page can
  // show several of these at once.
  label: string;
  // The string to write. Read at click time. Returning empty (or
  // undefined) makes the click a no-op — the row has nothing to give.
  text: () => string | undefined;
}

export function makeCopyButton(options: CopyButtonOptions): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn';
  btn.title = options.label;
  btn.setAttribute('aria-label', options.label);
  btn.innerHTML = COPY_ICON_SVG + CHECK_ICON_SVG;

  // Per-button timer, so two buttons flashing at once don't cancel each
  // other, and a rapid double-click on one leaves no stuck checkmark:
  // each click clears its own prior reset and schedules a new one.
  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  btn.addEventListener('click', () => {
    void (async () => {
      const text = options.text();
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // The write can be rejected (permission denied, or no user
        // gesture credited). The text is selectable on the page, so
        // there is nothing to fall back to and nothing worth saying.
        return;
      }
      // `.copied` swaps the visible icon to a checkmark via CSS.
      btn.classList.add('copied');
      if (resetTimer !== null) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        btn.classList.remove('copied');
        resetTimer = null;
      }, COPIED_FLASH_MS);
    })();
  });

  return btn;
}
