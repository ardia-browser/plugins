import gzip
import re
import hashlib
import json
import shutil
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from tests.m3 import compare, divergences, infra, normalize, protocol
from tests.m3.side import Fault, Run, Side


def scenario_paths(patterns: list[str]) -> list[Path]:
    found = []
    for pattern in patterns or ["**/*"]:
        direct = Path(pattern)
        if direct.suffix == ".json" and direct.exists():
            found.append(direct.resolve())
            continue
        found += sorted(infra.SCENARIOS.glob(pattern if pattern.endswith(".json") else f"{pattern}.json"))
    return list(dict.fromkeys(found))


def name_of(path: Path) -> str:
    return str(path.resolve().relative_to(infra.SCENARIOS)).removesuffix(".json")


def load(path: Path) -> dict:
    scenario = json.loads(path.read_text())
    scenario["name"] = name_of(path)
    return scenario


def seed_of(scenario: dict) -> int:
    return int(scenario.get("seed") or int(hashlib.sha256(scenario["name"].encode()).hexdigest()[:8], 16))


def recording(name: str) -> Path:
    return infra.TRANSCRIPTS / f"{name}.jsonl.gz"


def expectation(name: str) -> Path:
    return infra.TRANSCRIPTS / f"{name}.result.json.gz"


def expected_of(name: str, racy: list[int] | None = None, rewrite=None) -> dict:
    raw = json.loads(gzip.decompress(expectation(name).read_bytes()))
    return normalize.run(Run(root=Path(raw["subs"]["root"]), transcript=recording(name), steps=raw["steps"], files=raw["files"], subs=raw["subs"]), None, racy,
                         rewrite)


def checked_protocol(result: Run, label: str) -> list[str]:
    return [f"protocol {label}: {line}" for line in protocol.violations(result)]


def racy_of(scenario: dict) -> list[int] | None:
    return (scenario.get("racy_steps") or {}).get("steps")


def shaped_of(result: Run, scenario: dict, unstable: list[int] | None = None, fault: Fault | None = None) -> dict:
    return normalize.run(result, unstable, racy_of(scenario), divergences.rewriter(divergences.names_for(scenario, fault)))


def checked_rows(result: Run, impl: str, label: str, scenario: dict | None = None) -> list[str]:
    if divergences.daemon_of(impl) != "ts":
        return []
    console = divergences.captures_console((scenario or {}).get("steps"))
    return [f"transcript {label}: {line}" for line in divergences.checks(result.transcript, console)]


