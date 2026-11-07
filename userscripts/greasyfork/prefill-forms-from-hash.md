# <img src="../site-icons/greasyfork.org_script_versions_new.png" width="24" height="24" alt=""> Greasy Fork: Fill post/update/import forms from URL parameters

## Summary

The [SourceMonkey](https://github.com/jshute96/SourceMonkey) userscript
manager includes tools for agentic userscript development, including a
tool for publishing scripts to Greasy Fork. That uses this userscript,
which fills in the forms on Greasy Fork's script upload pages from
parameters in the URL hash, so they can be opened from command-line
tools.

It covers these pages:

* **Post a new script** (`/script_versions/new`)
* **Post a new version** (`/scripts/<id>/versions/new`)
* **Import scripts** (`/import`)

The userscript never clicks Submit on Greasy Fork. It opens tabs with
the forms filled in, for you to review and submit.

Use the
[publish-on-GreasyFork](https://github.com/jshute96/SourceMonkey/blob/main/skills/publish-on-GreasyFork/SKILL.md)
skill or the
[greasyfork-url.py](https://github.com/jshute96/SourceMonkey/blob/main/skills/publish-on-GreasyFork/scripts/greasyfork-url.py)
script to open the forms. They're installed as part of
[SourceMonkey's development tools](https://github.com/jshute96/SourceMonkey#userscript-development-tools).
They open each form through
[a status page](https://jshute96.github.io/SourceMonkey/userscripts/greasyfork/open-prefilled-form.html),
which checks that this userscript is installed and that you're signed in
to Greasy Fork, then sends you on to the form.

Greasy Fork has a prefill endpoint of its own, but it fills only the
Code field, and only from a POST request, not a URL parameter.
This script covers all fields on the forms: descriptions and
changelogs, images, library fields, etc.

### Building URLs with a script

`greasyfork-url.py`, linked above, builds these URLs from file paths
and opens them in the browser. It has one subcommand per page (`new`,
`update`, `import`); run it with `--help` for full details.

For file uploads (images, or code given with `--code-upload`), it
starts a short-lived background server on `localhost` that serves just
those files. (The browser can't do uploads from `file:` URLs.)

**Post a new script**, with its documentation and two screenshots:

```
greasyfork-url.py new \
    --code-file /home/me/scripts/my-script.user.js \
    --info-file /home/me/scripts/my-script.md \
    --image-files /home/me/shots/before.png,/home/me/shots/after.png
```

**Post a new version** of script 123456, with a changelog:

```
greasyfork-url.py update 123456 \
    --code-file /home/me/scripts/my-script.user.js \
    --info-file /home/me/scripts/my-script.md \
    --changelog-text 'Fix the icon alignment.'
```

**Import a script** from GitHub, that Greasy Fork will update automatically:

```
greasyfork-url.py import \
    https://raw.githubusercontent.com/me/userscripts/main/my-script.user.js \
    --sync-type automatic
```

### Building URLs manually

Normally you don't have to: use one of the tools linked above to build
the URLs.

All parameters go in the URL **hash** (after `#`), as
`key=value` pairs joined by `&`. Every value must be
percent-encoded with `encodeURIComponent`.

Anywhere a parameter takes a file or URL, it takes an `http(s)://` URL.
Your userscript manager may ask before the script connects to a site.
Local paths and `file://` URLs aren't accepted.

Yes/no parameters (`keep_hash`, `adult`, `source_editor`) accept
`1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`, and a bare
`#keep_hash` with no value counts as yes. Anything else is reported in
the console and ignored, as are misspelled parameter names and
parameters aimed at a different page.

**There is no auto-submit.** You review the filled form and click
Submit yourself. A submit parameter would be dangerous, since any link
on the web could then post to your account.

#### Post a new script / Post a new version

The two forms are nearly the same; the "Page" column marks the
parameters that only exist on one of them.

| Parameter | Page | Value |
| --- | --- | --- |
| `code` | both | Script source, inline. Goes in the Code textarea. |
| `code_url` | both | Load the Code textarea from a URL. |
| `code_upload` | both | Attach a file to the "Or upload" input instead of using the textarea. |
| `additional_info_html` | both | Sets the markup radio to HTML and fills Additional info. |
| `additional_info_markdown` | both | Same, with the Markdown radio. |
| `additional_info_html_url` | both | As above, text loaded from a URL. |
| `additional_info_markdown_url` | both | As above, text loaded from a URL. |
| `image_files` | both | Comma-separated image URLs, uploaded **in the order given**. |
| `script_type` | both | `public`, `unlisted` or `library` (or `1`/`2`/`3`). |
| `name` | both | Library name field (only shown for `script_type=library`). |
| `description` | both | Library description field. |
| `adult` | both | Ticks the adult-content self-report. |
| `source_editor` | both | Turns Greasy Fork's syntax-highlighting code editor on or off. |
| `script_locale` | new script | Script language. Accepts the option's numeric id, its label (`Spanish (es)`), the name alone (`Spanish`, taking the first match), or the code (`es`). |
| `changelog_html` | new version | Sets the changelog markup radio to HTML and fills the changelog. |
| `changelog_markdown` | new version | Same, with the Markdown radio. |
| `changelog_html_url` / `changelog_markdown_url` | new version | As above, text loaded from a URL. |
| `remove_images` | new version | `all` ticks every "remove" checkbox on the images already attached. |

`code` / `code_url` / `code_upload` are alternatives; pass one. Same
for the `_html` / `_markdown` pairs: whichever is present wins, with
HTML checked first.

#### Import scripts

| Parameter | Value |
| --- | --- |
| `urls` | Source URLs to import, separated by newlines or commas. |
| `language` | `detect`, `js` or `css`. |
| `sync_type` | `automatic` or `manual`. |

#### Common parameters

These work on all pages:

| Parameter | Value |
| --- | --- |
| `keep_hash` | Leave the parameters in the address bar (they're stripped by default). |

#### Behavior notes

* **Preview.** When Additional info (or the changelog) is filled, that
  pane is switched from Write to Preview, so the rendered markup is
  what you see on arrival.
* **Hash stripping.** After filling, the hash is removed from the
  address bar so a reload doesn't clobber manual edits with a stale
  prefill. Pass `keep_hash=1` to keep it.
* **No parameters, no action.** With an empty hash the script does
  nothing at all, so the pages behave normally when you browse to
  them by hand.

## Visible changes

* On the three form pages, fields named in the URL hash arrive
  already filled in.
* Markup-mode radios (HTML / Markdown) are selected to match whichever
  parameter was used.
* Image attachments and the code upload appear as genuinely selected
  files on the upload inputs, images in the order listed.
* Console warnings for misspelled parameters, parameters meant for a
  different page, unusable values, and combinations where one value
  would silently win over another.
* Additional info and changelog panes open on the Preview tab rather
  than Write.
* The parameters disappear from the address bar once applied.
* The opener page redirects to the form it names. It stays, with its
  status rows filled in, when you need to sign in, its files are no
  longer available, it has no form values, or its target isn't a
  posting form.

## Implementation

### Pages and how they're detected

Greasy Fork is a server-rendered Rails app, not a single-page app —
every one of these pages is a full document load — so the script does
its work once per load and needs none of the URL-change plumbing a
single-page-app script needs.

The script runs at `document-start`, so that it can leave
[the opener page](#the-opener-page) quickly. On a form, it waits with
`whenDomReady()` before filling anything:

* A `DOMContentLoaded` listener added at `document-start` runs before
  the page's own, so it would fill the form before the page's setup.
  The wait adds a `setTimeout(0)` after the event to let them go first.
* A manager can start the script after the event has fired, so the wait
  ends at once if parsing is already done.
* It doesn't wait for `load`, which also waits for images and the like.

There are two matching layers. `@match` keeps the script off every
other page on the site, one pair of patterns per page — a bare one and
a locale-prefixed one, since Greasy Fork serves both `/import` and
`/en/import`:

```
https://jshute96.github.io/SourceMonkey/userscripts/greasyfork/open-prefilled-form.html*
https://greasyfork.org/script_versions/new*
https://greasyfork.org/*/script_versions/new*
https://greasyfork.org/scripts/*/versions/new*
https://greasyfork.org/*/scripts/*/versions/new*
https://greasyfork.org/import*
https://greasyfork.org/*/import*
file:///*/userscripts/greasyfork/open-prefilled-form.html*
```

The first and last are [the opener page](#the-opener-page), on GitHub
Pages or as a local copy. It comes first because managers link a script
to the first page it matches, and the opener page is more use than a
blank form. On any origin other than Greasy Fork, the script
treats the page as the opener.

The trailing `*` is needed because a match pattern's path is compared
against the path *and* query string, and the language-switcher form on
these pages navigates to e.g. `/script_versions/new?locale=…`. (The
fragment isn't part of matching, so our hash never affects it.)

Then `location.pathname` is matched against three regexes, each
allowing one optional leading locale segment (`/en`, `/zh-CN`, …):

| Page | Pattern |
| --- | --- |
| new script | `/script_versions/new` |
| new version | `/scripts/<id-or-slug>/versions/new` |
| import | `/import` |

The second layer isn't redundant: `@match` wildcards span slashes, so
they can't express "at most one locale segment", and the script needs
to know *which* of the three pages it landed on regardless.

### The opener page

A browser launched from the command line reports nothing about the page
it reached, so `greasyfork-url.py` can't tell when the script is missing.
All it would produce is a blank form. So the tool opens
`open-prefilled-form.html` on GitHub Pages, which is a static page of
the form-filler's intro and a status list, with the form named in the
query string:

```
…/open-prefilled-form.html?to=/en/scripts/123456/versions/new#changelog_html=…
```

The status list has a row for each thing that has to be in place:

* **Userscript manager** and **Form-filler userscript.** The page's own
  defaults mark the manager unknown and the script missing, with install
  links. The script fills them in from `GM_info`, since its running
  proves both.
  * A page can't detect a manager without the script. Tampermonkey and
    Violentmonkey expose themselves only to a few script-hosting sites,
    and none of the managers has files a page could probe for.
* **Greasy Fork sign-in** and **Local files for the form**, shown when
  the script runs the checks below.
* **Link**, shown when `to` names something other than a posting form.

The page's own inline script shows the "correct the issues above, then
Reload" section when the URL has a `to` and a hash. Reloading keeps the
hash, so it continues to the form once things are fixed. Otherwise it
shows a note on opening the page through the skill or
`greasyfork-url.py`.

With the script running, what happens depends on the URL:

| URL | Result |
| --- | --- |
| A `to` naming a posting form, and a hash | Runs the checks below, then `location.replace()` to the form, hash untouched |
| No `to`, or no hash | Stays, showing the manager and script rows |
| A `to` naming anything else | Stays, and shows the Link row |

The checks run first because each problem would otherwise cost the
form's values or files. Both use `GM_xmlhttpRequest`:

* **Signed in.** Greasy Fork's sign-in redirect drops the hash at the
  sign-in step, leaving a blank form. So the script requests the form
  itself, and if that ends at `/users/sign_in`, the sign-in row links
  to the sign-in page.
  * A failed check counts as signed in, since the form is the most it
    could have held back.
  * The sign-in link passes `return_to=/`. Without it, signing in ends
    on the form the check requested, which is blank in that tab.
* **File server up.** If the hash names a [file server](#loading-files)
  that has stopped, the files row says to run the command again.

The status list is hidden until the script has filled in its rows, with
a stylesheet added at `document-start`, so the "missing" defaults don't
flash up.

Why it's built this way:

* **The redirect stays on Greasy Fork.** The origin is fixed and `to`
  has to match `PAGE_PATTERNS`, so the page can't redirect elsewhere.
* **It doesn't check how the page was reached.** A command-line launch
  and a link with no referrer look the same from inside the page. A link
  gains nothing here anyway: it could target the form directly, and the
  person still has to submit the form.
* **Long URLs still work.** Browsers don't send the hash to the server,
  so GitHub never sees the form's values and the URL's length isn't
  limited by GitHub Pages. An over-long URL goes through the local
  launcher page first, as it did before.
* **Back doesn't return here.** `location.replace()` keeps the page out
  of history, so Back can't bounce forward to the form again.

The tool opens the form directly for `--direct` and for any `--base`
other than Greasy Fork, since the script only redirects to the real site.

**Testing a changed page** before pushing it:

* Pass `--opener-page userscripts/greasyfork/open-prefilled-form.html`
  to the tool. A path is turned into a `file:` URL. `--print
  --no-direct` shows the URL without opening it.
* The script's `file:` `@match` covers that copy. Chrome runs it there
  only with "Allow access to file URLs" on for the manager's extension.

### Form controls we depend on

Both script forms are one `<form id="new_script_version">`
(`enctype="multipart/form-data"`), and the fields are addressed by id:

| Field | Selector |
| --- | --- |
| Code | `#script_version_code` (textarea) |
| Code upload | `#code-upload` (`name="code_upload"`) |
| Additional info | `#script-version-additional-info-0` |
| Additional info markup | `#script_version_additional_info_0_value_markup_{html,markdown}` |
| Changelog | `#script_version_changelog` |
| Changelog markup | `#script_version_changelog_markup_{html,markdown}` |
| Attachments | `#script_version_attachments` (`multiple`) |
| Existing attachment removal | `input[id^="remove-attachment-"]` |
| Script type | `#script_script_type_{1,2,3}` |
| Library name / description | `#library-name`, `#library-description` |
| Locale | `select[name="script[locale_id]"]` |
| Adult content | `#script_adult_content_self_report` |

The import form is `form[action*="/import/add"]` with
`#sync-urls`, `#sync-language-{detect,js,css}` and
`#sync-type-{1,2}` (`sync-type-2` is *automatic*, `sync-type-1` is
*manual* — the numbering follows Greasy Fork's internal enum, not the
display order).

The additional-info and changelog textareas each sit inside a
`div.previewable` that also contains `div.tabs` with
`a.write-tab` and `a.preview-tab`. Switching to preview is a
`.click()` on `a.preview-tab`, found by walking up from the textarea
with `closest('.previewable')` — there are two such wrappers on the
new-version page, so an anchor relative to the textarea is what keeps
them apart.

### Filling controls

Text fields get `.value` assigned followed by bubbling `input` and
`change` events, so any of Greasy Fork's own listeners see the change.

File inputs can't be given a path — that's a browser security rule
with no way around it — but their `files` property *is* assignable
from a `FileList`, and a `DataTransfer` is the only way to build one.
So each path is fetched into a `Blob`, wrapped in a `File` (name from
the last path segment, MIME type from the extension), added to a
`DataTransfer` in order, and the resulting `FileList` assigned. Image
attachments are fetched sequentially rather than with
`Promise.all` so their order in the list is deterministic — Greasy
Fork displays them in upload order.

### The syntax-highlighting source editor

Both script forms carry an "Enable syntax-highlighting source editor"
checkbox (`input.enable-source-editor`). Greasy Fork's
`app/javascript/source-editor.js` runs its change handler on page load
as well as on click: when the box is checked it hides
`#script_version_code`, builds an **ace** editor next to it in
`#ace-editor` seeded from the textarea's value *at that moment*, and
registers a submit hook — on both the form's `submit` event and the
reCAPTCHA button's click — that copies the editor's content back over
the textarea.

That means anything written into the textarea while the editor is up is
silently discarded when the form posts. The box starts unchecked, but
Chrome restores checkbox state across reloads, so it can be on at load.

`ensureSourceEditorOff()` handles it, and the ordering is deliberate:

* Unchecking is done *before* writing the code. Unchecking makes Greasy
  Fork copy ace's content into the textarea, so doing it afterwards
  would wipe what we just wrote.
* It also removes `#ace-editor` outright if it's there. Greasy Fork
  imports the ace module before building the editor, so the editor can
  appear *after* our uncheck — and unchecking a box whose editor
  doesn't exist yet does nothing. The submit hook only copies while
  that element exists, so its absence is what actually protects the
  value. The code is written again if anything was torn down on the
  second pass.
* `source_editor=1` is applied *after* the code is set, so ace seeds
  itself from our text.

### Loading files

Fetching happens through `GM_xmlhttpRequest`, so cross-origin sources
like `raw.githubusercontent.com` work.

**What the script will load.** These URLs come from a link anyone could
have written, and what they load lands in a form you may post. So
`assertLoadable()` limits them:

* Only `http` and `https` URLs. No local paths, `file://` or `data:`.
* On this machine, only URLs of the file server's form
  (`/gf-prefill-<token>/...`). A link can't read from other local services.
* `@connect` lists only `greasyfork.org`, for the sign-in check, and
  `localhost`, for the file server. Other sites get the manager's own
  connection prompt, in managers that have one.
* The URL check is in the script because `@connect` only covers hosts,
  and Violentmonkey doesn't enforce it.

**How local files get here.** `greasyfork-url.py` can inline text in the
URL, but `image_files` and `code_upload` need real files, and `file://`
reads don't work. So it starts `serve-files.py` in the background, which
serves just those files on `127.0.0.1`, under a random path.

* Each file is at `<base>/files/<path>`, where `<path>` is relative to
  the folder all the files share, so two files with the same name stay
  apart.
* The script names each upload after the last part of its URL.

The server's lifetime:

* It waits up to 5 minutes for the first request. The normal path makes
  one within seconds, so this only runs out when the script isn't
  installed, and leaves time to install it.
* After that, it exits 90 seconds after the last request.
* While the opener page waits for you to sign in, the script pings the
  server to keep it up.
* The opener page can't ping it without the script. Chrome's Local
  Network Access permission applies to a public page's requests to
  `localhost`, so that would mean a permission prompt on the status
  page. Installing for more than 5 minutes means running the
  command again, as the page then says.

### Submitting

### Why there's no auto-submit

The parameters live in a URL, and a URL is clickable from anywhere — an
email, a forum post, a redirect. A working `submit` parameter would
mean that one click on a link someone else wrote posts a script to your
Greasy Fork account, with nothing shown to you first. Prompting for
confirmation first would be no better than the intended workflow, which
is to read the filled form and click Greasy Fork's own button.

So the submit code is commented out in the script rather than deleted,
with the notes below, and a `submit` parameter in the hash logs that
it's disabled. Were it ever re-enabled, the two forms submit
differently, which is why it clicks a button rather than calling
`form.submit()`:

* New version and import have a plain
  `input[type="submit"][name="commit"]`.
* The new-script page had one too when it was saved for the spec
  (signed in, 2026-11-03), with no captcha. It has also been seen with
  `button.g-recaptcha[type="submit"]` instead, with a
  `data-callback="submitInvisibleRecaptchaFormScriptVersion"` — an
  invisible reCAPTCHA Enterprise widget. The captcha token is
  obtained by the widget's own click handler, so the form must be
  submitted *through* a click; `form.submit()` would post without a
  token and be rejected. A scripted click still runs that handler,
  but the challenge is scored, so an automated post of a brand-new
  script would be the least reliable case. The new-version and import
  forms carry no captcha.

Every form also carries a Rails `authenticity_token` hidden field.
Because the page's own already-rendered form is what gets posted, that
token comes along untouched — which is also why this is a userscript
and not a `curl` script.

### Greasy Fork's own prefill endpoint

Greasy Fork already has a prefill mechanism, so it's worth being clear
about why this script exists alongside it. From its source
(`app/controllers/script_versions_controller.rb`, `config/routes.rb`):

* `POST /script_versions/prefill` and
  `POST /scripts/<id>/versions/prefill` render the normal form with the
  **Code textarea** filled from a `script_version[code]` form field.
  The comment in the controller calls it the "externally open prefill
  URL used by script managers" — it's what a manager's "publish to
  Greasy Fork" button posts to, and the route skips the CSRF check so
  an outside page can reach it. The new-script variant alternatively
  takes `import_url` (plus `sync_type`) and fetches the code
  server-side. That's the whole interface: no additional info,
  changelog, attachments, library name/description, or adult flag.
* A plain `GET …/new` reads only `script[script_type]` (`1`/`2`/`3`)
  and `language` (`js`/`css`). Code is ignored on GET — that branch
  is gated on the POST route.
* `GET /import` reads nothing; `sync-urls`, `sync-language` and
  `sync-type` are only consumed by the `POST /import/add` submission.

So the site covers one field, and only via POST — which can't be
launched from a command line as a URL. It *could* be reached with the
same bounce we use for over-long URLs (`write_launcher` in
`greasyfork-url.py`): a local `file://` page containing a
`<form method="post">` with the code in a hidden field, submitted from
its own script. Untested; one open question is whether the session
cookie survives a cross-site top-level POST (Rails defaults to
`SameSite=Lax`, which withholds cookies on those), in which case the
bounce would land on the login page.

Everything else this script fills — additional info and changelog
from files, ordered image attachments, `remove_images`, the code
upload input, library fields, locale, the source-editor toggle, the
import form — has no server-side equivalent, and those are the parts
that make the publishing flow worth automating.

### What we assume stays stable

* The three URL paths, and the optional locale prefix on each.
* The field ids in the tables above, particularly the
  `script_version_additional_info_0_*` naming for the first (default)
  additional-info block.
* The `div.previewable` / `a.preview-tab` structure around the
  markup-backed textareas.
* The sign-in redirect ending at `/users/sign_in`.
* `name="commit"` on the submit buttons (or the `g-recaptcha` class,
  where the new-script page has one).
* Attachment ordering following upload order.
