"""Usage: python plugin_grammar.py grammar <command>... | parse | split  (argv lists as JSON on stdin)

Reads ardia browse's daemon-side option grammar from the real command functions in ardia_cli/browse/commands.py
(the flags and aliases each passes to parse()), runs the real parse() on daemon argvs, and runs the client's real
global split (cli.split_globals) on browse argvs, so the TypeScript plugin guard can be checked against all three.
Prints JSON.
"""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ardia_cli.browse import commands
from ardia_cli.browse.errors import Usage


class Captured(Exception):
    pass


def grammar(name: str) -> dict:
    seen = []
    real = commands.parse

    def capture(argv, flags=None, aliases=None):
        seen.append({"flags": dict(flags or {}), "aliases": dict(aliases or {})})
        raise Captured

    commands.parse = capture
    try:
        asyncio.run(commands.COMMANDS[name](None, []))
    except Captured:
        pass
    finally:
        commands.parse = real
    if not seen:
        raise LookupError(f"{name} doesn't start with parse()")
    return seen[0]


def parsed(argv: list) -> dict:
    name = commands.ALIASES.get(argv[0], argv[0]) if argv else ""
    if name not in commands.COMMANDS:
        return {"command": name, "known": False}
    try:
        rules = grammar(name)
    except Exception:
        return {"command": name, "known": True, "grammar": None}
    try:
        options, positionals = commands.parse(argv[1:], rules["flags"], rules["aliases"])
    except Usage as error:
        return {"command": name, "known": True, "usage": error.message}
    return {"command": name, "known": True, "options": options, "positionals": positionals}


def split(argv: list) -> dict:
    from ardia_cli.browse import cli

    try:
        found, rest = cli.split_globals(list(argv))
    except Usage as error:
        return {"usage": error.message}
    return {"found": found, "rest": rest}


def main() -> int:
    if sys.argv[1:2] == ["grammar"]:
        print(json.dumps({name: grammar(name) for name in sys.argv[2:]}, sort_keys=True))
        return 0
    if sys.argv[1:2] == ["split"]:
        print(json.dumps([split(argv) for argv in json.load(sys.stdin)]))
        return 0
    if sys.argv[1:2] == ["parse"]:
        print(json.dumps([parsed(argv) for argv in json.load(sys.stdin)]))
        return 0
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
