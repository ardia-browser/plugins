"""Runs one Python function on JSON inputs: stdin is a JSON list of argument lists, stdout a JSON list of
{"ok": result} or {"error": "ExceptionName: message"}.

  python -m tests.m3.oracle <name>       a name from FUNCTIONS, or module:attribute under ardia_cli
"""
import importlib
import json
import sys

FUNCTIONS = {
    "printable.shown": "ardia_cli.printable:shown",
    "printable.inert": "ardia_cli.printable:inert",
    "printable.json_safe": "ardia_cli.printable:json_safe",
}


def resolve(name: str):
    target = FUNCTIONS.get(name, name)
    module, _, attribute = target.partition(":")
    if not attribute or not module.startswith("ardia_cli"):
        raise SystemExit(f"oracle: unknown function {name!r}")
    found = importlib.import_module(module)
    for part in attribute.split("."):
        found = getattr(found, part)
    return found


def call(function, args: list) -> dict:
    try:
        return {"ok": function(*args)}
    except Exception as error:
        return {"error": f"{type(error).__name__}: {error}"}


def main(argv: list[str]) -> int:
    if len(argv) != 1 or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv and argv[0] in ("-h", "--help") else 2
    function = resolve(argv[0])
    cases = json.loads(sys.stdin.read())
    json.dump([call(function, args) for args in cases], sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
