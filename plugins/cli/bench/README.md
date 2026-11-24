# Browser-agent bench

Claude Code and Codex driving Ardia through `ardia browse`, against Browser Use (cloud browser) and Aside's built-in
agent. Every contender gets the same eight everyday web apps and the same prompt. A checker on each app's own server
grades the run.

```
tasks.json            the registry every side reads
tasks/benchhttp.py    stdlib HTTP helpers every task server uses (port offsets, static files, /realism.js)
tasks/realism.py/.js  signed writes that record how each write arrived (the check's `method`)
tasks/benchclient.py  the signed client the newer selftests use
tasks/<id>/           server.py, fixture/ (the app), selftest.py (checker proof over HTTP)
harness/bench.py      the harness and plan runner (python3 -I harness/bench.py --help)
plans/*.json          tasks x contenders x repeats
```

## Tasks

| id | app | ports | deadline |
| --- | --- | --- | --- |
| `calendar` | Calendar week view: add five events | 8791 | 480 s |
| `research` | Developer docs with search, versions and nested pages, plus a questionnaire | 8801-8802 | 600 s |
| `booking` | Four-step flight booking: search, fares, passengers and seat map, review | 8811 | 600 s |
| `shop` | Electronics shop: categories, specs, a coupon on another page, checkout | 8821 | 480 s |
| `multitab` | Inbox, team directory and room scheduler on three origins: book the meeting | 8851-8853 | 600 s |
| `news` | Signal Daily: cookie banner, newsletter modal, a review behind tabs, a follow-up behind an accordion; bookmark the review and file a research note | 8871 | 480 s |
| `triage` | Forge issue tracker: filter v2.4, load more, read the linked PR to find the owner, label, assign, comment, close a duplicate | 8881 | 600 s |
| `compare` | Vantage pricing (billing toggle, seat calculator with volume rates, feature matrix), security page and changelog, then a purchase request on Northwind Procurement | 8891-8892 | 600 s |

Each task has traps a careless agent falls into: the manufacturer's battery claim and the retest result next to the
review's own number, the PR author versus the engineer who took the PR over, the monthly price and the list price
without volume rates, the superseded SOC 2 Type I date, and an archived notice for the old Dublin EU region.

Each server is Python stdlib only (3.9 or newer), run from this folder as `python3 -I tasks/<id>/server.py`, on fixed
ports, and stops on SIGTERM. With `BENCH_PORT_OFFSET=N`, `benchhttp.serve_forever` binds each port + N and rewrites
`127.0.0.1:<port>` and `localhost:<port>` to `<port> + N` in text bodies and headers, for that server's own ports
only, so links between a task's origins keep working on every lane. Endpoints:

- `POST /api/reset` puts everything back to its initial state.
- `GET /api/check` returns `{pass, matched, total, completed_at_ms, reset_at_ms, details}`, plus `method`
  (`{label, accepted, ui, ui_scripted, no_event, rejected, rejected_reasons, trigger_events}`, `label` one of `ui`,
  `ui_scripted`, `no_event`, `mixed`, `none`) and `invariants` (`{name: bool}`) on `news`, `triage` and `compare`.
  - `completed_at_ms` is when the write that made the state pass happened.
  - `details` shows what's wrong and what the user entered, never the expected values.
  - Every side grades a run the same way (`harness/grading.py`): the check passes, the run finished before its
    deadline, and nobody reset the task during it.

Neither endpoint is linked from the apps. `python3 -I tasks/<id>/selftest.py`, with the server running (and the same
`BENCH_PORT_OFFSET` for the newer tasks), checks that a fresh state fails and leaks nothing, the correct solution
passes, and each trap fails.

## Registry

