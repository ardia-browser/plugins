import fcntl
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from parity import harness

CREDENTIAL = "p." + "Ab3_-9xYz0" * 4 + "Q7w"
BROWSER = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"
FD = 4


def holders(paths: list) -> set:
    if shutil.which("lsof"):
        found = subprocess.run(["lsof", "-t", *paths], capture_output=True, text=True).stdout.split()
        return {int(pid) for pid in found}
    wanted = {os.path.realpath(path) for path in paths}
    found = set()
    for fd_dir in Path("/proc").glob("[0-9]*/fd"):
        try:
            if any(os.path.realpath(os.readlink(link)) in wanted for link in fd_dir.iterdir()):
                found.add(int(fd_dir.parent.name))
        except OSError:
            continue
    return found


def programs():
    return harness.ts_binary() is not None and harness.ts_binary().exists() and harness.binary() is not None


class TokenServer:
    def __init__(self):
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(4)
        self.port = self.server.getsockname()[1]
        self.request = b""
        self.asked = threading.Event()
        self.release = threading.Event()
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        try:
            connection, _ = self.server.accept()
        except OSError:
            return
        with connection:
            connection.settimeout(10)
            while b"\r\n\r\n" not in self.request:
                chunk = connection.recv(4096)
                if not chunk:
                    break
                self.request += chunk
            self.asked.set()
            self.release.wait(15)

    def close(self):
        self.release.set()
        self.server.close()


