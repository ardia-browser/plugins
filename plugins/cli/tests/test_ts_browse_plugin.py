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
        found = subprocess.run(["lsof", "-t", *locks], capture_output=True, text=True).stdout.split()
        return sorted({int(pid) for pid in found} - {os.getpid()})

    def env(self, port: int) -> dict:
        return {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(self.box / "home"), "TMPDIR": str(self.box / "tmp"),
                "LANG": "en_US.UTF-8", "ARDIA_DATA_DIR": str(self.box / "data"), "ARDIA_CLI_HOME": str(self.box / "cli-home"),
                "ARDIA_TELEMETRY": "0", "NO_COLOR": "1", "ARDIA_BROWSE_FOR_PLUGIN": "1", "ARDIA_PLUGIN_CREDENTIAL_FD": str(FD),
                "ARDIA_PLUGIN_ENDPOINT": f"ws://127.0.0.1:{port}/devtools/browser/{BROWSER}", "PYTHONPATH": str(harness.CLI)}

    def family(self, root: int) -> list:
        rows = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True).stdout.split("\n")
        members = {root}
        for _ in range(6):
            for row in rows:
                parts = row.split()
                if len(parts) == 2 and int(parts[1]) in members:
                    members.add(int(parts[0]))
        return sorted(members | set(self.daemon_pids()))

    def look(self, root: int) -> list:
        seen = []
        for pid in self.family(root):
            args = subprocess.run(["ps", "-o", "args=", "-p", str(pid)], capture_output=True, text=True).stdout
            environ = subprocess.run(["ps", "-E", "-o", "command=", "-p", str(pid)], capture_output=True, text=True).stdout
            held = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", str(FD)], capture_output=True, text=True).stdout
            seen.append((pid, args, environ, held))
        return seen

    def start_session(self, command: list) -> tuple[str, list]:
        server = TokenServer()
        self.addCleanup(server.close)
        reader, writer = os.pipe()
        os.write(writer, CREDENTIAL.encode())
        os.close(writer)
        moved = ["/bin/sh", "-c", f'exec {FD}<&{reader} {reader}<&-; exec "$@"', "sh"] if reader != FD else []
        wrapped = [*moved, *command, "browse", "--session", "plugin-ai", "get", "--", "title"]
        process = subprocess.Popen(wrapped, env=self.env(server.port), cwd=self.box / "tmp", stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(reader,), start_new_session=True)
        os.close(reader)
        try:
            self.assertTrue(server.asked.wait(30), "the daemon never opened the token server")
            seen = self.look(process.pid)
        finally:
            server.release.set()
            process.communicate(timeout=120)
        return server.request.decode("latin1"), seen

    def check(self, head: str, seen: list, client: str):
        self.assertTrue(head.startswith(f"GET /devtools/browser/{BROWSER}?token={CREDENTIAL} HTTP/1.1\r\n"), head[:200])
        self.assertNotIn("\r\norigin:", head.lower())
        self.assertNotIn("decoy-token-never-read", head)
        commands = [args for _, args, _, _ in seen]
        self.assertTrue(any(client in args for args in commands), commands)
        self.assertTrue(any("daemon.main()" in args for args in commands), commands)
        for pid, args, environ, held in seen:
            self.assertNotIn(CREDENTIAL[2:], args, pid)
            self.assertNotIn(CREDENTIAL[2:], environ, pid)
            if client in args or "daemon.main()" in args:
                kinds = [row.split()[4] for row in held.strip().splitlines()[1:]]
                self.assertNotIn("PIPE", kinds, f"fd {FD} is still the credential pipe in {args.strip()}")
        for path in (Path(self.env(0)["ARDIA_DATA_DIR"]) / "Browse").iterdir():
            if path.is_file():
                self.assertNotIn(CREDENTIAL[2:], path.read_text(errors="replace"), path.name)

    def test_the_typescript_client_starts_a_daemon_that_alone_holds_the_credential(self):
        head, seen = self.start_session([str(self.install.root / "bin" / "ardia")])
        self.check(head, seen, "ardia-ts.bin")

    def test_the_python_client_does_the_same(self):
        head, seen = self.start_session([str(self.install.python), "-I", "-m", "ardia_cli"])
        self.check(head, seen, "-m ardia_cli")


LONG_DATA_DIR = 94


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
        self.server.close()
        os.close(self.lock)


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
        found = subprocess.run(["lsof", "-t", *locks], capture_output=True, text=True).stdout.split()
        return sorted({int(pid) for pid in found} - {os.getpid()})

    def env(self, port: int) -> dict:
        return {**super().env(port), "ARDIA_DATA_DIR": str(self.long)}

    def test_plugin_browse_starts_and_reaches_its_daemon_under_a_long_data_dir(self):
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
        try:
            reached = server.asked.wait(30)
        finally:
            server.release.set()
            out, err = process.communicate(timeout=120)
        self.assertNotIn(b"daemon_unreachable", out)
        self.assertTrue(reached, (out, err))
        self.assertTrue(server.request.startswith(f"GET /devtools/browser/{BROWSER}?token={CREDENTIAL} ".encode()))

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

    def test_a_slow_stdin_writer_is_read_to_the_end_before_the_daemon_is_asked(self):
        daemon = self.live_daemon(request_wait=1.5)
        process = self.start(["browse", "eval", "--stdin"], self.plain_env(), stdin=subprocess.PIPE)
        time.sleep(3)
        process.stdin.write(b"1+1")
        process.stdin.close()
        out, err = process.communicate(timeout=60)
        self.assertEqual((process.returncode, out, err), (0, b"2\n", b""))
        self.assertEqual([request["stdin"] for request in daemon.requests], ["1+1"])

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
        for json_mode in (True, False):
            argv = [str(root / "bin" / "ardia"), "browse", "--session", "plugin-ai", *(["--json"] if json_mode else []), "get", "--", "title"]
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


if __name__ == "__main__":
    unittest.main()
