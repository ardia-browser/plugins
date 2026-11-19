import copy
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

CLI = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CLI))

from tests.m3 import compare, infra, linkrun, normalize, protocol, runner


def message(**fields) -> str:
    return json.dumps(fields)


def entries(*items) -> list[dict]:
    return [{"k": kind, "c": 0, "t": index, "m": text} if kind in ("in", "out") else {"k": kind, "step": text} for index, (kind, text) in enumerate(items)]


class Normalizer(unittest.TestCase):
    def shaped(self, items, subs=None):
        return normalize.transcript(entries(*items), normalize.Subs(subs or {}))[0]

    def test_browser_ids_become_placeholders_by_first_appearance(self):
        a = self.shaped([("mark", 0), ("out", message(id=1, method="Target.createTarget", params={"url": "about:blank"})),
                         ("in", message(id=1, result={"targetId": "AAAA1111"})), ("out", message(id=2, method="Target.attachToTarget", params={"targetId": "AAAA1111"}))])
        b = self.shaped([("mark", 0), ("out", message(id=7, method="Target.createTarget", params={"url": "about:blank"})),
                         ("in", message(id=7, result={"targetId": "BBBB2222"})), ("out", message(id=8, method="Target.attachToTarget", params={"targetId": "BBBB2222"}))])
        self.assertEqual(a, b)
        self.assertIn('"targetId":"<id#1>"', a["requests"]["0"]["0:browser"][1][0])

    def test_only_id_fields_are_masked(self):
        a = self.shaped([("mark", 0), ("out", message(id=1, method="Runtime.evaluate", params={"expression": "1", "contextId": 5}))])
        b = self.shaped([("mark", 0), ("out", message(id=1, method="Runtime.evaluate", params={"expression": "2", "contextId": 9}))])
        self.assertTrue(compare.compared(a, b, ("requests", "sources")))
        self.assertIn('"contextId":"<context#1>"', a["requests"]["0"]["0:browser"][0][0])

    def test_concurrent_requests_compare_as_a_multiset_and_groups_in_order(self):
        first, second = message(id=1, method="A.one", params={}), message(id=2, method="A.two", params={})
        later = message(id=3, method="A.three", params={})
        together = self.shaped([("mark", 0), ("out", first), ("out", second), ("in", message(id=1, result={})), ("in", message(id=2, result={})), ("out", later)])
        swapped = self.shaped([("mark", 0), ("out", second), ("out", first), ("in", message(id=2, result={})), ("in", message(id=1, result={})), ("out", later)])
        self.assertEqual(together, swapped)
        sequential = self.shaped([("mark", 0), ("out", first), ("in", message(id=1, result={})), ("out", second), ("in", message(id=2, result={})), ("out", later)])
        self.assertNotEqual(together, sequential)

    def test_scratch_and_ports_in_answers(self):
        subs = normalize.Subs({"root": "/tmp/run/A", "tap": 9401, "chrome": 9400})
        self.assertEqual(subs.text("saved to /tmp/run/A/home/x.png via --port 9401 and 127.0.0.1:9400/json, not 94011"),
                         "saved to <SCRATCH>/home/x.png via --port <TAP> and 127.0.0.1:<CHROME>/json, not 94011")

    def test_read_stamp_and_file_times(self):
        shaped = normalize.answer({"exit": 0, "out": "rows\n[read 2026-11-19 17:49:34 UTC]\n", "err": ""}, normalize.Subs({}), normalize.Ids(), {})
        self.assertEqual(shaped["out"], "rows\n[read <TIME>]\n")
        self.assertEqual(normalize.file_value({"pid": 4, "started": 1, "ids": {"x": [1, 1795110280.4]}, "next": 3}),
                         {"pid": "<PID>", "started": "<TIME>", "ids": {"x": [1, "<TIME>"]}, "next": 3})

    def test_every_rule_is_named(self):
        for rule in ("browser-ids", "message-id", "concurrency", "scratch", "ports", "ids-in-answers", "session-key", "tabs-file", "file-times",
                     "read-stamp", "metrics"):
            self.assertIn(rule, normalize.RULES)


def replayable() -> list[Path]:
    return [path for path in runner.scenario_paths([]) if runner.recording(runner.name_of(path)).exists() and not runner.load(path).get("live_only")]


