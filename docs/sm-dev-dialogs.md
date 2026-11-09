# sm-dev dialogs

One `dialog` command for every kind of box that waits for an answer.
The code is in `src/harness/dialogs.ts`, with the command in
`console-commands.ts`.

- **Built:** the page's JavaScript dialogs, Chrome's "Leave site?",
  SourceMonkey's connection prompts, and file choosers.
- **Not built:** the File System Access pickers, and HTTP sign-in.
  Their known limits and what might be done later are in TODO.md,
  under "sm-dev dialogs".
- How a page's JavaScript dialogs are caught is in
  [sm-dev-design.md](sm-dev-design.md#dialogs).

## Why

- Each kind of dialog has had its own one-off handling, and some have
  none. A box nobody can answer leaves the page or the test stuck.
- Browser-drawn dialogs are outside the page's DOM (its document tree),
  and CDP (Chrome DevTools Protocol, how sm-dev drives Chrome) has no
  access to the browser's own UI. Headless Chrome draws no such UI at
  all. So `snapshot` and `click` can't reach them.
- Each kind can be caught as it opens, over CDP or with a stub, and
  answered from sm-dev. This design gives all of them one shape, so a
  new kind needs a tracker and no new command.

## Kinds of dialogs

| Kind | Opened by | From | Caught by |
|---|---|---|---|
| Alert, Confirm, Prompt | `alert()`, `confirm()`, `prompt()` | The page | Playwright's `dialog` event |
| Leave site | A `beforeunload` handler | Chrome | Playwright's `dialog` event |
| Connection permission | A request to a host the script's `@connect` lines don't cover | SourceMonkey | The extension's `connect-prompt` event |
| File chooser | Clicking an `<input type=file>`, in the document or not | Chrome | `Page.setInterceptFileChooserDialog` |
| Open, Save and Directory pickers (not built) | `showOpenFilePicker`, `showSaveFilePicker`, `showDirectoryPicker` | Chrome | None yet: refused while file choosers are caught (see [Pickers](#pickers)) |
| Sign in (not built) | A server's HTTP Basic auth challenge | Chrome | `Fetch` with `handleAuthRequests` (see [Sign in](#sign-in)) |

- **From** names who wrote the text: the page for its own message,
  Chrome for its own boxes, or SourceMonkey.
- These stay outside the `dialog` command:
  - **Downloads** already go into the run's folder without a prompt in
    a launched browser ([sm-dev-design.md](sm-dev-design.md#downloads-download-watchts)).
  - **Site permission requests** (geolocation, notifications,
    clipboard, camera) send no CDP event, so nothing can list them. A
    `start` flag to grant or deny them up front is a separate item.
  - **`window.print()`** does nothing in headless. A visible browser
    shows print preview for the person.
  - **Native popups** for `<select>`, date and color inputs don't block
    anything, and keys or `type` reach the field.
  - **Chrome's "Open xdg-open?" prompt** for a custom-scheme link
    (`snssdk://`) is browser UI with no CDP event or answer. It is in
    TODO.md under "sm-dev runs: follow-ups".

## Addressing a dialog

- **A tab can have more than one dialog waiting**, so the tab alone
  doesn't always name one.
  - A JavaScript dialog stops the page, so the page opens no other
    dialog while it is up.
  - A file chooser or picker doesn't stop the page, which can open
    another dialog afterwards.
  - Connection prompts are per script and host, so more than one can
    wait at a time. Each one belongs to the tab whose request opened it.
- **Each dialog gets an id**: its tab and a number counting that tab's
  dialogs over the run (`T1.1`, `T1.2`).
  - Numbers aren't reused, so an id never names a later dialog.
  - Event lines, `dialog show` and `tabs` show the id.
- **`dialog` commands act on**, in order:
  - the one `--dialog T1.2` names, for that command only;
  - with `--tab`, the selected dialog if it's on that tab, else one on
    that tab, picked as below;
  - else the default dialog (`defaultDialog`):
    - the one `dialog select T1.2` picked, while it is still waiting;
    - one waiting on the current tab;
    - one waiting in the run.
  - Among those on a tab or in the run, a dialog that blocks its page
    comes first, then the oldest (`firstToAnswer`).
    - A file chooser's answer runs on its page (its `change` or
      `cancel` event), so it would wait while a prompt holds the page.
      Putting the prompt first makes the default the one that can be
      answered.
    - Answering a file chooser while a JavaScript dialog blocks its page
      is refused, naming that dialog.
- So with one dialog waiting, which is the usual case, no id or tab is
  needed, even for a dialog on another tab.

## Commands

All but `dialog select` take `--tab` and `--dialog`.

| Command | Does |
|---|---|
| `dialog show` | Shows the tab's waiting dialogs: what each one asks, its fields and buttons, and the commands that answer it. Ends with a line for each other tab that has one. |
| `dialog select <id>` | Makes that dialog the default for the `dialog` commands that follow. |
| `dialog set <field> <value...>` | Sets a field. Only the `files` field of a chooser that takes multiple files takes more than one value. |
| `dialog accept [value...]` | Clicks the dialog's OK button. With one or more values given, it first sets the dialog's only field to them. |
| `dialog cancel` | Clicks the Cancel button, or closes a dialog that has no Cancel (an Alert). |
| `dialog click <button>` | Clicks the button with that label, matched case-insensitively. |

- Field values are kept by sm-dev until the dialog is answered, so
  `set` can be run more than once, and `show` shows them.
- A value with spaces has to be quoted, as a field that takes one value
  refuses more than one word.
- A word that is no command but names a dialog's action (`accept`,
  `dismiss`, `connect`, `alert`, `confirm`, `upload`) suggests `dialog`
  (`GUESSED_NAMES`).
- `dialog show --json` gives each dialog as an object, as other
  commands' `--json` does ([sm-dev-json.md](sm-dev-json.md)).

## `dialog show` output

Each dialog gets named fields, then a table of its fields (if any) and
a table of its buttons. Each table shows the command to use.
Each example below is from a run of its own.

With more than one dialog waiting, the output starts by saying which
one `dialog` commands apply to by default, and each one follows, oldest first:

```
T1 has 2 dialogs waiting. `dialog` commands apply to T1.1 by default.
Use `--dialog` or `dialog select` to choose another.

T1.1  Connection permission (default for `dialog` commands)
  ...

T1.2  Confirm
  ...
  Buttons:
    Button  Command
    OK      dialog accept --dialog T1.2
    Cancel  dialog cancel --dialog T1.2
```

- A dialog that isn't the default one shows its commands with
  `--dialog`, so each command shown can be used as written.

A Confirm, alone on its tab:

```
T1.1  Confirm
  From:     The page (https://www.example.com/lists)
  Opened:   During `click 'text=Delete'`, 12 seconds ago
  Message:  Delete 3 items?

  Buttons:
    Button  Command
    OK      dialog accept
    Cancel  dialog cancel
```

A Prompt, with its field:

```
T1.1  Prompt
  From:     The page (https://www.example.com/lists)
  Opened:   During `menu 'New list'`, 3 seconds ago
  Message:  Name for the new list:

  Fields:
    Field  Value                 Set with
    text   "Untitled" (default)  dialog set text <text>

  Buttons:
    Button  Command
    OK      dialog accept [text]
    Cancel  dialog cancel
```

A file chooser:

```
T1.1  File chooser
  From:     Chrome, for an <input type=file> on https://space.bilibili.com/
  Opened:   During `menu 'Import'`, 5 seconds ago
  Choose:   One file
  Accepts:  .json

  Fields:
    Field  Value   Set with
    file   (none)  dialog set file <file>

  Buttons:
    Button  Command
    Open    dialog accept [file]
    Cancel  dialog cancel
```

A connection prompt, whose buttons need a "Does" column:

```
T1.1  Connection permission
  From:     SourceMonkey, for the script "Bilibili favlist backup"
  Opened:   During `click 'text=Export'`, 1 second ago
  Message:  Bilibili favlist backup requests permission to connect to api.bilibili.com (GET https://api.bilibili.com/x/v3/fav/resource/list).

  Buttons:
    Button           Command                         Does
    Allow once       dialog accept                   Lets this request through
    Cancel           dialog cancel                   Fails this request
    Allow            dialog click Allow              Allows the host for this script from now on
    Deny             dialog click Deny               Fails the script's requests to the host from now on
    Allow all sites  dialog click "Allow all sites"  Allows all hosts for this script from now on
```

- **`Opened`** names the command that was running when the dialog
  opened. A dialog that opened between commands just gives how long ago
  it opened.
- **The `[text]` and `[file]` in a button's command** show that
  `accept` can take the field's value directly.

## Fields and defaults

| Kind | Fields | Default |
|---|---|---|
| Prompt | `text` | The page's default value |
| File chooser | `file`, or `files` when it takes multiple files | None |
| Open picker (not built) | `file`, or `files` when it takes multiple files | None |
| Save picker (not built) | `file` | The page's suggested name, in the run's downloads folder |
| Directory picker (not built) | `directory` | None |
| Sign in (not built) | `username`, `password` | None |

- **A default is only what the page gives** (a prompt's default text,
  a save's suggested name). A chooser starts with no file, as Chrome's
  own does, so `dialog accept` refuses until a file is given, and names
  the field to set.
- **Relative paths** resolve against the directory the `sm-dev`
  command ran in, and globs expand, as other file arguments do
  ([sm-dev-design.md](sm-dev-design.md#file-arguments-checksts-path-argsts)).
- **`Accepts`** is shown, not enforced, as Chrome's own chooser lets a
  person pick other files too.
- **A password** (not built, for Sign in) would show as `(set)`, and
  stay out of the run's log.
- **A save** (not built, for the Save picker) would write into the run's
  downloads folder, made for a connected browser's run too, and be
  reported like a download.

## How each kind is caught

### JavaScript dialogs and Leave site

- Each tab's `DialogTracker` catches them, lists each one, and answers
  it through Playwright's `Dialog` (`javascriptSpec`).
- "Leave site?" shows Chrome's own words, as the page's message is
  ignored there.
- A dialog whose close went unseen would stay listed. So before each
  command, the tracker checks that a page it holds a dialog for is
  still stopped (`verify`): a page with every frame answering within
  300 ms has no dialog open.
  - Every frame, since a cross-site iframe runs in a process of its own,
    which its dialog stops while the rest of the page runs on.
  - Not before a command that answers or fills a dialog, which finds
    out for itself, so answering doesn't wait on the check. This is the likely cause of a friction
  report where, after two confirms in a row, `tabs` still named the
  first and answering it said it was already closed.

### File chooser

- Each run tab's lasting CDP session turns on
  `Page.setInterceptFileChooserDialog`, so Chrome shows no chooser and
  sends `Page.fileChooserOpened` instead.
- The event carries the input's `backendNodeId` (Chrome's id for the
  element), and `accept` answers with `DOM.setFileInputFiles` on it.
  - This also works for an input that was never added to the document,
    which is what a script's `.click()` on a new input gives.
- An intercepted chooser doesn't stop the page, so it can wait as long
  as needed.
- `dialog cancel` sends the input a `cancel` event, as Chrome's own
  chooser does, so a page that waits for one goes on.
- A frame that navigates drops its choosers; the top frame, all of the
  tab's.
- Choosers are caught only while the run reads commands. Otherwise
  Chrome shows its own, for a person at the browser.
- An iframe from another site runs in a process of its own, which the
  tab's session doesn't reach, so its choosers aren't caught.

### Pickers

Not built. What's known, from the dialogs example
(`userscripts/examples/dialogs/`):

- **CDP can't hand a picker to sm-dev.**
  - While `Page.setInterceptFileChooserDialog` is on, Chrome sends
    `Page.fileChooserOpened` for `showOpenFilePicker`,
    `showSaveFilePicker` and `showDirectoryPicker` too, with no
    `backendNodeId`. It fails the call at once with an `AbortError`
    ("Intercepted by Page.setInterceptFileChooserDialog()").
  - So there's nothing to answer. sm-dev prints a warning
    (`PICKER_REFUSED`) rather than listing a chooser.
  - In headless Chrome with interception off, a picker never returns.
  - In a visible browser with interception off, Chrome should show its
    real picker. That hasn't been tried.
- **Under Tampermonkey**, the script's sandbox can't call the pickers
  at all ("Illegal invocation").
- **A stub is the remaining way** to answer them, if it's ever worth it:
  - It replaces the pickers before the page's code runs, asks sm-dev
    through a CDP binding (`Runtime.addBinding`), and returns handles
    whose `getFile()` and `createWritable()` read and write through
    sm-dev.
  - A stub set over CDP runs in the page's world only. A script with
    grants runs in the `USER_SCRIPT` world, where it calls the real
    pickers. SourceMonkey's prelude could install the stub there too.
    Under Tampermonkey or Violentmonkey, a stub can't reach that world.

### Sign in

- `Fetch.enable` with `handleAuthRequests` sends `Fetch.authRequired`,
  answered with `Fetch.continueWithAuth`.
- It also pauses every request, each of which then waits on sm-dev to
  continue it. That would slow pages down, and it conflicts with a
  person's own `cdp Fetch.*` calls.
- So first test what headless does with a challenge today, and
  make catching it a `start` flag if it costs too much to keep on.

### Connection permission

- sm-dev builds the dialog from the extension's `connect-prompt` events
  (`connectSpec`), on the tab whose request opened the prompt.
- The button labels come from `CONNECT_BUTTONS` in `src/gm-connect.ts`,
  which the prompt window takes its labels from too, so they can't
  drift apart.
- A prompt that closes with nobody waiting is dropped, and the run says
  it closed without an answer.

## Tampermonkey and Violentmonkey

- **Page and Chrome dialogs** are caught at the browser level, so they
  work the same under each manager.
- **A manager's own prompts** (such as Tampermonkey's `@connect`
  confirmation, which opens as an extension page) could later be
  recognized and listed with that manager as the source. Until then,
  they show as another tab.

## Telling about a dialog

### When it opens

- **The stream's event for a new dialog is its whole `dialog show`
  block**, its first line marked `*DIALOG*` (`*DIALOG* T1.1  Confirm`).
  So the fields, buttons and commands are right there, with no
  `dialog show` needed first.
  - With another dialog already waiting in the run, the commands shown
    include `--dialog`.
  - In a visible browser, it ends by saying the dialog can also be
    answered there.
  - JSON events aren't built yet ([sm-dev-json.md](sm-dev-json.md#events)).
    When they are, a dialog's should carry the same object as
    `dialog show --json`.
- In a run that takes no commands, a dialog gets one line instead:
  answered in its window when the browser is visible. In a headless
  one, a page's dialog is dismissed, and a connection prompt says
  nothing can answer it.
- The page's own text (a message, a script's name) goes in as text, so
  its backticks aren't read as commands.
- A dialog opened during a command shows in that command's output, as
  stream events do. One opened between commands shows in the stream and
  the run's log, and the next command's reminder names it.
- **The command's own message stays one line**: the "opened a dialog,
  which is waiting for an answer" messages in `page-commands.ts` name
  the dialog's id and leave the details to the block.
- A page that opens many dialogs (an `alert` in a loop) gets a block
  for each one. Each needs answering anyway.

### While it waits

Later mentions are one line each, naming the dialog's id and
`dialog show`:

- **Commands that refuse** while a tab is stopped on a dialog (`menu`,
  `set`, `reload`, `open`, `load`, `update`).
- **The reminders each command ends with** for a dialog that is still
  waiting (`*DIALOG* still waiting: ...`, from `waitingReminders` in
  `console-commands.ts`).
  - Only for a dialog that was already waiting when the command began.
    One that opened during the command just showed its block.
  - Not after a command whose output said how to answer it, or showed
    it.
- **`tabs`** lists each tab's waiting dialogs under it, and its JSON
  has them as `dialogs`.
- **`status`** lists a connection prompt under its script too, and its
  JSON has the prompts shown as dialogs (`permissionPrompts`).
- A connection prompt whose tab closed is dropped, as a person at the
  browser couldn't answer it from that tab either.
- **The stuck-tab message** in `stuck-tabs.ts`, for a tab already on a
  dialog when `start` connects, says to answer it or close the tab,
  since the run can't reach the tab yet.

## Visible browsers

sm-dev still drives the tabs in a visible browser, so it catches dialogs
there too, and `dialog` answers them the same way.

- **JavaScript dialogs** show in the browser as well, so the person can
  answer them there instead.
- **A caught file chooser doesn't show in the browser.** Chrome either
  shows its own chooser or hands it to sm-dev, not both. While it
  hands choosers to sm-dev, it refuses the pickers.
  - So in a visible browser, the person answers it with `dialog` too.
  - The event says that the browser doesn't show it, so a person who
    clicked Upload and saw nothing can find it.
