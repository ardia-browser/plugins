# The browse daemon's replay harness

The browse daemon (`ardia-ts daemon`, M3) was ported from the Python CLI with a differential harness: the same
`ardia browse` calls ran against both daemons, every CDP message each one exchanged with Chromium was recorded, and the
normalized requests, answers and session folder were compared. The Python CLI is gone; what stays is the corpus those
runs recorded and a Bun harness that replays it against the TypeScript daemon with no browser. A replay fails when the
daemon sends a request the recording doesn't have, skips one it does, or answers differently. Everything below runs
from `plugins/cli/ts`.

## Pieces

| Piece | File | What it does |
|---|---|---|
| Tap | `tests/m3/tap.ts` (Bun, not shipped) | WebSocket proxy in front of one Chromium, or, with `--replay`, a stand-in that answers from a recording. Serves `/json/version` with its own URL, writes a JSONL transcript and injects faults (`POST /tap/fault`). |
| Replay | `tests/m3/replay.ts` | The tap's replay mode (below). |
| Scenario | `tests/m3/scenarios/<group>/<name>.json` | `steps`: `argv` (`{fixture}` is the fixture server, `{fixture_dir}` its folder, `{home}` the side's HOME), `session`, optional `stdin` and `main_world`. Optional: `window`, `env`, `seed`, `pace` (`asap` or `recorded`), `live_only` (a reason), `divergences`, `racy_steps`, `unstable_steps`, `designed`. |
| Recording | `tests/m3/transcripts/<name>.jsonl.gz` and `.result.json.gz` | The CDP transcript and the raw result (answers, session files, `subs`). Raw, so a normalizer change needs no re-record. |
| Runner | `tests/m3/harness/runner.ts`, `side.ts` | One side = one tap and one client, isolated (HOME, TMPDIR, `ARDIA_CONFIG_HOME`, `ARDIA_CLI_HOME`, XDG and data dir under the side's scratch folder). After the steps it snapshots the session folder, then runs `close --all`. |
| Client | `tests/m3/harness/client-preload.ts`, `client-hooks.ts` | The client is the TypeScript CLI from source (`bun --preload client-preload.ts src/main.ts browse …`). The preload patches three functions at load: `loadLibc` finds the addon beside `ARDIA_M3_TS_PROGRAM`, `spawnDaemon` adds `harness_seed` and starts that program, and `exchange` appends each request and answer to `ARDIA_M3_ANSWERS`. Nothing in `src/` knows about the harness. |
| Daemon | `ARDIA_M3_TS_PROGRAM` | The built `ardia-ts` the client starts as `<program> daemon` (default `ts/dist/ardia-ts`). |
| Normalizer | `tests/m3/harness/normalize.ts` | Every rule is named in `RULES` and tested in `harness/harness.test.ts`. A rule that masks more than its named field is a review finding. |
| Divergences | `tests/m3/harness/divergences.ts` | The designed differences between the recordings and the TypeScript daemon (below). |
| Protocol | `tests/m3/harness/protocol.ts`, `tests/m3/protocol.schema.json` | Checks every request, answer and spawn config of a run against the schema (`docs/browse-daemon-protocol.md`). A violation is a difference. |
| Link | `tests/m3/harness/linkrun.ts`, `tests/m3/link-driver.ts`, `link-scenarios/`, `link-transcripts/` | The same replay for the CDP link alone (slice D1). |
| Corpus test | `tests/m3/replay-corpus.test.ts` | Runs in `bun run test` on macOS: every replayable recording not on `PENDING`, the link recordings, a changed scenario and a changed link request that must fail, a recording moved to another port block, and the protocol check over every recorded result file. |

## Running it

```sh
sh scripts/build.sh                                       # the daemon the replay starts
bun tests/m3/harness/main.ts replay                       # every scenario with a recording
bun tests/m3/harness/main.ts replay 'core/*' daemon/waits # names under scenarios/, globs allowed
bun tests/m3/harness/main.ts list 'act/*'                 # steps and live-only marks
bun tests/m3/harness/main.ts link-replay                  # every link recording that isn't live-only
bun tests/m3/harness/main.ts link-list
bun test tests/m3/harness/harness.test.ts                 # normalizer rules, port blocks, divergences
bun test tests/m3/replay-corpus.test.ts                   # what CI runs
```

`replay` takes `--keep --scratch <dir>` to keep each side's `transcript.jsonl`, `tap.log`, `answers.jsonl` and data
dir, `--json` for machine output, `--pace asap|recorded` and `--serial` (one scenario at a time; by default one per
free port pair). A live-only scenario is reported as skipped with its reason. A failed replay prints the tap's report:
the request the daemon sent and the recorded ones it could have been. `ARDIA_M3_DATA_ROOT` points the harness at
another copy of the data (scenarios, transcripts, link data, schema and `elastic.json`).

Recording new transcripts, live runs against Chromium and fault runs (`cancel`) come with a TypeScript record mode in
plugins#108. Until then the corpus can only be replayed, and a scenario whose recording no longer describes the daemon
goes on `PENDING` in `replay-corpus.test.ts` with its reason.

## Ports

Ports come from `ARDIA_M3_PORT_BASE` (default 9600): a run owns the block of 20 starting there. In a block, +0 to +17
are tap pairs and +19 serves the fixtures (`tests/fixtures/browse`). A run first checks every port of its block and
stops at once if any is bound (bound locally or answering a connection), so a daemon never talks to another run's tap.
`ARDIA_M3_PORTS` is refused. The live unit tests that start headless Chrome (`ARDIA_M3_CHROME`, below) take fixed ports
from the 9400 block instead: `ARDIA_D2_CHROME_PORT` (default base + 10), `ARDIA_D4_CHROME_PORT` (default base + 8).

Each `.result.json.gz` stores its fixture port in `subs.fixture` (recordings from before that have none and mean
9619). Replay rewrites the recorded fixture port to the replaying block's own in the recorded messages (the tap's
`--fixture-from` and `--fixture-to`), and the normalizer writes every fixture port as `<FIXTURE>`, so any recording
replays in any block.

## How comparison works

- **Answers.** For each step: `exit`, `out` and `err` after normalization. From the raw daemon answer it compares
  `code`, `busy_elsewhere`, `exit` and the key set of `metrics`.
- **Requests.** Compared per step, per connection and per CDP session, in order. Browser-issued IDs become `<id#n>`,
  `<node#n>`, `<backend#n>` or `<context#n>`, numbered by first appearance in that step's own requests, and the
  message `id` is dropped.
- **Sources.** Every `expression`, `functionDeclaration` and `source` is hashed per step, so drift in the page
  JavaScript (`src/browse/js/`) fails even when the results agree.
- **Files.** The session folder (`Browse/`) is compared before teardown: names, modes and JSON contents, with keys,
  pids and times masked.
- **Transcript checks.** Every run also fails on `Runtime.enable`, `Debugger.enable` or `Console.enable` on a page
  session (`Runtime.enable` is allowed only in a scenario that captures the console), a busy probe in the main world of
  a page that has an isolated world, a page call on a numeric execution context, a world handle used before
  `Page.getFrameTree` checked its loader, a touch event before touch emulation or the page's touch probe (row 1), and,
  on macOS, a Meta editing shortcut without its command (row 20).

### Normalizer rules

`RULES` in `harness/normalize.ts`:

| Rule | What it does |
|---|---|
| `browser-ids` | CDP ID fields become `<kind#n>`, numbered by first appearance in the step's own requests |
| `after-fault` | in a fault run, the faulted step's requests before the fault are left out; only the cleanup after it is compared |
| `message-id` | a request's top-level `id` is dropped; requests are matched by content |
| `concurrency` | requests on one CDP session sent while another was unanswered are one group, compared as a sorted multiset |
| `scratch` | the side's scratch root becomes `<SCRATCH>` in answers, files and requests |
| `ports` | the tap's, Chromium's and the fixture server's port become `<TAP>`, `<CHROME>` and `<FIXTURE>` |
| `ids-in-answers` | browser string IDs (8+ characters) seen in the transcript become their placeholder inside answer text |
| `session-key` | 24-hex session keys in file names and answers become `<KEY:session>` |
| `tabs-file` | the tab registry's file name hash becomes `tabs-<HASH>` |
| `file-times` | `pid`, `started`, `at` and epoch-second floats in the session folder's JSON files become `<PID>` and `<TIME>` |
| `read-stamp` | the time in `read`'s `[read … UTC]` line and in a page header's `(HTTP 200, read …)` becomes `<TIME>` |
| `console-detectable` | the recorded `console` notice reads with the TypeScript ending, `…; the page can detect this)` |
| `request-rows` | the `[<renderer pid>.<n>]` id at the start of a `network requests` row becomes `[<REQUEST>]` |
| `live-sets` | live mode compares each step's requests as a set of distinct forms (with plugins#108) |
| `ready-probe` | live mode ignores the `() => document.readyState` probe |
| `cached-probes` | live mode ignores `Page.getFrameTree` and the `document.visibilityState` probe, which the daemon skips when it read them in the last 0.75 s and 0.25 s |
| `replay-order` | replay matches a request within `lookahead` concurrency groups (`elastic.json`) |
| `replay-repeats` | replay lets the read-only probes in `elastic.json` repeat or be skipped |
| `unstable-steps` | live mode compares only exit and stderr of the steps listed in `unstable_steps` |
| `build` | a session's `<key>.json` is compared without `build` |
| `metrics` | of `metrics` only the key set is compared, without the flags and counts added after the recordings (`tsOnlyMetrics`: what `src/browse/metrics.ts` registers and `harness/python-command-metrics.json`, the recorded daemon's frozen list, doesn't) |
| `secrets` | credential-bearing params (`continueWithAuth`'s username and password, `Authorization`, `Proxy-Authorization` and `Cookie` header values, cookie values being set) become `<REDACTED>`; the tap writes them redacted too |
| `racy-steps` | every mode compares only the exit status of the steps listed in `racy_steps` |
| `whole-floats` | a whole-number float in a request's params (`91.0`) compares as the integer (`91`) |
| `fixture-dir` | the checkout's own fixture folder becomes `{fixture_dir}`, so a recording replays from any clone |
| `temp-tab-nonce` | `about:blank#ardia-temp-<nonce>` in `Target.createTarget` compares as the recorded `about:blank` |
| `uncoded-failure` | `code: "command_failed"` on an exit-1 answer, and an exit-1 `batch` answer's lifted line code, compare as the recorded answer without one |
| `json-error-code` | a `--json` failure envelope's trailing `"code":"command_failed"` or `"unknown_command"` is dropped |
| `open-moved-tab` | the recorded `open` notice on a tab taken with `tab active` reads as the current one |
| `divergences` | the designed differences rewrite only the request fields they name, on both sides, before IDs are numbered |

### Divergences

`DIVERGENCES` in `harness/divergences.ts` lists each place the daemon deliberately sends something other than what was
recorded, with the recorded form, the current one, why, and its ardia#2812 row or decision. `world-handle`,
`oopif-auto-attach`, `temp-tab-marker` and `shadow-pierce` always apply; the rest (`busy-probe-isolated`,
`console-detectable`, `eval-isolated`, `script-isolated`, `permission-overrides`, `json-error-code`, `open-moved-tab`,
`editing-commands`) only when a scenario names them in `divergences`, and `busy-probe-isolated` also in a `drop` or
`stop` fault run. An unknown name fails the run.

## Replay

Replay serves the recorded browser messages in their recorded order. Each event and answer is sent as soon as the
request it followed has arrived, in one corked batch, and each answer gets the live request's `id`. What replay
preserves is each event's order against the daemon's requests, not its delay. A request matches the first
unconsumed recorded request with the same form, in the session's current concurrency group or up to `lookahead` groups
ahead, which covers tasks that interleave by timing (a `Network.disable` cleanup beside a page call).

`tests/m3/elastic.json` lists the read-only probes whose count follows the daemon's own sleeps (`Page.getFrameTree`,
`Target.getTargets`, `Target.activateTarget`, the `visibilityState` and `readyState` probes and `ardiaBrowse.query`):
- an extra one is answered with its latest recorded answer;
- a recorded one the daemon doesn't send is skipped once the daemon sends any request recorded after it, or once it
  waits on an answer queued behind one. It is never skipped while the daemon is idle between steps.

Nothing that acts on the page is ever elastic. If a reorder still leaves an answer stuck behind a request that hasn't
come, the answer is sent ahead after 50 ms. Every elastic step is written to the transcript as `{"k": "elastic"}`.

Replay fails on an unmatched request, a recorded request the daemon never sent, and a stall (the daemon waits for
answers and the recording waits for a request that never comes).

A scenario whose logic runs on the daemon's clock (waiting out a fading dialog, waiting for a field to enable,
`read --scroll`'s lazy-load waits) is `live_only` and isn't replayed: 47 of the 102 scenarios today. Of the other 55,
26 are on `PENDING` (below), so the corpus test replays 29.

A scenario with more than one session ends with an explicit `close` step for each, in a fixed order: teardown's
`close --all` closes sessions in the order of their keys, a key hashes the endpoint, and the endpoint's port differs
between the recording and the replay.

The tap delivers each Chromium burst as one write (a burst ends after 3 ms of quiet, or at 250 ms), so live and replay
group messages the same way. The recorded scratch root is replaced by the replay's own in every frame, so paths match.

Credentials never reach a recording: the tap writes `Fetch.continueWithAuth` and `Network.continueInterceptedRequest`
credentials, `Authorization`, `Proxy-Authorization` and `Cookie` header values and cookie values being set as
`<REDACTED>`. Chromium still gets the real values, and replay matches requests on the redacted form.

## Pending recordings

The recordings were made from the Python daemon. plugins#92 changed what the TypeScript daemon sends: it keeps Network
on per session and reuses a frame tree and a visibility probe it read in the last 0.75 s and 0.25 s. The 26
recordings that change touched no longer describe its requests, so `PENDING` in `replay-corpus.test.ts` holds them out
of the corpus with that reason, and a test checks each one is still a replayable recording. They come back once
plugins#108 re-records them from TypeScript.

## Determinism

The client's spawn hook adds `harness_seed` (`ARDIA_M3_SEED`: the scenario's `seed` or a hash of its name) to the
daemon's spawn config, and appends each config to `$HOME/spawn-config.jsonl`, which the protocol check reads. Only
then does the daemon seed its randomness with `pylib/random.ts` (MT19937), the generator the recordings were made
with: humanized paths, watch IDs, nonces and tab slots come out as recorded.

