# The `ardia` command

`ardia` drives a running Ardia from the terminal. `ardia browse` is how an agent drives the browser: agent-browser's
commands on a small CDP client of its own (`ardia_cli/cdp.py` over the WebSocket client in `ardia_cli/wsclient.py`). The other commands run Ardia's own commands, stream its events,
run hooks and userscripts, edit its config and read its browsing data.

It lives here, in ardia-browser/plugins (`plugins/cli`), with its own version (`plugin.json`, which `ardia --version`
reports), tests, CI and releases (`cli-v<version>`, below). Ardia ships it as the **Command Line** plugin: each Ardia
release bundles the version pinned in ardia's `apps/browser/official-plugins.json`, signs it with the app, and offers it
in Settings › Plugins and onboarding as a one-click install; once installed it stays, and Ardia keeps `~/.local/bin/ardia`
linked to its copy (ardia's `docs/plugins.md` › programs). An `ardia` installed the old way is adopted on update. Linux,
which has no plugins yet, bundles the pinned linux-x64 tarball and installs it with `install.sh` (below). The app and
the command talk over the control socket, whose protocol is versioned both ways (How it finds Ardia).

While it drives a page, a pill floats over the bottom centre of the page ("Claude Code is controlling Ardia · Stop", or
"The ardia command is controlling Ardia" when it can't tell who runs it; Stop turns the setting off). It shows for a
DevTools connection (`browse`, `scripts test`) and for `ardia run`, which presses Ardia's own commands; reading and
organizing (`tabs`, `groups`, `apply`, `windows`, `commands`, `events`, `pinned`, `history`, `config`) never shows it. It overlays the page and never resizes it. It shows at the first connection and stays 3 s after
the last one closes, so a burst of commands shows one steady pill; turning the setting off hides it at once. One per
window: the focused pane of a split, the full screen page, or the Peek while one is open
(ardia's `apps/browser/src/components/window/CliControlPill.tsx`, `useCliIndicator` in `state/app/cliControl.ts`). Settings › Advanced ›
Command line › Show the control pill as an icon and Stop (`compactCliPill`) keeps only the caller's icon and Stop, the
line moving to its tooltip and accessibility label; nothing hides it.

The pill names who runs the command (`ardia_cli/caller.py`). The command walks its own process ancestry once (parent
pids through libproc's `proc_pidinfo`, each one's executable through `proc_pidpath` and its first two arguments
through `KERN_PROCARGS2`; well under a millisecond). A known agent anywhere up the chain wins: `claude` is Claude
Code, then Codex, Cursor Agent, Gemini CLI, OpenCode, Aider, Amp, Goose, Crush, Droid, Qwen Code, Copilot CLI, Kiro
and Cline, matched on the program's name, on `argv[0]` (Claude Code's binary is a version number) or on the script an
interpreter (`node`, `bun`, `deno`, `python`, `ruby`) runs. Otherwise it's the app that owns the chain: the first
ancestor inside an `.app` bundle, named by the outermost bundle's `CFBundleDisplayName`, else `CFBundleName`, else its
folder (so VS Code's helpers name VS Code), and that bundle's icon replaces the terminal glyph. Otherwise (a process
reparented to launchd, ssh) it's "ardia". The name and the bundle path travel as `{"name", "app"?}` in the control
socket's `hello` (`docs/automation.md`); a `browse` client puts them in its request and the daemon, which outlives
the client, tells the app over a short socket connection (`hello`, then `caller`) when it connects to Ardia and
whenever a request comes from someone else. `scripts test` does the same as it connects. The name is display only:
it never changes what a connection may do, and both ends strip control and invisible characters and keep 40
characters (the app keeps `app` only when it's an absolute, outermost `.app` path). When several run at once the pill
names the most recent one; a pill that hid and shows again without a new name says "The ardia command".

Code: `plugins/cli` (`ts`, `install.sh`, `build.sh`, `scripts/build.sh`; `ardia_cli` is the Python reference the parity harness compares against until the switch). It runs on macOS (Apple silicon) and Linux
(x86_64). Dependencies are pinned with hashes in `plugins/cli/requirements.lock` (regenerate with `uv pip compile
requirements.in --python-version 3.13 --python-platform aarch64-apple-darwin --generate-hashes --no-annotate
--no-header -o requirements.lock`); the Python tests use it until the switch, and nothing ships it. uv writes the hash of every file a
pinned version publishes, so the one lock covers both platforms: compiled with `--python-platform
x86_64-manylinux_2_28` it comes out byte for byte the same, and it carries the cp313 manylinux x86_64 wheels of the
native packages (aiohttp, pydantic-core, multidict, yarl, frozenlist, propcache, websockets). Check that again when
you bump a pin.

## Commands

- `ardia browse <command> [args]` takes agent-browser's commands, flags and output against the running Ardia (see
  The `ardia browse` command).
- `ardia pinned [--json] [--data-dir DIR]` lists the favorites and pinned tabs, and `ardia history [--days N]
  [--limit N] [--profile P] [--domains] [--json] [--data-dir DIR]` the recent history (see Browsing data). `--days`
  defaults to 1 and `--limit` to 200 (0 for no limit). A pin's `kind` is `favorite` for a Top Apps tile (`folder` is
  its tile folder) and `pinned` for a pinned row or a tab in a pinned folder (`folder` is the folder). They read
  `session.json` from version 2 on, the tab's `pin` field or the older `pinned` flag. Exit 0 done, 1 the data
  couldn't be read or ran out of time, 2 Ardia can't be reached.
- `ardia notes [get|set|append|list|rm] [SITE] [TEXT|-]` keeps plain-text notes per site for the user's own agent
  (see Site notes). It hands its arguments to `ardia_cli/notes.py` (`main(argv)`), which runs them as
  `ardia browse notes …`, with the shared options given before `notes` put first.
- `ardia skills install --target general|codex|claude-code|cursor|opencode [--target …] [--project]` installs the
  agent skill (`ardia_cli/skill`: a `SKILL.md` of about 5K characters with the fast paths (read, batch, select,
  script, notes), plus `references/troubleshooting.md`, `script.md`, `flows.md`, `userscripts.md`, `config.md`,
  `automation.md` and `daily-reports.md` read only when a task needs them) into `~/.agents/skills` (general, codex),
  `~/.claude/skills`, `~/.cursor/skills` or `~/.config/opencode/skills`; with `--project`, into `./.agents/skills`,
  `./.claude/skills`, `./.cursor/skills` or `./.opencode/skills`. It writes each file it ships in place (temp file,
  then rename, so a linked file is replaced, never written through) plus a `.ardia-skill` marker (vendor, version and
  the files it wrote), removes only files an earlier marker listed that it no longer ships, and leaves every other
  file alone. A folder counts as ours only when it isn't a link and its marker is a plain file naming vendor
  `ardia`. `install` also adopts a copy from before the marker, but only when its files, none of them links, have
  exactly the paths and SHA-256 of a version we shipped (`ardia_cli/skill_hashes.json`, frozen data: it was
  written from ardia's history up to the commit it names, which no history holds any more). Anything else, a foreign skill named ardia
  included, is refused with the folder's path; `--replace` removes that one folder (a link itself, never its target)
  and installs fresh. Each folder it wrote goes into `$ARDIA_CLI_HOME/skills.json`. `ardia skills refresh` never
  adopts: it rewrites every marked folder in that list and every marked user-level folder above, prints
  `skipped <folder>` for the rest, refuses a linked subfolder, and keeps only our folders in the list. `install.sh` runs it after
  each upgrade, so installed copies follow the CLI. Both also install cua-driver's skill next to ours (see Computer
  use); `--no-cua` skips it.
- `ardia skills get [--full]` (and `ardia --skill [--full]`, the same command) prints the skill that ships inside
  this CLI to stdout, byte for byte, so an agent reads the version that matches the command it is about to run:
  `SKILL.md` alone, or with `--full` followed by every file under `references/`, each after a `--- references/<name> ---`
  line. `ardia skills list` prints each shipped skill's name and description (the front matter), tab-separated.
  Neither needs Ardia, writes a file or prints to stderr, and both exit 0 (141, quietly, when the reader closes the
  pipe). `ardia --help` tells an agent to run `ardia --skill` unless an ardia skill is already in its context.
- `ardia computer <cua-driver command> [args]`, `ardia computer setup [--no-grant]` and
  `ardia computer mcp-config [--target …]` operate native Mac apps through the pinned cua-driver (see Computer use).
- `ardia scripts new|test|install|uninstall|list` writes, tests and installs userscripts (see Userscripts).
- `ardia config path|init|get|set|unset|list|edit|check` reads, writes and checks `config.json` (see
  `docs/config.md`, The ardia command). Never needs Ardia running.
- `ardia theme new|use|list|check|get|set|unset` makes, picks, edits and checks themes: colours, type, metrics,
  layout and icons. `ardia theme set KEY VALUE` changes one key of the active theme (`dark.accent`,
  `metrics.radius.row`, `icons.chevron.down`) and a running Ardia restyles at once (see `docs/config.md`, Themes).
- `ardia run COMMAND [ARG]` runs one of Ardia's commands over `<data dir>/ArdiaControl.sock` (see
  `docs/automation.md`).
- `ardia commands` lists the commands `run` takes (see `docs/automation.md`).
- `ardia windows` lists the windows and their tabs (see `docs/automation.md`). With `--json` each tab also has
  `targetId`, the DevTools page target `ardia browse` attaches to (null when the tab's page isn't loaded), and
  `pageGeneration`, bumped whenever that target changes (a slept tab reloading). The app asks each live tab through
  ArdiaCore's `devToolsCall` (`Target.getTargetInfo`, engine call `engine.cliTabTargets`); an older build leaves both
  out. A tab a page opened whose first page is still loading isn't asked and has a null `targetId` until that page
  commits: the DevTools attach counts as a touch of its blank initial document, after which Chrome and the tab show
  about:blank instead of the pending address (`awaitsFirstDocument`; `packages/ardiacore/scripts/pending-address-check.mjs
  <Debug app>` checks it).
- `ardia tabs --usage` lists each tab with its renderer's process id, CPU and memory, hottest first, and
  `ardia tabs --pid N` names the tabs in a process, so a pid from `top -o power` leads to its tab (`workspace`'s
  `usage`, `docs/automation.md` › Tabs and groups). Use counts come from the option names on the command event;
  `error_code` `no_pid` means an engine that reports no process ids.
- `ardia tabs`, `ardia groups` and `ardia apply` list and organize tabs and groups by id: open URLs into a window,
  profile, group or spot, move tabs between groups, windows and profiles without reloading, pin, mute, sleep, wake,
  close, rename and set icons; create, nest, reorder, pin, collapse, recolour, ungroup, close and delete groups; and
  apply a JSON batch of those in one call (`ardia_cli/workspace_cli.py`; protocol, operations and rules in
  `docs/automation.md` › Tabs and groups). Groups can be named by id or by name (`--group Work`, `ardia groups update
  Work …`); output names them next to their ids (`created group 💼 Work (g-…) with 4 tabs`, `moved Inbox (tab-…)`).
  `--json` prints the app's reply. Exit 0 done, 1 refused, a bad request
  or a batch stopped at a failing operation, 2 Ardia can't be reached or the connection dropped after sending. Human
  output shows control characters in page text, titles and names as `\u00NN` (`ardia_cli/printable.py`), so a page
  title can't drive the terminal (an OSC 52 clipboard write, say): see Terminal output.
- `ardia call METHOD [--params JSON|-] [-p key=value]… [-p key:=json]… [--timeout S] [--json] [--data-dir DIR]` sends
  any method to `<data dir>/ArdiaControl.sock` (`hello` first, as every control command does) and prints the result:
  JSON with `--json`, otherwise a readable `key: value` / `- item` outline with control characters escaped, or
  `✓ METHOD` for a null result. `--params` is a JSON object (`-` reads it from stdin, up to 1 MB in bytes); `-p key=value`
  sets a string and `-p key:=json` any JSON value, and `-p` wins over `--params` for the same key. Params are checked
  before connecting and must be clean JSON: UTF-8, no lone surrogates (an escaped `\ud800` too), no `NaN` or
  `Infinity`, no number a double can't hold (`1e400`), no key twice, at most 64 levels deep, and not empty. Empty
  input is refused rather than read as `{}`: an empty pipe usually means the command feeding it failed, and running a
  method with no params then could change something nobody asked for; send `{}` for no params. The whole request line
  must fit the socket's 1 MB (`MAX_LINE`, bytes). Any of these exits 2, like other usage errors, with nothing sent. `--timeout` is seconds
  above 0 and up to 600 (default 30), checked before connecting; an unknown method's nearest-name lookup (`methods`)
  runs only inside what is left of it, and not at all when the unknown method is `methods` itself. A refusal prints
  `ardia call: <Ardia's message>` and exits 1; an unknown method adds the closest name from `methods`, or, on an Ardia
  without `methods`, says to update Ardia. Exit 2 when Ardia can't be reached, or when the connection dropped after
  the request went out, or Ardia's answer had neither a `result` nor an `error` (in both the method may or may not
  have run). An explicit `"result": null` is a result. Other control commands (`run`, `windows`, `commands`) still
  take an answer without either as an empty result. `ardia_cli/call_cli.py`; the protocol number is unchanged.
