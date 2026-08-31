// The two trash cans.
//
// SourceMonkey has two removal actions that look alike and aren't:
//
// - `record` — drop SourceMonkey's row for a script. The bytes it came
//   from are untouched (they may not even be reachable any more).
// - `file`   — delete the script FILE from disk, which only a local
//   copy in the copies directory qualifies for. This is the one
//   action that destroys something SourceMonkey didn't create.
//
// Both used to render the same trash-can emoji and differ only in
// `title`, so the difference was invisible until you hovered. They now
// share a trash-can silhouette — same family, same action shape — and the
// file variant carries a small disk badge in its lower-right corner
// plus a red resting colour, so the destructive one is marked twice:
// by shape and by colour, since colour alone isn't a cue everyone gets.
//
// The glyphs live as `<symbol>`s in the shared sprite
// (src/glyph-sprite.svg, inlined into each page by the build) rather
// than being written out per button, so a hundred rows share one copy
// of the path data. Every call site goes through `setDeleteIcon` so
// the pair can't drift apart again.

const NS = 'http://www.w3.org/2000/svg';

export type DeleteIconKind = 'record' | 'file';

const SYMBOL_ID: Record<DeleteIconKind, string> = {
  record: '#sm-trash',
  file: '#sm-trash-file',
};

// Replace the button's contents with the glyph for `kind`, and mark
// the file-deleting variant with `.deletes-file` so the stylesheet can
// give it its own resting colour. Callers keep owning `title` /
// `aria-label`: the icon narrows what the tooltip has to explain, it
// doesn't replace it.
export function setDeleteIcon(btn: HTMLElement, kind: DeleteIconKind): void {
  const doc = btn.ownerDocument;
  btn.textContent = '';
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'delete-icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = doc.createElementNS(NS, 'use');
  use.setAttribute('href', SYMBOL_ID[kind]);
  svg.appendChild(use);
  btn.appendChild(svg);
  btn.classList.toggle('deletes-file', kind === 'file');
}
