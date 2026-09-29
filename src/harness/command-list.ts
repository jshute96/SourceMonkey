// Every sm-dev command in one list, in the sections `sm-dev --help`
// shows: the ones sm-dev runs itself (start, stop, ...) and the ones it
// sends to a run (status, click, ...), with their arguments and
// options. `help <command>` picks a command out of it, the prompt
// completes its names, and the run takes each command's flags from it.
//
// No imports, so cli.ts can load it for help without the run's code.

// How many of a selector's matches `probe --css` and `--html` show.
export const PROBE_MAX = 10;

/**
 * A term and what it means: an argument, an option, a way to name
 * something. `commands`: for an option listed in a section rather than
 * under one command, the commands that take it.
 */
export interface HelpItem {
  term: string;
  /** Wrapped to fit; each element starts a new line. */
  about: string | string[];
  commands?: string[];
}

export interface HelpCommand {
  /** The command's name, then its arguments. */
  usage: string;
  about: string | string[];
  args?: HelpItem[];
  options?: HelpItem[];
  /** Options in titled groups, for a command with many (start). */
  optionGroups?: { title: string; options: HelpItem[] }[];
  /** Listed for the reader's sake only; the command's help is elsewhere. */
  pointer?: boolean;
  /** A blank line before it in the full help. */
  gap?: boolean;
}

export interface HelpSection {
  title: string;
  /**
   * Lines before the rest, each wrapped to fit. '' is a blank line, and
   * one starting with two spaces is shown as is.
   */
  text?: string[];
  items?: HelpItem[];
  commands?: HelpCommand[];
  /** Options several commands take, or the section's own. */
  options?: HelpItem[];
  optionsTitle?: string;
  subsections?: HelpSection[];
}

const BROWSER = ['start', 'clear'];
const TAB_LOADS = ['newtab', 'open', 'reload'];
const SETTLING = ['start', ...TAB_LOADS, 'click', 'hover', 'type', 'key'];

