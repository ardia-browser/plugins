import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from parity import harness

CALLS = (["--version"], ["--help"], ["-h"], [])


def run_to_closed_pipe(command: list[str], home: Path) -> tuple[int, bytes]:
    read_end, write_end = os.pipe()
    os.close(read_end)
    env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "ARDIA_CLI_HOME": str(home / "cli"), "ARDIA_DATA_DIR": str(home / "data"),
           "TMPDIR": str(home), "ARDIA_TELEMETRY": "0", "LANG": os.environ.get("LANG", "en_US.UTF-8"), "PYTHONPATH": str(harness.CLI)}
    try:
        done = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=write_end, stderr=subprocess.PIPE, env=env, timeout=60)
    finally:
        os.close(write_end)
    return done.returncode, done.stderr


class ClosedStdout:
    entry = "rust"

    def test_each_served_call_ends_like_python_when_stdout_is_a_closed_pipe(self):
        install = harness.Installation(harness.entry_binary(self.entry), entry=self.entry)
        try:
            with tempfile.TemporaryDirectory() as scratch:
                for argv in CALLS:
                    with self.subTest(argv=argv):
                        python = run_to_closed_pipe([sys.executable, "-m", "ardia_cli", *argv], Path(scratch))
                        new = run_to_closed_pipe([*install.command("new"), *argv], Path(scratch))
                        self.assertEqual(new, python)
        finally:
            install.close()


@unittest.skipUnless(harness.binary(), "build plugins/cli/rust first (cargo build) or set ARDIA_RUST_CLI")
class RustClosedStdout(ClosedStdout, unittest.TestCase):
    entry = "rust"


@unittest.skipUnless(harness.ts_binary() and harness.binary(), "build plugins/cli/ts and plugins/cli/rust first, or set ARDIA_TS_CLI and ARDIA_RUST_CLI")
class TsClosedStdout(ClosedStdout, unittest.TestCase):
    entry = "ts"
