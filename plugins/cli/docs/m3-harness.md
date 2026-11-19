# The browse daemon's differential harness

The TypeScript browse daemon (M3) is done when it behaves like the Python one. This harness checks that: it runs the
same `ardia browse` calls against both, records every CDP message each daemon exchanges with Chromium, and compares
the normalized requests, the answers and the session folder. Everything runs from `plugins/cli`.

## Pieces

| Piece | File | What it does |
|---|---|---|
| Tap | `ts/tests/m3/tap.ts` (Bun, not shipped) | WebSocket proxy in front of one Chromium. Serves `/json/version` with its own URL, forwards frames unchanged and writes a JSONL transcript. It also injects faults. |
| Replay | `ts/tests/m3/replay.ts` | The tap's `--replay` mode. It answers the daemon from a recording, with no browser. |
| Scenario | `tests/m3/scenarios/<group>/<name>.json` | `steps`: `argv` (`{fixture}` is the fixture server, `{home}` the side's HOME), `session`, optional `stdin`. Optional: `window`, `env`, `seed`, `pace` (`asap` or `recorded`), `live_only` (a reason). |
| Recording | `tests/m3/transcripts/<name>.jsonl.gz` and `.result.json.gz` (raw answers and files; normalized when compared, so a normalizer change needs no re-record) | The Python run's transcript and raw result. Re-record a scenario whenever Python changes. |
| Runner | `python -m tests.m3` (`runner.py`, `side.py`) | One side = one Chromium, one tap and one daemon, isolated (HOME, TMPDIR, `ARDIA_CONFIG_HOME`, `ARDIA_CLI_HOME`, XDG and data dir all under the side's scratch folder). After the steps it snapshots the session folder, then runs `close --all`. |
| Normalizer | `tests/m3/normalize.py` | Every rule is named in `RULES` and tested in `tests/test_m3_harness.py`. A rule that masks more than its named field is a review finding. |
| Function oracle | `tests/m3/oracle.py`, `ts/tests/m3/oracle.ts`, `tests/m3/pure.py` | Runs a named Python function and its TypeScript twin on the same JSON inputs (recorded or fuzzed) and diffs the results exactly (ints and floats apart, keys in order). The P-slice twins are registered in `tests/m3/oracle_fns*.py` and `ts/tests/m3/oracle-fns*.ts`, with a generator each in `tests/m3/cases*.py`. |
| Driver | `tests/browse_driver.py` | The `browse()` helper the process-level tests share. `ARDIA_BROWSE_DAEMON=python\|ts` picks the client and daemon. `ARDIA_BROWSE_HARNESS=<dir>` writes each test's calls as a scenario. `ARDIA_BROWSE_TEST_PORTS=a-b` pins the tests' ports. |

## Setup

- Bun 1.3.14 and `bun install --frozen-lockfile --ignore-scripts` in `ts/`.
- Live modes need `ARDIA_M3_CHROME`: a pinned `chrome-headless-shell` (Chrome for Testing 158.0.8127.18, Playwright's
  `chromium_headless_shell-1254`, in its own folder). It always runs headless, never headed.
- Ports come from `ARDIA_M3_PORTS` (default `9400-9419`; slice *i* uses `9400 + 20i` through `+19`). The top port
  serves the fixtures; the rest are Chromium and tap pairs.
- The TS side runs through `ARDIA_M3_TS_PROGRAM=<built ardia-ts>`. The program is started as `<program> browse …`. To
  be seeded it must read `harness_seed` from its spawn config (below).

## What a slice runs

```sh
python -m tests.m3 replay --impl ts                        # CI: every recording, no browser
python -m tests.m3 live core/open_title --a python --b ts  # truth: twin Chromiums
python -m tests.m3 cancel act/drag_takes_the_target_place_and_names_it --impl ts   # Ctrl-C at every CDP request
python -m tests.m3 cancel core/open_title --kind kill --step 0 --impl ts            # or kill|stop|close|drop|error
python -m tests.m3.pure printable.shown --fuzz 2000        # P-slices: Python vs TS function
python -m tests.m3.pure shape.apply --generated 2000       # with the function's own generator and recorded inputs
python -m tests.m3.pure all --generated 2000               # every function that has a generator
python -m tests.m3 record <scenario>                       # after a Python change, then commit the recording
python -m tests.m3 selftest                                # the harness itself: Python vs Python, live and replay
python -m unittest tests.test_m3_harness                   # normalizer rules + every recording replays
```

Add `--keep --scratch <dir>` to keep each side's `transcript.jsonl`, `tap.log`, `answers.jsonl`, `chrome.log` and data
dir. A failed replay prints the tap's report: the request the daemon sent and the recorded ones it could have been.

## How comparison works

- **Answers.** For each step: `exit`, `out` and `err` after normalization. From the raw daemon answer it compares
  `code`, `busy_elsewhere`, `exit` and the key set of `metrics`. For Python, the seeded client writes the raw answer
  to `ARDIA_M3_ANSWERS`. A TS client in harness mode should append the same `{"request", "answer"}` lines.
- **Requests.** Requests are compared per step, per connection and per CDP session. Browser-issued IDs become
  `<id#n>`, `<node#n>`, `<backend#n>` or `<context#n>`, numbered by first appearance in that step's own requests (browser
  events cross step boundaries by timing), and the message `id` is dropped. Live mode compares each step's requests as a **set** of distinct forms (and ignores the
  `() => document.readyState` probe). Chromium's load timing decides how often Python polls and whether the load event
  beats its readiness check, so two live Pythons never agree on order or counts. Order is checked in replay instead.