export const HELP_SECTIONS: HelpSection[] = [
  {
    title: 'Command input',
    text: [
      'Commands run in order, stopping at the first that fails.',
      'Commands come from one or more of:',
      '  1. Command-line arguments',
      '     - Multiple commands can be separated by "--".',
      '  2. Piped input',
      '     - With --stdin, or with pipe input and no command-line commands.',
      '     - One command per line.',
      '  3. A prompt',
      '     - With --interactive.',
    ],
  },
  {
    title: 'Examples',
    text: [
      'Choose a browser:',
      '  # Start a headless test browser for this sm-dev run.',
      '  sm-dev --temp-browser start <script> [<url>] ...',
      '',
      '  # Launch a visible browser (if not already running).',
      '  sm-dev --open-browser [--cdp <port>] [<commands...>]',
      '',
      '  # Connect to an existing browser.',
      '  sm-dev [--cdp <port>|<url>] <commands...>',
      '',
      'Start sm-dev with a tab, injecting a userscript:',
      '  # Start with an interactive prompt.',
      '  sm-dev --interactive start example.user.js http://example.com',
      '',
      '  # Start, run commands (separated by --), then exit.',
      '  sm-dev start example.user.js http://example.com -- status -- snapshot',
      '',
      '  # Start a persistent server, then send it commands.',
      '  # Rerunning start restarts it with new arguments.',
      '  # It shuts down after an idle period, or with stop.',
      '  sm-dev start example.user.js http://example.com --detach',
      '  sm-dev status',
      '  sm-dev screenshot /tmp/image.png',
    ],
  },
  {
    title: 'General commands',
    commands: [
      { usage: 'help [command]...', about: 'Show commands and options.' },
      { usage: 'exit', about: 'End this sm-dev. Runs it started without --detach stop.' },
    ],
  },
  {
    title: 'Starting a run',
    text: [
      'A run is an sm-dev server process connected to a browser, managing a list of tabs and operating as a SourceMonkey userscript manager injecting scripts into those pages.',
      '',
    ],
    commands: [
      {
        usage: 'start <script>... [url]...',
        about: ['Start a server process and connect to a browser.', 'Load the listed userscripts.', 'Open a tab for each listed URL.', 'Starts with the ID from --run. Stops existing runs with that ID.'],
        args: [
          { term: '<script>...', about: 'Files ending in .user.js, directories, or globs.' },
          { term: '[url]...', about: ['URLs to open.', 'Default: the first script\'s default page (from @match).'] },
        ],
        optionGroups: [
          {
            title: 'Tabs at startup',
            options: [
              { term: '--all', about: 'Open each script\'s default page, one tab per page.' },
              { term: '--noscript', about: 'Start with no scripts loaded.' },
              { term: '--notab', about: 'Open no tabs at startup. (Use newtab later.)' },
              { term: '--from-saved', about: 'Serve .html files as saved page snapshots, at their embedded URLs by default. See Saved pages.' },
              { term: '--url URL', about: 'With --from-saved and one .html file: The URL to serve it at.' },
              { term: '--offline', about: 'With --from-saved: Block network requests from the saved pages.' },
            ],
          },
          {
            title: 'Lifetime',
            options: [
              { term: '--seconds N', about: 'Stop the run after N seconds.' },
              { term: '--detach', about: 'Leave the run going when this sm-dev ends.' },
              { term: '--new', about: 'With --detach: Start a new run (don\'t stop old ones).' },
              { term: '--idle-seconds N', about: ['Stop the run after N seconds with no activity.', '(Default: 1800; 0 never stops).'] },
            ],
          },
          {
            title: 'Options',
            options: [
              { term: '--watch', about: 'Re-inject and reload when a script or its files change.' },
              { term: '--values JSON', about: ['Seed GM_* storage before the scripts run,', 'e.g. --values \'{"units":"metric"}\'.'] },
              { term: '--values-file <path>', about: 'Seed GM_* storage from a file holding a JSON object.' },
              { term: '--page-errors', about: 'Also show errors from the page (not just the script).' },
            ],
          },
          {
            title: 'DevTools',
            options: [
              {
                term: '--devtools',
                about: ['Also start a Chrome DevTools server for the run, and print each tab\'s page id in it. Use with chrome-devtools.', 'On by default when $SM_DEV_DEVTOOLS is 1.'],
              },
              { term: '--nodevtools', about: 'Don\'t start it, even when $SM_DEV_DEVTOOLS is 1.' },
            ],
          },
        ],
      },
    ],
  },
  {
    title: 'Concurrent runs',
    text: [
      'Each run is identified by a run ID (named D1, D2, ..., or D<name>).',
      'If started with --detach, the run continues after sm-dev exits.',
      'sm-dev sends commands to a running server.',
      'If only one run is active, it\'s used by default.',
      'Otherwise, use --run to choose.',
      '',
    ],
    commands: [
      { usage: 'start <script>... [url]...', about: 'Start a run, and connect to it. See Starting a run.', pointer: true },
      { usage: 'list', about: 'List the active runs.' },
      { usage: 'attach [ID]', about: 'Connect to an existing run.' },
      { usage: 'stop [ID|--all]', about: 'Stop a run, or all runs.' },
    ],
  },
  {
    title: 'Status',
    commands: [
      {
        usage: 'status',
        about: 'Show overall status, script list, and tab list.',
      },
    ],
  },
  {
    title: 'Scripts',
    commands: [
      { usage: 'scripts', about: 'List the loaded scripts.' },
      { usage: 'script <script>', about: 'Select the active script by ID. With T2.3, pick tab T2 too.' },
      { usage: 'load <script>...', about: 'Load more scripts from disk: files, directories, or globs. See Files and file patterns.' },
      { usage: 'update [script]', about: 'Re-read one (or all) scripts from disk, and reload all affected tabs.' },
    ],
    subsections: [
      {
        title: 'Checking scripts',
        text: [
          'Without a run, these check script files and URLs. In a run, they can also reference scripts and tabs by ID, or use the currently selected script and current tab\'s URL by default.',
          '',
        ],
        commands: [
          {
            usage: 'match [script]... [url]...',
            about: 'Report whether each script would run on each page, and list the header rules that matched or excluded it.',
            args: [
              { term: 'all-scripts', about: 'In a run: all loaded scripts.' },
              { term: 'all-tabs', about: 'In a run: all tabs.' },
              { term: 'all', about: 'In a run: all scripts on all tabs.' },
            ],
          },
          {
            usage: 'validate [script]...',
            about: ['Check scripts (headers, syntax, @requires) without loading them.', 'With a directory, all scripts under it.'],
            args: [{ term: 'all', about: 'In a run: all loaded scripts.' }],
            gap: true,
          },
        ],
      },
    ],
  },
  {
    title: 'Tabs',
    commands: [
      { usage: 'tabs', about: 'List the tabs this run controls.' },
      { usage: 'tab <tab>', about: 'Select the active tab by ID.' },
      {
        usage: 'open [page]',
        about: 'Open a URL in the current tab.',
        args: [
          { term: '<url>', about: 'A URL.' },
          { term: '<file>', about: 'A file, or a glob matching one.' },
          { term: '<script ID>', about: 'A script\'s default page.' },
          { term: '(default)', about: 'The selected script\'s default page.' },
        ],
        gap: true,
      },
      {
        usage: 'newtab [page...|all]',
        about: [
          'Open a new tab for each page (a URL, file, glob or script ID), or a blank tab.',
          'The first new tab is selected and focused.',
          'With a script ID: that script\'s default URL.',
          'With all: one tab for each script\'s default URL.',
        ],
        gap: true,
      },
      { usage: 'reload [T<n>|all]', about: 'Reload this tab, another tab, or all tabs.', gap: true },
      { usage: 'focus [T<n>]', about: 'Bring the tab to the front.', gap: true },
    ],
    optionsTitle: 'Options for open, newtab, reload',
    options: [
      { term: '--noscript', about: 'Run no scripts in the tab. (Sticky)', commands: TAB_LOADS },
      { term: '--script', about: 'Run the scripts in the tab again. (Undo --noscript.)', commands: TAB_LOADS },
      { term: '--from-saved', about: 'Serve .html files as saved page snapshots, at their embedded URLs by default.', commands: ['newtab', 'open'] },
      { term: '--url URL', about: 'With --from-saved and one .html file: The URL to serve it at.', commands: ['newtab', 'open'] },
      { term: '--offline', about: 'With --from-saved: Block network requests from the saved pages.', commands: ['newtab', 'open'] },
    ],
    subsections: [
      {
        title: 'Saved pages',
        text: [
          'With --from-saved, pages contents are served from saved html snapshot files. Chrome shows the page running at its original URL, so the page and its scripts work as on the live site. --offline blocks network requests to other live pages.',
          '',
          'Page URLs are taken from the header comment in the HTML file if present. Otherwise, pass the URL with --url.',
          'The tab keeps serving that URL from the file, rereading it on reloads.',
        ],
      },
    ],
  },
  {
    title: 'Inspecting the page',
    commands: [
      {
        usage: 'snapshot [tab] [selector]',
        about: ['Print the page, or an element, as its accessibility tree, with a ref for each element.'],
        options: [
          { term: '--visible', about: 'Only what is on screen.' },
          { term: '--out FILE', about: 'Write it to a file instead.' },
        ],
      },
      {
        usage: 'screenshot [tab] [selector] <file>',
        about: 'Save a PNG of what is on screen, or of an element.',
        options: [{ term: '--full', about: 'The whole page.' }],
        gap: true,
      },
      { usage: 'savehtml [tab] <file>', about: 'Save the page\'s HTML (live DOM snapshot).', gap: true },
      {
        usage: 'probe [tab] <selector>...',
        about: ['Look up selectors.', 'Report which are found, how many times.'],
        options: [
          { term: '--css', about: `For the first ${PROBE_MAX} matches, show a unique CSS selector, if one exists.` },
          { term: '--html', about: `For the first ${PROBE_MAX} matches, show the start of each one's HTML.` },
        ],
        gap: true,
      },
      { usage: 'logs [tab]', about: 'Print the page\'s console log and errors so far.', gap: true },
    ],
  },
  {
    title: 'Driving the page',
    commands: [
      { usage: 'click [tab] <selector>', about: 'Click an element.' },
      { usage: 'hover [tab] <selector>', about: 'Move the mouse over an element.', gap: true },
      { usage: 'type [tab] <selector> <text>', about: 'Type text into an element. (Text box, etc.)', gap: true },
      { usage: 'key [tab] <keys>...', about: ['Press keys in order, using common key names.', 'e.g. key j Shift+ArrowRight Escape'], gap: true },
      {
        usage: 'eval [tab] <js>',
        about: [
          'Evaluate JavaScript in the page and print the result.',
          'The last expression is the result, as in the DevTools console. A top-level return works too.',
          'eval {{ starts a multi-line block, ended by }}.',
        ],
        options: [
          { term: '--script', about: 'Evaluate in the scripts\' world.' },
          { term: '--file <path>', about: 'Evaluate a JavaScript file, in place of <js>.' },
        ],
        gap: true,
      },
    ],
    subsections: [
      {
        title: 'Waiting',
        commands: [
          {
            usage: 'wait [T<n>|all]',
            about: [
              'Wait until one tab, or all tabs, settles.',
              'Meaning: The page loaded, its scripts ran, and no requests or DOM changes happened for a short interval.',
              'Most commands doing browser actions wait by default before returning, unless they have --nowait.',
            ],
          },
          { usage: 'wait selector <css>', about: 'Wait until an element matches.', gap: true },
          { usage: 'wait selector-gone <css>', about: 'Wait until no element matches.' },
          { usage: 'wait log <text>', about: 'Wait for an output line with the text, or matching /regex/, printed since the previous command began.', gap: true },
          { usage: 'wait <time>', about: 'Wait that long, e.g. 500ms or 2s.', gap: true },
        ],
        options: [
          { term: '--timeout-seconds S', about: 'Give up after S seconds (default: 5).', commands: ['wait'] },
        ],
      },
      {
        title: 'Menus',
        commands: [
          {
            usage: 'menu [what]',
            about: 'List the tab\'s menu commands, or fire one.',
            args: [
              { term: 'T2', about: 'List a tab\'s.' },
              { term: 'all', about: 'List all tabs\'.' },
              { term: 'M2, T2.M2', about: 'Fire one, by number.' },
              { term: '<label>', about: 'Fire one, by its label.' },
            ],
          },
        ],
      },
      {
        title: 'Stored values',
        commands: [
          {
            usage: 'values [what]',
            about: 'Print values scripts have stored in GM Storage.',
            args: [
              { term: '<script>', about: 'One script.' },
              { term: 'all', about: 'All scripts. (Default)' },
              { term: 'T2', about: 'Scripts running on a tab.' },
            ],
          },
          { usage: 'get <key>', about: 'Print one value for the selected script.', gap: true },
          {
            usage: 'set <key> <json>',
            about: ['Store a value for the selected script.', 'set <key> {{ starts a multi-line block of JSON, ended by }}.'],
            options: [{ term: '--file <path>', about: 'Read the JSON from a file, in place of <json>.' }],
          },
        ],
      },
      {
        title: 'Dialog boxes',
        commands: [
          { usage: 'accept [text]', about: 'Answer an open dialog with OK, and a prompt with the text.' },
          { usage: 'dismiss', about: 'Answer an open dialog with Cancel.' },
        ],
      },
    ],
  },
  {
    title: 'Controlling the SourceMonkey extension',
    text: ['Instead of injecting the scripts itself, a run can push them into the SourceMonkey extension in the browser it connects to.', ''],
    commands: [
      { usage: 'clear --extension', about: 'Remove all scripts in the extension\'s Scratch collection, and turn solo mode off.' },
    ],
    optionsTitle: 'Options for start',
    options: [
      { term: '--extension', about: 'Push the scripts into the extension\'s Scratch collection instead of injecting them.', commands: ['start'] },
      { term: '--solo', about: 'With --extension: Disable all other collections, and run only the started scripts, until this run ends.', commands: ['start'] },
    ],
  },
  {
    title: 'Global options',
    text: ['These go first, before any command, and apply for later commands.'],
    subsections: [
      {
        title: 'Where to get input commands (after processing command-line arguments)',
        options: [
          { term: '--stdin', about: ['Read commands from stdin.', 'This is the default when command-line has no commands and stdin is piped input.'] },
          { term: '--interactive', about: 'Read commands interactively from a prompt.' },
        ],
      },
      {
        title: 'Browser selection',
        options: [
          { term: '--cdp URL|PORT', about: ['The browser to connect to, and where --open-browser starts one: a URL, host:port, or port.', '(Default: $SM_DEV_CDP or 9233)'], commands: BROWSER },
          {
            term: '--open-browser',
            about: [
              'Start a browser, if one isn\'t running on --cdp (which must be a port or on localhost target).',
              'Starts it headed (with a visible window), and leaves it open after sm-dev ends.',
              'Uses Google Chrome if installed, else Chromium.',
              'Used alone (sm-dev --open-browser), just start the browser.',
            ],
          },
          { term: '--profile DIR', about: ['With --open-browser: the browser profile, kept between launches.', '(Default: ~/.config/sm-dev/browser-profile-<port>)'] },
          { term: '--temp-browser', about: 'Instead, launch a hidden browser for each run, with an empty profile, and close it when the run ends.' },
          { term: '--headed', about: 'With --temp-browser: make its window visible.' },
        ],
      },
      {
        title: 'Server selection',
        options: [
          {
            term: '--run ID',
            about: [
              'A label to identify which sm-dev instance to use, or what to label a newly started run.',
              'Only needed when multiple are active.',
              'Default new names are D1, D2, etc.',
              'If only one run is active, it\'s chosen by default.',
            ],
          },
        ],
      },
      {
        title: 'Search paths',
        options: [
          { term: '--root DIR', about: ['The repo root, searched for local copies of @require URLs.', '(Default: the current directory)'] },
          { term: '--local DIR', about: 'Additional directory to search. Can repeat.' },
        ],
      },
    ],
  },
  {
    title: 'Common options',
    text: ['These apply for multiple commands.'],
    options: [
      {
        term: '--nowait',
        about: ['Don\'t wait for the page to settle after the action.', 'By default, most page actions wait for the page to settle before continuing.'],
        commands: SETTLING,
      },
    ],
  },
  {
    title: 'Specifying objects',
    text: ['Each object type has a unique keyspace. Some commands determine object type based on these rules.'],
    subsections: [
      {
        title: 'Scripts',
        items: [
          { term: '2', about: 'Script ID in the scripts list.' },
          { term: 'T2.3', about: 'Script 3, on tab T2.' },
          { term: '<name>', about: ['Its name, file name or path, or a unique substring.', '(Only in commands that expect script names.)'] },
          { term: '<file>', about: 'A script file. (Ending with .user.js)' },
          { term: '<url>', about: 'A script file loaded from a URL. (Ending with .user.js)' },
        ],
      },
      {
        title: 'Pages',
        items: [
          { term: '<url>', about: 'A URL. Protocol (e.g. http://) is optional.' },
          { term: '<file>', about: 'A file on disk, interpreted as a file:// URL.' },
        ],
      },
      {
        title: 'Tabs',
        items: [
          { term: 'T2', about: 'Tab ID in the tabs list.' },
          { term: 'targetId=<id>', about: ['Its CDP (Chrome DevTools Protocol) target id.', 'Or its first 6 or more characters. targetId= is optional.'] },
          { term: 'pageId=4', about: 'Its DevTools page id (with --devtools).' },
        ],
      },
      {
        title: 'HTML Elements',
        items: [
          { term: '<selector>', about: 'A CSS or Playwright selector.' },
          { term: 'e4, f2e6', about: 'Its ref in the latest snapshot. Also ref=e4 or [ref=e4].' },
        ],
      },
      {
        title: 'Menu items (for userscript menus)',
        items: [
          { term: 'M2', about: 'Its number in the tab\'s menu list.' },
          { term: 'T2.M2', about: 'Menu command M2, on tab T2.' },
          { term: '<label>', about: 'Its label.' },
        ],
      },
      {
        title: 'Runs (instances of sm-dev)',
        items: [
          { term: 'D2', about: 'Its number, as reported by start, status, list.' },
          { term: 'Dname', about: 'A user-chosen ID passed in with --run.' },
        ],
      },
    ],
  },
  {
    title: 'Files and file patterns',
    text: ['Commands that take filenames accept:'],
    items: [
      { term: '<filename>', about: 'A file name, optionally with a path.' },
      { term: '<directory>', about: 'Matches all .user.js files under it.' },
      {
        term: '<glob>',
        about: [
          'Matches files against a pattern, e.g. src/*.user.js.',
          '* matches any characters in one path part.',
          '** matches zero or more directories. It must be a whole directory part, and not the last.',
          'Fail if no files match.',
        ],
      },
    ],
  },
];

