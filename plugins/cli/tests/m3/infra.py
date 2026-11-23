import json
import functools
import http.server
import os
import queue
import shutil
import signal
import socket
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

CLI = Path(__file__).resolve().parents[2]
M3 = CLI / "tests" / "m3"
FIXTURES = CLI / "tests" / "fixtures" / "browse"
TAP = CLI / "ts" / "tests" / "m3" / "tap.ts"
SCENARIOS = M3 / "scenarios"
TRANSCRIPTS = M3 / "transcripts"
AXE_VENDORED = CLI / "ts" / "vendor"
AXE_FOR_PYTHON = CLI / "ardia_cli" / "vendor" / "axe.min.js"


def vendor_axe_for_python() -> None:
    import hashlib

    manifest = json.loads((AXE_VENDORED / "axe.json").read_text())
    data = (AXE_VENDORED / "axe.min.js").read_bytes()
    if hashlib.sha256(data).hexdigest() != manifest["files"]["axe.min.js"]:
        raise RuntimeError("ts/vendor/axe.min.js doesn't match ts/vendor/axe.json")
    if AXE_FOR_PYTHON.exists() and AXE_FOR_PYTHON.read_bytes() == data:
        return
    AXE_FOR_PYTHON.parent.mkdir(exist_ok=True)
    AXE_FOR_PYTHON.write_bytes(data)
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))
CHROME_FLAGS = ["--headless", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
                "--disable-sync", "--disable-default-apps", "--mute-audio", "--hide-scrollbars", "--force-color-profile=srgb"]


DEFAULT_BASE = 9400
BLOCK = 20
RECORDED_FIXTURE = DEFAULT_BASE + BLOCK - 1


class PortsBusy(RuntimeError):
    pass


def port_base() -> int:
    if os.environ.get("ARDIA_M3_PORTS"):
        raise PortsBusy("ARDIA_M3_PORTS is gone: set ARDIA_M3_PORT_BASE to your block's first port (D3 9400, D4 9420, D5 9440, "
                        "F1-early 9460, reviewers 9500 and up); the block is that port and the 19 after it")
    text = os.environ.get("ARDIA_M3_PORT_BASE", str(DEFAULT_BASE))
    if not text.isdigit() or not 1024 <= int(text) <= 65535 - BLOCK:
        raise PortsBusy(f"ARDIA_M3_PORT_BASE must be a port from 1024 to {65535 - BLOCK}, not {text!r}")
    return int(text)


def port_range() -> tuple[int, int]:
    base = port_base()
    return base, base + BLOCK - 1


def bound(port: int) -> bool:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        probe.bind(("127.0.0.1", port))
    except OSError:
        return True
    finally:
        probe.close()
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
            return True
    except OSError:
        return False


def check_block(low: int, high: int):
    taken = [port for port in range(low, high + 1) if bound(port)]
    if taken:
        raise PortsBusy(f"ports {', '.join(map(str, taken))} of the block {low}-{high} are already bound (another agent's harness, or a run "
                        "of yours still going); refusing to start so no daemon talks to someone else's tap. Wait for it, or set "
                        "ARDIA_M3_PORT_BASE to your own block")


class Ports:
    def __init__(self):
        low, high = port_range()
        check_block(low, high)
        self.fixture = high
        self.free: queue.Queue = queue.Queue()
        for chrome in range(low, high - 2, 2):
            self.free.put((chrome, chrome + 1))

    def take(self) -> tuple[int, int]:
        return self.free.get(timeout=600)

    def give(self, pair: tuple[int, int]):
        self.free.put(pair)


def bun() -> str:
    found = shutil.which("bun") or str(Path.home() / ".bun" / "bin" / "bun")
    if not Path(found).exists():
        raise RuntimeError("bun is needed for the tap (tests/m3 runs it, it isn't shipped)")
    return found


def chrome_binary() -> str:
    found = os.environ.get("ARDIA_M3_CHROME")
    if not found or not Path(found).exists():
        raise RuntimeError("live mode needs ARDIA_M3_CHROME, a pinned chrome-headless-shell (docs/m3-harness.md)")
    return found


def answers(url: str) -> bool:
    try:
        with DIRECT.open(url, timeout=2) as response:
            return response.status == 200
    except OSError:
        return False


def wait_for(check, seconds: float, what: str):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.05)
    raise TimeoutError(f"timed out waiting for {what}")


def launch_chrome(port: int, profile: Path, window: tuple[int, int]) -> subprocess.Popen:
    profile.mkdir(parents=True, exist_ok=True)
    log = open(profile.parent / "chrome.log", "wb")
    process = subprocess.Popen([chrome_binary(), *CHROME_FLAGS, f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
                                f"--window-size={window[0]},{window[1]}", "about:blank"], stdout=log, stderr=log, start_new_session=True)
    log.close()
    try:
        wait_for(lambda: answers(f"http://127.0.0.1:{port}/json/version"), 30, f"Chromium on port {port}")
    except BaseException:
        stop(process)
        raise
    return process


def signal_group(process: subprocess.Popen, sig: int):
    try:
        os.killpg(process.pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


def stop(process: subprocess.Popen | None, grace: float = 5):
    if process is None:
        return
    signal_group(process, signal.SIGCONT)
    signal_group(process, signal.SIGTERM)
    try:
        process.wait(grace)
    except subprocess.TimeoutExpired:
        pass
    signal_group(process, signal.SIGKILL)
    try:
        process.wait(grace)
    except subprocess.TimeoutExpired:
        pass


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class FixtureServer:
    def __init__(self, port: int, root: Path = FIXTURES):
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(QuietHandler, directory=str(root)))
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.base = f"http://127.0.0.1:{port}"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()
