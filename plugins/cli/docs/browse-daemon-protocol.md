# The `ardia browse` daemon protocol

The contract between the `ardia browse` client (`ts/src/browse/`) and its daemon, the same program run as
`ardia daemon` (`ts/src/browse/daemon/`). A client only ever reaches a daemon of its own build (the build stamp is
part of the session key, below); the rules keep the protocol readable as it grows.
The machine form is `ts/tests/m3/protocol.schema.json`. `ts/tests/m3/harness/protocol.ts` checks against it every
request, answer and spawn config of a harness run, and `ts/tests/m3/replay-corpus.test.ts` ("the recorded protocol")
every request and answer in the recorded result files (`docs/m3-harness.md`).

## Rules

- Fields are only added, never repurposed. A field whose meaning changes gets a new name.
- A reader ignores fields it doesn't know. The daemon reads only the fields below, and the client prints only `out`
  and `err`.
- The daemon answers a command it doesn't know with `Unknown command: <name>. Run \`ardia browse --help\`` (a usage
  error, exit 1), and one of agent-browser's commands it skips on purpose with `code: "unsupported"` and why.

## Files

All in `<data dir>/Browse/` (`docs/cli.md`, Process model). The folder is opened `O_NOFOLLOW | O_DIRECTORY`, must be a
folder the user owns with mode 0700 (`fstat`), and every file in it is opened relative to it.

| File | Who writes it | What it holds |
|---|---|---|
| `<key>.lock` | daemon, `flock` exclusive for its whole life | nothing; a held lock means a live daemon |
| `<key>.sock` | daemon, bound inside the private `.<key>.bind/` folder (umask 0177, mode 0600) and moved into place with an exclusive rename | the Unix socket; unlinked when stale only under the lock, and at exit only if its device and inode are still the ones bound |
| `<key>.json` | daemon, written atomically | `{"session", "namespace", "endpoint", "pid", "started", "build"}` (Python's `json.dumps` spacing: `", "` and `": "`) |
| `<key>.log` | client creates it (0600, truncated), the daemon writes it as stdout and stderr | redacted log lines, `<time> ardia_cli.browse <LEVEL> <message>` (the logger name kept from the Python daemon, so old and new logs read alike), a stack trace after an exception |
| `claims/<sha256(target)[:24]>.json` | daemon, under `claims/.lock` | `{"owner": <key>, "session", "target", "kinds": [...]}` |
| `tabs-<sha256(instance)[:20]>.json` | any daemon, under `tabs.lock` | the shared tab registry, version 3 |

`<key>` is `sha256(namespace + "\0" + endpoint key + "\0" + session + ["\0plugin"] + "\0build:" + build stamp)` in hex,
first 24 characters; the build stamp is the version plus a hash of the TypeScript sources, baked in by
`ts/scripts/build.sh` (`docs/cli.md`). The endpoint key is `port:<n>`, `ws:<scheme>://<netloc><path>` or
`token:<data root>`. Answers too long for the terminal spill to
`$TMPDIR/ardia-browse-output-<uid>/output-*.txt` (folder 0700, the newest 40 kept). A daemon running from an install
takes the lease `<version>/.leases/<pid>` beside `realpath` of its program and removes it at exit.

## Spawn

The client starts a daemon when `<key>.sock` doesn't answer: its own program, `<ardia> daemon`
(`spawnDaemon` in `ts/src/browse/daemon/spawn.ts`).

The child is detached (its own session), runs with cwd `/`, gets stdin as a pipe and the `<key>.log` file
descriptor as stdout and stderr, and inherits no other descriptor. The client also leaves `ARDIA_WS`,
`ARDIA_PORT`, `ARDIA_CDP_URL` and `AGENT_BROWSER_CDP` out of the daemon's environment, moving the endpoint they named
into `ws` or `port` first (`daemonEnvironment` in `spawn.ts`). The config is written to stdin as one JSON object
and stdin is closed; the client waits for the write before it polls. Nothing goes in argv or the environment. The
client then polls for the socket for up to 15 s; if the child exits and the lock isn't held, it fails at once with
`the ardia browse daemon exited before it listened: <the log's last 2,000 bytes>`.

`ardia daemon` refuses to run (exit 2) with any argument, with a terminal on stdin, or with a config it can't parse.

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

Planned: `credential` (plugin mode, F1).

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
| `body`, `body_bytes` | base64 string and its byte count, optional | `read --http … --out` of a binary response: its bytes as sent, outside `out` so redaction never touches them; the client checks the count and writes them raw, before and whatever it makes of `out`; sent only when the request's options have `out_body` |
| `failed_step_command` | string, optional | a failed `batch`: the browse command of its first failed line (telemetry's `failed_step_command`) |
| `daemon` | `ts/<version>` | the daemon's version, on every answer it writes |

Planned: `loader` (plugin mode, F1).

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
