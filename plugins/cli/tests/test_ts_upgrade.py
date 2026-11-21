import json
import os
import shutil
import socket
import subprocess
import tarfile
import io
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path

CLI = Path(__file__).resolve().parent.parent
REPO = CLI.parent.parent
TS = Path(os.environ.get("ARDIA_TS_CLI") or CLI / "ts" / "dist" / "ardia-ts")
CHROME = os.environ.get("ARDIA_M3_CHROME")
PYTHON = os.environ.get("ARDIA_UPGRADE_PYTHON") or shutil.which("python3")
PORT = int(os.environ.get("ARDIA_M3_PORT_BASE", "9640")) + 7
OLD_TAG = "cli-v0.4.0"
IDLE_END = 50


def old_cli(into: Path) -> Path:
    archive = subprocess.run(["git", "-C", str(REPO), "archive", OLD_TAG, "plugins/cli/ardia_cli"], capture_output=True, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(into, filter="data")
    return into / "plugins" / "cli"


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def wait_for(check, seconds: float) -> bool:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return True
        time.sleep(0.1)
    return check()


class Relay:
    def __init__(self, path: Path, target: Path):
        self.connections = 0
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(str(path))
        os.chmod(path, 0o600)
        self.server.listen(8)
        self.target = target
        self.sockets = []
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        while True:
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            self.connections += 1
            upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sockets += [client, upstream]
            upstream.connect(str(self.target))
            for a, b in ((client, upstream), (upstream, client)):
                threading.Thread(target=self.pipe, args=(a, b), daemon=True).start()

    @staticmethod
    def pipe(source, sink):
        try:
            while data := source.recv(65536):
                sink.sendall(data)
        except OSError:
            pass
        finally:
            for end in (source, sink):
                try:
                    end.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def close(self):
        self.server.close()
        for end in self.sockets:
            end.close()


@unittest.skipUnless(CHROME and TS.exists() and PYTHON, "needs ARDIA_M3_CHROME, a built ts/dist/ardia-ts and python3")
class UpgradeFromPython(unittest.TestCase):
    def setUp(self):
        self.box = Path(tempfile.mkdtemp(prefix="au-", dir="/tmp")).resolve()
        self.addCleanup(shutil.rmtree, self.box, True)
        self.data = self.box / "data"
        self.data.mkdir(mode=0o700)
        self.old = old_cli(self.box / "old")
        self.chrome = subprocess.Popen([CHROME, f"--remote-debugging-port={PORT}", f"--user-data-dir={self.box / 'chrome'}", "about:blank"],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(self.stop_chrome)
        self.assertTrue(wait_for(self.devtools_up, 15), "headless Chrome never answered")
        self.addCleanup(self.stop_daemons)

    def devtools_up(self) -> bool:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=1) as reply:
                self.version = json.load(reply)
            return True
        except OSError:
            return False

    def stop_chrome(self):
        if self.chrome.poll() is None:
            self.chrome.kill()
        self.chrome.wait(10)

    def daemons(self) -> dict:
        found = {}
        for entry in (self.data / "Browse").glob("*.json"):
            meta = json.loads(entry.read_text())
            if "pid" in meta and alive(int(meta["pid"])):
                found[entry.stem] = meta
        return found

    def stop_daemons(self):
        for meta in self.daemons().values():
            try:
                os.kill(int(meta["pid"]), 15)
            except ProcessLookupError:
                pass

    def env(self, **extra) -> dict:
        return {"PATH": "/usr/bin:/bin", "HOME": str(self.box), "LANG": "en_US.UTF-8", "ARDIA_DATA_DIR": str(self.data), "ARDIA_TELEMETRY": "0",
                "TMPDIR": str(self.box), **extra}

    def old_client(self, *argv, **extra) -> subprocess.CompletedProcess:
        return subprocess.run([PYTHON, "-m", "ardia_cli", *argv], env=self.env(PYTHONPATH=str(self.old), **extra), capture_output=True, text=True, timeout=60)

    def new_client(self, *argv, **extra) -> subprocess.CompletedProcess:
        return subprocess.run([str(TS), *argv], env=self.env(**extra), capture_output=True, text=True, timeout=60)

    def test_the_typescript_client_starts_its_own_daemon_and_never_talks_to_the_old_one(self):
        opened = self.old_client("browse", "--port", str(PORT), "open", "about:blank", AGENT_BROWSER_IDLE_TIMEOUT_MS="2000")
        self.assertEqual(opened.returncode, 0, opened.stderr)
        [(old_key, old_meta)] = self.daemons().items()
        self.assertNotIn("build", old_meta)
        browse = self.data / "Browse"
        os.rename(browse / f"{old_key}.sock", browse / f"{old_key}.real")
        relay = Relay(browse / f"{old_key}.sock", browse / f"{old_key}.real")
        self.addCleanup(relay.close)
        self.assertEqual(self.old_client("browse", "--port", str(PORT), "get", "url").returncode, 0)
        through_old = relay.connections
        self.assertGreater(through_old, 0, "the relay must carry the old client's calls")
        new = self.new_client("browse", "--port", str(PORT), "open", "about:blank")
        self.assertEqual(new.returncode, 0, new.stderr)
        self.assertEqual(relay.connections, through_old, "the TypeScript client connected to the 0.4.0 daemon")
        daemons = self.daemons()
        new_keys = [key for key in daemons if key != old_key]
        self.assertEqual(len(new_keys), 1)
        self.assertTrue(daemons[new_keys[0]].get("build"))
        self.assertIn("ardia-ts", subprocess.run(["ps", "-o", "command=", "-p", str(daemons[new_keys[0]]["pid"])], capture_output=True, text=True).stdout)
        self.assertTrue(alive(int(old_meta["pid"])), "the old daemon is left alone, not killed")
        self.assertTrue(wait_for(lambda: not alive(int(old_meta["pid"])), IDLE_END), "the 0.4.0 daemon never idled out")

    def test_the_typescript_daemon_disconnects_when_idle_then_ends_on_its_idle_timeout(self):
        new = self.new_client("browse", "--port", str(PORT), "open", "about:blank", AGENT_BROWSER_IDLE_TIMEOUT_MS="2000")
        self.assertEqual(new.returncode, 0, new.stderr)
        [meta] = self.daemons().values()
        self.assertTrue(wait_for(lambda: not alive(int(meta["pid"])), IDLE_END), "the TypeScript daemon outlived its idle timeout")

    def test_the_typescript_daemon_ends_when_ardia_quits(self):
        control = self.data / "Chromium" / "ArdiaControl.json"
        control.parent.mkdir(mode=0o700)
        browser = "/" + self.version["webSocketDebuggerUrl"].split("/", 3)[3]
        control.write_text(json.dumps({"port": PORT, "browser": browser, "token": "t" * 32, "pid": self.chrome.pid}))
        os.chmod(control, 0o600)
        new = self.new_client("browse", "open", "about:blank")
        self.assertEqual(new.returncode, 0, new.stderr)
        [meta] = self.daemons().values()
        self.stop_chrome()
        self.assertTrue(wait_for(lambda: not alive(int(meta["pid"])), 15), "the TypeScript daemon kept running after Ardia quit")


if __name__ == "__main__":
    unittest.main()
