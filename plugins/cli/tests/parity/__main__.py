"""Usage: python -m tests.parity [--rust BIN] [--command NAME]... [--case ID]... [--jobs N] [--keep] [--report]

Runs every parity case (tests/parity/cases) on the Rust ardia and on the Python one in identical throwaway
environments and compares stdout, stderr, exit code, control-socket requests, telemetry, usage, files written and
helper programs started. Prints a diff for each mismatch. --report prints the machine-readable state instead: for each
command its cases, how many pass, and whether rust/served.txt lists it. Exits 1 when a case fails or served.txt
lists a command whose cases don't all pass.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from parity import harness


def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m tests.parity", description=__doc__.split("\n\n", 1)[1], formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--rust", type=Path, default=None, help="the Rust ardia (default: $ARDIA_RUST_CLI, else rust/target/{release,debug}/ardia)")
    parser.add_argument("--command", action="append", default=[], help="only this command's cases (repeatable)")
    parser.add_argument("--case", action="append", default=[], help="only this case (repeatable)")
    parser.add_argument("--jobs", type=int, default=6)
    parser.add_argument("--keep", action="store_true", help="keep each side's sandbox to inspect")
    parser.add_argument("--report", action="store_true", help="print the parity table as JSON")
    args = parser.parse_args()
    rust = args.rust or harness.binary()
    if not rust or not rust.exists():
        sys.stderr.write("no Rust ardia: build rust/ (cargo build --release) or pass --rust\n")
        return 2
    cases = harness.load_cases()
    if args.command:
        cases = [case for case in cases if case.command in args.command]
    if args.case:
        cases = [case for case in cases if case.id in args.case]

    def progress(outcome):
        if not args.report:
            sys.stdout.write("." if outcome.passed else "F")
            sys.stdout.flush()

    outcomes, install = harness.run_all(cases, rust, jobs=args.jobs, keep=args.keep)
    for outcome in outcomes:
        progress(outcome)
    served = harness.served_commands()
    if args.command or args.case:
        served = [name for name in served if any(outcome.case.command == name for outcome in outcomes)]
    summary = harness.summarize(outcomes, served)
    if args.report:
        head = subprocess.run(["git", "-C", str(harness.CLI), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        dirty = bool(subprocess.run(["git", "-C", str(harness.CLI), "status", "--porcelain", "--", "."], capture_output=True, text=True).stdout.strip())
        print(json.dumps({"commit": head, "dirty": dirty, "cases": len(outcomes), "failed": sum(not o.passed for o in outcomes), **summary}, indent=1))
    else:
        print()
        for outcome in outcomes:
            if not outcome.passed:
                print(outcome.report())
        failed = sum(not outcome.passed for outcome in outcomes)
        print(f"{len(outcomes) - failed}/{len(outcomes)} cases pass; Rust serves {', '.join(served)}")
        if summary["unproven_but_served"]:
            print(f"served.txt lists commands whose cases don't all pass: {', '.join(summary['unproven_but_served'])}")
        if args.keep:
            print(f"sandboxes kept in {install.scratch}")
    if not args.keep:
        install.close()
    return 1 if any(not o.passed for o in outcomes) or summary["unproven_but_served"] else 0


if __name__ == "__main__":
    sys.exit(main())