class Harness:
    def __init__(self, scratch: Path | None = None, keep: bool = False):
        self.scratch = Path(scratch or tempfile.mkdtemp(prefix="ardia-m3-"))
        self.keep = keep
        self.ports = infra.Ports()
        self.workers = max(1, self.ports.free.qsize())
        self.fixtures = None

    def __enter__(self):
        self.scratch.mkdir(parents=True, exist_ok=True)
        self.fixtures = infra.FixtureServer(self.ports.fixture).__enter__()
        return self

    def __exit__(self, *exc):
        self.fixtures.__exit__(*exc)
        if not self.keep:
            shutil.rmtree(self.scratch, ignore_errors=True)

    def side(self, scenario: dict, label: str, impl: str, replay: Path | None = None, fault: Fault | None = None):
        pair = self.ports.take()
        try:
            root = self.scratch / scenario["name"].replace("/", "__") / label
            return Side(scenario, root, impl, pair, self.fixtures.base, seed_of(scenario), replay, fault).run()
        finally:
            self.ports.give(pair)

    def twin(self, scenario: dict, a: str, b: str, fault: Fault | None = None, label: str = "live"):
        with ThreadPoolExecutor(2) as pool:
            first = pool.submit(self.side, scenario, f"{label}-A", a, None, fault)
            second = pool.submit(self.side, scenario, f"{label}-B", b, None, fault)
            return first.result(), second.result()

    def record(self, scenario: dict) -> dict:
        result = self.side(scenario, "record", "python")
        target = recording(scenario["name"])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(gzip.compress(result.transcript.read_bytes(), 9, mtime=0))
        shaped = normalize.run(result)
        raw = json.dumps({"steps": result.steps, "files": result.files, "subs": result.subs}, indent=1, ensure_ascii=False, sort_keys=True) + "\n"
        expectation(scenario["name"]).write_bytes(gzip.compress(raw.encode(), 9, mtime=0))
        return {"name": scenario["name"], "ok": True, "requests": sum(len(g) for s in shaped["requests"].values() for gs in s.values() for g in gs),
                "bytes": target.stat().st_size}

    def live(self, scenario: dict, a: str = "python", b: str = "python") -> dict:
        first, second = self.twin(scenario, a, b)
        unstable = (scenario.get("unstable_steps") or {}).get("steps")
        differences = compare.compared(shaped_of(first, scenario, unstable), shaped_of(second, scenario, unstable), compare.LIVE)
        differences += checked_protocol(first, "A") + checked_protocol(second, "B")
        differences += checked_rows(first, a, "A", scenario) + checked_rows(second, b, "B", scenario)
        return {"name": scenario["name"], "mode": f"live {a}/{b}", "ok": not differences, "differences": differences}

    def replay(self, scenario: dict, impl: str = "python") -> dict:
        name = scenario["name"]
        if scenario.get("live_only"):
            return {"name": name, "mode": f"replay {impl}", "ok": True, "skipped": scenario["live_only"]}
        if not recording(name).exists():
            return {"name": name, "mode": f"replay {impl}", "ok": False, "differences": ["no recording; run `record` first"]}
        result = self.side(scenario, f"replay-{impl}", impl, replay=recording(name))
        expected = expected_of(name, racy_of(scenario), divergences.rewriter(divergences.names_for(scenario)))
        differences = [f"tap: {failure}" for failure in result.tap.get("failures", [])]
        if result.tap.get("remaining"):
            differences.append(f"tap: {result.tap['remaining']} recorded request(s) never sent, first: {result.tap.get('remainingForms', [])[:2]}")
        differences += compare.compared(expected, shaped_of(result, scenario), compare.LIVE)
        differences += checked_protocol(result, impl)
        differences += checked_rows(result, impl, impl, scenario)
        return {"name": name, "mode": f"replay {impl}", "ok": not differences, "differences": differences}

    def request_points(self, scenario: dict) -> dict[int, list[tuple[str, int]]]:
        points: dict[int, list[tuple[str, int]]] = {}
        seen: dict[tuple[int, str], int] = {}
        step = None
        for entry in normalize.load(recording(scenario["name"])):
            if entry.get("k") == "mark":
                step = entry.get("step")
            elif entry.get("k") == "out" and isinstance(step, int):
                message = json.loads(entry["m"])
                if "id" in message and "method" in message:
                    key = (step, message["method"])
                    seen[key] = seen.get(key, 0) + 1
                    points.setdefault(step, []).append((message["method"], seen[key]))
        return points

    def faulted(self, scenario: dict, fault: Fault, a: str, b: str) -> dict:
        first, second = self.twin(scenario, a, b, fault, label=re.sub(r"[^A-Za-z0-9]+", "-", fault.label()))
        mode = f"{fault.label()} {a}/{b}"
        fired = [bool(side.steps[fault.step].get("fault_fired")) for side in (first, second)]
        if not all(fired):
            return {"name": scenario["name"], "mode": mode, "ok": True, "skipped": f"the fault point was reached on {sum(fired)} of 2 sides"}
        unstable = (scenario.get("unstable_steps") or {}).get("steps")
        shaped = [shaped_of(side, scenario, unstable, fault) for side in (first, second)]
        for found in shaped:
            for part in ("requests", "request_sets", "sources"):
                found[part].pop(str(fault.step), None)
        differences = compare.compared(shaped[0], shaped[1], compare.LIVE)
        differences += checked_protocol(first, "A") + checked_protocol(second, "B")
        differences += checked_rows(first, a, "A", scenario) + checked_rows(second, b, "B", scenario)
        return {"name": scenario["name"], "mode": mode, "ok": not differences, "differences": differences}

    def cancel(self, scenario: dict, a: str = "python", b: str = "python", kind: str = "interrupt", steps: list[int] | None = None) -> list[dict]:
        found = self.request_points(scenario)
        points = [Fault(step, nth, kind, method=method) for step, calls in sorted(found.items()) if steps is None or step in steps for method, nth in calls]
        with ThreadPoolExecutor(max(1, self.workers // 2)) as pool:
            return list(pool.map(lambda fault: self.faulted(scenario, fault, a, b), points))
