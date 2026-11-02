# Generated class names

Many sites build their CSS with tools that add a hash to each class
name, which changes on every deploy:

- CSS modules: `Button_btn__g8LLk Button_secondary__8WBFj`.
- Emotion, styled-components: `css-1x2y3z`, `sc-bdVaJa`.
- JSS (CSS written in JavaScript) and MUI (Material UI, a React
  component library that uses it): `jss32`, `makeStyles-root-12`.

## Selecting by them

- Never hardcode the full class. Match the stable prefix:
  `[class*="Comment_Base"]`, `[class*="Button_btn"][class*="Button_secondary"]`.
- Exclude variants you don't want with `:not([class*="iconButton"])`.
- Record the prefix you rely on in the script's doc, if it has one.
- Pure hashes (`css-1x2y3z`, `jss32`) carry no meaning; anchor on
  something else (see the selector order in `SKILL.md`).

## Making an added element look like the site's

Don't copy the hashed class names into the script. Copy them from the
page at runtime:

- Find a reference element that already has the styling you want, by
  prefix (`button[class*="Button_btn"][class*="Button_medium"]`), and
  copy its `className` to the new element.
- If the best reference might not exist yet when you insert (it renders
  below the toolbar you attach to, or later), insert with a fallback
  and have the `MutationObserver` *upgrade* the `className` once a
  better reference appears.
- The same goes for JSS / MUI classes, and for values that depend on
  them (padding, a grid's negative margin): read them from a live
  element rather than assuming them.