## Faults

`POST /tap/fault {"at": k, "kind": …}` on the tap arms one fault at the k-th CDP request from now, or with
`"method": M` at the k-th request of method M:

| Kind | Effect |
|---|---|
| `interrupt` (default) | The tap holds request k, the harness sends SIGINT to the client (Ctrl-C), then releases the request. Later requests on the same CDP session queue behind it; other sessions aren't held. |
| `kill` | Forward request k, then SIGKILL Chromium. |
| `stop` | Forward request k, then SIGSTOP Chromium for `seconds`. |
| `close` | Close the daemon's WebSocket with `code` instead of forwarding. |
| `drop` | Forward request k, but swallow its reply. |
| `error` | Answer request k with a CDP error. |

The `after-fault` rule compares only the faulted step's cleanup (held keys released, `Network.disable`, temp tabs
closed), every later step, the answers and the session folder. The runner that drives faults step by step comes with
plugins#108; until then the daemon's fault handling is covered by the unit tests below.

## Function oracle

The pure functions the port mirrored (printable, shape, flows, the D7 helpers and the rest) were checked against their
Python originals on recorded and generated inputs. Those results are frozen in `tests/fixtures/oracle/` (CPython
3.13.16; `meta.json` names the commit and every fixture), and `tests/m3/oracle.test.ts` runs each TypeScript twin
(`oracle.ts`, `oracle-fns*.ts`) on the same inputs and diffs the results exactly (ints and floats apart, keys in
order). `m3-pure-linux.json` holds the Linux results where libm differs (`random.gauss`).

