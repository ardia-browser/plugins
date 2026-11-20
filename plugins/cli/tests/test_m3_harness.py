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

from tests.m3 import compare, divergences, infra, linkrun, normalize, protocol, runner


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

    def test_the_fixture_folder_reads_the_same_from_any_checkout(self):
        here = normalize.Subs({"root": "/tmp/run/A", "fixture_dir": "/clone/one/tests/fixtures/browse"})
        there = normalize.Subs({"root": "/tmp/run/B", "fixture_dir": "/clone/two/tests/fixtures/browse"})
        said = "[Errno 2] No such file or directory: '{}/no-such-script.js'"
        self.assertEqual(here.text(said.format("/clone/one/tests/fixtures/browse")), there.text(said.format("/clone/two/tests/fixtures/browse")))
        self.assertEqual(here.text("/clone/two/tests/fixtures/browse/x"), "/clone/two/tests/fixtures/browse/x")

    def test_a_temporary_tab_nonce_is_dropped_only_from_create_target(self):
        made = {"method": "Target.createTarget", "params": {"url": "about:blank#ardia-temp-0a1b", "background": True}}
        self.assertEqual(normalize.without_temp_nonce(made)["params"], {"url": "about:blank", "background": True})
        other = {"method": "Page.navigate", "params": {"url": "about:blank#ardia-temp-0a1b"}}
        self.assertIs(normalize.without_temp_nonce(other), other)
        plain = {"method": "Target.createTarget", "params": {"url": "about:blank#elsewhere"}}
        self.assertIs(normalize.without_temp_nonce(plain), plain)

    def test_every_rule_is_named(self):
        for rule in ("browser-ids", "message-id", "concurrency", "scratch", "ports", "ids-in-answers", "session-key", "tabs-file", "file-times",
                     "read-stamp", "metrics", "racy-steps", "divergences"):
            self.assertIn(rule, normalize.RULES)

    def test_racy_steps_keep_only_the_exit_status(self):
        steps = [{"exit": 1, "out": "", "err": "✗ one\n", "answers": [{"answer": {"code": "navigation_failed", "exit": 1}}]},
                 {"exit": 0, "out": "x\n", "err": "", "answers": []}]
        result = runner.Run(root=Path("/tmp/none"), transcript=Path("/dev/null"), steps=steps, files={}, subs={})
        shaped = normalize.run(result, None, [0])
        self.assertEqual(shaped["answers"][0], {"exit": 1, "err": "<racy>", "out": "<racy>", "answers": "<racy>"})
        self.assertEqual(shaped["answers"][1]["out"], "x\n")


class PortBlocks(unittest.TestCase):
    def setUp(self):
        self.saved = {name: os.environ.get(name) for name in ("ARDIA_M3_PORT_BASE", "ARDIA_M3_PORTS")}

    def tearDown(self):
        for name, value in self.saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    def test_the_block_follows_the_base(self):
        os.environ.pop("ARDIA_M3_PORTS", None)
        os.environ["ARDIA_M3_PORT_BASE"] = "9440"
        self.assertEqual(infra.port_range(), (9440, 9459))
        os.environ.pop("ARDIA_M3_PORT_BASE")
        self.assertEqual(infra.port_range(), (9400, 9419))
        for bad in ("94x0", "80", "65530"):
            os.environ["ARDIA_M3_PORT_BASE"] = bad
            with self.assertRaises(infra.PortsBusy):
                infra.port_base()

    def test_the_old_range_variable_is_refused(self):
        os.environ["ARDIA_M3_PORTS"] = "9400-9419"
        with self.assertRaises(infra.PortsBusy):
            infra.port_range()

    def test_a_bound_port_in_the_block_stops_the_run_before_anything_starts(self):
        import socket

        holder = socket.socket()
        holder.bind(("127.0.0.1", 0))
        holder.listen()
        port = holder.getsockname()[1]
        try:
            with self.assertRaises(infra.PortsBusy) as caught:
                infra.check_block(port - 3, port + 2)
            self.assertIn(str(port), str(caught.exception))
        finally:
            holder.close()

    def test_a_replay_tap_rewrites_the_recorded_fixture_port(self):
        self.assertEqual(normalize.Subs({"fixture": 9459}).text("http://127.0.0.1:9459/login.html and localhost:9459"),
                         "http://127.0.0.1:<FIXTURE>/login.html and localhost:<FIXTURE>")
        self.assertEqual(normalize.Subs({}).text("http://127.0.0.1:9419/x"), "http://127.0.0.1:<FIXTURE>/x")


