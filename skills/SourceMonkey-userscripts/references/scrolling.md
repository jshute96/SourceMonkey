# Scrolling

## Find the real scroller

The window isn't always what scrolls. A full-height scrollbar can belong
to an inner `overflow: auto` container.

- Probe the live page after scrolling a bit:
  `[...document.querySelectorAll('*')].filter(e => e.scrollTop > 0)`.
  A saved HTML snapshot can't tell you.
- Read and write the same element. Writing `el.scrollTop` but reading
  `window.scrollY` silently does nothing useful.

## Pages that grow while you scroll

`scrollIntoView()` and `scrollTo()` fix their destination as a scroll
offset when called, then animate to it. On pages that lazy-load images
or inject ad slots, content that finishes loading *above* the target
during the animation pushes it down, and the scroll stops short.

- Correct after the scroll settles: re-measure the target's position
  and scroll again if it's off, with a limit on corrections.
- Judge "settled" by the target's `getBoundingClientRect().top`, not
  `window.scrollY`. Content above keeps growing, so `scrollY` can sit
  still while the element is still moving.
- Worked example: the `settle` scroll strategy in
  [keyboard-comment-nav.js](https://github.com/jshute96/userscripts/blob/main/lib/keyboard-comment-nav.js)
  (described in [its doc](https://github.com/jshute96/userscripts/blob/main/lib/keyboard-comment-nav.md)).
- The same holds in a spec that waits for a scroll to finish (see the
  `SourceMonkey-dev` skill's `references/specs.md`).

## Scrolls that silently do nothing

On some fixed-position drawers, both `scrollIntoView` and `scrollTo`
do nothing (one case had `scrollbar-gutter: stable`). Write `scrollTop`
on the container directly, from `requestAnimationFrame` steps if it
should animate.

## Sticky headers

Anything pinned over the top of the scroll area hides what you scroll
to. Scroll to the header's bottom edge, not the viewport's top.

- **Prefer a value the site declares**, but check where it's declared.
  Reddit sets `--shreddit-header-height` on `<shreddit-app>`, not
  `:root`, so reading it off the document root silently gives `""`.
- **Measure where it will be once pinned.** At the top of the page a
  sticky element may not be pinned yet, and its current rect gives no
  offset at all.
- If you walk the DOM to measure it, cache the result briefly (100ms):
  callers tend to ask more than once per action.

## Headers that hide on scroll

Some headers (Substack's) hide when scrolling down and come back when
scrolling up. Check before assuming a constant: scroll the live page
down 300px, then up 300px, and read the bar's `position`, `top` and
`height` after each.

- **No constant offset is right, and neither is its live position**:
  mid-animation it can flip between `fixed` and `absolute` with `top`
  anywhere in its range. Decide by the scroll's *direction*: reserve
  the header's height when scrolling up (it's coming back), none when
  scrolling down (it's leaving).
- **Leave a pixel or two of slack** in comparisons: the measurements are
  fractional (71.7356px), and exact ones flip on rounding.
- **Never let a downward scroll overshoot.** The correction would be an
  upward scroll, which brings the header back right after the scroll
  looks finished, and shoves the content down. A header that also
  *changes height* near the top of the page causes this: aim short by
  that difference and correct downward.
- **Check by measuring**, not by eye: the gap between the target's top
  and the header's painted bottom edge should be 0 in both directions.
  Sample about 1.5s after the action, or you catch corrections in
  flight.

## Real wheel input

A scroll from script (`scrollIntoView`, `scrollBy`) fires no `wheel`
event. A script that watches for the person scrolling (to cancel its
own scroll, say) needs real wheel input to test; the `SourceMonkey-dev`
skill's CDP reference shows how.