@unittest.skipUnless(shutil.which("bun") or (Path.home() / ".bun" / "bin" / "bun").exists(), "the replay tap needs bun")
class Replay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scratch = Path(tempfile.mkdtemp(prefix="ardia-m3-test-"))
        cls.harness = runner.Harness(cls.scratch).__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.harness.__exit__(None, None, None)

    def test_every_recording_replays_identically_against_the_python_daemon(self):
        paths = replayable()
        self.assertGreaterEqual(len(paths), 10)
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(self.harness.workers) as pool:
            results = list(pool.map(lambda path: self.harness.replay(runner.load(path)), paths))
        failed = [result for result in results if not result["ok"]]
        self.assertEqual(failed, [], "\n".join(f"{result['name']}: {result['differences'][:3]}" for result in failed))

    def test_replay_catches_a_changed_scenario(self):
        scenario = runner.load(infra.SCENARIOS / "core" / "open_title.json")
        changed = copy.deepcopy(scenario)
        changed["steps"][1]["argv"] = ["get", "url"]
        result = self.harness.replay(changed)
        self.assertFalse(result["ok"])
        self.assertTrue(any("tap: unexpected request" in line or "answers" in line for line in result["differences"]), result["differences"])


def ts_program() -> str | None:
    found = os.environ.get("ARDIA_M3_TS_PROGRAM") or str(Path(__file__).resolve().parents[1] / "ts" / "dist" / "ardia-ts")
    return found if Path(found).exists() else None


@unittest.skipUnless(shutil.which("bun") or (Path.home() / ".bun" / "bin" / "bun").exists(), "the replay tap needs bun")
@unittest.skipUnless(ts_program(), "the TS daemon replays need the built ardia-ts")
class DaemonReplay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["ARDIA_M3_TS_PROGRAM"] = ts_program()
        cls.scratch = Path(tempfile.mkdtemp(prefix="ardia-m3-d2-"))
        cls.harness = runner.Harness(cls.scratch).__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.harness.__exit__(None, None, None)

    def test_every_daemon_recording_replays_identically_against_the_ts_daemon(self):
        paths = [path for path in replayable() if runner.name_of(path).startswith("daemon/")]
        self.assertGreaterEqual(len(paths), 4)
        failed = [result for result in (self.harness.replay(runner.load(path), "ts") for path in paths) if not result["ok"]]
        self.assertEqual(failed, [], "\n".join(f"{result['name']}: {result['differences'][:3]}" for result in failed))


class Protocol(unittest.TestCase):
    def test_every_recorded_request_and_answer_fits_the_schema(self):
        import gzip

        checked = 0
        for path in sorted(infra.TRANSCRIPTS.rglob("*.result.json.gz")):
            raw = json.loads(gzip.decompress(path.read_bytes()))
            for step in raw["steps"]:
                for item in step.get("answers") or []:
                    found = protocol.check("answer", item["answer"]) + (protocol.check("request", item["wire"]) if "wire" in item else [])
                    self.assertEqual(found, [], f"{path.name}: {found}")
                    checked += 1
        self.assertGreater(checked, 50)

    def test_the_schema_catches_a_bad_message(self):
        self.assertEqual(protocol.check("answer", {"exit": 0, "out": "", "err": "", "daemon": "ts/0.4.0"}), [])
        self.assertNotEqual(protocol.check("answer", {"exit": "0", "out": "", "err": ""}), [])
        self.assertNotEqual(protocol.check("answer", {"exit": 0, "out": "", "err": "", "code": "Not A Code"}), [])
        self.assertNotEqual(protocol.check("request", {"argv": ["open", 3]}), [])
        self.assertNotEqual(protocol.check("config", {"session": "s", "key": "../x", "data_root": "/tmp"}), [])
        self.assertEqual(protocol.check("config", {"session": "s", "key": "0" * 24, "data_root": "/tmp", "port": 9222, "harness_seed": 5}), [])


def link_replayable() -> list[str]:
    return [name for name in linkrun.names([]) if linkrun.recording(name).exists() and not linkrun.load(name).get("live_only")]


@unittest.skipUnless(shutil.which("bun") or (Path.home() / ".bun" / "bin" / "bun").exists(), "the replay tap needs bun")
class LinkReplay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.harness = linkrun.LinkHarness()

    @classmethod
    def tearDownClass(cls):
        cls.harness.close()

    def test_every_link_recording_replays_identically_against_both_implementations(self):
        names = link_replayable()
        self.assertGreaterEqual(len(names), 4)
        for impl in ("python", "ts"):
            failed = [result for result in (self.harness.replay(linkrun.load(name), impl) for name in names) if not result["ok"]]
            self.assertEqual(failed, [], "\n".join(f"{impl} {result['name']}: {result['differences'][:3]}" for result in failed))

    def test_link_replay_catches_a_changed_request(self):
        scenario = linkrun.load("round_trips")
        changed = copy.deepcopy(scenario)
        changed["ops"][4]["params"]["expression"] = "1+2"
        result = self.harness.replay(changed, "ts")
        self.assertFalse(result["ok"])
        self.assertTrue(any(line.startswith("tap: ") for line in result["differences"]), result["differences"])


if __name__ == "__main__":
    unittest.main()
