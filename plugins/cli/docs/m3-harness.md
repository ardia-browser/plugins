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
- Ports come from `ARDIA_M3_PORT_BASE` (default 9400): each agent owns the block of 20 starting there (D3 9400, D4
  9420, D5 9440, F1-early 9460, reviewers 9500 and up). In a block, +0 to +17 are Chromium and tap pairs, +19 serves
  the fixtures, `human_core` takes +16 and +17, and the D2 bun tests (`ARDIA_D2_CHROME_PORT` overrides them) take +10
  to +14. A run first checks every port of its block and stops at once if any is bound (bound locally or answering a
  connection), so a daemon never talks to another agent's tap. `ARDIA_M3_PORTS` is refused.
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
  `() => document.readyState` probe, and `Page.getFrameTree` and the `document.visibilityState` probe, which the TS
  daemon skips when it read them in the last 0.75 s and 0.25 s; those two are left out before the set's IDs are numbered,
  rule `cached-probes`). Chromium's load timing decides how often Python polls and whether the load event
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

A scenario with more than one session ends with an explicit `close` step for each, in a fixed order. The side's
teardown (`close --all`) closes sessions in the order of their keys, and a key hashes the endpoint, whose port differs
between the recording and the replay. Left to teardown, the sessions close in a different order, so the tabs' close
requests and the registry's ids are numbered differently, and Python fails its own replay
(`tabs/tab_active_borrowed` did).

