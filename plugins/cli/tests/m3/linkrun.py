"""The CDP link's differential harness (slice D1, docs/m3-harness.md "The CDP link").

  python -m tests.m3.linkrun record [scenario ...]               live Python run; writes link-transcripts/<name>.*.gz
  python -m tests.m3.linkrun replay [scenario ...] [--impl I]     answer the driver from the recording, no browser
  python -m tests.m3.linkrun live   [scenario ...] [--a I --b I]  twin headless Chromiums, one driver each, compared
  python -m tests.m3.linkrun list

Each scenario in tests/m3/link-scenarios is a list of ops that tests/m3/link_driver.py (Python's Browser and
Connection) and ts/tests/m3/link-driver.ts (browse/cdp/browser.ts and link.ts) both run through the tap.
I is python or ts. Live mode needs ARDIA_M3_CHROME; ports come from ARDIA_M3_PORT_BASE (a block of 20).
"""
import argparse
import gzip
import json
import shutil
import signal
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from tests.m3 import compare, infra, normalize
from tests.m3.side import tap_call

SCENARIOS = infra.M3 / "link-scenarios"
RECORDED = infra.M3 / "link-transcripts"
TS_DRIVER = infra.CLI / "ts" / "tests" / "m3" / "link-driver.ts"
PY_DRIVER = infra.M3 / "link_driver.py"
DRIVER_TIMEOUT = 600


def names(patterns: list[str]) -> list[str]:
    found = []
    for pattern in patterns or ["*"]:
        found += [path.stem for path in sorted(SCENARIOS.glob(f"{pattern}.json"))]
    return list(dict.fromkeys(found))


def load(name: str) -> dict:
    scenario = json.loads((SCENARIOS / f"{name}.json").read_text())
    scenario["name"] = name
    return scenario


def recording(name: str) -> Path:
    return RECORDED / f"{name}.jsonl.gz"


def outcome_file(name: str) -> Path:
    return RECORDED / f"{name}.result.json.gz"


def driver_argv(impl: str, url: str, script: Path, tap_port: int) -> list[str]:
    if impl == "python":
        return [sys.executable, "-I", str(PY_DRIVER), url, str(script), str(tap_port)]
    if impl == "ts":
        return [infra.bun(), str(TS_DRIVER), url, str(script), str(tap_port)]
    raise ValueError(f"unknown implementation {impl}")


def run_side(scenario: dict, root: Path, impl: str, ports: tuple[int, int], replay: Path | None = None) -> dict:
    chrome_port, tap_port = ports
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    script = root / "script.json"
    script.write_text(json.dumps({"ops": scenario["ops"]}))
    chrome = tap = None
    try:
        tap_args = [infra.bun(), str(infra.TAP), "--listen", str(tap_port), "--out", str(root / "transcript.jsonl"), "--scratch", str(root)]
        if replay:
            tap_args += ["--replay", str(replay), "--pace", scenario.get("pace", "asap")]
        else:
            chrome = infra.launch_chrome(chrome_port, root / "profile", (800, 600))
            tap_args += ["--upstream", str(chrome_port), "--chrome-pid", str(chrome.pid)]
        log = open(root / "tap.log", "wb")
        tap = subprocess.Popen(tap_args, stdout=subprocess.PIPE, stderr=log, start_new_session=True)
        log.close()
        if not tap.stdout.readline().startswith(b"{"):
            raise RuntimeError(f"the tap didn't start: {(root / 'tap.log').read_text()[-2000:]}")
        url = f"ws://127.0.0.1:{tap_port}/devtools/browser/tap"
        try:
            done = subprocess.run(driver_argv(impl, url, script, tap_port), capture_output=True, text=True, timeout=DRIVER_TIMEOUT, cwd=root)
            stdout, stderr, status = done.stdout, done.stderr, done.returncode
        except subprocess.TimeoutExpired as expired:
            stdout, stderr, status = "", f"{expired.stderr or ''}\n[harness: the driver timed out]", None
        lines = [line for line in stdout.split("\n") if line.startswith("[")]
        outcomes = json.loads(lines[-1]) if lines else None
        (root / "outcomes.json").write_text(json.dumps(outcomes, indent=1))
        state = tap_call(tap_port, "/tap/state")
    finally:
        if tap is not None:
            if tap.stdout:
                tap.stdout.close()
            if tap.poll() is None:
                try:
                    tap_call(tap_port, "/tap/quit", {})
                    tap.wait(5)
                except (OSError, subprocess.TimeoutExpired):
                    infra.stop(tap)
        infra.stop(chrome)
        shutil.rmtree(root / "profile", ignore_errors=True)
    return {"outcomes": outcomes, "status": status, "stderr": stderr[-4000:], "tap": state,
            "subs": {"root": str(root), "tap": tap_port, "chrome": chrome_port}, "transcript": str(root / "transcript.jsonl")}


def only_types(outcomes: list, indexes: list[int]) -> list:
    shaped = list(outcomes)
    for index in indexes:
        if index < len(shaped) and isinstance(shaped[index], dict) and "error" in shaped[index]:
            shaped[index] = {"error": {"type": shaped[index]["error"].get("type")}}
    return shaped


def normalized(run: dict, transcript: Path, scenario: dict) -> dict:
    subs = normalize.Subs(run["subs"])
    requests, ids = normalize.transcript(normalize.load(transcript), subs)
    outcomes = run["outcomes"]
    if outcomes is not None:
        outcomes = json.loads(ids.in_text(subs.text(json.dumps(ids.walk(outcomes), ensure_ascii=False))))
        outcomes = only_types(outcomes, scenario.get("type_only", []))
    return {"outcomes": outcomes, **requests}