- `ardia methods [NAME] [--json]` lists what the running Ardia offers over the control socket, from its `methods`
  method: one line per method with `reads` or `changes` and its description; with NAME, that method's description,
  params schema and result. It takes the catalog as a list of `{name, area, description, params, result, mutates}` (the
  app's shape), a `{methods: …}` object whose `methods` is such a list or an object of descriptors, or an object keyed
  by name, which may list `methods` itself: an object is taken as a wrapper only when its `methods` value isn't a
  descriptor (`description`, `mutates`, `params`, `result`, `area`) and no other key holds one. An Ardia without `methods` (`unknown_method`) gets
  `this Ardia is too old to list its methods …: update Ardia` and exit 1. Agents discover with `ardia methods` and act
  with `ardia call`.
- `ardia events [EVENT…]` streams browser events (see `docs/automation.md`).
- `ardia on EVENT[,EVENT…] -- PROGRAM` runs a program for each event (see `docs/automation.md`). PROGRAM's output goes
  to the terminal untouched; event data such as `ARDIA_TITLE` and `ARDIA_URL` comes from pages, so a program that
  prints it should escape control characters, as the CLI's own output does.
- `ardia hooks run|install|uninstall|list` runs the hooks in `hooks.json`, at login through a LaunchAgent on macOS
  or a systemd user service on Linux (see Linux below and `docs/automation.md`).
- `ardia plugins list|install|check|remove|enable|disable|call|path` installs and manages plugins in the config
  folder's `plugins/`; `enable`, `disable` and `call` need Ardia running with control on, and `enable` only opens the
  consent sheet in Ardia (see `docs/plugins.md`).
- `ardia feedback --title TITLE [--kind bug|slow|idea|other] [--attach FILE]… [--command CMD] [--data-dir DIR] TEXT|-`
  reports a problem or an idea to the developer (see Feedback and the star nudge). Exit 0 sent (or the same report
  already went out today), 1 not sent and kept on the Mac (the line says why), 2 a missing or bad title, description
  or attachment.
- `ardia star [--data-dir DIR]` stars github.com/mantrakp04/ardia for the user, run only after they said yes (see
  Feedback and the star nudge). Exit 0 starred or the page opened, 1 neither worked.
- `ardia --version`, `ardia --help`, `ardia browse --help`, `ardia scripts <command> --help`,
  `ardia config <command> --help`, `ardia theme <command> --help`, `ardia hooks <command> --help` and `--help` on
  each of `pinned`, `history`, `run`, `commands`, `windows`, `call`, `methods`, `events`, `on`, `apply`, and `tabs` and `groups` and
  their commands. `ardia browse <command> --help` (or `ardia browse help <command>`) prints that command's entry; a
  command without one prints its line from the overview and `flags: none`, never the whole overview.

`ardia exec` is gone: `ardia browse` is the one way to drive the browser. `ardia exec …` (and any other unknown
command) prints `ardia: unknown command '…'` with where to go instead, and exits 2. What `exec` offered maps to
`ardia browse` for pages, `ardia pinned` and `ardia history` for `pinned()` and `history()`, and `ardia run`,
`ardia windows` and `ardia events` for `run()`, `windows()` and `events()`.

### Terminal output

Page text, titles, notes, names and other text from pages or files reach the terminal only with their control
characters (C0, C1 and DEL) shown as `\u00NN`, so a page can't write escape sequences (an OSC 52 clipboard write, a
screen clear) through the CLI. Two places do it, so new commands get it without asking: `ardia browse` and
`ardia notes` text output in `render` (`browse/daemon.py`), keeping line breaks and tabs, so snapshots, page text and
notes read as before; and `cli.main` wraps stdout and stderr for every other command (`printable.inert_output`), with
single-line fields (titles in `tabs`, `windows`, `events`, `pinned`, `history`) escaping line breaks too. Other text
(accents, CJK, Arabic, emoji) is untouched. JSON output (`--json`, and `AGENT_BROWSER_JSON` for browse) keeps
C0 controls as `json.dumps` writes them and escapes only U+007F–U+009F (raw there because of `ensure_ascii=False`) as
`\u00NN` (`printable.json_safe`, in browse's JSON render and in the JSON-mode stdout writer), so it decodes to the
same values and non-ASCII text stays readable; stderr is always guarded. The `\u00NN` form keeps text that is itself
JSON (a script's result) valid JSON.

### Shared options

`--port N`, `--ws URL` and `--data-dir DIR`, plus `--timeout S` and `--json` where a command has them, go before the
command or after it: `ardia --port 9222 browse snapshot` and `ardia browse --port 9222 snapshot` are the same, and so
are `ardia --json windows`, `ardia windows --json` and `ardia hooks --data-dir DIR list`. `cli.py` moves the ones in
front of (or between) the command words to just after them, so a flag written after the command wins over the same
flag before it; arguments after `on`'s `--` are never touched. A command that doesn't take a flag given before it
says so and exits 2 (`ardia: windows doesn't take --port`). For `browse` the flags go to the front of browse's own
arguments, where its parser reads them; `browse` takes `--port`, `--ws`, `--data-dir` and `--json`, not `--timeout`.

Each has an environment variable, and a flag wins over it: `ARDIA_PORT`, `ARDIA_WS`, `ARDIA_DATA_DIR`. The
endpoint comes from `--ws`, else `--port`, else `$ARDIA_WS`, else `$ARDIA_PORT`, else `$ARDIA_CDP_URL`, else
`<data dir>/Chromium/ArdiaControl.json` (see How it finds Ardia). For `browse`, `ARDIA_WS` or `ARDIA_PORT` is
passed as `--ws`/`--port` only when its arguments have none of `--ws`, `--port` and `--cdp` (a `--port` after
`stream` is the stream's own), so the session is keyed on the endpoint it really uses. A bad `ARDIA_PORT` exits 2.

The CLI never quits Ardia: every DevTools WebSocket it opens (`browse`, `scripts test`; `ardia_cli/guard.py`) checks
each outgoing message and refuses fragmented sends, so `Browser.close`, `Browser.crash` and `Browser.crashGpuProcess`
never leave the process, whether sent one at a time, in an `execute_commands` batch (checked whole before anything is
sent) or straight on the socket. Its WebSockets always connect directly, ignoring `http_proxy`, `ws_proxy` and the
like, so no proxy sees the token.

## The `ardia browse` command

`ardia browse` gives agent-browser's command line (0.35: commands, flags, `@eN` refs, text output with `✓`/`✗`, and
`--json` as `{"success","data","error"}`) on top of the running Ardia, so an agent that knows `agent-browser <args>`
types `ardia browse <args>`. None of agent-browser's code is used. Code: `ardia_cli/browse/` (`cli.py` parses the
globals and runs the commands that need no browser, `daemon.py` owns the connection, `commands.py`, `actions.py`,
`snapshot.py`, `changes.py`, `fields.py`, `capture.py`, `media.py`, `audit.py`, `react.py`, `vault.py`, `plugins.py`,
`readurl.py`; site notes in `ardia_cli/notes.py`).

An agent's loop is short: `snapshot -i` once, then actions, each of which prints what it changed, so it rarely needs
another snapshot; repetitive work goes in one `batch` on stdin. Input is instant unless `--humanize`, a session works
in background tabs of its own until it picks the user's with `tab active`, and text output stops at about 12,000 characters.

### Process model

Each session has a background daemon that owns the CDP connection, the refs, the tabs it opened and the tracked
mouse position, so a humanized path starts where the last one ended. `ardia browse` talks to it over a Unix socket.

- Everything lives in `<data dir>/Browse/` (`--data-dir`, else `$ARDIA_DATA_DIR`, else the installed app's, with
  `--port` and `--ws` too). The folder is created 0700 and must be a real folder the
  user owns (`O_NOFOLLOW`, checked by `fstat`); every file in it is opened relative to it.
- A session's files are named by `sha256(namespace, endpoint, session)`, never by the session name, which must match
  `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`: `<key>.lock`, `<key>.sock`, `<key>.json` (session name, pid) and `<key>.log`
  (the daemon's redacted stderr). The socket is bound and connected by a relative name after `fchdir` into the
  folder, so a long data dir never hits the 104-byte `sun_path` limit.
- The daemon holds an exclusive `flock` on `<key>.lock` for its whole life. Only with that lock held does it treat
  an existing `<key>.sock` as stale and unlink it; it binds with umask 0177 so the socket is 0600 from the start,
  records the socket's inode, and at exit unlinks it only if it's still that inode. Both ends check the other's
  uid with `LOCAL_PEERCRED`; the client also checks the socket is a socket, owned and 0600.
- Files are created with `openat(dir_fd, …, O_CREAT)`, retried up to four more times on `ENOENT`
  (`paths.open_at`): on macOS, when several processes create the same new file through a directory descriptor at
  once, all but one get `ENOENT` on the first try (racing eight processes for one new lock, seven failed in nearly
  every round; the second try always succeeded). A path that really is missing still fails after the retries.
  `tests/test_browse.py` races eight processes for one new lock and expects exactly one holder.
- The client starts the daemon (`python -I -c`, its config on stdin, never argv or env) when the socket doesn't
  answer, and waits up to 15 s. A request is one JSON line; the daemon serializes commands, so one gesture never
  interleaves with another, and cancels a command whose client went away (Ctrl-C). Every command has a limit (120 s;
  `batch`, `read` and `record` 600 s; `script` its `--timeout` plus 30 s; `wait` its own timeout plus 30 s), after which
  it's stopped with `command_timeout` (outcome unknown for one that changes something) and the session is free again;
  a command queued behind another gives up after 30 s with `session_busy`, naming what's running and pointing at
  `--session <name>` for independent work. A `read` of named URLs (or URLs on stdin) doesn't queue: it uses its own
  background tabs, so when the session is busy it runs at once in a sibling session `<session>-side`. Coding agents
  ran a long `script` and a `read` in parallel and lost the read after 30 s.
- **Idle disconnect.** After 30 s with no admitted or queued command, no held key or button and no capture lease
  (console or errors, network log, HAR, route, trace, record, stream, init scripts, emulation; an action's own network
  watch, see Changes after actions, ends with the action and never counts), the daemon drops the
  CDP connection so the control pill goes away, but keeps its state. The next command reconnects: it re-reads and
  re-checks `ArdiaControl.json` (or `/json/version`) and refuses, ending the session, if the browser instance
  (`pid:generation:browser path`, or the browser WebSocket path) changed. Admission and the idle check run on one
  event loop under the command lock, so a disconnect never races a command.
- **Connection loss is terminal.** When Ardia closes the connection itself (Stop, control turned off, Ardia quit),
  the session ends: queued commands fail, nothing reconnects and nothing is replayed. `cdp.Connection` opens once
  and never reconnects, with a 256 MB `max_size`; a message over it closes the connection (1009). A link found dead when a command
  starts is treated the same way, before any endpoint is resolved again; only the daemon's own idle disconnect
  reconnects. A command that may already have been dispatched is never retried; it reports that its outcome is
  unknown (exit 2 on connection loss, 1 otherwise). That covers a timeout on any method that changes something
  (`Page.navigate`, `Page.reload`, `Target.createTarget`/`closeTarget`/`activateTarget`, `Input.*`, `Emulation.*`,
  cookie, Fetch and download methods, `eval`, and every isolated-world call that isn't marked as a read), a daemon
  that goes away after taking a mutating command, and batch: after an unknown outcome the rest of the batch isn't
  run and is reported as `not_run`. Isolated-world reads are retried once when the document changes under them;
  writes (`history.go`, `storage set`, `select`, `pushstate`, scripted scrolls) fail with `document_changed` and are
  never replayed on the new document.
- **A detached tab.** Ardia can detach a tab from the connection while a command uses it: the tab closed, crashed,
  went to sleep (Memory Saver, `ardia tabs sleep`) or moved to a window Ardia keeps for itself. The page then has no
  CDP session, and a command sent without one goes to the browser target, which answered `'Page.getFrameTree' wasn't
  found` (a multi-page `read` printed that for each page whose reading tab went away). `Page.send` now refuses to send
  without a session (`code: "tab_detached"`), `Page.detach` fails the calls still waiting for an answer at once (a
  mutating one as an unknown outcome) instead of leaving them to their timeout (a `Page.navigate` waited its 30 s). A
  multi-page `read` reads that page again in a new tab, once (`READER_TRIES`; telemetry `read_tabs_reopened`); a second
  detach fails that page only. When the tab is still open, `open`, the load wait and an action's change report attach
  to it again (`State.reattach`) and put back what the session set on it: init scripts, the `set` overrides (viewport,
  device, geolocation, media, offline, headers) and request interception for routes and credentials (`set credentials` answers only the tab's own page's server
  challenge, and only from the first origin that asks; a frame, a subresource, a proxy or any other origin gets the
  browser's default). What can't be put
  back is dropped from the session's bookkeeping and the command fails with `code: "setup_lost"`, naming it. The CLI
  never detaches a tab itself: a `Network.disable` the page doesn't confirm in 2 s (Chromium waits on the page's main
  thread and on a pending navigation) leaves the session as it is, and a change report counts only requests that began
  after its own `Network.enable` returned, so a late event from an earlier capture isn't reported as this action's
  write. In the TypeScript CLI (the port of plugins#5), `open` and a multi-page `read` attach again right before
  `Page.navigate` and send it once: when Ardia had already ended the session (the navigation answers that the session
  is gone, so it never ran), it's sent once on the new session; when the session ends while `Page.navigate` is in
  flight, the outcome is settled by whether the tab's main-frame loader changed, never by sending it again.
  `State.reattach` tries up to 3 times when the new session is itself ended while it's set up, console and network
  capture count as on only once the new session confirms them, the settle probe attaches again instead of failing a
  page that loaded, and a tab that's really gone fails as `tab_detached` naming the URL the command was opening (left
  out for `about:` pages). Actions (`click`, `fill`, …) are never retried: one cut off mid-way stays an unknown
  outcome. Watch `error_code` `tab_detached` on `open` and `read` (84 in 13 days before, 63 of them on `open`) and
  `reattached_after_detach`, which should take its place.
  `Inspector.detached` ("Render process gone.") is only an event, sent when the tab's renderer exits normally:
  the session stays attached, and Chromium sends its calls on to the next renderer, so the CLI keeps it.
- **A crashed tab.** A renderer that dies leaves the CDP session attached but answers nothing, so `Page.enable` on
  attach waited its 30 s and every command after it too, `reload` included. `Inspector.targetCrashed` now marks the
  page crashed instead of detaching it, and attach asks `Inspector.enable` first (on the token policy's list; Chrome
  answers it from the browser and reports a dead renderer at once), so a session that attaches later knows too. A
  crashed page refuses every method but `Page.reload` and `Page.navigate` at once (`code: "tab_crashed"`, which says
  to reload or close it), and fails the calls still waiting. `reload` on it sends `Page.reload`, enables the page
  again and waits for `document.readyState` to be `complete` (about a second); `open <url>` on it navigates first the
  same way; `close`, `tab close`, `--show` and `set viewport reset` need no answer from the page. A main-frame
  navigation or `Inspector.targetReloadedAfterCrash` (someone else reloaded it) clears the mark. A session that
  attached to an already crashed tab skipped `Page.enable` (it would never answer), so the page is enabled before
  the next command once the mark is gone (`needs_enable`).
- `close` takes the command lock, marks the session closing, and only then closes its tabs; requests already queued
  or arriving later get `session_closing`. On any stop the daemon lets running handlers settle (up to 5 s, then
  cancels them) before it touches the browser. Every answer is sanitized (registered tokens and any `token=` query
  are masked in each JSON field and in the text) before it's written, and the daemon refuses to send an answer over
  256 MB.
- While disconnected the daemon watches `ArdiaControl.json` every 2 s and exits when it disappears or names another
  instance. It also exits after `--idle-timeout`/`AGENT_BROWSER_IDLE_TIMEOUT_MS` (default 1 h) without commands, and
  on `close`. It takes a lease on its CLI version like `ardia` does.
- Sessions (`--session`, `AGENT_BROWSER_SESSION`, default `default`; `--namespace`) are command-state namespaces on
  the same Ardia, not isolated browsers: cookies, storage and logins are the user's in all of them. A capture or
  route claims its tab in `Browse/claims/` (checked against the owner's lock), and a second live session is refused
  on a tab another one owns. The claim is taken before the CDP domain is enabled (console and errors, including
  `open --capture-console`, network, HAR, route and credentials, trace, record, stream), dropped if enabling fails,
  and released by the matching stop (`har stop`, `unroute` of the last route, `trace`/`profiler stop`,
  `record stop`, `stream disable`) or when the session ends.
- **Tab registry.** Sessions share `Browse/tabs-<sha256(instance)>.json` (version 2, under `tabs.lock`; `tabs.py`), so
  a `tN` id is the same in every session and never moves to another tab. It records which session opened each tab
  (`opened`), which tab each live session uses (`using`), tabs a reader or script opened only to read
  (`note_temporary`: hidden from `tab list`, adoptable by no one, kept after the daemon dies so `temptabs.sweep`
  closes them after the next connect or at `close`; `note_intent` marks a tab about to be created, so a daemon that
  dies mid-create leaves a marker `claim_orphans` hands to the next one), and close reservations: `reserve_close`
  refuses a tab another live session uses or is closing, `finish_close` (or `release_close`, which keeps the
  temporary record) ends it, and adopting a reserved tab fails with `tab_closing`. Ids carry when they were last seen;
  a target list deletes only ids older than it. Dead sessions' entries are pruned on every write, every write stays
  under 1 MiB (dead intents, then dead sessions' temporaries oldest first, then unreferenced ids), and a file it
  can't read (over 8 MiB, or damaged) starts over.

### Refs

Refs keep agent-browser's `@eN` form with stable numbers: a node (same browser instance, target, frame, document
and backend node id) keeps its number across snapshots and `find`, so repeat snapshots of an unchanged page give
identical refs. A node seen for the first time takes the next unused number, and a number never moves to another
node, so a delayed `click @e1` can't land on a different element, short of the strict redraw follow below; once its
node or document is gone it fails as stale. Numbers keep rising across documents (a new page's nodes are new
nodes), and refs of documents a tab has left are forgotten. Each ref keeps the browser instance, target id, frame id,
the frame's loader id, the snapshot generation and the backend DOM node id (with role and name for display). A ref
resolves only within that lifetime: the instance must match, the frame must still have the same loader
(`Page.getFrameTree`), and `DOM.resolveNode` must find the node, connected, in the isolated world. Anything else is
`Stale ref @eN: <why>. Run snapshot again` (`code: "stale_ref"`). Refs survive the idle disconnect (backend node ids
outlive CDP sessions). `find` gives its element the next ref. When a ref's node is gone but its document isn't, a fresh
collection looks for the same role and name. The ref follows that node, with a `→ @eN was redrawn…` notice on stderr
and `followed_redrawn_ref` in telemetry, only when all of this holds: the old ref was the only node with that role
and name in the last whole-page collection that saw it (a scoped `snapshot -s` keeps what the ref had); the new node
is the only one now; both sit in the same frame; and both have the same chain of named ancestors (`walk_in_context`
in `snapshot.py`: dialog, row, form, region names, the page title left out). So a row's "Delete" that had siblings,
or a dialog reopened for another item, never resolves to the wrong element. Otherwise the error names the new ref.

Selectors are CSS, `@eN`, `xpath=…` (or `//…`), `text=Save` (substring, case-insensitive; `text="Save"` exact),
`role=button[name="Save"]`, and `:has-text("…")` (`:text("…")` too) or `:text-is("…")` (whole text, exact) anywhere
in a CSS selector (`[role=row]:has-text("FAS-1") td`). `A >> B` finds B inside each A, and `>> nth=N` keeps the Nth
match from 0 (`-1` the last): `main >> text=Save`, `[role=option] >> nth=3`.
`[role=main]` also matches `<main>`, and so on for the other implicit roles (`nav`, `dialog`, `tr`, `a[href]`, `h1`–`h6`,
`select`, text inputs, `input[type=search]` as `searchbox`, `option`, `progress`, …); a bare role word such as `grid`
that matches no element is tried as that role. A selector that matches several elements takes the first visible one.
`find` waits up to 1.5 s for its element to appear. `find label`, `text`, `placeholder`, `alt` and `title` take an exact
match first (case and spacing aside, a trailing `*` or `:` too), then a whole-word one, then any substring.

### Input

Input is instant by default: clicks dispatch straight at the target point, `fill` focuses the field with `DOM.focus`,
selects all, presses Backspace and puts the text in (one `Input.insertText` for a plain field, see below), and scrolls
are single wheel events. `--humanize` (or `AGENT_BROWSER_HUMANIZE=1` for the session) turns on the humanized
classes in `browse/human.py`, ported from pydoll 3.0 (MIT): `Mouse` (`click`, `dblclick`, `hover`, `drag`, `mouse move`; Bézier paths with Fitts timing, overshoot and
tremor, press and hold timing), `Scroll` (`scroll`, `scrollintoview`, and scrolling a target into view before a
click), and `Keyboard` (`type`, `fill` (click in, select all, Backspace, then type), `keyboard type`, `press`), with
pydoll's default timing. Typos are left out: the port has no typo code, and `tests/test_browse.py` checks humanized
typing types exactly the text.
`keyboard inserttext` stays an instant `Input.insertText`. `--no-humanize` and `AGENT_BROWSER_NO_HUMANIZE=1` are
still accepted; they force it off, so `AGENT_BROWSER_HUMANIZE=1 AGENT_BROWSER_NO_HUMANIZE=1` is off and a
`--humanize` flag beats both.
`fill` and `type` follow a field the page swaps out when it's focused (Wikipedia's Vector 2022 search box mounts a new
input on first focus): if the target is detached after the focusing click or `DOM.focus`, and focus sits on an
editable field in the same frame and document that matches it (same tag and type, and a shared id, name, placeholder,
aria-label or title), they type there and report `retargeted: true` (the text output says so too). Anything else
fails with `element_replaced` and types nothing. `auth login` never follows a replacement. Click points get a small
random offset inside the box. A selector (not a ref) that matches nothing yet is polled every 0.15 s for up to 3 s
before `not_found` ("waited 3 s for it to appear") on every command that acts on or reads one element (`is` checks
presence, so it doesn't wait): agents on hydrating pages, and scripts written Playwright-style, failed on elements
that showed up a moment later. A click whose point is covered first tries two fixes, each once: when the cover is a
cookie or consent layer (the cover's nearest fixed, sticky, dialog or CMP-vendor ancestor, or a CMP layer behind a fixed
backdrop over half the viewport, whose text names cookies or consent and is under 3,000 characters, or 20,000 for a layer named after a consent
platform such as OneTrust, consentmanager, Cookiebot, iubenda, Termly, Klaro, Complianz or CookieYes, whose banners and
preference centers run long), it clicks that
layer's reject button ("Reject all", "Necessary only"…), else accept ("Accept all", "I agree", "OK"…), else
close, never a bare "Continue" or "Decline" on some other dialog, says so in the output
(`A consent banner was in the way: … "Reject all" button was clicked (reject)`) and retries; otherwise it scrolls
the element to the middle of the viewport (a sticky header over it) and retries. A left click on an element that still sits outside the page after that
(a carousel slide translated to x = -2700) gets a DOM `click()` instead, and the output says so, but only when it is
visible to CSS, at least 4×4, not clipped (sr-only), and inside a container that clips overflow; a honeypot at
left:-9999px still fails (`dom_click_fallback`): one BU Bench agent hit `outside_viewport` 20 times on carousel cards.
While a modal dialog is open, that DOM click only goes to an element inside the open dialog on top; anything else
fails with `outside_viewport`, naming the dialog and saying to close it first (`dom_click_behind_modal`). A dialog
still fading out is given up to 0.5 s to go, so `click <close>` or `press Escape` straight before the click works
(`dom_click_waited_for_modal` when that wait ends in the click). A dialog counts as open when a click at it would
land in it: the page is hit-tested at points on the dialog and on up to 200 of its elements (40 hit tests at most),
so one closed by clipping, collapsing, sliding off screen, `inert` or `pointer-events: none` doesn't count, nor does
one faded to `opacity: 0` or `filter: opacity(0)`, and one whose only visible part comes after its first 200
elements isn't seen. An open dialog hit at a point inside
another one's box is above it. Of open dialogs that don't overlap, the one holding focus takes the click, or any of
them when none does, and the error names the focused one or the last in the document. Only a
`<dialog>` opened with `showModal()` and an element marked `aria-modal="true"` are recognised. These aren't, so the
click goes through them as before: `role="dialog"` or `role="alertdialog"` without `aria-modal` (Radix, MUI 5, React
Aria Components), a modal in a parent frame, a modal in a child iframe over a target in the parent, and a modal
element inside a shadow root (a shadow host can itself be the modal). A menu portaled out of the dialog counts as outside it. If the element is still covered it fails with
`covered by <tag#id.class>`, and one outside the laid-out viewport with `outside_viewport` (the point and the viewport
size). A tab with no size yet (0×0, seen on a loaded hidden test instance) is waited for up to 2 s, then given a
1280×800 device metrics override for that command, cleared afterwards and never over the session's own `set viewport`;
where the policy refuses it (the token path: the tab isn't off-screen) it fails with `no_viewport`.

`fill` on a `date`, `time`, `datetime-local`, `month`, `week`, `color` or `range` input doesn't type (typing
`2026-11-09` into the segmented date field stored `0009-02-06`, and a time field stayed empty). As Playwright's
`fill` does, it checks the value, focuses the field (`DOM.focus`), sets `value` in the isolated world, reads it back,
and only then dispatches `input` (bubbling, composed) and `change` (bubbling). Formats (`fields.py`): `YYYY-MM-DD`
(a real date), `HH:MM[:SS[.mmm]]` in 24-hour time or with AM/PM (`2:30 PM` becomes `14:30`), the two joined by `T`
or a space for `datetime-local`, `YYYY-MM`, `YYYY-Www`, `#rrggbb` or `#rgb`, and a number for `range`; an empty value
clears the field. A value in another format fails before anything is touched (`code: "bad_value"`, naming the
format), and so does one the input refuses (it's put back the way it was). The answer carries what the field holds
(`data.value`; the text says so when it differs from what was given, such as `#3b82f6` for `#3B82F6` or a range
snapped to its step). It needs no visible tab and sends no key events. A textarea, a contenteditable field and a
`text`, `search`, `email`, `url`, `tel` or `number` input get the whole text in one `Input.insertText` (confirmed by
its `beforeinput`/`input`; per-key typing took 1.8 s for 400 characters in a textarea and dropped newlines, and on the
bench 1.3 to 1.5 s per 9-field form). A combobox, typeahead or datalist input, a password field, `auth login` (its
guard) and `--humanize` still type per character, since suggestion lists and some masks listen for keys. e3915e9be,
which moved textareas to one insert, kept inputs typing without giving a reason; frameworks (React, Vue) handle the
insert's `input` event as they do a paste. `fill` on a `<select>` picks the option whose label or value is the text,
else a whole line of one, else the only one containing it, as `select` does for suggestions (no match or two fail
and list the options); the answer names the option's label.

`fill` on something that isn't a field but is, or sits inside, a grid cell (`[role=gridcell]`, `[role=cell]` or `td`)
edits the cell: a field already in the cell is filled in place, and so is an editor that's already open over it (a
grid that opens one on "Add row"); otherwise it double-clicks the cell, waits up to 1 s for an editor to take focus
(inside the cell, or any field focused by the double-click, since grids often float the editor above the rows), and
presses Enter and waits again if the double-click opened nothing. It sets the editor the way the editor needs (picks
on a `<select>`, takes the matching `<datalist>` entry or the text as given, picks from a combobox's suggestions,
else fills), presses Enter to commit and waits up to 0.5 s for the editor to close. The answer reads the cell again
(by the cell, its id, or its row and column indexes after a redraw) and prints
`~ gridcell "Reorder level, FAS-53565 Reno": 250 (was 150)`, named by the editor's label. When the editor stays open
(the grid rejected the value) it presses Escape and fails with `rejected` and the grid's message (the editor's
`aria-errormessage` or `aria-describedby` text, or its validation message). So a whole grid edit is one batch of
`fill <cell> <value>` lines.

`click`, `fill`, `select` (both kinds), `check` and `uncheck` wait up to 1.5 s for a disabled target (`:disabled`, a
disabled ancestor button or fieldset, or `aria-disabled="true"`) to become enabled, so a dependent field (To after
From, City after Country) can follow the one that enables it in the same batch. One still disabled after that fails
with `disabled` and says to do what enables it first; a `click` on an element that's only `aria-disabled` goes ahead
after the wait, since the page gets that click.

`select` on a combobox picks from its suggestions per value: a typeahead or chip input is filled with the value, a
button that opens a listbox is clicked, an input with a `<datalist>` takes the matching entry. Options come only from
a popup the field owns (`aria-controls`, `aria-owns`, `aria-activedescendant`) or one inside the field's component
(the nearest ancestor holding a listbox and no other control, where a control is a field, a combobox or a button with
`aria-haspopup`, and whose lists no other control owns); anything else refuses (`no_fresh_suggestions`), names the
visible lists and points at `find role option click --name …`. A MutationObserver in the isolated world tracks the
options' own content (ids, text, labels and values); changes above the popup don't count. An exact match (the
option's text, `aria-label`, `value` or `data-value`, or an email in them) is picked once the list has been quiet
350 ms with no `aria-busy="true"`. A looser match (a whole line of the option, else the only one containing the value)
needs the options to have changed after the last keystroke; without that, after 4 s it refuses and lists what's
showing, since the list may be for an earlier query. Two matches or none fail and list the suggestions. `fill` on a typeahead types only, then says how many suggestions show
and the `select` command to pick one.

In the TypeScript CLI, three more cases work the way agents use `select` (the bench's `multitab` task lost 1–3
commands each run to them):

- A suggestion list the page drew again after the last keystroke counts as fresh even when its rows read the same
  (the watch notices new option elements, not only new text), so `select` after a `fill` of the same text works where
  it used to refuse with `no_fresh_suggestions`; a page that leaves the very same elements in place still needs an
  exact match (telemetry `select_retyped` marks a field that already held the value).
- On a typeahead, a suggestion that holds the value as whole words, like `PR Priya Raman priya@… · Engineering
  Manager` for `Priya Raman`, ranks above one that merely contains it (`Marcus Cheng` for `Marcus Chen`); the containment
  and whole-word checks compare after Unicode NFC (an exact match compares the text as given), a combining mark counts as part of its word, and `.`,
  `@`, `_`, `+`, an apostrophe or a dash between two letters joins them into one word, so an email or a name like
  `O'Brien` or `Jean-Luc` must match whole. Only fresh
  suggestions are picked this way: from a list that didn't change after typing, only an exact match is, since that
  list may answer an earlier query. The answer says which it picked (`✓ Picked "…" for "…"`, telemetry
  `select_word_match`). Only `select` on a typeahead ranks this way: button comboboxes, grid editors, `fill` on a
  `<select>` and datalists keep the old ranking.
- The pointer moves onto the chosen suggestion and the CLI checks it still reads the same before pressing: a row the
  list redrew into someone else as the pointer arrived fails with `target_replaced` and isn't clicked.
- Two or more equal matches fail with `ambiguous` and name each candidate's full text, which `select` takes to pick it.

Every input command confirms the page got it. Capture listeners in the isolated world count trusted `mousedown`,
`mouseup`, `mousemove`, `keydown`, `keyup` and `wheel` events in the target's frame; after the gesture the command
waits up to 1.5 s for the counts it needs (a click's `mousedown` and `mouseup`, one `keydown` and `keyup` per typed
character, a `wheel` per scroll, a `beforeinput` or `input` for `keyboard inserttext`). If the listeners can't be set
up the command fails before sending anything (`input_unconfirmable`). If none of the events arrive it fails with
`input_not_delivered`, or `target_replaced` when the target had left the page by then (the page redrew it, as a list
does after a search); if only some do (a `mousedown` without its `mouseup`), or confirmation fails after sending, it
reports an unknown outcome, since part of the gesture may have landed. A navigation or a closed frame counts as
delivered, and so do keys sent while focus is in an iframe and a raw `mouse` event over one, since those land in
another frame. A raw `mouse` event asks Chrome which frame is under the point (`DOM.getNodeForLocation`), so a frame
inside a shadow root, closed ones included, counts too, as do `embed` and `object` (a PDF): a bot check's "Press &
Hold" button lives in such a frame, and `elementFromPoint` only sees its shadow host. Keys whose `keydown` never reaches
the target's frame count as delivered when another frame, deeper in the page, holds focus (`document.hasFocus()` with no
frame focused inside it), as after a press into that button. Chrome delivers this input to a background tab as to the one
on screen; a failure there is a frame this check missed, not a hidden tab. The listeners add no DOM and nothing the
page's world can enumerate.

Held keys and buttons are tracked before each dispatch, and a gesture that's interrupted releases them in a
bounded (2 s), shielded `finally`; `keydown` and `mouse down` stay held across commands on purpose (and keep the
connection up). An interrupted drag reports an unknown outcome.

`drag` from an HTML5 draggable (the source or an ancestor has `draggable`, as links and images do by default) goes
through drag interception, the way Playwright does it, since a synthetic mouse drag would start a real macOS drag
session. It turns on `Input.setInterceptDrags` for the tab's CDP session before sending anything, presses on the
source and moves toward the target; when the page starts a drag, Ardia hands it over as `Input.dragIntercepted`
(the `dataTransfer` items), and from then on each point of the path is an `Input.dispatchDragEvent`: `dragEnter`,
`dragOver` along the rest of the path, then `drop` at the target, and the button is released. The drop point (for
both kinds of drag) is the target's far half: 75% of its height when the target is below the source and 25% when
it's above, or the same along its width when the two sit side by side, so in a sortable list (most of them read the
target's middle as the line between "before" and "after") the source takes the target's place. `--before` and
`--after` pick the side. Before the drag it looks for the list: the source's ancestor whose parent also holds the
target, when both are the same kind of element and it's a list row (`li`, `tr`, a `listitem`, `row`, `option` or
`treeitem`), the draggable itself or inside `aria-roledescription="sortable"`, and its text is unique among its
siblings. After the change report it finds that text again and the answer says `moved to 5 of 5 (was 4)` or `the
order didn't change: still 2 of 3` (`--json`: `position`), so the agent needn't read the list again. With `--humanize` the
path is the same curved one a mouse drag takes; without it, it's one move. If the page started a drag (a trusted
`dragstart` that wasn't cancelled) but the handover hasn't come by the release, it waits up to 1.5 s for it. On the way
out, always, one shielded cleanup that the command waits for (also when it's cancelled), so nothing it sends can land
in the next command: a drag that was handed over but not confirmed dropped (a drop that failed or timed out
included) gets a `dragCancel`; a held button is released, while interception is still on, even when the cancel
fails; and only then is interception turned off. Each of its CDP calls is bounded (2 s, plus up to 1.5 s for a
late handover), instead of one deadline that could cut a release short and leave it running. Interception
belongs to the CDP session, so it also ends when the session disconnects, and a drag the session still holds then (the daemon killed, Stop pressed mid-drag) is ended by the engine, so the page doesn't stay deaf to clicks and keys (`chromium-drag-always-ends.patch`). If the token policy refuses
`Input.setInterceptDrags` (an Ardia older than this engine), the command fails before any input with the gated message (`policy_refused`). Ardia hands a drag to a session only when the drag started from that session's own press (`docs/engine-build.md`, the control-token patch); sessions still share control of the tab, so one session's drag timing and payload aren't isolated from another session's. It reports
what happened: `✓ Done (HTML5 drag and drop)`, `the target didn't accept the drop` (the page cancelled no `dragover`, so
no `drop` event arrived) or `the page didn't start an HTML5 drag, so it was a plain mouse drag` (its `dragstart` was
cancelled); `--json` has `html5`, `started` and `dropped`. It confirms delivery like other input (a `mousedown`, then a
`dragend` or `mouseup`) and ends with its changes. A source that isn't draggable takes the plain mouse path.
`tests/fixtures/browse/dnd.html` is a sortable list; the end-to-end test reorders it both ways.

Chrome doesn't deliver mouse or keyboard input to a hidden tab, and a tab `open` puts in the background is hidden
unless the engine keeps it live. An Ardia that does keeps a tab with a CLI CDP session attached visible to the
renderer (a capturer count, as tab capture does) without switching the user's view, so the page reports
`document.visibilityState === 'visible'` shortly after attaching (about 90 ms) and gets a `visibilitychange` back to
`hidden` when the session detaches or the connection closes, the idle disconnect included; its timers run unthrottled
meanwhile. Ardia does this on the token path from engine 27cc5eff (`ac_cli_visible_tabs.cc`), and on a `--port` test
instance only when it's launched with `--test cdpTabsVisible`. Input commands check visibility first; when the tab
is hidden they poll it for up to 0.5 s, every time (one tab that stayed hidden doesn't make later ones refused
without waiting). A hidden tab fails with `code: "tab_hidden"` and the exact
fix, `[t2] is a background tab, … use: ardia browse tab t2 --show (or open <url> --show)` (`data.use` carries the
command). `open --show`, `tab new --show`, `tab <id> --show` or `AGENT_BROWSER_SHOW_TAB=1` show the tab
(`Target.activateTarget`, retried until the page reports visible and the tab target's `embedderData.tabActive` has
held for 0.3 s, since the app could switch back right after). `scroll` on a hidden tab keeps the
humanized timing but applies each step with `scrollBy` in the isolated world; `record` and `stream` refuse a hidden
tab (it paints no frames). The tab probe that picks the active tab on `--port`/`--ws` reads visibility straight after
attaching, before an engine that keeps attached tabs live has made them visible.

### What the page can see

`ardia browse` doesn't change the page's main world by default: locating, snapshots (`Accessibility.getFullAXTree`,
cursor-interactive elements found by computed style), `get`, `is`, `find`, `read`, `storage`, `select`, `pushstate`,
`vitals` (`PerformanceObserver` with buffered entries) and `a11y` (axe-core, `iframes: false`) run in an isolated
world (`Page.createIsolatedWorld`, `ardia-browse`) or through browser-side CDP. `--annotate` lists and labels only the refs whose boxes fall inside the
captured image (agent-browser 0.35.1 prints every ref on the page in its legend; ardia browse lists only what the
image shows), and draws its labels on the
PNG in Python, so nothing is added to the page. The page still sees what a person causes: trusted input events,
focus, scrolling, and the DOM changes those lead to (`select` and `pushstate` dispatch their `input`/`change` and
`popstate` events from the isolated world, and `fill` on a date, time or other typed input its `input`/`change`). An
action's network watch uses the Network domain of the command's own CDP session, which the page can't observe. Only `eval`, `wait --fn`, init scripts and the React hook run in the
main world (`eval --isolated` and `wait --fn … --isolated` don't). `wait --fn` is the caller's JavaScript like `eval`, so it runs where the page's own globals are; it's
evaluated every 100 ms until it's truthy. There's no `--enable-automation`.

A tab `open` makes in the background tells its page the window it belongs to from its first script:
`outerWidth`/`outerHeight` are that window's size, `screenX`/`screenY` its position and `innerWidth`/`innerHeight` the
content area, though the tab isn't shown (`chromium-windowless-page-screen-rects.patch`). Stock Chrome on macOS says
0x0 at 0,0 for a background tab until it's shown, which pages read as a headless tell. Background tabs throttle their
timers as Chrome's do (a hidden page's timers wake about once a second) unless the engine keeps them live.
`tests/fixtures/browse/geometry.html` and the end-to-end test check it.

The one deviation from agent-browser: the Runtime domain stays off until console or error capture starts (the first
`console` or `errors`, or `open --capture-console`); from then on it's on for that tab for the rest of the session.
`tests/fixtures/browse/probe.html` records `navigator.webdriver`, new window globals, DOM mutations, and the extra
getter reads `Runtime.enable` adds to console arguments (this engine already stringifies each console argument once
without DevTools, so the classic `Error.stack` bait reads positive on every page; the probe counts the reads beyond
that), plus every mouse and key event. The end-to-end test asserts none after open, snapshot, click, fill, get and
screenshot, that the detector does fire once `console` turns Runtime on, and that input was humanized (several
`mousemove`s before `mousedown`, presses over 20 ms, one `keydown`/`keyup` per character with varying gaps, exact
final value).

### Ardia etiquette

`open` without a session tab opens a new background tab in the sidebar (`Target.createTarget` at `about:blank`,
init scripts registered, then `Page.navigate`); later `open`s navigate the session's tab. A session works in the
background by default: it never takes the tab the user is looking at on its own. Until it has a tab (`open`, `tab
new`, `tab active` or `tab <id>`), every command that needs a page fails with `no_session_tab` and names both ways in
(`ardia browse open <url>`, or `ardia browse tab active` to work in the user's tab). Before #1738 such a session took
the active tab for its first command, so an agent's first `snapshot`, click or fill landed in the page the user was
on. `tab active` picks the page shown in Ardia's last focused window: on the token path `GET /ardia/active?token=…`;
on `--port`/`--ws` test servers, or when that route fails, the page that's visible and focused, else one that's
visible (each tab is probed through a flat session and an isolated world, then detached). It errors (`no_tab`) only
when there's no such page, as on New Tab. Once a session's tab closes it doesn't move on to whatever the user is
looking at: commands fail with `tab_gone` until `tab active`, `tab <id>` or `open`. A tab taken with `tab active` is
the user's: the session reads it, clicks and types in it, but `open` never navigates it: it opens its own background
tab, as with no tab, and in the TypeScript CLI its answer's first line says so (`→ Opened in a new background tab [t2];
the tab you picked with \`tab active\` [t1] is unchanged (\`open --here <url>\` navigates it, \`tab t1\` goes back)`,
where it used to come after the page's title). To navigate the user's tab, `open --here <url>` (a command's boolean flag takes no value, or `=true`, `=1`, `=yes` or `=on`; `--here=false` or any other value is a usage error, so it never acts; TypeScript; telemetry
`open_here`; it needs a URL, and once the session switched to another tab by id it has no picked tab, so it's a usage
error; a failed navigation leaves the session on the tab it was on; it refuses `--enable` and `--init-script`, the global
one too, since it never sets up a tab it didn't open, and `--show` on a tab Ardia keeps off-screen), or pick it by id with `tab <id>`. A ref from a page that a later
`open` replaced in the same tab fails as `stale_ref` naming both pages and how to keep both: `Stale ref @e84: it was on
"People directory"; \`open\` replaced it in this tab with "Team calendar". To keep both pages, open the second with
\`ardia browse tab new <url>\`` (telemetry `stale_ref_after_open`; four bench runs of `multitab` lost a command here). The same goes for every command that
loads a URL (`vitals <url>`, `diff url`, `a11y <url>`, `record start <path> <url>`, and `auth login` when the tab isn't
on the credential's origin; script's `page.goto` is `open`), while `back`, `forward`, `reload` and `pushstate` refuse
it (`borrowed_tab`), and so does anything that changes its site data: storage set/remove/clear, cookies set/clear,
every `set`, `state load`, `addinitscript` and `network route` (reads still work; `auth login` logs in in the
session's own tab). `eval` is left alone. `open` stays in the background and never switches the user's view unless
`--show`. When it opens a background tab it checks whether the tab takes input (`--json`: `tabId`, `background`,
`takesInput`) and says so in its own output when the session was in the user's tab or the tab won't take input, so an
agent learns it before its first click fails: `→ [t2] is this session's tab now, a background tab of its own, since
this session uses your tab [t1] and won't navigate it; `tab t1` goes back; this Ardia doesn't deliver input there.
use: ardia browse tab t2 --show (or open <url> --show)`, or `…; it takes input without being shown`. It names the tab
it left (`--json`: `left`) so an agent switches back with `tab t1` instead of running `tab list` (telemetry:
`open_moved_tab`); a command that opens its own tab for the same reason (`vitals <url>`, say) ends its notice the same
way. A tab that won't take input and wasn't a move says `→ Opened in its own background tab [t2]; this Ardia doesn't
deliver input there…`. Telemetry: `error_code` `no_session_tab` counts agents that tried to act before opening or
picking a tab (it should fall as the skill's `batch "tab active" "snapshot -i"` start spreads), and `tab` commands with
no error count the picks. `close` and `tab close` close only tabs this session opened, and not one another live session
uses (reserved through the tab registry; the answer says which stayed open); the guard refuses `Browser.close` on every
socket. `tab list` shows the user's tabs too (minus prewarmed `about:blank` pages, read/script tabs and tabs another
session is closing), with the `tab-…` id `ardia windows` prints when the app reports the tab's target, and which
session opened or uses each. `tab <id>` takes `tN`, a label, a target id or that `tab-…` id (an unloaded tab is
`tab_asleep`). When a tab's page is replaced, the session follows it only where the app's `targetId` says it went,
keeping whether it borrowed or opened the tab; otherwise it's `tab_gone` and the agent re-picks. `alert` and `beforeunload`
dialogs are accepted, as in agent-browser, unless `--no-auto-dialog`. `get cdp-url` refuses any URL that carries a
token or other credentials, however it was chosen (the token path, `--ws`, `$ARDIA_CDP_URL`); it prints only a
plain `--port`/`--ws` URL. After `frame <iframe>`, if that iframe goes away, commands fail with `frame_gone` until
`frame main` or another `frame`, instead of falling back to the main document.

### Snapshots

In the TypeScript CLI a repeated `snapshot -i` of the same document prints only what changed since the last one this
session printed for that tab:

```
snapshot -i (changes since your snapshot 2 commands ago of "Task board"; 12 refs unchanged and still valid; `snapshot -i --full` lists everything)
+ button "Fresh task" [ref=e14]
~ button "Item 3 done" [ref=e4] (was: button "Item 3")
```

`+` lines are new, `~` changed (with what they were), `-` gone; every ref not listed keeps its meaning, since a ref
names one element in one document for as long as that document lives. It prints the full list instead when there's no
earlier snapshot of that tab in this daemon (a first snapshot, or after the daemon restarted), when the tab navigated
or its main document or the scoped frame changed, for another tab, frame, `-s`, `-d`, `-c`, `-u` or `--diff`, inside a
`script`, with `--json` (whose output is unchanged), `--full` or `--max-output 0` (so `--out <file>` saves the whole
list; a batch line's `--out` saves it too), when refs that stayed moved relative to each other, and when more than 40%
of the refs changed: past that share the diff is about as long as the list and harder to read, and a diff that comes
out no shorter than the list is dropped for the list too. Inside a `batch` only the batch's own `--full` or that
line's turns the diff off, since an earlier line's `--full` widens the whole batch's cap. A snapshot whose output was
cut by the cap (its own or its batch's) doesn't become the one the next diff compares with: a batch cut by its cap, or
interrupted, leaves the one from before it, so the next snapshot still diffs against what you saw. A snapshot only saved to a file (`--out`, alone or on a
batch line or the batch) or printed as `--json` doesn't count as shown, and one a `script` takes never does, inside a batch too. A control's `(near …)`
label counts as part of it, so a changed label shows as a change. Telemetry: `snapshot_diff` and `snapshot_diff_full` (a repeat that fell back); watch
`snapshot_chars` on `snapshot`, which it should lower. In the bench, snapshots inside batches were 39% of the bytes agents
read, and 4.7% of the refs they listed were used in the next two commands.

`snapshot` renders a native `date`, `time`, `datetime-local`, `month` or `week` input (accessibility roles `Date`,
`InputTime`, `DateTime`) and a `color` input (`ColorWell`) as one `textbox` with its type, its `required` state and
its DOM value, read from the isolated world: `- textbox "Date" [type=date, required, ref=e7]: 2026-11-06`. Their
internal spinbuttons and picker buttons are left out, in full and `-i` snapshots alike. Those pieces also had doubled
names (`spinbutton "Month Month"`, `button "Show date picker Show date picker"`). That comes from Chromium, not
ardia browse: for a field inside a date or time control `AXNodeObject::GetName` appends the control's own name and
passes the same `name_sources` vector to it, and DevTools' `Accessibility.getFullAXTree` always asks for sources
(`inspector_type_builder_helper.cc`), so `GetSavedTextAlternativeFromNameSource` picks the first winning source in
the shared vector, the field's own `aria-label`, and the name becomes `Month Month` instead of `Month Date`. Screen
readers never ask for sources, so they hear the right name. Hiding the pieces means no doubled name reaches an
agent; the engine fix is to give the ancestor its own `NameSources`. A clickable element with no accessible name
(found by `cursor: pointer`, `onclick`, `tabindex` or `contenteditable`) is named by its text in full snapshots too,
so both kinds of snapshot agree on what each ref is.

`snapshot -i` cuts names past 100 characters with `…` (text in a full snapshot stays whole), and in a run of one role
at one level (as long as the ones the change report folds) with three or more disabled members it lists the enabled
members as usual and puts one count line where the first disabled one was (`- 108 disabled buttons (Seat 1A … Seat
30F)`), dropping the disabled members and what they hold, so a seat map lists every free seat within the output cap.

When the session's tab is a web page with site notes, `snapshot` (full or `-i`) starts with them (see Site notes).
`snapshot --diff` (with or without `-i`) prints only what changed since this session's previous snapshot of the same
document, in the format of Changes after actions (without network writes); "previous" counts a whole-page snapshot,
`snapshot --diff` itself and the view each action takes afterwards. With no earlier snapshot of the document it
prints the whole snapshot after a line saying so. It takes no `-s` or `-d`.

### Changes after actions

After `click`, `dblclick`, `fill`, `type`, `select`, `check`/`uncheck`, `press`, `keyboard type|inserttext`, `drag` and
`find … <action>`, the answer ends with what the action changed, so an agent rarely needs another snapshot:

```
✓ Done
changes:
url: http://127.0.0.1:8792/ → http://127.0.0.1:8792/#saved
+ textbox "Title" [required, ref=e21]
+ combobox "Calendar" [expanded=false, ref=e22]: Home
+   option "Home" [selected, ref=e23]
+ 10 back as last shown: e1 e2 e3 e4 e5 e6 e7 e8 e9 e10
~ textbox "Date" [type=date, required, ref=e27]: 2026-11-09 (was '2026-11-06')
- 11 removed: e11 e12 e13 e14 e15 e16 e17 e18 e19 e20 e21
POST http://127.0.0.1:8792/api/events → 200
```

- **Nodes** (`changes.py`). The command takes the interactive snapshot's view of the page (the same collection as
  `snapshot -i`, refs kept) before the action and again after it, and compares them by ref: `+` added (indented as in
  `snapshot -i`; nodes whose line is exactly what the session was last shown fold into one `back as last shown`
  line), `~` changed (role, name, value or state, with what it was), `-` removed (one line each up to five, else one
  line of refs). After the action the new refs are live, so a dialog's fields can be used straight away. A run of
  one role at one level (6 or more options, links, menu items, tree items or generic clickables; 12 or more buttons,
  radios, checkboxes, switches or tabs) is one line with its count, parent, first and last name, ref range and how
  many are disabled (`+   48 options in combobox "Start time" (12:00 AM … 11:30 PM; e8…e55)`), followed by any
  selected, pressed, expanded or checked member verbatim. A run with both enabled and disabled members lists the
  enabled ones one by one (up to 40) and counts the rest, so the choices are never folded away
  (`+ 35 enabled …` lines, then `+ 119 disabled buttons (Seat 1A … Seat 30F)`). Nodes redrawn unchanged under new
  refs are one line (`+ 13 redrawn as they were, with new refs: …`). A new document (or a changed URL or title)
  prints the new page's whole interactive tree that way, up to 150 lines, so no follow-up snapshot is needed; landing
  on another site prints its notes first, as `snapshot` does. A same-page report stops after 40 lines with a pointer
  at `snapshot -i -s <css>`. Names longer than 100 characters end in `…`, here and in `snapshot`; `find … --name`
  takes such a clipped name (with or without the `…`) as a prefix of the full one.
- **Text** (`text:` lines, `changes.add_text`). After a navigation (new document, URL or title) the report adds the
  readable text of the page's `main` (else `body`), about 3,000 characters; when an action opens something on the same
  page (a new heading of level 1 or 2, or a new dialog, article or region holding new nodes) it adds that container's
  text (`closest('article, dialog, [role=dialog], [role=region], section, main > *')`), about 1,200 characters. Short
  blocks such as a card or a table row are one line, joined with `·` (cells with `|`). Enabled controls carry their
  ref inline (`Main $129 per person [@e92]`, using the control's `aria-label` when its visible text is short); a
  disabled control shows only its visible text. A canvas, image or `role=img` of 48 px or more is
  `[image "receipt.png": screenshot @e91]` (the ref is new, made for it), and a child frame is
  `[frame "Folio.pdf preview": frame @e95; read]` followed by the frame's own text when it's in reach. Rows the text
  already shows with their ref and no state or value aren't repeated as `+` lines, and when the text says no more
  than the new rows' names (a form dialog) it's left out. Cut text ends with `… more: read -s <css>`; after a
  navigation the `+` list gets what's left of about 5,400 characters and the removed nodes of the last view are a
  count. Values of password fields never show. `open <url>` reports the page it lands on the same way, as a click
  that navigates does (not inside `script`, where `goto` stays light).
- **URL and title** of the session's tab, when they changed. The URLs keep their path and query, but the values of
  keys that look like credentials (`code`, `token`, `pass`, `secret`, `key`, `sig`, `auth`, `session`, `state`,
  `nonce`, …) and a fragment holding `=` become `…`.
- **Network writes.** The first action on a tab turns on `Network` for the tab's CDP session, unless the session
  already captures it (`network requests`, HAR, `set offline`), and leaves it on until the session lets the tab go, so
  later actions don't turn it on and off again; each action listens only while it runs. Afterwards it waits for the
  requests the action started to be answered (headers in; a response body the page never reads doesn't hold it up), for
  a quiet 50 ms with none (120 ms after the last network event when there were some), and for `DOMContentLoaded` if
  the action navigated, at most 1.5 s; past that it says the page was still busy. Background requests neither hold it
  up nor restart the quiet window: pings and beacons, CSP reports, images, media, fonts, prefetches,
  manifests, event streams and WebSockets, requests to known analytics, tag-manager, ad and video-QoS hosts
  (`browse/changes/background.ts`) from a page on another site (on the vendor's own site they are its app's
  traffic), favicon `GET`s, and Google Analytics' and Cloudflare's collector paths on any host
  (`/g/collect`, `/j/collect`, `/r/collect`, `/cdn-cgi/rum`); a redirect is judged again by where it goes, and a
  redirect of a request that began before the action isn't the action's. Documents, scripts, stylesheets, fetches and
  XHRs to anything else are still waited for (`settle_ignored_background` marks a settle that passed some by), and
  when only background requests came, the quiet window is still the longer 120 ms. Only writes to those known hosts
  and collector paths are left out of the list below; a first-party beacon is listed, and so is a write that
  redirects to a collector. Then it removes its listener, also when the action fails or is cancelled; it takes no
  capture lease or tab claim, so the idle disconnect works as before. It reports requests that aren't `GET`, `HEAD`
  or `OPTIONS` (fetch, XHR, form posts), in order: method, URL without user info, fragment or query values (`?token=…&id=…`; a query key that isn't plain
  letters, digits and `_.-[]` becomes `…` too, and so does a path segment with a `:` or one of 20 or more characters
  mixing letters and digits; non-http(s) URLs only as `data:…`), every status (`303 → 200` for a redirect), `failed`/`canceled`, or `pending`. Request bodies and headers
  are never read. While no capture is on, `network requests` keeps no log, so these requests don't show up there.
- **JSON.** `data.changes`: `document` (`same`, `new`, or `unknown` when the view before couldn't be taken),
  `url`/`title` (`{"from","to"}` or null), `added`, `removed` (each `{ref, role, name, value, attrs}`), `changed`
  (`{ref, from, to}`), `back` (refs), `network` (`{method, url, type, statuses, status}` plus `failed` or
  `pending`), `rerendered` (`{ref, was}`), `notes` (the arrival header), `text` (`{lines, more, where}`) and
  `unsettled`/`error` when they apply. Every
  node is listed, folded or not. Names are redacted before the 200-character cut and before folding, and everything
  is sanitized like any other answer.
- `--no-text` leaves out only the `text:` lines. `--no-changes` skips all of it for one command (no snapshots, no
  network watch), and `open` then prints only its title and URL. If the view afterwards can't be
  taken (the tab closed, say), the action's result stands and the report says why.

### Output cap

Text output of every command stops at 12,000 characters (20,000 for `script`, whose result the agent asked for), at a
line break when there's one in the last fifth, and one line on stderr points at narrowing, tailored to the command,
and names `--max-output` last: `[output capped at 6,000 of 15,920 characters. Narrow it: snapshot -i -s "[role=main]"
(the main, 380 of 512 lines), find role <role> <action> --name <text> (act without a snapshot); or --max-output 15920
for every line]`. For a snapshot it names the biggest landmark or list whose role appears once (`main`, `navigation`,
`form`, `table`, `list`, `dialog`, …; not `banner` or `contentinfo`, whose implicit selectors match only a header or
footer right under `<body>`) as `-s "[role=…]"`, with its share of the lines, and only when that share is at most 70%;
otherwise the fixed hint. The notice travels apart from the page's text, so a page line that merely looks like one
stays in stdout (inside `--content-boundaries` markers), and a capped `read` inside a `batch` still sends its footer
to stderr; it's written to stderr even when stdout was closed early. The
whole output is still saved, and the line names that file last, after `--max-output`, as `(full output: <path>)`. It
used to suggest `--full`, and agents ran `snapshot --full` at up to 35K characters a time. The line goes to stderr
only (so does `read`'s own "pages cut to fit" line), so it survives `| head`, `| grep` and `> file` and stays outside
`--content-boundaries` markers. In the TypeScript CLI and Python alike it used to end stdout as well, so an agent reading
both streams saw it twice (22 of 28 cap hits in the bench), and it led with "all of it is in <file>", which agents then
`cat` or `sed` into context (7 of 28); the file is now the last clause, never offered as the next step. `read`'s line
also leads with narrowing and names its file last. `--max-output N` (or
`AGENT_BROWSER_MAX_OUTPUT`) sets another limit (`0` for none), `--full` turns it off; JSON output is never cut, and
neither is output redirected to a regular file (`> out.json`), which never reaches the agent's context. `script`, `eval`,
`read`, `snapshot` and `get` take `--out <file>` (`snapshot` and `get` save their full text, uncapped, and print the
first 12 lines; `read --scroll` saves its rows): the client asks the daemon for JSON, writes the whole result to the file (a script's or
eval's value as JSON, or a string as is; `read` pages as JSON for a `.json` path, else as text), redacted, through a
temporary file, and prints a short digest (`✓ Saved to rows.json (84,210 characters): a list of 900 items with fields i, name`, then
the first and last rows) plus the script's last 20 log lines. A failure prints the error and writes nothing. `read --out` lists each page with its status,
read time and a 500-character excerpt (12 pages at most); a saved list also prints its first rows, up to 3,000
characters, so the agent reads what it saved and the transcript keeps evidence of what each page said. A `.csv` or
`.tsv` path turns a returned list of objects (or an object holding one such list) into a table, columns in first-seen
order, nested values as JSON (`saved_as_csv`): two bu9 tasks were zeroed for reward hacking because the agent typed
rows into a build script instead of deriving them from saved data:
a BU Bench judge failed `bu3` items whose values lived only in a file. A script starts with `state`, one JSON object per
session that the daemon keeps between scripts: the worker sends it back (at most once a second, on each command it
awaits, and at the end), so a script that times out keeps what it gathered, and the timeout error lists what's in
it; when nothing was kept, it says to push results into `state` as they come. A timed-out script that had opened three
or more pages one after another is pointed at `read <url> <url> …`, which loads them side by side with a time limit
each: a `bu12` task lost three minutes to a script that opened seven pages in a row and saved nothing. Browser Use's agent keeps data in a persistent REPL and Betterwright's in a `state` object; Ardia's agents lost
whole loops to timeouts and rebuilt them through files. Browser Use's agent on
BU Bench keeps extracted data in its program and writes deliverables from it; Ardia's agents saw the output cap in
every transcript and retyped values, and the judge's faithfulness items were met half as often. The saved
copy goes in a `0700` folder in the user's temp dir, which keeps the newest 40: agents on BU Bench reran long
scripts with `--max-output` only to see the result the cap had cut, and complained most about that. `--full` after `screenshot` or `diff` is still their
full-page flag. A `read` reads every URL it's given (up to 100, so a script's `read(urls)` goes 100 at a time); only
`--links` reads at most 20 unless `--limit` (with no URL, `--list` still prints every match), since agents passed 27-URL lists and lost the last seven. `read <url>... --links <pattern>` takes the links from the URLs it's given, each opened in one background reader tab that waits up to 5 s for a matching link to render, and reads (or with `--list` prints) those links rather than the named pages, at most 20 unless `--limit` however many listings there are; links to a named listing (compared as serialized URLs) or to a listing already visited are skipped, a listing that fails to load is named in a `[couldn't list the links on <url>: <why>]` line while the others' links are kept (exit 1, and named in `--out`'s summary and text file; all failing is `navigation_failed`), and a document change while polling settles and looks again (each look waits only as long as the 5 s window has left, and one that times out fails that listing); with no URL it takes them from the session's tab. It used to take them from the session's tab either way, so an agent whose session had moved on read or listed the wrong page's links (FB-MPXE; `read_links_from_url`, and watch `error_code` `no_links` on `read`). A `read` of a PDF
prints its text page by page (`[page 1 of 3]`), taken with macOS's PDFKit from bytes fetched with the page's cookies
(40 MB at most; a scanned PDF says it has no text layer). A page that reads thinner than 120 characters (or whose `-s` matches nothing yet) after it
settles is read again every 0.5 s for up to 5 s: single-page apps that render their results after the load event
used to read as a heading or nothing. Each page's header carries its HTTP status and the UTC time it was read
(`=== Title (HTTP 200, read 2026-11-14 06:04:19 UTC)`), so a judge or reviewer can see when and how each source
answered. A page that reads like a bot check or block (a 401/403/429, or a short page saying "Just a moment",
"verify you are human", CAPTCHA, "access denied"…) gets a note under its header: wait 30-60 s and read it again,
try the site's other pages or another source, and name what stayed blocked. On BU Bench, 60% of the tasks Ardia's
agents lost by 30+ points showed such a block, and the agent usually gave up after one try. Each page read also carries a scope line
when the page states its own extent: `(scope: page says "1–20 of 340 results"; has a Next page link, pages up to 17)`
(a count range, an "N results"-style total, "page N of M", a rel=next or Next link, a Load more button, the highest
number in a pagination nav); `read` of the session's tab ends with `[scope: …]`, then `[read <UTC time>]`, the moment it read the page (also `readAt` in `--json`), which agents used to take with `date -u` at the wrong moment, before or after the filter the answer depended on. On BU Bench, coverage was the rubric
family Ardia's agents failed most (45% violated), and Browser Use's prompt has its agent check counts and coverage
against the source. The cap rose from 6,000 to 12,000 (6,000 a page for multi-page reads, up to 36,000): 746 of
5,755 baseline commands hit it and 704 of those reran with `--max-output`; Browser Use's agent allows 12,000. A script
or eval value that is a list of objects prints one compact JSON row per line (as does an object holding such lists). A `read` of several pages gets 6,000 characters a page instead (at least 12,000, at most 36,000) and
shares it between them (`readpages.pages_cap`): research reads of 8 to 12 pages used to come back cut to a few hundred
characters each.

### Site menus

A whole-page `read` (and `open --read`) prints each site menu and link-heavy footer outside the page's `main` or
`article` as one line: `[navigation hidden, 15 links, a search box: Search · Dinners · Meals …; read --nav shows it]`
(`js.py` `readable`; menus next to each other share one line, and only the first names `--nav`). It still prints
breadcrumbs, pagination (named so, or links that are mostly numbers, Next and Previous), in-page contents (named so,
or links that are mostly `#` anchors on the same page), filters (named so, two or more visible checkboxes, radios,
sliders or switches, or a dropdown that isn't a language, version or theme switcher), menus whose text is under 100
characters or is mostly not link text, menus holding a `main`, an `article`, a visible frame or one of those kept menus,
and everything inside `main` or `article`, also through shadow roots, slots and frames. A page whose
menus hold more text than the rest of it prints whole when it has no `main` or `article` (a sitemap, a directory of
links), or when the rest is under 400 characters. `read -s`
never hides what it was pointed at, and `read <url>` reads `<main>` as before (`--nav` reads the whole body). Agents on
the WebVoyager control run piped `open --read` through `head`, and the menus came first: on GitHub's home page and an
Allrecipes search they were a quarter of the text (24% and 26%), and 1 to 6% on the other sites, about 30 to 300
tokens a read; `snapshot -i` still lists every menu link with its ref.

### Reading lists and grids

`read` (and `read -s`) prints a table or an ARIA grid one row per line: `tr` and `[role=row]` are rows, and `td`, `th`
and the `gridcell`, `cell`, `columnheader` and `rowheader` roles are cells, split by ` | ` (`js.py` `readable`). A grid
built from `display: grid` divs used to come out one cell per line, so 80 lines held 6 rows. When `aria-rowcount` is
larger than the rows in the DOM it adds `(25 of 2682 rows rendered; the grid is virtualized: sort, filter or scroll it
to see others, or read -s <grid> --scroll)`.

`read [-s <list>] --scroll [--limit rows] [--match <text>] [--timeout ms]` reads a long or virtualized list on the
session's tab in one call, the loop agents used to hand-write in 3 to 4 calls (`readpages.run_scroll`). `-s` takes a
selector or a ref; without it, the page's main repeated list is used: the element with the most children of one tag
and class (at least 4), weighted toward children holding links and toward more text (`MAIN_LIST`), or `no_list`. Rows are the list's outermost `option`, `row`, `listitem`, `treeitem` or `article` roles, `li`, `tr`
or `article` elements, else its children; when the selector matches several elements and they hold no such rows,
those elements are the rows. It finds the scroll box (the nearest scrollable ancestor of a row, else of the list, else
a scrollable box inside it, else the page), starts at the top, and each step jumps to the last row rendered (at least
nine tenths of the box), then waits for the rows to stay the same for 0.1 s (up to 1.5 s, 8 s while the list shows
`aria-busy` or a `Loading…` row). It stops when the box can't move and stopped growing, at `--limit` rows (1,000;
10,000 with `--match`) or at `--timeout` (30 s), and then scrolls the box back where it was. Virtualized lists
recycle nodes, so a row is keyed by `aria-posinset`, `aria-rowindex` or `data-index`, else `data-id`, `data-key` or
its id, else its offset in the box plus its text, and rows print in that order, a row's lines joined by ` · `.
`--match` keeps rows containing the text, ignoring case. The last line says how many rows it read and why it
stopped: `[2 of 200 rows match "staples"; scrolled to the end of the list]`. A hidden tab (plain Chrome without
`--show`) draws no animation frames, so lists that render rows in one stop early; then that line adds `the tab is
hidden, so the page may not have drawn every row: ardia browse tab t3 --show, then read again`. The inbox of the expenses fixture (200
mails, 40 a page) reads in about 3 s, and its 2,682-row grid in about 16 s.

### Forms agents guess

The TypeScript CLI also takes the forms agents typed in the bench and got `Unknown …` for, each costing a turn:

- `get attribute <sel> <name>` is `get attr <sel> <name>`; the help now gives `attr`'s real order, selector first.
- `-s <sel>` or `--selector <sel>` names the element on `screenshot`, `get`, `click` and `fill`, as the positional
  selector does. On `fill` it must come before the text, and the word after it is the text even when it looks like a
  flag (`fill -s #q -s` types `-s`). An empty selector (or `--`), a selector given both as a word and with `-s`, and a
  screenshot path given twice (or a word after `screenshot -s <sel>` that isn't a file path) are usage errors. Flows
  record `fill -s` like `fill` (typed text masked) and keep `find … --nth`.
- `links [pattern]` is `read --links <pattern> --list` (every link without a pattern). It takes `--limit`; `-s`,
  `--out`, `--links`, `--timeout` and a second pattern are usage errors (use `read --links … --list` for those).
- `find role … --nth <n>` picks match n of several (from 0, like `find nth`) instead of failing as ambiguous, and an
  ambiguous `find role` error mentions it; `--nth` on another locator is a usage error pointing at `find nth`.

A `find role … --name` that matches nothing now leads with the closest name and its ref, `closest: button "Archived · 1"
@e700`, before the list of names, so the next command can use the ref (`--json`: `data.closest` with `ref` and
`name`; telemetry `find_closest_ref`). When several elements share that name it gives the name, how many it can
reach (`50+` past 50), and the `find role … --name '<that name>' --exact --nth <n>` that picks from exactly those, and
no ref. It's worked out only once the
1.5 s wait for a match has run out, from the last attempt's accessibility tree, so no ref is made for a hint nobody
sees and no extra tree is fetched. Only the message changed: matching, `--exact` included, is as before. In the
bench, 9 runs lost a command to `--name "Archived" --exact` against a button named "Archived · 1".

Each form above sets `guessed_syntax` in telemetry, and the new flags are in the `flags` table; watch `guessed_syntax` against
`error_code` `usage` and `unknown_command` on `browse`, and `--help` runs, which these should lower.

### Batch

`ardia browse batch [--bail] [--json]` runs commands one after another in one call and one daemon request. With no
command arguments it reads them from stdin, one per line, so a heredoc works; blank lines and lines starting with `#`
are skipped. A line is a command as you'd type it after `ardia browse` (shell quoting rules, through `shlex`), or a
JSON array of strings. The session's flags (`--session`, `--port`, `--data-dir`, …) go on the `batch` command; a line
takes its command's own flags and the per-command ones (`--full`, `--max-output`, `--no-changes`, `--no-text`, `--humanize`,
`--show`); `--full` or a larger `--max-output` on a line widens the whole batch's cap, never narrows it. Each
command's answer, changes included, is printed in order, separated by a blank line; `--bail` stops at the first
failure, and a command whose outcome is unknown stops the rest (`not_run`). A line that reports changes starts from
the page as the line just before it left it (that line's view after, when it was on the same tab and document), so the
page is read once between two lines, not twice. A run of `fill`, `type`, `select`, `check` and `uncheck` lines whose
next target is already known (a CSS selector, or a ref the session has) reads the page once before the run and once
after its last line, and settles once (each held line still waits the usual quiet window and for requests it started
itself, so a list it fills in arrives before the next line and a flow keeps their answers): the lines before the last print `✓ fill #name "Ana Ruiz"`, and the last prints
the run's whole change report (`batch_lines_held` counts the held lines). If a line in the run fails, it gets its own
error and the report so far goes on the line before it. Lines with `--no-changes`, `--full`, `--max-output` or
`--out` aren't held. `batch` can't run inside a batch. `close`
can be the last line: it ends the session once every other line ran and succeeded (else it reports `not_run` and the
session stays); anywhere else the error points at `tab close`. For a loop the page has to run itself, `eval`
takes JavaScript (`eval --stdin` from a heredoc) and runs it in the page's main world.

Filling a form five times is one call:

```sh
ardia browse snapshot -i
ardia browse batch --bail <<'EOF'
# one contact per block; @e10 is "Add contact" from the snapshot
click @e10
fill #name "Ana Ruiz"
select #group clients
fill #email "ana@example.com"
fill #phone "+1 555 0100"
click #save
click @e10
fill #name "Tom Becker"
…
EOF
```

Refs stay valid across the batch as long as their nodes do (a dialog that's reopened keeps its fields' refs), and
every selector form (see Refs) and `find` line works as on the command line. `eval` with `fetch(`, `DOMParser` or
XHR, and open → `get text` on three pages in a row, print a one-time tip on stderr pointing at `read` and `script`.

`ardia browse script` runs its JavaScript in a runner process the daemon starts from its own program
(`--ardia-script-runner`, TypeScript; Python's `browse/script.py` still uses a Worker of a blank background page). The
script sees only its API: `page`, `browse`, `read`, `log`, `sleep`, `state`, `console`, timers, `URL`,
`URLSearchParams`, `atob`, `btoa` and `structuredClone`, in a `node:vm` context whose global has no prototype from the
runner (every object it can reach is its own realm's, and `import()` is refused with its own error). The runner talks
to the daemon only over its IPC channel, starts with an empty environment and `/` as its folder, and confines itself
before it runs anything: on macOS a Seatbelt profile (`ardia-libc.so` `confineProcess`) denies network, file writes,
file reads outside `/usr` and `/System`, process exec and fork, Mach lookups and POSIX IPC; on Linux Landlock (where
the kernel has it) denies the file system, TCP and, from ABI 6, abstract sockets and signals. A runner that can't
confine itself on macOS refuses the script. Each script gets a fresh runner; the daemon keeps one started and
waiting (killed after 5 idle minutes), so a script starts without a tab or a page load. A script past its
`--timeout`, one using more than 1 GB (polled every 200 ms: `proc_pid_rusage` on macOS, `/proc` on Linux) and one
interrupted are killed with SIGKILL; `state` survives each, since the runner sends it as it goes.

Each `page.*` call is a browse command on the session, served straight from the IPC message (no controller tab and no
CDP hop per call). Read-only calls (`get`, `is`, `read`, `page.evaluate`, `page.$eval`, `page.$$eval`,
`page.frames()`) run side by side, up to 8 at once, so `Promise.all` over them is concurrent; every other call waits
for the calls before it and runs alone, in the order the script made them. Calls still queued when the script returns
never run. When it returns or fails, actions and `evaluate` calls it didn't await that were already sent finish (still
within its `--timeout`), while reads and sleeps still running are stopped; the result says how many never ran and how
many were stopped. A timeout or interrupt stops waiting on everything still running; code an action or
`evaluate` already started in the page can still finish there, since CDP has no way to stop it midway. Either way
every call's promise is awaited before the command answers. A CDP reply that arrives later (a temporary tab created past its deadline) is
still cleaned up when it lands, as for any command.
`page.evaluate` counts as a read: an `evaluate` that changes the page should be awaited on its own, not inside
`Promise.all`. A script has exactly the authority of the `ardia browse` commands it calls, no more: `screenshot` and
`pdf` write the files it names and `read --http` fetches through the daemon, as they do from a shell. Actions made through `page` (`click`, `fill`, `type`, `press`, `select`,
`check`, `uncheck`, `hover`, `focus`, `dblclick`, `keyboard`, `scroll`) wait for the page to settle (network and the
DOM's reaction) but skip the change report's snapshots and text; pass `{receipt: true}` as their last argument for the
report. `browse('click', …)` is the command as typed, with its report. `page.evaluate(fn, ...args)` (also `page.eval`)
is `eval` of `(fn)(...args)` in the page's main world, the arguments JSON. `page.$eval(sel, fn, ...args)` calls `fn`
with the first match (failing when none matches) and `page.$$eval(sel, fn, ...args)` with an array of every match;
their selector is written into the expression as a literal, so `eval`'s quoting repair fixes an unquoted attribute
value. `page.frames()` lists the tab's frames (`id`, `url`, `name`, `origin`, `parent`, `main`, `crossProcess`), each
with `evaluate`, `$eval` and `$$eval` that run in that frame's isolated world, cross-process frames included where the
session attached them. `page.dblclick`, `page.focus` and `page.keyboard(text)` (`keyboard type`; also
`.press(key)`, `.type(text)` and `.insertText(text)`) cover cells and fields that only take typing, and the
Playwright names agents reach for (`content`, `innerText`, `textContent`, `inputValue`, `getAttribute`, `isVisible`,
`goBack`, `goForward`, `waitForSelector`, `waitForURL`, `waitForLoadState`) map to the matching commands. Any other
`page` method throws a `TypeError` (code `usage`) that names the API instead of `page.x is not a function`. Two
mistakes get a hint under the error: a `ReferenceError` for `document`, `window`, `localStorage`, `sessionStorage` or
`getComputedStyle` in the script itself says the script runs outside the page and points at `page.evaluate` or
`ardia browse eval`, and one from inside `page.evaluate` for a script variable says to pass it as an argument.

### Site notes

`ardia notes` (and `ardia browse notes`, the same command) keeps plain notes per site for the user's own agent;
Ardia runs no AI and never reads them itself.

- `ardia notes [get] [SITE]` prints them; `set [SITE] TEXT|-` replaces them, `append [SITE] TEXT|-` adds a line,
  `rm [SITE]` deletes them and `list` shows every site with its size and time. `-` reads stdin.
- `SITE` is `host[:port]` (a URL works too; default ports are dropped, names are lowercased and IDN hosts become
  punycode). Without it, it's the session's tab's site, so that form needs Ardia (and auto-attaches like any command);
  with it, or for `list`, it runs without the browser. For `set` and `append` the first of two or more arguments is
  taken as the site only when it looks like one (a dot, a port or `localhost`), else all of them are the text.
- One markdown file per site, `<data dir>/Notes/<host[:port]>.md`: the folder is made 0700 and must be a real folder
  the user owns, files are 0600 and opened relative to it with `O_NOFOLLOW` (a link or anything but a regular file is
  refused), writes go to a temp
  file that's renamed over the old one, and each site holds at most 8 KB (`code: "notes_too_large"`, nothing
  written).
- On a page with notes, `snapshot` and `snapshot -i` start with them, cut at 1,000 characters (the rest is one `ardia
  notes get` away): `# notes for 127.0.0.1:8792 (ardia notes): Add events with + New Event` and `# `-prefixed lines
  after it. `--json` has them in `data.notes`. They count as page content (inside `--content-boundaries`), since a
  page could have talked an agent into writing them. Writes take an exclusive lock on the folder, reads never block
  on a FIFO.

### Saved flows

A flow is a read-only task done once in the page (a search, a filtered list, a lookup) saved as the GET request
behind it, so the next run is one call that returns just the data (`browse/flowlog.py` records, `flows.py` builds,
checks and stores, `flowurl.py` parses and masks URLs, `flowrun.py` runs, `shape.py` shapes). Modeled on
agent-browser's saved flows, without its launch flag, direct HTTP tier, command replay, writes or MCP tools.

**What a run does.** A flow run opens the flow's start page like `open` and sends GET requests to the flow's site; it
never replays clicks or typing, and a site whose GET endpoints change state (some logout links) isn't protected
against that. When anything goes wrong it stops and says why; the agent then drives the page itself (open, click,
read). Flows keep and send GET requests only: a task whose answer comes from a POST, GraphQL over POST included,
can't be saved (`flow_not_get`), and GraphQL over GET works only when its URL values pass the literal rule below.

- **Recording.** Every session keeps its last 200 actions (`open`, `click`, `dblclick`, `fill`, `type`, `press`,
  `keyboard`, `select`, `check`/`uncheck`, `find`, `back`/`forward`/`reload`, `scroll`, `hover`, `focus`, `wait`,
  `pushstate`; also inside `batch` and `script`) in memory, never on disk: the command, the URL before and after,
  whether it worked, the first-party (same base domain) origins its GET requests went to, and the answers of up to 8
  first-party GET XHR, fetch and document requests with a 2xx status, JSON or HTML, under 2 MB each, at most 2 s in
  all (`Network.getResponseBody`, read off the change report's network watch before it turns `Network` off). A
  document is kept only when a `<script>` holds JSON: `type="application/json"`, `__NEXT_DATA__`, JSON-LD, or a plain
  `window.x = {...}`. Answers stay under 16 MB per session (the oldest are dropped first). Request bodies are never
  read; other methods are only counted, so `flow steps` and `flow save` can say they weren't kept. `--no-changes`
  records the step without its requests. After a typing command it reads the focused field once: a password field,
  an `autocomplete` of `current-password`, `new-password`, `one-time-code` or `cc-*`, a name, id, label, placeholder or
  selector with `pass`, `secret`, `token`, `otp`, `pin`, `cvv`, `cvc` or `card`, or a value the CLI redacts (a vault
  password) makes the value a secret.
- **URLs** (`flowurl.parse`, one parser for the start URL and request URLs). An absolute `http` or `https` URL in
  plain ASCII (an IDN host must already be punycode), with no backslash, whitespace, control character or user info,
  a host of DNS labels (lowercased) or a bracketed IPv6 address, and a port from 1 to 65535. A host whose last label is
  a number in any spelling (`127.1`, `2130706433`, `0x7f000001`, `0177.0.0.1`) or an IPv6 address is an IP literal;
  it, and `localhost`, are allowed only when the flow was recorded on that exact host and port. Other hosts must sit
  on the start URL's base domain, on its port or the scheme's default. Origins are compared by exact equality after
  that normalization.
- **The literal rule.** A saved request URL keeps a path segment or query value only when it is a param, a number,
  or a short value (up to 24 letters, digits, `-` and `_`, plus `.` inside a path segment) with no `@`, isn't a typed
  secret in any encoding (as is, percent-encoded, JSON-escaped, base64, hex or as decimal bytes), isn't under a
  credential-named query key (`token`, `key`, `sig`, `session`, `password`, `csrf`, …), and the path has no
  credential word (`sessions`, `tokens`, …). Anything else leaves the whole request out, and the save report says why.
  This is a limit, not a guarantee: a short opaque token or a numeric id under a query key the rule doesn't
  recognize (`?u=a8f3k2`, `?ref=1234567`) is kept. Param examples follow the same rule; a value that fails it is a
  param with no example. `flow steps`, the save report and each saved step's command and page URL show URLs with every
  value that fails the rule, or carries a known typed secret, as `<hidden>` (a bare secret word is `<redacted>`), and
  user info and fragments dropped.
- **Answer shapes.** The recorded shape keeps an object key only when it is a short identifier
  (`[A-Za-z_][A-Za-z0-9_]{0,31}`) and not a typed secret; other keys become `*`, so a map keyed by emails or ids is one
  stable shape (drift checks skip `*`). The main list's path and item fields follow the same rule, and a document's
  JSON block is found again only by a plain `id`.
- **`flow steps [--all]`** lists the steps since the last save (`[3] click #go → <url>`, then each kept GET as
  `s3r1 GET <url> 200 json` and a count of other requests not kept), text and `--json` (`data.steps`).
- **`flow save <name> [--from n] [--to n] [--param k=v]… [--output s3r1] [--description text]`** saves steps from the
  last `open` after the previous save to the latest (or `--from`/`--to`). It keeps the GET requests on the start
  page's site whose answer was JSON (or a document's largest JSON block) and whose URL passes the literal rule, and
  for each: the URL, the `accept` header when it is CORS-safelisted, and the answer's status, MIME type, size,
  shape, main list and its item fields (only names of up to 24 letters, digits and `_`, dotted once). Params: every
  value typed into an ordinary field becomes `{{name}}` (named after the field's name, id or label when that is a short
  identifier, `[a-z][a-z0-9_]{0,23}`, else `p1`, `p2`, …) wherever it appears in a request's path segments and query
  values (whole value, or inside a longer one when 3 or more characters), with no copy kept, so a run must pass it;
  `--param k=v` names a typed value and keeps it as the example; a query value of the start or an opened URL that a
  request also sent becomes a param. `--output` defaults to the largest answer among requests that use a param, else
  the largest; it must name a kept GET. The steps are kept only so `flow show` can list them; nothing runs them. The
  saved flow is checked with the same validation as a load before it's written. Cookies and credential headers are
  never kept (the request is marked `strippedAuth`). The known secrets are every value typed into a secret field
  anywhere in the session's recording, including steps outside the saved range and steps already dropped from it
  (up to 200 values); a request whose URL (path, query key or value) or kept header carries one is left out.
- **Storage.** `<data dir>/Flows/<site>/<name>.json`, where `<site>` is the start URL's base domain (`example.com`
  for `shop.example.com`, `example.co.uk` for `www.example.co.uk`, an IP or `localhost` as is) plus a non-default
  port. Folders are 0700 and must be real folders the user owns, files 0600, opened relative to the folder with
  `O_NOFOLLOW`, written to a temp file renamed over the old one, at most 4 MB. The file is `version: 1`:
  `name`, `description`, `site`, `origin`, `startUrl`, `hosts` (the origins the flow may contact), `createdAt`,
  `createdBy`, `params` (`{name, example, source}`, source `typed`, `given` or `query`), `output`, `verified` and
  `steps` (`{seq, command, url, ok, requests}`, each request `{id, method: "GET", url, headers, kind, expect}`, never a
  body). Loading fails with `code: "flow_invalid"` for an unknown field, another version, a site or name that doesn't
  match where the file sits, an `origin` that isn't the start URL's, an origin in `hosts` the URL rules don't allow, a
  request that isn't a GET, has a body or another field, or whose URL fails the parser, the rule or isn't on a listed
  origin, a header other than a CORS-safelisted `accept`, a param name, example or item field that isn't a short
  identifier or value, a description over 120 characters or with a line break, a step command that isn't a short list
  of words, or a missing output request.
- **`flow run <name> [--param k=v]… [--fields a,b.c] [--where f=v]… [--limit n] [--site s] [--timeout 60s]`.**
  Unknown params fail with the list of real ones; a param with no example must be given. Values are encoded for where
  they land, and the filled URL must still parse and sit on a listed origin (`off_site`). The request is sent with
  `fetch(url, {method: "GET", credentials: "include", cache: "no-store", redirect: "manual"})` with no header but the
  recorded `accept` (so no CORS preflight), once and never retried, from a tab the session opened itself (never the
  user's tab picked with `tab active`) when it is already on the request's or the start page's origin, else from a
  temporary background tab that loads the start URL the way `open` does (closed again afterwards); a start page that
  lands off the flow's origins (a sign-in page) is `redirected`. No body is ever sent and cookies stay in Ardia.
  There is no direct-HTTP tier (it would need the cookies through `Network.getCookies`, which the token policy
  refuses) and no command replay.
- **Outcomes.** One answer, checked once; every failure says to drive the page instead: a redirect is `redirected`
  (a flow never follows one), a 401 or 403 `auth_expired` (or `credential_not_sendable` for a request recorded with
  a stripped credential header), 429 `rate_limited` (`data.retryAfter`), a bot-check page `blocked`, another status
  `http_error`, a network or CORS failure `fetch_failed`, a page that navigated or closed while the GET was in flight
  `fetch_interrupted` (whether it reached the site is unknown), an answer over 8 MB `answer_too_large`. The answer is
  compared with the recorded shape: a missing key, a changed type, or the main list gone or no longer a list is
  `drifted` (a present, empty list isn't), and the file is marked `verified: false` (true again after a clean run).
- **Output.** The list at the path the recording saw, else the answer's heaviest list of objects (or the answer
  itself when it's a list), as `{list, total, matched, items}` after `--where` (case-insensitive contains, dotted
  paths, all must match), `--limit` and `--fields`; a field no item has fails with `unknown_field` and the items'
  fields, and a list that is now empty gives zero items. An answer with no list comes back as `value`. Text output is
  a header (`✓ search: 2 of 3 items in results`) and one JSON line per item; `data` has `verified` and `result`.
- **Discovery.** When `open` lands on a site, or `snapshot` runs on it, with saved flows, the answer starts with
  `# saved flows for <site> (…): name(params) [saved description: "…"]; …` (up to five, the description quoted and
  cut at 80 characters, since a page could have shaped it), once per site per session (a session that saved a flow
  there doesn't get it). It follows the site's notes; `snapshot --json` has it in `data.flows`. `flow list` and
  `flow show` count as page content too (`--content-boundaries`).
- **`flow list [site]`, `flow show <name> [--site s]`, `flow rm <name> [--site s]`** run without the browser; a name
  saved for several sites needs `--site`.

### Commands that need Ardia 0.2.49 or later

From Ardia 0.2.49 the engine's token connection is a full DevTools client of the browser (ardia-browser/ardia #3674),
so the commands below work as they do against a plain `--port` DevTools server. An older Ardia's token policy
(`ac_cli_token_policy_methods.cc`) refuses the methods they need, so there they fail with exit 1, naming the method and
the command (`code: "policy_refused"`, `data.method`, `data.reason` empty, or `with those editing commands` for
`clipboard copy|paste`). Both daemons say the command needs Ardia 0.2.49 or later, to update Ardia and run it again,
and what to do until then (ask the user to attach or download the file, `screenshot` for `record`, `storage` or `eval`
for cookies, `set viewport` for `set device`, …; `NOT_YET` and `FULL_CONTROL_ARDIA` in `daemon-errors.ts` and
`browse/errors.py`). The refusal itself is the capability test: the command always tries the method, and only an
engine that refuses it gets the message, so nothing depends on the version string. A refusal of anything else, a
method no command here is known to need, says this Ardia doesn't allow it and that 0.2.49 or later allows every
method. A refusal with a reason (a tab the command didn't open, a URL, a target) also comes only from an older engine,
and says 0.2.49 or later has no such limit. Nothing in the command
changes. `set viewport` isn't one of them: the policy allows `Emulation.setDeviceMetricsOverride` with a width,
height, scale and mobile on a tab the session opened and took off-screen.

| Command | Needs |
| --- | --- |
| `cookies get\|set\|clear`, `cookies set --curl` | `Network.getCookies`, `Network.setCookie`, `Network.clearBrowserCookies` |
| `state save`, `state load` of a file with cookies | `Network.getAllCookies`, `Network.setCookies` |
| `set device\|geo\|media` | `Emulation.setTouchEmulationEnabled`, `Emulation.setUserAgentOverride`, `Emulation.setGeolocationOverride`, `Emulation.setEmulatedMedia` |
| `set offline`, `set headers` | `Network.emulateNetworkConditions`, `Network.setExtraHTTPHeaders` |
| `set credentials`, `network route` | `Fetch.enable` (and `Fetch.fulfillRequest`, `failRequest`, `continueRequest`) |
| `upload` | `DOM.setFileInputFiles` (the paths are resolved against the current directory and must be files) |
| `download <sel> <path>`, `wait --download [path]` | `Browser.setDownloadBehavior` with `allowAndName` into the destination's folder and `eventsEnabled`, then `default` again (`wait --download` waits for the next download that starts after it; `download` clicks and saves) |
| `highlight` | `Overlay.enable`, `Overlay.highlightNode` |
| `clipboard copy\|paste` | `Input.dispatchKeyEvent` with the `copy`/`paste` editing commands |
| `clipboard read\|write` | `Browser.grantPermissions` (Python), `Browser.setPermission` (TypeScript), so `data.method` differs |
| `set permission` (TypeScript) | `Browser.setPermission` |
| `trace start`, `profiler start` | `Tracing.start` (`Tracing.end` only ends a recording that started) |
| `record start\|restart` | `Page.startScreencast` (and ffmpeg on PATH for the WebM) |
| `stream enable` | `Page.startScreencast` |
| `cdp <method>` | the method itself |

### Raw CDP

`ardia browse cdp <Domain.method> [--params <json>|-] [--param k=v]… [--param k:=json]… [--target browser|<tab>]
[--timeout 30s]` (above 0 and up to 10m, checked before the daemon starts) sends one DevTools method and prints its result as JSON (`--json`: `{method, target, result}` in
`data`), or `✓ <method>` for an empty result. It goes to the session's tab, to the tab `--target` names (`t1`,
`tab-…`, a label or a targetId, as `tab` takes them; attached without becoming the session's tab, and held for the
call as a tab in use: `tab list` shows the session under `usedBy`, and the owner's `tab close` says `tab_in_use` until
the call ends), or with
`--target browser` to the browser connection itself (`Browser.*`, `Target.*`, `Storage.*`, `SystemInfo.*`). Params
work as in `ardia call`, with `--param` for `-p` (agent-browser's `-p` is its provider flag), and are checked the same
way before the daemon starts; `--params -` reads stdin, up to 1 MB in bytes, and the encoded params are at most 1 MB.
A bad param is a usage error, exit 1 as for every browse command. On your tab the session picked with `tab active`
(a borrowed tab, where `reload`, `back`, `storage` and the like refuse too), a raw call without `--target` is refused
(`code: "borrowed_tab"`, saying the `--target <tab>` that sends it anyway): raw calls can navigate or change anything,
so they go to a borrowed tab only when you name it. Every call counts as a mutation, so a timeout or a dropped
connection reports the outcome as unknown and a `batch` stops there.

Raw calls run on a DevTools session of their own (`browse/rawcdp.py`), never on the one the daemon drives the tab
with: for a tab, a flattened `Target.attachToTarget` session the daemon keeps per tab; for `--target browser`, a
`Target.attachToBrowserTarget` session. So domain state such as `cdp Runtime.disable` or `Network.disable` reaches
only that raw session, and `console`, `network`, snapshots and the rest keep working as the daemon set them up. Some
methods change the page itself rather than the session: an `Emulation.set…` override such as
`Emulation.setDeviceMetricsOverride` applies to the tab, so screenshots and other browse commands see it too.
What persists: domains enabled and settings made through `cdp` stay on that raw session for as long as the daemon
keeps its DevTools connection, which it drops after 30 s with nothing to do (an open `console` or `network` capture
keeps it). The next `cdp` call then attaches a fresh raw session, so those enables and settings are off again. To
tell, `--json` gives `data.session`: `attached` (a new raw session, the first on this tab), `kept` (the same one as
the last call), `reattached` (a fresh one replacing an earlier raw session, after a reconnect or after Ardia detached
it; text mode also prints a `→ …off again` notice on stderr), or `shared` (an engine that refuses
`attachToBrowserTarget`: browser calls then go on the daemon's own browser connection, as before). Effects outside
the session itself, such as a navigation, a cookie or a download setting, aren't undone by a reconnect. Events
aren't printed. A
method name that isn't `Domain.method` is a usage error. Its result is page content (`--content-boundaries` wraps it).
Text mode prints the whole result, as `--json` does: it skips the output cap (`--max-output` doesn't cut it), because
part of a JSON value is no use, and failing instead would come after a call that may have changed something, inviting
a retry that repeats it. Ask for less with params when a result would be large. An answer over the daemon's 256 MiB
(`MAX_RESPONSE`, measured once the result is JSON-escaped and wrapped in the answer) fails with exit 1 and
`code: "result_too_large"`, saying the call did run and how to ask for less; a single DevTools message over 256 MiB
still ends the connection (`connection_lost`), as for every command. Telemetry: the browse command event's `subcommand` `cdp`, with `error_code`
`policy_refused` from an older engine.

WebUI pages are tabs too: `tab list`, `tab <id>` and `open` take `chrome://`, `chrome-extension://`,
`chrome-untrusted://` and `devtools://` pages (`PAGE_SCHEMES` in `state.py`), which an older engine refuses to attach
to (`to that target`).

The command leaves `Cookie`, `Cookie2`, `Set-Cookie`, `Set-Cookie2`, `Authorization` and `Proxy-Authorization` out of every request it records
(`clip_headers` / `clipHeaders`, `CREDENTIAL_HEADERS`), so `network requests`, `network request <id>` and HAR files
never contain them, on any engine and over `--port` too. An older engine also stripped them from its events; from
0.2.49 the engine passes events through unchanged, so the command does it.

The policy also refuses some uses of methods it allows (`ac_cli_token_policy.cc`), and says which in its reply:
`ardia: <method> <reason> isn't allowed for the ardia command`. The command keeps that reason (`data.reason`, same
`code`) and words the error around it, so it never reads as a method that is off the list:

| Reason | Methods | Means |
| --- | --- | --- |
| `to that target`, `on that target` | `Target.attachToTarget`, `activateTarget`, `closeTarget`, `getTargetInfo` | The tab is gone, isn't a web page (an Ardia or extension page), or sits in a window Ardia keeps for itself |
| `without flatten` | `Target.attachToTarget`, `setAutoAttach` | The command always sends `flatten`, so this is a bug in it |
| `to that URL`, `in another browser context` | `Target.createTarget`, `Page.navigate` | Only http, https, data and about:blank pages, in the user's own profile |
| `in that execution context`, `on that object` | `Runtime.*`, `DOM.*` | A context or object the connection didn't make |
| `on a tab the ardia command didn't open`, `on a tab that isn't off-screen`, `with that option` | `Emulation.setDeviceMetricsOverride`, `clearDeviceMetricsOverride` | The viewport override is for tabs the command opened (below), with a width, height, scale and `mobile` only |
| `in a named world`, `as a stream`, `with the command line API`, `without a button`, `with those editing commands` | `Page.addScriptToEvaluateOnNewDocument`, `Page.printToPDF`, `Runtime.evaluate`, `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent` | That option isn't allowed |

`set viewport <w> <h> [scale]` works on the token path only in a window the user never sees. An emulated page is
never in a user's window, so nothing has to be restored in place or held off the screen (five reviews found each
version of that unsound: e7f251520 and the commits before it).

- **The automation window.** One per profile, made on first use (`OffscreenWindowFor`, `ArdiaHost.mm`): an
  `ArdiaCoreWindow` that is `internal` (never ordered on screen, hidden from extensions, not in `ardia windows`) and
  `automation`, 1280×800. The token policy treats a tab in an internal window as not a web target; the automation
  window is the exception (`IsPrivilegedContents`), and only tabs the command created ever get into it.
- **Going off-screen.** `set viewport` first asks the app, over the control socket, to take the session's tab there
  (`offscreen` `{tab}`, `state/automation/offscreen.ts`). It is refused unless the tab is one a token connection
  created (`ac_cli_owns_tab`), has never been in a shown slot (the shown-slot report, kept as this check), and isn't
  shown, warm or being revealed now. The page's view lets go of the tab (`releasePageForOffscreen`), the window
  adopts the same `WebContents` (`adoptTab:`, no reload), and the store drops the row with no closed-tab record
  (`removeTabs(…, false)`): the tab has no sidebar row while it is off-screen. `ardia browse tab list` still lists it
  for its session.
- **The policy.** `Emulation.setDeviceMetricsOverride` and `clearDeviceMetricsOverride` are allowed only on a session
  attached to a tab the command created that is in the automation window now and was never in a shown slot
  (`CliEmulationRefusal`; otherwise `on a tab the ardia command didn't open` or `on a tab that isn't off-screen`),
  with `width`, `height`, `deviceScaleFactor` and `mobile` only (`with that option`). A tab never leaves the
  automation window: `canAdoptTab:` refuses to move one out.
- **Showing it.** `tab <id> --show`, `open --show` and `set viewport reset` don't move the page back. The command
  opens a new tab of its own at the same address in the user's window, in the background, waits for it to load,
  closes the off-screen one, and only then shows the new one (not for `reset`). The output says the page was reloaded
  in a new tab; form state, scroll position and `sessionStorage` are gone. The first frame a user's window gets is
  from a page that never had an override.
- **Ending.** `close` and `tab close` close the off-screen tab like any tab the session opened. A session keeps
  every tab it took off-screen (`State.offscreen`), and the engine is the authority for the rest: on the token path
  `Target.getTargets` and `Target.getTargetInfo` mark a target in an automation window `"ardiaOffscreen": true`, so
  `--show`, `reset` and `set viewport` from a session that didn't move it (another session, or the same session's new
  daemon) take the off-screen path too. Each tab the command created has an owner in the engine
  (`ac_cli_owned_tabs.cc`): the token connection that created it, then whichever one last set its viewport
  (`ClaimCliOwnedTarget`, on `setDeviceMetricsOverride` only). When a connection goes (the daemon died, Stop,
  control turned off), every tab it owned is checked 5 s later and closed if it is still in an automation window and
  no connection has claimed it since, whatever other connections are open (`ReleaseCliOwnedTargets`); each change
  of owner bumps the tab's generation, so an older release's check does nothing and a later owner gets its own 5 s.
  The `offscreen` lease keeps a daemon connected while any of its tabs is off-screen; `State.set_offscreen` derives
  it from the set, so a reset of another tab or a close (the session's own or anyone's) can't leave it wrong. The app's sweep stays as a backstop for a tab
  moved off-screen whose viewport was never set: 5 s after the last connection goes it closes every tab in the
  automation windows (`noteCliConnections`, `cliCloseOffscreenTabs`). Off-screen tabs aren't in the store, so
  `session.json` never has them, and Chrome's restore list never gets one either: `LiveTabSkipsRestore`
  (`g_ardia_live_tab_skips_restore`, `ac_seams.mm`) answers yes for a tab in an automation window, so neither a
  closed tab nor the window snapshot a quit takes (`TabRestoreService::BrowserClosing`) records it, and an
  automation window with no other tab records no window. A crashed page stays off-screen with no row; `reload`
  brings it back there.
- `set device` still fails, before changing anything, on `Emulation.setTouchEmulationEnabled`. A session on a plain
  `--port` server sets the override where the tab is, as before. Telemetry: `viewport_set` on the command event;
  watch `error_code` `viewport_needs_hidden_tab` and `viewport_unsupported` on `set`.

A refused `Target.attachToTarget` also says what Ardia's own tab list has for that page (`ardia windows`): the tab and
its address, or that no tab holds it. The command used to print the off-the-list sentence for every refusal, which hid
the reason.

### Skipped

`connect` and `inspect` (the endpoint is Ardia's; opening DevTools on the user's tab isn't something the command
does), `install`, `upgrade`, `doctor`, `dashboard`, `mcp`, `chat` (Ardia has no AI features), `profiles` (it never
reads browser profiles), `confirm`/`deny` and `--action-policy`/`--confirm-actions`, iOS and Safari (`-p ios`,
`--device`, `swipe`, `tap`), cloud providers (`-p`, `--provider`), and launch options that only mean something when
agent-browser starts its own browser (`--headed`, `--profile`, `--executable-path`, `--extension`, `--args`,
`--user-agent`, `--proxy`, `--proxy-bypass`, `--ignore-https-errors`, `--ca-cert`, `--allow-file-access`,
`--hide-scrollbars`, `--webgpu`, `--engine`, `--restore*`, `--state`, `--auto-connect`, `--allowed-domains`); these
fail with a message saying so. `--headers`, `--color-scheme` and `--download-path` are launch-time too: they point at
`set headers`, `set media` and `download <sel> <path>`. Config files (`~/.agent-browser/config.json`, `./agent-browser.json`) and
`AGENT_BROWSER_PLUGINS` are never read. `read <url>` fetches with Python's `urllib`, so it never touches Ardia.

When the reader of its output goes away early (`ardia browse snapshot -i | head`), it stops writing and exits 141, as a
program killed by SIGPIPE would, without a traceback.

### Captures and bounds

Console messages (1,000 and 16 MB), errors (500 and 16 MB) and network requests (1,000 and 32 MB per tab) are ring
buffers that count what they drop; each record's text is cut at 64 KB, header values at 8 KB and a record's headers at
64 KB. Response bodies are capped at 1 MB for `network request`, 2 MB each and 64 MB in all for a HAR, trace events at
2 million, a request to the daemon at 16 MB and its answer at 256 MB. `network requests` and `har` start capturing
at their first use (`Network.enable`).

`stream enable [--port N] [--input]` (once allowed) binds 127.0.0.1 only, with its own random token in the URL (never
the CDP token), checks `Host` and `Origin` exactly (localhost or 127.0.0.1 on its port, or no Origin; `null` is refused), takes at most
4 clients, and is view-only unless `--input`. Messages follow agent-browser's (`status`, `frame` with `seq` and
`metadata`, `input_mouse`, `input_keyboard`, `input_touch`).

### Auth vault and plugins

`auth save <name> --url <https url> [--origin <url>]... --username <u> [--password-stdin]` takes the password on
stdin or from a no-echo prompt; `--password` is refused. It talks to Keychain only through `/usr/bin/security -i`
with the command written to its stdin, so `ps` never shows the secret, and captures its output privately (non-ASCII
passwords come back hex-encoded, which the metadata records). The item is a generic password, service
`dev.ardia.browse.auth`, account `<name>`, in the login Keychain. Non-secret metadata (url, origins, username,
selectors) is `Browse/auth/<name>.json`, 0600. Each credential is bound to https origins (http only for localhost).
`auth login` checks the tab's committed top-level origin and the field's frame origin against them before typing,
types per character, and stops if the page navigates, the frame's loader or origin changes, or focus leaves the
field. The check runs after each `DOM.focus` has returned (so a page's focus handler has already run) and right
before that character's key events; for a field in an iframe it also checks the top document's focus is on that
frame. `tests/fixtures/browse/auth.html#steal` moves focus into a cross-origin iframe on focus; the end-to-end test
checks no character reaches it. Any process running as the user can read items `/usr/bin/security` created (Keychain lets that tool read its
own items without a prompt), the same boundary as `ArdiaControl.json`. `ARDIA_BROWSE_KEYCHAIN` points it at another
keychain file, for tests.

`plugin add <npm-name[@version] | owner/repo[#ref]>` pins the exact version (`npm view`) or commit (`git ls-remote`),
installs it with `npm install --ignore-scripts` into `Browse/plugins/<name>/`, and records it in
`Browse/plugins/registry.json`. Plugins run only through `plugin run` or `auth login --credential-provider`, over
agent-browser's `agent-browser.plugin.v1` protocol (one JSON request on stdin: `protocol`, `capability`, `type`,
`request`; one reply on stdout: `protocol`, `success`, `data` or `error`), with `ARDIA_*` and `AGENT_BROWSER_*` removed
from their environment and a 60 s limit.

### Plugin mode

The app's AI plugin runs `ardia browse --session plugin-<name> <step>` with `ARDIA_BROWSE_FOR_PLUGIN=1`. The contract
it relies on is `tests/parity/cases/ai-plugin-contract.json` (one case per item); the credential handoff is ardia#2808's
`docs/cli.md` › Plugin credentials.

**Plugin mode never reaches the Python daemon.** ardia#2808 removes `Runtime` from plugin credentials (no `evaluate`,
no `callFunctionOn`, no isolated worlds), and the Python daemon reads and acts on pages through page script, so plugin
steps are served by a TypeScript plugin daemon (F1-early, on M3's D1 and D2) that uses DOM, AX and Input only. Until it
lands, a plugin step that passes every check below answers status 77 and code `plugin_daemon_unavailable` ("has no
plugin daemon yet…"), and nothing is sent anywhere: no daemon is started or contacted and the token server never hears
from it. `browse` help and `browse --version` are still answered by the client; `ardia --version` and every other non-browse call answer 77 `plugin_refused`. The Python daemon has no plugin mode; the Python
client's plugin mode (`plugin_access.py`) stays only as the parity reference for the refusals. The cases that expected
a daemon's plugin answers are kept for F1-early in `tests/parity/pending/f1-early.json` (outside the parity table);
their places in the table now expect `plugin_daemon_unavailable`.

#### What the client checks today

- The credential comes only on the inherited descriptor `ARDIA_PLUGIN_CREDENTIAL_FD` names (the app uses 4): read to EOF,
  at most 256 bytes, exactly `p.` and 43 base64url characters, then closed before anything else happens. The token
  server is `ARDIA_PLUGIN_ENDPOINT` (`ws://127.0.0.1:<port>/devtools/browser/<id>`; empty means control is off). The
  credential is never in argv, the environment, a file or a log, and `ArdiaControl.json` is never read.
- Refused with status 77 and one line (JSON with code `plugin_refused` under `--json`), before anything is sent:
  `ARDIA_BROWSE_FOR_PLUGIN` other than `1`; a missing, non-numeric, closed, terminal or unreadable descriptor; anything
  but a well-formed credential (a trailing newline included); no read within 2 s (Ctrl-C ends the wait with status
  130 and `interrupted`); a missing or empty endpoint, or one whose host isn't exactly `127.0.0.1` or whose port isn't
  1 to 65535 without a leading zero; `--ws`, `--port`, `--cdp`, `ARDIA_WS`, `ARDIA_PORT`, `ARDIA_CDP_URL` or
  `AGENT_BROWSER_CDP`; a session flag after the command (`--session --namespace --data-dir --port --ws --cdp
  --screenshot-* --idle-timeout --init-script --enable --headers --color-scheme --download-path --annotate
  --no-auto-dialog --pin-tab --no-pin-tab --debug --capture-console --show --content-boundaries --out --stdin`); global
  options the client can't read (a value flag with no value, a launch option); and `auth`, `notes`, `flow`, `plugin`,
  `read`, `session`, `script`, `cdp`, `clipboard` and `close --all`. The router sends a plugin's browse call only to the
  TypeScript client and refuses (77) rather than hand it to Python.
- **Commands and flags are an allowlist**, exactly the AI plugin contract's §1 list minus what needs page script:
  `snapshot` (`-i -c -d -s -u --diff`; the AI sends `snapshot -c`), `get` (`text html value attr title url count box`),
  `click` (`--button --no-humanize`), `fill`, `press`/`key` (`--no-humanize`), `type` (`--delay --no-humanize`),
  `scroll` (`-s --no-humanize`), `wait` (`-t -u -l --state --timeout`), `find` (`--name --exact --partial
  --no-humanize`), `is`, and `tab` as the pick (`tab <id>`) or the list. `snapshot --cursor` and `get styles` read
  computed styles, so they are refused. Nothing allowed names a local path. The guard reads each argv with the daemon's
  own grammar (`plugin-grammar.ts`: the flags and aliases each command function in `commands.py` passes to `parse()`,
  and a port of `parse()` itself, where a value flag takes the next token even when it is `--` and a negative number
  is `-` and any Unicode decimal digit), and fails closed: an argv it can't read exactly is refused with 77.
  `tests/plugin_grammar.py` reads that grammar from the real functions, and `plugin-grammar.test.ts` checks the table
  and runs every case's argv through both parsers.
- **Global options are an allowlist too:** `--session`, `--json`, `--expect-loader`, `--max-output`,
  `--humanize`/`--no-humanize`, `--full`, `--no-changes` and `--no-text`, after `browse`; before it, only `--json`.
  The plugin checks run before any ordinary parsing, so anything else, before `browse` or after it, unreadable or not
  allowed, is refused with 77 `plugin_refused`, never a usage error. `--timeout` is not a browse option in either
  place (Python says so too). The data folder comes only from the environment Ardia starts the plugin with.
- **Plugin mode runs only `ardia browse`.** The router sends every call with `ARDIA_BROWSE_FOR_PLUGIN` set to the
  TypeScript client, browse or not, and the client refuses (77) whatever isn't a readable browse call (`tabs`,
  `--session x browse …`), so nothing in plugin mode reaches Python. A refusal before `browse` is named records no usage
  entry, as Python's own error there doesn't.
- **Every refusal keeps its JSON envelope.** Plugin mode reads `--json` with the option-aware parse when the options can
  be read; when they can't (an option before `browse`, an unreadable one after it), any `--json` token before `--` counts
  (the last one wins), so the refusal is one JSON line on stdout. A refusal prints once and writes nothing afterwards.
- Commands that run other commands answer code `nested_commands_refused` (77): `batch` and `open`/`goto`/`navigate
  --read`.
- On Linux plugin mode reads the locale like macOS, except that it treats a UTF-8 locale name as installed: glibc keeps
  locales in one archive the client can't check cheaply, and the app always sets an installed `en_US.UTF-8`.
- **Plugin mode records no CLI telemetry and no usage at all**, whatever the environment or argv: it never reads the
  consent file, never writes the spool or the usage history, never starts a flusher and touches no telemetry file, even
  for a refused `--data-dir`. The AI app sets `ARDIA_TELEMETRY=0` and counts plugin activity in its own plugin telemetry.
  `cli_command` has no `plugin_mode` field. The parity harness applies this to every plugin case: the TypeScript side
  is expected to leave no usage entry or telemetry file where Python's plugin client does.

#### What F1-early's daemon must do (the spec)

- **The session:** the daemon gets `<endpoint>?token=<credential>` on its stdin config and connects with no `Origin`
  header. Its session key ends in `\0plugin` and its endpoint part is `plugin:` and a SHA-256 prefix of the credential,
  so a plugin never shares a daemon with the person's session of the same name, with an older CLI, or with another
  activity.
- **Exactly the commands and flags above**, served from plain data (the AI plugin thread's mapping):

  | command | served from |
  |---|---|
  | `tab <id>`, the pick | Target, scoped to the credential; `tab --json` carries `data.loader` |
  | `snapshot -c` | the AX tree; `--urls` from `DOM.getAttributes` |
  | `get` | the AX name or value, or `DOM.getOuterHTML` parsed in the daemon |
  | `click` | `DOM.scrollIntoViewIfNeeded`, `DOM.getContentQuads`, then a mouse event |
  | `fill` | `DOM.focus`, the `selectAll` and `deleteBackward` key commands, then `Input.insertText` |
  | `type`, `press` | Input |
  | `scroll` | `mouseWheel` |
  | `is` | `DOM.getBoxModel` and the AX tree |
  | `wait` | AX polling, target info, lifecycle events and `DOM.getBoxModel` |
  | `find` | an AX search |
  | dialogs | `Page.handleJavaScriptDialog` |

- **`find --name` and `wait --text` search the AX tree**, never the DOM: `DOM.performSearch` is off the engine's
  allowlist.
- **No input pipelining:** one `Input.dispatchMouseEvent`, `dispatchKeyEvent` or `insertText` at a time, each sent only
  after the previous one answered, humanized typing and `fill` included, so an engine refusal stops the step after the
  refused event with nothing queued behind it.
- **Plugins can't drag:** no `drag` command, and no mouse-down/move/up sequence that crosses elements.
- **Input the engine accepts from a plugin** (ardia#2808's plugin policy): `Input.dispatchKeyEvent` never carries
  `nativeVirtualKeyCode` or `isSystemKey`; its `commands` hold only `selectAll`; `moveToBeginningOfLine`,
  `moveToEndOfLine`, `moveToBeginningOfDocument`, `moveToEndOfDocument`, `moveLeft`, `moveRight`, `moveUp`,
  `moveDown`, `moveWordLeft`, `moveWordRight`, each also with `AndModifySelection`; `deleteBackward`, `deleteForward`,
  `deleteWordBackward`, `deleteWordForward`; `insertNewline`; `insertTab`; never `copy`, `cut`, `paste` or
  `pasteAndMatchStyle`. `backendNodeId` stays usable; the engine accepts only ids from the session's own frame tree.
  The contract cases record each rule as `cdp_rules`.
- **The document check:** `--expect-loader <loaderId>` compares the main frame's loader before the step (mismatch:
  `document_changed`, nothing ran) and after it (mismatch: `document_changed_after`, the step ran). A step whose picked
  tab is gone answers `tab_gone`; there is no lost-tab recovery and no notes or saved-flow hints.
- **Engine refusals keep their codes:** an engine error whose own message starts `ardia: tab_out_of_scope` answers
  code `tab_out_of_scope`, and the act lease's `ardia: document_changed` answers `document_changed`; codes never come
  from page text.
- **A registry of its own:** a plugin session keeps its tab numbers in a registry keyed by its credential id and never
  touches the shared `Browse/` tab registry, the temporary-tab sweep, the `using` state or `tab list`'s view of other
  sessions. A credential's scoped target list can't tell another activity's tab from a closed one.
- **No local writes:** no output spill file for an answer over the cap, and nothing written under the person's data
  folder beyond the session's own socket, lock and log.
- **Every rule on every step** it runs, if it ever runs nested steps.

### Starting the TS daemon

M1's client starts no daemon in plugin mode and hands any other missing daemon to Python. When the switch to M3's
daemon happens, on top of D2 (plugins#20), the client starts daemons through D2's `browse/daemon/spawn.ts`, and these
are the exact changes:

- **Starting:** in the client's session open, after `openSession` answers `NoDaemon`, start one with
  `awaitDaemon(dir.fd, key, spawnDaemon(dir.fd, key, config, choice), connect)`, where `choice` is
  `chooseDaemon(python)` and `config` is the daemon's stdin config, which the client builds as Python's client does.
  If `chooseDaemon` answers `null` (no bundled Python and no TS daemon), the client answers `daemon_unreachable`.
  `connect` is `() => openSession(root, key, deadline).catch((error) => error instanceof NoDaemon ? null : Promise.reject(error))`:
  `null` means "not listening yet", and any other error stops the wait.
- **Failure:** `DaemonDidNotStart` maps to the unreachable error (`unreachable(error.message)`, exit 2, code
  `daemon_unreachable`), with D2's own message ("exited before it listened: <log tail>" or "didn't start in 15 s").
- **One stat call:** D2's `statAt` (mode, owner, device, inode and mtime, links not followed, one plain name) replaces
  this PR's `socketInfoAt`. `checkSocket` reads `mode` and `uid` from it, and the addon drops the `socketInfoAt` export.
  `stat_at` takes over `socket_info_at`'s refusal of a negative descriptor (`AT_FDCWD`, `-1`) with `EBADF`, and the
  `native-arity` test moves to `statAt`.
- **Plugin mode** still starts nothing until F1-early. Then `choice` is the TS plugin daemon, and the same
  `awaitDaemon` call starts it, with no flusher and no other child.
- Until then, the client hands a missing daemon to Python exactly as today.

### JSON error codes

Under `--json` the TypeScript client prints every browse error as one JSON line with a `code` (the AI plugin contract;
text mode is unchanged). A code the daemon or Python gives is kept (`document_changed`, `tab_gone`, `tab_not_found`,
`unknown_ref`, `connection_lost`, `outcome_unknown`, `timeout`, `tab_in_use`, `session_busy`, `policy_refused`, …). Where
Python has none:

| code | when |
|---|---|
| `usage_error` | an option or flag the client can't read (`--max-output lots`, a value flag with no value) |
| `invalid_name` | a session name or namespace that isn't 1 to 64 letters, digits, `.`, `_` or `-` |
| `unsafe_path` | the data dir or its `Browse` folder is missing, a link, another user's or not private |
| `socket_refused` | the session socket isn't a socket of yours with mode 0600, or another user serves it |
| `daemon_unreachable` | the daemon closed the connection, didn't take the command, or didn't start |
| `daemon_timeout` | the daemon didn't answer a read in time (a mutating step answers `outcome_unknown`) |
| `answer_too_large` | the daemon's answer was over 256 MB |
| `unknown_command` | the daemon's `Unknown command: …` |
| `command_failed` | any other daemon error line without a code |
| `plugin_refused` | a plugin-mode refusal (status 77) |
| `interrupted` | Ctrl-C while the client waited: on stdin, the credential, the connection or the answer (status 130) |
| `internal_error` | the client crashed as Python's would, for instance on a reply that isn't JSON or isn't an object; `error` holds Python's crash line (status 1). If stdout itself failed, the crash line stays on stderr. Also a failing answer (nonzero exit) whose output isn't one JSON value: plain text (the text is the message), a `✗` line on stderr (its text, moved off stderr), nothing at all, or an error object whose `code` is null or not text. Any other JSON value (a number, a string, an object that isn't `success: false`) becomes one error object with its text as `error`. A list is kept only from `batch`, where each failed row without a code, the joined `close` row included, gets `code: "internal_error"`; any other command's list is wrapped like other JSON |
| `tab_out_of_scope` | (F1-early's daemon) the engine's `ardia: tab_out_of_scope` refusal: the tab moved to another window or profile mid-step |
| `plugin_daemon_unavailable` | plugin mode with a step that passed every check: its daemon (F1-early) isn't there yet, so nothing is sent (status 77) |
| `nested_commands_refused` | plugin mode and a command that runs other commands (`batch`, `open --read`; status 77) |

The Rust router's own plugin refusals (no TypeScript client, it didn't start, or it asked for Python) follow the same
rule: one JSON line with `plugin_refused` on stdout under `--json` or `AGENT_BROWSER_JSON`, `✗ …` on stderr otherwise.

Telemetry's `error_code` stays Python's. Each such case in the parity table is marked `intentional`, holds the output
the TypeScript client must print instead of Python's, and is counted apart in the report.

### Testing it

`python -m unittest discover -s plugins/cli/tests` runs the unit tests (`test_browse.py`). The end-to-end test needs a
built app (never `/Applications`):

```sh
ARDIA_BROWSE_E2E_APP=<build>/Ardia.app python -m unittest plugins/cli/tests/test_browse_e2e.py
```

`test_browse_full_control.py` drives `upload`, `download`, `wait --download`, `cdp` and a `chrome://` tab against a
plain DevTools server: a headless Chromium it starts on a throwaway profile, named by `ARDIA_BROWSE_CHROMIUM`
(`ARDIA_BROWSE_CHROMIUM=/Applications/Helium.app/Contents/MacOS/Helium`, or any Chrome); without it that class is
skipped.

`ARDIA_TEST_STDIN_READY_FD=<n>` (tests only) makes the TypeScript client write one byte, `r`, to inherited descriptor
`n` and close it once it has checked the session's daemon and is about to read stdin, so a process test can act at
that moment instead of sleeping. Nothing else reads it.

A Debug build takes its JavaScript from Metro, and the token instance has no DevTools port to find it by, so name it:
`ARDIA_BROWSE_E2E_JS=localhost:8081`. Without it that instance never turns control on and `BrowseTokenPath` times out
waiting for `ArdiaControl.json`.

`plugins/cli/scripts/token-smoke.sh <Ardia.app> <ardia command> [metro host:port]` is the short version: one hidden
instance on the token connection, then `read <url>`, `open <url>`, `read` and a refused `cookies`. The release smoke
test runs it with the release's own CLI tarball against the release candidate, since nothing else runs the command
against a real token connection.

`ARDIA_BROWSE_E2E_ENGINE=full` (Ardia 0.2.49 or later) or `legacy` (0.2.48 and earlier) makes the refusal test require
that engine's behaviour; unset, it accepts either. It serves `tests/fixtures/browse` on 127.0.0.1, launches one hidden instance with a DevTools port (`ac launch
--no-wait`) and one on the token path (`open -g -n`, `ARDIA_BACKGROUND=1`, control on in `session.json`), both under
`~/ardia-scratch/browse-impl/e2e` (`ARDIA_BROWSE_E2E_DIR`), runs the core loop, the probe (humanized with
`--humanize`), instant input by default, the hidden-tab refusal, refs across an idle disconnect, `fill` on every typed
input and the snapshot of them (`form.html`), the changes report with a dialog and a POST that carries a token in its
query (`form.html`; the fixture server answers 501), `snapshot --diff`, auto-attach on both paths, site notes, the
output cap (`many.html`), five form fills in one `batch` from stdin, the gated errors and a service worker starting
mid-session, then closes its sessions and quits both. `tests/test_browse_changes.py` covers the same pieces as unit
tests (formats, the report and its folding, URL cleaning, the network watch and its bound, the cap, batch comments,
auto-attach choices, notes storage).
The a11y command needs `ardia_cli/vendor/axe.min.js`: `build.sh` adds axe-core 4.10.3 (pinned by sha256 and npm's
sha512); from the repo it falls back to `node_modules/axe-core` in a parent folder.

## Browsing data

For daily reports, `ardia pinned` and `ardia history` read files in Ardia's data dir (`ardia_cli/browsing.py`,
`browsing_cli.py`), each with one 20 s deadline from the start (the session read, the snapshot, every SQLite connection
through a progress handler that aborts past it, row fetching capped at 200,000); the worker deletes its temp snapshot
in its own `finally`, and at exit a hook sets a closing flag first (workers check it before making a temp folder and
at every backup or copy step), waits up to 1 s for live workers, then deletes any temp folder still registered. The
data dir is `--data-dir`, else `$ARDIA_DATA_DIR`, else the installed app's. Both run the same `ArdiaControl.json`
checks as the token path first (regular file, owned, 0600, live pid), so they work only while Ardia runs with control
on (exit 2 otherwise). Neither reads cookies, passwords, Login Data or Web Data. Text output is one line per row;
`--json` prints the rows.

- `ardia pinned` reads `<data dir>/session.json` (the app's persisted state, `apps/browser/src/state/session/persist.ts`;
  version 2 or later) and, on Linux, `<data dir>/<app profile>/Ardia/linux-session.json` (see Linux) and lists one
  row per pin: `title` (custom title first), `url` (else the pinned URL), `pinned_url`, `kind` (`favorite` for a
  Top Apps tile, `pinned` for a pinned row or a tab in a pinned folder), `folder` (the pinned folder, the innermost
  one when they nest, or the tile's folder), `profile` (its name) and `parked` (pins of a profile no window shows,
  from `parkedPins`). It takes each tab's `pin` (`{"as": "tile" | "row", "folder"?}`), or the older `pinned`,
  `pinnedAsRow` and `tileFolder` fields when a tab still has them. Rows follow `profileOrder`, then `windowOrder`,
  then each window's tab order. Pins mirrored across windows (one `pinKey`) count once. Incognito profiles, private
  and small windows are skipped. A missing file gives no rows; a symlink, a file that isn't regular, one past the
  size cap (256 MB for `session.json`, the host's 8 MB for `linux-session.json`) or invalid JSON is an error.
- `ardia history [--days N] [--limit N] [--profile P] [--domains]` (default 1 day, 200 rows, `--limit 0` for all) reads Chromium's `History` for each `Default` and
  `Profile <id>` folder under `<data dir>/Chromium/` (on Linux, the data dir itself) (never incognito, guest or system profiles; `--profile` must be a
  profile name or one of those folder names, never a path). Rows per URL, newest first: `url`, `title`, `visits` in
  the window, `total_visits`, `last_visit` (ISO 8601, local time), `profile`. Only http(s) pages; subframe
  navigations and hidden URLs are left out. `--domains` rolls rows up per domain (`domain`, `visits`, `pages`,
  `last_visit`, `top_title`, `profile`), most visited first. It never touches the live file for writing: it opens it
  read-only (`mode=ro`) and copies it with SQLite's backup API into a private temp dir; the progress callback ends
  the backup once 0.5 s have passed. Chromium keeps `History` exclusively locked while Ardia runs, so that usually
  fails, and it falls back to copying `History` plus its `-wal`/`-journal` (no symlinks, regular files only), checking
  the copy opens, up to 3 tries. A copy taken mid-write can miss the last few visits. The copy checks the deadline
  between 1 MB chunks.

## Userscripts

`ardia scripts` runs Violentmonkey-style userscripts written in TypeScript or JavaScript. A `.user.js` from
Violentmonkey or Tampermonkey works as is. Keys read from the `// ==UserScript==` block: `@name` (the id is its slug),
`@namespace`, `@version`, `@description`, `@match`/`@exclude-match` (Chrome match patterns for content scripts:
`*`, `http`, `https`, `file`, `ftp` schemes, checked when parsed the way `URLPattern::Parse` does, a bit stricter:
hosts canonicalized as the browser does: lowercase, IDN to punycode (refused when it has ß, ς or a joiner, which
IDNA versions treat differently), WHATWG IPv4 forms like `127.1` or `2130706433` to dotted, compressed IPv6, no `%`
anywhere (so no IPv6 scope ids); ports 0 to 65535 without leading zeros and none with scheme `*`),
`@include`/`@exclude` (globs over the whole URL with `base::MatchPattern`: `*` any run, `?` zero or one character,
`\` escapes, matched left to right without backtracking; regexes are refused),
`@run-at` (`document-start`, `document-end` default, `document-idle`), `@inject-into` (`page` default and `auto` run
in the page's world, `content` in an isolated world), `@noframes`. `@grant` other than `none`, `@require` and
`@resource` are ignored with a warning. `@match` and `@include` add up, as in Violentmonkey.

Builds go through esbuild: `--bundle --format=iife --platform=browser --target=chrome130 --tsconfig-raw={}`, not
minified, so relative imports bundle in and no `tsconfig.json` is read (no `paths` aliases). Types are stripped, not
checked. Every input esbuild reports in its metafile must be a `.ts .tsx .mts .cts .js .jsx .mjs .cjs .css` source
(JSON, text and other loader types are refused), a regular file with no other hard links, and inside the script's
own folder tree; nothing may come from Ardia's data dir (the `--data-dir`/`$ARDIA_DATA_DIR` one and the installed
app's), even inside the tree. Both are decided by file identity (`st_dev`, `st_ino` of each ancestor after
resolving symlinks), not by path spelling, since APFS is case-insensitive. A script directly in the home folder or
`/` may import nothing. Otherwise the build fails
before anything is injected or published, so a script can't bundle `ArdiaControl.json` or other files and send
them to a page. `data:` imports are allowed. The tarball ships esbuild in `libexec/esbuild` and an installed
CLI uses only that one; from the repo it falls back to
`node_modules/@esbuild/darwin-arm64/bin/esbuild` (`@esbuild/linux-x64` on Linux) in a parent folder of the package,
then `esbuild` on PATH. It never
looks in the cwd.

- `ardia scripts new NAME [--match PATTERN]…` writes `NAME.user.ts` in the cwd (default match
  `https://example.com/*`), never over an existing file.
- `ardia scripts test FILE [--url URL] [--expect JS] [--wait S] [--screenshot PATH] [--keep] [--json] [--data-dir DIR]
  [--port N] [--ws URL]` finds Ardia like `browse` (exit 2 when it can't), opens its own background target at `about:blank`,
  attaches a flat session, turns on Runtime and Page, registers the script with `Page.addScriptToEvaluateOnNewDocument`
  (no `worldName`: the token policy refuses named worlds), and only then navigates to `--url` (default: the first
  `@match` whose host has no wildcard, path up to its first `*`). The registered source is a wrapper around the
  build that applies the `@match`/`@include`/excludes rules, `@noframes` and `@run-at` like the extension would, and
  reports start/skip/done through `console.debug` with a random marker. Matching is a port of Chromium's
  `URLPattern::MatchesURL` (`extensions/common/url_pattern.cc`) and `base::MatchPattern` (`base/strings/pattern.cc`)
  in both the wrapper and Python: canonical hosts without trailing dots (`*.` takes subdomains, never of IP
  addresses), the effective port (`:443` matches `https://example.com/`; no port matches any), the path plus query
  unescaped by `UnescapeURLComponent`'s `NORMAL` rule, including its full list of characters left escaped (BiDi
  controls, spaces, default-ignorable and format characters, lock emoji) (`/café/*` matches `/caf%C3%A9`), with a
  raw fallback, and `/foo/*`
  matching `/foo`. `plugins/cli/tests` runs both against cases taken from `url_pattern_unittest.cc` and
  `pattern_unittest.cc`, and they agreed with a real Ardia on the glob and percent-encoding cases. Console output and uncaught exceptions count
  as the script's when a stack frame is the script's `sourceURL`; positions map back to the sources through esbuild's
  source map. Cross-origin iframes are reached by `Target.setAutoAttach` with `waitForDebuggerOnStart`, on the token
  path too: the token policy attaches a web frame while it waits to commit, so the script runs at its document start.
  Frames that show an extension's page (a password manager's inline menu, say), a `chrome://` or DevTools page are
  never attached over the token path; a frame that starts loading one cuts off the page's session, as Chrome does for
  `chrome.debugger`. The report says how many iframes never reported. After the top frame ran (or skipped) and the page loaded (at most 10 s
  more, 30 s in all), it listens `--wait` seconds (default 2; Chrome reports unhandled rejections about a second
  late), retrying `--expect` every 100 ms until `Boolean(value)` is true in the page (the report shows the value too). A
  first pass that starts and never finishes, in any frame, fails the test; when the top frame's doesn't finish in 30 s
  the test stops there. Then, in a bounded cleanup, it removes the registration and
  closes the target it made, unless `--keep`. `@inject-into content` is tested in the page's world, with a warning.
  Exit 0 ran without uncaught exceptions and `--expect` truthy, 1 otherwise, 2 Ardia unreachable.
- `ardia scripts install FILE [--data-dir DIR]`, `ardia scripts uninstall NAME [--data-dir DIR]` (by `@name` or id),
  `ardia scripts list [--json] [--data-dir DIR]`. Install and uninstall need control on (the `ArdiaControl.json`
  checks, else the exit-2 line); list doesn't.

### Install contract with the app

The data dir is `--data-dir`, else `$ARDIA_DATA_DIR`, else the installed app's (`~/Library/Application
Support/com.ardia.browser`; on Linux `${ARDIA_CONFIG_HOME:-${XDG_CONFIG_HOME:-~/.config}}/ardia`, see How it finds
Ardia).

1. The CLI takes an exclusive `flock` on `<data dir>/Scripts/.lock` (polled, 30 s deadline). The app takes a shared
   one while it reads and validates. `Scripts/`, `Scripts/scripts/`, record folders and `extension/` must be real
   folders the user owns: each is opened with `O_NOFOLLOW`, and everything below works relative to those folder
   descriptors (`renameatx_np` on macOS, `renameat2` on Linux, `openat`, `rmtree(dir_fd=)`), so a planted symlink is
   refused, not followed.
2. It keeps its record in `Scripts/scripts/<id>/`: `meta.json` (the parsed metadata, `id`, `world`, `source_file`,
   `installed_at`, `updated_at`), `script.js` (the build) and `source.<ext>` (a copy of the entry file). A new record
   is staged in a temp sibling and only swapped in after the extension built from it validated and was published; if
   that swap fails, the previous extension is swapped back.
3. It regenerates `Scripts/extension/` in a temp sibling: `manifest.json` with only `manifest_version` 3, `name`
   "Ardia Scripts", `version` (`1.<generation / 65536>.<generation % 65536>`), `description` and `content_scripts`;
   `js/<id>.js`; and `generation`. Each content script entry has exactly `matches`, `exclude_matches`,
   `include_globs`, `exclude_globs`, `js`, `run_at`, `all_frames` (false with `@noframes`) and `world` (`MAIN` or
   `ISOLATED`). The whole manifest is checked (keys, every pattern and glob, files, values) before it's published, so
   one bad script can't make the shared extension unloadable, along with the engine's limits: at most 256 content
   script entries, 256 files per entry, 512 distinct files, and a 256 KB manifest. A script with `@match` gets one entry; one with `@include` gets an entry with `matches` `*://*/*` and
   the globs, excluding its `@match` patterns so no page runs it twice. Entries follow install order. When
   `extension/` exists the new folder replaces it with `renameatx_np(RENAME_SWAP)` (`renameat2(RENAME_EXCHANGE)` on
   Linux) and the old one is deleted, so the
   path never goes missing; a plain rename only when there's none. With no scripts left, `extension/` is removed.
4. It writes `Scripts/generation` (temp file and rename): one more than the largest of `Scripts/generation`,
   `extension/generation` and the last reported one. A crashed run is repaired by the next install or
   uninstall (they rebuild from the records) or `list`: when its data dir was named (`--data-dir`,
   `$ARDIA_DATA_DIR`) or has a live control file, it takes the lock, rebuilds the extension from the records if
   they disagree (`manifest.json` entries, the `js/` files and their bytes), and otherwise publishes
   `Scripts/generation = extension/generation` when the extension is ahead, rebuilds when it is behind, and
   publishes the next generation when there are no records and no `extension/` but `status.json` still reports the
   current generation as loaded. Uninstalling the last script writes `Scripts/generation` before it removes
   `extension/`, so a crash between them looks like an old extension, not a finished uninstall. `list --json` puts
   any repair in its `repaired` key, never ahead of the JSON. `scripts test` never writes to any `Scripts/` folder,
   and nothing creates `Scripts/` under a data dir that wasn't named or live. `extension/generation` holds the same number. A bumped generation with
   no `extension/` means every script was uninstalled.
5. It drops the lock, then polls `Scripts/status.json` for up to 10 s: `{"generation": N, "profiles": {"<profile>":
   {"ok": true} | {"error": "…"} | {"disabled": true} | {"removed": true}}}`; `removed` means no scripts are left and the extension is gone from that profile. Exit 0 when every profile loaded or is turned off, 1 on any
   error, 3 when Ardia didn't report in 10 s (the outcome is unknown; it may still be loading), and 0 with "loads on
   its next launch" when Ardia quit or turned control off while it waited. A newer generation in `status.json` means
   another change replaced this one, and its result is printed.

## How it finds Ardia

1. `--ws URL`, a browser WebSocket URL.
2. `--port N`, a plain DevTools server on 127.0.0.1 (`/json/version`). For test servers only.
3. `$ARDIA_WS`, like `--ws`, then `$ARDIA_PORT`, like `--port`.
4. `$ARDIA_CDP_URL`, like `--ws`.
5. `<data dir>/Chromium/ArdiaControl.json`, with `--data-dir` or `$ARDIA_DATA_DIR`, else the installed app's
   `~/Library/Application Support/com.ardia.browser/Chromium/ArdiaControl.json`.
   On Linux the browser is Chromium itself and its user data dir is the data dir, so it's `<data dir>/ArdiaControl.json`
   and the installed app's is `${XDG_CONFIG_HOME:-~/.config}/ardia/ArdiaControl.json` (`$ARDIA_CONFIG_HOME/ardia` when
   that's set, as the engine does). The control socket is `<data dir>/ArdiaControl.sock` on both, checked with
   `LOCAL_PEERCRED` on macOS and `SO_PEERCRED` on Linux; its path may be 103 bytes on macOS and 107 on Linux.

The active-page route is `GET http://127.0.0.1:P/ardia/active?token=<token>`: `{"targetId": "<id>"}`, or `null` when
New Tab or an Ardia view is showing; anything else is a 404. The CLI calls it directly (no proxy, no Origin header)
with the token redacted like everywhere else, and falls back to the visibility check if it fails.

The app writes `ArdiaControl.json` when the setting is on:
`{"port":P,"browser":"/devtools/browser/<guid>","token":"…","pid":…,"generation":N}`. The CLI opens it without
following links and trusts it only when it's a regular file the user owns, mode 0600, and `pid` is alive. A `pid`
that `kill(pid, 0)` answers with EPERM counts as alive, since an agent sandbox (Codex, Seatbelt) can forbid signals to
Ardia: the CLI then checks `ArdiaControl.sock` (beside the control file on Linux, one folder up on macOS, the same
place the app announces callers on) without following links, and goes ahead only when it is a socket the user owns
and the process answering it runs as the user (peer credentials); otherwise it stops there, so a stale file with a
recycled pid never sends its token anywhere, and the line says why: no socket, nothing accepting, a socket someone
else owns or serves, or a refusal a sandbox or the folder's permissions may cause. It connects
to `ws://127.0.0.1:P<browser>?token=<token>`; every CDP call goes over that one browser socket
(flattened sessions), so it always carries the token. A missing, stale or unsafe file, or a refused connection, prints one line and exits 2:
`Ardia isn't running, or Command Line isn't installed (Settings › Plugins).` (on Linux, where the switch stays:
`Ardia isn't running, or "Let the ardia command control Ardia" is off in Settings.`), followed in parentheses by
what the CLI found when there is something to say: the missing socket and its folder, or the checks the app makes
before it opens its socket there, on both platforms: the folder is a real folder (not a link), the user's own, and not
writable by others (`others can write to <folder>
(mode 0775), so Ardia won't open ArdiaControl.sock there; run chmod go-w on it`). That was the Linux 0.2.47 release
smoke failure (ardia#3241): the release VM's login umask 0002 made the smoke's profile folder 0775, and every
`ardia windows` reported Ardia not running for 30 s, where CI's runners (umask 0022) passed. On Linux the CLI keeps its
own files under `${XDG_DATA_HOME:-~/.local/share}/ardia/cli` and no longer creates `~/Library` (ardia#2929); the
first run carries `skills.json` and `Usage/usage.json` over from `~/Library/Application Support/Ardia/CLI` when the new
folder has none. A command and an Ardia whose
control protocols don't fit say which one to update, in one line, from every command. There's no port scanning and no
`/json` fallback on this path. The token never reaches the output: stdout and stderr are redacted as a stream (a token
split across writes is held back until it's complete), and so are log records and everything a logging handler
formats, tracebacks included. The `websockets` logger (only the `stream` server uses it) stays at ERROR. The stream holds back only a tail that could start a
registered token and releases everything on `flush()`, at exit and on SIGTERM or SIGHUP (exit 143). A token printed in
two parts with an explicit flush between them gets through; that gap is accepted.

## Crash reports and usage

`ardia_cli/telemetry.py` records crash reports and usage only while the app's "Share anonymous crash reports and usage
stats" is on for the data dir the command resolved (`--data-dir`, else `$ARDIA_DATA_DIR`, else the installed app's):
`<data dir>/telemetry.json`, the app's own saved choice, must say `"sharing": true` with an `installId` (and, during a
14-day watch, a `sharingUntil` still in the future: one that isn't a readable time, an epoch number or an ISO 8601
date, means no consent; `null` or no field means no end). The background flusher checks all of this again itself,
`DO_NOT_TRACK` and `ARDIA_TELEMETRY` included, before each batch. That id is the events' `distinct_id`, so the command's events join
the install's. The CLI reads only the fields it needs and ignores the rest, at any `version`, so a newer app format never
silently stops CLI telemetry. Nothing is sent when the file is missing, unreadable or says sharing is off, with `DO_NOT_TRACK` set (anything but empty, `0` or `false`) or
`ARDIA_TELEMETRY=0` (or `false`, `off`, `no`), for a command pointed at a test endpoint (`--port`, `--ws`, `--cdp`,
`ARDIA_PORT`, `ARDIA_WS`, `ARDIA_CDP_URL`, `AGENT_BROWSER_CDP`), or from a checkout (version `0.0.0.dev0`). `ardia
--version` records nothing.

The wire format is the app's: OTLP log records (`otlp.ts` `eventRecord`/`logsRequest`) posted as `application/json`
to `https://ardia.dev/otel/v1/logs`, scope `ardia.analytics`, resource `service.name` `ardia-cli`, so they land in
`telemetry.events` with `source = 'ardia-cli'`. Every event carries `$lib` `ardia-cli`, `cli_version`, `$os_version`,
`arch`, `python_version`, `$environment` (`production` for the installed app's data dir, `test` for any other, `dev`
from a checkout), `$geoip_disable`, `$process_person_profile: false` and `$session_id`: the app's `sessionId` from
`telemetry.json` while it says `sessionOpen`, else one UUIDv7 per CLI process. During a watch, events also carry
`watch_report` (`FB-…`). Every post sends `X-Ardia-Key` with the CLI's public ingest key (`CLI_INGEST_KEY` in
`telemetry.py`, the same value as `packages/core/src/ingestKeys.ts`; a test keeps them equal).

- `cli_command`, one per run: `command` (the first command word; `unknown` for a word it doesn't know, `none` for
  bare `ardia` and `--help`), `subcommand` (the second word; for `browse`, the browse command, or `other` when it
  isn't one; for `call`, the method's family, the part before the first dot from a fixed list (`FAMILIES` in
  `call_cli.py`: `windows`, `tabs`, `history`, `cookies`, …) or `other`, never the method or its params; `error_code` is
  one of the protocol's codes (`bad_request`, `unknown_method`, `unknown_command`, `refused`, `no_window`, `failed`,
  `unsupported_protocol`), `other` for any other code Ardia sends (never the code itself), or `bad_params`; `methods` on an Ardia without it is
  `methods_unsupported`), `exit_code`, `error_code` (browse's `code`, such as `stale_ref`, `element_replaced` or
  `connection_lost`, or `unhandled_exception`; the TypeScript daemon answers every exit 1 with one: a failure
  with no code of its own, such as a `wait` or `is` that reported one or a batch line without a code, is
  `command_failed`, where Python's daemon sends none), and `flags`, the option names given, comma-separated, only names the
  command's parser knows. Then times in whole ms and counts, each capped (an hour, 100 million): `total_ms` (process
  start to exit) and `startup_ms` (process start until the command runs); for browse, `daemon_spawned` and
  `daemon_start_ms` when it had to start the daemon, `connect_ms` with `reconnected_after_idle` when the daemon
  (re)connected, `attach_ms` (finding and attaching the tab), the command itself as `snapshot_build_ms` for
  `snapshot`, `eval_ms` for `eval` or `action_ms` for the rest (the daemon's time less connect, attach and settle),
  `settle_ms` (the wait for the change report's network to settle, `changes.observe`), `snapshot_nodes` and
  `snapshot_chars`, `network_writes_count` and `unsettled` from the change report,
  `output_chars` and `output_truncated`, `humanize`, `settle_ignored_background` (a change report's settle passed
  over background requests, beacons, analytics, images, favicons and the like, instead of waiting for them; watch
  `settle_ms` on `open` and the actions, which it should lower, and `unsettled`), `frame_point_unconfirmed` (a click inside a same-origin frame
  aimed by `DOM.getContentQuads`, because a frame owner is rotated, mirrored or the like, landed somewhere Chromium's
  own hit test says isn't the element, so it was refused as covered instead of sent; watch `error_code` `covered` on
  `click`), `batch_lines_held` (how many lines of
  a `batch` ran inside a run of field lines that read the page once before and once after the run; watch `cdp_calls`
  and `total_ms` on `batch`), `dom_snapshot_used` and `dom_snapshot_refused` (a snapshot named 16 or more clickable
  elements it hadn't seen before with one `DOMSnapshot.captureSnapshot` instead of one `DOM.describeNode` each, or the
  engine refused that method, once per session, and the snapshot fell back; watch `cdp_calls` on `open` and
  `snapshot`), `followed_redrawn_ref` (a stale ref followed its redrawn node), `followed_ref_after_reload` (a ref from before the page reloaded the same address was used, its element was unique by role and name before and after, so the command used the new one and said so; a different address still fails as a stale ref), `stale_ref_after_navigation` (a ref from before the page navigated was used; the error says the page navigated, where it used to say only that the ref came from an earlier snapshot, and names the same role and name on the new page when there is one; watch `error_code` `stale_ref`), `attach_refused` (the policy refused the attach to a tab; watch it with `error_code` `policy_refused` on `read` and `open`, where it should stay at zero), `tab_kept_awake` (on a browser reached with `--ws`, `--port` or `--cdp`, a tab the command opened, a session tab or a reader tab for `read <url>`, got `Emulation.setFocusEmulationEnabled`, which Chromium keeps visible and focused while the command stays attached, so its timers aren't slowed to once a second in the background and it takes input without being shown; Ardia's own token path does this in the engine and skips it; watch `read_waited_for_content` and `error_code` `tab_hidden`, which it should lower), `network_disable_unconfirmed` (a command's change report turned network capture off and the page didn't confirm within 2 s, usually because it was mid-navigation or its main thread was busy; the tab is kept, where it used to be detached and the command failed with `error_code` `tab_detached`), `reattached_after_detach` (`open`, or an action's change report, found its tab detached from the command while the tab was still open, attached to it again and finished; watch `error_code` `tab_detached` on `open` and `script`, which should stay near zero), `setup_restored` and `setup_restore_failed` (after attaching again, the session's init scripts, `set` overrides and interception were put back, or something couldn't be and the command failed with `error_code` `setup_lost`, which should stay near zero), `renderer_exit_kept_session` (Chromium said a tab's renderer exited and the session was kept), `earlier_requests_ignored` (a change report left out requests that began before its capture was on), `cell_edits` (grid cells `fill` edited through their editor; watch `error_code` `rejected` and `not_editable` on `fill`), `fill_picked_option` (`fill` picked a `<select>` option), `fill_inserted_text` (`fill` put the text in with one `Input.insertText`), `fill_no_reaction_hint` (a `fill` into a text, number, search or phone input changed nothing else on the page, neither its text nor its controls nor a request, and the answer said some fields only apply on Enter or when left; watch it against `press` right after `fill`), `waited_for_enabled` (a `click`, `fill`, `select` or `check` target was disabled and was waited for; `error_code` `disabled` when it stayed so), `drag_side_given` (`drag --before`/`--after`) and `drag_list_position` (the drag answer named the new place in a list), `select_opened_list` (`select` picked from the one list that opened when it opened a field with no linked list; watch `error_code` `no_fresh_suggestions` on `select`, which it should lower), `press_targeted` (`press <sel> <key>` focused the element first), `find_closest_ref` (TypeScript: that error also led with the closest name and its ref), `find_closest_names` (`find role … --name` matched nothing and the error listed the names closest to the one asked for first, where it used to list the first eight on the page, usually navigation links; watch `error_code` `not_found` on `find`), `focused_inner_field` (an element that couldn't take focus itself, like a combobox wrapper, had the field inside it focused instead; a hidden or inert one now fails with `error_code` `not_focusable` and says to click it open, where it used to print the raw `DOM.focus: Element is not focusable`), `waited_for_reaction` (after typing into a search or filter field, the next command that targets something else waited, best effort, at least 0.6 s from the last keystroke for the page to redraw and go quiet, longer while anything is `aria-busy`, counting only the results the field `aria-controls` when it names them, up to 1.5 s; key presses without a target, `tab`, `notes`, `frame` and `get url`/`title` don't wait, and `--no-changes` keeps the wait; watch `error_code` `target_replaced` and `input_not_delivered` on `fill`, which it should keep low), `selector_nth` (a selector ended in `>> nth=N`; a CSS selector with an unquoted attribute value that has spaces or punctuation, like `[aria-label=Two words]`, is quoted for you, in `eval` too when it's a string literal passed to `querySelector`, `querySelectorAll`, `closest` or `matches` (`eval_selectors_quoted`; the answer names what it quoted), and an `eval` that still fails on one says how to quote it; watch `error_code` `page_script_error` on `click` and `eval`), `saved_as_csv` (`--out` wrote a CSV or TSV table), `script_state_kept` (a script ended or timed out with something in `state`), `script_state_kept_on_interrupt` (a script was interrupted, its caller's Ctrl-C or a closed connection, and what it had put in `state` was kept for the next script, where it used to be thrown away; the interrupt message says to read it with `script 'return state'`), `eval_timed_out` (an `eval`'s page code, usually an awaited promise, ran past its limit, 60 s or `--timeout` up to 10m, and the error said so and pointed at `--timeout`, where it used to say Ardia didn't answer `Runtime.evaluate`; it stays an unknown outcome, so a `batch` stops after it; watch `error_code` `outcome_unknown` on `eval`), `navigation_https_only_hint` (an `http://` navigation failed with `net::ERR_BLOCKED_BY_CLIENT`, which usually means Ardia's https-only loading found no working https on the site, and the error said so and pointed at the https:// address, where it used to read like an ad blocker; watch `error_code` `navigation_failed` on `open` and `read`), `batch_lines_compacted` (how many lines of a `batch`, other than its last successful one, were a `fill`, `select`, `check`, `uncheck` or `type` whose whole change report was the field taking the value it was given, and so were printed as one line, `✓ fill #title "Board prep"`, instead of the report; a line that changed anything else, new elements, text, the URL or a request, keeps its full report; on the landing-page bench, change reports were half of everything the CLI printed), `open_read` (`open <url> --read` opened the page and printed its full `read` text in the same call, instead of the change report; agents had run `open` and then `read` on the same page about 440 times in two full BU Bench runs), `covered_close_ref` (a click target was covered and the error named the covering layer's own close control as a ref, `its close control is @e12 "×"`, so the agent closes it in one step; watch `error_code` `covered` on `click`), `script_timeout_state_shown` (a timed-out `script` had put something in `state`, and the error printed it, up to 1,500 characters, where it used to name only its keys), `download_fetched_again` (`download` or `wait --download` finished on a browser that saved the file on its own machine, a browser reached with `--ws` on another host, so the file was fetched again from the page, through the page's cookies, and written to the local path, up to 50 MB; it used to fail with `FileNotFoundError`; a fetch that fails says so with `error_code` `download_remote`), `session_busy_on_stuck_tab` (a command gave up with `error_code` `session_busy` while the running command was waiting on a tab whose page wasn't answering, and the message named that tab), `page_busy_fast_fail` (a tab whose page had already left a command unanswered for its full wait, because the page's own scripts kept its main thread busy, was checked with a 3 s probe before the next command and was still stuck, so that command failed with `error_code` `page_busy` in about 3 s instead of waiting 30 s again; the first unanswered call now says the same thing in plain words and suggests `reload` or a lighter page; the tab is checked for 2 minutes after it last failed to answer; watch `error_code` `page_busy` and `session_busy`, which it should lower), `navigation_site_silent` (`open`, a script's `goto` or `read <url>` sent `Page.navigate` and got nothing back within its time limit because the site never answered; the error names the host, says the site may be down, slow or not answering automated traffic, and that a retry rarely helps, with code `timeout`, where it used to read "Ardia didn't answer Page.navigate" with `outcome_unknown`, which also ended a whole `script` past its own try/catch; watch `error_code` `outcome_unknown` on `open`, `script` and `read`, which it should lower), `navigation_dropped_hint` (a navigation failed because the site dropped or refused the connection, and the error said a retry of the same URL rarely loads, named what may still answer and asked to say what couldn't be reached, counting the failures on that host; watch `error_code` `navigation_failed` on `open`), `queued_behind_script` (a command arrived while its session was running a `script` and waited its turn, up to 5 minutes, where it used to give up after 30 s; watch `error_code` `session_busy`), `script_queued_behind_busy` (a `script` arrived while its session was busy and waited its turn, up to its own `--timeout` or 90 s, where every command used to give up after 30 s; watch `error_code` `session_busy` on `script`, which it should lower), `script_timeout_read_hint` (a timed-out script had opened three or more pages one after another and was pointed at `read <url> <url> …`; watch `error_code` `timeout` on `script`, which it should lower), `saved_to_file` (`script`, `eval` or `read` ran with `--out`; watch `output_truncated` on `script`, which it should lower), `read_links_from_url` (`read <url> --links <pattern>` took its links from the URLs given, where it used to take them from the session's tab; watch `error_code` `no_links` on `read`), `read_binary_saved` (`read --http … --out` saved a binary response's bytes as sent, where it used to write corrupt decoded text; watch `error_code` `binary_body` on `read`, a binary body read without `--out`), `batch_line_saved` (a `batch` line carried `--out` and saved its file, where it used to fail with Unknown flag), `batch_saved` (`batch … --out <file>` saved everything the batch printed and listed the lines that failed, where it used to fail with Unknown flag), `waited_for_element` (a selector matched only after polling; watch `error_code` `not_found`, which it should lower), `output_saved` (a capped output was saved whole to a file; watch `output_truncated` on `script`, which it should lower), `consent_dismissed` (a click dismissed the consent banner covering it; watch `error_code` `covered` on `click`, which it should lower), `popup_dismissed` (a click closed an email-signup popup or a feedback-survey invite (Medallia/Kampyle, Qualtrics, Hotjar, ForeSee, Usabilla, Survicate) covering it, through its close, No thanks or × button, never its signup or survey button; watch `error_code` `covered` on `click`), `input_mouse_events_cancelled` (a click's mousedown/mouseup never arrived because the page cancelled pointerdown, as Radix menu triggers do, and its pointerdown/pointerup counted instead), `input_confirmed_by_text` (a text insert's beforeinput/input never reached the watch, as when an editor takes them over first, but the same focused field now reads exactly as before with the inserted text at the caret, so it landed), `input_lost_pointer`, `input_lost_keys`, `input_lost_text`, `input_lost_wheel` and `input_lost_drag` (which kind of events was missing when an action failed with input_not_delivered), `modal_dismissed` (a click target was covered by a site popup whose class or id names it a popup, overlay, pop-layer, lightbox or interstitial (or a Bounce Exchange or Wisepops box), so it was closed through its own close control, ×, Close or a close label, never another button, and the click went through; a dialog marked only by role or aria-modal is left alone, as are other buttons; watch `error_code` `covered` on `click`), `menu_closed_for_click` (a click target was covered by an open menu, dropdown list or suggestion list, so the click pressed Escape once to close it and tried again, and the answer said so; a consent layer still fading in now also gets a second try after 0.8 s; watch `error_code` `covered` on `click`, which it should lower), `dom_click_fallback` (a click target outside the page got a DOM click), `dom_click_behind_modal` (a click target outside the page sat outside the modal dialog showing over it, so it got no DOM click and the error named that dialog; watch `error_code` `outside_viewport` on `click` and `dom_click_fallback` against it), `dom_click_waited_for_modal` (that dialog was still closing and went within 0.5 s, so the click went through after the wait; watch it against `dom_click_behind_modal`), `input_in_inner_frame` (a raw `mouse` event's point, or a key press's focus, was in a frame inside the page, a cross-process iframe, a frame in a shadow root or an `embed`, so delivery counted as confirmed instead of failing with `input_not_delivered`; watch `error_code` `input_not_delivered` on `mouse` and `press`, which it should lower), `screenshot_unchanged` (`screenshot --if-changed` found the view unchanged since its last screenshot and saved nothing), `flow_saved` with `flow_requests_kept` and `flow_params` (a `flow save` and what it kept), `flow_run_page` (a `flow run` got its answer), `flow_drifted` (an answer's shape changed; watch it with `error_code` `drifted`, `redirected`, `auth_expired`, `blocked`, `rate_limited`, `fetch_failed` and `flow_not_get` on `flow`), `flow_shaped` with `flow_items` (`--fields`, `--where` or `--limit` were given, and the items returned), `flow_hint_shown` (`open` or `snapshot` listed a site's saved flows), `frame_cross_process_box` (`frame` on a cross-process iframe, which ardia browse can't enter, answered with `error_code` `cross_process_frame`, the iframe's viewport box and the `mouse move`/`down`/`up` recipe for clicking inside it), `click_scroll_locked` (a click target the page couldn't scroll to was held back by an open dialog or a scroll lock, and the error named it and said to close it; watch `error_code` `outside_viewport` on `click`), `click_recentered` (a covered or off-screen click target was scrolled to the middle and retried; watch `error_code` `outside_viewport`), `element_rehomed` (a page call was refused because an element's handle belonged to an older JavaScript world of the page, so the element was resolved again in the current world by its node and the call retried, where the command used to fail with a raw `Runtime.callFunctionOn` error), `clicked_visible_content` (a click target with no box of its own, like a zero-size wrapper around its visible content, was clicked through its first visible descendant, which the event reaches it from; a hidden target still fails with `error_code` `not_visible`, now in plain words where a raw `DOM.scrollIntoViewIfNeeded` error used to leak), `clicked_label_of_hidden_input` (a click on a checkbox or radio drawn by its label, with the input itself hidden, went to the label; watch `error_code` `not_visible` on `click`), `waited_for_box_to_settle` (a click target was still moving, from a scroll or a layout change, and the click waited up to 1 s for it to stop before aiming), `read_scope_shown` (a read printed the page's own total or pagination), `read_data` with `read_data_blocks` and `read_data_shaped` (`read --data` listed the JSON blocks the page embeds, how many, and whether `--fields`/`--where`/`--limit` shaped one; watch `error_code` `no_data` on `read`), `read_bot_check` (a page read like a bot check or block and got the retry note), `network_reloaded` (`network requests --reload` started recording and reloaded the page so its own loads were listed; plain `network requests` that starts recording now points at it), `read_empty_page` (a page came back with no title and no text and was marked as a likely block; watch `read_pages` against it), `read_oopif_frames` (TypeScript daemon: `read` appended the text of an out-of-process iframe it read in that frame's own session), `snapshot_oopif_frames` (a snapshot put an out-of-process iframe's tree under its `Iframe` node), `selector_in_shadow_root` (a selector that matched nothing in the document was found in an open or closed shadow root), `snapshot_document_changed` (a snapshot found a frame had changed document while it was taken, and refused its refs), `oopif_attach_refused` (the browser refused the iframe auto-attach on a page session), `read_scroll_waited_at_end` (`read --scroll` reached the bottom of a list with no new rows, waited up to 3 s, nudging the scroll once to set off the page's loader again, and more rows arrived, so it kept going, where it used to call the list ended after about 0.2 s and stop a feed that fetches its next batch at a few hundred rows; watch `read_rows` against it), `read_scroll_guessed` (`read --scroll` without `-s` picked the page's main repeated list; watch `error_code` `no_list`), `read_beside_busy` (a `read` of named URLs ran in the sibling session because its own was busy; watch `error_code` `session_busy` on `read`, which it should lower), `read_queued_beside` (that sibling session was itself busy, so the read waited its turn there, up to its own time limit, where it used to give up after 30 s), `read_waited_for_content` (a page read thin after settling and was read again until it filled in or 5 s passed; watch `read_pages` against it), `read_partial_page` (a `read <url>` page hit its time limit before the document finished arriving but had already shown text, so that text was returned with a note saying the page was still loading, where the page used to fail with `error_code` `timeout`; watch `error_code` `timeout` on `read`, which it should lower), `read_waited_for_requests` (a `read <url>` page looked settled while a fetch or XHR it started in the last 1.5 s was still in flight, so the read kept waiting, within the usual 3 s settle limit, for results a page fetches after it loads; watch `read_pages` against it, and `read_waited_for_content`, which it should lower), `read_scope_empty` (`read -s` on the session's tab matched elements that still had no text after 5 s of polling, and the answer said so and pointed at reading without `-s`, where it used to print nothing and succeed; a selector that matches nothing now fails with `error_code` `not_found` on `read`, so watch both), `read_pdf` (`read` extracted a PDF's text; watch `error_code` `pdf_unreadable`), `script_eval_alias` (a script called `page.eval`), `script_command_line_split` (a script called `browse()` with a whole command line in one string, like `browse('read --data')`, and it was split into the command and its arguments, where it used to fail with Unknown command; watch `error_code` `usage` on `script`), `script_page_world_hint` (a script's error got the page-world hint), `read_scrolled` with `read_rows` (a `read --scroll` and the rows it read) and `read_matched` (it had `--match`), `read_pages` (the pages a multi-page `read` read; watch `output_truncated` on those), `read_tabs_reopened` (reading tabs Ardia detached mid-read that were opened again; watch it with `error_code` `tab_detached`, which should stay near zero), `read_virtualized_grid` (a read printed the virtualized-grid note), `read_frame_text` (a read reached into an iframe: a visible same-origin frame of at least 120×80 px is read in place between `[frame "<title>"]` and `[end of frame "<title>"]`, three frames deep at most, where frames used to be left out, so a careers page or a form inside one read as its wrapper; a cross-origin frame of at least 400×300 px, which the page's script can't reach, gets a line with its address to `read`); `read_nav_hidden` with `read_nav_chars_hidden` (a whole-page `read` or `open --read` printed site menus and link-heavy footers outside the main content as one `[navigation hidden, 84 links: …]` line each, consecutive ones merged, and how many characters of their text it left out; breadcrumbs, pagination, in-page contents, filters, anything inside `main` or `article`, menus that hold content, menus under 100 characters, and pages that are mostly navigation still print in full (the Site menus section), and `read --nav` prints every menu; watch `read_nav_chars_hidden` against `output_chars` on `read` and `open`, and `--nav` in `flags`, which should stay rare); `read` marks the navigation it keeps, asides and blocks titled or named like related, recently viewed, sponsored or recommended items with `[<title>: not the main content]` … `[end of <title>]`, so they're easy to skip or scope away from (reading such a block itself with `-s` doesn't mark it); `read` writes the label of an icon that carries one (an `aria-label` on a textless element, or an SVG's `aria-label` or `<title>`) in brackets beside its value, like `[Customer care] 1-800-…`, where it used to drop it; nothing extra is counted for this, `change_text` with `change_text_chars` (a change report carried `text:` lines, and their length), `change_run_choices` (a mixed run listed its enabled members), `open_report` (`open` printed a change report), `open_moved_tab` (`open` moved the session off the user's tab to its own and named the way back), `open_still_loading` (`open` hit its time limit waiting for the load event on a page that already showed content, and returned it with a note instead of failing; watch `error_code` `timeout` on `open`, which it should lower), `snapshot_disabled_folded` (`snapshot -i` folded disabled members into a count), `snapshot_repeat_labels` (`snapshot -i` labeled controls that share a name, or have none, with the nearest heading, link, cell or text around them, as `(near "…")`; headings get none, a text that is itself a repeated name is never used, and a label two of the same controls would share is left out), `names_clipped` (a name was cut at 100 characters), `daemon_answer_timed_out` (the client gave up waiting for the
  daemon's answer: the queue wait plus the command's own limit plus 30 s, `browse/limits.py`), `batch_steps` (also the operations an `ardia apply`, `tabs …`
  or `groups …` call sent), for a `batch` with a failed line `failed_step_index` (the first failed line, counting
  from 0) and `failed_step_command` (that line's browse command, from the same closed list as `subcommand`, or
  `other`; never its arguments), with `error_code` set to that line's code (TypeScript only; watch `failed_step_command`
  with `error_code` on `batch` to see which step agents lose batches on; a trailing `close` that fails counts as the
  step after the last line, and a line that can't be parsed, one that isn't a JSON array of strings or a command
  line, is the failed step with `other`, though nothing ran), for a `script` `script_calls` (the page calls it made),
  `script_concurrent_peak` (the most read-only calls it ran at once), `script_receipts_skipped` (actions that skipped the
  change report because the script didn't ask for one) and the flags `script_runner_warm` (it started on the daemon's
  waiting runner), `script_eval_args` (`page.evaluate` got more than one argument), `script_selector_eval`
  (`page.$eval` or `page.$$eval`), `script_frames_listed`, `script_frame_eval`, `script_missing_api` (it called a
  `page` method the API doesn't have; the name isn't sent), `script_runner_unconfined` (Linux without Landlock),
  `script_runner_crashed`, `script_memory_limit` and `script_sandbox_hint` (a `require`, `fetch` or `process` the
  sandbox lacks got a hint) (TypeScript only; watch `total_ms` on `script` against
  `script_calls`, and `error_code` on `script` beside `script_missing_api`), and `cdp_calls` with `cdp_ms_total` (the
  command's own DevTools calls, counted in `connection.py`). The daemon returns its share as `metrics` in its answer
  (`command_metrics.py`).
- `$exception` for a crash the CLI didn't handle (`source` and mechanism `cli_unhandled`, level `fatal`) or one inside
  a browse daemon command (`browse_daemon`, level `error`; `fatal` when the daemon itself dies). It has the type and
  no free text: the message is sent only when it's one of the fixed built-in messages that carry no input
  (`FIXED_MESSAGES` in `telemetry_scrub.py`, like `division by zero` or `Event loop is closed`), or as
  `[Errno N] <the system's text for N>` for an `OSError`; otherwise the value is the type again. Frames are module,
  function and line, where a frame outside `ardia_cli`, the standard library and the bundled packages shows as
  `<other>`. At most 10 per process, one per type, message and top frame. The daemon checks its own environment and
  also each request's `telemetry` field, which the client sets from the command's own environment (opt-outs, test
  endpoints, a checkout): it reports a command's crash only when that request was eligible, and a crash of the
  daemon itself only when the last request it took was.

It never sends argv values, URLs, page text, selectors, refs, typed text, JS, notes, file paths, cookies or anything
from the page. Reports from `ardia feedback` don't go through this pipeline (see Feedback and the star nudge).

Every event it builds, sent or not, is also appended to a 7-day local copy, `<data dir>/Telemetry/local/cli-<UTC
day>.jsonl` (folder 0700 when the CLI makes it; the app shares it, so one it made without group or other write access
is used too), one record per line with `sent` true when it was queued for ardia.dev and false when sharing is off
(`distinct_id` is then `local`). Files older than 7 days are deleted and the total is capped at 4 MB, oldest lines
first, on every append, under `cli-local.lock`. It's written whenever the command would send if sharing were on, so
the opt-outs, test endpoints and a checkout above keep no copy either. It leaves the Mac only as the normal events
(sharing on) or when someone attaches it to a report.

Nothing waits on the network. Events go to `<data dir>/Telemetry/cli-queue.jsonl` (folder 0700, file 0600, under
`cli-queue.lock`; at most 500 events and 256 KB, the oldest dropped). At exit, once at least 60 s have passed since the
last flush started (`cli-flush.json`, read and updated under `cli-flush-claim.lock`, so concurrent commands start one),
the command starts a detached `python -I` flusher with its config on stdin and the data dir made absolute. It holds
`cli-flush.lock` so only one runs, drops events from another install id, posts batches of 100 (500 KB at most) with a
5 s timeout and a 12 s budget, and removes what was accepted (2xx) or refused (400, or 413 for a single event). It
reads `telemetry.json` again before every post: sharing turned off stops it and deletes the spool, a new install id
stops it and drops the old id's events. Anything else keeps the events and backs off 30 s, doubling up to 30 minutes. With sharing off,
the next command deletes the spool, and so does a flusher. The browse daemon only appends; the next command's exit
sends it. Turning sharing off in the app stops new events at once; what's already spooled goes at the next `ardia`
run.

`ARDIA_TELEMETRY_URL` is for tests only: a loopback `http://` URL (`127.0.0.1`, `localhost` or `[::1]`) gets the
posts instead of ardia.dev, from a checkout too, and any other value turns telemetry off. `tests/test_telemetry.py`
runs against a local stub with fixture data dirs.

## Feedback and the star nudge

`ardia feedback --title "<short title>" "<what you ran, what happened, what you expected>"` (or the description on
stdin, or `-`) is for agents and people to report a problem or an idea: a confusing error, a missing command, output
that cost turns, something slow. It follows the contract in `docs/feedback.md`: `--title` is required, 1-67 characters
once runs of whitespace are folded into one space; the description is required and kept to 4,000 characters after
scrubbing; `--kind` is `bug` (the default), `slow`, `idea` or `other`; `--command` names the command that misbehaved.

Sending a report is consent for that report, so it goes out whether or not the app's sharing is on. With sharing on
(`telemetry.json` for `--data-dir`, `$ARDIA_DATA_DIR` or the installed app's data dir; from a checkout, only an
explicit data dir is read) the report carries the install id, so it joins that install's events; otherwise a one-time
UUIDv4 made for that report. `session_id` is the same one the events carry. It posts to `https://ardia.dev/api/feedback`
with `X-Ardia-Key` (the CLI key): `kind`, `title`, `description`, `source: "cli"`, `install_id`, `session_id`,
`app_version` and `app_build` (the app's `lastVersion`/`lastBuild` from `telemetry.json`), `channel`, `os_version`,
`arch`, `cli_version`, `watch_days: 0`, `diagnostics` (`agent`, the caller name the control pill shows from
`caller.py`; `about_command`, scrubbed and capped at 300; `recent_commands`, the last five command names this CLI home
ran, like `browse click` or `browse fill (exit 1)`, never their arguments; `description_truncated`; `environment`;
`python_version`) and `attachments`. Then it uploads each file with `PUT <endpoint>/<id>/files/<name>` and the
`upload_token` as a Bearer token, and calls `POST <endpoint>/<id>/complete`. It prints `Sent. Reference FB-…`, the
GitHub issue link and "You appear to us as <name>" from the service's answer, and says "Sent" only after a 2xx from
`complete`.

`--attach FILE` (repeatable, 10 at most) takes the contract's kinds: one `.mp4` as `recording.mp4` (100 MB), one
`.json.gz` as `trace.json.gz` (50 MB), `.ips` crash reports as `crash-<n>.ips`, and `.png`, `.jpg`, `.jpeg`, `.gif`,
`.webp`, `.heic`, `.mov`, `.txt`, `.log`, `.md`, `.json`, `.jsonl` or `.csv` as `attachment-<n>.<ext>` (10 MB each).
Anything else, an empty file or one over its cap is refused before anything is sent. Files aren't scrubbed; they stay
private and never reach GitHub.

`telemetry_scrub.scrub` removes secrets by exact pattern, never by cutting at a keyword, so a report about
`ardia browse session`, `auth save` or an expired token keeps its words. It replaces control characters, then
removes: private key blocks; every parameter of a Digest header; the value of `Authorization`, `Proxy-Authorization`,
`Cookie`, `Set-Cookie`, `Api-Key`, `Private-Token` and `X-…-Token/Key/Secret/Auth/Session/Password` headers; URL logins
and queries (`https://host/path?<redacted>`); `key=value`, `key: value`, `key => value` and `--key value` where the key
names a secret (`password`, `passwd`, `pwd`, `passphrase`, `secret`, `token`, `api_key`, `access_key`, `private_key`,
`credential(s)`, `session_id`/`session_key`/`session_token`, `sessionid`, `auth_token`/`auth_key`/`auth_code`,
`cookie`, `signature`, `otp`, and names ending in them like `client_secret` or `access_token`), quoted values whole,
escapes and unclosed quotes included; session cookie pairs (`sid=`, `PHPSESSID=`, `connect.sid=`, `_x_session=`…);
`Bearer`/`Basic` followed by something credential-shaped (a digit or `._~+/=-`, 20 letters, or quoted); known key
formats (`ghp_…`, `github_pat_…`, `sk-…`, `sk_live_…`, `xox?-…`, `glpat-…`, `npm_…`, `AKIA…`/`ASIA…`, `AIza…`,
`ya29.…`, `hf_…`) and JWTs as `<secret>`; emails as `<email>`; mixed letter-and-digit runs of 32 or more as
`<secret>`; card numbers that pass the Luhn check as `<number>`; and the name in `/Users/<name>` and `/home/<name>`.
A title or description with nothing left but those placeholders is refused (exit 2). The raw length isn't sent.

When it isn't sent, the report is kept, scrubbed, in `$ARDIA_CLI_HOME/Usage/feedback.jsonl` (newest 200, with the
reason and any reference the service gave), and the line says exactly why: `DO_NOT_TRACK=… is set`,
`ARDIA_TELEMETRY=… is set`, `ARDIA_PORT points ardia at a test browser` (any of the test endpoint variables), a
checkout build (`0.0.0.dev0`, which never sends to ardia.dev), an `ARDIA_FEEDBACK_URL` that isn't loopback, the daily
limit, the network failing (with the system's reason), or the service's HTTP status and message. At most 20 reports a
rolling day go out per CLI home, and the same kind, title and description twice in a day is sent once
(`$ARDIA_CLI_HOME/Usage/usage.json`, under `usage.lock`); a report that fails gives its slot back, and when another
`ardia` holds that lock the report is kept with that reason. From a checkout without `ARDIA_CLI_HOME`, nothing is
counted or saved, and the line says so.

`ARDIA_FEEDBACK_URL` is for tests: a loopback `http://` URL gets the reports instead of ardia.dev, from a checkout too
(an origin alone gets `/api/feedback` added); any other value keeps reports on the Mac. `tests/test_feedback.py` runs
against a stub of the service and, when `node` is there, against `node infra/feedback/server.mjs --local <tmp dir>`.

The owner reads them on dash.ardia.dev › Feedback, and each opens a GitHub issue.

Every command (but `feedback` and `star`) also leaves its name and, when it failed, its exit code in that state's
`recent` list (five at most), for the next report's `recent_commands`. From a checkout (`0.0.0.dev0`) nothing is recorded
unless `ARDIA_CLI_HOME` is set, so tests never touch the installed CLI's state.

A task is a stretch of `ardia browse` work: it starts with a successful command that does something (`open`, `click`,
`fill`, `type`, `press`, `select`, `find`, `eval`, `batch`, `script`, `read`, `scroll`, `back`…, not `snapshot` or
`help` alone) and ends when 30 minutes pass without another one. Gaps make it robust to agents that run hundreds of
commands for one job or several jobs a day. Commands aimed at a test endpoint (`--port`, `--ws`, `--cdp`, their
variables) or at a data dir other than the installed app's (hidden test instances, the bench) never count. When a
sixth task starts after five finished ones, the CLI prints once, on stderr after the command's output:

> Ardia here: if this helped, you may ask the user once whether they'd like to star github.com/mantrakp04/ardia.
> Only if they say yes, run `ardia star`.

It records `star.prompted_at` first, so it never shows twice. `ARDIA_STAR_PROMPT=0`
(or `false`, `off`, `no`) and CI (`CI`, `GITHUB_ACTIONS`, `BUILDKITE`, `JENKINS_URL`) keep it quiet; tasks still count.

`ardia star` runs `gh api --method PUT /user/starred/mantrakp04/ardia --silent` when `gh` is on the PATH (no prompts,
20 s cap). If gh is missing, not signed in or fails, it opens the repo with
`ardia browse --session ardia-star open https://github.com/mantrakp04/ardia --show` (its own session, so the agent's
tab stays where it was) and says to ask the user to click Star; it never clicks it. If that fails too it prints the
URL and exits 1. Whatever happened, it records `star.done_at` so the nudge never shows again.

## Computer use

`ardia computer` is [cua-driver](https://github.com/trycua/cua/tree/main/libs/cua-driver) (MIT, Cua AI): an MCP server
and CLI that operates native apps through the accessibility tree, in background windows, with a cursor of its own.
The browser stays `ardia browse`; `ardia computer` is for everything that isn't a web page in Ardia. Code:
`ardia_cli/computer.py`.

### What ships and where it lands

The CLI tarball doesn't carry it (it would add about 31 MB compressed, 83 MB installed, for everyone). It's fetched
on first use from cua's GitHub release, pinned in `computer.py`: `VERSION`, `DRIVER_SHA256` (the
`cua-driver-rs-<V>-darwin-arm64.tar.gz` asset, about 85 MB) and `SKILLS_SHA256` (`cua-driver-rs-v<V>-skills.tar.gz`).
A download is https only (redirects too), checked against the pinned digest before anything is extracted (a mismatch
installs nothing), and extracted with no links, special files or entries outside the archive's folder. Only the
signed `CuaDriver.app`, `LICENSE` and `THIRD_PARTY_NOTICES.md` are kept, in `$ARDIA_CLI_HOME/cua-driver/<V>/`; the
app is stored as `CuaDriver` (no `.app`) so LaunchServices never sees a second copy. It must be Cua AI's: bundle id
`com.trycua.driver`, the pinned version, and `codesign --verify --deep --strict` against
`identifier "com.trycua.driver" and anchor apple generic and certificate leaf[subject.OU] = "YCK386LBJ7"`. The
bundle is Developer ID signed, hardened and notarized with a stapled ticket; ardia never re-signs or modifies it, so
our own signing and notarization are untouched. The cached copy is checked the same way every time it's reused; one
that fails is deleted and fetched again. The current and one older version stay; `install.sh` keeps the folder
across upgrades and `--uninstall` removes it.

### Permissions

macOS ties Accessibility and Screen Recording to the app that asks. cua-driver's daemon is always
`/Applications/CuaDriver.app` (hardcoded upstream): `cua-driver mcp` starts it with `open -n -g
/Applications/CuaDriver.app --args serve`, and `permissions grant` asks for the switches from inside it, so the
grants land on `com.trycua.driver`, never on the terminal, the agent or ardia. `ardia computer setup` therefore
copies the verified app there, links `$ARDIA_CLI_BIN_DIR/cua-driver` (default `~/.local/bin`) to a shim that runs
`ardia computer` (cua's skill calls `cua-driver`), turns cua-driver's telemetry off (`cua-driver telemetry disable`, saved in `~/.cua-driver/config.json`; the daemon starts through
LaunchServices and never sees our environment), then runs `cua-driver permissions grant` when it has a terminal.
A `CuaDriver.app` that ardia didn't put there (cua's own installer, another version) is kept and used as it is, and
a `cua-driver` command that isn't our link is kept too. Replacing ardia's copy with a newer one signed by the same
team keeps the grants (TCC matches the designated requirement).

Putting the app in place is one recoverable operation. Setup and refresh hold an flock on
`$ARDIA_CLI_HOME/cua-driver/.applications.lock` (up to 120 s, then they give up with an error). The verified app is
copied with `ditto` to `/Applications/.CuaDriver.app.ardia-new` and checked again; then the record
(`$ARDIA_CLI_HOME/cua-driver/applications.json`: path, version, the new copy's CDHash) is written as `pending`,
keeping the previous record inside it. Only then does ardia stop the old daemon (after verifying the old app), rename
the old app to `.CuaDriver.app.ardia-old`, rename the new one into place, commit the record, delete the old copy and
register the app with LaunchServices. A failure before the swap changes nothing; a failure during it puts the old
app and record back. After a crash, the next setup, refresh or `ardia computer` run (under the same lock) recovers:
it puts `.ardia-old` back when `CuaDriver.app` is missing, commits a pending record whose CDHash matches a
`CuaDriver.app` that verifies, restores the previous record only on a definite mismatch (a different CDHash, or a
signature codesign rejects), and removes leftover `.ardia-new` and `.ardia-old` copies. When `codesign` can't answer
(it fails to run or times out), recovery leaves the pending record and `.ardia-old` exactly as they are, says
recovery is pending, and setup and refresh exit 1; the next run tries again. An app counts as ardia's only with a
committed record whose path and CDHash match.

The shim runs `$ARDIA_CLI_HOME/current/bin/ardia` when that resolves inside `$ARDIA_CLI_HOME`, else the launcher of
the installation that is running (`<root>/bin/ardia` next to `<root>/python`). It never takes whatever `ardia` is first
on PATH: with neither, setup and `mcp-config` refuse and say why.

### Running it

`ardia computer <args>` execs the driver with the arguments unchanged: `/Applications/CuaDriver.app`'s binary when
it's there, otherwise the bundled copy (fetched on demand). Either is verified before every run (`codesign --verify
--deep --strict` against Cua's designated requirement, about 0.1 s); an app in `/Applications` that fails, ardia's or
not, is refused with a line saying to move it away and run setup. The check runs right before every launch; the
window that remains between it and the exec needs the user's own write access to the app (macOS has no `fexecve`),
and that access could replace `ardia` itself. Any version Cua signed runs. The bundled copy
answers `--version`, `--help`, `list-tools`, `describe` and the like. `mcp`, `call`, `serve` and `permissions` need the installed app, so before setup they print
one line pointing at `ardia computer setup` and exit 1. `CUA_DRIVER_RS_TELEMETRY_ENABLED=0` and
`CUA_DRIVER_RS_UPDATE_CHECK=0` are set unless the caller set them. `update`, `channel` and `skills` exit 2 with where
to go instead: the driver moves with ardia, not with cua's curl-to-bash installer. `help` is cua-driver's `--help`.
When ardia's copy in `/Applications` is older than the pin, it says to run setup. Shared flags (`--port` and the
rest) are refused.

`ardia computer mcp-config --target general|claude-code|codex|cursor|opencode` prints the MCP entry, which runs
`$ARDIA_CLI_HOME/current/bin/ardia computer mcp` so it keeps working across upgrades: `claude mcp add-json --scope
user cua-driver '…'` for Claude Code, `codex mcp add cua-driver -- … computer mcp` for Codex, and the JSON to paste
for the others.

`install.sh` starts `ardia computer refresh` in the background after each upgrade: when the app in `/Applications`
is ardia's (path and CDHash match the record) and older than the pin, it stops the daemon and swaps in the new one
(staged next to it, renamed into place); otherwise it does nothing.

### Its skill

`ardia skills install` puts cua-driver's own skill (`SKILL.md` plus its references, `LINUX.md` and `WINDOWS.md`
left out) in a `cua-driver` folder next to each `ardia` folder, from the pinned skills asset (cached in
`$ARDIA_CLI_HOME/cua-driver/<V>/skills`). It writes the same `.ardia-skill` marker with `"skill": "cua-driver"` and
the upstream tag, under the same rules as ours: files written by rename, only files its marker listed removed,
links never followed. A `cua-driver` folder or link without our marker (cua's installer links
`~/.cua-driver/skills/cua-driver` into each agent) is left alone and reported as `kept`. Our `ardia` marker records
`"companions": ["cua-driver"]` once the companion is in place; `refresh` rewrites a marked companion, adds one
next to an `ardia` folder written before companions existed, and never brings back one the user deleted. A failed
download fails the command (exit 1), leaves our skill installed, and is retried by the next refresh. `--no-cua`
records no companions. Our `SKILL.md` has one line pointing native-app work at `ardia computer`.

### Bumping it

Change `VERSION`, `DRIVER_SHA256` and `SKILLS_SHA256` at the top of `ardia_cli/computer.py`, taking the digests
from the release's `SHA256SUMS` and checking them against your own download (`shasum -a 256`), then run
`ardia computer --version` against a scratch `ARDIA_CLI_HOME`, the tests, and `ardia computer --help` for new or
renamed subcommands (`DRIVER_COMMANDS`, `DAEMON_COMMANDS`). Pick a release at least a week or two old: cua ships
several a day. The bump ships with the next CLI release; `install.sh` then updates ardia's copy in `/Applications`.

## Install and upgrade

On macOS Ardia installs the command itself, as a plugin (above); `install.sh` is for Linux, where Ardia runs it with its
own environment minus every `ARDIA_*` variable, plus `ARDIA_CLI_HOME`, `ARDIA_CLI_BIN_DIR` and `ARDIA_CLI_URL` from its
`ARDIA_INSTANCE` keys `cliHome`, `cliBinDir` and `cliUrl`, and for installing by hand.

`install.sh [--version V] [--sha256 DIGEST] [--uninstall]` (run with `/bin/sh`; `--help`):

- Downloads `https://github.com/ardia-browser/plugins/releases/download/cli-v<V>/ardia-cli-<V>-macos-arm64.tar.gz` on macOS
  and `…/ardia-cli-<V>-linux-x64.tar.gz` on Linux (https only) into a private temp dir; it runs on Apple silicon and
  x86_64 Linux and stops with an error anywhere else. Without `--version` it
  takes the latest release that has the asset. `--sha256` is the only
  digest it trusts (Ardia on Linux passes its package's `lib/ardia/cli/ardia-cli.sha256`), and
  a download needs it: a `.sha256` from the same release would only prove the tarball came from wherever the tarball
  came from. Only a `file://` `ARDIA_CLI_URL` (Ardia's own bundled tarball, and tests) may go without it, reading
  `<url>.sha256`.
- Verifies the digest, refuses entries outside `ardia-cli-<V>/`, `..` paths, hard links and links pointing outside the
  tree, plus names with control characters, backslashes or ` -> `, extracts to `$ARDIA_CLI_HOME/<V>.partial`, checks
  the extracted tree again (`find`, no line parsing), renames it to `<V>`, and swaps `current` atomically.
- It keeps the current and the previous version, and any version a running `ardia` uses: `ardia_cli` writes
  `<V>/.leases/<pid>` when it starts (from the launcher or `python -m ardia_cli`) and removes it at exit. A lease
  counts only while a process with that pid runs and started no later than the lease was written (`ps -o lstart`
  against the lease's mtime), so a reused pid doesn't pin a version.
- Links `$ARDIA_CLI_BIN_DIR/ardia` (default `~/.local/bin`) to `current/bin/ardia`. It replaces only a link that
  already points into `$ARDIA_CLI_HOME` and refuses anything else. With the default bin dir off the login shell's
  PATH, it adds `export PATH="$HOME/.local/bin:$PATH"` to the shell's login file once: on macOS `~/.zprofile`
  (`~/.bash_profile` for bash); on Linux `~/.zprofile` for zsh, `~/.bash_profile` for bash when it exists, else
  `~/.profile`, and `~/.profile` for any other shell. Fish reads none of those, so for fish (on both) it writes
  `contains -- $HOME/.local/bin $PATH; or set -gx PATH $HOME/.local/bin $PATH` to
  `${XDG_CONFIG_HOME:-~/.config}/fish/conf.d/ardia.fish` instead. The login shell comes from `dscl` on macOS and
  `getent passwd` on Linux, else `$SHELL`.
- A version that is already current is a no-op. Two runs never overlap: each takes a flock on
  `$ARDIA_CLI_HOME/.lock` through fd 9 (`/usr/bin/lockf -s -t 120 9`; `flock -w 120 9` on Linux). The kernel drops it
  when the run exits, even on
  SIGKILL; a run that waits 120 s prints `error another install is still running`. Uninstall leaves the empty `.lock`
  file, since deleting a lock file other runs may have open would split the lock.
- Output for the app, one line each: `step resolve|download|verify|install|link`, `version <v>`, `path <rc file>`,
  then `installed <bin path>` or `uninstalled`, or `error <message>` with exit 1.

`$ARDIA_CLI_HOME` defaults to `~/Library/Application Support/Ardia/CLI` (on Linux
`${XDG_DATA_HOME:-~/.local/share}/ardia/cli`). The installed version is
`basename "$(readlink "$ARDIA_CLI_HOME/current")"`. Ardia on Linux installs the copy its package bundles, named
`ardia-cli-<app version>-linux-x64.tar.gz` (the name its engine's installer expects; ardia's
`scripts/release/official-plugins.py linux-cli` renames the pinned tarball), so there the folder is named after the app's
version and `ardia --version` prints the command's own. The CLI never updates itself. After switching `current` to a
new version, `install.sh` runs `current/bin/ardia skills refresh` (stdin, output and the lock's fd closed; its result
ignored), which brings the agent skill copies up to date.

## Build and release

`plugins/cli/scripts/build.sh <version> <out dir> [--platform macos-arm64|linux-x64]` writes
`ardia-cli-<version>-<platform>.tar.gz` and its `.sha256` (`sha256sum` format). The platform defaults to the host's
and must be the host's, since the build runs what it made. It holds three files and no Python or Rust:

- `bin/ardia`, the TypeScript command (`ts/src`) compiled by Bun 1.3.14 into one executable (`bun build --compile
  --minify`, with `.env`, `bunfig.toml`, `tsconfig.json` and `package.json` autoloading off, so the folder it runs in
  never changes it). axe-core and every other asset are embedded in it;
- `bin/ardia-libc.so`, the Node-API addon (`ts/native/ardia-libc.c`) for the libc calls Bun lacks. `bin/ardia` loads it
  from beside its own resolved path, so the link in `~/.local/bin` finds it; without it every command but `--version`
  exits 252 with one line;
- `libexec/esbuild`, the helper `ardia scripts` and userscripts bundle with (the npm `@esbuild/darwin-arm64` or
  `@esbuild/linux-x64` tarball, its version, sha256 and npm's sha512 pinned in the script, cached in
  `~/Library/Caches/ardia-cli-build` on macOS and `${XDG_CACHE_HOME:-~/.cache}/ardia-cli-build` on Linux);

plus an empty `.leases/` for `install.sh`. It needs Bun 1.3.14 and a C compiler (`xcrun clang`, or `cc` on Linux).

`plugins/cli/build.sh <out dir>` builds the plugin folder Ardia bundles (`<out dir>/cli`: the tarball's tree without
`.leases`, with `plugin.json` and, once `plugins/cli/main` exists, the manifest-v2 `dist/main.js` built from it), checks
it has no links (Ardia refuses them in a plugin's programs) and that `bin/ardia --version` says the version, and packs
it as `cli-plugin-<version>-<platform>.tar.gz` beside the tarball, each with its `.sha256`.

Sizes for the macOS build (TypeScript entry of 2026-11-20): `bin/ardia` 63.5 MB, `ardia-libc.so` 54 KB, esbuild
10.6 MB; the folder is 74 MB, the plugin tarball 28.3 MB. 0.4.0 with CPython was 42.6 MB and 15.2 MB: Bun's runtime is
most of the difference.

**Signing.** Nothing here is signed with a Developer ID; the Mach-Os stay ad hoc signed, as the toolchains leave them.
Ardia's release (`scripts/release/export-sign.sh`) signs every executable Mach-O and `*.so` in the bundled copy with
its Developer ID and `--options runtime`, inside out with the rest of the app, and notarizes it with the app.
`bin/ardia` runs under the hardened runtime with no entitlements: JavaScriptCore can't map JIT memory, so it runs on
its interpreter, `SharedArrayBuffer` is undefined (the code never uses it or `Atomics.wait`; sleeps go through
`Bun.sleepSync`), and `bun:ffi` crashes, which is why the libc calls are an addon. The addon must carry the same Team
ID as `bin/ardia`, or library validation refuses it. The macOS tarball for hand installs stays unsigned, as it always
was (`install.sh` clears its quarantine).

**Releasing** (`.github/workflows/cli-release.yml`): bump `version` in `plugin.json`, merge, and push the tag
`cli-v<version>` (the workflow refuses a tag that isn't `plugin.json`'s version). It builds with Bun on macOS (arm64)
and Linux (x86_64), checks each build says its version, carries the addon and esbuild, has no `python/` and no links,
and publishes the GitHub release `cli-v<version>` with `cli-plugin-<version>-<platform>.tar.gz`,
`ardia-cli-<version>-<platform>.tar.gz`, `install.sh` and a `.sha256` for each. Every pull request runs the same build
as a dry run, and `workflow_dispatch` runs it with `dry_run` (default on). It needs no secrets beyond the workflow's own
token.

Then in ardia: `scripts/release/official-plugins.py pin cli <version>` writes the release's SHA-256s into
`apps/browser/official-plugins.json`, and the next Ardia release bundles it.

## Test

Never against the real home. A hidden instance's plain DevTools port works with `--port`:

```sh
scripts/agent/ac launch <Ardia.app> --data /tmp/ardia-cli-test --onboarded
ardia browse --port <port> open https://example.com
ardia browse --port <port> get title
scripts/agent/ac quit /tmp/ardia-cli-test
```

The `ArdiaControl.json` path needs the app's token server: Chrome's plain server accepts `?token=` on the browser
socket but answers 500 on page sockets with a query. For the installer:

```sh
plugins/cli/scripts/build.sh 0.0.1 /tmp/ardia-cli-out
HOME=/tmp/ardia-cli-home ARDIA_CLI_URL=file:///tmp/ardia-cli-out/ardia-cli-0.0.1-macos-arm64.tar.gz \
  /bin/sh plugins/cli/install.sh
HOME=/tmp/ardia-cli-home ardia skills install --target claude-code
```

`ardia scripts test` needs a running instance; it reaches cross-origin iframes on both paths, and over `--port` also frames that show an extension's page. Install and the
helpers need the token path: an instance launched without `ARDIA_REMOTE_DEBUGGING_PORT` (the app doesn't start its
control server when the port switch is set) and with control on, for example a scratch dir whose `session.json` has
`"settings": {"cliControl": true}`, opened with `open -g -n --env ARDIA_BACKGROUND=1 --env ARDIA_DATA_DIR=<dir>`.
Unit tests (matching parity with node, import confinement, store rollback and recovery, symlink refusal; config
and theme commands against the schemas in `tests/fixtures`: a hand-written `config.schema.json` that uses every keyword
of the subset, and `theme.schema.json` as the app's `themeSchema` writes it; the Linux paths, the systemd unit
against a fake `systemctl`, and `install.sh` run end to end from `file://` tarballs in a scratch home in `tests/test_linux.py`): `python -m unittest discover -s plugins/cli/tests` with the locked dependencies
installed. On Linux, the installer:

```sh
plugins/cli/scripts/build.sh 0.0.1 /tmp/ardia-cli-out --platform linux-x64
HOME=/tmp/ardia-cli-home ARDIA_CLI_URL=file:///tmp/ardia-cli-out/ardia-cli-0.0.1-linux-x64.tar.gz \
  /bin/sh plugins/cli/install.sh
/tmp/ardia-cli-home/.local/bin/ardia browse --port <port> open https://example.com
/tmp/ardia-cli-home/.local/bin/ardia browse --port <port> get title
```

Any Chromium works for `--port`: `chromium --headless=new --remote-debugging-port=<port> --user-data-dir=<scratch>`.

A test that needs the Rust router or the TypeScript program skips when it isn't built, except where
`ARDIA_TEST_REQUIRES` (comma-separated: `rust`, `ts`) says the job built it: there a missing program fails the test.
CI (`.github/workflows/cli.yml`) sets it, so nothing that should run there is skipped silently:

| Tests | Job |
| --- | --- |
| `cargo test` (with the Python CLI for the listing check) | Rust, macOS and Ubuntu |
| `RustParityTable`, `RustProcess`, `RustClosedStdout`, and the Rust-only checks in `HarnessRules` and `HarnessCatches` | Rust (`ARDIA_TEST_REQUIRES=rust`) |
| `bun test` | TypeScript |
| `TsParityTable`, `TsProcess`, `TsClosedStdout`, `HarnessRules`, `HarnessCatches` | TypeScript (`ARDIA_TEST_REQUIRES=rust,ts`) |
| `ServedTable`, `ProtocolAgrees`, `BuildSmoke` | Rust, TypeScript and Python |
| every other `tests/*.py` | Python (`unittest discover`); the parity classes skip there, no program being built |
| `ProductionSigning` | none: it needs the Developer ID identity in the keychain, so it runs on a release Mac |

macOS-only checks (`sandbox-exec`, the argument size rule) run in the macOS legs.

### Rust parity

The command is moving from Python to Rust one command at a time (ardia-browser/ardia#2703). The Rust entry serves a
command only when `rust/served.txt` lists it, and lists it only when every parity case for it passes and at least one
of them ran natively; anything else, and any input the Rust code can't mirror exactly, goes to the bundled Python. A
case (`tests/parity/cases/*.json`, one row each) gives argv, stdin, environment, the starting files, the control
socket's replies (or no socket), consent and helper stubs; it may only name paths inside its sandbox and can't touch the
sandbox's own variables. `python -m tests.parity` runs each case on both sides in the same throwaway HOME, CLI home and
data dir, from a copy of `ardia_cli` and the test fixtures in scratch, with helpers stubbed on PATH. On macOS both sides
run under `sandbox-exec`: writes and Unix-socket connections stay inside the case's folder, there is no IP network, and
`launchctl`, `security`, `codesign`, `osascript`, `open` and the like can't run; reading the host's files and reaching
system services are still allowed. Elsewhere it runs only on a throwaway machine (`CI=true`, or
`ARDIA_PARITY_UNSANDBOXED=1`), relying on the case checks alone. Afterwards it kills whatever either side left running
that carries the case's folder in its command line or environment, or runs from the harness's own install. It compares stdout, stderr, exit code, each control-socket connection's requests (ids and
params as sent), telemetry, usage, the flush state, the files written (with modes) and the helpers started (each argument whole), byte for byte, with a diff
for each mismatch, and it knows which side served a call from whether the bundled Python's `ardia_cli.cli` was imported, not from telemetry. A
case marked `fallback` is one Rust must hand to Python; before handing off, the native side may have opened at most one
connection of its own, asking only read-only questions (`hello`, `workspace`, `windows`, `commands`); a second extra
connection, or one in a case not marked `fallback`, is a mismatch. `--command NAME` and `--case ID` narrow a run, `--keep` keeps both
sandboxes, and `--report` prints the table as JSON (per command: cases, passing, native, served) for a given commit.

A call started with fd 0, 1 or 2 closed, with stdout open read-only, or with fd 0, 1 or 2 open on a directory runs the
command in TypeScript: output to a closed stdout is dropped, a read-only stdout fails with `ardia <command>: Bad file
descriptor` (status 1). Python fails there at startup or crashes (`AttributeError` on a closed stdout, `OSError: [Errno
9]` and status 120 on a read-only one, `<stdin> is a directory, cannot continue` from CPython's `init_sys_streams`). A listing whose stdout later fails with anything but EPIPE ends as
Python's would after its traceback. Each line is written as CPython 3.13's `BufferedWriter` writes it (its buffer is
stdout's `st_blksize`): straight to the descriptor while what is left is at least one buffer long, then the shorter rest
through the buffer. A failure while writing straight leaves nothing behind, so the call prints the exception line and
ends with status 1; a failure writing the buffered rest leaves it in the buffer, which Python's exit flush tries again,
so the call prints the exception line, tries the rest once more and, when that fails too, prints
`Exception ignored on flushing sys.stdout:` with the second error and ends with status 120; bare `ardia` (help) follows the same rule for its whole text (on a hung-up Linux terminal,
whose `st_blksize` is 1024, that is status 1), `--version` prints both on a terminal and the second alone elsewhere. Telemetry records what Python's crash records, and records it first, before any of that is written to stderr, as Python's `telemetry.track` does before the interpreter prints the exception: a `$exception` event (`cli_unhandled`,
fatal, the `OSError` subclass and `[Errno N] text`) before the `cli_command` event, which carries exit code 1 and
`unhandled_exception`. A line on stderr that fails later (a closed pipe, a hung-up terminal) stays pending as it does in
Python's line-buffered stderr and is tried again before exit: a complaint that fails with EPIPE ends as Python's caught
`BrokenPipeError` does (`stdout_closed`, status 141), any other error as its crash (the two events above, then the
exception line), and a stderr still failing at exit makes the status 120, as Python's last flush does. Both entries ignore SIGXFSZ as Python does at startup, so a file-size limit gives `EFBIG`, not
death by signal; the router restores the caller's disposition before it execs Python, and the flusher starts with it at
its default, as Python's `subprocess` starts it. Like Python's `close_fds=True`, the flusher inherits no descriptor
above stderr, and the spawn itself sees to it rather than the caller scanning beforehand. On macOS the Rust entry starts
it with `posix_spawn` and `POSIX_SPAWN_CLOEXEC_DEFAULT` (with `POSIX_SPAWN_SETSID`, SIGPIPE and SIGXFSZ at their
defaults and an empty signal mask), giving it exactly the config pipe as stdin and `/dev/null` as stdout and stderr,
whatever the descriptor limits; Bun's macOS spawn, which the TypeScript entry uses, sets the same flag. On Linux the Rust
entry's child, after its stdio is set up and before it execs, calls `close_range(3, ~0U, CLOSE_RANGE_CLOEXEC)`, then
`close_range` without the flag (kernels 5.9 and 5.10), then marks what `/proc/self/fd` lists, and when all of those
fail scans up to the hard `RLIMIT_NOFILE`, capped at 2^20; only that last fallback, on a kernel older than 5.9 with
`/proc` unavailable, can miss a descriptor above a lowered hard limit. The TypeScript entry relies on Bun's Linux spawn,
which uses `close_range` and, when that fails (kernels older than 5.9), falls back to a scan bounded by the soft limit
that can miss a descriptor above a lowered limit. The flusher is detached but stays a child of the Rust entry, which never
waits for it, so while that call is still running (blocked on its output, say) a flusher that already finished shows as
a zombie until the call exits and it is reparented and reaped; it holds no descriptors meanwhile. Every command is TypeScript. `served.txt` lists each command label (the one Python records in telemetry: the
first one or two words after any shared flags, or a family such as `call *`) with `ts`; `scripts/build.sh` refuses a
row that says anything else, and `tests/test_parity.py` checks the table and, on the routerless install, that no parity
case is answered by Python. There is no router, no hand-back status and no Python in the package: an argv shape the
TypeScript side doesn't model prints `ardia: this command still runs on Python, which this build of ardia doesn't
include` and exits 1, and the parity table has no such case. What can still reach that line is listed under accepted
differences. The parity harness's routerless install puts a probe at `bin/ardia` that records the route and execs
`bin/ardia.bin`, the program, beside `bin/ardia-libc.so`, and still runs every case against the source tree's Python
for the expected output.

The TypeScript program does the few libc calls Bun lacks in-process, through a Node-API addon built from one C file
(`ts/native/ardia-libc.c`) that ships as `bin/ardia-libc.so` beside `bin/ardia`. `ts/scripts/build.sh`
builds both for one architecture (`--target bun-darwin-arm64` or `bun-darwin-x64`; a separate addon per architecture,
`-O2 -bundle -undefined dynamic_lookup -arch …` with clang on macOS, `-D_GNU_SOURCE -pthread -shared -fPIC` on Linux) and, given
`--node-headers`, checks the addon's own Node-API declarations against Node's official headers with the same per-platform flags. The `.so` name puts it
under the plugin signing rule for libraries, which signs it with the app's Developer ID and `--options runtime` whatever
its mode; the hardened runtime's library validation then loads it only into a program signed by the same team.
`ts/src/libc.ts` is the only module that touches it:

| Export | C call(s) | Why Bun can't | Used by |
| --- | --- | --- | --- |
| `peerUid` | `getsockopt` `LOCAL_PEERCRED` (`struct xucred`) on macOS, `SO_PEERCRED` on Linux | no socket credential API | `control.ts`: refuse a control socket served by another user |
| `interruptsIgnored` | `sigaction(SIGINT, NULL, …)` | can read no signal disposition | `main.ts`: leave an inherited ignored SIGINT ignored |
| `openAt` | `openat` (always `O_CLOEXEC`) | `fs` opens by path only | `privatefs.ts`: folders under an open folder |
| `openFileAt` | `openat` with `O_NONBLOCK\|O_NOFOLLOW\|O_CLOEXEC`, `fstat`, then `fcntl(F_SETFL)` to clear `O_NONBLOCK`; `null` when the name is not a regular file (one that opened, or a FIFO with no reader, `ENXIO`) | `fs` opens by path only, and a blocking open can't be interrupted | `privatefs.ts`: every private file (spool, local copies, usage, flush state, locks), never blocking on a FIFO; `null` becomes the `PathError` Python's `open_private_file` raises for a file that isn't regular |
| `mkdirAt` | `mkdirat` | path only | `privatefs.ts`: create `Telemetry`, `Local` and the usage folder |
| `renameAt` | `renameat` | path only | `privatefs.ts`: the temp-then-rename writes |
| `unlinkAt` | `unlinkat` (a name is a string or a `Buffer` of raw bytes, as for `sizeAt`) | path only | `privatefs.ts`: drop the spool and pruned copies |
| `sizeAt` | `fstatat(…, AT_SYMLINK_NOFOLLOW)` | path only | `privatefs.ts`: spool and local-copy sizes |
| `listAt` | what CPython 3.13's `os.listdir(fd)` does: `fcntl(F_DUPFD_CLOEXEC)` (sharing the folder's open file and its offset), `fdopendir`, `readdir` from that offset, then `rewinddir` and `closedir`; names as raw-byte `Buffer`s. So it sees what Python sees on every filesystem (on overlayfs, not a file made after the folder was opened) and leaves the offset where Python leaves it | no directory listing from a descriptor | `privatefs.ts`: prune the local copies |
| `lock` | `flock` | no `flock`; `O_EXLOCK` is Darwin-only | `privatefs.ts`: the same lock Python's `fcntl.flock` takes, on macOS and Linux |
| `strerror` | `strerror_r` (GNU form on glibc, XSI elsewhere) | Node's messages are libuv's, not libc's | `paths.ts`, `libc.ts`: every OS error text, as Python's `os.strerror` gives it on that platform |
| `writeSome` | one `write` (retried on `EINTR`), returning the bytes written or the error, with SIGINT at its default disposition for the duration unless it was ignored; `EAGAIN` comes back at once, so a non-blocking descriptor is never waited on | a synchronous `writeSync` blocked on a full pipe or a paused terminal can't be ended by Ctrl-C while Bun's own SIGINT handler is installed, and the caller needs to know how much was written to keep the unwritten tail as Python's buffer does | `libc.ts` (`writeWhole`), `printable.ts`, `main.ts`: help, `--version` and every line on stderr |
| `watchLifeline` | `fcntl(FD_CLOEXEC)`, a detached `pthread` blocking in `read`, `kill(getpid(), SIGKILL)` at EOF or error | a JS watcher can't run while the JS thread is blocked in a synchronous call | `main.ts`: end at once when the router dies |
| `accountHome` | `getpwnam_r`, growing its buffer on `ERANGE`; the home folder as raw bytes, or `null` for an unknown name | `os.userInfo` knows only the current user | `paths.ts`: `~name/…` in `--data-dir`, `ARDIA_DATA_DIR` or `ARDIA_CLI_HOME`, as `os.path.expanduser` reads `pwd` |

Every integer argument must be a number that is exactly a 32-bit integer, and a boolean a boolean; anything else throws
a `TypeError` or `RangeError` rather than being truncated or wrapped, and an export that opened a descriptor closes it if it
can't hand back the result. So nothing changes the working directory and no helper process runs: the private-file code follows Python's `dir_fd`
code call for call. The caller still comes from the router's marker, which already walked the process ancestry. The
program loads the addon from beside its own resolved path before it serves anything, `--version` included; if it is
missing, isn't a loadable library for this architecture, fails library validation or lacks an export, it prints
`ardia: can't load <file> (<reason>); reinstall ardia` on stderr and exits 252, never handing the call to Python and
never skipping the peer check. The parity harness signs both ad hoc with the hardened runtime, the program with only
`com.apple.security.cs.disable-library-validation`, since an ad hoc pair has no team for library validation to match;
`ProductionSigning` in `tests/test_parity.py`, run only where the Developer ID identity is in the keychain, signs both
with it, no entitlements, and lists windows through the pair.

`python -m tests.parity.record` seeds `tests/parity/cases/seeded/` from the Python tests: it runs them with the entry
points and the control client wrapped and keeps each in-process call whose replay in the sandbox gives the test's own
exit status, stdout and stderr, twice, for a command safe to run outside the test's mocks. It keeps only variables the
test set, and drops a recording that would carry a local path, the host name or an inherited variable. `tests/test_rust_parity.py` runs the whole
table, checks that `served.txt` lists only proven commands, that both sides speak the same control protocol, that the
harness refuses unsafe cases and catches a binary that hands everything to Python, and keeps the process checks
(Ctrl-C, leases, the flusher, paths that aren't UTF-8).

#### Help, usage and argument errors

The `argparse` row in `served.txt` covers what Python prints before a command runs, for every command but `browse`,
`notes` and `computer`'s own driver commands: `-h`/`--help` at any level, a command group run without its subcommand,
`ardia: --port needs a value`, `ardia: <command> doesn't take --flag`, an unknown or removed command, and every
argparse error (unrecognized arguments, an ambiguous or abbreviated option, a missing value or argument, an invalid
choice, int or float, `--timeout` out of range, two options of one exclusive group). `ts/src/argparse.ts` mirrors
CPython 3.13's argparse, textwrap and terminal width rule, and `ts/src/argparse-cli.ts` mirrors `cli.run` up to the
command's own code. The parsers aren't retyped: `python -m tests.argparse_specs` reads the live parser objects, on macOS
and on Linux, into `ts/src/argparse-specs.json`, and `bun test` fails when that file is stale. The same test runs about
twenty thousand generated argv per platform (options, typos, abbreviations, missing values, `--help` at every level,
`COLUMNS` of 40, 80 and 200 and odd ones) through CPython's parsers and the TypeScript ones and requires identical stdout,
stderr, exit status and parsed values. A command ported to TypeScript gets its values from `parseArgs(spec, argv)` or
`frontEndOutcome(argv)` instead of parsing argv itself. The parity harness expects the TypeScript entry to serve a case
whenever Python's own front end ends it before the command runs.

#### Accepted differences from the Python implementation

The native entries (the Rust router serving a row itself, and the TypeScript program behind it) match Python's exit
status, the lines Python prints on stderr for a failure (its final exception line and any `Exception ignored ...`
block) and the telemetry it records, except for these, each asserted by name in `tests/test_closed_stdout.py` and the
parity harness rather than stripped wholesale:

- The forms agents guess (`get attribute`, `-s`/`--selector` on `screenshot`, `get`, `click` and `fill`, `links`,
  `find role … --nth`) are TypeScript-only; Python answers them with Unknown flag or Unknown command. A `find role`
  that matches nothing names the closest match with its ref only in TypeScript. `select` retyping a field that already
  holds the value, picking a single whole-word match, and listing refs when ambiguous are TypeScript-only.
- A repeated `snapshot -i` prints only what changed (TypeScript); Python prints the whole list each time.
- The TypeScript daemon answers every exit 1 with a code (`command_failed` when the failure has none of its own),
  a failed `batch` adds `failed_step_index` and `failed_step_command` to the event, and telemetry's `flags` keeps the
  TypeScript-only `--touch`, `--isolated` and `--main-world` (parity cases mark these `intentional` with a
  `command_properties` entry: the `cli_command` properties TypeScript records instead of Python's).
- With a `MIMALLOC_*` variable set (in any case), Bun's own mimalloc reads it, so the diagnostics it prints on stderr,
  if any, are Bun's, not those of Python's bundled mimalloc.
- Python's traceback, the `Traceback (most recent call last):` header and its frames, isn't printed; the exception line
  and any `Exception ignored ...` block are. A `$exception` telemetry event carries the same type, value, mechanism
  and level, with an empty `stacktrace.frames`: the frames name Python's own functions and line numbers. So that event
  is shorter than Python's, and under a file-size limit it can fit where Python's write is cut short.
- A private file the CLI opens (the telemetry spool, a local copy, the usage file, the flush state, any of their locks)
  that is a FIFO: Python's open blocks until something opens the other end, forever if nothing does, and a Ctrl-C then
  ends it by KeyboardInterrupt. The native side opens it without blocking and treats it as Python treats a file that
  opened but isn't regular (`PathError`), so the call ends as Python's would have once the FIFO opened.
- Ctrl-C while stdout or stderr is blocked (a full pipe nobody reads, a paused terminal): Python raises
  KeyboardInterrupt, then blocks again flushing stdout as it exits, so only a second signal ends it, and it prints
  `KeyboardInterrupt` and an `Exception ignored on flushing sys.stdout` block. The native side dies by SIGINT at once and
  prints nothing more. A listing still ends as Python's does, with `ardia <command>: interrupted` and status 130.
- A telemetry spool write cut short (a full disk, a file-size limit): Python's `os.write` appends whatever fit, so the
  spool keeps a partial record that the next append joins, and neither line parses. The native side writes each append
  until every byte is in, and on any failure truncates the spool back to its size before that append, which it read
  under the spool lock; if even the truncation fails, the next append starts with a newline, so the fragment is a line of
  its own that readers skip. A rewrite of the whole spool (past 64 KiB) writes its temp file whole or removes it, so a
  cut spool is never renamed into place. Either way the cut events are dropped, as Python's are, and the spool still parses.
- Ctrl-C that lands between a listing's interrupt check and its next `write` to a stdout nobody is reading: same as
  CPython, not a difference in kind. The signal only sets the flag; it doesn't interrupt a `write` that hasn't started,
  so that write blocks until a second Ctrl-C or until a reader drains the pipe, and only then does the listing end
  with `ardia <command>: interrupted` and status 130. CPython has exactly this window between its signal check and the
  blocking `write` in its buffered writer, so no code closes it.
- `ardia browse`: a command that reads stdin (`eval`/`addinitscript --stdin`, `eval` with no code, `batch` with no
  steps) reads it to EOF before connecting, as Python does, so a writer slower than the daemon's 30 s request wait
  still works, and starts the session's daemon after it if none is running, as Python does.
  Stdin is read only up to the daemon's 16 MiB request limit, and a request over it (stdin plus the envelope) is never
  sent: the client answers what Python's client reports when the daemon drops it ("closed the connection before taking
  the command", exit 2) without waiting for the writer to finish. Stdin is passed
  as read: Python 3.13 reads it with `newline="\n"` on macOS, so CR and CRLF reach the daemon unchanged on both sides.
- `ardia browse`'s `cli_command` event: its `subcommand` is a known browse command name (the daemon's commands, the
  skipped ones, the help table's, their aliases, `auth`, `help`, `version`), `other` when the arguments don't parse, or
  `unknown`; an unrecognized name is never recorded. Python writes the typed name into its local copy and spool and maps
  it to `other` only when it sends. Tests: `subcommand.test.ts`; `KNOWN_COMMANDS` is generated from Python's own list
  and checked by `test_ts_browse_tables`.
- `ardia browse wait --state <state>`: the TypeScript client reads a `--state` after `wait` as `wait`'s own option, as
  the daemon does; Python's global parser rejects it as agent-browser's `--state <file>` launch option, so
  `wait --state` can't run on Python (plugins#18). Before the command, `--state` is still refused as a launch option on
  both. The AI plugin sends `wait --state=`. Tests: `json-intent.test.ts`, the grammar test's one recorded split
  difference, and the router's `json_requested` test.
- `ardia browse`: stdin over the daemon's 16 MiB request limit, or a request line the envelope pushes over it, fails
  before the client connects; Python's client connects, sends, and reports the daemon dropping it. Both answer "closed
  the connection before taking the command" with exit 2, but only Python's leaves the daemon a dropped connection
  (`test_ts_browse_plugin.JsonAndStdin.test_stdin_over_the_daemons_request_limit_stops_the_read_and_sends_nothing` and
  `test_a_request_the_envelope_pushes_over_the_limit_is_refused_before_connecting`).
- `ardia browse`: a daemon answer whose exit is 253 ends with status 1, as it did while 253 was the router's hand-back
  status. A real daemon never answers 253.
- `ardia browse`: the client starts the session's daemon itself when none answers, always the TypeScript daemon
  (`bin/ardia daemon`), and a side daemon for `busy_elsewhere` the same way. Every subcommand runs in the TypeScript
  client: the local ones (`auth`, `notes`, local `flow`, `plugin`, `read`, `session id`/`list`, `close --all`) as
  `cli.run_local` does, and `--out` as `outfile` does. Only the M3 harness's fleet client can start Python's daemon
  (`ARDIA_BROWSE_DAEMON=python`), for differential runs.
- `ardia browse`: the session key carries the build: `sha256(namespace, endpoint, session[, plugin], build:<stamp>)`,
  where the stamp is the version plus a hash of the TypeScript sources, baked in by `ts/scripts/build.sh`
  (`ARDIA_BROWSE_BUILD` overrides it, for harnesses). A client only ever reaches a daemon of its own build: after an
  update, the old build's daemon (or Python's, whose key has no stamp) is left alone under its old key until it idles
  out or `close --all` stops it, and the client starts its own. The daemon's `<key>.json` also records `build`, which
  `session list --json` shows.
- `ardia skills install --auto`, `ardia skills refresh` and `ardia computer refresh`, the afterUpdate commands Ardia
  runs after an update, stop when Ardia does (an intentional fix). On SIGTERM, SIGINT or SIGHUP they stop within a few
  milliseconds, and within 50 ms when the process that started them goes away (their parent pid changes, to 1 or a
  subreaper), which they check between steps and between the files of a skills folder. A step either finishes or is
  rolled back: a skills folder is swapped in whole or its staging folder removed, a half-downloaded cua-driver archive
  is removed, a CuaDriver.app copy is removed or its swap undone. Nothing else is written, and the command dies by the
  signal it got (SIGTERM for a lost parent). Python dies at once by SIGTERM and SIGHUP, leaving its staging folders,
  raises KeyboardInterrupt on SIGINT wherever it is, and keeps running, and writing, when Ardia quits. Test:
  `ts/tests/after-update-stop.test.ts`.
- `ardia browse batch`: an `eval` or `script` line keeps its code as typed (an intentional fix). Python shell-splits every
  batch line and eval joins the pieces with spaces, so `eval document.querySelectorAll("[title]").length` ran as
  `querySelectorAll([title])` (5 of 27 bench runs retried for it). The TypeScript daemon reads the code as the rest of
  the line after the command word and its leading flags; a single fully quoted argument loses only its outer quotes, and
  trailing `--timeout`, `--out`, `--max-output` (and eval's `--stdin`, `--main-world`, `--isolated`) stay flags. Other lines are
  split as before. Test: `ts/tests/batch-code-line.test.ts`.
- `ardia browse`: a value in an argument slot that takes user text is never read as a shared option: the user and
  password of `set credentials|auth`, the text of `fill` and `type`, `keyboard type|inserttext`'s text, and the values
  of `cookies set` and `storage <kind> set`. Python's parser takes a password like `--port=9222` there as `--port`
  (and then reports it in its usage error). Options anywhere else still work as before. The daemon's parser keeps the
  same slots opaque, so `fill #pw --port=9222` types `--port=9222`, and its `Unknown flag:` error names the flag without
  its `=value` (Python prints the whole token).
- `ardia browse`: usage errors about a shared option's value (`--port`, `--max-output`, `--idle-timeout`) name the
  option but never repeat the value, which may be a secret typed in the wrong place; Python echoes it.
- `ardia browse`: an answer that starts with a UTF-16 or UTF-32 byte order mark or a NUL byte is read as UTF-8, so a
  malformed one of those ends with a different exception line than Python's.
- `ardia browse` under `--json`: errors carry a code where Python's have none (see "JSON error codes"); these are the
  parity cases marked `intentional`.

The TypeScript CDP link (M3), which the browse daemon and `ardia scripts test` both use, differs from Python's in these ways, each covered by
`ts/tests/m3/link.test.ts`, `browser.test.ts` or the link scenarios (`docs/m3-harness.md`):

- The 256 MB message cap is checked once a frame has arrived, so the frame is already in memory; Python stops reading
  at the cap. Chromium is the only peer, and it never sends a frame over 268,435,456 bytes.
- No send-stall check: Bun's WebSocket shows no backpressure, so Python's "the browser read nothing for 30 s" can't be
  reproduced. A stalled browser is caught by the command's own timeout.
- A failed connection's detail text, shown only for an explicit endpoint (`can't connect to --port N (…)`): a refused
  port reads `Failed to connect` (Python: `[Errno 61] Connect call failed (…)`); a refused handshake reads
  `server rejected WebSocket connection (Expected 101 status code)` (Python names the HTTP status). Both raise the
  same `Unreachable` error with the same exit status. A URL the WebSocket can't open (a host with a space, a bad
  percent escape) reads `the endpoint isn't a URL a WebSocket can open (<invalid endpoint>)`, where Python reports the
  lookup's `[Errno 8] …`. An endpoint is only ever described by the scheme, host and port of a successful URL parse,
  else as `<invalid endpoint>`, so the session token and any user info never reach an error, a log line or telemetry.
- Once `close` starts, the connection is done for good: a later `open` fails with `connection_lost` and opens nothing.
- A malformed endpoint is refused with a fixed message that names the problem without repeating the URL's text: `the
  endpoint's port isn't a number`, `the endpoint's bracketed host isn't an IPv4 or IPv6 address`, `the endpoint isn't a
  ws:// or wss:// URL` (Python quotes the port, the host or the scheme). An endpoint is described only when the URL
  parser and Python's split agree on its host.
- A command with a timeout of zero, or one already cancelled, fails as a plain timeout or cancellation before anything
  is sent, mutating or not (Python reports a zero-timeout mutation as `outcome_unknown` though it never sent it).
- Each command is read once when it's sent: a method that isn't a string is refused, and the params are serialized once,
  so a getter or `toJSON` can't change what goes out or send a second command with the same id.
- `close` while the connection is still being set up ends it: the setup fails with `connection_lost` and no socket is
  left open. Python's setup would finish and keep its socket. A second setup started while one is running waits for
  that one instead of opening another socket.
- `Target.attachToTarget` and `Target.attachToBrowserTarget` always go through the attach bookkeeping (the 16-attach cap
  and the late detach), whoever sends them; the link refuses one sent any other way, before it reaches the wire.
- Frames Chromium never sends: a reply whose `id` is written `1.0` answers command 1 (Python ignores a float id); a
  message holding `NaN` or `Infinity` is dropped (Python accepts it); a binary frame must be UTF-8 (Python's
  `json.loads` also takes UTF-16 and UTF-32), else it's skipped, as Python skips one it can't decode; a text frame
  that isn't UTF-8 closes with 1003 (Python 1007), and both end in `connection_lost`.
- Cancellation is explicit: an abandoned command stops at its next CDP call or `sleep`, not at any `await`.

The TypeScript browse daemon itself (`bin/ardia daemon`, slice D2 of M3) keeps Python's files,
protocol and answers (`docs/browse-daemon-protocol.md`), except for these, each covered by `ts/tests/m3/daemon*.test.ts`
or the `daemon/*` harness scenarios:

- Its answers carry `"daemon": "ts/<version>"`; Python's carry none. Clients and telemetry tell the two apart by it.
- It checks its spawn config before it touches anything: a key that isn't 24 hex digits, a relative `data_root`, a
  session or namespace that isn't a session name, or a field of the wrong type ends it with exit 2 and
  `ardia-ts daemon: <what's wrong>` in `<key>.log`. Python takes such a config as it is.
- It enters `Browse/` by path and then checks that `.` is the folder it opened (same device and inode), where Python
  calls `fchdir` on the open folder. A folder swapped in between ends it with exit 2 (`the Browse folder changed while
  the daemon started`) before it binds anything.
- `<key>.log` holds JavaScript stack traces where Python's holds tracebacks; the line format
  (`<time> ardia_cli.browse <LEVEL> <message>`) and the redaction are the same. A `$exception` event it reports has an
  empty `stacktrace.frames`, as the other native entries' do.
- Cancelling a command during `Target.attachToTarget` detaches the session the late answer opens (plugins#11's attach
  rule, in the link); Python on this branch leaves it attached.
- Under heavy load it can resume a few milliseconds later than Python after a CDP reply, so the `load` event may
  already be in when it first checks, and the isolated world `open` would have made for its readiness probe is made by
  the next command instead. The harness's Ctrl-C comparison shows this as a request moving between steps; the answers
  don't change.

These are intentional: Python behaves the other way, and the TypeScript daemon fixes it.

- It never lets Bun own `<key>.sock`. Under the session lock it binds inside a private folder, `Browse/.<key>.bind/`
  (0700; one left by a crash is swept first), records the socket's device and inode, and moves it to `<key>.sock` with an
  exclusive rename (`renameatx_np` `RENAME_EXCL`, `renameat2` `RENAME_NOREPLACE`) that never replaces an entry created
  there meanwhile, checks the identity again, and removes the folder. So no client can find the socket before it is
  published, and closing the server can't unlink the path. At exit it unlinks `<key>.sock` (through the folder
  descriptor) only if the device and inode are still the ones it bound, compared exactly. A socket file someone replaced
  is left alone.
- Once `close` has marked the session closing, the rest of it (closing tabs, ending the daemon) runs to the end within
  its own 10 s deadline, even if the client goes away. Python cancels it there and strands the session, which then
  refuses every command until its idle exit.
- Shutdown deadlines are hard. Endpoint discovery (`/json/version`) honours cancellation and gives up after 3 s in all,
  where Python's 3 s applies to each socket operation, so a server that trickles bytes held Python forever. Shielded
  temp-tab work has its own 10 s deadline. Waiting for `tabs.lock` or `claims/.lock` gives up after 5 s with `lock_busy`;
  Python waits for as long as another process holds them. A native watchdog thread in the addon is armed the moment
  the daemon starts stopping, on every path (`close`, a signal, the idle exit, a lost connection), before anything else
  runs. 15 s later it exits the daemon (status 1) whatever JavaScript is doing, even stuck in a synchronous lock wait,
  after unlinking its own socket with the inode check; it touches no JavaScript, lock or log. Firing and disarming
  exclude each other (one atomic state, armed to firing or armed to disarmed): a clean exit disarms it only if it wins,
  else it waits for the fire, and the session lock is held until then, so no successor publishes a socket the fire might
  still unlink. If it can't be armed (a folder descriptor that isn't a folder, no thread), the daemon unlinks its socket
  with the same check and exits 1 at once instead of cleaning up unguarded. Log writes never
  block: stdout and stderr are made non-blocking at start, and a write that would block is dropped.
- An attach publishes its session only once `Page.enable` and the frame refresh have succeeded and the session is still
  attached; a crashed tab's session (which skips the enable) is published only if it is still attached. Otherwise the
  page stays unattached and needs enabling, and the half-made CDP session is detached. Losing the session or the tab
  during the enable is never swallowed, a lost connection while probing a crashed tab included, and nothing is
  published once the connection is gone. Python keeps the session id and skips the enable on the next command.
- A temporary tab is created at `about:blank#ardia-temp-<nonce>` (then navigated by its reader), with the nonce kept in
  its reservation in the tab registry until `createTarget` answers. An answer that arrives after its command was
  cancelled or ran out of time closes the tab (counted in the log); one that never arrives (the daemon stopped, or 30 s
  passed) leaves the reservation, and the daemon's `drain` at exit or the next connect's sweep closes any tab still
  showing that marker. Python creates the tab at plain `about:blank`, waits for the answer however long it takes, and
  drops the reservation on any failure. Openers aren't followed: a temporary tab opens nothing before it is recorded.
- A queued command's `caller` takes effect only once it holds the command lock, so it can't relabel the command that is
  running. Python sets it as the request arrives.
- `close` waits for the command lock at most as long as a command queued behind a `script` would (300 s), then answers
  `session_busy` and leaves the session as it was. Python waits without limit. The lock never hands itself to a waiter
  whose time ran out while the daemon was busy; that waiter gets its `session_busy`.
- Control-file discovery is checked for cancellation before and after it reads the file.
- The tab registry's instance for a `ws://` endpoint leaves out any user info, so `user:password@` never reaches
  `tabs-<hash>.json` (the hash is of that cleaned instance). Python keeps the user info in it.
- The client starts the daemon without `ARDIA_WS`, `ARDIA_PORT`, `ARDIA_CDP_URL` or `AGENT_BROWSER_CDP` in its
  environment, after moving the one the daemon would have used into the config's `ws` or `port`, read by the same
  parser the daemon's resolver uses, which is Python's `int`: surrounding ASCII whitespace or any non-ASCII Unicode
  space, a sign, underscores between digits and any Unicode decimal digit (`+9222`, `9_222`, full-width digits); the error
  quotes the value as Python's `repr` does. An `ARDIA_PORT` that
  isn't a valid port stays in the environment, so the daemon still reports it, even with `ARDIA_CDP_URL` set. The daemon writes the
  endpoint label without any query, fragment or user info, whatever the client sent.
- A request line may be 16 MiB including its newline; one byte more is dropped unanswered.

Its page core (slice D3: `browse/state/page.ts`, `state.ts`, `refs.ts`, `apptabs.ts` and the command table in
`browse/commands/`) follows `page.py`, `state.py` and `tabs.py`, except for these, each covered by
`ts/tests/m3/core*.test.ts`, the `core/*` harness scenarios or the human tier (`tests/m3/human_core.py`):

- It never sends `Runtime.enable` or `Debugger.enable` on a page session (ardia#2812 row 8). Python doesn't either
  unless console capture asks for it; in TypeScript that is the one opt-in path left (`Page.enableRuntime`, for slice
  D6), and the harness fails any TS run that sends either on a page session.
- The busy probe, sent before any command on a tab whose page stopped answering in the last 120 s, evaluates `1` in the
  `ardia-browse` isolated world (made first with `Page.createIsolatedWorld` when the document has none yet) instead of
  the page's main world, within the same 3 s. Before any frame of the tab is known it evaluates `1` without a context,
  as Python does, since there is no world to put it in. The harness compares it through the `busy-probe-isolated`
  divergence.
- Setup that a cancelled or failed command cut short after the session was published (`keepAwake`, the layout metrics,
  a setup restore) is done again on the tab's next use, `Page.enable` first. Python marks the tab ready and never
  finishes it; after a Ctrl-C during attach, its next `open --show` can time out on that half-made session.
- `tab active`'s fallback probe follows plugins#11: at most 8 probes at a time, a probe the attach cap refuses counts as
  not probed rather than inactive and is tried again in up to three passes (0.25 s, then 0.5 s apart), and tabs still
  unprobed after that end the command with `attaches_unanswered` instead of `no_tab`. Python on this branch probes all
  tabs at once and reads a refusal as inactive.
- Ardia's tab list (`windows`, for the app tab ids and following a replaced page) is asked over the control socket in
  one exchange with a 6 s deadline; Python allows 3 s to connect and 3 s for the answer.
- A ref resolves only to the backend node it was issued for. Python follows a ref whose page reloaded the same address,
  or whose element was redrawn, to the one node with the same role and name; TypeScript fails it as a stale ref, with
  the same `stale_ref` code, exit status and wording (naming the likely successor's ref), so a command never acts on a
  node it wasn't given. `followed_redrawn_ref` and `followed_ref_after_reload` never fire.
- A page call is bound to the document and frame its isolated world was made for. Each world gets a handle (one more
  `Runtime.evaluate` of `globalThis`, kept as its remote object id), and every call is `Runtime.callFunctionOn` on that
  handle rather than on a numeric execution context id, which Chromium can reuse in another process. Right after the
  handle is made, a `Page.getFrameTree` request (one more than Python sends per world) binds it to the loader the
  renderer reports, so a navigation whose event hasn't arrived yet can't hand the call a world in the new document. A renderer that no
  longer has the handle's document refuses it, and the call fails with `document_changed` (a read retries once in a
  fresh world). The frame's loader is also checked after the world is made, after the helper library goes in and right
  before the call is sent. An element from another frame is never re-homed into this frame's world. Python can run such
  a call on the new document. The harness compares the calls through the `world-handle` divergence, and its replay
  serves the handle from the recorded context.
- A lost connection is never read as an answer: a page title, a visibility check, the busy probe, the active-tab
  probe, the setup restore and the readiness poll after `back` and `forward` pass `connection_lost` on, where Python's catch-all reads it as an empty title, a
  visible tab, an inactive tab, lost setup (releasing the route claim) or a page still loading (polling until the
  command's timeout).
- Setup restored after a reattach is done in full or left to be done again: a cancel or lost connection partway keeps
  it pending, and the next use replays the steps not yet applied on that session. An init script whose registration is
  ambiguous (cancelled, timed out or answered with an unknown outcome) may be installed without its id, so the session
  is detached instead (`setup_session_dropped`) and the next use attaches a new one and replays everything; it isn't
  reported as lost setup.
- A tab that had crashed before the session attached keeps its CDP session as a handle for `reload` only; the session
  counts as attached once `Page.enable` and the frame refresh finish. A connection whose target discovery was cancelled
  or failed is dropped, so the next command connects and discovers again.
- When `set viewport`'s tab leaves its off-screen copy and the replacement tab fails to load, the replacement is closed
  and the session's tab, label and pin go back to the original (`offscreen_handoff_rolled_back`, counted only when the
  close succeeded). Every such close takes the tab registry's close reservation first, as the temporary-tab sweep does;
  a replacement whose reservation is refused, that Chromium won't close, or whose creation was answered after a cancel
  goes on the list of tabs the daemon keeps closing (each retry reserves again) and is handed to the next connect's sweep
  at exit. The command's own error is kept, with any closing error as its cause, and the answer reports it even when that
  cause is a lost connection (the session is still marked lost, so the next command gets `connection_lost`). Python leaves the session on the half-made tab.
- Two metric flags are TypeScript-only: `offscreen_handoff_rolled_back` (the rollback above closed the replacement) and
  `setup_session_dropped` (an ambiguous init-script registration detached the session). They count from the TypeScript
  client onward (M1, plugins#14), whose flag list carries them. While the Python client fronts the TS daemon, its
  `command_metrics.clean()` drops names it doesn't know, and the Python side is frozen, so neither is reported then.
- `dialog accept` and `dialog dismiss` send `Page.handleJavaScriptDialog` shielded from Ctrl-C, so the answer the
  user asked for always reaches the dialog. The request skips the busy probe: an open dialog blocks the page's
  scripts, so after a page call went unanswered (a `get title` behind a prompt) the probe can't be answered and Python
  fails `dialog accept` with `page_busy`, leaving the dialog open; TypeScript answers the dialog. When the browser
  rejects or doesn't answer the request, the daemon sends a dismiss (5 s deadline) and reports the first error. That
  dismiss is counted (`dialog_dismissed_after_failure`) only when it went through. A dismiss the browser also rejects
  leaves the dialog as the browser has it, and a lost connection skips the dismiss. Python sends the one request.
- `tab close` keeps the registry's close reservation only when the close succeeded: when `Target.closeTarget` fails,
  the reservation is released and the tab stays the session's, and after a Ctrl-C the tab goes on the list of tabs the
  daemon keeps closing (`tab_close_interrupted`). Python finishes the reservation either way, dropping the tab from the
  registry's opened list while it may still be open. After the Ctrl-C the session's tab is no longer that tab, and
  another `tab close` on it answers `tab_closing`. `tab new` and `window new` queue a tab whose creation was answered
  after a Ctrl-C for closing, as `set viewport` does; Python leaves it open.
- `tab new` and `window new` with global page setup (`--enable`, `--init-script`, `--capture-console`) answer
  `unsupported` until the init-script slice lands, as `open` does.
- Two more TypeScript-only metric flags, `tab_close_interrupted` and `dialog_dismissed_after_failure`, follow the rule
  for `offscreen_handoff_rolled_back` above.
- The caller counts as announced to Ardia's control socket only after the handshake finished, so a cancelled one is
  tried again by the next command; Python records it before. A cancelled active-tab lookup (`tab active`) ends its HTTP
  request at once.
- Capture and media (D6). Console and error capture is the one path that sends `Runtime.enable` on a page session
  (Chromium reports console calls only through it); `console` and `errors` start it (and `open --capture-console` once `open`'s page setup is served), the page
  can detect it, and it lasts until the session ends, as in Python. Its first notice says so: Python's
  "(Runtime is on for this tab until the session ends)" reads "(Runtime is on for this tab until the session ends; the
  page can detect this)" (design section 8; the harness's `console-detectable` rule). The transcript check allows
  `Runtime.enable` only in a scenario that asks for console capture. The rest:
  - A deliberate fix: when a cancel or timeout lands while `network route`'s or `set credentials`' `Fetch.enable` is
    unanswered, on a tab that had no route claim before, the daemon sends `Fetch.disable` (shielded, bounded at 2 s) and
    counts `route_enable_undone`. Python leaves interception possibly on with no handler, so the page's requests hang.
    The route handler is also registered before `Fetch.enable` is sent and stays registered after an unknown outcome
    (it's removed only after a definite refusal), so a request paused by interception that slipped past the
    `Fetch.disable` is continued rather than left hanging. Fault runs show the extra `Fetch.disable` and a page that
    keeps loading on the TypeScript side.
  - A lost connection is never swallowed: `network request` and HAR bodies, `network unroute`'s `Fetch.disable` and the
    screencast stop pass `connection_lost` on where Python's catch-all ignores it. `record stop` still closes ffmpeg's
    input and waits for it when that happens.
  - Numbers Chromium sends as whole floats (`1.0`) are written as integers in HAR and trace files and in stream frame
    metadata, because the CDP reply is parsed into JavaScript numbers. Values computed as floats by the command itself
    (a HAR entry's `time`, a selector screenshot's clip origin, `diffPercent`) keep Python's float spelling.
  - The stream viewer runs on `Bun.serve`: its Host, Origin, token, four-viewer and 64 KiB message checks and their
    status codes and texts are Python's; a plain HTTP request without a WebSocket upgrade gets 426 with our own text
    where the `websockets` package answers 400 or 426 with its own; a port already in use reports Python's `OSError`
    line. Frames a slow viewer can't take yet are skipped to the newest, as Python's single-slot waiter does. A
    message over 64 KiB ends the connection without a close frame (1006 at the viewer) where Python's `websockets`
    sends 1009. Python stops reading a viewer that sends input faster than it's applied (TCP backpressure); Bun can't
    pause one socket, so a viewer gets at most one input waiting for the command lock plus 32 queued: mouse moves past
    that are dropped, any other input closes it with 1008. `stream disable` and a viewer's disconnect cancel that
    viewer's queued input instead of waiting for it, so a command holding the lock never waits on its own stream.
  - A Ctrl-C during `record stop`'s wait for ffmpeg (up to 60 s) kills ffmpeg and ends the command; Python keeps
    waiting until ffmpeg exits or the 60 s pass.
  - A background route, auth or screencast-ack task that fails for a reason other than a CDP error ends quietly;
    Python's event loop logs "Task exception was never retrieved".
  - `a11y` uses axe-core embedded in the program (`ts/vendor/axe.min.js`, 4.10.3, the version and checksums
    `scripts/build.sh` pins for Python, recorded in `ts/vendor/axe.json` and checked by a test); it never looks on disk.
  - Live input from a stream viewer (`stream enable --input`) is tracked and released by the act slice's input model
    (D5); until it lands the daemon still sends the events, under the command lock, but can't release held keys.

Its read side (slice D4: `browse/snapshot/collect.ts`, `take.ts`, `browse/read/`, and `get`, `is`, `find`, `read`,
`diff`, `vitals`, `storage`, `cookies` and `state` in `browse/commands/`) follows `snapshot.py`, `readpages.py`,
`pagedata.py`, `pdftext.py`, `readurl.py` and `commands.py`, except for these, each covered by
`ts/tests/m3/read*.test.ts`, the `d4/*` harness scenarios or the human tier (rows 12 and 13):

- A selector that matches nothing in the document is looked for in the page's open and closed shadow roots (ardia#2812
  row 12), for `get`, `is`, `snapshot -s`, `read -s` and `get count`. Python fails with `not_found` there, and its CSS
  selectors don't reach into open roots either; this one matches in both, as a person sees both. The frame's document
  is read with `DOM.describeNode` (`pierce`, from the isolated world's `document`), which leaves the DOM domain off, so no
  DOM events follow; every root is resolved into the isolated world at once and searched with the same selector syntax,
  each element counted once even when roots nest (an open root inside a closed one). It runs on the first poll of a
  wait, then every fifth poll of `get`'s 3 s wait (every second of `read -s`'s 5 s wait) and on the last, so an element
  in a closed root is found at once (measured: 0.01 s, where running it only on the last poll took 2.9 s). User-agent
  shadow roots (inside `<input>`, `<video>`) are never searched. Counted as `selector_in_shadow_root`.
- Out-of-process iframes are read (rows 13, 21). Each page session sends `Target.setAutoAttach` (flattened, iframes
  only) after `Page.setLifecycleEventsEnabled`, and each iframe session does the same for its own iframes. The iframes'
  frames join the page's frames, and a world, a page call, an element lookup or an AX tree for one of them goes to its
  own session. `snapshot` puts an out-of-process iframe's AX tree under its `Iframe` node, at any depth, where Python
  only expands same-process frames one level down (`snapshot_oopif_frames`). `read` of the session's tab appends the
  text of each out-of-process frame below the one it reads (three levels at most) that passes the library's own rules
  (at least 120×80, not an ad or a captcha), as `[frame "<title>"]` … `[end of frame "<title>"]` after the page's text
  (`read_oopif_frames`). The library's `[frame "…" from another site, not read here: read <src>]` line still shows for
  a large one. A crash or detach in an iframe's session leaves the page alone. Python sees none of these frames.
  `oopif_attach_refused` counts a policy that refuses the auto-attach.
- `read --http` verifies TLS with Bun's bundled Mozilla roots, plus the certificates in `SSL_CERT_FILE` and
  `NODE_EXTRA_CA_CERTS` when they name readable files. Python's bundled OpenSSL reads `/etc/ssl/cert.pem`, which lacks
  some roots in use (example.com's chain), so the 0.3.0 plugin's `read --http https://example.com/` fails where this
  succeeds. A fetch error's reason reads `[Errno 61] Connection refused`, `[Errno 8] nodename nor servname provided, or
  not known`, `timed out` or `[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: <code>`. Other reasons are
  Bun's own text. Python's timeout is per socket operation; here it is reset by each chunk read and by each redirect.
- A page's charset is decoded with Python's codec registry (`ts/scripts/gen-codecs.py` writes every name `bytes.decode`
  accepts, and every single-byte codec's table, from CPython 3.13). Names, spellings, single-byte codecs, UTF-8, UTF-16
  and UTF-32 decode exactly as Python's `errors="replace"` does, and an unknown or non-text codec fails with Python's
  `LookupError` text. The CJK multibyte codecs (Shift JIS, EUC-JP, ISO-2022-JP, GBK, GB18030, Big5, EUC-KR and their
  Python variants), `utf-7`, `unicode-escape` and `punycode` decode with the closest WHATWG decoder (UTF-8 for the last
  three), so invalid bytes and the few characters those tables map differently can differ. `idna` and `undefined` fail
  as Python's do.
- A failing file read or write (`diff snapshot --baseline`, `cookies set --curl`, `state save|load`) fails with Python's
  exception line (`FileNotFoundError: [Errno 2] No such file or directory: '<path>'`). A file that isn't UTF-8 or a
  state file that isn't JSON reads `UnicodeDecodeError: 'utf-8' codec can't decode the file: invalid utf-8` or
  `JSONDecodeError: Expecting value: line 1 column 1 (char 0)`, without Python's byte position.
- A snapshot names clickable elements (`ardiaBrowse.clickables()`) with one page call per frame: the frame's isolated
  world keeps each element's backend node id it has been told in a `WeakMap`, so only elements it hasn't seen yet are
  described (`DOM.describeNode` each, or one `DOMSnapshot.captureSnapshot` for 16 or more where the engine allows it,
  matched by element order, tag, id and count, and kept only when no element was added, removed or moved while the
  snapshot was taken, else falling back), and the same call returns the main
  frame's title. The change report's `text:` marks are resolved the same way. Before this, every snapshot and every
  action's two views described every clickable element again (77 calls for one Wikipedia article).
- A change report reuses the frame tree it read in the last 0.75 s unless a frame navigated, detached or attached since
  (`Page.getFrameTree` used to run four to ten times per action); a world it creates checks the tree again.
- A snapshot records each frame's document (its loader) when it reads that frame's tree, and checks it again before it
  names clickable elements, before it reads field values and before it hands out refs. If a document changed in
  between, the snapshot fails with `document_changed` (`snapshot_document_changed`) instead of mixing two documents' refs.
  Python goes on and can hand out refs into a document that is gone.
- A command on a frame whose out-of-process iframe went away (its session detached, or Chromium no longer knows the
  session) fails with `frame_gone`, not `tab_detached`; the tab's own session stays attached.
- `read --http` stops at a redirect to anything but `http:` or `https:` (`file:`, `data:`, …) and answers as Python's
  urllib does, with the redirect's own status and no body; the first URL must be `http:` or `https:` too.
- `read --http` sends a URL written with Unicode as a URI (IDNA host, percent-encoded path and query, through WHATWG
  `URL`), redirects included, and reports it as given; Python's urllib raised `UnicodeEncodeError`, which ended a
  whole multi-URL read (FB-A2CU, FB-5QSW). A body that isn't text (a known binary type, image, audio, video, font, archive or office format (playlists and `model/*` read as text), or any other non-text type whose body
  holds a NUL byte or invalid UTF-8; `text/*`, JSON, XML, JavaScript, `+json`/`+xml`, playlists and a declared UTF-16/32
  charset always read as text) is never
  decoded: with `--out` (alone or on a `batch` line) the body's bytes are saved byte for byte (after HTTP content decoding, so a gzipped response saves unzipped), up to 8 MB (`read_binary_saved`); a PDF too; they travel in the answer's `body` field, outside the redacted text, and only for the `read` that carries `--out` (`out_body`), not a `read` inside a `script --out`,
  where Python wrote the decoded text with U+FFFD in place of every invalid byte (FB-8EJR). Without `--out` the page
  fails with `binary_body` and says to save it; a response over 8 MB with `--out` fails with `result_too_large`
  rather than saving part of it, and a single URL given on stdin saves the same way. A `--json` read where some pages failed prints its `success: true`
  payload with exit status 1, where the client used to wrap the whole payload as an `internal_error` string (other
  commands' `success: true` answers with a non-zero exit are still coded). A single `read --http /path` resolves
  against the session's tab, where it used to fetch `https:///path`.
- `read`'s reader tabs are D2's marked temporary tabs (`about:blank#ardia-temp-<nonce>`). The harness compares them
  through the `temp-tab-marker` divergence.

Its act side (slice D5: `browse/act/`, `browse/input/{input,mouse,keyboard}.ts`, `browse/changes/observe.ts` and the
commands in `browse/commands/act.ts` and `batch.ts`) follows `actions.py`, `inputs.py`, `human.py`, `changes.py`'s
observer, `react.py` and `batch`, except for these, each covered by `ts/tests/m3/act-ported.test.ts`, the `act/d5_*`
harness scenarios or the human tier (`tests/m3/human_act.py`):

- Editing commands on `Input.dispatchKeyEvent`: as in Python, Control or Meta with a, z, y and Shift+z send `selectAll`,
  `undo` and `redo` on every platform, so `press Control+a` still selects all on a Mac. On macOS every other editing
  shortcut also carries its command (ardia#2812 row 20): Meta with c, x and v (`copy`, `cut`, `paste`), Meta and Alt
  with the arrows (line and word movement, with `AndModifySelection` under Shift), and with Backspace and Delete (line
  and word deletion); Linux and Windows send only Python's three. The harness compares this through the
  `editing-commands` divergence and fails a TS run that sends a macOS Meta shortcut without its command.
- `click --touch` (new) taps only when the page itself reports touch (`navigator.maxTouchPoints` above 0 and
  `ontouchstart` present, so whichever client turned emulation on); otherwise it is a mouse click and the answer says
  so (ardia#2812 row 1). No other command sends a touch event, and the harness fails a TS run that sends one before
  touch emulation or that probe.
- A click, hover, tap or drag first makes one page call in the element's frame (`PREPARE_ACTION` in `browse/act/pointer.ts`):
  whether it is still in the page and disabled, the frame's size, whether it sits outside its frame's view or a
  clipping scroller (then it is scrolled to the middle, instantly), whether it or an ancestor is animating, and the
  cover check at the aiming point, measured in that frame's own coordinates as a fraction of the element's box, so a
  frame's offset, scroll, border, padding, CSS zoom or transform can't move the tested point (FB-4XLZ: a button in a
  same-origin iframe of a zoomed or transformed page was refused as covered by the text above it). The click goes to
  that same point: in the main frame as measured, and inside same-origin frames carried up through each frame owner's
  box in the page (`DOM.getContentQuads` leaves out an ancestor's CSS zoom). `DOM.getContentQuads` is used instead
  when the page is pinch-zoomed, inside a cross-origin frame, under a frame owner with any transform other than a
  plain positive scale and move (a rotation, skew, mirror, 3D transform or `rotate`/`scale` property), and to wait for a
  moving box: that 50 ms wait, with its second `DOM.getContentQuads` and a fresh page call, runs only when the element
  was scrolled or is animating (`waited_for_box_to_settle`). The same call takes the frame's input counts that the click's delivery check starts
  from, and its `document.visibilityState`, which the visible-tab check reuses for 0.25 s.
- Element boxes, hit tests and frame offsets go through `browse/state/frames.ts`: an element inside an out-of-process
  iframe is measured in its own CDP session and placed at the sum of each frame owner's offset up to the top session,
  where the click is sent (ardia#2812 rows 12, 13, 21). Python has no out-of-process frames. The offsets come from D4's
  `state/offsets.ts` (`get box` uses the same helper), and each frame owner is measured in its parent's own session. An element inside a
  shadow root, closed ones included, isn't "covered" by its own host: when the cover check names something, the click
  point is tested again through each shadow root from the element out to the document, and the click goes ahead if
  every level hits the element or the host holding it. Python refuses such a click as covered by the host.
- A command's whole-number coordinates and deltas go out as JSON integers (`91`), where Python's floats print `91.0`;
  Chromium reads both the same. The harness compares them as equal (`whole-floats`).
- `batch` reads a line's `wait --state` as `wait`'s own flag, as the TypeScript client does; Python's splitter refuses
  it as a launch option. A line's own `--out` saves the text of `get` and `snapshot`; for `eval`, `read` and `script`
  it answers that the save isn't served yet.
- Every mouse event goes through the page's own send, like keys and touches, so it gets the busy probe, the crashed and
  detached checks and the unanswered-call memory, and a humanized move waits for each `mouseMoved` answer before the
  next: at most one input event is ever outstanding. Python sends a humanized path's moves without waiting for their
  answers (pipelined), so its pages can see coalesced moves the TypeScript daemon doesn't produce. Measured on headless Chrome for Testing 158 at load 5 (n = 20 each, interleaved): a humanized `mouse move` takes the same time (median 983 ms against 993 ms pipelined, since the path follows the clock) and sends fewer moves (median 47 mouse events against 69).
- A tap's finger counts as held from just before `touchStart` until `touchEnd` is answered, so a command cut short in
  between lifts it with `touchCancel`, as held keys and buttons are released. A release that runs out of its 2 s is
  cancelled, as Python's `wait_for` cancels it, so no earlier key up or button release is still awaited when the next
  command's input starts; daemon shutdown also waits (at most 5.5 s) for an unfinished drag cleanup.
- Page calls go through `Runtime.callFunctionOn` on the isolated world's handle, with one exception, as in Python:
  `react` evaluates in the page's main world with `Runtime.evaluate`, since React's devtools hook lives on the page's
  `window`.
- The drag's interception cleanup, the network watch's `Network.disable` and held keys and buttons run under
  `shield()` and finish before the command answers, also when it is cancelled or cut short, as Python's do; the harness
  compares the cleanup traffic at every CDP call of `act/d5_drag_scroll`'s HTML5 drag.

Its scripting, flows and raw-access commands (slice D7: `browse/commands/{pagejs,settings,cdp,notes}.ts`,
`browse/script/`, `browse/flows/`, `browse/auth/`, `browse/cdp/{raw,params}.ts`, `notes.ts`) follow `script.py`,
`flows.py`, `flowrun.py`, `flowlog.py`, `vault.py`, `plugins.py`, `notes.py` and plugins#11's `cdp`, except for these,
each covered by `ts/tests/m3/d7.test.ts`, the `d7.*` function oracle (`tests/m3/oracle_fns_d7.py`) or the `js/*`
scenarios:

- `eval` and `wait --fn` run in the page's main world by default, with Python's exact `Runtime.evaluate` (no
  `Runtime.enable`, no context id), and `--main-world` is accepted and changes nothing. `--isolated` opts into the
  `ardia-browse` isolated world (ardia#2812 rows 8 and 9): `Runtime.callFunctionOn` on the world's handle with
  `function (source) { return (0, eval)(source); }`. There the page's DOM is the same, its own JavaScript globals
  (`window.app`, a framework's store) aren't there, and nothing the code defines leaks into the page. A
  `ReferenceError` under `--isolated` adds a line saying so (`eval_isolated_reference_error`); the wrapper's own stack
  frames are taken out of an error, so it reads as Python's does. `clipboard read` always uses the isolated
  evaluation. Python has neither flag. The harness compares the isolated form through the `eval-isolated` divergence.
- `script`'s controller lives in the isolated world of its temporary tab: it is installed with
  `Runtime.callFunctionOn` on the world's handle and returned by reference, and its worker is started from there, so
  neither `__ardiaScript` nor the worker is visible to a page (`script-isolated` divergence). Every later controller
  call is Python's, on the controller's own object id. `page.evaluate()` and `page.eval()` inside a script are `eval`, so
  they run in the page's main world, as in Python.
- `cdp`, `eval`, init scripts and the raw session per tab and per browser follow plugins#11 (full-control/cli
  3917106), which isn't on main yet: its params checks, timeouts, `result_too_large`, `borrowed_tab`, the 16-attach cap
  and the `using` hold on `--target` tabs. Integers in `cdp` params are sent exactly, past 2^53 too, as Python sends them.
- `set permission geolocation|notifications|camera|microphone|clipboard` is new (ardia#2812 row 14): it grants the
  permission to the tab's origin with `Browser.grantPermissions` ahead of any prompt (`permission_granted`). A prompt
  already on screen isn't answered; that needs Ardia's control socket to offer it. Python has no such setting and
  answers `Unknown setting: permission`.
- The flow log, the hinted sites and the raw sessions live beside the session's state, not in Python's `extras`
  dictionary: nothing outside these modules can see or change them.
- Keychain and plugin processes are started without a shell, from an argv array, and the Keychain secret goes only to
  `security -i`'s stdin, as in Python. How a helper is stopped at its deadline is below.
- `auth save`'s and `auth login --url`'s URL must have a host: `https://` alone is refused as not an https origin,
  where Python takes it as the origin `https://`.
- Plugins and credential providers get only `PATH`, `HOME`, `LANG`, `LC_*`, `TMPDIR`, `USER`, `LOGNAME` and `SHELL` from
  the daemon's environment; Python passes everything but `ARDIA_*` and `AGENT_BROWSER_*`.
- A credential provider's reply for `auth login` is checked strictly before anything uses it: the process must exit 0,
  `success` must be the boolean `true`, `password` a non-empty string, and `url`, `username` and the three selectors
  strings or absent (an explicit `null` is malformed). `url` must parse as a URL with a non-empty host and no user
  info, https (http only for localhost) with a valid port; a selector must be non-blank, at most 1,000 characters,
  with no control or format character (Unicode Cc, C1 included, and Cf). Anything else reads
  `Credential provider <name> sent a malformed reply`, and a `success: false` reply or a nonzero exit
  `Credential provider <name> returned an error`: the provider's own text, the item and the reply are never repeated.
  Any later failure of a provider login reads `Credential provider <name>: the login didn't finish (<code>)`, built
  from fixed text and one of the daemon's codes only.
  Python echoes the provider's `error`, `protocol` and item. Python's `plugin run <name> credential.read` keeps its
  own messages and environment (it is frozen); the TypeScript client's `plugin run` (M2) must apply the same
  boundary.
- Keychain, plugin, `git` and `npm` processes run in their own session and process group. At the deadline or on a
  cancel the call ends at once, and the group gets one SIGTERM, whether or not the process the daemon started has
  already exited, so anything it left behind is stopped too; 0.5 s later it gets one SIGKILL if `kill(-pgid, 0)`
  still finds any member, whatever its pipes did in between. After that, or once the group is gone, it is forgotten
  and never signalled again. A group id can't be handed to a new group while a member of ours is alive, so the only
  residual is our group emptying and its id being recycled into a new group within that 0.5 s. When the daemon exits,
  every group whose run hasn't settled (its output still open, or its result not yet delivered) or that is still inside
  that window is killed synchronously, whether or not its first process has exited; the native shutdown watchdog
  does the same from the addon's own list of live groups before it calls `_exit`. A run that settled normally is
  forgotten at once and never signalled: a process it left behind that closed our pipes is left alone, as Python
  leaves it. The native list holds 256 groups; a group it can't take is still tracked and killed by the daemon's own
  exit, but not by the watchdog, and is counted (`groupStats.unregistered`). Python kills only the process it started.
- `clipboard` and `set permission` grant each permission with `Browser.setPermission`, so grants add up; Python's
  `Browser.grantPermissions` replaces every grant the origin had (a clipboard grant revoked geolocation). The harness
  leaves both out of the comparison through the `permission-overrides` divergence (ardia#2812 row 3).
- An `--init-script` file is opened without blocking and must be a regular file; at most 4 MB is read from it, whatever
  its size said when it was opened, and more than that is refused with `bad_init_script`, as is a FIFO or device.
  Python reads whatever the path names and can block on a FIFO. It is decoded as
  Python's text read decodes it: a BOM kept, CRLF and CR made LF.
- Passwords never enter output, by construction rather than by masking: nothing is substring-redacted for them.
  `set credentials` and `set auth` take the user and password as opaque positionals, never parsed as flags, so
  `-x` or `--foo` is a valid password; their usage error prints only the expected form (`Usage: ardia browse set
  credentials <user> <pass>`), never the arguments. Python parses them as flags and answers `Unknown flag: -x`.
- A `script` that fails in a call names it by its index and the command the parser resolved, never the call's text
  or arguments (`line 2: … (in call 3, \`set credentials\`)`, `unknown command` when it names none), and its `data`
  carries `call` and that `command`; a timed-out script names the call the same way. A single-string call that can't
  be split (an unclosed quote) fails with `that call couldn't be parsed`, and a call naming no command with `unknown
  command`; neither repeats the call. Python answers `Unknown command: <the call's text>`.
  Python quotes the call's arguments.
- An answer's `code` (and so the client's telemetry `error_code`) is always one of the daemon's own codes; anything
  else, such as a code a script throws, becomes `failed` (`script_failed` for a script). Python passes a script's code
  through.
- Flows save URLs, query strings included, as Python does, so a site that puts a secret in a URL has it saved in the
  flow. User info (`user:password@`) is never kept: a URL carrying it is dropped from the flow, and a page URL is saved
  without it.
- The temporary tabs D2 opens carry `#ardia-temp-<nonce>` in their `about:blank` URL; the harness's `temp-tab-nonce`
  rule compares them with Python's plain `about:blank`.

- `ardia call`, `methods`, `run`, `events`, `apply` and the `tabs` and `groups` verbs read their arguments with narrow
  parsers for the shapes argparse reads one way. Any other argv (help, a usage error, an abbreviated option,
  `--opt=value` on a switch, a split positional run that Python 3.13 still accepts) is read by M2-F's argparse
  (`ts/src/argparse.ts`), which prints exactly what CPython's argparse prints, before anything is sent.
- An `ardia run` whose `commands` catalog, or whose command's `variants`, is a number or `false` (not something Python
  can iterate): Python crashes with a `TypeError` traceback while building the "did you mean" hint, after Ardia has
  already refused the command. The TypeScript side prints Ardia's refusal without a hint and exits 1.
- `ardia apply` replies whose `tabs` or `results` Python can't read (a number for the list, a result that isn't an
  object, an id that is a list, an object or a float): Python crashes with a traceback after the batch ran. The
  TypeScript side prints each result as text instead, then the usual summary.
- Method errors whose `code` or `message` is an object or list holding non-ASCII text: Python prints its `repr`; the
  TypeScript side prints the JSON (`{"a": "é"}` rather than `{'a': 'é'}`), after the method ran, so it can't hand back.
  An event field of that shape in `ardia events` text output is shown the same way, and a `time` outside what a
  JavaScript date holds (beyond ±8.64e15 ms) shows `--:--:--` where Python fails to convert it.
- `ardia apply` reading stdin that isn't UTF-8, in a locale where Python reads stdin with `surrogateescape` (`C`, `POSIX`,
  `C.UTF-8`, `UTF-8` or none set): when the bytes sit inside a JSON string, the JSON parses and Python crashes with a
  `UnicodeEncodeError` traceback while sending the batch. The TypeScript side prints `that isn't JSON ('utf-8' codec
  can't decode ...)`, as Python does in a UTF-8 locale, and sends nothing. Bytes outside a string give Python's own JSON
  error in either locale.
- `ardia apply` with JSON nested deeper than about 9,994 levels: Python crashes with a `RecursionError` traceback. The
  TypeScript side prints `that isn't JSON (maximum recursion depth exceeded ...)` and exits 1. `ardia call` params at that
  depth give Python's own `is nested deeper than 64 levels` either way.
- An error code Ardia sends that isn't one the control socket documents (`bad_request`, `unknown_method`,
  `unknown_command`, `refused`, `no_window`, `failed`, `unsupported_protocol`, `password_manager_plugin`) is recorded
  in telemetry as `other` by `tabs`, `groups`, `apply` and their verbs, as `ardia call` already did. Python records any
  lowercase code as given, so text Ardia put in the code could reach telemetry.
- One deadline covers sending a request and waiting for its answer, and the connection closes when it passes. Python
  waits without a limit while a large request is still being written to an Ardia that stopped reading, and starts the
  answer's deadline only once it's written; an Ardia that stalls past the whole timeout now gets `didn't answer ... in N
  s` instead of an answer that came late.
- `ardia events` after Ardia sends a line nested too deeply to read: Python's reader stops and the command waits
  forever. The TypeScript side prints the events read before it, then `ardia: ... (Ardia sent a line nested too
  deeply to read)` and exits 2. Its events queue also drops the oldest events once the waiting ones take more than
  32 MB, counting each raw line and its parsed form, besides Python's cap of 1,000 events.
- Any control call waiting when Ardia sends a line nested too deeply to read fails at once with that reason, and so
  does any call made afterwards on the connection; Python's calls wait out their timeout.

- `ardia browse plugin run` (TypeScript) goes through the credential-provider boundary: the plugin gets only `PATH`,
  `HOME`, `LANG`, `LC_*`, `TMPDIR`, `USER`, `LOGNAME` and `SHELL`, runs in its own process group that is killed on a
  timeout or Ctrl-C, and its reply must be an object of exactly `protocol`, `success`, `data` and `error` with `success`
  `true` and exit status 0. A failure reads `Plugin NAME returned an error` or `Plugin NAME sent a malformed reply`
  (error code `plugin_failed`). Python passes the plugin's own error and protocol text into its message and accepts
  any truthy `success`, which lets a plugin put arbitrary text in front of the agent.
- What the TypeScript side still doesn't model ends in `ardia: this command still runs on Python, which this build
  of ardia doesn't include` (exit 1) instead of Python's output. Every case is input that only Ardia or a shipped file
  produces, or a test-only variable: a `methods` or `plugins` reply whose rows aren't the shapes Ardia sends (a method
  name that isn't a string, a plugin row without a name, contributions or problems that aren't lists), a control call
  that ends in a reply the port can't read, a shipped schema or manifest maximum of the wrong type, a regular
  expression in a shipped schema with no exact JavaScript equivalent, a plist value with control characters for the
  LaunchAgent, an `ARDIA_FEEDBACK_URL` with a line break, and an environment path or working directory that isn't valid
  UTF-8 (Python reads those with surrogateescape). Under `ARDIA_BROWSE_FOR_PLUGIN` the same shapes are refused with
  `plugin_refused`.
- `plugins check` on a manifest 2 (TypeScript) runs Ardia's own manifest checker, vendored unchanged from ardia's
  `apps/browser/src/lib` into `ts/src/app-manifest`, after the schema, plus the manifest-only app rules driven by the
  schema's `x-ardia-rules` (approved settings, hooks that need tabs) and `contributes.settings.defaults` against
  config.schema.json. Python checks a manifest 2 only against the schema and two rules (main or sidecar, not both;
  activationEvents only go with a main), so it can call ok a manifest Ardia refuses. Neither side checks what depends on
  the running app: built-in-only keys (`alwaysOn`, `official`, `autoInstall`, `afterUpdate`), the app version and the
  app's current settings.
- `plugins install` (TypeScript) copies a plugin folder by descriptor: each folder and file is opened without following
  links, and a link, FIFO, socket or device met during the copy fails the install with the same message Python gives for
  a link found beforehand (or `isn't a regular file or folder` for the others), with the size cap counted as it copies.
  The finished copy is walked once more before it's published and refused if it holds a link, a special file or a
  hard-linked file. Python checks for links in one pass and then copies with `copytree`, which recreates a link that
  appeared in between, and it copies FIFOs and devices.
- A schema `pattern` with `\w` or `\d` outside `re.ASCII` (the theme checks) is matched with the JavaScript engine's
  Unicode tables, which may differ from CPython 3.13's on characters assigned in a newer Unicode version.

- `ardia computer`, `ardia on` and `ardia hooks`: every helper program they start (codesign, ditto, lsregister,
  launchctl, systemctl, the driver's quiet `stop` and `telemetry disable`, hook and decide programs) runs in its own
  process group. A timeout or a stop sends the group one SIGTERM, then at the end of the grace exactly one SIGKILL if
  any member is left, whether or not the program itself has exited, and then forgets the group; Python's timeouts
  stopped only the program, so a descendant that ignored SIGTERM and closed its output kept running. Groups still
  alive when ardia exits are killed.
- Hook and decide programs, and the cua-driver that `ardia computer` hands over to, inherit ardia's environment on
  purpose, as with Python: they are programs the user configured, and they see the user's whole environment.
- `ardia computer` hands over to cua-driver with `execve` from the libc addon, as Python's `os.execve` does, so the
  driver keeps the pid; before it, the addon marks every descriptor above 2 close-on-exec, clears the signal mask and
  ignores SIGPIPE and SIGXFSZ, which is the state Python's process hands over.
- An uncaught exception from `launchctl` or `systemctl` that Python lets end the command (one that can't be started,
  like `/bin/launchctl` in a sandbox) prints only the exception line, as above.
- A cua-driver download that fails prints `couldn't download <asset>: <reason>` with Bun's network error as the
  reason, where Python printed urllib's (`<urlopen error ...>`, `HTTP Error 404: Not Found`); the https-only rule,
  the redirect refusal and the checksum check are the same.

- `ardia scripts` with a hand-edited `meta.json` whose fields have the wrong types (a `matches` that isn't a list of
  text, a `name` that isn't text, an `installed_at` that doesn't compare with the others'): Python fails with a
  `TypeError` traceback, or, for a list field given as text, builds the manifest from its characters and then refuses
  it. The native side stops before writing anything with `ardia scripts: <id>'s meta.json has a field of the wrong
  type; reinstall it` and status 1. The CLI never writes such a record; only a hand edit makes one.
- Ctrl-C during `ardia scripts install`, `uninstall` or `list`: Python raises `KeyboardInterrupt` wherever it is. The
  native side notices it while it waits (for esbuild, the store's lock or Ardia's report) and between steps, so a
  Ctrl-C during a store write lets that write finish. Both then end alike: `KeyboardInterrupt` on stderr, the call
  recorded with status 130, and death by SIGINT. esbuild runs in a process group of its own, killed on Ctrl-C and on
  the 60 s timeout, where Python kills only esbuild itself on the timeout.
- esbuild's diagnostics that aren't valid UTF-8: Python fails decoding them with a traceback; the native side shows
  them with U+FFFD in place of the bad bytes.

- The telemetry flusher is the TypeScript program itself (started with `--ardia-telemetry-flush`), not the bundled
  Python. It sends the same OTLP body except that each record's attributes leave out `python_version`, which no longer
  describes the program; `cli_command` events already say `served_by`. A 3xx answer from the ingest service is a retry,
  not a redirect to follow, so a spool is never posted anywhere but the configured URL.
- `ardia feedback` leaves `python_version` out of the report's diagnostics for the same reason. A redirect from the
  feedback service is reported as `the feedback service answered HTTP 3xx` instead of being followed, so a report and its
  attachments only ever go to the configured URL. When the network fails, the reason in `Not sent: the network failed
  (…)` is the runtime's wording (a refused connection still reads `[Errno 61] Connection refused`).
- argv shapes that make argparse print usage or an error (`--help`, an unknown or abbreviated option, an invalid
  `--kind`/`--target`/`--days`/`--limit`, positionals on both sides of an option) are printed by M2-F's argparse
  (`ts/src/argparse.ts`), which renders them as CPython 3.13's does from the parser specs in `argparse-specs.json`.
- The TypeScript flusher uploads only the CLI's own events (`cli_command`, `$exception`) and, in each, only the known
  fields with values of their kind; anything else in a spooled record is dropped at upload, and a record that isn't
  one of those events is dropped whole. Names are checked against closed sets, not shapes (`ts/src/telemetry-names.ts`):
  a command or subcommand the CLI's own tables don't list (the argparse specs, served.txt, browse's commands, call's
  method families, computer's driver commands) is sent as `other`, a flag they don't list is left out, an exception
  type outside CPython's built-ins and the CLI's own is `other`, the source and mechanism are `cli_unhandled` or
  `browse_daemon` (else `other`), an exception value is a fixed message, `[Errno N] ` with exactly that errno's text,
  or a known type name (else `other`), and stack frames are sent empty. Python's flusher sends what the spool holds. The TS flusher also notes the events the service took before it rewrites the
  spool, so a crash in between doesn't send them twice.
- Skill copies are replaced in one atomic swap (`renameatx_np`/`renameat2`); where the filesystem can't swap, the old
  folder waits beside it as `.<name>.old`, which the next run restores or removes. `ardia scripts install` and
  `uninstall` commit the script record before publishing the extension, so a crash between the two is completed by
  the next repair (`ardia scripts list`) or install. Python moves the old skill folder aside under a random name and
  publishes the extension first.
- `ardia skills install --replace` over a folder ardia didn't install overwrites only the files the skill ships and
  keeps every other file in it (Python deleted the folder first); a linked folder is still replaced by a real one, its
  target untouched. Every install and refresh is built in a staging folder beside the destination and swapped in whole,
  marker last, so a failure leaves the old copy as it was, and nothing is done through a symbolic link below the home
  or project folder (`.agents`, `skills`, …): such a destination is refused or skipped.
- A cached cua-driver skill (`<CLI home>/cua-driver/<version>/skills`) is used only when its files match the pinned
  release's hashes; otherwise it's downloaded again. The download is capped in size, expanded size and entries.

## Linux

The same CLI, with these differences:

- Paths: data dir `${ARDIA_CONFIG_HOME:-${XDG_CONFIG_HOME:-~/.config}}/ardia` (the engine's Chromium user data dir,
  holding `ArdiaControl.json`, `ArdiaControl.sock` and the `Default`/`Profile N` folders), config folder
  `<data dir>/config` (`${ARDIA_CONFIG_HOME:-${XDG_CONFIG_HOME:-~/.config}}/ardia/config` by default, which the app
  reads too; on macOS the default is `~/.config/ardia`), so `hooks.json` lives there as well, CLI home
  `${XDG_DATA_HOME:-~/.local/share}/ardia/cli`, bin dir `~/.local/bin`, hooks log
  `${XDG_STATE_HOME:-~/.local/state}/ardia/hooks.log` (rotated at 5 MB as on macOS). An `XDG_*_HOME` that isn't an
  absolute path is ignored, as the XDG spec, systemd and the engine's CLI installer do, except `XDG_CONFIG_HOME` (and
  `ARDIA_CONFIG_HOME`) for the data dir and config folder, where Chromium takes any non-empty value.
- `ardia hooks install` writes `${XDG_CONFIG_HOME:-~/.config}/systemd/user/dev.ardia.hooks.service` (`Type=exec`,
  `ExecStart` the installed `current/bin/ardia hooks run --log <log>`, `WorkingDirectory` the home folder, `PATH`
  from the installing shell, an empty `ARDIA_DATA_DIR` and `ARDIA_CONFIG_HOME` set to the folder the installing
  shell resolved (`$ARDIA_CONFIG_HOME`, else `${XDG_CONFIG_HOME:-~/.config}`), so the service reads the same
  `hooks.json` and reaches the same Ardia as `ardia hooks list` even when the systemd user manager's environment
  differs, `Restart=on-failure` with `RestartSec=10` and
  `StartLimitIntervalSec=0` so it never gives up, output to null, `WantedBy=default.target`), then runs `systemctl
  --user daemon-reload`, `enable` and `restart` (so a reinstall picks up a new unit). `hooks run` exits 0 only on
  SIGTERM or SIGHUP, so `systemctl --user stop` sticks and every crash restarts it. `uninstall` runs `disable --now`,
  removes the unit and reloads; `list` reads `systemctl --user show` and prints whether it's active. Paths in the unit
  escape `%`, `$`, `"` and `\`; control characters are refused.
- `ardia config edit` uses `$VISUAL`, then `$EDITOR`; with neither, in a desktop session (`$DISPLAY` or
  `$WAYLAND_DISPLAY` set) it opens the file with `xdg-open`, which returns at once, so it prints a reminder to run
  `ardia config check` instead of checking. Without a display (an SSH session) or without `xdg-open` it uses `vi`.
- `ardia scripts install|uninstall|list` use `<data dir>/Scripts`, which is where the engine's scripts policy looks on
  Linux (the Mac's `Chromium/..` parent would be `~/.config` here). The Linux host reads, watches and reports the
  folder with the same contract as the Mac (`ac_linux_user_scripts*.cc`, see [linux-port.md](linux-port.md) › "The
  `ardia` command"); one regular window applies the scripts, and another takes over when it closes.
- `ardia browse` runs on Linux for opening, reading, snapshots and screenshots, with two gaps. `open --show` and
  `tab <id> --show` switch Ardia to the tab, but a tab it opened in the background stays hidden to the page, so `click`
  and typing refuse it with the hidden-tab error. `auth` stores passwords through `/usr/bin/security`, the macOS
  Keychain tool, which Linux doesn't have.
- `ardia computer` is macOS only (cua-driver drives macOS apps): `setup` and every passthrough print `ardia computer:
  computer use through cua-driver needs macOS here` and exit 1, and `computer refresh`, which `install.sh` starts after
  an upgrade, does nothing. `skills refresh` works as on macOS.
- The caller name (`ardia_cli/caller.py`) walks the parent processes through `/proc/<pid>/stat`, `exe` and `cmdline`
  instead of libproc and `sysctl`; app bundles don't exist here, so a process with no known agent above it is
  `ardia`. Telemetry's `startup_ms` reads the process start from `/proc/self/stat` against `CLOCK_BOOTTIME`.
- `ardia pinned` reads the host's session, `<data dir>/<app profile>/Ardia/linux-session.json`
  (`engine/ardiacore-linux/src/ardia/linux/ac_linux_host.cc`, `MergeAndWriteSession`; the shape is
  `snapshotHostSession` in `apps/linux/src/hostSession.ts`), never `session.json`. The app profile is the folder
  `profile.last_used` names in `<data dir>/Local State`, which the host pins to its app profile, when it's `Default`
  or a regular `Profile …` folder; else `Default`. The shape differs from macOS's only in packaging: `windows`,
  `tabs`, `groups` and `splits` are objects keyed by id rather than lists, there's no `version`, and windows carry
  `kind` instead of `incognito`. Nothing macOS's pins need is missing: profile names, `profileOrder`,
  `windowOrder`, tab order, pin keys, folders and `parkedPins` are all there, so the rows match macOS's. The host
  writes it with `ImportantFileWriter::WriteFileAtomically` (a temp file in `Ardia/`, then a rename), so the CLI
  opens the profile folder, `Ardia` and the file each with `O_NOFOLLOW` (relative to the folder above) and reads
  the one file it opened, which is always a whole version; it never writes there. `ardia history` takes its profile
  labels from the same file (`Profile <dataId>` is that profile's folder).