@unittest.skipUnless(programs(), "build plugins/cli/rust (the router) and plugins/cli/ts first")
class PluginCredentialProcesses(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.install = harness.Installation(harness.ts_binary(), entry="ts")

    @classmethod
    def tearDownClass(cls):
        cls.install.close()

    def setUp(self):
        self.box = Path(tempfile.mkdtemp(prefix="arpl", dir="/tmp")).resolve()
        for name in ("home", "data", "cli-home", "tmp"):
            (self.box / name).mkdir()
        (self.box / "data").chmod(0o700)
        (self.box / "data" / "ArdiaControl.json").write_text(json.dumps({"port": 9, "token": "decoy-token-never-read"}))

    def tearDown(self):
        for pid in self.daemon_pids():
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        shutil.rmtree(self.box, True)

    def daemon_pids(self) -> list:
        locks = [str(path) for path in (self.box / "data" / "Browse").glob("*.lock")]
        if not locks:
            return []
        return sorted(holders(locks) - {os.getpid()})

    def env(self, port: int) -> dict:
        return {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(self.box / "home"), "TMPDIR": str(self.box / "tmp"),
                "LANG": "en_US.UTF-8", "ARDIA_DATA_DIR": str(self.box / "data"), "ARDIA_CLI_HOME": str(self.box / "cli-home"),
                "ARDIA_TELEMETRY": "0", "NO_COLOR": "1", "ARDIA_BROWSE_FOR_PLUGIN": "1", "ARDIA_PLUGIN_CREDENTIAL_FD": str(FD),
                "ARDIA_PLUGIN_ENDPOINT": f"ws://127.0.0.1:{port}/devtools/browser/{BROWSER}", "PYTHONPATH": str(harness.CLI)}

    def test_a_plugin_step_reads_its_credential_and_starts_nothing(self):
        server = TokenServer()
        self.addCleanup(server.close)
        reader, writer = os.pipe()
        os.write(writer, CREDENTIAL.encode())
        os.close(writer)
        moved = ["/bin/sh", "-c", f'exec {FD}<&{reader} {reader}<&-; exec "$@"', "sh"] if reader != FD else []
        command = [*moved, str(self.install.root / "bin" / "ardia"), "browse", "--session", "plugin-ai", "--json", "get", "--", "title"]
        process = subprocess.Popen(command, env=self.env(server.port), cwd=self.box / "tmp", stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(reader,), start_new_session=True)
        os.close(reader)
        out, err = process.communicate(timeout=60)
        self.assertEqual((process.returncode, err), (77, b""))
        answer = json.loads(out)
        self.assertEqual((answer["success"], answer["code"]), (False, "plugin_daemon_unavailable"))
        self.assertNotIn(CREDENTIAL[2:], out.decode())
        self.assertFalse(server.asked.wait(1), "a plugin step reached the token server")
        browse = Path(self.env(0)["ARDIA_DATA_DIR"]) / "Browse"
        self.assertEqual(sorted(browse.iterdir()) if browse.exists() else [], [])
        self.assertEqual(self.daemon_pids(), [])


LONG_DATA_DIR = 94
MAX_REQUEST = 16 * 1024 * 1024
OVERSIZED = "✗ the ardia browse daemon closed the connection before taking the command (see the session log)\n".encode()


def fd_open(fd: int) -> bool:
    try:
        os.fstat(fd)
    except OSError:
        return False
    return True

MAX_REQUEST = 16 * 1024 * 1024
OVERSIZED = "✗ the ardia browse daemon closed the connection before taking the command (see the session log)\n".encode()


class RelativeDaemon:
    def __init__(self, browse: Path, key: str, reply: dict, request_wait: float | None = None):
        here = os.open(".", os.O_RDONLY)
        browse.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.lock = os.open(browse / f"{key}.lock", os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(self.lock, fcntl.LOCK_EX)
        self.request_wait = request_wait
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            os.chdir(browse)
            self.server.bind(f"{key}.sock")
        finally:
            os.fchdir(here)
            os.close(here)
        (browse / f"{key}.sock").chmod(0o600)
        self.server.listen(4)
        self.reply = reply
        self.requests = []
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        while True:
            try:
                connection, _ = self.server.accept()
            except OSError:
                return
            connection.settimeout(self.request_wait)
            try:
                with connection, connection.makefile("rb") as lines:
                    self.requests.append(json.loads(lines.readline()))
                    connection.sendall(json.dumps(self.reply).encode() + b"\n")
            except OSError:
                continue

    def close(self):
        if self.lock is None:
            return
        self.server.close()
        os.close(self.lock)
        self.lock = None


@unittest.skipUnless(programs(), "build plugins/cli/rust (the router) and plugins/cli/ts first")
class LongDataDirs(PluginCredentialProcesses):
    def setUp(self):
        super().setUp()
        data = self.box / "data"
        padding = LONG_DATA_DIR - len(str(data)) - 1
        self.assertGreater(padding, 0)
        self.long = data / ("d" * padding)
        self.long.mkdir(mode=0o700)
        self.assertEqual(len(str(self.long).encode()), LONG_DATA_DIR)
        self.assertGreater(len(str(self.long / "Browse" / ("0" * 24 + ".sock")).encode()), 103)

    def daemon_pids(self) -> list:
        locks = [str(path) for path in (self.box / "data").rglob("*.lock")]
        if not locks:
            return []
        return sorted(holders(locks) - {os.getpid()})

    def env(self, port: int) -> dict:
        return {**super().env(port), "ARDIA_DATA_DIR": str(self.long)}

    @unittest.skipUnless(sys.platform == "darwin", "non-plugin browse hands back to Python on Linux by design")
    def test_normal_browse_reaches_a_running_daemon_under_a_long_data_dir_without_python(self):
        if str(harness.CLI) not in sys.path:
            sys.path.insert(0, str(harness.CLI))
        from ardia_cli.browse import client, paths

        key = paths.session_key("", client.endpoint_key(None, None, self.long)[0], "default")
        daemon = RelativeDaemon(self.long / "Browse", key, {"exit": 0, "out": "Long dirs work\n", "err": ""})
        self.addCleanup(daemon.close)
        env = {key: value for key, value in self.env(9).items() if not key.startswith(("ARDIA_BROWSE", "ARDIA_PLUGIN"))}
        process = subprocess.Popen([str(self.install.root / "bin" / "ardia"), "browse", "get", "title"], env=env, cwd=self.box / "tmp",
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        out, err = process.communicate(timeout=60)
        self.assertEqual((process.returncode, out, err), (0, b"Long dirs work\n", b""))
        self.assertEqual(len(daemon.requests), 1)
        self.assertEqual((self.install.routes / str(process.pid)).read_text(), "ts\n")


@unittest.skipUnless(programs(), "build plugins/cli/rust (the router) and plugins/cli/ts first")
class JsonAndStdin(LongDataDirs):
    def plain_env(self) -> dict:
        return {key: value for key, value in self.env(9).items() if not key.startswith(("ARDIA_BROWSE", "ARDIA_PLUGIN"))}

    def live_daemon(self, request_wait=None) -> RelativeDaemon:
        if str(harness.CLI) not in sys.path:
            sys.path.insert(0, str(harness.CLI))
        from ardia_cli.browse import client, paths

        key = paths.session_key("", client.endpoint_key(None, None, self.long)[0], "default")
        daemon = RelativeDaemon(self.long / "Browse", key, {"exit": 0, "out": "2\n", "err": ""}, request_wait)
        self.addCleanup(daemon.close)
        return daemon

    def start(self, argv: list, env: dict, **extra) -> subprocess.Popen:
        return subprocess.Popen([str(self.install.root / "bin" / "ardia"), *argv], env=env, cwd=self.box / "tmp", stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, start_new_session=True, **extra)

    @unittest.skipUnless(sys.platform == "darwin", "non-plugin browse hands back to Python on Linux by design")
    def test_a_slow_stdin_writer_is_read_to_the_end_before_the_daemon_is_asked(self):
        daemon = self.live_daemon(request_wait=1.5)
        process = self.start(["browse", "eval", "--stdin"], self.plain_env(), stdin=subprocess.PIPE)
        time.sleep(3)
        process.stdin.write(b"1+1")
        process.stdin.close()
        out, err = process.communicate(timeout=60)
        self.assertEqual((process.returncode, out, err), (0, b"2\n", b""))
        self.assertEqual([request["stdin"] for request in daemon.requests], ["1+1"])

    def oversized(self, size: int, close_after: bool) -> tuple:
        daemon = self.live_daemon()
        reader, writer = os.pipe()
        process = self.start(["browse", "eval", "--stdin"], self.plain_env(), stdin=reader)
        os.close(reader)

        def feed():
            try:
                with os.fdopen(writer, "wb", closefd=close_after) as pipe:
                    pipe.write(b"1" * size)
            except OSError:
                pass

        threading.Thread(target=feed, daemon=True).start()
        if not close_after:
            self.addCleanup(lambda: os.close(writer) if fd_open(writer) else None)
        out, err = process.communicate(timeout=60)
        return process.returncode, out, err, daemon.requests

    @unittest.skipUnless(sys.platform == "darwin", "non-plugin browse hands back to Python on Linux by design")
    def test_stdin_over_the_daemons_request_limit_stops_the_read_and_sends_nothing(self):
        status, out, err, requests = self.oversized(MAX_REQUEST + 1, close_after=False)
        self.assertEqual((status, out, requests), (2, b"", []))
        self.assertEqual(err, OVERSIZED)

    @unittest.skipUnless(sys.platform == "darwin", "non-plugin browse hands back to Python on Linux by design")
    def test_a_request_the_envelope_pushes_over_the_limit_is_refused_before_connecting(self):
        status, out, err, requests = self.oversized(MAX_REQUEST - 64, close_after=True)
        self.assertEqual((status, out, requests), (2, b"", []))
        self.assertEqual(err, OVERSIZED)

    @unittest.skipUnless(sys.platform == "darwin", "non-plugin browse hands back to Python on Linux by design")
    def test_a_daemon_gone_while_stdin_was_read_says_the_input_was_used(self):
        daemon = self.live_daemon()
        reader, writer = os.pipe()
        process = self.start(["browse", "eval", "--stdin"], self.plain_env(), stdin=reader)
        os.close(reader)
        time.sleep(2)
        daemon.close()
        for path in (self.long / "Browse").glob("*.sock"):
            path.unlink()
        os.write(writer, b"1+1")
        os.close(writer)
        out, err = process.communicate(timeout=60)
        self.assertEqual((process.returncode, out), (2, b""))
        self.assertEqual(err, "✗ the ardia browse daemon exited while stdin was being read, and that input was used up, so nothing ran; "
                              "run the command again with its input\n".encode())
        self.assertEqual(daemon.requests, [])

    @unittest.skipUnless(sys.platform == "darwin", "non-plugin browse hands back to Python on Linux by design")
    def test_ctrl_c_while_stdin_is_read_answers_one_json_line(self):
        self.live_daemon()
        reader, writer = os.pipe()
        self.addCleanup(os.close, writer)
        process = self.start(["browse", "--json", "eval", "--stdin"], self.plain_env(), stdin=reader)
        os.close(reader)
        time.sleep(2)
        os.killpg(process.pid, signal.SIGINT)
        out, err = process.communicate(timeout=30)
        self.assertEqual(process.returncode, 130, err)
        self.assertEqual(json.loads(out), {"success": False, "data": None, "error": "interrupted", "code": "interrupted"})
        self.assertEqual(out.count(b"\n"), 1)
        self.assertEqual(err, b"")

    def credential_never_ends(self, json_mode: bool) -> tuple:
        reader, writer = os.pipe()
        self.addCleanup(os.close, writer)
        moved = ["/bin/sh", "-c", f'exec {FD}<&{reader} {reader}<&-; exec "$@"', "sh"] if reader != FD else []
        argv = ["browse", "--session", "plugin-ai", *(["--json"] if json_mode else []), "get", "--", "title"]
        process = subprocess.Popen([*moved, str(self.install.root / "bin" / "ardia"), *argv], env=self.env(9), cwd=self.box / "tmp",
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(reader,), start_new_session=True)
        os.close(reader)
        time.sleep(0.7)
        started = time.monotonic()
        os.killpg(process.pid, signal.SIGINT)
        out, err = process.communicate(timeout=30)
        return process.returncode, out, err, time.monotonic() - started

    def test_ctrl_c_ends_the_credential_read(self):
        status, out, err, waited = self.credential_never_ends(False)
        self.assertEqual((status, out, err), (130, b"", "✗ interrupted\n".encode()))
        self.assertLess(waited, 1.2)
        status, out, err, _ = self.credential_never_ends(True)
        self.assertEqual((status, err), (130, b""))
        self.assertEqual(json.loads(out)["code"], "interrupted")

    def test_the_router_refuses_in_json_when_there_is_no_typescript_client(self):
        root = self.box / "bare"
        (root / "bin").mkdir(parents=True)
        shutil.copy2(self.install.root / "bin" / "ardia", root / "bin" / "ardia")
        for json_mode, words in ((True, ["browse", "--session", "plugin-ai", "--json"]), (False, ["browse", "--session", "plugin-ai"]),
                                 (False, ["--json", "browse", "--session", "plugin-ai", "--json=false"])):
            argv = [str(root / "bin" / "ardia"), *words, "get", "--", "title"]
            done = subprocess.run(argv, env=self.env(9), cwd=self.box / "tmp", stdin=subprocess.DEVNULL, capture_output=True, timeout=30)
            self.assertEqual(done.returncode, 77)
            if json_mode:
                self.assertEqual(done.stderr, b"")
                answer = json.loads(done.stdout)
                self.assertEqual((answer["success"], answer["code"]), (False, "plugin_refused"))
                self.assertIn("this ardia has no TypeScript client", answer["error"])
            else:
                self.assertEqual(done.stdout, b"")
                self.assertTrue(done.stderr.startswith("✗ ardia browse for a plugin".encode()))


    def test_a_missing_addon_under_json_is_one_json_line(self):
        root = self.box / "no-addon"
        shutil.copytree(self.install.root / "bin", root / "bin")
        shutil.copytree(self.install.root / "libexec", root / "libexec", symlinks=True)
        (root / "libexec" / "ardia-libc.so").unlink()
        for json_mode in (True, False):
            argv = [str(root / "bin" / "ardia"), "browse", "--session", "plugin-ai", *(["--json"] if json_mode else []), "get", "--", "title"]
            done = subprocess.run(argv, env=self.env(9), cwd=self.box / "tmp", stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
            self.assertEqual(done.returncode, 252, done.stderr)
            if json_mode:
                self.assertEqual(done.stderr, b"")
                answer = json.loads(done.stdout)
                self.assertEqual((answer["success"], answer["code"]), (False, "internal_error"))
                self.assertIn("ardia-libc.so", answer["error"])
                self.assertEqual(done.stdout.count(b"\n"), 1)
            else:
                self.assertEqual(done.stdout, b"")
                self.assertIn(b"ardia-libc.so", done.stderr)



class Listener:
    def __init__(self):
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(4)
        self.server.settimeout(0.2)
        self.port = self.server.getsockname()[1]
        self.heard = threading.Event()
        self.closing = threading.Event()
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        while not self.closing.is_set():
            try:
                connection, _ = self.server.accept()
            except OSError:
                continue
            self.heard.set()
            connection.close()

    def close(self):
        self.closing.set()
        self.server.close()


@unittest.skipUnless(programs(), "build plugins/cli/rust (the router) and plugins/cli/ts first")
class PluginTelemetry(PluginCredentialProcesses):
    def run_with_sharing(self, telemetry: str | None) -> tuple:
        data = self.box / "data"
        (data / "telemetry.json").write_text(json.dumps({"sharing": True, "installId": "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"}))
        (data / "Telemetry").mkdir(mode=0o700, exist_ok=True)
        listener = Listener()
        self.addCleanup(listener.close)
        env = {key: value for key, value in self.env(9).items() if key != "ARDIA_TELEMETRY"}
        if telemetry is not None:
            env["ARDIA_TELEMETRY"] = telemetry
        env["ARDIA_TELEMETRY_URL"] = f"http://127.0.0.1:{listener.port}/v1/logs"
        reader, writer = os.pipe()
        os.write(writer, CREDENTIAL.encode())
        os.close(writer)
        moved = ["/bin/sh", "-c", f'exec {FD}<&{reader} {reader}<&-; exec "$@"', "sh"] if reader != FD else []
        command = [*moved, str(self.install.root / "bin" / "ardia"), "browse", "--session", "plugin-ai", "--json", "get", "--", "title"]
        process = subprocess.run(command, env=env, cwd=self.box / "tmp", stdin=subprocess.DEVNULL, capture_output=True,
                                 pass_fds=(reader,), timeout=60)
        os.close(reader)
        heard = listener.heard.wait(3)
        spool = data / "Telemetry" / "cli-queue.jsonl"
        events = [json.loads(line) for line in spool.read_text().splitlines()] if spool.exists() else []
        return process, heard, events, (data / "Telemetry" / "cli-flush.json").exists()

    def test_with_sharing_on_a_plugin_call_spools_its_event_and_starts_no_flusher(self):
        process, heard, events, flushed = self.run_with_sharing(None)
        self.assertEqual(process.returncode, 77, process.stderr)
        self.assertFalse(heard, "a plugin call reached the network")
        self.assertFalse(flushed, "a plugin call started a flush")
        commands = [event for event in events if event.get("event") == "cli_command" or event.get("body", {}).get("event") == "cli_command"
                    or "cli_command" in json.dumps(event)]
        self.assertEqual(len(commands), 1, events)
        self.assertIn('"plugin_mode": true', json.dumps(commands[0]))
        self.assertNotIn(CREDENTIAL[2:], json.dumps(events))

    def test_with_telemetry_off_a_plugin_call_records_nothing(self):
        process, heard, events, flushed = self.run_with_sharing("0")
        self.assertEqual(process.returncode, 77, process.stderr)
        self.assertEqual((heard, events, flushed), (False, [], False))


if __name__ == "__main__":
    unittest.main()
