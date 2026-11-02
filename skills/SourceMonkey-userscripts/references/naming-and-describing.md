# Naming and describing a script

`@name` and `@description` are what people see in the userscript
manager, in search results, and on the script's page when it's
published to a repository site like [Greasy Fork](https://greasyfork.org/).
Each is written for a reader who may never see the other, or the
script's longer docs.

A repo may also keep a longer description (a doc file, a README). Write
them as a set and keep them consistent; the longer one adds detail to
the `@description`, without contradicting it.

When either changes on an existing script, bump `@version`, so
installed copies pick up the new text.

## `@name`: one line, "Site Name: title"

Many tools show *only* the `@name`, so on its own it has to say which
site the script is for and what it does, and ideally interest someone
who has that problem.

It's also what search mostly matches on (Greasy Fork's script search
appears to look at little more than the name), so include the words
someone looking for the script would actually search for.

- **Site name**, then a colon. Use the site's own brand name, not its
  domain: `Google Calendar`, not `calendar.google.com`. Use the fullest
  common form rather than an abbreviation (`NYTimes`, not `NYT`), since
  the abbreviation someone searches for may not be the one we picked.
  - `Site Name Section:` when the script applies to one section or
    feature of a large site: `Peloton Player`, `NYTimes Spelling Bee`.
    Scripts for the site as a whole keep the plain site name.
- **Title** after the colon: sentence case, no trailing period.
  Describe the change or feature, not the mechanism. Prefer a verb
  phrase (`Show elevation loss as well as gain`, `Auto-close the
  newsletter popup`) or a plain noun phrase for a thing that's added
  (`Keyboard comment navigation`).
- Keep the whole thing under about 70 characters, so it doesn't wrap
  or get cut off in a script list.
- Don't put "userscript", "script" or a manager's name in it.
- Where several scripts do the same job on different sites, use the
  *same* title on each.

## `@description`: 1 to 2 sentences, up to about 160 characters

What the script is for, and what it adds or changes, in general terms.
It's the blurb under the name in script lists and search results.

- Say what the script does and, where it's the point of the script,
  what was wrong or missing without it. A bug-fix script describes the
  bug.
- General terms only: no selectors, no key-by-key listings, no
  configuration syntax. Those go in longer docs.
- Don't restate the `@name`; assume the reader just read it.
- No trailing "...on this site" filler, and no first person.