## The CDP link (slice D1)

`src/browse/cdp/link.ts`, `browser.ts` and `guard.ts` are the CDP link. Its harness runs without a daemon:

| Piece | File | What it does |
|---|---|---|
| Driver | `tests/m3/link-driver.ts` | Runs one op script (`open`, `send`, `gather`, `pipeline`, `cancel`, `fault`, `close`, …) through the TS `Browser` and prints each op's outcome (result, or error class, message and code). |
| Scenarios | `tests/m3/link-scenarios/*.json` | `ops`, plus `live_only` (a reason), `type_only` (ops whose error is compared by class only) and `pace`. |
| Recordings | `tests/m3/link-transcripts/` | Transcript and outcomes; four replay (`large`, `pipelined`, `round_trips`, `unreachable`). The fault and timeout scenarios are live-only. |
| Runner | `bun tests/m3/harness/main.ts link-replay` | Same tap and normalizer; compares outcomes, requests in order and sources. |
| Unit tests | `tests/m3/link.test.ts`, `browser.test.ts` (fake peers in `rawpeer.ts`) | What a live Chromium can't produce: the exact 256 MiB boundary, invalid UTF-8, binary frames, close codes, burst ordering, ids, cancellation, and the attach cap. |

Chromium's DevTools server never sends a frame over 268,435,456 bytes: it logs "Too large write data is pending" and
drops the reply without closing. So a reply over the link's 256 MiB cap can only come from a fake peer; from Chromium
the command times out.

