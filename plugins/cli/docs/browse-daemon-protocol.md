# The `ardia browse` daemon protocol

One contract between every `ardia browse` client (Python's `ardia_cli/browse/client.py`, the TypeScript client) and
every daemon (Python's `ardia_cli/browse/daemon.py`, the TypeScript `libexec/ardia-ts daemon`). While both
implementations ship, any client must work with any daemon that holds the session's key. The machine form is
`tests/m3/protocol.schema.json`; the M3 harness checks every request, answer and spawn config of both implementations
against it (`tests/m3/protocol.py`, `python -m unittest tests.test_m3_harness`).

## Rules

- Fields are only added, never repurposed. A field whose meaning changes gets a new name.
- A reader ignores fields it doesn't know. Python's daemon reads with `.get`, the TypeScript one reads only the fields
  below, and both clients print only `out` and `err`.
- An old daemon answers a command it doesn't know with its usual `Unknown command: <name>. Run \`ardia browse --help\``
  usage error (exit 1). The TypeScript daemon answers a command Python serves but it doesn't yet with `code:
  "unsupported"` and says it isn't served by the TypeScript daemon yet.

## Files

All in `<data dir>/Browse/` (`docs/cli.md`, Process model). The folder is opened `O_NOFOLLOW | O_DIRECTORY`, must be a
folder the user owns with mode 0700 (`fstat`), and every file in it is opened relative to it.

| File | Who writes it | What it holds |
|---|---|---|
| `<key>.lock` | daemon, `flock` exclusive for its whole life | nothing; a held lock means a live daemon |
| `<key>.sock` | daemon, bound inside the private `.<key>.bind/` folder (umask 0177, mode 0600) and moved into place with an exclusive rename | the Unix socket; unlinked when stale only under the lock, and at exit only if its device and inode are still the ones bound |
| `<key>.json` | daemon, written atomically | `{"session", "namespace", "endpoint", "pid", "started"}` (Python's `json.dumps` spacing) |
| `<key>.log` | client creates it (0600, truncated), the daemon writes it as stdout and stderr | redacted log lines |
| `claims/<sha256(target)[:24]>.json` | daemon, under `claims/.lock` | `{"owner": <key>, "session", "target", "kinds": [...]}` |
| `tabs-<sha256(instance)[:20]>.json` | any daemon, under `tabs.lock` | the shared tab registry, version 3 |

`<key>` is `sha256(namespace + "\0" + endpoint key + "\0" + session)` in hex, first 24 characters. The endpoint key is
`port:<n>`, `ws:<scheme>://<netloc><path>` or `token:<data root>`. Answers too long for the terminal spill to
`$TMPDIR/ardia-browse-output-<uid>/output-*.txt` (folder 0700, the newest 40 kept). A daemon running from an install
takes the lease `<version>/.leases/<pid>` beside `realpath` of its program and removes it at exit.

## Spawn

The client starts a daemon when `<key>.sock` doesn't answer:

- Python's: `<python> -I -c "…daemon.main()"`.
- TypeScript's: `<ardia-ts> daemon`. The TypeScript client starts it when `served.txt` has the row `browse-daemon ts`,
  or `ARDIA_BROWSE_DAEMON=ts` is set (`ARDIA_BROWSE_DAEMON=python` forces Python's). Otherwise it starts Python's.

Either way the child is detached (its own session), runs with cwd `/`, gets stdin as a pipe and the `<key>.log` file
descriptor as stdout and stderr, and inherits no other descriptor. The TypeScript client also leaves `ARDIA_WS`,
`ARDIA_PORT`, `ARDIA_CDP_URL` and `AGENT_BROWSER_CDP` out of the daemon's environment, moving the endpoint they named
into `ws` or `port` first (`daemonEnvironment` in `spawn.ts`). The config is written to stdin as one JSON object
and stdin is closed; the client waits for the write before it polls. Nothing goes in argv or the environment. The
client then polls for the socket for up to 15 s; if the child exits and the lock isn't held, it fails at once with
`the ardia browse daemon exited before it listened: <the log's last 2,000 bytes>`.

`ardia-ts daemon` refuses to run (exit 2) with any argument, with a terminal on stdin, or with a config it can't parse.

### The config

| Field | Type | Meaning |
|---|---|---|
| `session` | string, `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` | the session name |
| `namespace` | string, empty or a session-like name | the namespace |
| `key` | 24 lowercase hex digits | the session key (file names) |
| `data_root` | absolute path | the data dir holding `Browse/` |
| `ws`, `port`, `data_dir` | string or null, 1–65535 or null, string or null | the endpoint choice, as the client resolved it |
| `endpoint_label` | string or null | how `<key>.json` names the endpoint; the TS daemon drops any query, fragment or user info |
| `idle_timeout_ms` | number or null | exit after this long without a command while disconnected (default 1 h) |
| `debug` | boolean | log at INFO instead of WARNING |
| `no_auto_dialog`, `pin_tab` | boolean or null | session defaults |
| `harness_seed` | integer, harness only | seeds the daemon's randomness (`docs/m3-harness.md`) |
| `plugin` | 32 lowercase hex digits or null | makes this a plugin daemon (below): the activity's credential id, `sha256(credential)[:32]` |

## Request

One line of JSON (UTF-8, ending in `\n`) per connection, at most 16 MiB (16,777,216 bytes) including the newline. The daemon first checks
the peer's uid (`LOCAL_PEERCRED`) and closes the connection if it isn't its own. A line over the limit, a line that
isn't a JSON object, or a client that sends nothing for 30 s gets the connection closed with no answer.

| Field | Type | Meaning |
|---|---|---|
| `argv` | array of strings | the command and its arguments, aliases allowed (`goto`, `quit`, …) |
| `options` | object | `json`, `humanize`, `timeout_ms`, `max_output`, `full`, `no_changes`, `no_text`, `content_boundaries`, `annotate`, `screenshot_*`, `no_auto_dialog`, `capture_console`, `show`, `enable`, `init_scripts`, `pin_tab`, `_session` |
| `cwd` | string | the client's working directory (relative paths resolve against it) |
| `env` | object of strings | the client's `AGENT_BROWSER_*` variables |
| `stdin` | string or null | stdin the command reads (`eval`, `batch`, `script`, `read`, `notes`) |
| `telemetry` | boolean | whether the command's metrics may be shared |
| `caller` | `{"name", "app"?}` or null | the program that ran `ardia` |
| `beside_if_busy` | true, optional | answer `busy_elsewhere` at once instead of queueing |
| `patient_queue` | true, optional | a `read` that may queue as long as its own limit |
| `credential` | `p.` and 43 base64url characters, plugin mode only | the activity's credential (below) |

`options` also carries `expect_loader` (string or null): plugin mode's document check (below).

After the request line the daemon watches the connection: any further byte or the client closing it (Ctrl-C) cancels
the command, and then no answer is written.

## Answer

One line of JSON (UTF-8, `\n`), at most 256 MiB. An answer over that is replaced by
`{"exit": 1, "out": "", "err": "✗ The answer was too large (<n> bytes, the limit is 268435456); narrow it (snapshot -s, -d, --max-output)\n"}`.

| Field | Type | Meaning |
|---|---|---|
| `exit` | integer 0–255 | the exit status the client returns |
| `out`, `err` | strings | what the client prints on stdout and stderr, already redacted and made inert |
| `code` | `[a-z][a-z0-9_]{0,40}`, optional | the error code (`session_busy`, `command_timeout`, `connection_lost`, `tab_gone`, `unsupported`, …) |
| `metrics` | object of numbers and booleans, optional | the command's telemetry counts, timings and flags |
| `busy_elsewhere` | true, optional | the session was busy and the request had `beside_if_busy` |
| `daemon` | `ts/<version>`, optional | sent only by the TypeScript daemon; its absence means Python's |
| `loader` | string, optional | plugin mode: the picked tab's main-frame loader after the step, so the plugin can chain |

## Serving

- Commands run one at a time, first come first served. A queued command gives up after 30 s (`session_busy`), longer
  for `script` and patient reads; a command queued behind a `script` waits up to 300 s.
- Each command has a limit (120 s; `batch`, `read`, `record` 600 s; `script` its timeout plus 30 s; `wait` its own
  timeout plus 30 s), after which it's stopped with `command_timeout`.
- `close` takes the lock after what's already running, marks the session closing (so commands queued before it, and any
  after, get `session_closing`), closes the tabs it opened and ends the daemon.
- When it connects to Ardia through `ArdiaControl.json`, and before a command whose `caller` differs from the last one
  it announced, the daemon tells Ardia's control socket who is driving it (`hello` with the caller, then `caller`,
  within 1 s, failures ignored).
- Lifetime: after 30 s with no command and nothing held, the daemon drops the browser connection and keeps its state;
  the next command makes a new connection and refuses (`browser_restarted`) if the browser instance changed. While
  disconnected it re-reads the endpoint every 2 s and exits if it's gone or changed. Without a command for
  `idle_timeout_ms` (1 h) while disconnected, it exits. A connection the browser closes is terminal: the daemon ends.
  On SIGTERM, SIGHUP or SIGINT it lets running commands finish for up to 5 s, cancels the rest, then cleans up within
  10 s (tabs it must close, the connection, the socket, `<key>.json`, its claims and registry entries).

## Plugin mode

A plugin's steps (`ARDIA_BROWSE_FOR_PLUGIN=1`, `docs/cli.md` › Plugin mode) are served by a TypeScript plugin daemon
and never by Python's or by the person's own session. The TypeScript daemon only; Python's has no plugin mode.

- **Key.** `<key>` is `sha256(namespace + "\0" + "plugin:" + <credential id> + "\0" + session + "\0plugin")`, first 24
  hex characters, where the credential id is `sha256(credential)` in hex, first 32 characters. So a plugin session never
  shares a daemon, a socket or any state with the person's session of the same name, with another activity, or with a
  client that doesn't know plugin mode.
- **Spawn.** As above (`<ardia-ts> daemon`, always TypeScript's, whatever `served.txt` says), with `plugin` set to the
  credential id, `ws` set to the token server exactly as `ARDIA_PLUGIN_ENDPOINT` gave it (`ws://127.0.0.1:<port>/devtools/browser/<id>`,
  no query), `port`, `data_dir` and `endpoint_label` null. The credential itself is never in the config, argv or the
  environment: every spawn drops `ARDIA_WS`, `ARDIA_PORT`, `ARDIA_CDP_URL`, `AGENT_BROWSER_CDP`, every `ARDIA_PLUGIN_*`
  variable and `ARDIA_BROWSE_FOR_PLUGIN` from the child's environment, and the client closes the credential descriptor
  before spawning. A config with `plugin` and any other endpoint is refused (exit 2).
- **Requests.** Every request carries `credential`. The plugin daemon checks `sha256(credential)[:32]` against its
  `plugin` (in constant time) as soon as the line is parsed, before it reads any option or touches any state, and answers
  a missing or different one with exactly `exit` 77, `out`, `err` and `code` `plugin_refused`: no `loader`, `metrics` or
  `daemon`, nothing sent, and no change to its caller, dialog or pinning settings. A daemon without `plugin` answers the
  same, just as early, to any request that carries `credential`, so a person's session never serves a plugin step. The daemon holds the credential only while that request runs; it
  registers it for redaction and never writes it.
- **Connection.** On a step's first CDP need the daemon connects to `<ws>?token=<credential>` with no `Origin` header.
  It drops the connection after 30 s idle like any session, and the next step reconnects with that step's credential. A
  connection the token server closes (the activity ended, control went off) ends the daemon.
- **Commands.** Only `tab <id>` (the pick) and `tab`/`tab list`, `snapshot`, `click`, `fill`, `press`/`key`, `type`,
  `scroll`, `wait`, `find`, `is` and `get`; anything else (and `close`'s tab closing) answers 77 `plugin_refused`.
  They read pages through DOM, accessibility and Input only: no `Runtime`, `DOM.resolveNode`, `DOM.performSearch`,
  `Page.createIsolatedWorld`, `DOM.focus`, `Page.captureScreenshot`, `DOM.scrollIntoViewIfNeeded`,
  `Emulation.setFocusEmulationEnabled` or drag method is ever sent (the daemon checks every outgoing method against its list, and
  the harness checks the transcript). A click is one `Ardia.dispatchClick {x, y, button, clickCount, modifiers}`, which
  the engine presses and releases in one browser task; `Input.dispatchMouseEvent` is only ever a buttonless
  `mouseMoved` or a `mouseWheel`, never a press, a release or a held button. At most one input command
  (`Input.dispatch*`, `Input.insertText` or `Ardia.dispatchClick`) is outstanding: each is sent
  only after the previous one was answered, and one left unanswered (10 s, `outcome_unknown`) holds back the next step's
  input for up to 10 s more (`input_unanswered`).
- **Page session only.** An act lease names the tab, the DevTools page target of its primary main frame and that
  frame's document, and the engine refuses input on any other session. So every input command (`Input.*`,
  `Ardia.dispatchClick`) goes out on the page target's own session, the one the daemon attached to that tab with
  `Target.attachToTarget`: never on an iframe target's, a prerender target's or an auto-attached session, and never on
  the browser session. The daemon refuses to send one anywhere else, and the harness checks it as acceptance check (c).
- **Focus and scrolling.** Focus comes only from clicks: `fill`, `type`, `press <selector> <key>` and `find … focus`
  click their element (`Ardia.dispatchClick` at its first content quad's centre), which focuses the page the way a
  person's click does; moves and wheels never focus. The engine holds the tab visible only while the plugin acts (its
  act lease turns the hold on), so the daemon scrolls only inside acting steps (`click`, `fill`, `type`, `press`,
  `scroll`, and `find` with an action other than `text`): it reads the element's content quad and the layout viewport
  (`Page.getLayoutMetrics`), and while the quad's middle is outside the viewport it sends one buttonless `mouseWheel` at
  the viewport's centre with the delta that would centre it, up to 4 times; still outside answers `outside_viewport`
  and nothing is clicked. Reads (`snapshot`, `get`, `is`, `find … text`, `wait`) never scroll, and the daemon's link
  refuses a wheel outside an acting step. A wheel the engine answers `ardia: busy` (the person used that tab in the last
  500 ms) is retried after 100, 200, 300, 400 and 500 ms, then the step answers `busy` ("Ardia didn't scroll the tab
  because the person is using it right now …"); `ardia: page_hidden` answers `outside_viewport` ("The tab is hidden and
  can't be scrolled"). The owner session keeps `DOM.scrollIntoViewIfNeeded`.
- **Keys.** Key events follow ardia#2808's key policy, whose key table the daemon carries as generated data
  (`ts/scripts/plugin-key-table.ts`, checked against the engine's compiled validator by `plugin-keys.test.ts`). A
  `press` the engine would refuse (Meta+C, Meta+V, Meta+Z, Shift+Delete, a character no key types) answers 77
  `plugin_refused` before any key goes out, so no modifier is left down. `type` and humanized `fill` send each
  character as key events when the engine allows them and as `Input.insertText` otherwise (é, CJK, emoji).
- **Frames.** `snapshot` (and each step's changes view) reads the top document's AX tree and, under each `<iframe>`,
  the child frame's own tree (`Accessibility.getFullAXTree {frameId}`) when that frame is in the tab's frame tree and
  same-site with the top document (same scheme and registrable domain, approximated as the host's last two labels).
  Cross-site frames (out-of-process iframes) aren't read; when any frame is skipped the snapshot ends with one line,
  `N embedded frame(s) not read`, and `--json` carries `framesNotRead`. Refs inside a read frame work like any other.
- **Protected fields.** The daemon never returns a password field's value: not in `snapshot`, `get value`, `get text`,
  `get attr … value`, `get html` (a password input's `value` attribute is removed), `find` or any change report. A field
  is protected when the AX tree marks it `protected`, when its AX value is all mask characters, or when `DOM.describeNode`
  shows `<input type=password>`; on Chrome 158 only the DOM signal is reliable (the AX tree carries no `protected`
  property and masks the value with one bullet per character). It shows as present, with its role, name and
  `(password field)` and no value. `fill`, `type` and `find … fill|type` into one answer exit 77 `protected_field`
  ("Password fields are filled by the password manager, not by plugins") before any input goes out, and the answer's
  metrics count it (`plugin_protected_refused`). Owner mode is unchanged.
- **Refs.** A step acts only on the picked tab: a ref taken on another tab is stale, answering exit 1 `stale_ref` like
  any other stale ref, and nothing is sent.
- **Document check.** With `options.expect_loader`, the daemon compares the picked tab's main-frame loader before the
  step (a mismatch answers code `document_changed`, exit 1, and nothing ran) and after it, even when the step failed (a
  mismatch answers code `document_changed_after`, exit 1, `data.ran: true`, in place of the step's own answer). The
  pick ignores it. Every answer whose tab is
  attached carries `loader`.
- **Engine codes.** A CDP error whose own message starts `ardia: tab_out_of_scope` answers code `tab_out_of_scope`, and
  one that starts `ardia: document_changed` (the act lease) answers `document_changed`. Codes never come from page text.
  A coded refusal always ends the step before any further CDP call; only a plain, uncoded CDP failure may fall back
  (an empty title, a default viewport point, "no box").
- **State.** Tab numbers live in the daemon's memory, per credential; the shared `tabs-*.json` registry, claims, the
  temporary-tab sweep and `using` are never touched. Nothing is written in `Browse/` beyond the session's socket, lock and
  log (no `<key>.json`), and an answer over the output cap is cut, not spilled.