- **Sources.** Every `expression`, `functionDeclaration` and `source` is hashed per step, so JS drift between `js.py`
  and `browse/js/*.js` fails even when the results agree.
- **Files.** The session folder (`Browse/`) is compared before teardown: names, modes and JSON contents, with keys,
  pids and times masked.

## Replay

Replay serves the recorded browser messages in their recorded order. Each event and answer is sent as soon as the
request it followed has arrived, in one corked batch, and each answer gets the live request's `id`. What replay
preserves is each event's order against the daemon's requests, not its delay. With real delays the daemon outruns an
event Chromium had already sent (`Page.frameNavigated` before `Page.createIsolatedWorld`). A request matches the first
unconsumed recorded request with the same form, in the session's current concurrency group or up to `lookahead` groups
ahead. That covers asyncio tasks that interleave by timing (a `Network.disable` cleanup beside a page call).

`tests/m3/elastic.json` lists the read-only probes whose count follows the daemon's own sleeps (`open --show`'s
`visibilityState` and `Target.getTargets` loop, `Page.getFrameTree`, `Target.activateTarget`):
- an extra one is answered with its latest recorded answer;
- a recorded one the daemon doesn't send is skipped once the daemon sends any request recorded after it (it has moved
  past that point), or once it waits on an answer queued behind one. It is never skipped while the daemon is idle
  between steps.

Nothing that acts on the page is ever elastic. If a reorder still leaves an answer stuck behind a request that hasn't
come, the answer is sent ahead after 50 ms. Every elastic step is written to the transcript as `{"k": "elastic"}`.

Replay fails on:
- an unmatched request;
- a recorded request the daemon never sent;
- a stall, where the daemon waits for answers and the recording waits for a request that never comes.

A scenario whose action logic runs on the daemon's clock gets `"live_only": "<reason>"`. Examples: waiting out a
fading dialog before a DOM click, waiting for a field to enable, `read --scroll`'s lazy-load waits. Python replayed
against its own recording then makes different decisions. 15 of the 33 recorded scenarios are live-only today; the
other 18 replay identically, run after run. `"unstable_steps": {"steps": [...], "reason": …}` names steps whose
`changes:` report depends on whether the page finished a change before the daemon's snapshot. For those steps live mode
compares only exit and stderr. `"pace": "recorded"` replays the recorded gaps (capped at 2 s); no scenario needs it now.

The tap delivers each Chromium burst as one write (a burst ends after 3 ms of quiet, or at 250 ms). Python handles every
message of one socket read before the command that waited on an answer resumes, so the grouping decides what the
daemon sees first. Live and replay therefore group the same way.

The recorded scratch root is replaced by the replay's own root in every frame, so paths match.

## Determinism

The harness starts each daemon itself, as the client does, and adds `harness_seed` to the spawn config. Python's
bootstrap (`tests/m3/seeded_client.py`) then calls `random.seed(seed)`, and `secrets.token_hex`, `token_bytes` and
`token_urlsafe` draw from `random.Random(seed + 1)`. That covers humanized paths, watch IDs, nonces and tab slots.
The TS daemon must do the same with `pylib/random.ts` (MT19937), and only when the config carries `harness_seed`. The
seed is the scenario's `seed` or a hash of its name.

