import argparse
import contextlib
import io
import json
import os
import pathlib
import random
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import urllib.request

PLATFORM, CLI, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
SEED = int(sys.argv[4]) if len(sys.argv) > 4 else 2724
RANDOM_CASES = int(sys.argv[5]) if len(sys.argv) > 5 else 80
sys.platform = PLATFORM
sys.path.insert(0, CLI)
HOME = tempfile.mkdtemp(prefix="argparse-diff-")
os.environ["HOME"] = HOME
for name in ("ARDIA_CONFIG_HOME", "XDG_CONFIG_HOME", "ARDIA_DATA_DIR", "ARDIA_WS", "ARDIA_PORT"):
    os.environ.pop(name, None)

sys.path.insert(0, os.path.join(CLI, "tests"))

import ardia_cli
from ardia_cli import cli, computer
from parity.argparse_route import run_front_end

COLUMNS = ["40", "80", "200"]
ODD_COLUMNS = [None, "0", "1", "11", "23", "60", " 100 ", "1_00", "abc", "-5", "١٢٠"]
VALUES = ["x", "", "-", "--", "-1", "-1.5", "-.5", "1", "0", "1.5", "nan", "inf", "-inf", "1e3", "1_000", " 7 ", "٣", "a b",
          "été", "\x1b[31m", "'q'", '"q"', "a'b\"c", "tab\there", "-x", "--json", "-h", "601", "0.001", "1e309", " ", "-5\n"]
SHARED = ["--data-dir", "--data-dir=d", "--json", "--port", "--port=9", "--ws", "--ws=u", "--timeout", "--timeout=3"]


class Built(Exception):
    def __init__(self, parser):
        self.parser = parser


def caught(build):
    original = argparse.ArgumentParser.parse_args

    def stop(self, args=None, namespace=None):
        raise Built(self)

    argparse.ArgumentParser.parse_args = stop
    try:
        build()
    except Built as built:
        return built.parser
    finally:
        argparse.ArgumentParser.parse_args = original
    raise RuntimeError("the parser was never used")


def walk(parser, into):
    into[parser.prog] = parser
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            for sub in action._name_parser_map.values():
                if sub.prog not in into:
                    walk(sub, into)
    return into


BUILT = cli.build_parser()
cli.build_parser = lambda: BUILT
PARSERS = walk(BUILT, {})
PARSERS.update(walk(caught(lambda: computer.setup([])), {}))
PARSERS.update(walk(caught(lambda: computer.print_mcp_config([])), {}))


def encoded(value):
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return {"int": str(value)}
    if isinstance(value, float):
        return {"float": repr(value)}
    if isinstance(value, list):
        return [encoded(item) for item in value]
    raise TypeError(repr(value))


def namespace_json(ns):
    return {key: encoded(value) for key, value in sorted(vars(ns).items())}


def tokens_for(parser, rng):
    options = list(parser._option_string_actions)
    longs = [name for name in options if name.startswith("--")]
    shorts = [name for name in options if not name.startswith("--")]
    choices = []
    subnames = []
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            subnames += list(action._name_parser_map)
        elif action.choices:
            choices += [str(choice) for choice in action.choices]
    pool = list(options)
    pool += [name[:length] for name in longs for length in range(3, len(name))]
    pool += [name[:-1] + "x" for name in longs] + [name.replace("-", "_") for name in longs] + [name + "s" for name in longs]
    pool += [f"{name}={rng.choice(VALUES + choices + [''])}" for name in longs]
    pool += [f"{name}{rng.choice(VALUES + choices)}" for name in shorts]
    pool += ["-" + "".join(rng.choice("hxyzqn") for _ in range(rng.randint(1, 3))) for _ in range(3)]
    pool += ["--bogus", "--bogus=1", "--", "-", "--h", "--he", "--help=1", "-h=1", "-hx", "-xh"]
    pool += subnames + [name[: max(1, len(name) - 1)] for name in subnames] + ["bogus", "exec"]
    pool += choices + ["nope"] + SHARED + VALUES
    return pool


def random_argv(parser, rng):
    pool = tokens_for(parser, rng)
    return [rng.choice(pool) for _ in range(rng.randint(0, 6))]


TYPED = {
    "int": ["3", "-2", " 4 ", "1_0", "x", "\u0663", "99999999999999999999", "1.0", "+5", "_1", "0x10", ""],
    "float": ["2.5", "nan", "-inf", "1e-3", "x", ".5", "5.", "1_0.5", "Infinity", "1e400", "0", "-0.0", "\u0661.5", "1e", ""],
    "timeout_seconds": ["30", "0", "601", "600", "nan", "1e999", "x", "0.5", "-1", "6e2", "inf", ""],
}


