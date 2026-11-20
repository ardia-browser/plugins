import gzip
import json
import os
import shutil
import signal
import stat
import subprocess
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from tests import browse_driver
from tests.m3 import infra

STEP_TIMEOUT = 150


@dataclass
class Fault:
    step: int
    at: int
    kind: str
    seconds: float = 1
    code: int = 1011
    method: str | None = None

    def label(self) -> str:
        return f"{self.kind}@{self.step}:{self.method}#{self.at}" if self.method else f"{self.kind}@{self.step}:{self.at}"


@dataclass
class Run:
    root: Path
    transcript: Path
    steps: list = field(default_factory=list)
    files: dict = field(default_factory=dict)
    tap: dict = field(default_factory=dict)
    subs: dict = field(default_factory=dict)


def tap_call(port: int, path: str, body: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method="POST" if body is not None else "GET",
                                     headers={"content-type": "application/json"})
    with infra.DIRECT.open(request, timeout=10) as response:
        return json.loads(response.read())


def recorded_fixture(replay: Path) -> int:
    expected = replay.with_name(replay.name.removesuffix(".jsonl.gz") + ".result.json.gz")
    try:
        return int(json.loads(gzip.decompress(expected.read_bytes()))["subs"]["fixture"])
    except (OSError, ValueError, KeyError, TypeError):
        return infra.RECORDED_FIXTURE


def substitute(text: str, fixture: str, home: Path) -> str:
    return text.replace("{fixture_dir}", str(infra.FIXTURES)).replace("{fixture}", fixture).replace("{home}", str(home))


def browse_files(data: Path) -> dict:
    folder = data / "Browse"
    found = {}
    if not folder.is_dir():
        return found
    for path in sorted(folder.rglob("*")):
        relative = str(path.relative_to(folder))
        info = path.lstat()
        entry = {"mode": oct(stat.S_IMODE(info.st_mode)), "kind": "dir" if path.is_dir() else "sock" if stat.S_ISSOCK(info.st_mode) else "file"}
        if entry["kind"] == "file" and path.suffix == ".json":
            try:
                entry["json"] = json.loads(path.read_text())
            except (OSError, ValueError):
                entry["json"] = None
        found[relative] = entry
    return found


