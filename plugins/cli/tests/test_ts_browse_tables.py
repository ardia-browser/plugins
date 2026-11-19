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
    return (
        words("VALUE_FLAGS", browse_cli.VALUE_FLAGS)
        + words("BOOL_FLAGS", browse_cli.BOOL_FLAGS)
        + words("LAUNCH_ONLY", browse_cli.LAUNCH_ONLY)
        + pairs("LAUNCH_HINTS", browse_cli.LAUNCH_HINTS)
        + f"export const COMMAND_OWNS: Readonly<Record<string, readonly string[]>> = {json.dumps(owns)};\n"
        + f"export const COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {json.dumps(local)};\n"
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


class TsBrowseTables(unittest.TestCase):
    def test_help_matches_python(self):
        self.assertEqual(HELP.read_text(), ts_help(), "ts/src/browse/help-text.ts is stale; regenerate it: "
                         "python -c 'from tests.test_ts_browse_tables import ts_help; print(ts_help(), end=\"\")' > ts/src/browse/help-text.ts")

    def test_tables_match_python(self):
        self.assertEqual(TABLES.read_text(), ts_tables(), f"ts/src/browse/tables.ts is stale; regenerate it: {REGENERATE}")


if __name__ == "__main__":
    unittest.main()
