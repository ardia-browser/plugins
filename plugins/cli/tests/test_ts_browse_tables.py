import json
import re
import sys
import unittest
from pathlib import Path

CLI = Path(__file__).resolve().parents[1]
TABLES = CLI / "ts" / "src" / "browse" / "tables.ts"
HELP = CLI / "ts" / "src" / "browse" / "help-text.ts"
REGENERATE = "python -c 'from tests.test_ts_browse_tables import ts_tables; print(ts_tables(), end=\"\")' > ts/src/browse/tables.ts"


def words(name: str, values) -> str:
    return f"export const {name}: readonly string[] = {json.dumps(sorted(values), ensure_ascii=False)};\n"


def pairs(name: str, mapping: dict) -> str:
    rows = json.dumps(dict(sorted(mapping.items())), ensure_ascii=False)
    return f"export const {name}: Readonly<Record<string, string>> = {rows};\n"


def number(name: str, value: int) -> str:
    return f"export const {name} = {value};\n"


def text(name: str, value: str) -> str:
    return f"export const {name} = {json.dumps(value, ensure_ascii=False)};\n"


def known_browse_commands() -> list:
    if str(CLI) not in sys.path:
        sys.path.insert(0, str(CLI))
    from ardia_cli import telemetry

    aliases, known = telemetry.browse_names()
    return sorted(known | set(aliases))


DAEMON_METRICS = CLI / "ts" / "src" / "browse" / "metrics.ts"


def daemon_metric_sets(*names: str) -> set:
    source = DAEMON_METRICS.read_text(encoding="utf-8")
    found = set()
    for name in names:
        body = re.search(rf"export const {name} = new Set\(\[(.*?)\]\);", source, re.S)
        if body is None:
            raise AssertionError(f"{DAEMON_METRICS.name} has no {name} set")
        found |= set(re.findall(r'"([a-z0-9_]+)"', body.group(1)))
    return found


def ts_tables() -> str:
    if str(CLI) not in sys.path:
        sys.path.insert(0, str(CLI))
    from ardia_cli import command_metrics, telemetry, usage
    from ardia_cli.browse import cli as browse_cli, help as browse_help, limits, outfile
    from ardia_cli.browse.commands import ALIASES, MUTATING

    shared = browse_cli.VALUE_FLAGS | browse_cli.BOOL_FLAGS
    local = {name: sorted(set(re.findall(r"(?<![\w-])(--?[a-z][a-z0-9-]*)", usage_text)) - shared)
             for name, usage_text in sorted(browse_help.COMMANDS.items())}
    owns = {name: sorted(flags) for name, flags in sorted(browse_cli.COMMAND_OWNS.items())}
    flags = (command_metrics.FLAGS | command_metrics.READ_FLAGS | command_metrics.ACT_FLAGS | command_metrics.CHANGE_FLAGS
             | command_metrics.FLOW_FLAGS)
    counts = command_metrics.COUNTS | command_metrics.ACT_COUNTS | command_metrics.CHANGE_COUNTS | command_metrics.FLOW_COUNTS
    flags |= daemon_metric_sets("FLAGS", "READ_FLAGS", "ACT_FLAGS", "CHANGE_FLAGS", "FLOW_FLAGS")
    counts |= daemon_metric_sets("COUNTS", "ACT_COUNTS", "CHANGE_COUNTS", "FLOW_COUNTS")
    return (
        words("VALUE_FLAGS", browse_cli.VALUE_FLAGS)
        + words("BOOL_FLAGS", browse_cli.BOOL_FLAGS)
        + words("LAUNCH_ONLY", browse_cli.LAUNCH_ONLY)
        + pairs("LAUNCH_HINTS", browse_cli.LAUNCH_HINTS)
        + f"export const COMMAND_OWNS: Readonly<Record<string, readonly string[]>> = {json.dumps(owns)};\n"
        + f"export const COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {json.dumps(local)};\n"
        + words("KNOWN_COMMANDS", known_browse_commands())
        + words("LOCAL_AUTH", browse_cli.LOCAL_AUTH)
        + words("EVAL_VALUE_FLAGS", browse_cli.EVAL_VALUE_FLAGS)
        + pairs("ALIASES", ALIASES)
        + words("MUTATING", MUTATING)
        + words("TAKES_OUT", outfile.TAKES_OUT)
        + words("AS_TEXT", outfile.AS_TEXT)
        + words("TASK_COMMANDS", usage.TASK_COMMANDS)
        + words("METRIC_FLAGS", flags)
        + words("METRIC_DURATIONS", command_metrics.DURATIONS)
        + words("METRIC_COUNTS", counts)
        + number("METRIC_MAX_MS", command_metrics.MAX_MS)
        + number("METRIC_MAX_COUNT", command_metrics.MAX_COUNT)
        + text("COMMAND_NAME", telemetry.COMMAND_NAME.pattern)
        + text("STAR_PROMPT", usage.STAR_PROMPT)
        + number("QUEUE_WAIT", limits.QUEUE_WAIT)
        + number("BEHIND_SCRIPT_WAIT", limits.BEHIND_SCRIPT_WAIT)
        + number("COMMAND_LIMIT", limits.COMMAND_LIMIT)
        + number("LIMIT_MARGIN", limits.LIMIT_MARGIN)
        + number("SCRIPT_DEFAULT", limits.SCRIPT_DEFAULT)
        + number("DEFAULT_TIMEOUT_MS", limits.DEFAULT_TIMEOUT_MS)
        + f"export const LONG_COMMANDS: Readonly<Record<string, number>> = {json.dumps(dict(sorted(limits.LONG_COMMANDS.items())))};\n"
    )


