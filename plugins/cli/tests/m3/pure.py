import argparse
import json
import os
import random
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLI = HERE.parents[1]
sys.path.insert(0, str(HERE))

from cases import GENERATORS, recorded_strings
import cases_p2
import cases_p2b


def run(command: list[str], lines: str) -> list[str]:
    with tempfile.TemporaryFile("w+") as feed:
        feed.write(lines)
        feed.seek(0)
        done = subprocess.run(command, stdin=feed, capture_output=True, text=True, cwd=CLI)
    if done.returncode != 0:
        raise SystemExit(f"{command[0]} failed ({done.returncode}):\n{done.stderr[-4000:]}")
    return done.stdout.splitlines()


def main() -> int:
    parser = argparse.ArgumentParser(description="Feeds the same recorded and fuzzed inputs to each Python function and its "
                                     "TypeScript twin (tests/m3/oracle.py, ts/tests/m3/oracle.ts) and compares the JSON answers exactly.")
    parser.add_argument("--fn", action="append", default=[], help="only functions whose name starts with this (repeatable)")
    parser.add_argument("--count", type=int, default=2000, help="fuzzed cases per function")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--show", type=int, default=5, help="mismatches printed per function")
    parser.add_argument("--bun", default=os.environ.get("BUN", "bun"))
    args = parser.parse_args()
    corpus = recorded_strings(CLI / "tests")
    cases: list[dict] = []
    for name, generate in GENERATORS.items():
        if args.fn and not any(name.startswith(prefix) for prefix in args.fn):
            continue
        rng = random.Random(f"{args.seed}:{name}")
        for case_args in generate(rng, args.count, corpus):
            cases.append({"fn": name, "args": case_args})
    lines = "".join(json.dumps(case, ensure_ascii=True) + "\n" for case in cases)
    python = run([sys.executable, "-I", str(HERE / "oracle.py")], lines)
    typescript = run([args.bun, "run", str(CLI / "ts" / "tests" / "m3" / "oracle.ts")], lines)
    if len(python) != len(cases) or len(typescript) != len(cases):
        raise SystemExit(f"answer count: {len(cases)} cases, Python {len(python)}, TypeScript {len(typescript)}")
    totals: dict[str, list[int]] = {}
    shown: dict[str, int] = {}
    for case, left, right in zip(cases, python, typescript):
        tally = totals.setdefault(case["fn"], [0, 0])
        tally[0] += 1
        if left != right:
            tally[1] += 1
            if shown.get(case["fn"], 0) < args.show:
                shown[case["fn"]] = shown.get(case["fn"], 0) + 1
                print(f"MISMATCH {case['fn']} {json.dumps(case['args'], ensure_ascii=True)[:600]}\n  python: {left[:600]}\n  ts:     {right[:600]}")
    failed = 0
    for name, (count, bad) in totals.items():
        print(f"{name:32} {count:7} cases  {'OK' if not bad else f'{bad} differ'}")
        failed += bad
    print(f"total {sum(count for count, _ in totals.values())} cases, {failed} differ")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
