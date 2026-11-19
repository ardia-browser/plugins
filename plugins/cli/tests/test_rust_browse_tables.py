import re
import sys
import unittest
from pathlib import Path

CLI = Path(__file__).resolve().parents[1]
TABLES = CLI / "rust" / "src" / "browse" / "tables.rs"
REGENERATE = "python -c 'from tests.test_rust_browse_tables import rust_tables; print(rust_tables(), end=\"\")' > rust/src/browse/tables.rs"


def lit(text: str) -> str:
    if not all(" " <= char <= "~" for char in text) or '"' in text or "\\" in text:
        raise ValueError(f"{text!r} needs escaping in Rust")
    return f'"{text}"'


def words(name: str, values) -> str:
    rows = "".join(f"    {lit(value)},\n" for value in sorted(values))
    return f"pub const {name}: &[&str] = &[\n{rows}];\n"


def rust_tables() -> str:
    if str(CLI) not in sys.path:
        sys.path.insert(0, str(CLI))
    from ardia_cli import command_metrics, usage
    from ardia_cli.browse import cli as browse_cli, help as browse_help, outfile
    from ardia_cli.browse.commands import ALIASES, MUTATING

    shared = browse_cli.VALUE_FLAGS | browse_cli.BOOL_FLAGS
    flag_rows = ""
    for name in sorted(browse_help.COMMANDS):
        local = sorted(set(re.findall(r"(?<![\w-])(--?[a-z][a-z0-9-]*)", browse_help.COMMANDS[name])) - shared)
        flag_rows += f"    ({lit(name)}, &[{', '.join(lit(flag) for flag in local)}]),\n"
    alias_rows = "".join(f"    ({lit(name)}, {lit(target)}),\n" for name, target in sorted(ALIASES.items()))
    launch_hints = "".join(f"    ({lit(name)}, {lit(hint)}),\n" for name, hint in sorted(browse_cli.LAUNCH_HINTS.items()))
    flags = (command_metrics.FLAGS | command_metrics.READ_FLAGS | command_metrics.ACT_FLAGS | command_metrics.CHANGE_FLAGS
             | command_metrics.FLOW_FLAGS)
    counts = command_metrics.COUNTS | command_metrics.ACT_COUNTS | command_metrics.CHANGE_COUNTS | command_metrics.FLOW_COUNTS
    return (
        words("VALUE_FLAGS", browse_cli.VALUE_FLAGS)
        + words("BOOL_FLAGS", browse_cli.BOOL_FLAGS)
        + words("LAUNCH_ONLY", browse_cli.LAUNCH_ONLY)
        + f"pub const LAUNCH_HINTS: &[(&str, &str)] = &[\n{launch_hints}];\n"
        + f"pub const COMMAND_FLAGS: &[(&str, &[&str])] = &[\n{flag_rows}];\n"
        + f"pub const ALIASES: &[(&str, &str)] = &[\n{alias_rows}];\n"
        + words("MUTATING", MUTATING)
        + words("TAKES_OUT", outfile.TAKES_OUT)
        + words("TASK_COMMANDS", usage.TASK_COMMANDS)
        + words("METRIC_FLAGS", flags)
        + words("METRIC_DURATIONS", command_metrics.DURATIONS)
        + words("METRIC_COUNTS", counts)
        + f"pub const METRIC_MAX_MS: i128 = {command_metrics.MAX_MS};\n"
        + f"pub const METRIC_MAX_COUNT: i128 = {command_metrics.MAX_COUNT};\n"
        + f"pub const STAR_PROMPT: &str = {lit(usage.STAR_PROMPT)};\n"
    )


class RustBrowseTables(unittest.TestCase):
    def test_tables_match_python(self):
        self.assertEqual(TABLES.read_text(), rust_tables(), f"rust/src/browse/tables.rs is stale; regenerate it: {REGENERATE}")


if __name__ == "__main__":
    unittest.main()
