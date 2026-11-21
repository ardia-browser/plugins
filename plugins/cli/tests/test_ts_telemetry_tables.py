import json
import sys
import unittest
from pathlib import Path

CLI = Path(__file__).resolve().parents[1]
TABLES = CLI / "ts" / "src" / "telemetry-tables.ts"
REGENERATE = "python -c 'from tests.test_ts_telemetry_tables import ts_tables; print(ts_tables(), end=\"\")' > ts/src/telemetry-tables.ts"


def words(name: str, values) -> str:
    return f"export const {name}: readonly string[] = {json.dumps(sorted(values), ensure_ascii=False)};\n"


def ts_tables() -> str:
    if str(CLI) not in sys.path:
        sys.path.insert(0, str(CLI))
    from ardia_cli import command_metrics, telemetry

    aliases, known = telemetry.browse_names()
    flags = (command_metrics.FLAGS | command_metrics.READ_FLAGS | command_metrics.ACT_FLAGS | command_metrics.CHANGE_FLAGS
             | command_metrics.FLOW_FLAGS)
    counts = command_metrics.COUNTS | command_metrics.ACT_COUNTS | command_metrics.CHANGE_COUNTS | command_metrics.FLOW_COUNTS
    return (
        f"export const BROWSE_ALIASES: Readonly<Record<string, string>> = {json.dumps(dict(sorted(aliases.items())), ensure_ascii=False)};\n"
        + words("BROWSE_KNOWN", known)
        + words("METRIC_FLAGS", flags)
        + words("METRIC_DURATIONS", command_metrics.DURATIONS)
        + words("METRIC_COUNTS", counts)
        + f"export const METRIC_MAX_MS = {command_metrics.MAX_MS};\n"
        + f"export const METRIC_MAX_COUNT = {command_metrics.MAX_COUNT};\n"
    )


class TsTelemetryTables(unittest.TestCase):
    def test_tables_match_python(self):
        self.assertEqual(TABLES.read_text(), ts_tables(), f"ts/src/telemetry-tables.ts is stale; regenerate it: {REGENERATE}")


if __name__ == "__main__":
    unittest.main()