class Divergences(unittest.TestCase):
    def shaped(self, items, names=None):
        rewrite = divergences.rewriter(names) if names is not None else None
        return normalize.transcript(entries(*items), normalize.Subs({}), rewrite)[0]

    def test_the_busy_probe_compares_equal_across_worlds_only_when_the_scenario_names_it(self):
        python = [("mark", 3), ("out", message(id=1, method="Runtime.evaluate", sessionId="S", params={"expression": "1", "returnByValue": True}))]
        ts = [("mark", 3), ("out", message(id=4, method="Runtime.evaluate", sessionId="S", params={"expression": "1", "contextId": 2, "returnByValue": True}))]
        self.assertTrue(compare.compared(self.shaped(python), self.shaped(ts), compare.LIVE))
        named = divergences.names_for({"divergences": ["busy-probe-isolated"]})
        self.assertEqual(compare.compared(self.shaped(python, named), self.shaped(ts, named), compare.LIVE), [])
        other = [("mark", 3), ("out", message(id=4, method="Runtime.evaluate", sessionId="S", params={"expression": "2", "contextId": 2}))]
        self.assertTrue(compare.compared(self.shaped(python, named), self.shaped(other, named), compare.LIVE))
        with self.assertRaises(ValueError):
            divergences.names_for({"divergences": ["no-such-divergence"]})

    def test_world_handles_compare_with_python_context_ids_without_shifting_other_ids(self):
        call = {"functionDeclaration": "() => document.title", "arguments": [], "returnByValue": True, "awaitPromise": True}
        python = [("mark", 1), ("out", message(id=1, method="Runtime.callFunctionOn", sessionId="SESSION-A", params={**call, "executionContextId": 5})),
                  ("in", message(id=1, result={})), ("out", message(id=2, method="DOM.describeNode", sessionId="SESSION-A", params={"objectId": "NODE-1"}))]
        ts = [("mark", 1), ("out", message(id=7, method="Runtime.evaluate", sessionId="SESSION-B", params={"expression": "globalThis", "contextId": 5, "returnByValue": False})),
              ("in", message(id=7, result={"result": {"objectId": "HANDLE-XYZ"}})),
              ("out", message(id=10, method="Page.getFrameTree", sessionId="SESSION-B", params={})),
              ("in", message(id=10, result={})),
              ("out", message(id=8, method="Runtime.callFunctionOn", sessionId="SESSION-B", params={**call, "objectId": "HANDLE-XYZ"})),
              ("in", message(id=8, result={})), ("out", message(id=9, method="DOM.describeNode", sessionId="SESSION-B", params={"objectId": "NODE-2"}))]
        names = divergences.names_for({})
        self.assertEqual(names, ["world-handle"])
        self.assertTrue(compare.compared(self.shaped(python, []), self.shaped(ts, []), compare.LIVE))
        self.assertEqual(compare.compared(self.shaped(python, names), self.shaped(ts, names), compare.LIVE), [])

    def test_only_world_handles_lose_their_object_id(self):
        call = {"functionDeclaration": "function () { return this.go(); }", "arguments": [], "returnByValue": True, "awaitPromise": True}
        python = [("mark", 2), ("out", message(id=1, method="Runtime.callFunctionOn", sessionId="S", params={**call, "objectId": "CONTROLLER-1"}))]
        aimed_wrong = [("mark", 2), ("out", message(id=7, method="Runtime.evaluate", sessionId="S", params={"expression": "globalThis", "contextId": 5, "returnByValue": False})),
                       ("in", message(id=7, result={"result": {"objectId": "HANDLE-1"}})),
                       ("out", message(id=8, method="Runtime.callFunctionOn", sessionId="S", params={**call, "objectId": "HANDLE-1"}))]
        aimed_right = [("mark", 2), ("out", message(id=8, method="Runtime.callFunctionOn", sessionId="S", params={**call, "objectId": "CONTROLLER-9"}))]
        names = divergences.names_for({})
        self.assertTrue(compare.compared(self.shaped(python, names), self.shaped(aimed_wrong, names), compare.LIVE))
        self.assertEqual(compare.compared(self.shaped(python, names), self.shaped(aimed_right, names), compare.LIVE), [])

    def test_every_divergence_names_its_row(self):
        for name, entry in divergences.DIVERGENCES.items():
            self.assertIsInstance(entry.get("row"), int, name)

    def test_the_transcript_check_finds_page_session_enables_and_a_main_world_probe(self):
        folder = Path(tempfile.mkdtemp(prefix="ardia-m3-div-"))
        try:
            path = folder / "t.jsonl"
            lines = [{"k": "out", "m": message(id=1, method="Runtime.enable", sessionId="S")},
                     {"k": "out", "m": message(id=2, method="Runtime.enable")},
                     {"k": "out", "m": message(id=3, method="Debugger.enable", sessionId="S")},
                     {"k": "out", "m": message(id=4, method="Runtime.evaluate", sessionId="T", params={"expression": "1"})},
                     {"k": "out", "m": message(id=5, method="Page.createIsolatedWorld", sessionId="S", params={"frameId": "F"})},
                     {"k": "out", "m": message(id=6, method="Runtime.evaluate", sessionId="S", params={"expression": "1"})},
                     {"k": "out", "m": message(id=7, method="Runtime.evaluate", sessionId="S", params={"expression": "1", "contextId": 3})},
                     {"k": "out", "m": message(id=8, method="Runtime.callFunctionOn", sessionId="S", params={"executionContextId": 3})},
                     {"k": "out", "m": message(id=9, method="Runtime.evaluate", sessionId="S", params={"expression": "globalThis", "contextId": 3, "returnByValue": False})},
                     {"k": "out", "m": message(id=10, method="Runtime.callFunctionOn", sessionId="S", params={"objectId": "H"})}]
            path.write_text("".join(json.dumps(line) + "\n" for line in lines))
            self.assertEqual(divergences.checks(path), ["a page call named a numeric execution context instead of its world handle",
                                                        "a world handle was used before its loader was checked by Page.getFrameTree",
                                                        "row 8: Debugger.enable sent on a page session", "row 8: Runtime.enable sent on a page session",
                                                        "row 8: the busy probe ran in the page's main world though the page had an isolated world"])
        finally:
            shutil.rmtree(folder, ignore_errors=True)


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


