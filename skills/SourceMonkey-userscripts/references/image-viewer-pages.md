# Chrome's standalone image viewer

Scripts that match a site also run on its direct image URLs, which
Chrome shows in its built-in image viewer. That page is an
`ImageDocument`:

- `document.contentType` is the image's MIME type (starts with
  `image/`). Check it to tell the viewer from a normal page.
- The DOM is synthetic: `<html><head>...</head><body><img src="..."></body></html>`.

Changing the viewer:

- **Never replace or clone its `<img>`.** Chrome feeds the document's
  network stream straight into that element's decoded image, so a
  replaced or cloned `<img>` has no bitmap (`naturalWidth === 0`).
  Restyle and transform the original only.
- **Chrome's click-to-zoom** is a `click` handler on the image. A
  capture-phase `click` listener on `document` that calls
  `preventDefault()` and `stopImmediatePropagation()` suppresses it.
- **Chrome sets `width` and `height` attributes** on the `<img>`.
  `width: auto; height: auto; max-width: 100vw; max-height: 100vh`, all
  `!important`, override them.
- **Chrome rewrites the `<img>`'s inline style on window resize**,
  clearing any transform before your `resize` handler runs. Measure
  against whatever transform is actually on the element, and put yours
  back from a `MutationObserver`.
- **Chrome centers the image with `margin: auto`.** Keep it: overriding
  the margin makes a small image jump to the top-left corner as your
  styles load.

A full implementation (zoom and pan for the viewer) is
[image-zoom-pan.js](https://github.com/jshute96/userscripts/blob/main/lib/image-zoom-pan.js), with notes in
[its doc](https://github.com/jshute96/userscripts/blob/main/lib/image-zoom-pan.md).

Image URLs are a common case of pages sent with a CSP `sandbox` header;
see [worlds-and-csp-sandbox.md](worlds-and-csp-sandbox.md).
