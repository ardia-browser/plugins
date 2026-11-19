"""Feeds a Python function and its TypeScript twin the same inputs and diffs the outputs.

  python -m tests.m3.pure <name|all> [--inputs cases.json] [--fuzz N] [--generated N] [--seed S] [--errors exact|kind]

cases.json is a JSON list of argument lists. --fuzz adds N generated one-string cases (lone surrogates, astral
characters, CR LF, C0/C1 controls, very long text). --generated adds N cases from the function's own generator in
tests/m3/cases*.py, after its recorded inputs (string literals from the Python tests, fixture pages, the M3 spikes'
AX tree and screenshots). "all" runs every function that has a generator. Results compare exactly: ints and floats
apart, object keys in order. Errors compare by exception kind unless --errors exact, the default for generated
functions.
"""
import argparse
import json
import random
import subprocess
import sys

from tests.m3 import cases_p2, cases_p2b, cases_p3, infra
from tests.m3.cases import GENERATORS, recorded_strings

PIECES = ["a", "Z", " ", "\t", "\n", "\r\n", "\x00", "\x07", "\x1b", "\x1f", "\x7f", "\x85", "\x9f", "\xa0", "é", " ", "​",
          "\ud800", "\udfff", "\ud83d", "\U0001f600", "\U00010000", "﻿", "￿", "token=abc", "&", "<", '"', "\\", "日本"]
REGISTERED = (cases_p2, cases_p2b, cases_p3)


def fuzz(count: int, seed: int) -> list[list]:
    draw = random.Random(seed)
    cases = [[""], ["".join(PIECES)], ["x" * 100_000], ["\U0001f600" * 5000]]
    while len(cases) < count:
        cases.append(["".join(draw.choice(PIECES) for _ in range(draw.randint(1, 40)))])
    return cases[:count]


def generated(name: str, count: int, seed: int) -> list[list]:
    generate = GENERATORS.get(name)
    if generate is None:
        raise SystemExit(f"pure: {name} has no generator in tests/m3/cases*.py")
    return generate(random.Random(f"{seed}:{name}"), count, recorded_strings(infra.CLI / "tests"))


def strict(text: str) -> list:
    return json.loads(text, parse_int=lambda digits: ("int", digits), parse_float=lambda digits: ("float", digits),
                      parse_constant=lambda name: ("float", name), object_pairs_hook=lambda pairs: ("object", pairs))


def failed(item) -> bool:
    return isinstance(item, tuple) and item[0] == "object" and any(key == "error" for key, _ in item[1])


def run(argv: list[str], cases: list) -> str:
    payload = json.dumps(cases, ensure_ascii=True).encode()
    done = subprocess.run(argv, input=payload, capture_output=True, cwd=infra.CLI, timeout=1800)
    if done.returncode:
        raise SystemExit(f"{' '.join(argv)} failed ({done.returncode}): {done.stderr.decode(errors='replace')[-2000:]}")
    return done.stdout.decode()


def same(a, b, errors: str) -> bool:
    if failed(a) or failed(b):
        return a == b if errors == "exact" else failed(a) == failed(b)
    return a == b


def compare(name: str, cases: list, errors: str, show: int) -> tuple[int, int]:
    python_text = run([sys.executable, "-m", "tests.m3.oracle", name], cases)
    typescript_text = run([infra.bun(), str(infra.CLI / "ts" / "tests" / "m3" / "oracle.ts"), name], cases)
    python, typescript = strict(python_text), strict(typescript_text)
    raw_python, raw_typescript = json.loads(python_text), json.loads(typescript_text)
    differing = [index for index, (a, b) in enumerate(zip(python, typescript)) if not same(a, b, errors)]
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
    parser = argparse.ArgumentParser(prog="python -m tests.m3.pure", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("name")
    parser.add_argument("--inputs")
    parser.add_argument("--fuzz", type=int, default=0)
    parser.add_argument("--generated", type=int, default=0)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--errors", choices=["kind", "exact"])
    parser.add_argument("--show", type=int, default=10)
    args = parser.parse_args(argv)
    names = sorted(GENERATORS) if args.name == "all" else [args.name]
    total = bad = 0
    for name in names:
        cases = json.loads(open(args.inputs, encoding="utf-8").read()) if args.inputs else []
        cases += generated(name, args.generated, args.seed) if args.generated else []
        cases += fuzz(args.fuzz, args.seed) if args.fuzz else []
        if not cases:
            print("no inputs: pass --inputs, --generated or --fuzz", file=sys.stderr)
            return 2
        errors = args.errors or ("exact" if name in GENERATORS else "kind")
        count, differ = compare(name, cases, errors, args.show)
        total += count
        bad += differ
    if len(names) > 1:
        print(f"all: {total - bad} of {total} cases agree across {len(names)} functions")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