const INTRO = [
  'sm-dev: develop and test userscripts against a real browser,',
  'with SourceMonkey\'s script injection and GM_* APIs behind them.',
  '',
  'Usage: sm-dev [global options] <command> [options] [-- <command> ...]',
];

// Where every description starts, and where lines wrap.
const ABOUT_COLUMN = 20;
const WIDTH = 79;

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  // No last line of one word: the line above gives it one of its own.
  const last = lines.length - 1;
  if (last > 0 && !lines[last].includes(' ') && lines[last - 1].split(' ').length > 2) {
    const cut = lines[last - 1].lastIndexOf(' ');
    lines[last] = `${lines[last - 1].slice(cut + 1)} ${lines[last]}`;
    lines[last - 1] = lines[last - 1].slice(0, cut);
  }
  return lines;
}

// A description's lines, each of its own lines wrapped to `width`.
function aboutLines(about: string | string[], width: number): string[] {
  return (typeof about === 'string' ? [about] : about).flatMap((line) => wrap(line, width));
}

// A term and its description, the description at ABOUT_COLUMN; a term
// too long for that gets a line of its own.
function itemLines(term: string, about: string | string[], indent: number): string[] {
  const pad = ' '.repeat(ABOUT_COLUMN);
  const about_ = aboutLines(about, WIDTH - ABOUT_COLUMN).map((line) => pad + line);
  const lead = ' '.repeat(indent) + term;
  // At least two spaces before the text, or it reads as part of the term.
  if (lead.length + 2 > ABOUT_COLUMN) return [lead, ...about_];
  return [lead.padEnd(ABOUT_COLUMN) + (about_[0]?.trimStart() ?? ''), ...about_.slice(1)];
}

