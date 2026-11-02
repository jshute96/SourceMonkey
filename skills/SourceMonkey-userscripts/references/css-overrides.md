# CSS overrides that don't take effect

When an override doesn't change anything, confirm with
`getComputedStyle(target)` that the rule you changed is the one
responsible, before trying another selector or more `!important`.

Common culprits:

- **Elements Inspect Element can't pick.** Pseudo-elements (`::before`,
  `::after`) and elements with `pointer-events: none` never come up
  under the cursor. Look at the target's neighbors and pseudo-elements
  in the Styles pane.
- **The visible background isn't where you think.** It can be an
  `<img>` element, a CSS gradient, or a `background-image: url(...)`
  PNG. Grepping the CSS for `linear-gradient` misses the last. A DOM
  walk for non-transparent backgrounds finds them:

  ```js
  [...document.querySelectorAll('*')].filter(e => {
    const s = getComputedStyle(e);
    return s.backgroundImage !== 'none' || s.backgroundColor !== 'rgba(0, 0, 0, 0)';
  })
  ```

- **The window isn't the scroller**, so a fix to the body's overflow or
  scrollbar does nothing. See [scrolling.md](scrolling.md).
- **The site re-renders the element**, replacing an inline style or a
  class we set. Prefer a `<style>` rule with a selector the site's
  element keeps matching over inline styles on its nodes.
