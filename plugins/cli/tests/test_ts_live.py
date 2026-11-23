import json
import unittest
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from parity import harness


def fake(path: Path, events: int, hang_method: str | None):
    server = socket.socket(socket.AF_UNIX)
    server.bind(str(path))
    server.listen(4)

    def talk(connection):
        for line in connection.makefile("rb"):
            request = json.loads(line)
            method = request["method"]
            if method == hang_method:
                time.sleep(30)
                return
            if method == "hello":
                connection.sendall(json.dumps({"id": request["id"], "result": {"app": "Ardia", "protocol": 4}}).encode() + b"\n")
            elif method == "subscribe":
                connection.sendall(json.dumps({"id": request["id"], "result": True}).encode() + b"\n")
                try:
                    for index in range(events):
                        connection.sendall(json.dumps({"event": "tab.opened", "time": 1700000000000, "data": {"tabId": index}}).encode() + b"\n")
                except OSError:
                    return
            else:
                connection.sendall(json.dumps({"id": request["id"], "result": [{"id": 1}]}).encode() + b"\n")

    def accept():
        while True:
            try:
                connection, _ = server.accept()
            except OSError:
                return
            threading.Thread(target=talk, args=(connection,), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()
    return server


def run(install, side, argv, *, interrupt_after=None, head=False, events=3, hang=None):
    box = Path(tempfile.mkdtemp(prefix="m2l", dir="/tmp"))
    data = box / "d"
    data.mkdir()
    server = fake(data / "ArdiaControl.sock", events, hang)
    env = {"PATH": "/usr/bin:/bin", "HOME": str(box), "ARDIA_CLI_HOME": str(box / "cli"), "ARDIA_DATA_DIR": str(data), "DO_NOT_TRACK": "1", "TZ": "UTC"}
    command = install.command(side) + argv
    if head:
        reader, writer = os.pipe()
        process = subprocess.Popen(command, env=env, stdout=writer, stderr=subprocess.PIPE, start_new_session=True)
        os.close(writer)
        first = os.read(reader, 200)
        os.close(reader)
        _, stderr = process.communicate(timeout=20)
        out = first.split(b"\n")[0]
    else:
        process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        if interrupt_after is not None:
            time.sleep(interrupt_after)
            os.killpg(process.pid, signal.SIGINT)
        out, stderr = process.communicate(timeout=20)
        out = out[-200:]
    server.close()
    shutil.rmtree(box, True)
    return process.returncode, out, stderr.decode()




def silent_stdin(install, side, argv):
    reader, writer = os.pipe()
    box = Path(tempfile.mkdtemp(prefix="m2l", dir="/tmp"))
    env = {"PATH": "/usr/bin:/bin", "HOME": str(box), "ARDIA_CLI_HOME": str(box / "cli"), "ARDIA_DATA_DIR": str(box), "DO_NOT_TRACK": "1"}
    process = subprocess.Popen(install.command(side) + argv, env=env, stdin=reader, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    time.sleep(2.0)
    os.killpg(process.pid, signal.SIGINT)
    out, err = process.communicate(timeout=20)
    os.close(reader)
    os.close(writer)
    shutil.rmtree(box, True)
    return process.returncode, out, err.decode()


@harness.requires(harness.binary() and harness.ts_binary(), ("rust", "ts"), "build plugins/cli/rust (the router) and plugins/cli/ts (bun run build)")
class TsControlCommandsLive(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.install = harness.Installation(harness.entry_binary("ts"), entry="ts")

    @classmethod
    def tearDownClass(cls):
        cls.install.close()

    def same(self, results):
        self.assertEqual(results["new"], results["python"])

    def test_interrupts_and_closed_stdout_end_like_python(self):
        for name, argv, options in (
            ("events interrupted", ["events"], {"interrupt_after": 2.0}),
            ("events closed stdout", ["events"], {"head": True, "events": 20000}),
            ("call interrupted while waiting", ["call", "slow.method"], {"interrupt_after": 2.0, "hang": "slow.method"}),
            ("run interrupted while waiting", ["run", "newTab"], {"interrupt_after": 2.0, "hang": "run"}),
            ("windows closed stdout", ["call", "windows"], {"head": True}),
        ):
            with self.subTest(name):
                self.same({side: run(self.install, side, argv, **options) for side in ("new", "python")})

    def test_an_interrupt_while_params_wait_on_stdin_ends_like_python(self):
        self.same({side: silent_stdin(self.install, side, ["call", "x", "--params", "-"]) for side in ("new", "python")})


if __name__ == "__main__":
    unittest.main()
