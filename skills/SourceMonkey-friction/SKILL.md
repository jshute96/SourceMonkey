---
name: SourceMonkey-friction
description: Record friction from userscript development with SourceMonkey tools (sm-dev, the Playwright harness, the SourceMonkey-dev skill, the script manager) in a shared friction log. Use when finishing a task that ran into problems with those tools (at commit time, or when abandoning the work), without being asked, or when the person asks to log friction. Also covers compacting the log: moving fixed and obsolete items out, and combining the rest.
---

# SourceMonkey friction log

The friction log collects problems hit while developing userscripts
with SourceMonkey (SM) tools: `sm-dev`, the Playwright harness, the
`SourceMonkey-dev` skill and the other SourceMonkey skills
(`SourceMonkey-userscripts`, `install-in-SourceMonkey`), and the script manager (the SourceMonkey
extension itself). It's input for improving those tools.

## Where the log lives

`SourceMonkey-friction.md`, in the directory *above* the repo you're
working in (`../SourceMonkey-friction.md`). That keeps it out of any
one repo, so sessions in multiple repos share one log.

- If the person or the repo's instructions name another path, use that.
- If the file doesn't exist, create it from
  [references/template.md](references/template.md), which has the
  title, the tags, and the entry format.
- Next to it, `SourceMonkey-friction-done.md` holds fixed items and
  `SourceMonkey-friction-obsolete.md` holds items set aside, moved there
  when the log is compacted (see [Compacting the log](#compacting-the-log)).
  New entries never go in those.

## When to add an entry

Write one entry per task, when the task is finished and it ran into
friction with the tools, without being asked. Finished means:

- You're committing the work, or
- The work is being abandoned (it failed, or the person dropped it).

Don't log each problem as it comes up; collect them and write the entry
at the end, so one task doesn't produce many separate notes.

- Put a `---` line before each new entry.
- If more work on the same task follows on the same day, add to that
  task's entry instead of starting a new one. It's the same task when
  the entry has today's date and the same topic in its heading, and
  this repo on its `Repo:` line.
- Otherwise, don't rewrite earlier entries. If you learn more about an
  issue logged earlier (like what the real problem was, or that it's
  now fixed), add a dated note to it instead, as in
  [Notes on earlier items](#notes-on-earlier-items).
- Other sessions may write to the same file. Re-read it just before
  adding to it, and add rather than rewriting the whole file.

## What an entry has

Follow the template in the log file (or
[references/template.md](references/template.md)):

- A `##` heading with the date and a short topic, then the repo and the
  scripts worked on.
- What we were trying to do.
- The friction: things that failed or misled, confusing output, and
  anything better tools could make easier or faster. Add a concrete
  idea for fixing each one when there is one.
  - Start each item with one or more tags:
    - `[tools]`: the dev tools: sm-dev, the Playwright harness, and the
      skills.
    - `[SM]`: the SourceMonkey script manager itself (the extension):
      injection, `GM_*` APIs, header handling.
    - `[general]`: general issues making scripts work, which could
      come up on many sites.
    - `[site-specific]`: this site or this script.
    - `[unknown]`: not sure which.
    - `[bug]`: added to one of the above when it looks clearly broken,
      rather than missing or awkward.
- Missing tools that would have made this faster: features that don't
  exist, rather than ones that misbehaved. Tag these too.
- What worked well, including whether the skill or `--help` already had
  the information needed, or it took research.
  - If you found later that the tools can do what you needed, but it
    wasn't obvious or easy to find, note that.
- The sm-dev log file paths (from `start` or `status`) if they show
  what happened.

When an item repeats one in the log's Open items section, say so
with its ID: `Repeat of Open items #5 ("<its summary>")`, or `Related
to` when it's only close. Compacting adds it to that item's count.

Under a numbered item, indent a sub-bullet to line up with the item's
text: 3 spaces under `1.` to `9.`, and 4 under `10.` and up. With too
few spaces, Markdown doesn't nest it under the item.

Be specific: exact commands, error text, and what you tried. An entry
should make sense to someone fixing the tools months later, without
the session transcript.

## Notes on earlier items

When an item logged earlier is looked into or fixed, add a sub-bullet
under that item, starting with a dated label:

- `Investigated (YYYY-MM-DD): <what was found>`: looked into, not fixed.
- `Fixed (YYYY-MM-DD, <short commit id>): <what changed>`: a change
  should fix it.
  - Leave out the commit id when there isn't one clear commit.
  - Leave out the description when there's nothing to say beyond that
    it was fixed: `Fixed (YYYY-MM-DD, abc1234).`

When an item is fixed, strike through its text and its other
sub-bullets with `~~...~~`, leaving the `Fixed` bullet plain, so open
items stand out.

- Strikethrough doesn't cross paragraph or list-item breaks, so wrap
  each paragraph and bullet separately.

A finding about the entry as a whole, rather than one item, goes at
the entry's end: a `### Update YYYY-MM-DD` heading, then what was
learned.

## Compacting the log

When the person asks to compact the friction log, or to clean it up,
do the following. "Items" means both friction and missing-tools items.

1. Make sure a backup exists first. If the person hasn't made one,
   copy the log to `SourceMonkey-friction.md-MMDD.md` (today's date).
2. Move each struck-through item, with its notes, to
   `SourceMonkey-friction-done.md`, under the heading of the entry it
   came from (add the heading there if it's new). An item from an
   earlier compacted section goes under that section's heading, with
   its `#N`. Add to the file; don't rewrite what is there.
3. Spot-check open items that may be fixed now: try the command, or
   read the code. Move the fixed ones to the done file too, struck
   through as in [Notes on earlier items](#notes-on-earlier-items),
   with a `Fixed (checked YYYY-MM-DD): <how>` note ("checked": found
   fixed now, with no known commit).
4. Move to `SourceMonkey-friction-obsolete.md`, naming the entry each
   came from, items that are:
   - intended behavior, or already documented as a known limit;
   - outside the tools: a site's bot wall or outage, the machine, how
     agents were briefed;
   - overtaken by later changes;
   - too obscure to act on: one unconfirmed report where nothing broke.

   Put each under the heading for its reason, reusing the headings
   already there. Add to the file; don't rewrite what is there.
5. Rewrite what is left as the log's `## Open items (compacted
   YYYY-MM-DD)` section, after the log's intro and template and before
   any new entries, with a `---` line before it:
   - Start it with a short paragraph: the dates of the entries it
     covers, where the done, obsolete and backup files are, and that
     IDs are written into the text.
   - Combine reports of the same problem into one item, with how many
     reports and their dates: `(4 reports, 2026-10-02 to 10-14)`.
   - Describe each as it is now: drop the parts that have been fixed,
     and keep the concrete examples and ideas that are still useful.
   - Group items under short `###` headings by area.
   - Write each item as a plain bullet starting with its ID,
     `- **#N** [tags] **<summary>** (<N> reports, <dates>)`, numbered
     straight through all the groups, with sub-bullets indented 4
     spaces. Not a numbered list: some renderers restart those at 1
     under each heading, so the numbers shown wouldn't match the
     "Open items #N" that later entries cite.
   - Fold an earlier compacted section into the new one: its items keep
     their counts, plus the new reports, including later items marked
     as repeats of them. Fold a `Related to` item in when it's the same
     problem; otherwise it stays its own item.
   - Number the new section afresh.
   - Leave out the per-entry "What worked well" and log-path notes.
     The backup keeps them.
6. Check every open item went somewhere: the done file, the obsolete
   file, or an item of the new section.
7. Re-read the log just before writing it, to check if another session
   added any new entries concurrently.
