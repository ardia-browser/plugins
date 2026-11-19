import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
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
        return sorted({int(pid) for pid in found})

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
    def __init__(self, browse: Path, key: str, reply: dict):
        here = os.open(".", os.O_RDONLY)
        browse.mkdir(mode=0o700, parents=True, exist_ok=True)
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
            with connection, connection.makefile("rb") as lines:
                self.requests.append(json.loads(lines.readline()))
                connection.sendall(json.dumps(self.reply).encode() + b"\n")

    def close(self):
        self.server.close()


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
        return sorted({int(pid) for pid in found})

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


if __name__ == "__main__":
    unittest.main()
