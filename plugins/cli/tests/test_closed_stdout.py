import fcntl
import json
import os
import pty
import re
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from parity import harness
from test_parity import FakeArdia, full_blocking_pipe

CALLS = (["--version"], ["--help"], ["-h"], [])
LISTINGS = (["windows", "--json"], ["tabs", "--json"], ["tabs"])
STDOUT_KINDS = ("closed pipe", "read-only file", "full non-blocking pipe", "hung-up terminal") + (("full device",) if Path("/dev/full").exists() else ())
TRACEBACK = re.compile(rb"Traceback \(most recent call last\):\n(?:  .*\n)*")
TABS = [{"type": "tab", "id": f"tab-{index}", "title": "t" * 40, "url": "https://example.com/" + "p" * 40} for index in range(3000)]
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


def run_to(command: list[str], home: Path, kind: str) -> tuple:
    env = environment(home, telemetry=True)
    if kind == "full device":
        stdout = os.open("/dev/full", os.O_WRONLY)
        keep = None
    elif kind == "read-only file":
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
    try:
        stderr = process.communicate(timeout=60)[1]
    finally:
        if keep is not None:
            os.close(keep)
    return process.returncode, TRACEBACK.sub(b"", stderr), telemetry_of(home)


STDERR_KINDS = ("closed pipe", "read-only file", "full non-blocking pipe", "hung-up terminal")


def failing_stderr(home: Path, kind: str) -> tuple:
    if kind == "read-only file":
        target = home / "read-only-stderr"
        target.touch()
        return None, os.open(target, os.O_RDONLY)
    if kind == "full non-blocking pipe":
        return full_pipe()
    keep, stderr = pty.openpty() if kind == "hung-up terminal" else os.pipe()
    os.close(keep)
    return None, stderr


def left_in(keep: int) -> bytes:
    fcntl.fcntl(keep, fcntl.F_SETFL, fcntl.fcntl(keep, fcntl.F_GETFL) | os.O_NONBLOCK)
    tail = b""
    try:
        while chunk := os.read(keep, 65536):
            tail = (tail + chunk)[-65536:]
    except BlockingIOError:
        pass
    return tail.rstrip(b"x")


def run_with_stderr(command: list[str], home: Path, kind: str) -> tuple:
    keep, stderr = failing_stderr(home, kind)
    try:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=stderr, env=environment(home, telemetry=True))
    finally:
        os.close(stderr)
    try:
        stdout = process.communicate(timeout=60)[0]
    finally:
        tail = b""
        if keep is not None:
            tail = left_in(keep)
            os.close(keep)
    return process.returncode, stdout, TRACEBACK.sub(b"", tail), telemetry_of(home)


def crash_recorded_while_stderr_blocks(command: list[str], home: Path) -> tuple:
    keep, stderr = full_blocking_pipe()
    master, stdout = pty.openpty()
    os.close(master)
    try:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, env=environment(home, telemetry=True))
    finally:
        os.close(stdout)
        os.close(stderr)
    local = home / LOCAL_TELEMETRY

    def recorded() -> bool:
        return any('"cli_command"' in path.read_text() for path in local.glob("cli-*.jsonl"))

    try:
        early = harness.wait_until(recorded, 20)
    finally:
        drainer = threading.Thread(target=drain, args=(keep,))
        drainer.start()
        process.wait(60)
        drainer.join(10)
        os.close(keep)
    return early, process.returncode, telemetry_of(home)


def run_limited(command: list[str], home: Path, limit: int, ignored: bool, telemetry: bool) -> tuple:
    out = home / "out"
    stdout = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)

    def limit_file_size():
        resource.setrlimit(resource.RLIMIT_FSIZE, (limit, resource.RLIM_INFINITY))
        signal.signal(signal.SIGXFSZ, signal.SIG_IGN if ignored else signal.SIG_DFL)

    try:
        process = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=stdout, stderr=subprocess.PIPE, env=environment(home, telemetry),
                                 preexec_fn=limit_file_size, timeout=60)
    finally:
        os.close(stdout)
    return process.returncode, out.stat().st_size, TRACEBACK.sub(b"", process.stderr), telemetry_of(home)