The link settles a reply in the reader (pending entry, timer, attach slot) but resumes its caller with `setImmediate`,
so an event that arrives in the same socket read as a reply reaches its handlers before the command that waited goes
on, as it did when the recordings were made.

## Where each slice lives

| Slice | Code | Unit tests |
|---|---|---|
| D2, the daemon shell | `src/browse/daemon/`: `main.ts` (`ardia-ts daemon`), `config.ts`, `server.ts` (socket, admission, the FIFO command lock, busy answers, limits, idle disconnect, the endpoint watch, `close`, signals), `render.ts`, `claims.ts`, `log.ts`, `spawn.ts`; shared `src/browse/paths.ts`, `endpoint.ts`, `state/registry.ts`, `state/temptabs.ts` | `tests/m3/daemon*.test.ts`: stale socket, lock held elsewhere, unsafe folders, oversized and broken requests, queueing and `beside_if_busy`, signals, the install lease, the native watchdog, the bind folder and exclusive rename; `daemon-live.test.ts` and the live parts of `daemon-review*.test.ts` need `ARDIA_M3_CHROME` |
| D3, the page core | `src/browse/state/` (`page.ts`, `state.ts`, `refs.ts`, `apptabs.ts`, `records.ts`), `src/browse/commands/` (`index.ts` the command table, `parse.ts`, `ctx.ts`, `core.ts`) | `tests/m3/core*.test.ts` |
| D4, the read side | `src/browse/snapshot/`, `src/browse/read/`, `state/oopif.ts`, `state/pierce.ts`, `commands/read.ts`, `read-page.ts`, `find.ts`, `storage.ts`, `shared.ts` | `tests/m3/read*.test.ts`, `reading.test.ts`; `read-live.test.ts` needs `ARDIA_M3_CHROME` |
| D5, the act side | `src/browse/act/`, `src/browse/input/`, `changes/observe.ts`, `state/frames.ts`, `commands/act.ts`, `batch.ts` | `tests/m3/act-ported.test.ts`, `batch-observe.test.ts` |
| D6, capture and media | `src/browse/capture/`, `src/browse/media/` | `tests/m3/capture.test.ts`, `media-stream.test.ts` |
| D7, scripting, flows and raw access | `src/browse/commands/{pagejs,settings,cdp,notes}.ts`, `script/`, `flows/`, `auth/`, `cdp/{raw,params}.ts` | `tests/m3/d7*.test.ts`, `script-live.test.ts` |

`ARDIA_M3_CHROME` is a pinned `chrome-headless-shell` (Chrome for Testing 158.0.8127.18, Playwright's
`chromium_headless_shell-1254`, in its own folder); the live tests skip without it and always run it headless.
`bun run typecheck:harness` type-checks everything under `tests/m3`.
