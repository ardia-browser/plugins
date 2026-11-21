import json
import subprocess
import sys
from pathlib import Path

CLI = Path(__file__).resolve().parents[1]
SPECS = CLI / "ts" / "src" / "argparse-specs.json"
PLATFORMS = {"macos": "darwin", "linux": "linux"}
CONFIG_FOLDER = "\ue000config-folder\ue000"
VERSION = "\ue000version\ue000"

DUMP = r"""
import argparse, json, os, pathlib, re, shutil, signal, socket, sqlite3, subprocess, tempfile, textwrap, urllib.request
import sys
sys.platform = sys.argv[1]
sys.path.insert(0, sys.argv[2])
CONFIG_FOLDER, VERSION = sys.argv[3], sys.argv[4]

import ardia_cli
ardia_cli.__version__ = VERSION
from ardia_cli import call_cli, cli, computer, config_files

config_files.default_folder = lambda: pathlib.PurePosixPath(CONFIG_FOLDER)
cli.__version__ = VERSION

KINDS = {
    argparse._HelpAction: "help",
    argparse._VersionAction: "version",
    argparse._StoreAction: "store",
    argparse._StoreConstAction: "store_const",
    argparse._StoreTrueAction: "store_true",
    argparse._StoreFalseAction: "store_false",
    argparse._AppendAction: "append",
    argparse._AppendConstAction: "append_const",
    argparse._CountAction: "count",
    argparse._ExtendAction: "extend",
    argparse._SubParsersAction: "parsers",
}
FORMATTERS = {argparse.HelpFormatter: "plain", argparse.RawDescriptionHelpFormatter: "raw_description"}


def value(item):
    if item is None or isinstance(item, (bool, str)):
        return item
    if isinstance(item, int):
        return {"int": str(item)}
    if isinstance(item, float):
        return {"float": repr(item)}
    if isinstance(item, (list, tuple)):
        return [value(entry) for entry in item]
    raise TypeError(f"unsupported value {item!r}")


def choice_text(choice):
    if not isinstance(choice, str):
        raise TypeError(f"unsupported choice {choice!r}")
    return choice


def type_name(action):
    if action.type is None:
        return None
    name = getattr(action.type, "__name__", None)
    if name not in ("int", "float", "timeout_seconds"):
        raise TypeError(f"unsupported type {action.type!r} on {action.dest}")
    return name


def nargs(action):
    if action.nargs is None or isinstance(action.nargs, str):
        return action.nargs
    return {"int": str(action.nargs)} if not isinstance(action.nargs, int) else action.nargs


def text_of(parser, text):
    if text is None:
        return None
    if "%(prog)" in text:
        return text % dict(prog=parser.prog)
    return text


def dump(parser, out):
    if type(parser) is not argparse.ArgumentParser:
        raise TypeError(f"unsupported parser class {type(parser)!r}")
    formatter_class = FORMATTERS.get(parser.formatter_class)
    if formatter_class is None:
        raise TypeError(f"unsupported formatter {parser.formatter_class!r}")
    if parser.fromfile_prefix_chars is not None or parser.prefix_chars != "-" or not parser.exit_on_error:
        raise TypeError(f"unsupported parser options on {parser.prog}")
    formatter = parser._get_formatter()
    index = {id(action): number for number, action in enumerate(parser._actions)}
    actions = []
    for action in parser._actions:
        kind = KINDS.get(type(action))
        if kind is None:
            raise TypeError(f"unsupported action {type(action)!r} on {parser.prog}")
        entry = {
            "kind": kind,
            "option_strings": list(action.option_strings),
            "dest": action.dest,
            "nargs": nargs(action),
            "const": value(action.const) if kind != "parsers" else None,
            "default": value(action.default),
            "type": type_name(action),
            "choices": None if action.choices is None else [choice_text(choice) for choice in action.choices],
            "required": action.required,
            "help": action.help,
            "expanded_help": formatter._expand_help(action) if action.help not in (None, argparse.SUPPRESS) and action.help.strip() else None,
            "metavar": list(action.metavar) if isinstance(action.metavar, tuple) else action.metavar,
            "deprecated": bool(getattr(action, "deprecated", False)),
        }
        if kind == "version":
            entry["version"] = text_of(parser, action.version)
        if kind == "parsers":
            entry["parsers"] = [[name, sub.prog] for name, sub in action._name_parser_map.items()]
            entry["deprecated_parsers"] = sorted(action._deprecated)
            entry["choices_actions"] = [
                {"dest": choice.dest, "metavar": choice.metavar, "help": choice.help,
                 "expanded_help": formatter._expand_help(choice) if choice.help not in (None, argparse.SUPPRESS) and choice.help.strip() else None}
                for choice in action._choices_actions
            ]
            for sub in action._name_parser_map.values():
                if sub.prog not in out:
                    dump(sub, out)
        actions.append(entry)
    out[parser.prog] = {
        "prog": parser.prog,
        "usage": None if parser.usage is None else parser.usage % dict(prog=parser.prog),
        "description": text_of(parser, parser.description),
        "epilog": text_of(parser, parser.epilog),
        "formatter": formatter_class,
        "allow_abbrev": parser.allow_abbrev,
        "defaults": {key: value(item) for key, item in parser._defaults.items()},
        "actions": actions,
        "groups": [{"title": group.title, "description": text_of(parser, group.description), "actions": [index[id(action)] for action in group._group_actions]} for group in parser._action_groups],
        "mutually_exclusive": [{"required": group.required, "actions": [index[id(action)] for action in group._group_actions]} for group in parser._mutually_exclusive_groups],
        "negative_number_options": parser._has_negative_number_optionals != [],
    }


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


out = {}
dump(cli.build_parser(), out)
dump(caught(lambda: computer.setup([])), out)
dump(caught(lambda: computer.print_mcp_config([])), out)
constants = {
    "max_timeout": repr(float(call_cli.MAX_TIMEOUT)),
    "max_timeout_shown": f"{call_cli.MAX_TIMEOUT:g}",
    "shared_value_flags": sorted(cli.SHARED_VALUE_FLAGS),
    "shared_bool_flags": sorted(cli.SHARED_BOOL_FLAGS),
    "removed_commands": dict(sorted(cli.REMOVED_COMMANDS.items())),
    "computer_labels": {name: computer.label([name]) for name in ("setup", "mcp-config")},
}
sys.stdout.write(json.dumps({"parsers": out, "constants": constants}, ensure_ascii=False, sort_keys=True))
"""


