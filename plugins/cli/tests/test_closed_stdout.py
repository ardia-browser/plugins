import fcntl
import json
import os
import pty
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from parity import harness
from test_parity import FakeArdia

CALLS = (["--version"], ["--help"], ["-h"], [])
LISTINGS = (["windows", "--json"], ["tabs", "--json"], ["tabs"])
STDOUT_KINDS = ("closed pipe", "read-only file", "full non-blocking pipe", "hung-up terminal")
TRACEBACK = re.compile(rb"Traceback \(most recent call last\):\n(?:  .*\n)*")
TABS = [{"type": "tab", "id": f"tab-{index}", "title": "t" * 40, "url": "https://example.com/" + "p" * 40} for index in range(3000)]
DRAIN_AFTER_S = 0.4
CLOSING = {0: "<&-", 1: ">&-", 2: "2>&-"}
LOCAL_TELEMETRY = Path("data") / "Telemetry" / "local"


def environment(home: Path, telemetry: bool = False) -> dict:
    env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "ARDIA_CLI_HOME": str(home / "cli"), "ARDIA_DATA_DIR": str(home / "data"),
           "TMPDIR": str(home), "ARDIA_TELEMETRY": "0", "LANG": os.environ.get("LANG", "en_US.UTF-8"), "PYTHONPATH": str(harness.CLI)}
    if telemetry:
        del env["ARDIA_TELEMETRY"]
        env["ARDIA_TELEMETRY_URL"] = "http://127.0.0.1:9/v1/logs"
    return env


def without_native_differences(record: dict) -> dict:
    for exception in record.get("properties", {}).get("$exception_list") or []:
        exception.get("stacktrace", {}).pop("frames", None)
    return record


def telemetry_of(home: Path) -> list:
    records = []
    for path in sorted((home / LOCAL_TELEMETRY).glob("cli-*.jsonl")):
        for line in path.read_text().splitlines():
            record = json.loads(line)
            for key in (*harness.VOLATILE, "timestamp"):
                record.pop(key, None)
            for key in harness.VOLATILE_PROPERTIES:
                record.get("properties", {}).pop(key, None)
            records.append(without_native_differences(record))
    shutil.rmtree(home / "data" / "Telemetry", True)
    return records


def run_with_closed(command: list[str], home: Path, fd: int) -> tuple:
    wrapped = ["/bin/sh", "-c", f'exec "$@" {CLOSING[fd]}', "sh", *command]
    captured = {name: subprocess.DEVNULL if index == fd else subprocess.PIPE for index, name in enumerate(("stdin", "stdout", "stderr"))}
    process = subprocess.run(wrapped, env=environment(home, telemetry=True), timeout=60, **captured)
    return process.returncode, process.stdout, TRACEBACK.sub(b"", process.stderr or b""), telemetry_of(home)


def run_to_closed_pipe(command: list[str], home: Path) -> tuple[int, bytes]:
    return run_to(command, home, "closed pipe")


def full_pipe() -> tuple[int, int]:
    read_end, write_end = os.pipe()
    fcntl.fcntl(write_end, fcntl.F_SETFL, fcntl.fcntl(write_end, fcntl.F_GETFL) | os.O_NONBLOCK)
    while True:
        try:
            os.write(write_end, b"x" * 65536)
        except BlockingIOError:
            return read_end, write_end


def drain(read_end: int) -> None:
    while os.read(read_end, 65536):
        pass


def run_to(command: list[str], home: Path, kind: str) -> tuple[int, bytes]:
    env = environment(home)
    if kind == "read-only file":
        target = home / "read-only"
        target.touch()
        stdout = os.open(target, os.O_RDONLY)
        keep = None
    elif kind == "full non-blocking pipe":
        keep, stdout = full_pipe()
    else:
        keep, stdout = pty.openpty() if kind == "hung-up terminal" else os.pipe()
        os.close(keep)
        keep = None
    try:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=stdout, stderr=subprocess.PIPE, env=env)
    finally:
        os.close(stdout)
    drainer = None
    if keep is not None:
        time.sleep(DRAIN_AFTER_S)
        drainer = threading.Thread(target=drain, args=(keep,))
        drainer.start()
    try:
        stderr = process.communicate(timeout=60)[1]
    finally:
        if drainer is not None:
            drainer.join(10)
            os.close(keep)
    return process.returncode, TRACEBACK.sub(b"", stderr)


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

    def test_a_listing_ends_like_python_whatever_stdout_fails_with(self):
        install = harness.Installation(harness.entry_binary(self.entry), entry=self.entry)
        try:
            with tempfile.TemporaryDirectory() as scratch:
                home = Path(scratch)
                (home / "data").mkdir()
                fake = FakeArdia(home / "data" / "ArdiaControl.sock", {"hello": {"result": {"app": "Ardia"}}, "windows": {"result": []},
                                 "workspace": {"result": {"windows": [{"id": "w-1", "spaces": [{"profile": "p", "tabs": TABS}]}]}}})
                try:
                    for argv in LISTINGS:
                        for kind in STDOUT_KINDS:
                            with self.subTest(argv=argv, stdout=kind):
                                python = run_to([sys.executable, "-m", "ardia_cli", *argv], home, kind)
                                new = run_to([*install.command("new"), *argv], home, kind)
                                self.assertEqual(new, python)
                finally:
                    fake.close()
        finally:
            install.close()

    def test_a_call_ends_like_python_when_a_standard_descriptor_was_closed_before_it_started(self):
        install = harness.Installation(harness.entry_binary(self.entry), entry=self.entry)
        try:
            with tempfile.TemporaryDirectory() as scratch:
                home = Path(scratch)
                (home / "data").mkdir()
                fake = FakeArdia(home / "data" / "ArdiaControl.sock", {"hello": {"result": {"app": "Ardia"}}, "windows": {"result": [{"id": "w-1"}]},
                                 "workspace": {"result": {"windows": [{"id": "w-1", "spaces": [{"profile": "p", "tabs": TABS[:2]}]}]}}})
                try:
                    for argv in (*CALLS, *LISTINGS):
                        for fd in CLOSING:
                            with self.subTest(argv=argv, closed=fd):
                                python = run_with_closed([sys.executable, "-m", "ardia_cli", *argv], home, fd)
                                new = run_with_closed([*install.command("new"), *argv], home, fd)
                                self.assertEqual(new, python)
                finally:
                    fake.close()
        finally:
            install.close()


@unittest.skipUnless(harness.binary(), "build plugins/cli/rust first (cargo build) or set ARDIA_RUST_CLI")
class RustClosedStdout(ClosedStdout, unittest.TestCase):
    entry = "rust"


@unittest.skipUnless(harness.ts_binary() and harness.binary(), "build plugins/cli/ts and plugins/cli/rust first, or set ARDIA_TS_CLI and ARDIA_RUST_CLI")
class TsClosedStdout(ClosedStdout, unittest.TestCase):
    entry = "ts"
