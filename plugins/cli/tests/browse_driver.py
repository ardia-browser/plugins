import json
import os
import re
import subprocess
import sys
import threading
from pathlib import Path

CLI = Path(__file__).resolve().parents[1]
SEEDED_CLIENT = CLI / "tests" / "m3" / "seeded_client.py"
HARNESS_ENV = ("ARDIA_BROWSE_DAEMON", "ARDIA_BROWSE_HARNESS", "ARDIA_M3_SEED", "ARDIA_M3_ANSWERS", "ARDIA_M3_TS_PROGRAM")
KEPT_ENV = ("PATH", "LANG", "LC_ALL", "TZ")


_ports: list[int] = []


def free_port() -> int:
    pinned = os.environ.get("ARDIA_BROWSE_TEST_PORTS")
    if pinned:
        low, _, high = pinned.partition("-")
        if not _ports:
            _ports.extend(range(int(low), int(high) + 1))
        return _ports.pop(0)
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def implementation() -> str:
    chosen = os.environ.get("ARDIA_BROWSE_DAEMON", "python")
    if chosen not in ("python", "ts"):
        raise RuntimeError(f"ARDIA_BROWSE_DAEMON is python or ts, not {chosen!r}")
    return chosen


def client_argv(chosen: str | None = None, seeded: bool | None = None) -> list[str]:
    chosen = chosen or implementation()
    if chosen == "ts":
        program = os.environ.get("ARDIA_M3_TS_PROGRAM")
        if not program:
            raise RuntimeError("ARDIA_BROWSE_DAEMON=ts needs ARDIA_M3_TS_PROGRAM, the built ardia-ts")
        return [program]
    if seeded or (seeded is None and os.environ.get("ARDIA_M3_SEED") is not None):
        return [sys.executable, "-I", str(SEEDED_CLIENT)]
    return [sys.executable, "-m", "ardia_cli"]


def isolated_env(home: Path, extra: dict | None = None) -> dict:
    env = {name: os.environ[name] for name in KEPT_ENV if name in os.environ}
    env.update({name: os.environ[name] for name in HARNESS_ENV if name in os.environ})
    tmp = home / "tmp"
    for folder in (home, tmp, home / "config", home / "cli", home / "xdg-config", home / "xdg-data", home / "xdg-cache"):
        folder.mkdir(parents=True, exist_ok=True)
    env.update({
        "HOME": str(home), "TMPDIR": str(tmp) + "/", "ARDIA_CONFIG_HOME": str(home / "config"), "ARDIA_CLI_HOME": str(home / "cli"),
        "XDG_CONFIG_HOME": str(home / "xdg-config"), "XDG_DATA_HOME": str(home / "xdg-data"), "XDG_CACHE_HOME": str(home / "xdg-cache"),
        "PYTHONPATH": str(CLI), "LANG": "en_US.UTF-8", "TZ": "UTC",
    })
    env.update(extra or {})
    return env


class Recorder:
    def __init__(self, folder: Path):
        self.folder = folder
        self.lock = threading.Lock()
        self.name: str | None = None
        self.prefix: list[dict] = []
        self.steps: list[dict] = []
        self.fixture: str | None = None
        self.source: str | None = None

    def begin_class(self, fixture: str):
        self.fixture = fixture
        self.prefix = []
        self.name = None

    def begin(self, test_id: str):
        self.flush()
        self.name = test_id
        self.source = test_id
        self.steps = []

    def templated(self, text: str) -> str:
        return text.replace(self.fixture, "{fixture}") if self.fixture else text

    def add(self, args, session, stdin, done):
        step = {"argv": [self.templated(str(arg)) for arg in args], "session": session}
        if stdin is not None:
            step["stdin"] = self.templated(stdin)
        step["seen"] = {"exit": done.returncode, "out": self.templated(done.stdout), "err": self.templated(done.stderr)}
        with self.lock:
            (self.steps if self.name else self.prefix).append(step)

    def flush(self):
        if not self.name or not self.steps:
            return
        group, _, test = self.name.rpartition(".")
        group = group.rpartition(".")[2]
        target = self.folder / re.sub(r"[^A-Za-z0-9_]+", "_", group) / f"{test}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        steps = [dict(step) for step in self.prefix + self.steps]
        target.write_text(json.dumps({"name": f"{group}/{test}", "source": self.source, "steps": steps}, indent=1, ensure_ascii=False) + "\n")
        self.steps = []


RECORDER = Recorder(Path(os.environ["ARDIA_BROWSE_HARNESS"])) if os.environ.get("ARDIA_BROWSE_HARNESS") else None


def begin_class(fixture: str):
    if RECORDER:
        RECORDER.begin_class(fixture)


def begin(test_id: str):
    if RECORDER:
        RECORDER.begin(test_id)


def end():
    if RECORDER:
        RECORDER.flush()


def browse(args, *, endpoint: list[str], data_dir: Path, session: str, env: dict | None = None, stdin: str | None = None,
           timeout: float = 120, cwd: Path | None = None, check: bool = True):
    argv = [*client_argv(), "browse", *endpoint, "--data-dir", str(data_dir), "--session", session, *[str(arg) for arg in args]]
    done = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=dict(os.environ, PYTHONPATH=str(CLI), **(env or {})), input=stdin,
                          cwd=cwd or CLI)
    if RECORDER:
        RECORDER.add(args, session, stdin, done)
    if check and done.returncode:
        raise AssertionError(f"ardia browse {' '.join(map(str, args))} exited {done.returncode}: {done.stderr}{done.stdout}")
    return done