class ClosedStdout:
    entry = "rust"

    def test_each_served_call_ends_like_python_whatever_stdout_fails_with(self):
        install = harness.Installation(harness.entry_binary(self.entry), entry=self.entry)
        try:
            with tempfile.TemporaryDirectory() as scratch:
                for argv in CALLS:
                    for kind in STDOUT_KINDS:
                        with self.subTest(argv=argv, stdout=kind):
                            python = run_to([sys.executable, "-m", "ardia_cli", *argv], Path(scratch), kind)
                            new = run_to([*install.command("new"), *argv], Path(scratch), kind)
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

    def test_a_file_size_limit_ends_like_python_whether_or_not_sigxfsz_was_ignored(self):
        install = harness.Installation(harness.entry_binary(self.entry), entry=self.entry)
        try:
            with tempfile.TemporaryDirectory() as scratch:
                home = Path(scratch)
                (home / "data").mkdir()
                windows = [{"id": f"w-{index}", "title": "t" * 30} for index in range(300)]
                fake = FakeArdia(home / "data" / "ArdiaControl.sock", {"hello": {"result": {"app": "Ardia"}}, "windows": {"result": windows}})
                try:
                    for argv, limit, telemetry in ((["windows", "--json"], 4096, True), (["windows"], 4096, True), ([], 2048, False),
                                                   (["--help"], 2048, False), (["--version"], 8, False)):
                        for ignored in (False, True):
                            with self.subTest(argv=argv, sigxfsz_ignored=ignored):
                                python = run_limited([sys.executable, "-m", "ardia_cli", *argv], home, limit, ignored, telemetry)
                                new = run_limited([*install.command("new"), *argv], home, limit, ignored, telemetry)
                                self.assertEqual(new, python)
                finally:
                    fake.close()
        finally:
            install.close()

    def test_a_listing_ends_like_python_whatever_stderr_fails_with(self):
        install = harness.Installation(harness.entry_binary(self.entry), entry=self.entry)
        try:
            with tempfile.TemporaryDirectory() as scratch:
                home = Path(scratch)
                (home / "data").mkdir()
                for replies, argv in ((None, ["windows"]), ({"windows": {"error": {"code": "boom", "message": "it broke"}}}, ["windows"]),
                                      ({"workspace": {"error": {"code": "boom", "message": "it broke"}}}, ["tabs", "--json"])):
                    (home / "data" / "ArdiaControl.sock").unlink(missing_ok=True)
                    fake = None if replies is None else FakeArdia(home / "data" / "ArdiaControl.sock", {"hello": {"result": {"app": "Ardia"}}, **replies})
                    try:
                        for kind in STDERR_KINDS:
                            with self.subTest(argv=argv, control=replies is not None, stderr=kind):
                                python = run_with_stderr([sys.executable, "-m", "ardia_cli", *argv], home, kind)
                                new = run_with_stderr([*install.command("new"), *argv], home, kind)
                                self.assertEqual(new, python)
                    finally:
                        if fake is not None:
                            fake.close()
        finally:
            install.close()

    def test_a_line_cut_by_a_file_size_limit_ends_as_pythons_buffered_writer_decides(self):
        install = harness.Installation(harness.entry_binary(self.entry), entry=self.entry)
        try:
            with tempfile.TemporaryDirectory() as scratch:
                home = Path(scratch)
                (home / "data").mkdir()
                (home / "probe").touch()
                block = os.stat(home / "probe").st_blksize
                first = len("window w-1  normal\n")
                tab_line_extra = len("     t  " + "  u\n")
                for line, limit in ((block + 16, 2000), (block, first), (block - 1, first), (block - 1, first + 100), (2 * block + 5, block + 100),
                                    (2 * block + 5, first)):
                    tabs = [{"id": "t", "title": "a" * (line - tab_line_extra), "url": "u"}]
                    (home / "data" / "ArdiaControl.sock").unlink(missing_ok=True)
                    fake = FakeArdia(home / "data" / "ArdiaControl.sock", {"hello": {"result": {"app": "Ardia"}}, "windows": {"result": [{"id": "w-1", "tabs": tabs}]}})
                    try:
                        for ignored in (False, True):
                            with self.subTest(line=line, limit=limit, buffer=block, sigxfsz_ignored=ignored):
                                python = run_limited([sys.executable, "-m", "ardia_cli", "windows"], home, limit, ignored, False)
                                new = run_limited([*install.command("new"), "windows"], home, limit, ignored, False)
                                self.assertEqual(new, python)
                    finally:
                        fake.close()
        finally:
            install.close()

    def test_a_crash_is_recorded_before_its_diagnostic_waits_on_a_blocked_stderr(self):
        install = harness.Installation(harness.entry_binary(self.entry), entry=self.entry)
        try:
            with tempfile.TemporaryDirectory() as scratch:
                home = Path(scratch)
                (home / "data").mkdir()
                fake = FakeArdia(home / "data" / "ArdiaControl.sock", {"hello": {"result": {"app": "Ardia"}}, "windows": {"result": [{"id": "w-1"}]}})
                try:
                    for argv in (["windows"], []):
                        with self.subTest(argv=argv):
                            python = crash_recorded_while_stderr_blocks([sys.executable, "-m", "ardia_cli", *argv], home)
                            new = crash_recorded_while_stderr_blocks([*install.command("new"), *argv], home)
                            self.assertTrue(python[0])
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


@harness.requires(harness.binary(), ("rust",), "build plugins/cli/rust first (cargo build) or set ARDIA_RUST_CLI")
class RustClosedStdout(ClosedStdout, unittest.TestCase):
    entry = "rust"


@harness.requires(harness.ts_binary() and harness.binary(), ("rust", "ts"), "build plugins/cli/ts and plugins/cli/rust first, or set ARDIA_TS_CLI and ARDIA_RUST_CLI")
class TsClosedStdout(ClosedStdout, unittest.TestCase):
    entry = "ts"