def ts_help() -> str:
    if str(CLI) not in sys.path:
        sys.path.insert(0, str(CLI))
    from ardia_cli.browse import help as browse_help

    rows = "".join(f"  {json.dumps(name)}: {json.dumps(text, ensure_ascii=False)},\n" for name, text in browse_help.COMMANDS.items())
    return (f"export const OVERVIEW = {json.dumps(browse_help.OVERVIEW, ensure_ascii=False)};\n"
            f"export const COMMANDS: Readonly<Record<string, string>> = {{\n{rows}}};\n")


RUST_TABLES = CLI / "rust" / "src" / "browse_tables.rs"
REGENERATE_RUST = "python -c 'from tests.test_ts_browse_tables import rust_tables; print(rust_tables(), end=\"\")' > rust/src/browse_tables.rs"


def rust_words(name: str, values) -> str:
    return f"pub const {name}: &[&str] = &[{', '.join(json.dumps(value) for value in sorted(values))}];\n"


def rust_tables() -> str:
    if str(CLI) not in sys.path:
        sys.path.insert(0, str(CLI))
    from ardia_cli.browse import cli as browse_cli

    owns = ", ".join(f"({json.dumps(name)}, &[{', '.join(json.dumps(flag) for flag in sorted(flags))}])"
                     for name, flags in sorted(browse_cli.COMMAND_OWNS.items()))
    return (
        rust_words("VALUE_FLAGS", browse_cli.VALUE_FLAGS)
        + rust_words("LAUNCH_STOPS", set(browse_cli.LAUNCH_ONLY) | set(browse_cli.LAUNCH_HINTS))
        + f"pub const COMMAND_OWNS: &[(&str, &[&str])] = &[{owns}];\n"
    )


class TsBrowseTables(unittest.TestCase):
    def test_rust_router_tables_match_python(self):
        self.assertEqual(RUST_TABLES.read_text(), rust_tables(), f"rust/src/browse_tables.rs is stale; regenerate it: {REGENERATE_RUST}")

    def test_help_matches_python(self):
        self.assertEqual(HELP.read_text(), ts_help(), "ts/src/browse/help-text.ts is stale; regenerate it: "
                         "python -c 'from tests.test_ts_browse_tables import ts_help; print(ts_help(), end=\"\")' > ts/src/browse/help-text.ts")

    def test_tables_match_python(self):
        self.assertEqual(TABLES.read_text(), ts_tables(), f"ts/src/browse/tables.ts is stale; regenerate it: {REGENERATE}")


if __name__ == "__main__":
    unittest.main()