class LinkHarness:
    def __init__(self, scratch: Path | None = None, keep: bool = False):
        self.scratch = Path(scratch or tempfile.mkdtemp(prefix="ardia-m3-link-"))
        self.keep = keep
        self.ports = infra.Ports()

    def side(self, scenario: dict, label: str, impl: str, replay: Path | None = None) -> dict:
        pair = self.ports.take()
        try:
            return run_side(scenario, self.scratch / scenario["name"] / label, impl, pair, replay)
        finally:
            self.ports.give(pair)

    def record(self, scenario: dict) -> dict:
        run = self.side(scenario, "record", "python")
        if run["outcomes"] is None or run["status"] != 0:
            return {"name": scenario["name"], "ok": False, "differences": [f"the Python driver failed: {run['stderr'][-800:]}"]}
        RECORDED.mkdir(parents=True, exist_ok=True)
        recording(scenario["name"]).write_bytes(gzip.compress(Path(run["transcript"]).read_bytes(), 9, mtime=0))
        outcome_file(scenario["name"]).write_bytes(gzip.compress(json.dumps({"outcomes": run["outcomes"], "subs": run["subs"]}).encode(), 9, mtime=0))
        return {"name": scenario["name"], "ok": True, "mode": "record"}

    def expected(self, scenario: dict) -> dict:
        raw = json.loads(gzip.decompress(outcome_file(scenario["name"]).read_bytes()))
        return normalized(raw, recording(scenario["name"]), scenario)

    def replay(self, scenario: dict, impl: str = "ts") -> dict:
        name = scenario["name"]
        run = self.side(scenario, f"replay-{impl}", impl, recording(name))
        found = []
        if run["status"] != 0 or run["outcomes"] is None:
            found.append(f"{impl} driver exited {run['status']}: {run['stderr'][-800:]}")
        found += [f"tap: {failure}" for failure in run["tap"].get("failures", [])]
        if run["tap"].get("remaining"):
            found.append(f"tap: {run['tap']['remaining']} recorded requests never sent, first {run['tap'].get('remainingForms')}")
        if run["outcomes"] is not None:
            found += compare.compared(self.expected(scenario), normalized(run, Path(run["transcript"]), scenario), ("outcomes", "requests", "sources"))
        self.cleanup(scenario)
        return {"name": name, "mode": f"replay {impl}", "ok": not found, "differences": found}

    def live(self, scenario: dict, a: str = "python", b: str = "ts") -> dict:
        with ThreadPoolExecutor(2) as pool:
            runs = list(pool.map(lambda pair: self.side(scenario, pair[0], pair[1]), (("a-" + a, a), ("b-" + b, b))))
        found = []
        for label, run in zip((a, b), runs):
            if run["status"] != 0 or run["outcomes"] is None:
                found.append(f"{label} driver exited {run['status']}: {run['stderr'][-800:]}")
        if not found:
            shaped = [normalized(run, Path(run["transcript"]), scenario) for run in runs]
            found += compare.compared(shaped[0], shaped[1], ("outcomes", "request_sets", "sources"))
            expect = scenario.get("expect")
            if expect is not None:
                found += [f"expected {line}" for line in compare.diff(expect, shaped[1]["outcomes"], "outcomes")]
        self.cleanup(scenario)
        return {"name": scenario["name"], "mode": f"live {a}/{b}", "ok": not found, "differences": found}

    def cleanup(self, scenario: dict):
        if not self.keep:
            shutil.rmtree(self.scratch / scenario["name"], ignore_errors=True)

    def close(self):
        if not self.keep:
            shutil.rmtree(self.scratch, ignore_errors=True)


def interrupted(*_):
    raise KeyboardInterrupt


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m tests.m3.linkrun", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=("record", "replay", "live", "list"))
    parser.add_argument("scenarios", nargs="*")
    parser.add_argument("--impl", default="ts")
    parser.add_argument("--a", default="python")
    parser.add_argument("--b", default="ts")
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--scratch")
    args = parser.parse_args(argv)
    signal.signal(signal.SIGTERM, interrupted)
    chosen = names(args.scenarios)
    if args.mode == "list":
        for name in chosen:
            print(name + (f"  (live only: {load(name)['live_only']})" if load(name).get("live_only") else ""))
        return 0
    harness = LinkHarness(Path(args.scratch) if args.scratch else None, args.keep)
    results = []
    try:
        for name in chosen:
            scenario = load(name)
            if args.mode == "record":
                results.append(harness.record(scenario))
            elif args.mode == "replay":
                if scenario.get("live_only"):
                    results.append({"name": name, "mode": "replay", "ok": True, "skipped": scenario["live_only"]})
                    continue
                results.append(harness.replay(scenario, args.impl))
            else:
                results.append(harness.live(scenario, args.a, args.b))
    finally:
        harness.close()
    failed = [result for result in results if not result["ok"]]
    for result in results:
        mark = "ok  " if result["ok"] else "FAIL"
        extra = f" (skipped: {result['skipped']})" if result.get("skipped") else ""
        print(f"{mark} {result.get('mode', '')}: {result['name']}{extra}")
        for line in result.get("differences", [])[:20]:
            print(f"       {line}")
    print(f"{len(results) - len(failed)} of {len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
