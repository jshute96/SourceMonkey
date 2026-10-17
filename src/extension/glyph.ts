// Rendering a glyph from the shared sprite (src/glyph-sprite.svg) into
// the page.
//
// Every icon in the extension is one `<symbol>` in that sprite, inlined
// once per page by the build. All this module does is build the tiny
// `<svg><use href="#id">` that points at one — but it is shared because
// the alternative is each caller inventing its own class name and
// sizing, which is how two buttons wearing "the same" icon end up
// different sizes.
//
// Colour and size come from CSS on the button (`.btn-glyph` in
// styles.css), not from attributes here, so a glyph inherits
// `currentColor` and tracks the surrounding font.

const NS = 'http://www.w3.org/2000/svg';

// The class the shared sizing/spin rules key off. Callers with their
// own rules (the site-icon globe, the removal cans) pass their own.
export const GLYPH_CLASS = 'btn-glyph';

// Build an `<svg>` referencing one sprite symbol. `aria-hidden` on
// every one of them: a glyph never carries the accessible name, the
// button's own `aria-label` does.
export function renderGlyph(
  doc: Document,
  symbolId: string,
  className: string = GLYPH_CLASS,
): SVGSVGElement {
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = doc.createElementNS(NS, 'use');
  use.setAttribute('href', symbolId.startsWith('#') ? symbolId : `#${symbolId}`);
  svg.appendChild(use);
  return svg;
}

export interface GlyphButtonOptions {
  // Visible text beside the glyph. Omit for an icon-only button, where
  // `label` is the whole story and reaches the user as the tooltip.
  //
  // Worth keeping where the words carry something the glyph can't: the
  // difference between refreshing one collection and refreshing all of
  // them is the word "All", and no arrow says it.
  text?: string;
}

// Replace a button's contents with a glyph (and optional label), and
// give it `label` as its tooltip.
//
// `label` also becomes the accessible name, but ONLY for an icon-only
// button. A button that shows words has to be announced by the words a
// sighted user can read — an `aria-label` overrides them, so "Refresh
// All" on screen would be announced (and matched by voice control) as
// something else entirely.
export function setGlyphButton(
  btn: HTMLElement,
  symbolId: string,
  label: string,
  opts: GlyphButtonOptions = {},
): void {
  const doc = btn.ownerDocument;
  btn.textContent = '';
  btn.classList.add('icon-btn');
  btn.appendChild(renderGlyph(doc, symbolId));
  // Truthy, not `!== undefined`: an empty label would render an empty
  // `.btn-label`, which `setGlyphButtonLabel` then reads as "this
  // button shows its own text" and drops the `aria-label` for — a
  // button announced as nothing at all.
  if (opts.text) {
    const span = doc.createElement('span');
    span.className = 'btn-label';
    span.textContent = opts.text;
    btn.appendChild(span);
  }
  setGlyphButtonLabel(btn, label);
}

// Retitle a glyph button without rebuilding it. The busy state uses
// this: the glyph itself has to survive, because it is what spins.
//
// The `aria-label` goes on only where there is no visible label to
// override — see `setGlyphButton`. A labelled button's accessible name
// is its own text, and its `title` is the longer explanation.
export function setGlyphButtonLabel(btn: HTMLElement, label: string): void {
  btn.title = label;
  if (btn.querySelector('.btn-label')) btn.removeAttribute('aria-label');
  else btn.setAttribute('aria-label', label);
}

// The in-flight state for a button whose action takes a while.
//
// The glyph spins in place rather than the label changing to
// "Refreshing…". That used to be the only signal, and it can't survive
// an icon-only button — but it was also the thing that made the button
// change width mid-click, nudging its neighbours. Spinning the glyph
// says the same thing and moves nothing.
//
// `aria-live` is deliberately not used: the tooltip and the disabled
// state carry it, and a row of collections each announcing their own
// refresh would be worse than silence.
export function setGlyphButtonBusy(
  btn: HTMLButtonElement,
  busy: boolean,
  labels: { idle: string; busy: string },
): void {
  btn.disabled = busy;
  btn.querySelector(`.${GLYPH_CLASS}`)?.classList.toggle('spinning', busy);
  setGlyphButtonLabel(btn, busy ? labels.busy : labels.idle);
}
