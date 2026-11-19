import functools
import http.server
import os
import queue
import shutil
import signal
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
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))
CHROME_FLAGS = ["--headless", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
                "--disable-sync", "--disable-default-apps", "--mute-audio", "--hide-scrollbars", "--force-color-profile=srgb"]


def port_range() -> tuple[int, int]:
    low, _, high = os.environ.get("ARDIA_M3_PORTS", "9400-9419").partition("-")
    return int(low), int(high)


class Ports:
    def __init__(self):
        low, high = port_range()
        self.fixture = high
        self.free: queue.Queue = queue.Queue()
        for chrome in range(low, high - 1, 2):
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
