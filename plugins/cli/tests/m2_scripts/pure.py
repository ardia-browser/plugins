"""Feeds each Python function in tests/m2_scripts/functions.py and its TypeScript twin the same inputs and diffs the outputs.

  python -m tests.m2_scripts.pure <name|all> [--generated N] [--seed S] [--show N]

Each function gets its fixed cases (tests/m2_scripts/cases.py FIXED) and N generated ones (GENERATORS). Results compare
exactly, ints and floats apart and object keys in order; errors compare by kind and message, except Unicode and
address errors, which compare by kind.
"""
import argparse
import json
import random
import shutil
import subprocess
import sys
from pathlib import Path

from tests.m2_scripts.cases import FIXED, GENERATORS
from tests.m2_scripts.functions import FUNCTIONS

CLI = Path(__file__).resolve().parents[2]
TS_ORACLE = CLI / "ts" / "tests" / "m2-scripts" / "oracle.ts"


def bun() -> str:
    found = shutil.which("bun") or str(Path.home() / ".bun" / "bin" / "bun")
    if not Path(found).exists():
        raise SystemExit("pure: bun is needed to run the TypeScript side")
    return found


def strict(text: str) -> list:
    return json.loads(text, parse_int=lambda digits: ("int", digits), parse_float=lambda digits: ("float", digits),
                      parse_constant=lambda name: ("float", name), object_pairs_hook=lambda pairs: ("object", pairs))


def run(argv: list[str], cases: list) -> str:
    payload = json.dumps(cases, ensure_ascii=True).encode()
    done = subprocess.run(argv, input=payload, capture_output=True, cwd=CLI, timeout=1800)
    if done.returncode:
        raise SystemExit(f"{' '.join(argv)} failed ({done.returncode}): {done.stderr.decode(errors='replace')[-2000:]}")
    return done.stdout.decode()


def compare(name: str, cases: list, show: int) -> tuple[int, int]:
    python_text = run([sys.executable, "-m", "tests.m2_scripts.oracle", name], cases)
    typescript_text = run([bun(), str(TS_ORACLE), name], cases)
    python, typescript = strict(python_text), strict(typescript_text)
    raw_python, raw_typescript = json.loads(python_text), json.loads(typescript_text)
    differing = [index for index, (a, b) in enumerate(zip(python, typescript)) if a != b]
    if len(python) != len(typescript):
        differing.append(min(len(python), len(typescript)))
    for index in differing[:show]:
        left = raw_python[index] if index < len(raw_python) else None
        right = raw_typescript[index] if index < len(raw_typescript) else None
        print(f"case {index}: input {json.dumps(cases[index] if index < len(cases) else None)[:300]}\n"
              f"  python: {json.dumps(left)[:400]}\n  ts:     {json.dumps(right)[:400]}")
    print(f"{name}: {len(cases) - len(differing)} of {len(cases)} cases agree", flush=True)
    return len(cases), len(differing)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m tests.m2_scripts.pure", description=__doc__.split("\n\n", 1)[1],
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("name", help="a function name, or all")
    parser.add_argument("--generated", type=int, default=300)
    parser.add_argument("--seed", default="m2-scripts")
    parser.add_argument("--show", type=int, default=5)
    args = parser.parse_args(argv)
    names = sorted(FUNCTIONS) if args.name == "all" else [args.name]
    failed = 0
    for name in names:
        if name not in FUNCTIONS:
            raise SystemExit(f"pure: unknown function {name!r}")
        draw = random.Random(f"{args.seed}:{name}")
        generate = GENERATORS.get(name)
        cases = list(FIXED.get(name, [])) + ([generate(draw) for _ in range(args.generated)] if generate else [])
        _, differing = compare(name, cases, args.show)
        failed += differing
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
