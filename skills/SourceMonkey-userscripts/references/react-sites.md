# React-rendered pages

## Clicking React controls

- React menu items are often plain `<div>`s with `onClick` handlers,
  not `<button>` or `<a>`.
- From the script, `.click()` on the element reliably fires React's
  `onClick`, including on the menu's trigger. So "open the menu, find
  the item, click it" needs no simulated pointer events.
- From a Playwright test the same `.click()` may not toggle the menu.
  `focus()` then `Enter` works there as a fallback.

## Reading component state from fiber

React puts a `__reactFiber$<random>` property on each DOM node it
renders. Walking up its `.return` chain reaches the components above,
whose `stateNode`, `memoizedProps` and `memoizedState` hold data the DOM
doesn't show (a map engine, an item's id).

```js
function findUp(el, test, maxDepth = 12) {
  const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
  let fiber = key && el[key];
  for (let i = 0; fiber && i < maxDepth; i++, fiber = fiber.return) {
    const found = test(fiber);
    if (found) return found;
  }
  return null;
}
// e.g. findUp(canvas, f => f.stateNode?.context?.mapEngine)
```

- **This needs the page's world.** The property exists only there; from
  an isolated world (`@inject-into content`, `@sandbox DOM`) it's
  simply `undefined`, with no error. See
  [worlds-and-csp-sandbox.md](worlds-and-csp-sandbox.md).
- It's an internal structure: cap the walk, and keep a fallback (the
  URL, the DOM) for when it finds nothing.
- Worked example: a map script that reads a WebGL engine's camera this
  way, in
  [strava-map-crosslink.md](https://github.com/jshute96/userscripts/blob/main/sites/www.trailforks.com/strava-map-crosslink.md).

## Rearranging a React-rendered list: don't move React's nodes

React keeps references to its DOM nodes and later calls
`insertBefore` / `removeChild` on them against the parent it expects.
That throws, and can break the page, once we've moved them.

- **To reorder or regroup items** in a flex or grid container, set
  `style.order` on each item. DOM order, and so Tab order, stays the
  site's.
- **Adding our own element** inside React's container (a heading as a
  full-width flex item, `flex: 0 0 100%`) is safe. React ignores
  children it didn't create.
- **To show an item in a second place**, `cloneNode(true)` it into a
  container of our own, and replay clicks on the copy onto the
  original: find the clicked element's child-index path within the
  copy, follow it in the original, and `.click()` the nearest button
  there. Rebuild the copies when the originals change.
- **Re-apply from a `MutationObserver`** on `childList` (plus
  `characterData` for text React rewrites, like a quantity). Leave out
  `attributes`, so our own `style.order` writes don't retrigger it.
- **Measure what changes with window width** (a grid's negative margin)
  rather than assuming one value, and copy generated class names from
  live elements (see [generated-class-names.md](generated-class-names.md)).

## When React takes over the page

React apps that render on the server and then "hydrate" or re-render
the document can undo early changes:

- Medium's React strips every extra child of `<html>` when it renders
  the document on the client.
- GitHub's React drops attributes we set on `<html>` when it takes over
  the page, while our `<style>` children survive.

So:

- Keep page-wide state in an element we own, such as a `<style>`
  switched with its `media` attribute (`disabled` does nothing until
  the element is in the document), not in an `<html>` attribute.
- Re-create DOM state that must persist when it's removed (an observer
  on its parent).
- Scripts can start earlier under some managers than under others
  (see [manager-portability.md](manager-portability.md)), so a change
  that survives in one may be wiped in another.