LATER_SLICES = {"core/open_title": "its `open` reports changes (D5) and it runs `snapshot` (D4)"}


@unittest.skipUnless(shutil.which("bun") or (Path.home() / ".bun" / "bin" / "bun").exists(), "the replay tap needs bun")
class ReplayInAnotherBlock(unittest.TestCase):
    RECORDED_BASE = 9620
    REPLAY_BASE = 9980

    def setUp(self):
        self.scratch = Path(tempfile.mkdtemp(prefix="ardia-m3-blocks-"))
        self.saved = (infra.TRANSCRIPTS, os.environ.get("ARDIA_M3_PORT_BASE"))

    def tearDown(self):
        infra.TRANSCRIPTS = self.saved[0]
        if self.saved[1] is None:
            os.environ.pop("ARDIA_M3_PORT_BASE", None)
        else:
            os.environ["ARDIA_M3_PORT_BASE"] = self.saved[1]
        shutil.rmtree(self.scratch, ignore_errors=True)

    def moved(self, name: str, fixture: int) -> Path:
        import gzip
        import re

        folder = self.scratch / "transcripts"
        port = re.compile(rf"(?<=(127\.0\.0\.1|localhost):){infra.RECORDED_FIXTURE}\b")
        for suffix in (".jsonl.gz", ".result.json.gz"):
            source = infra.TRANSCRIPTS / f"{name}{suffix}"
            text = port.sub(str(fixture), gzip.decompress(source.read_bytes()).decode("utf-8"))
            if suffix == ".result.json.gz":
                raw = json.loads(text)
                raw["subs"]["fixture"] = fixture
                text = json.dumps(raw)
            target = folder / f"{name}{suffix}"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(gzip.compress(text.encode("utf-8"), 9, mtime=0))
        return folder

    def test_a_recording_made_in_another_block_replays_in_a_third(self):
        fixture = self.RECORDED_BASE + infra.BLOCK - 1
        self.assertNotIn(fixture, (infra.RECORDED_FIXTURE, self.REPLAY_BASE + infra.BLOCK - 1))
        infra.TRANSCRIPTS = self.moved("daemon/waits", fixture)
        from tests.m3 import side

        self.assertEqual(side.recorded_fixture(runner.recording("daemon/waits")), fixture)
        os.environ["ARDIA_M3_PORT_BASE"] = str(self.REPLAY_BASE)
        with runner.Harness(self.scratch / "run") as harness:
            result = harness.replay(runner.load(infra.SCENARIOS / "daemon" / "waits.json"), "python")
        self.assertTrue(result["ok"], result.get("differences"))

    def test_a_recording_without_a_stored_fixture_port_is_read_as_9419(self):
        from tests.m3 import side

        self.assertEqual(side.recorded_fixture(self.scratch / "nothing.jsonl.gz"), infra.RECORDED_FIXTURE)


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
        paths = [path for path in replayable() if runner.name_of(path).startswith(("daemon/", "core/")) and runner.name_of(path) not in LATER_SLICES]
        self.assertGreaterEqual(len(paths), 7)
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