`tasks.json` is `{version, tasks: [...]}`; each task has `id`, `title`, `server` (`{command, ports}`, run with this
folder as cwd), `start_url` (the only tab open when the run starts), `extra_urls` (other URLs the prompt names),
`preopen_extra` (false everywhere), `reset` and `check` (`{method, url}`), `deadline_s`, `prompt` (verbatim, the
same for every contender) and `today` (each side's prompt ends with "Today is Friday, November 6, 2026."). `today`
`"live"` uses the run's own date (or `BENCH_TODAY`), and `business_days` fills a `{name}` in the prompt with the date
that many business days later; `shop` uses both, and its store dates its deliveries and promos from the same clock.

## Running

Copy a Release build into the bench home and run the copy, never the build in place and never `/Applications`:

```sh
mkdir -p ~/ardia-scratch/bench-proper/app
ditto <ardia checkout>/apps/browser/build-engine-cli/Build/Products/Release/Ardia.app ~/ardia-scratch/bench-proper/app/Ardia.app
cd plugins/cli/bench
python3 -I harness/bench.py freeze-cli
python3 -I harness/bench.py plan plans/smoke.json
python3 -I harness/bench.py run news claude try-1 --claude-base-url http://127.0.0.1:8317 --claude-auth-token local
python3 -I harness/bench.py servers start triage --port-offset 1000
python3 -I harness/bench.py stop
```

### The daily run, split across two Macs

| plan | machine | contenders |
| --- | --- | --- |
| `plans/daily-ardia.json` | MacBook | `ardia-codex` (GPT-6.2 Sol high), `ardia-claude` (Opus 5.5 high); 3 lanes, normal memory pressure only, one shared app copy |
| `plans/daily-bucloud.json` | Mac mini | `bucloud-codex`, `bucloud-claude` (Browser Use cloud browser, 2 lanes each); lanes from 10 |
| `plans/daily-aside.json` | Mac mini | `aside-sol`, `aside-opus`; one lane, from 20 |
| `plans/daily-compare.json` | Mac mini | the four above in one plan, paced together |
| `plans/daily.json` | one machine | all six |
| `plans/smoke.json` | either | `news` once with both Ardia contenders |

Each plan runs all eight tasks twice. Claude Code runs go through VibeProxy (`claude_base_url`
`http://127.0.0.1:8317`, `claude_auth_token` `local`), then merge the two machines' results:

```sh
python3 -I harness/bench.py plan plans/daily-ardia.json --app ~/ardia-scratch/bench-proper/app/Ardia.app
python3 -I harness/bench.py plan plans/daily-bucloud.json
BENCH_HOME=~/ardia-scratch/bench-aside python3 -I harness/bench.py plan plans/daily-aside.json
python3 -I harness/bench.py summarize ~/ardia-scratch/bench-proper/results/daily-ardia \
  ~/mini-results/daily-bucloud ~/mini-results/daily-aside \
  --out ~/ardia-scratch/bench-proper/results/daily
```

`summarize` takes one or more results dirs (or one dir with both machines' `runs/` copied in) and writes one
`summary.json`: contenders from every `plan.json` plus any found only in run records, a run id seen twice keeps the
record without a harness error, and each contender lists the `hosts` it ran on.

### Plan keys

`name`, `repeats`, `tasks` (`"all"` or ids), `contenders`, `results`, and optionally `max_lanes`, `lane_base`,
`normal_pressure_only`, `max_load_1m`, `pace_slack`, `max_round_lead`, `clean_run_scratch`, `shared_app`,
`claude_base_url`, `claude_auth_token` and the Ardia keys (`app`, `port`, `cli`, `ardia_test`). A contender's own key
beats the plan's. `plan --app PATH` replaces the plan's `app` for this machine.

### Claude Code routing

Every side starts `claude -p` with `--setting-sources project --strict-mcp-config --no-session-persistence`, so
`~/.claude/settings.json` never applies. `claude_base_url` and `claude_auth_token` (contender, plan, `run
--claude-base-url/--claude-auth-token`, else `BENCH_CLAUDE_BASE_URL` / `BENCH_CLAUDE_AUTH_TOKEN`) become
`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` in the agent's environment, and a configured token drops
`ANTHROPIC_API_KEY`. With neither set, Claude Code talks to Anthropic directly. Records note `claude_route`.

### Lanes and scheduling

- Lane `k` runs its own copy of every task server at `BENCH_PORT_OFFSET=1000(k+1)` and rewrites the task's URLs
  and prompt to match; Aside stays on +0, since its driver reads a copy of
  `tasks.json` with every prompt already dated. `lane_base` shifts the numbering so two
  plans on one machine don't share servers (give the second its own `BENCH_HOME` too).
- The plan refuses to start when an offset task port hits a harness port (Ardia `port + k`, Browser Use local CDP
  `9671 + k`, OpenCode `9571 + k` / `19990 + k`) or the ephemeral range; cloud-browser lanes reserve no CDP port.
  `--dry-run` prints that check and a simulated timeline.
- New lanes open only under 70% memory, nothing starts above 75%, and `normal_pressure_only` holds new runs unless
  macOS memory pressure is normal. Contenders progress together (`pace_slack`, `max_round_lead`). Rate limits and
  harness errors are retried; a plan resumes where it stopped.
- `python3 -I harness/test_scheduler.py` and `python3 -I harness/test_grading.py` test the scheduler and the pass
  rule.

## Sides

- **Ardia** (`kind: ardia`): one hidden instance per lane (`open -g -n`, `ARDIA_BACKGROUND=1`, its own data dir and
  DevTools port), cold site notes, the skill installed into a fresh workdir, and the prompt's last line names the
  port.
- **Browser Use** (`kind: browseruse`, `browser-use==1.0.0` in `BENCH_BROWSERUSE_HOME`, default
  `~/ardia-scratch/browser-use`): `"browser": "local"` drives a headless Chrome for Testing over CDP;
  `"browser": "cloud"` opens cloudflared tunnels to the lane's task servers, starts a Browser Use cloud browser
  (`cloud_country`, key in `~/ardia-scratch/bu-bench/.bu_api_key`), opens the public start URL and hands the agent
  `BU_CDP_WS`. The browser and tunnels stop when the run ends.
- **Aside** (`kind: aside`): `aside_run.mjs` from `BENCH_ASIDE_DRIVER`, else
  `~/ardia-scratch/bench-others/aside-driver/` or `~/ardia-scratch/aside-bench/bin/`, run with the Node the harness
  finds (`BENCH_NODE`, `PATH`, `~/.local/node*/bin`, Homebrew), so non-login SSH on the Mac mini works.
- **OpenCode Browse**, **Betterwright**, **Browser Harness**, **Browser Use agent** and **Ardia CLI on a cloud
  browser** (`kind: opencode`, `betterwright`, `browserharness`, `browseragent`, `ardiacloud`) still run with
  `bench.py run --side …`; no daily plan uses them.

Scratch lives in `BENCH_HOME` (default `~/ardia-scratch/bench-proper`): `app/`, `cli/`, `devbin/`, `data-ardia/`,
`work/`, `state/`, `logs/` and `results/`, plus per-lane `app-lane<k>/`, `data-ardia-lane<k>/` and
`codex-home-lane<k>/`.