## Faults and cancellation

`POST /tap/fault {"at": k, "kind": …}` on the tap arms one fault at the k-th CDP request from now, or with
`"method": M` at the k-th request of method M. For every request the recording made in a step, `cancel` arms the fault
at that request's method and occurrence. A step whose order depends on timing (`open`) is then still hit at the same
logical request on both sides:

| Kind | Effect |
|---|---|
| `interrupt` (default) | The tap holds request k, the harness sends SIGINT to the client (Ctrl-C), then releases the request. |
| `kill` | Forward request k, then SIGKILL Chromium. |
| `stop` | Forward request k, then SIGSTOP Chromium for `seconds`. |
| `close` | Close the daemon's WebSocket with `code` instead of forwarding. |
| `drop` | Forward request k, but swallow its reply. |
| `error` | Answer request k with a CDP error. |

Both sides get the same fault. Then the faulted step's requests after the fault (the cleanup: held keys released,
`Network.disable`, temp tabs closed), every later step, the answers and the session folder must match. Requests before
the fault in the faulted step are already covered by the plain runs, and in `open` they depend on timing. If one side
never reaches the fault point, that point is reported as skipped, not as a difference.

## Converting a test

Route the test class's `browse()` through `browse_driver.browse`. Call `browse_driver.begin_class(fixture_base)` in
`setUpClass`, `begin(self.id())` in `setUp` and `end()` in `tearDown`. Then run the class with
`ARDIA_BROWSE_HARNESS=<dir> ARDIA_BROWSE_TEST_PORTS=9410-9419 ARDIA_BROWSE_CHROME=<chrome>`. Copy the scenarios it
writes into `tests/m3/scenarios/<group>/`, then `record` them. `test_browse_act.ActInChrome` and
`test_browse_read.ReadListsInChrome` are converted this way. `test_browse_e2e.py` and `test_browse_pages_e2e.py` need
Ardia.app; they convert the same way once a hidden instance runs them.

## The CDP link (slice D1)

