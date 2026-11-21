export const TOP_USAGE = "usage: ardia [-h] [--version] [--skill] <command> ...\n";
const DATA_DIR_OPTION = `  --data-dir DIR  the Ardia data dir (default: $ARDIA_DATA_DIR, else the
                  installed app's)`;

export const LIST_USAGE = "usage: ardia hooks list [-h] [--data-dir DIR] [--json]\n";
export const LIST_HELP = `${LIST_USAGE}
List the hooks in hooks.json, check them, and show whether the LaunchAgent is
loaded. Exit 1 if hooks.json is invalid.

options:
  -h, --help      show this help message and exit
${DATA_DIR_OPTION}
  --json          print JSON
`;

export const INSTALL_USAGE = "usage: ardia hooks install [-h] [--data-dir DIR]\n";
export const INSTALL_HELP = `${INSTALL_USAGE}
Write ~/Library/LaunchAgents/dev.ardia.hooks.plist, which runs the installed ardia's hooks run at login
and keeps it alive, and load it. Refused with --data-dir or $ARDIA_DATA_DIR.

options:
  -h, --help      show this help message and exit
${DATA_DIR_OPTION}
`;

export const UNINSTALL_USAGE = "usage: ardia hooks uninstall [-h] [--data-dir DIR]\n";
export const UNINSTALL_HELP = `${UNINSTALL_USAGE}
Unload and remove the dev.ardia.hooks LaunchAgent. Refused with --data-dir or
$ARDIA_DATA_DIR.

options:
  -h, --help      show this help message and exit
${DATA_DIR_OPTION}
`;

export const RUN_USAGE = "usage: ardia hooks run [-h] [--data-dir DIR] [--log PATH]\n";
export const RUN_HELP = `${RUN_USAGE}
Run every hook in hooks.json until interrupted, reloading the file when it
changes.

options:
  -h, --help      show this help message and exit
${DATA_DIR_OPTION}
  --log PATH      where output goes (default ~/Library/Logs/Ardia/hooks.log; -
                  for the terminal)
`;

export const ON_USAGE = "usage: ardia on [-h] [--data-dir DIR] [--match PATTERN] [--timeout S] [--idle DURATION] [--full-urls] EVENT[,EVENT...] -- PROGRAM [ARGS...]\n";
export const ON_HELP = `${ON_USAGE}
Run PROGRAM for each matching event, until interrupted. The event's JSON line is PROGRAM's stdin; its environment
has ARDIA_EVENT, ARDIA_WINDOW_ID, ARDIA_TAB_ID, ARDIA_PROFILE, ARDIA_URL and ARDIA_TITLE (set or removed for every
run; never a notification's text). PROGRAM runs directly, never through a shell unless PROGRAM is one; a leading ~
is expanded. URLs come without their query and fragment unless --full-urls. tab.idle, tab.resumed, user.idle and
user.active need --idle (like 30m, at least 1m).

--match takes userscript match patterns (https://*.example.com/*); any of them may match, and events without a URL
never match. One run at a time, at most 100 events waiting (the oldest are dropped, with a warning). A run is
stopped after --timeout seconds (default 60): SIGTERM, then SIGKILL 5 s later. When Ardia quits or control turns
off it reconnects with backoff.

Examples:
  ardia on tab.navigated --match 'https://*.youtube.com/*' -- ~/bin/yt-hook
  ardia on tab.opened,tab.closed -- /bin/sh -c 'echo "$ARDIA_EVENT $ARDIA_URL" >> ~/tabs.log'
  ardia on tab.idle --idle 30m -- ~/bin/park-tab

positional arguments:
  EVENT[,EVENT...]  event names, comma-separated

options:
  -h, --help        show this help message and exit
  --data-dir DIR    the Ardia data dir (default: $ARDIA_DATA_DIR, else the
                    installed app's)
  --match PATTERN   a match pattern for the event's URL; repeat for several
  --timeout S       stop a run after this many seconds (default 60)
  --idle DURATION   the threshold for tab.idle, tab.resumed, user.idle and
                    user.active, like 30m
  --full-urls       keep each URL's query and fragment
`;
