"""Runs one Python function on JSON inputs: stdin is a JSON list of argument lists, stdout a JSON list of
{"ok": result} or {"error": "ExceptionName: message"} (a BrowseError adds its code, data and exit status).

  python -m tests.m3.oracle <name>       a name from FUNCTIONS or tests/m3/oracle_fns.py, or module:attribute under ardia_cli
"""
import importlib
import json
import sys

from ardia_cli.browse.errors import BrowseError
from tests.m3.oracle_fns import PURE

FUNCTIONS = {
    "printable.shown": "ardia_cli.printable:shown",
    "printable.inert": "ardia_cli.printable:inert",
    "printable.json_safe": "ardia_cli.printable:json_safe",
}
UNWORDED = {"UnicodeEncodeError", "UnicodeDecodeError", "RecursionError"}


def resolve(name: str):
    if name in PURE:
        return PURE[name]
    target = FUNCTIONS.get(name, name)
    module, _, attribute = target.partition(":")
    if not attribute or not module.startswith("ardia_cli"):
        raise SystemExit(f"oracle: unknown function {name!r}")
    found = importlib.import_module(module)
    for part in attribute.split("."):
        found = getattr(found, part)
    return found


def failure(error: Exception) -> dict:
    kind = type(error).__name__
    if isinstance(error, BrowseError):
        return {"error": f"{kind}: {error.message}", "code": error.code, "data": error.data, "exit": error.exit_code}
    return {"error": kind if kind in UNWORDED else f"{kind}: {error}"}


def call(function, args: list) -> dict:
    try:
        return {"ok": function(*args)}
    except Exception as error:
        return failure(error)


def main(argv: list[str]) -> int:
    if len(argv) != 1 or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv and argv[0] in ("-h", "--help") else 2
    sys.setrecursionlimit(10000)
    function = resolve(argv[0])
    cases = json.loads(sys.stdin.read())
    sys.stdout.write(json.dumps([call(function, args) for args in cases], ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
