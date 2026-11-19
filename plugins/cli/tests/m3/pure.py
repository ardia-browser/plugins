"""Feeds a Python function and its TypeScript twin the same inputs and diffs the outputs.

  python -m tests.m3.pure <name> [--inputs cases.json] [--fuzz N] [--seed S] [--errors exact|kind]

cases.json is a JSON list of argument lists. --fuzz adds N generated one-string cases (lone surrogates, astral
characters, CR LF, C0/C1 controls, very long text). Errors compare by exception kind unless --errors exact.
"""
import argparse
import json
import random
import subprocess
import sys

from tests.m3 import infra

PIECES = ["a", "Z", " ", "\t", "\n", "\r\n", "\x00", "\x07", "\x1b", "\x1f", "\x7f", "\x85", "\x9f", "\xa0", "é", " ", "​",
          "\ud800", "\udfff", "\ud83d", "\U0001f600", "\U00010000", "﻿", "￿", "token=abc", "&", "<", '"', "\\", "日本"]


def fuzz(count: int, seed: int) -> list[list]:
    draw = random.Random(seed)
    cases = [[""], ["".join(PIECES)], ["x" * 100_000], ["\U0001f600" * 5000]]
    while len(cases) < count:
        cases.append(["".join(draw.choice(PIECES) for _ in range(draw.randint(1, 40)))])
    return cases[:count]


def run(argv: list[str], cases: list) -> list:
    payload = json.dumps(cases).encode()
    done = subprocess.run(argv, input=payload, capture_output=True, cwd=infra.CLI, timeout=300)
    if done.returncode:
        raise SystemExit(f"{' '.join(argv)} failed ({done.returncode}): {done.stderr.decode(errors='replace')[-2000:]}")
    return json.loads(done.stdout)


def same(a: dict, b: dict, errors: str) -> bool:
    if "error" in a or "error" in b:
        if errors == "exact":
            return a == b
        return ("error" in a) == ("error" in b)
    return a == b


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m tests.m3.pure", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("name")
    parser.add_argument("--inputs")
    parser.add_argument("--fuzz", type=int, default=0)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--errors", default="kind", choices=["kind", "exact"])
    args = parser.parse_args(argv)
    cases = json.loads(open(args.inputs, encoding="utf-8").read()) if args.inputs else []
    cases += fuzz(args.fuzz, args.seed) if args.fuzz else []
    if not cases:
        print("no inputs: pass --inputs or --fuzz", file=sys.stderr)
        return 2
    python = run([sys.executable, "-m", "tests.m3.oracle", args.name], cases)
    typescript = run([infra.bun(), str(infra.CLI / "ts" / "tests" / "m3" / "oracle.ts"), args.name], cases)
    differing = [index for index, (a, b) in enumerate(zip(python, typescript)) if not same(a, b, args.errors)]
    if len(python) != len(typescript):
        differing.append(-1)
    for index in differing[:10]:
        print(f"case {index}: input {json.dumps(cases[index])[:300]}\n  python: {json.dumps(python[index])[:300]}\n  ts:     {json.dumps(typescript[index])[:300]}")
    print(f"{args.name}: {len(cases) - len(differing)} of {len(cases)} cases agree")
    return 1 if differing else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
