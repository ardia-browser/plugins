"""Runs one Python function on JSON inputs: stdin is a JSON list of argument lists, stdout a JSON list of
{"ok": result} or {"error": "ExceptionName: message"}.

  python -m tests.m2_scripts.oracle <name>       a name from tests/m2_scripts/functions.py
"""
import json
import sys

from tests.m2_scripts.functions import FUNCTIONS, failure


def call(function, args: list) -> dict:
    try:
        return {"ok": function(*args)}
    except Exception as error:
        return failure(error)


def main(argv: list[str]) -> int:
    if len(argv) != 1 or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv and argv[0] in ("-h", "--help") else 2
    function = FUNCTIONS.get(argv[0])
    if function is None:
        raise SystemExit(f"oracle: unknown function {argv[0]!r}")
    cases = json.loads(sys.stdin.read())
    sys.stdout.write(json.dumps([call(function, args) for args in cases], ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
