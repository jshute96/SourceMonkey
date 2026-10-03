// Ctrl/Cmd-A that selects a page's content rather than the page.
//
// On the viewer and the compare page the one thing worth copying is
// the code (or the log, or a diff), and a page-wide selection drags the
// header, details rows and button labels along with it, which nobody
// wants to paste. Each page says what the key should select, given
// where focus is; this installs the key.
//
// Left alone inside a text control or an open dialog, where select-all
// means what it always did — and whenever the page answers null, which
// is its way of saying the browser's own select-all is the right one.

export function installSelectAll(target: () => Element | null): void {
  document.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.defaultPrevented) return;
    // `code` as well as `key`: on a non-Latin layout the A key reports
    // its own letter, and Chrome's select-all still fires on it.
    if (ev.key.toLowerCase() !== 'a' && ev.code !== 'KeyA') return;
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.shiftKey) return;
    const from = ev.target;
    if (from instanceof Element && from.closest('input, textarea, select, [contenteditable], dialog[open]')) return;
    const el = target();
    if (!el) return;
    ev.preventDefault();
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  });
}