`ts/src/browse/cdp/link.ts` and `browser.ts` port `wsclient.py`, `guard.py`, `cdp.py` and `browse/connection.py`
(with plugins#11's attach rules). Their link-level harness runs before any daemon exists:

| Piece | File | What it does |
|---|---|---|
| Drivers | `tests/m3/link_driver.py`, `ts/tests/m3/link-driver.ts` | Run one op script (`open`, `send`, `gather`, `pipeline`, `cancel`, `fault`, `close`, …) through Python's `Browser` and the TS `Browser`, and print each op's outcome (result, or error class, message and code). |
| Scenarios | `tests/m3/link-scenarios/*.json` | `ops`, plus `live_only` (a reason), `type_only` (ops whose error is compared by class only) and `pace`. |
| Recordings | `tests/m3/link-transcripts/` | The Python run's transcript and outcomes. |
| Runner | `python -m tests.m3.linkrun record\|replay\|live` | Same tap, normalizer and comparison as the daemon runner. Replay compares outcomes, requests in order and sources; live compares outcomes and request sets on twin Chromiums. |
| Unit tests | `ts/tests/m3/link.test.ts`, `browser.test.ts` (fake peers in `rawpeer.ts`) | What a live Chromium can't produce: the exact 256 MiB boundary, invalid UTF-8, binary frames, close codes, burst ordering, ids, cancellation, and the attach cap. |

`tests.test_m3_harness` replays every recording that isn't live-only against both drivers. Live mode also runs the
faults (`fault_kill`, `fault_stop`, `fault_close`, `fault_drop_error`), the 256 MB scenario and the timeouts.

Chromium's DevTools server never sends a frame over 268,435,456 bytes: it logs "Too large write data is pending" and
drops the reply without closing. So a reply over the link's 256 MiB cap can only come from a fake peer; from Chromium
the command times out, in both implementations.

The link settles a reply in the reader (pending entry, timer, attach slot) but resumes its caller with
`setImmediate`. Bun runs microtasks between the messages of one socket read; Python's reader handles every buffered
message before a waiter resumes. Deferring the resume keeps that order: an event that arrives in the same read as a
reply reaches its handlers before the command that waited goes on.

## The daemon shell (slice D2)

`ts/src/browse/daemon/` is the daemon: `main.ts` (the hidden `ardia-ts daemon` subcommand), `config.ts`, `server.ts`
(socket, admission, the FIFO command lock, busy answers, limits, idle disconnect, the endpoint watch, `close`, signals),
`render.ts` (render, cap, spill, the answer encoding), `claims.ts`, `log.ts` and `spawn.ts` (what the TS client calls to
start a daemon). `ts/src/browse/paths.ts`, `endpoint.ts`, `state/registry.ts` and `state/temptabs.ts` are shared with
later slices. `daemon/stub/` holds the minimum page core the D2 scenarios need (`get title|url`, `open`, `wait`,
`session`); D3 replaces it, and every other command answers `code: "unsupported"` until its slice lands.

| What | How it's run |
|---|---|
| Scenarios `daemon/*` | `python -m tests.m3 live 'daemon/*' --a python --b ts`, `replay 'daemon/*' --impl ts`, `cancel daemon/minimum_set --impl ts`; `tests.test_m3_harness` replays them against the TS daemon |
| Mixed fleets | `--a`/`--b`/`--impl` take `client:daemon` pairs: `python:python`, `python:ts` (`ts` alone means this until the TS client serves browse), `fleet:python`, `fleet:ts`, and `ts:python`/`ts:ts` once the TS client does. `fleet` is `ts/tests/m3/fleet-client.ts`, a minimal TS client that starts daemons through `spawn.ts` |
| Protocol | every request, answer and spawn config of a run is checked against `tests/m3/protocol.schema.json`; a violation is a difference |
| Faults | `ts/tests/m3/daemon.test.ts` (built binary; most cases run against both daemons): stale socket, lock held elsewhere, symlinked or shared folder, oversized and broken requests, a client hanging up, queueing and `beside_if_busy`, close while queued, SIGTERM/SIGHUP/SIGINT during a request, the unconnected exit, the install lease. `daemon-live.test.ts` (headless Chrome for Testing on fixed ports from `ARDIA_D2_CHROME_PORT`, default 9531): idle disconnect then reconnect with a new link, connection loss, the endpoint watch, a folder swapped after it was opened. `daemon-units.test.ts`: render, cap and spill, session keys, seeded tokens and the tab registry checked against Python's own functions. `daemon-review.test.ts`: a replaced socket at exit, `close` interrupted by its client, endpoint discovery that never finishes, the cleanup cut-off and the watchdog, a cancelled attach, the spawn environment and endpoint label, capping 100 MB, the exact request limit, `statAt`'s refusals, and caller announcements to a fake control socket (live Chrome). `daemon-review2.test.ts`: the native watchdog (stuck JavaScript, a replaced socket, argument checks), a daemon whose log is a full non-blocking pipe, a stop that runs into held registry and claims locks (live Chrome behind a slow `/json/version`), detach and crash during attach, a late `createTarget`, the spawn's endpoint variables, queued callers, the bind folder and the exclusive rename, `close`'s queue limit, cancelled control-file discovery, and the registry instance without user info. `daemon-review3.test.ts`: arming before `close` does any work, an arm that fails, the watchdog's fire/disarm race (a test-only delay after the fire is claimed), a descriptor that isn't a folder, marked temporary tabs closed at a stop and by the next sweep, the crashed-tab path on a lost connection, the lock's deadline at grant time, and `ARDIA_PORT` against Python 3.13 on fuzzed input |

The Python seeded client starts the TS daemon when `ARDIA_BROWSE_DAEMON=ts` and appends each spawn config to
`$HOME/spawn-config.jsonl` and each full request to `answers.jsonl` (`wire`), which is what the protocol check reads.
Recordings must be made on the default ports (`ARDIA_M3_PORTS=9400-9419`): the fixture URL in them carries the port.

## Plugin mode (F1-early)

Plugin mode has no Python twin, so its scenarios run the TypeScript plugin daemon alone, on headless Chrome for
Testing through the tap, and check the transcript instead of comparing two sides. The engine's plugin policy
(ardia#2808) isn't in stock Chrome, so the rules it enforces are asserted on the tap.

| Piece | File | What it does |
|---|---|---|
| World | `ts/tests/m3/plugin-world.ts` | One Chrome, one tap, a fixture site and any number of plugin daemons, each spawned through `spawn.ts` with a `plugin` config and given the credential only in requests. Ports `ARDIA_F1_PORTS` (default 9660) up to +7. |
| Rules | `ts/tests/m3/plugin-rules.ts` | `pluginViolations(transcript)`: (a) a forbidden method (`Runtime.*`, `DOM.resolveNode`, `DOM.performSearch`, `Page.createIsolatedWorld`, `DOM.focus`, `Page.captureScreenshot`, `DOM.scrollIntoViewIfNeeded`, `Emulation.setFocusEmulationEnabled`, drags, and `Input.dispatchMouseEvent` as a press, a release or with any button) or any method off the plugin list; (b) an input command (`Input.dispatch*`, `Input.insertText`, `Ardia.dispatchClick`) sent while an earlier one on that connection is unanswered; key events with `nativeVirtualKeyCode`, `isSystemKey` or a command off the editing allowlist; (c) an input command on any session but a page target's own (one the daemon attached with `Target.attachToTarget` to a target reported as `type: "page"` with no subtype; iframe, prerender and auto-attached sessions and the browser session fail). Every harness step posts a tap mark carrying its argv, and the checker classifies it with the daemon's own `find` grammar. `plugin-rules.test.ts` shows each check failing on a made-up transcript. |
| Scenarios | `ts/tests/m3/plugin-live.test.ts`, `plugin-live2.test.ts` | Every verb, the document check before and after, engine refusals injected as CDP errors (`/tap/fault` with `message`), a held input event that must hold back the next one, credential refusals, the files left in `Browse/`, then (a) and (b) on the whole transcript. Skipped without `ARDIA_M3_CHROME`. |
| Pending cases | `ts/tests/m3/plugin-pending.ts <f1-early.json> [--phase 1\|2]` | Runs M1's pending F1-early cases against a fresh plugin daemon each and compares the answer with the recorded reply: `pass` (equal), `designed` (a listed difference, with its reason), `ran` (the reply was a placeholder and the step ran), `n/a` (client-only), `fail`. |

Stock Chrome has none of ardia#2808's plugin additions, so the plugin world starts the tap with three test-only fakes:
`--emulate-dispatch-click 1` answers each `Ardia.dispatchClick` itself after sending Chromium a press, waiting for its
answer, then a release; `--emulate-act-hold 1` stands in for the engine's act visibility hold: after `POST /tap/hold
{target, front}`, the mark of an acting step makes the tap activate `target` through its own owner connection
(`Target.activateTarget`) before the step runs, and `/tap/unhold`, which the harness posts after every step,
activates `front` again (both written as `{"k": "hold"}`); `--emulate-hidden-wheel-refusal 1` reads
`document.visibilityState` before forwarding a `mouseWheel`, writes `{"k": "visibility"}`, and refuses the wheel with
`ardia: page_hidden` when the page is hidden. Check (e) fails a wheel during a step that doesn't act (or before any
step) and a wheel a hidden page saw that wasn't refused with `ardia: page_hidden`. Scenarios that need a fake say so in
their names (`[tap emulates Ardia.dispatchClick]`, `[tap emulates the act visibility hold]`). `plugin-hidden.test.ts`
acts on a really hidden tab and needs a full Chrome for Testing (`ARDIA_F1_CHROME`, `--headless=new`);
chrome-headless-shell never hides a tab. Those two events are written as `{"k": "emulated"}`, which the rules don't read as the
daemon's traffic. Scenarios whose clicks need it say so in their names (`[tap emulates Ardia.dispatchClick]`); against
a real plugin engine the flag stays off.

`ARDIA_M3_TS_PROGRAM` names the built program the daemons run; `ARDIA_F1_SENT=<file>` writes the methods each marked
step sent.

### Acceptance case (d): an act on a hidden tab

`ts/tests/m3/plugin-background.ts` (run with Bun; `ARDIA_F1_CHROME` names a full Chrome for Testing, run
`--headless=new`, since chrome-headless-shell never hides a tab) opens a form in a background tab
(`Target.createTarget {background: true}`) behind a visible one and acts on it the plugin's way over raw CDP: a click
(a buttoned press and release stands in for `Ardia.dispatchClick` on stock Chrome), `Input.insertText`, Enter, and, in a
second act, wheels (at most 4) that bring a button in a lower area into view and a click on it. Each act holds the tab
visible the way the engine's act hold will (the harness activates it on the owner session, then the front tab again),
and the report checks the tab is hidden before and after every act. It reads the results through DOM and the AX tree (no Runtime on the plugin's
session), reads `visibilityState` through a separate owner session, and prints a JSON report, including whether hit
testing found the field and whether the field had focus before the insert. Rerun it against the ardia#2808 build
(engine/next) when it exists, where `Ardia.dispatchClick` is real.