def option_form(action, rng):
    name = rng.choice(action.option_strings)
    if name.startswith("--") and rng.random() < 0.2 and len(name) > 4:
        name = name[: rng.randint(3, len(name) - 1)]
    if action.nargs == 0:
        return [name]
    if action.choices:
        value = rng.choice([*map(str, action.choices), "nope"]) if rng.random() < 0.85 else rng.choice(VALUES)
    else:
        value = rng.choice(TYPED.get(getattr(action.type, "__name__", ""), ["w", "two words", "-v", "x=y", "\u00e9"]))
    if name.startswith("--") and rng.random() < 0.35:
        return [f"{name}={value}"]
    return [name, value]


def positional_form(action, rng):
    if isinstance(action, argparse._SubParsersAction):
        return [rng.choice(list(action._name_parser_map))] if rng.random() < 0.9 else ["nope"]
    count = {None: 1, "?": rng.randint(0, 1), "*": rng.randint(0, 3), "+": rng.randint(1, 3)}.get(action.nargs, action.nargs)
    if action.choices:
        return [rng.choice([*map(str, action.choices), "nope"]) for _ in range(count)]
    return [rng.choice(["w", "tab-1", "https://e.com", "a b", "1", "-1"]) for _ in range(count)]


def structured_argv(parser, rng):
    optionals = [action for action in parser._actions if action.option_strings and not isinstance(action, (argparse._HelpAction, argparse._VersionAction))]
    positionals = [action for action in parser._actions if not action.option_strings]
    parts = []
    for action in rng.sample(optionals, min(len(optionals), rng.randint(0, 4))):
        parts.append(option_form(action, rng))
    skip = rng.random() < 0.15
    for action in positionals:
        if skip and rng.random() < 0.5:
            continue
        parts.append(positional_form(action, rng))
    if rng.random() < 0.3:
        rng.shuffle(parts)
    if rng.random() < 0.1:
        parts.insert(rng.randint(0, len(parts)), ["--"])
    return [token for part in parts for token in part]


def path_of(prog):
    return prog.split()[1:]


def cases_for(rng):
    cases = []
    version = ardia_cli.__version__
    for prog, parser in sorted(PARSERS.items()):
        path = path_of(prog)
        for columns in COLUMNS:
            for argv in ([], ["-h"], ["--help"], ["--he"], ["-h", "extra"], ["--help", "--bogus"]):
                cases.append({"spec": prog, "argv": argv, "columns": columns})
            if path[:1] != ["computer"]:
                cases.append({"cli": True, "argv": [*path, "--help"], "columns": columns})
                cases.append({"cli": True, "argv": [*path, "--bogus"], "columns": columns})
        for _ in range(RANDOM_CASES):
            cases.append({"spec": prog, "argv": random_argv(parser, rng), "columns": rng.choice(COLUMNS + ODD_COLUMNS)})
            lead = [rng.choice(SHARED + VALUES)] if rng.random() < 0.2 else []
            if path[:1] == ["computer"] and lead:
                lead = []
            argv = random_argv(parser, rng)
            if path[:1] == ["computer"] and argv[:1] == ["--json"]:
                argv = argv[1:]
            cases.append({"cli": True, "argv": [*lead, *path, *argv], "columns": rng.choice(COLUMNS + ODD_COLUMNS)})
        for _ in range(RANDOM_CASES):
            argv = structured_argv(parser, rng)
            cases.append({"spec": prog, "argv": argv, "columns": rng.choice(COLUMNS)})
            if path[:1] != ["computer"] or argv[:1] != ["--json"]:
                cases.append({"cli": True, "argv": [*path, *argv], "columns": rng.choice(COLUMNS)})
    for case in cases:
        case["linux"] = PLATFORM == "linux"
        case["version"] = version
    return cases


def run_case(case):
    if case["columns"] is None:
        os.environ.pop("COLUMNS", None)
    else:
        os.environ["COLUMNS"] = case["columns"]
    out, err = io.StringIO(), io.StringIO()
    namespace = None
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            if case.get("cli"):
                kind, status, namespace = run_front_end(case["argv"])
                if kind == "elsewhere":
                    status = None
            else:
                namespace = PARSERS[case["spec"]].parse_args(list(case["argv"]))
                status = None
        except SystemExit as stop:
            status, namespace = stop.code, None
    result = {"status": status, "stdout": out.getvalue(), "stderr": err.getvalue()}
    if namespace is not None:
        result["values"] = namespace_json(namespace)
    return result


def main():
    rng = random.Random(f"{SEED}:{PLATFORM}")
    cases = cases_for(rng)
    try:
        results = [run_case(case) for case in cases]
    finally:
        shutil.rmtree(HOME, ignore_errors=True)
    pathlib.Path(OUT).write_text(json.dumps({"home": HOME, "cases": cases, "results": results}, ensure_ascii=False))


main()