def specs_for(platform: str, python: str = sys.executable) -> dict:
    done = subprocess.run([python, "-I", "-c", DUMP, platform, str(CLI), CONFIG_FOLDER, VERSION], capture_output=True, text=True, check=False)
    if done.returncode != 0:
        raise RuntimeError(f"reading the parsers on {platform} failed:\n{done.stderr}")
    return json.loads(done.stdout)


def one_per_line(parsers: dict) -> str:
    rows = [f"   {json.dumps(prog, ensure_ascii=False)}: {json.dumps(spec, ensure_ascii=False, sort_keys=True)}" for prog, spec in sorted(parsers.items())]
    return "{\n" + ",\n".join(rows) + "\n  }" if rows else "{}"


def specs(python: str = sys.executable) -> str:
    dumped = {name: specs_for(platform, python) for name, platform in PLATFORMS.items()}
    constants = dumped["macos"]["constants"]
    if any(dump["constants"] != constants for dump in dumped.values()):
        raise RuntimeError("the parser constants differ between platforms")
    every = {name: dump["parsers"] for name, dump in dumped.items()}
    progs = sorted(set().union(*every.values()))
    common = {prog: every["macos"][prog] for prog in progs if all(parsers.get(prog) == every["macos"].get(prog) for parsers in every.values())}
    sections = {"common": common, **{name: {prog: spec for prog, spec in parsers.items() if prog not in common} for name, parsers in every.items()}}
    body = ",\n".join(f"  {json.dumps(name)}: {one_per_line(parsers)}" for name, parsers in sections.items())
    head = f'{{\n "config_folder": {json.dumps(CONFIG_FOLDER)},\n "version": {json.dumps(VERSION)},\n "constants": {json.dumps(constants, sort_keys=True)},\n "parsers": {{\n'
    return head + body + "\n }\n}\n"


def main(argv: list[str]) -> int:
    text = specs()
    if argv == ["--check"]:
        if SPECS.read_text() != text:
            sys.stderr.write("ts/src/argparse-specs.json is stale; regenerate it: python -m tests.argparse_specs\n")
            return 1
        return 0
    SPECS.write_text(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