Scenarios under `stacked/` use commands from more than one slice (`snapshot`, `read` and `get text` from D4, `click`
from D5, with D8's navigation), so the TypeScript side replays them only once those slices are merged. Python records
and replays them as usual.

The tap delivers each Chromium burst as one write (a burst ends after 3 ms of quiet, or at 250 ms). Python handles every
message of one socket read before the command that waited on an answer resumes, so the grouping decides what the
daemon sees first. Live and replay therefore group the same way.

The recorded scratch root is replaced by the replay's own root in every frame, so paths match.

Credentials never reach a recording: the tap writes `Fetch.continueWithAuth` and `Network.continueInterceptedRequest`
with `authChallengeResponse.username` and `password` as `<REDACTED>`, and does the same for `Authorization`,
`Proxy-Authorization` and `Cookie` header values (`Network.setExtraHTTPHeaders`, `Fetch.continueRequest`) and for
cookie values being set (`Network.setCookie`, `Network.setCookies`, `Storage.setCookies`). Chromium still gets the
real values. Replay matches requests on that redacted form, and the normalizer (`secrets` rule) applies the same
redaction, so recordings made before the rule compare the same way.

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
| `interrupt` (default) | The tap holds request k, the harness sends SIGINT to the client (Ctrl-C), then releases the request. Later requests on the same CDP session queue behind the held one and follow it in order, as on a real WebSocket; other sessions aren't held. |
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
Recordings can be made in any block: each `.result.json.gz` stores its fixture port in `subs.fixture` (recordings from
before that have none and mean 9419). Replay rewrites the recorded fixture port to the replaying block's own in the
recorded messages (the tap's `--fixture-from` and `--fixture-to`), and the normalizer writes every fixture port as
`<FIXTURE>`, so any recording replays in any block.

## The page core (slice D3)

`ts/src/browse/state/` is the page core: `page.ts` (attach, frames, isolated worlds, `call`, crash and detach, setup
restore, the busy probe), `state.ts` (connection, targets, tab ids, the lost-tab follow, `tab active`'s probes),
`refs.ts` (refs and their staleness), `apptabs.ts` (Ardia's tab list over the control socket) and `records.ts` (console,
error and network records for D6). `ts/src/browse/commands/` holds the command table (`index.ts`: every Python command,
its owning slice, `register()`, `dispatch()` and its hooks), the parser (`parse.ts`), `Ctx` (`ctx.ts`) and the commands
D3 serves (`core.ts`: `open` without change reports, `get title|url`, `wait`, `session`). Later slices register their
commands from their own files and import them in `all.ts`; a name registered twice, or one outside the table, throws.

| What | How it's run |
|---|---|
| Scenarios `core/*` | `live 'core/*' --a python --b ts`, `replay 'core/*' --impl ts` (`core/open_title` waits for D5's change report on `open`; its `get title` and `snapshot -i` match live), `cancel core/frames_worlds --impl ts --kind interrupt\|error\|drop` |
| Designed divergences | `tests/m3/divergences.py`: each entry names its ardia#2812 row; a scenario lists the ones it needs in `divergences`, and only the named request form is rewritten, on both sides. `drop` and `stop` fault runs add `busy-probe-isolated`, since an unanswered call is what sends the probe. Every TS run (live, replay, fault) also fails on `Runtime.enable`, `Debugger.enable` or `Console.enable` on a page session and on a main-world busy probe |
| Racy steps | `racy_steps` in a scenario: only the exit status is compared, for a step where Chromium decides which of two errors one request gets |
| Main-world steps | `"main_world": true` on a step: the TS side runs its `eval` (or each `eval` line of a `batch`) as `eval --main-world`, which sends the same `Runtime.evaluate` Python does. The act scenarios read the fixtures' own globals (`state`, `reveal()`), which the isolated `eval` can't see by design (`eval-isolated`) |
| Designed scenarios | `"designed": "<why>"`: live mode runs the TS daemon on both sides, for a scenario whose Python answer is a known bug the TS daemon fixes (`tabs/dialog_on_busy_page`), or whose requests the TS daemon cuts on purpose (plugins#92: `act/d5_drag_scroll`, `act/d5_pointer`, `d4/diff_vitals`, `d4/snapshot_get_is`, `d4/read_page`, `core/frames_worlds`, `core/show`, `daemon/minimum_set`, `daemon/waits`, which also carry `live_only`, since a Python recording can't answer the TS daemon's page calls) |
| Unstable steps | `unstable_steps`: live mode compares only exit and stderr, and none of the step's requests (`js/script_runs` step 11, an unawaited call) |
| TS-only metrics | the metrics key set leaves out the flags and counts only the TS daemon registers (`normalize.ts_only_metrics()`) |
| Human tier | `python -m tests.m3.human_core --pages <plugins#13 tests/human> --chrome <Chrome for Testing> [--impl ts\|python]`: rows 7 to 13 through `ardia browse`, with a full Chrome for Testing in `--headless=new` (chrome-headless-shell is old-mode headless and sets `navigator.webdriver`). Clicks D5 doesn't serve yet are made by the tier and named in the row's notes |
| Unit tests | `ts/tests/m3/core.test.ts` (attach order, publish after the frame refresh, busy probe world, worlds per document, re-homing, crash and detach, setup restore, the probe rules, refs, the table) and `core-ported.test.ts` (`test_browse_crash` and `test_browse_detach`, same names) |

## The read side (slice D4)

`ts/src/browse/snapshot/collect.ts` and `take.ts` build snapshots on P2's tree and render, and set `Refs.snapshots`.
`ts/src/browse/read/` holds `read`: `pages.ts` (several pages in reader tabs, `--links`, rendering under the shared cap),
`scroll.ts` (`--scroll`), `pagedata.ts` (`--data`), `pdftext.ts` (osascript), `fetch.ts` and `charset.ts`
(`--http`, decoded with Python's codec registry from `codecs.gen.json`, which `ts/scripts/gen-codecs.py` writes),
`settle.ts` (settling, and the same-document navigation `navigate` uses) and `frames.ts` (out-of-process frame text).
`ts/src/browse/state/oopif.ts` attaches out-of-process iframes (`page.frameSessions`, `page.oopifs`, `page.sessionFor`)
and `pierce.ts` searches shadow roots. The commands are in `commands/read.ts`, `read-page.ts`, `find.ts` and
`storage.ts`, with `shared.ts` holding what D5 also uses (`resolve`, `currentOrNew`, `refuseOnBorrowed`).

| What | How it's run |
|---|---|
| Scenarios `d4/*` | `live 'd4/*' --a python --b ts`, `record 'd4/*'`, `replay 'd4/*' --impl ts`; three are copies of H's `read/*` with `open --no-changes` and without their `eval` step (D5, D7). `d4/find_missing` and the two scroll scenarios are live-only |
| Always-on divergences | `oopif-auto-attach` (row 13), `shadow-pierce` (row 12), `temp-tab-marker` (D2's decision). Replay answers `Target.setAutoAttach` with `{}` and the pierce's `() => document` call with null, and matches a marked reader tab's `createTarget` against the recorded `about:blank` |
| Elastic probes | `(s) => ardiaBrowse.query(s)` repeats as often as a 3 s wait for an element polls |
| Read stamps | the `read-stamp` rule also masks the time in a page header's `(HTTP 200, read …)` and `(read …)` |
| Human tier | rows 12 (closed shadow roots: `get text` and `snapshot`) and 13 (each out-of-process frame's secret through `read` and `snapshot`; passes on the page's `readOk`, since clicks are D5's) |
| Unit tests | `ts/tests/m3/read.test.ts` ports `test_browse_read`'s PagesCap and ScrollRows, `test_browse_pages`' Links, HashRoutes, SameDocumentRead, Urls, Rendering and ReadingTabs, and `test_browse`'s ReadTest and CookieFileTest (same names). `read-net.test.ts` checks charset decoding against CPython (every codec name in several spellings on random bytes, broken UTF sequences), fetch against a local server (charset, redirects, HTTP errors, timeouts, refusal, cancellation, a self-signed TLS server), shadow-root discovery, the OOPIF session bookkeeping and frame offsets across nested OOPIFs. `read-live.test.ts` (headless Chrome, `ARDIA_M3_CHROME`, port `ARDIA_D4_CHROME_PORT`, default `ARDIA_M3_PORT_BASE` + 8): one match for an element in an open root inside a closed one, no DOM events after a pierce read, the closed-root timing, and a snapshot refused when its document changes mid-collect |

## The act side (slice D5)

`ts/src/browse/act/` holds what `actions.py` did: `common.ts` (the delivery check, viewport, `overFrame`), `pointer.ts`
(target point, cover handling, click, hover, the DOM-click fallback, `click --touch`), `fields.ts` (fill, type, check,
select, suggestions, grid cells), `drag.ts` (the drag-intercept flow), `scroll.ts`, `react.ts` and `find-act.ts` (the
actions `find` hands over). `ts/src/browse/input/` adds `input.ts` (`Input`: held keys and buttons, `gesture`,
`pressCombo` with the macOS editing commands), `mouse.ts` and `keyboard.ts` on top of P2's `human.ts` and `keys.ts`.
`ts/src/browse/changes/observe.ts` is the change report's observer (network watch, settle, the settle reaction,
`open`'s arrival report), `state/frames.ts` routes element calls to each frame's own session on top of D4's `state/offsets.ts`. The commands are in
`commands/act.ts` and `commands/batch.ts`.

| What | How it's run |
|---|---|
| Scenarios `act/d5_*` | `live 'act/d5_*' --a python --b ts --keep` on a fixture (`act-input.html`) whose title reports what the page saw. `replay act/d5_pointer act/d5_drag_scroll --impl ts`; `d5_fields`, `d5_keys`, `d5_batch` and `d5_changes` wait for D7's flow log (Python probes the focused field after each step and reads response bodies while a change settles); live, their answers match. `d5_batch_close` is live only |
| Faults | `cancel act/d5_drag_scroll --step 1 --impl ts --kind interrupt\|error\|drop`: the HTML5 drag's cleanup (drag cancel, button release, interception off) at every CDP call |
| Human tier | `python -m tests.m3.human_act --pages <plugins#13 tests/human> --chrome <Chrome for Testing> [--impl ts\|python]`: rows 1, 2, 4, 5, 6, 20 and 21. The tier turns touch emulation on for row 1 (standing in for `set device`), sends row 5's IME composition and drops row 6's files, since the CLI has no command for them; row 21 runs on D4's closed-shadow selectors |
| Transcript checks | every TS run also fails on a touch event sent before touch emulation or the page's touch probe (row 1) and, on macOS, a Meta editing shortcut without its command (row 20) |
| Unit tests | `ts/tests/m3/act-ported.test.ts`: `test_browse_act`, `test_browse_drag`, `test_browse`'s held input and `test_browse_changes`' network watch, same names, plus the editing commands per platform |

## Scripting, flows and raw access (slice D7)

`ts/src/browse/commands/{pagejs,settings,cdp,notes}.ts`, `script/`, `flows/`, `auth/` and `cdp/{raw,params}.ts` port
`eval`, init scripts, `clipboard`, `set`, `cdp` (plugins#11), `script`, the flow log, `flow`, `auth login`, the
credential providers and the page half of `notes`. `notes-files.ts` holds the file half until M2 takes it.

| What | How it's run |
|---|---|
| Scenarios `js/*` | `live 'js/*' --a python --b ts`. `js/settings_notes_flows` also replays. `js/eval_reads`, `initscript`, `script_runs` and `clipboard` name the `eval-isolated` and `script-isolated` divergences, so they are live only (replay can't serve a request Python never sent). `js/cdp_raw` needs plugins#11's Python: run it from a copy of `plugins/cli` whose `ardia_cli` is full-control/cli's, until #11 is on main |
| Function oracle | `python -m tests.m3.pure d7.<name> --generated 1500` for every `d7.*` twin in `tests/m3/oracle_fns_d7.py` (generators in `cases_d7.py`): cdp params, flow building, validation, signatures, drift, URL templating and filling, masking, sites, embedded JSON, the script worker source and its helpers, selector quoting, Keychain quoting. `d7.cdp_params` needs plugins#11's Python, like `js/cdp_raw` |
| Unit tests | `ts/tests/m3/d7.test.ts`: the Keychain's argv and stdin (secret on stdin only), its failure, deadline and missing-program messages; credential providers' environment, working folder, bad answers, deadline and reply cap; tools without a shell; `git ls-remote` resolution; the `using` hold of `cdp --target`; the flow and note stores; the isolated `eval` call |
| Human tier | `python -m tests.m3.human_d7 --pages <plugins#13 tests/human> --chrome <Chrome for Testing>`: rows 3 (clipboard after `clipboard write`'s grant), 9 (`eval` and `script` leave no global and no foreign stack frame) and 14 (geolocation, notifications and camera after `set permission`) |
| Secrets | `python -m tests.m3.secret_check`: for the passwords `a`, `"`, `-x`, `--foo` and a long one, generates the `set credentials`/`set auth` and script scenarios, runs them TS against TS, and checks every `--json` reply parses, no reply is masked, no stderr repeats a dash-prefixed password, and the long one appears in no file and no reply. Not searched: the requests the client sent, and the CDP transcript of the script scenarios (the tap records the script's own source on its way to the worker; D3's tap still redacts CDP credential fields) |