def daemon_pids(data: Path) -> list[int]:
    pids = []
    for path in (data / "Browse").glob("*.json"):
        try:
            pid = json.loads(path.read_text()).get("pid")
        except (OSError, ValueError, AttributeError):
            continue
        if isinstance(pid, int):
            pids.append(pid)
    return pids


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class Side:
    def __init__(self, scenario: dict, root: Path, impl: str, ports: tuple[int, int], fixture: str, seed: int,
                 replay: Path | None = None, fault: Fault | None = None):
        self.scenario = scenario
        self.root = root
        self.impl = impl
        self.chrome_port, self.tap_port = ports
        self.fixture = fixture
        self.fixture_port = int(fixture.rsplit(":", 1)[1].split("/", 1)[0])
        self.seed = seed
        self.replay = replay
        self.fault = fault
        self.chrome = None
        self.tap = None

    def start(self):
        if self.root.exists():
            shutil.rmtree(self.root)
        self.root.mkdir(parents=True)
        (self.root / "data").mkdir()
        tap_args = [infra.bun(), str(infra.TAP), "--listen", str(self.tap_port), "--out", str(self.root / "transcript.jsonl"), "--scratch", str(self.root)]
        if self.replay:
            tap_args += ["--replay", str(self.replay), "--pace", self.scenario.get("pace", "asap"),
                         "--fixture-from", str(recorded_fixture(Path(self.replay))), "--fixture-to", str(self.fixture_port)]
        else:
            window = tuple(self.scenario.get("window") or (1200, 900))
            self.chrome = infra.launch_chrome(self.chrome_port, self.root / "profile", window)
            tap_args += ["--upstream", str(self.chrome_port), "--chrome-pid", str(self.chrome.pid)]
        log = open(self.root / "tap.log", "wb")
        self.tap = subprocess.Popen(tap_args, stdout=subprocess.PIPE, stderr=log, start_new_session=True)
        log.close()
        line = self.tap.stdout.readline()
        if not line.startswith(b"{"):
            raise RuntimeError(f"the tap didn't start: {(self.root / 'tap.log').read_text()[-2000:]}")

    def client(self, step: dict) -> list[str]:
        argv = [substitute(arg, self.fixture, self.root / "home") for arg in step["argv"]]
        return [*browse_driver.client_argv(self.impl, seeded=True), "browse", "--port", str(self.tap_port), "--data-dir", str(self.root / "data"),
                "--session", step.get("session", "harness"), *argv]

    def env(self) -> dict:
        extra = {"ARDIA_BROWSE_DAEMON": browse_driver.daemon_of(self.impl), "ARDIA_M3_SEED": str(self.seed), "ARDIA_M3_ANSWERS": str(self.root / "answers.jsonl")}
        extra.update(self.scenario.get("env") or {})
        return browse_driver.isolated_env(self.root / "home", extra)

    def answers_since(self, count: int) -> list[dict]:
        path = self.root / "answers.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines()[count:]]

    def run_step(self, index: int, step: dict, env: dict) -> dict:
        tap_call(self.tap_port, "/tap/mark", {"step": index})
        fault = self.fault if self.fault and self.fault.step == index else None
        if fault:
            tap_call(self.tap_port, "/tap/fault", {"at": fault.at, "kind": "hold" if fault.kind == "interrupt" else fault.kind,
                                                   "seconds": fault.seconds, "code": fault.code, **({"method": fault.method} if fault.method else {})})
        before = len(self.answers_since(0))
        stdin = substitute(step["stdin"], self.fixture, self.root / "home") if step.get("stdin") is not None else None
        started = time.monotonic()
        process = subprocess.Popen(self.client(step), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                                   cwd=self.root / "home", text=True)
        interrupted = False
        if fault and fault.kind == "interrupt":
            if stdin is not None:
                process.stdin.write(stdin)
            process.stdin.close()
            process.stdin = None
            deadline = time.monotonic() + STEP_TIMEOUT
            while process.poll() is None and time.monotonic() < deadline:
                if tap_call(self.tap_port, "/tap/state").get("held"):
                    process.send_signal(signal.SIGINT)
                    interrupted = True
                    break
                time.sleep(0.01)
        try:
            out, err = process.communicate(None if process.stdin is None else stdin, timeout=STEP_TIMEOUT)
        except subprocess.TimeoutExpired:
            process.kill()
            out, err = process.communicate()
            err += "\n[harness: the step timed out]"
        if interrupted:
            time.sleep(0.2)
            tap_call(self.tap_port, "/tap/release", {})
            time.sleep(0.5)
        fired = None
        if fault:
            fired = bool(tap_call(self.tap_port, "/tap/state").get("fired"))
            tap_call(self.tap_port, "/tap/fault", {})
        return {"exit": process.returncode, "out": out, "err": err, "answers": self.answers_since(before), "interrupted": interrupted, "fault_fired": fired,
                "seconds": round(time.monotonic() - started, 3)}

    def teardown(self, env: dict) -> dict:
        tap_call(self.tap_port, "/tap/mark", {"step": "teardown"})
        done = subprocess.run(self.client({"argv": ["close", "--all"], "session": "harness"}), capture_output=True, text=True, env=env,
                              cwd=self.root / "home", timeout=60)
        data = self.root / "data"
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and any(alive(pid) for pid in daemon_pids(data)):
            time.sleep(0.05)
        for pid in daemon_pids(data):
            if alive(pid):
                os.kill(pid, signal.SIGKILL)
        return {"exit": done.returncode, "out": done.stdout, "err": done.stderr}

    def run(self) -> Run:
        result = Run(root=self.root, transcript=self.root / "transcript.jsonl")
        result.subs = {"root": str(self.root), "tap": self.tap_port, "chrome": self.chrome_port, "fixture": self.fixture_port,
                       "fixture_dir": str(infra.FIXTURES)}
        self.start()
        try:
            env = self.env()
            for index, step in enumerate(self.scenario["steps"]):
                result.steps.append(self.run_step(index, step, env))
            time.sleep(float(self.scenario.get("settle", 0)))
            result.files = browse_files(self.root / "data")
            result.steps.append({**self.teardown(env), "answers": [], "teardown": True})
            time.sleep(0.3)
            result.tap = tap_call(self.tap_port, "/tap/state")
        finally:
            self.close()
        (self.root / "result.json").write_text(json.dumps({"steps": result.steps, "files": result.files, "tap": result.tap, "subs": result.subs},
                                                          ensure_ascii=False, indent=1))
        return result

    def close(self):
        if self.tap and self.tap.stdout:
            self.tap.stdout.close()
        if self.tap and self.tap.poll() is None:
            try:
                tap_call(self.tap_port, "/tap/quit", {})
                self.tap.wait(5)
            except (OSError, subprocess.TimeoutExpired):
                infra.stop(self.tap)
        infra.stop(self.chrome)
        shutil.rmtree(self.root / "profile", ignore_errors=True)