function paragraphLines(texts: string[], indent: number): string[] {
  const pad = ' '.repeat(indent);
  return texts.flatMap((text) => {
    if (text === '') return [''];
    if (text.startsWith('  ')) return [pad + text];
    return wrap(text, WIDTH - indent).map((line) => pad + line);
  });
}

function sectionLines(section: HelpSection, indent: number): string[] {
  const inner = indent + 2;
  const lines = [`${' '.repeat(indent)}${section.title}:`];
  lines.push(...paragraphLines(section.text ?? [], inner));
  // Under the section's text, if any, as options are below.
  const itemIndent = section.text ? inner + 2 : inner;
  for (const item of section.items ?? []) lines.push(...itemLines(item.term, item.about, itemIndent));
  for (const command of section.commands ?? []) {
    if (command.gap) lines.push('');
    lines.push(...itemLines(command.usage, command.about, inner));
    for (const item of [...command.args ?? [], ...command.options ?? []]) lines.push(...itemLines(item.term, item.about, inner + 2));
    for (const group of command.optionGroups ?? []) {
      lines.push(`${' '.repeat(inner)}${group.title}:`);
      for (const item of group.options) lines.push(...itemLines(item.term, item.about, inner + 2));
    }
  }
  if (section.options) {
    // Under a heading when the section has commands, which they follow;
    // otherwise under the section's text, if any.
    const titled = (section.commands ?? []).length > 0;
    if (titled) lines.push('', `${' '.repeat(inner)}${section.optionsTitle ?? 'Options'}:`);
    const at = titled || section.text ? inner + 2 : inner;
    for (const item of section.options) lines.push(...itemLines(item.term, item.about, at));
  }
  for (const sub of section.subsections ?? []) lines.push('', ...sectionLines(sub, inner));
  return lines;
}

