import argparse
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

CLI = Path(__file__).resolve().parents[2]

HELP_WITHOUT_SUBCOMMAND = {"skills": "skills_command", "scripts": "scripts_command", "hooks": "hooks_command", "config": "config_command",
                           "theme": "theme_command", "plugins": "plugins_command"}


class Parsed(Exception):
    def __init__(self, namespace):
        self.namespace = namespace


def goes_elsewhere(argv: list) -> bool:
    from ardia_cli import cli

    if argv == ["--version"]:
        return True
    try:
        index = cli.take_shared(argv, 0, [])
    except cli.UsageError:
        return False
    command = argv[index] if index < len(argv) else None
    if command in ("browse", "notes"):
        return True
    if command == "computer":
        rest = argv[index + 1:]
        return index == 0 and (not rest or rest[0] not in ("setup", "mcp-config"))
    return False


def run_front_end(argv: list):
    from ardia_cli import cli

    if goes_elsewhere(argv):
        return "elsewhere", None, None
    original = argparse.ArgumentParser.parse_args
    state = {"first": True}

    def first_parse(self, args=None, namespace=None):
        if state["first"]:
            state["first"] = False
            raise Parsed(original(self, args, namespace))
        return original(self, args, namespace)

    argparse.ArgumentParser.parse_args = first_parse
    try:
        return "served", cli.run(list(argv)), None
    except Parsed as parsed:
        namespace = parsed.namespace
    except SystemExit as stop:
        return "served", stop.code, None
    finally:
        argparse.ArgumentParser.parse_args = original
    if getattr(namespace, "command", "") is None:
        cli.build_parser().print_help()
        return "served", 0, None
    dest = HELP_WITHOUT_SUBCOMMAND.get(getattr(namespace, "command", None))
    if dest is not None and getattr(namespace, dest, None) is None:
        try:
            cli.build_parser().parse_args([namespace.command, "--help"])
        except SystemExit as stop:
            return "served", stop.code, None
    return "parsed", None, namespace


def probe_main() -> None:
    argvs = json.load(sys.stdin)
    answers = []
    for argv in argvs:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            kind, _, _ = run_front_end(argv)
        answers.append(kind == "served")
    sys.stdout.write(json.dumps(answers))


PROBE = "import sys; sys.path[:0] = sys.argv[1:3]; from parity.argparse_route import probe_main; probe_main()"


def served_by_front_end(argvs: list, python: str = sys.executable) -> list:
    with tempfile.TemporaryDirectory() as home:
        env = {key: value for key, value in os.environ.items() if key in ("PATH", "LANG", "LC_ALL", "TMPDIR")}
        env.update({"HOME": home, "ARDIA_TELEMETRY": "off"})
        done = subprocess.run([python, "-I", "-c", PROBE, str(CLI), str(CLI / "tests")], input=json.dumps(argvs), capture_output=True,
                              text=True, cwd=home, env=env, check=False)
    if done.returncode != 0:
        raise RuntimeError(f"probing the Python front end failed:\n{done.stderr}")
    return json.loads(done.stdout)
