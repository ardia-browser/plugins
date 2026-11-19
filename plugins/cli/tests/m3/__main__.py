"""The browse daemon's differential harness (docs/m3-harness.md).

  python -m tests.m3 record   [scenario ...]               live Python run; writes transcripts/<name>.jsonl.gz and .expect.json
  python -m tests.m3 replay   [scenario ...] [--impl I]     answer the daemon from the recording, no browser
  python -m tests.m3 live     [scenario ...] [--a I --b I]  twin headless Chromiums, one daemon each, compared
  python -m tests.m3 selftest [scenario ...]                live python/python, then replay python
  python -m tests.m3 cancel   scenario [--impl I] [--step N ...] [--kind K]
                                                          Ctrl-C (or K: kill|stop|close|drop|error) at every CDP request
  python -m tests.m3 list

Scenarios are names under tests/m3/scenarios (globs allowed). I is python, ts, or a client:daemon pair (python, fleet or ts
client; python or ts daemon). ts alone is Python's client with the TS daemon until the TS client serves browse; ts needs
ARDIA_M3_TS_PROGRAM.
Live modes need ARDIA_M3_CHROME. Ports come from ARDIA_M3_PORTS (default 9400-9419).
"""
import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from tests.browse_driver import PAIRS
from tests.m3 import runner


def report(results: list[dict], as_json: bool) -> int:
    failed = [result for result in results if not result.get("ok")]
    if as_json:
        print(json.dumps(results, indent=1, ensure_ascii=False))
    else:
        for result in results:
            mark = "ok  " if result.get("ok") else "FAIL"
            extra = f" (skipped: {result['skipped']})" if result.get("skipped") else ""
            extra += f" {result['requests']} requests, {result['bytes']} bytes" if "requests" in result else ""
            print(f"{mark} {result.get('mode', 'record')}: {result['name']}{extra}")
            for line in result.get("differences", [])[:20]:
                print(f"       {line}")
        print(f"{len(results) - len(failed)} of {len(results)} passed")
    return 1 if failed else 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m tests.m3", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["record", "replay", "live", "selftest", "cancel", "list"])
    parser.add_argument("scenarios", nargs="*")
    parser.add_argument("--impl", default="python", choices=PAIRS)
    parser.add_argument("--a", default="python", choices=PAIRS)
    parser.add_argument("--b", default="python", choices=PAIRS)
    parser.add_argument("--step", type=int, action="append")
    parser.add_argument("--kind", default="interrupt", choices=["interrupt", "kill", "stop", "close", "drop", "error"])
    parser.add_argument("--pace", choices=["asap", "recorded"], help="override the scenarios' replay pace")
    parser.add_argument("--scratch", type=Path)
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    paths = runner.scenario_paths(args.scenarios)
    if args.command == "list":
        for path in paths:
            scenario = runner.load(path)
            print(f"{scenario['name']}  {len(scenario['steps'])} steps{'  live-only' if scenario.get('live_only') else ''}")
        return 0
    if not paths:
        print("no scenarios matched", file=sys.stderr)
        return 2
    scenarios = [runner.load(path) for path in paths]
    if args.pace:
        for scenario in scenarios:
            scenario["pace"] = args.pace
    with runner.Harness(args.scratch, args.keep) as harness:
        if args.command == "cancel":
            results = [result for scenario in scenarios for result in harness.cancel(scenario, "python", args.impl, args.kind, args.step)]
            return report(results, args.json)
        jobs = {
            "record": lambda scenario: [harness.record(scenario)],
            "replay": lambda scenario: [harness.replay(scenario, args.impl)],
            "live": lambda scenario: [harness.live(scenario, args.a, args.b)],
            "selftest": lambda scenario: [harness.live(scenario), harness.replay(scenario)],
        }[args.command]
        width = harness.workers if args.command in ("record", "replay") else max(1, harness.workers // 2)
        with ThreadPoolExecutor(width) as pool:
            results = [result for found in pool.map(jobs, scenarios) for result in found]
    return report(results, args.json)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