/** The whole of `sm-dev --help`. */
export function fullHelp(): string {
  return [...INTRO, ...HELP_SECTIONS.flatMap((section) => ['', ...sectionLines(section, 0)])].join('\n') + '\n';
}

// Every section, subsections included, in the order the help lists them.
function allSections(sections = HELP_SECTIONS): HelpSection[] {
  return sections.flatMap((section) => [section, ...allSections(section.subsections ?? [])]);
}

const nameOf = (command: HelpCommand): string => command.usage.split(' ')[0];

// Each command's forms (wait has several), with the section listing them.
function formsOf(name: string): { command: HelpCommand; section: HelpSection }[] {
  const all = allSections().flatMap((section) => (section.commands ?? [])
    .filter((command) => nameOf(command) === name)
    .map((command) => ({ command, section })));
  // A pointer only when there is nothing else to show.
  const real = all.filter(({ command }) => !command.pointer);
  return real.length > 0 ? real : all;
}

/** Every command's name, in the list's order; one with several forms once. */
export const COMMAND_NAMES = [...new Set(allSections().flatMap((section) => (section.commands ?? []).map(nameOf)))];

/** The commands sm-dev runs itself, never sent to a run. */
export const CLIENT_COMMANDS = new Set(['start', 'attach', 'stop', 'list', 'exit', 'clear', 'help']);

