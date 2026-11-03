# Screenshots in doc files

Screenshots are optional. Include them when a picture makes the change
clearer than prose (layout fixes, added UI, restyled elements). Skip
them when the change is invisible or trivially described.

* **Location and naming.** Put images in a `screenshots/` subdirectory
  of the script's site directory: `sites/<site>/screenshots/`. Name
  them after the script:
  - `<script-basename>-before.png` / `<script-basename>-after.png`
    when there's a single pair.
  - `<script-basename>-<what>-before.png` /
    `<script-basename>-<what>-after.png` when showing more than one
    aspect, where `<what>` names the page, state, or condition.
  - A single unpaired image is just `<script-basename>.png`, or
    `<script-basename>-<what>.png`.

* **Where they go in the doc.** At the **end** of the `Summary`
  section: they're part of the user-facing description, not the
  implementation notes. (Implementation-only diagnostic images can go
  in `Implementation` instead.)
  - Keep them in one block at the end, all together, rather than
    interleaved through the prose. Repository sites like Greasy Fork
    strip the images out of the description and show them in a
    separate gallery underneath.
  - Headings above images: format them like
    ```markdown
    **Page X before:**
    ![Before](screenshots/thing-x-before.png)
    ```
  - Headings for multiple images: on Greasy Fork, the gallery gets one
    combined heading above all the images, like "Pages X and Y, before
    and after:".
    - Put that combined heading in the doc as an HTML comment
      immediately above the image block:
      ```markdown
      <!-- image-gallery-heading: **Pages X and Y, before and after:** -->
      ```
    - Every doc with *multiple* images should have this alternate
      heading. (With just a single image, the original heading works
      as is.)

* **Publishing.** The `publish-on-GreasyFork` skill's
  `extract-description.py` pulls the `Summary` text and the image list
  out of a doc, for Greasy Fork's description and gallery, and reads
  the `image-gallery-heading` comment.

* **Labels.** Label each image with what it is: `<what> before:` /
  `<what> after:` for a pair, `Example:` for a single one, where
  `<what>` names the page or surface being shown (`Search page`,
  `Title bar`, `Activity page`). Keep it to that. Set the label
  **bold** on its own line, so it doesn't read as body text next to
  the image. (Bold rather than a markdown heading.)
  **Don't narrate what's visible in the image**; the reader is looking
  at it. Add prose only for something the picture can't say on its
  own.

* **Matching dimensions.** Capture before and after at the same width
  and height, framing the same region of the page. A pair that differs
  only in the thing that changed is far easier to compare than one
  where everything shifts. (Exception when the shape of the captured
  items changed.)

* **Borders.** Most page captures are white-on-white and dissolve into
  the doc's background with no visible edge. Add a 1px black border to
  each: `convert x.png -bordercolor black -border 1 x.png` (ImageMagick).
  Images grow by 2px in both directions, but stay matched in size.
  Skip it for dark captures (a video player, say): they already have an
  edge, and a black border on them is invisible.

* **Size and format.** Full-screen captures off a HiDPI display come in
  enormous (3841×1976 for one browser window). Downscale them to about
  a quarter (`convert x.jpg -resize 25% -quality 88 out.jpg`), which is
  still legible in the doc. Keep photographic content (video frames) as
  `.jpg`; UI captures of text and flat color stay `.png`, where it's
  both sharper and smaller.

* **Layout.** If the images are small, show before and after
  side-by-side in an HTML table (GitHub renders raw HTML in Markdown);
  otherwise stack them.

* **Capturing them.** The person may capture images themselves. If
  they capture full-page screenshots, crop them appropriately.
  Otherwise, capture them in the browser `sm-dev` drives (see the
  `SourceMonkey-dev` skill).

* **Framing.** Prefer screenshots focused on the relevant section over
  full-page captures, but include enough surrounding context that it's
  clear where on the page you're looking. If the difference isn't
  obvious at a glance, add a highlight (box or arrow) to the image.

Stacked pair:

```markdown
**Search page before:**

![Before](screenshots/fix-climb-slider-before.png)

**Search page after:**

![After](screenshots/fix-climb-slider-after.png)
```

Side-by-side pair:

```markdown
<table>
  <tr><td><b>Before</b></td><td><b>After</b></td></tr>
  <tr>
    <td><img src="screenshots/fix-climb-slider-before.png" alt="Before"></td>
    <td><img src="screenshots/fix-climb-slider-after.png" alt="After"></td>
  </tr>
</table>
```