/**
 * The commands sm-dev runs itself when given only files and URLs, and
 * sends to a run for its scripts and tabs. Both lists name them.
 */
export const SHARED_COMMANDS = new Set(['match', 'validate']);

/** The commands sm-dev can run itself: its own and the shared ones. */
export const OWN_COMMANDS = new Set([...CLIENT_COMMANDS, ...SHARED_COMMANDS]);

/** The commands a run takes. */
export const RUN_COMMAND_NAMES = COMMAND_NAMES.filter((name) => !CLIENT_COMMANDS.has(name));

/** The names a command also answers to, when run and in `help`. */
export const ALIASES: Record<string, string> = { '?': 'help', keys: 'key' };

/** A typed name as the command it is, aliases resolved; null for none. */
export function commandNamed(typed: string): string | null {
  const name = ALIASES[typed] ?? typed;
  return COMMAND_NAMES.includes(name) ? name : null;
}

// A command's options in titled groups: its own, then those of any
// section that lists some for it.
function optionGroupsOf(name: string): { title: string; options: HelpItem[] }[] {
  const forms = formsOf(name);
  const home = forms[0]?.section;
  const groups: { title: string; options: HelpItem[] }[] = [];
  const own = forms.flatMap(({ command }) => command.options ?? []);
  const shared = (section: HelpSection): HelpItem[] => (section.options ?? []).filter((item) => item.commands?.includes(name));
  if (home) own.push(...shared(home));
  if (own.length > 0) groups.push({ title: 'Options', options: own });
  for (const { command } of forms) groups.push(...command.optionGroups ?? []);
  for (const section of allSections()) {
    if (section === home) continue;
    const options = shared(section);
    if (options.length > 0) groups.push({ title: section.title, options });
  }
  return groups;
}

/**
 * The flags a command takes, for checking a sent command's words: the
 * first word of each option's term.
 */
export function commandFlags(name: string): string[] {
  return optionGroupsOf(name).flatMap((group) => group.options.map((item) => item.term.split(/[\s,]/)[0]));
}

// One command's help: its usage, what it does, its arguments and options.
function commandBlock(name: string): string[] {
  const forms = formsOf(name);
  const groups = optionGroupsOf(name);
  // Said once, for a command of one form; several list their options below.
  const options = groups.length > 0 && forms.length === 1 ? ' [options]' : '';
  const lines = forms.map(({ command }, i) => `${i === 0 ? 'Usage:' : '      '} sm-dev ${command.usage}${options}`);
  lines.push('');
  if (forms.length === 1) lines.push(...aboutLines(forms[0].command.about, WIDTH));
  else for (const { command } of forms) lines.push(...itemLines(command.usage, command.about, 2));
  const args = forms.flatMap(({ command }) => command.args ?? []);
  if (args.length > 0) lines.push('', 'Arguments:', ...args.flatMap((item) => itemLines(item.term, item.about, 2)));
  for (const group of groups) lines.push('', `${group.title}:`, ...group.options.flatMap((item) => itemLines(item.term, item.about, 2)));
  const text = [...forms[0].section.text ?? []];
  while (text.at(-1) === '') text.pop();
  if (text.length > 0) lines.push('', ...paragraphLines(text, 0));
  return lines;
}

/**
 * `sm-dev help <command>...`: each command once, in the list's order.
 * `unknown`: the names no command has.
 */
export function commandsHelp(names: string[]): { text: string; unknown: string[] } {
  const unknown = names.filter((name) => !commandNamed(name));
  const wanted = [...new Set(names.map(commandNamed).filter((name): name is string => name !== null))]
    .sort((a, b) => COMMAND_NAMES.indexOf(a) - COMMAND_NAMES.indexOf(b));
  return { text: wanted.map((name) => commandBlock(name).join('\n')).join('\n\n') + '\n', unknown };
}
