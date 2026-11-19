import base64
import json
import os
import re
import select
import shutil
import socket
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from parity import harness

CLI = harness.CLI
INSTALL_ID = harness.INSTALL_ID
KEPT_ENV = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "USER", "LOGNAME", "SHELL")
binary = harness.binary
both_programs = lambda: binary() and harness.ts_binary()


def FakeArdia(path: Path, replies: dict):
    replies = dict(replies)
    return harness.FakeArdia(path, replies.pop("hello", harness.DEFAULT_HELLO), replies, [])


class ParityTable:
    entry = "rust"

    @classmethod
    def setUpClass(cls):
        cls.outcomes, cls.install = harness.run_all(harness.load_cases(), harness.entry_binary(cls.entry), entry=cls.entry)
        cls.summary = harness.summarize(cls.outcomes, harness.served_commands())

    @classmethod
    def tearDownClass(cls):
        cls.install.close()

    def test_every_case_matches(self):
        failed = [outcome.report() for outcome in self.outcomes if not outcome.passed]
        self.assertFalse(failed, f"{len(failed)} of {len(self.outcomes)} parity cases differ:\n" + "\n".join(failed))

    def test_it_serves_only_proven_commands(self):
        if self.entry == "ts" and not harness.TS_CAN_LOCK:
            self.skipTest("TypeScript hands every command back where it can't take Python's flock, so nothing is proven native here")
        self.assertEqual(self.summary["unproven_but_served"], [], "served.txt lists commands without passing parity cases")

    def test_the_table_has_each_served_command_at_least_once(self):
        for name in harness.served_commands():
            self.assertGreater(self.summary["commands"][name]["cases"], 0, name)


@unittest.skipUnless(binary(), "build plugins/cli/rust first (cargo build) or set ARDIA_RUST_CLI")
class RustParityTable(ParityTable, unittest.TestCase):
    entry = "rust"


@unittest.skipUnless(both_programs(), "build plugins/cli/rust (the router) and plugins/cli/ts (bun run build), or set ARDIA_RUST_CLI and ARDIA_TS_CLI")
class TsParityTable(ParityTable, unittest.TestCase):
    entry = "ts"


class ServedTable(unittest.TestCase):
    def test_each_row_names_a_command_and_who_serves_it_once(self):
        table = harness.served_table()
        self.assertTrue(table)
        self.assertTrue(set(table.values()) <= set(harness.SERVING_SIDES))
        scratch = Path(tempfile.mkdtemp(prefix="ars", dir="/tmp"))
        try:
            for body in ("tabs\n", "tabs go\n", "tabs rust\ntabs ts\n", "tabs rust extra\n"):
                with self.subTest(body=body):
                    (scratch / "served.txt").write_text(body)
                    with self.assertRaises(ValueError):
                        harness.served_table(scratch / "served.txt")
        finally:
            shutil.rmtree(scratch, True)

    def test_the_typescript_entry_embeds_the_same_table(self):
        source = (CLI / "ts" / "src" / "served.ts").read_text()
        self.assertIn('import table from "../../served.txt" with { type: "text" };', source)


class ProtocolAgrees(unittest.TestCase):
    def test_every_side_speaks_the_same_control_protocol(self):
        from ardia_cli import control

        rust = (CLI / "rust" / "src" / "control.rs").read_text()
        constants = dict(re.findall(r"pub const (PROTOCOL|MIN_APP_PROTOCOL): i128 = (\d+);", rust))
        self.assertEqual(int(constants["PROTOCOL"]), control.PROTOCOL)
        self.assertEqual(int(constants["MIN_APP_PROTOCOL"]), control.MIN_APP_PROTOCOL)
        ts = (CLI / "ts" / "src" / "protocol.ts").read_text()
        spoken = dict(re.findall(r"export const (PROTOCOL|MIN_APP_PROTOCOL) = (\d+);", ts))
        self.assertEqual(int(spoken["PROTOCOL"]), control.PROTOCOL)
        self.assertEqual(int(spoken["MIN_APP_PROTOCOL"]), control.MIN_APP_PROTOCOL)


class HarnessRules(unittest.TestCase):
    def case(self, **row):
        return harness.Case.from_dict({"id": "t", "command": "windows", "argv": ["windows"], **row}, "test")

    def test_a_case_cannot_reach_outside_its_sandbox(self):
        for row in ({"files": {"../x": "y"}}, {"files": {"data/../../x": "y"}}, {"files": {"/etc/x": "y"}}, {"files": {"elsewhere/x": "y"}},
                    {"argv": ["windows", "--data-dir", "/d"]}, {"argv": ["windows", "--data-dir=/d"]}, {"argv": ["windows", "--data-dir", "{data}/../../x"]},
                    {"argv": ["config", "path", "~/x"]}, {"argv": ["plugins", "install", "../../x"]}, {"argv": ["plugins", "install", "{cli}/../x"]}, {"env": {"HOME": None}}, {"env": {"ARDIA_CLI_HOME": "/x"}}, {"env": {"PATH": "/bin"}},
                    {"env": {"ARDIA_DATA_DIR": "/Users/someone/Ardia"}}, {"helpers": {"../launchctl": {}}}, {"helpers": {"/bin/sh": {}}},
                    {"env": {"ARDIA_CONFIG_HOME": "{box}/../sibling"}}, {"env": {"XDG_CONFIG_HOME": "/elsewhere"}}, {"env": {"XDG_DATA_HOME": "../.."}},
                    {"env": {"ARDIA_CONFIG_HOME": "{cli}/x"}}, {"env": {"SOME_DIR": "/elsewhere"}}):
            with self.subTest(row=row), self.assertRaises(harness.UnsafeCase):
                self.case(**row)
        self.case(argv=["windows", "--data-dir", "{box}/elsewhere"], env={"ARDIA_DATA_DIR": None, "COLUMNS": "80"})
        self.case(argv=["theme", "check", "../evil"])
        self.case(argv=["plugins", "call", "x", '{"who": "you/../me"}'])

    def test_the_rust_entry_expects_what_its_installation_does_with_a_typescript_row(self):
        case = self.case()
        served = {"windows": "ts", "tabs": "rust"}
        self.assertEqual(harness.expected_route("rust", served, case, ts_installed=False), "python")
        self.assertEqual(harness.expected_route("rust", served, case, ts_installed=True), "ts")
        self.assertEqual(harness.expected_route("rust", served, self.case(command="tabs", argv=["tabs"]), ts_installed=False), "rust")
        self.assertEqual(harness.expected_route("ts", served, self.case(command="tabs", argv=["tabs"]), ts_installed=True), "ts")
        self.assertEqual(harness.expected_route("rust", served, self.case(fallback=True), ts_installed=True), "python")

    def test_a_selection_that_matches_no_case_is_an_error(self):
        for selection in (["--case", "no-such-case"], ["--command", "no-such-command"]):
            with self.subTest(selection=selection):
                done = subprocess.run([sys.executable, "-m", "parity", "--program", sys.executable, *selection], cwd=CLI / "tests",
                                      capture_output=True, text=True, timeout=60)
                self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
                self.assertIn("no parity case", done.stderr)

    def test_a_fallback_may_only_ask_read_only_questions_first(self):
        python = [[{"id": 1, "method": "hello", "params": {"protocol": 4}}, {"id": 2, "method": "apply", "params": {"ops": []}}]]
        read_first = [[{"id": 1, "method": "hello", "params": {"protocol": 4}}, {"id": 2, "method": "workspace"}]] + python
        mutate_first = [[{"id": 1, "method": "hello", "params": {"protocol": 4}}, {"id": 2, "method": "apply", "params": {"ops": []}}]] + python
        self.assertEqual(harness.fallback_requests(read_first, python), python)
        self.assertEqual(harness.fallback_requests(mutate_first, python), mutate_first)

    def test_times_are_scrubbed_only_when_they_are_now(self):
        window = (1_763_500_000.0, 1_763_500_001.0)
        scrubbed = harness.scrub_times({"last_at": 1_763_500_000.5, "first_ms": 1_763_500_000_000, "next_at": 0, "open_at": False, "done_at": None,
                                        "count": 5, "later_at": 9_999_999_999.0, "earlier_at": 1_700_000_000}, window)
        self.assertEqual(scrubbed, {"last_at": "<now float s>", "first_ms": "<now int ms>", "next_at": 0, "open_at": False, "done_at": None,
                                    "count": 5, "later_at": 9_999_999_999.0, "earlier_at": 1_700_000_000})

    def test_comparisons_keep_json_types(self):
        self.assertNotEqual(harness.exact([[{"id": True, "method": "hello"}]]), harness.exact([[{"id": 1, "method": "hello"}]]))
        self.assertNotEqual(harness.exact([{"id": 2, "method": "windows"}]), harness.exact([{"id": 2, "method": "windows", "params": "<absent>"}]))
        self.assertNotEqual(harness.exact([{"id": 2, "method": "windows"}]), harness.exact([{"id": 2, "method": "windows", "extra": 1}]))
        self.assertNotEqual(harness.exact({"usage": True}), harness.exact({"usage": 1}))
        self.assertNotEqual(harness.exact({"n": 1.0}), harness.exact({"n": 1}))

    def test_fixtures_are_never_written_through_a_link(self):
        outside = Path(tempfile.mkdtemp(prefix="arpout", dir="/tmp")).resolve()
        box = Path(tempfile.mkdtemp(prefix="arpbox", dir="/tmp")).resolve() / "c1"
        try:
            case = self.case(files={"data/away": {"link": str(outside)}, "data/away/sub/file": "x"})
            with self.assertRaises(harness.UnsafeCase):
                harness.materialize(box, case)
            self.assertEqual(list(outside.iterdir()), [])
        finally:
            shutil.rmtree(outside, True)
            shutil.rmtree(box.parent, True)

    def test_a_data_dir_through_a_fixture_link_is_refused(self):
        box = Path(tempfile.mkdtemp(prefix="arpbox", dir="/tmp")).resolve() / "c1"
        outside = Path(tempfile.mkdtemp(prefix="arpout", dir="/tmp")).resolve()
        install = harness.Installation(binary() or Path(sys.executable))
        try:
            case = self.case(argv=["config", "init", "--data-dir", "{data}/away"], files={"data/away": {"link": str(outside)}})
            with self.assertRaises(harness.UnsafeCase):
                harness.run_side(install, "python", case, box)
            self.assertEqual(list(outside.iterdir()), [])
        finally:
            install.close()
            shutil.rmtree(outside, True)
            shutil.rmtree(box.parent, True)

    def test_telemetry_timestamps_are_checked_against_the_run(self):
        window = (1_763_500_000.0, 1_763_500_001.0)
        now, stale = {"timestamp": "2025-11-18T21:06:40.500Z"}, {"timestamp": "2000-01-01T00:00:00.000Z"}
        harness.scrub_timestamp(now, window)
        harness.scrub_timestamp(stale, window)
        self.assertEqual(now["timestamp"], "<now float s>")
        self.assertEqual(stale["timestamp"], "2000-01-01T00:00:00.000Z")

    def test_a_reply_that_cannot_be_written_does_not_hide_the_next_request(self):
        scratch = Path(tempfile.mkdtemp(prefix="arpsock", dir="/tmp")).resolve()
        fake = harness.FakeArdia(scratch / "s.sock", harness.DEFAULT_HELLO, {"windows": {"result": ["x" * 65536]}}, [])
        try:
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.connect(str(scratch / "s.sock"))
            client.shutdown(socket.SHUT_RD)
            client.sendall(b'{"id":1,"method":"windows"}\n{"id":2,"method":"commands"}\n')
            client.close()
        finally:
            fake.close()
            shutil.rmtree(scratch, True)
        self.assertEqual([method for method, _ in fake.requests], ["windows", "commands"])
        self.assertTrue(fake.complete)

    def test_flush_deadlines_compare_as_offsets(self):
        window = (1_763_500_000.0, 1_763_500_001.0)
        self.assertNotEqual(harness.scrub_times({"next_at": 1_763_500_002.0}, window), harness.scrub_times({"next_at": 1_763_500_101.0}, window))
        self.assertEqual(harness.scrub_times({"next_at": 1_763_500_061.2}, window), harness.scrub_times({"next_at": 1_763_500_060.9}, (1_763_499_999.8, 1_763_500_000.8)))

    def test_helpers_log_each_argument_whole(self):
        scratch = Path(tempfile.mkdtemp(prefix="arpstub", dir="/tmp"))
        try:
            log = scratch / "log"
            harness.write_stub(scratch, "tool", {}, log)
            for argv in (["a b"], ["a", "b"], ["x\ny"], ["x\ry"], [""], []):
                subprocess.run([str(scratch / "tool"), *argv], check=True, capture_output=True)
            lines = log.read_text().splitlines()
            self.assertEqual(len(lines), 6)
            self.assertEqual(len(set(lines)), 6)
        finally:
            shutil.rmtree(scratch, True)

    @unittest.skipUnless(sys.platform == "darwin", "sandbox-exec is macOS's")
    def test_the_sandbox_keeps_writes_sockets_and_helpers_inside(self):
        install = harness.Installation(binary() or Path(sys.executable))
        try:
            box = install.box()
            box.mkdir()
            outside = install.scratch / "outside-the-box"
            script = f"echo in > {box}/in; echo out > {outside}; /bin/launchctl list >/dev/null 2>&1 || echo launchctl-denied"
            done = subprocess.run(install.confined(["/bin/sh", "-c", script], box), capture_output=True, text=True, timeout=30)
            self.assertTrue((box / "in").exists())
            self.assertFalse(outside.exists())
            self.assertIn("launchctl-denied", done.stdout)
        finally:
            install.close()

    @unittest.skipUnless(binary(), "needs the Rust ardia")
    def test_detached_children_of_the_installation_are_reaped_whatever_their_environment(self):
        install = harness.Installation(binary())
        try:
            sleeper = install.root / "bin" / "parity-sleep"
            sleeper.write_text("#!/bin/sh\nwhile :; do /bin/sleep 1; done\n")
            sleeper.chmod(0o755)
            child = subprocess.Popen([str(sleeper)], env={}, start_new_session=True)
            listed = lambda: str(install.scratch).encode() in subprocess.run(["/bin/ps", "-x", "-ww", "-o", "command="], capture_output=True).stdout
            self.assertTrue(sys.platform != "darwin" or harness.wait_until(listed, 5))
        finally:
            install.close()
        child.wait(timeout=5)
        self.assertEqual(child.returncode, -signal.SIGKILL)

    def test_detached_children_are_reaped(self):
        box = Path(tempfile.mkdtemp(prefix="reap", dir="/tmp")).resolve()
        try:
            child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], env={**os.environ, "ARDIA_PARITY_BOX": str(box)},
                                     start_new_session=True)
            listed = lambda: str(box).encode() in subprocess.run(["/bin/ps", "-x", "-E", "-ww", "-o", "command="], capture_output=True).stdout
            self.assertTrue(sys.platform != "darwin" or harness.wait_until(listed, 5))
            harness.reap(str(box))
            child.wait(timeout=5)
            self.assertEqual(child.returncode, -signal.SIGKILL)
        finally:
            shutil.rmtree(box, True)


@unittest.skipUnless(binary(), "build plugins/cli/rust first (cargo build) or set ARDIA_RUST_CLI")
class HarnessCatches(unittest.TestCase):
    def test_the_seeder_refuses_a_secret_inside_a_binary_fixture(self):
        from parity import record

        recorder = record.Recorder()
        recorder.baseline = {"ARDIA_WS": "ws://127.0.0.1:9/devtools/browser/x?token=parity-secret-1234567890"}
        case = {"argv": ["windows"], "env": {}, "files": {"data/blob": {"base64": base64.b64encode(b"\x00\xff" + recorder.baseline["ARDIA_WS"].encode()).decode()}}}
        with self.assertRaises(record.Skip):
            recorder.check_private(case)
        recorder.baseline = {"ARDIA_NOTE": "café-parity-marker-0123"}
        case = {"argv": ["windows"], "env": {}, "files": {"data/blob": {"base64": base64.b64encode(b"\x00\xff" + "café-parity-marker-0123".encode()).decode()}}}
        with self.assertRaises(record.Skip):
            recorder.check_private(case)
    def test_a_binary_that_hands_everything_to_python_proves_nothing(self):
        for launch in ('-I -m ardia_cli "$@"', '-I -c "import runpy, sys; sys.argv[0] = \'ardia\'; runpy.run_module(\'ardia_cli\', run_name=\'__main__\')" "$@"',
                       '-I -c "import sys; from ardia_cli.cli import main; sys.exit(main(sys.argv[1:]))" ardia "$@"'):
            with self.subTest(launch=launch):
                self.impostor_fails(launch)

    def test_a_typescript_program_that_runs_python_as_its_child_proves_nothing(self):
        scratch = Path(tempfile.mkdtemp(prefix="arh", dir="/tmp"))
        try:
            impostor = scratch / "ardia-ts"
            impostor.write_text('#!/bin/sh\nhere=$(cd "$(dirname "$0")/.." && pwd)\nshift\n"$here/python/bin/python3" -I -m ardia_cli "$@"\nexit $?\n')
            impostor.chmod(0o755)
            cases = [case for case in harness.load_cases() if case.id in ("version--version", "windows--windows")]
            self.assertTrue(cases)
            outcomes, install = harness.run_all(cases, impostor, entry="ts")
            install.close()
            self.assertTrue(all("expected ts to serve it, but python did" in outcome.problems for outcome in outcomes), [o.problems for o in outcomes])
        finally:
            shutil.rmtree(scratch, True)

    def test_routes_follow_the_session_not_the_process(self):
        self.assertEqual(harness.route_from([]), "rust")
        self.assertEqual(harness.route_from(["ts"]), "ts")
        self.assertEqual(harness.route_from(["ts", "python"]), "python")
        self.assertEqual(harness.route_from(["python", "ts"]), "python")
        self.assertIn("getsid(0)", harness.ROUTE_PROBE)
        self.assertIn("$PPID", harness.TS_PROBE)

    def test_a_hand_off_that_drops_the_harness_environment_still_shows_python(self):
        self.impostor_fails('-I -m ardia_cli "$@"', prefix="/usr/bin/env -u ARDIA_PARITY_PYTHON_LOG -u ARDIA_PARITY_BOX ")

    def impostor_fails(self, launch, prefix=""):
        scratch = Path(tempfile.mkdtemp(prefix="arh", dir="/tmp"))
        try:
            impostor = scratch / "ardia"
            impostor.write_text('#!/bin/sh\nhere=$(cd "$(dirname "$0")/.." && pwd)\nexec ' + prefix + '"$here/python/bin/python3" ' + launch + '\n')
            impostor.chmod(0o755)
            cases = [case for case in harness.load_cases() if case.id in ("version--version", "windows--windows") or case.id.startswith("tabs--tabs-json")]
            self.assertTrue(cases)
            for entry in harness.ENTRIES:
                outcomes, install = harness.run_all(cases, impostor, entry=entry)
                install.close()
                self.assertTrue(all(not outcome.passed for outcome in outcomes), [outcome.case.id for outcome in outcomes if outcome.passed])
                self.assertTrue(all(f"expected {entry} to serve it, but python did" in outcome.problems for outcome in outcomes))
                summary = harness.summarize(outcomes, ["--version", "windows", "tabs"])
                self.assertEqual(summary["unproven_but_served"], ["--version", "tabs", "windows"])
        finally:
            shutil.rmtree(scratch, True)


class EntryProcess:
    entry = "rust"
    hand_backs: tuple = ()

    @classmethod
    def setUpClass(cls):
        cls.install = harness.Installation(harness.entry_binary(cls.entry), entry=cls.entry)
        cls.scratch = cls.install.scratch
        cls.root = cls.install.root
        cls.python = cls.install.python

    @classmethod
    def tearDownClass(cls):
        cls.install.close()

    def setUp(self):
        self.case = Path(tempfile.mkdtemp(prefix="c", dir=self.scratch))

    def environment(self, extra: dict) -> dict:
        env = {key: os.environ[key] for key in KEPT_ENV if key in os.environ}
        env.update({
            "HOME": str(self.case / "home"),
            "ARDIA_CLI_HOME": str(self.case / "cli-home"),
            "ARDIA_DATA_DIR": str(self.case / "data"),
            "ARDIA_TELEMETRY_URL": "http://127.0.0.1:9/v1/logs",
            "COLUMNS": "100",
            "LINES": "40",
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        env.update(extra)
        return env

    def start(self, argv: list, env: dict | None = None, ignore_interrupts: bool = False, program: Path | None = None) -> subprocess.Popen:
        def prepare():
            os.setsid()
            if ignore_interrupts:
                signal.signal(signal.SIGINT, signal.SIG_IGN)

        return subprocess.Popen([str(program or self.root / "bin" / "ardia"), *argv], env=env or self.environment({}), stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, preexec_fn=prepare)

    def ctrl_c(self, process: subprocess.Popen) -> None:
        os.killpg(process.pid, signal.SIGINT)

    def wait_for(self, fake, method: str, count: int = 1):
        deadline = time.monotonic() + 20
        while [name for name, _ in fake.requests].count(method) < count and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertGreaterEqual([name for name, _ in fake.requests].count(method), count, f"ardia never asked {method}")

    def test_an_ignored_interrupt_stays_ignored_after_the_hand_off(self):
        data = self.case / "data"
        data.mkdir()
        fake = FakeArdia(data / "ArdiaControl.sock", {"hello": {"result": {"app": "Ardia"}}, "subscribe": {"result": {}}})
        events = self.start(["events"], ignore_interrupts=True)
        try:
            self.wait_for(fake, "subscribe")
            self.ctrl_c(events)
            time.sleep(1)
            self.assertIsNone(events.poll(), events.stderr.read() if events.poll() is not None else "")
        finally:
            events.kill()
            events.communicate()
            fake.close()

    def blocked_listing(self, argv: list, program: Path | None = None) -> tuple:
        tabs = [{"type": "tab", "id": f"tab-{index}", "title": "t" * 40, "url": "https://example.com/" + "p" * 40} for index in range(3000)]
        data = self.case / "data"
        data.mkdir(exist_ok=True)
        fake = FakeArdia(data / "ArdiaControl.sock", {"hello": {"result": {"app": "Ardia"}}, "workspace": {"result": {"windows": [{"id": "w-1", "spaces": [{"profile": "p", "tabs": tabs}]}]}}})
        try:
            listing = self.start(argv, program=program)
            self.wait_for(fake, "workspace")
            time.sleep(1)
            self.assertIsNone(listing.poll(), "the output should fill the pipe and block")
            self.ctrl_c(listing)
            deadline = time.monotonic() + 5
            while listing.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            stopped = listing.poll() is not None
            if not stopped:
                listing.kill()
            out, err = listing.communicate()
            return stopped, listing.returncode, err
        finally:
            fake.close()

    def test_ctrl_c_while_blocked_on_output_ends_like_python(self):
        new = self.blocked_listing(["tabs", "--json"])
        self.case = Path(tempfile.mkdtemp(prefix="c", dir=self.scratch))
        python = self.blocked_listing(["-I", "-m", "ardia_cli", "tabs", "--json"], program=self.python)
        self.assertEqual(new, python)
        self.assertEqual(new, (True, 130, b"ardia tabs: interrupted\n"))

    def slow_listing(self, release: threading.Event, first=None):
        asked = []

        def answer():
            asked.append(1)
            if first is not None and len(asked) == 1:
                return first
            release.wait(10)
            return {"result": {"windows": []}}

        data = self.case / "data"
        data.mkdir()
        return FakeArdia(data / "ArdiaControl.sock", {"hello": {"result": {"app": "Ardia"}}, "workspace": answer})

    def test_ctrl_c_during_the_call_says_interrupted(self):
        release = threading.Event()
        fake = self.slow_listing(release)
        try:
            listing = self.start(["tabs"])
            self.wait_for(fake, "workspace")
            self.ctrl_c(listing)
            out, err = listing.communicate(timeout=10)
            self.assertEqual((listing.returncode, out, err), (130, b"", b"ardia tabs: interrupted\n"))
        finally:
            release.set()
            fake.close()

    def test_an_interrupt_sent_to_ardia_alone_says_interrupted(self):
        release = threading.Event()
        fake = self.slow_listing(release)
        try:
            listing = self.start(["tabs"])
            self.wait_for(fake, "workspace")
            os.kill(listing.pid, signal.SIGINT)
            out, err = listing.communicate(timeout=10)
            self.assertEqual((listing.returncode, out, err), (130, b"", b"ardia tabs: interrupted\n"))
        finally:
            release.set()
            fake.close()

    def test_an_ignored_interrupt_sent_to_ardia_alone_stays_ignored(self):
        release = threading.Event()
        fake = self.slow_listing(release)
        try:
            listing = self.start(["tabs"], ignore_interrupts=True)
            self.wait_for(fake, "workspace")
            os.kill(listing.pid, signal.SIGINT)
            time.sleep(0.5)
            self.assertIsNone(listing.poll(), "an ignored interrupt stopped the listing")
            release.set()
            out, err = listing.communicate(timeout=10)
            self.assertEqual((listing.returncode, err), (0, b""))
        finally:
            release.set()
            fake.close()

    def test_an_ignored_interrupt_stays_ignored_during_a_listing(self):
        release = threading.Event()
        fake = self.slow_listing(release)
        try:
            listing = self.start(["tabs"], ignore_interrupts=True)
            self.wait_for(fake, "workspace")
            self.ctrl_c(listing)
            time.sleep(0.5)
            self.assertIsNone(listing.poll(), "an ignored Ctrl-C stopped the listing")
            release.set()
            out, err = listing.communicate(timeout=10)
            self.assertEqual((listing.returncode, err), (0, b""))
        finally:
            release.set()
            fake.close()

    def test_paths_that_are_not_utf8_go_to_python(self):
        lossy = self.case / "data-�"
        lossy.mkdir()
        fake = FakeArdia(lossy / "ArdiaControl.sock", {"hello": {"result": {"app": "Ardia"}}, "windows": {"result": [{"id": 1, "tabs": []}]}})
        try:
            for name, value in (("ARDIA_DATA_DIR", str(self.case / "data-\udcff")), ("ARDIA_CLI_HOME", str(self.case / "home-\udcff"))):
                env = self.environment({name: value})
                new = subprocess.run([str(self.root / "bin" / "ardia"), "windows"], env=env, capture_output=True, timeout=30)
                python = subprocess.run([str(self.python), "-I", "-m", "ardia_cli", "windows"], env=env, capture_output=True, timeout=30)
                self.assertEqual((new.returncode, new.stdout, new.stderr), (python.returncode, python.stdout, python.stderr), name)
            self.assertEqual(fake.requests, [])
            self.assertFalse((self.case / "home-�").exists())
        finally:
            fake.close()

    def test_argv_that_is_not_utf8_reaches_python_byte_for_byte(self):
        env = self.environment({"ARDIA_NOTE": "n\udcfe"})
        for argv in (["nosuch-\udcff"], ["windows", "--data-dir", str(self.case / "d-\udcff")]):
            new = subprocess.run([str(self.root / "bin" / "ardia"), *argv], env=env, capture_output=True, timeout=30)
            python = subprocess.run([str(self.python), "-I", "-m", "ardia_cli", *argv], env=env, capture_output=True, timeout=30)
            self.assertEqual((new.returncode, new.stdout, new.stderr), (python.returncode, python.stdout, python.stderr), argv)
            self.assertNotIn("�".encode(), new.stderr)

    def test_its_events_reach_the_collector_through_the_python_flusher(self):
        collector = ThreadingHTTPServer(("127.0.0.1", 0), Collector)
        threading.Thread(target=collector.serve_forever, daemon=True).start()
        Collector.bodies.clear()
        data = self.case / "data"
        data.mkdir()
        (self.case / "home").mkdir()
        (data / "telemetry.json").write_text(json.dumps({"sharing": True, "installId": INSTALL_ID}))
        fake = FakeArdia(data / "ArdiaControl.sock", {"hello": {"result": {"app": "Ardia"}}, "windows": {"result": []}})
        reader, writer = os.pipe()
        try:
            url = f"http://127.0.0.1:{collector.server_address[1]}/v1/logs"
            done = subprocess.run([str(self.root / "bin" / "ardia"), "windows"], capture_output=True, pass_fds=(writer,),
                                  env=self.environment({"ARDIA_TELEMETRY_URL": url}), timeout=30)
            os.close(writer)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertTrue(select.select([reader], [], [], 1.5)[0], "the flusher kept a descriptor it inherited")
            self.assertEqual(os.read(reader, 1), b"")
            deadline = time.monotonic() + 20
            while not Collector.bodies and time.monotonic() < deadline:
                time.sleep(0.1)
            self.assertTrue(Collector.bodies, "the flusher never posted")
            attributes = {item["key"]: item["value"] for item in json.loads(Collector.bodies[0])["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]["attributes"]}
            self.assertEqual(attributes["served_by"], {"stringValue": self.entry})
            self.assertEqual(attributes["command"], {"stringValue": "windows"})
            self.assertEqual(attributes["distinct_id"], {"stringValue": INSTALL_ID})
            while (data / "Telemetry" / "cli-queue.jsonl").exists() and time.monotonic() < deadline:
                time.sleep(0.1)
            self.assertFalse((data / "Telemetry" / "cli-queue.jsonl").exists())
        finally:
            os.close(reader)
            fake.close()
            collector.shutdown()
            collector.server_close()

    def test_the_lease_is_held_through_the_hand_off_to_python(self):
        leases = self.root / ".leases"
        leases.mkdir(exist_ok=True)
        packages = subprocess.run([str(self.python), "-I", "-c", "import site; print(site.getsitepackages()[0])"], check=True, capture_output=True, text=True).stdout.strip()
        probe_hook = Path(packages) / "ardia-lease-probe.pth"
        probe_hook.write_text('import os, sys; probe = os.environ.get("ARDIA_LEASE_PROBE"); probe and open(probe, "a").write(str(os.path.exists(os.path.join(os.environ["ARDIA_LEASE_DIR"], str(os.getpid()))))[0] + " " + sys.argv[1] + "\\n")\n')
        data = self.case / "data"
        data.mkdir()
        fake = FakeArdia(data / "ArdiaControl.sock", {"hello": {"result": {"app": "Ardia"}}, "workspace": {"result": 3}})
        probe = self.case / "probe"
        try:
            for argv in (["config", "path"], ["tabs"]):
                env = self.environment({"ARDIA_LEASE_PROBE": str(probe), "ARDIA_LEASE_DIR": str(leases)})
                done = subprocess.run([str(self.root / "bin" / "ardia"), *argv], capture_output=True, env=env, timeout=30)
                self.assertIn(done.returncode, (0, 3), done.stderr)
            self.assertEqual(set(probe.read_text().splitlines()), {"T config", "T tabs"}, "Python started without this pid's lease")
        finally:
            probe_hook.unlink()
            fake.close()
            shutil.rmtree(leases, True)
        bare = self.case / "bare"
        (bare / "bin").mkdir(parents=True)
        (bare / ".leases").mkdir()
        for program in (self.root / "bin").iterdir():
            shutil.copy2(program, bare / "bin" / program.name)
        done = subprocess.run([str(bare / "bin" / "ardia"), "config", "path"], capture_output=True, env=self.environment({}), timeout=30)
        self.assertEqual(done.returncode, 127)
        self.assertEqual(os.listdir(bare / ".leases"), [])

    def bare_install(self, python_text: str | None = None, mode: int = 0o755, with_ts: bool | None = None, served: str | None = None) -> Path:
        bare = Path(tempfile.mkdtemp(prefix="b", dir=self.case))
        (bare / "bin").mkdir()
        (bare / ".leases").mkdir()
        (bare / "python" / "bin").mkdir(parents=True)
        shutil.copy2(binary(), bare / "bin" / "ardia")
        if self.entry == "ts" if with_ts is None else with_ts:
            (bare / "libexec").mkdir()
            shutil.copy2(self.root / "libexec" / "ardia-ts.bin", bare / "libexec" / "ardia-ts.bin")
            probe = bare / "libexec" / "ardia-ts"
            probe.write_text('#!/bin/sh\nprintf x >> "$(dirname "$0")/../ts-ran"\nexec "$(dirname "$0")/ardia-ts.bin" "$@"\n')
            probe.chmod(0o755)
            served = served if served is not None else "".join(f"{name} ts\n" for name in harness.served_table())
        if served is not None:
            (bare / "served.txt").write_text(served)
        python = bare / "python" / "bin" / "python3"
        python.write_text(python_text if python_text is not None else f'#!/bin/sh\nexec "{self.python}" "$@"\n')
        python.chmod(mode)
        return bare

    def couldnt_run(self, bare: Path, reason: str) -> bytes:
        return f"ardia: couldn't run {os.path.realpath(bare)}/python/bin/python3: {reason}\n".encode()

    def exec_cases(self) -> list:
        return [["config", "path"], ["nosuch-\udcff"], *self.hand_backs]

    def test_a_python_that_cannot_run_is_reported_and_the_lease_dropped(self):
        for argv in self.exec_cases():
            for body, mode, reason in ((None, 0o644, "Permission denied"), ("#!/nonexistent/interpreter\n", 0o755, "No such file or directory")):
                with self.subTest(argv=argv, reason=reason):
                    bare = self.bare_install(body, mode)
                    done = subprocess.run([str(bare / "bin" / "ardia"), *argv], env=self.environment({}), capture_output=True, timeout=30)
                    self.assertEqual((done.returncode, done.stdout, done.stderr), (127, b"", self.couldnt_run(bare, reason)))
                    self.assertEqual(os.listdir(bare / ".leases"), [])

    def test_a_python_that_is_not_a_program_runs_through_the_shell_as_execvp_does(self):
        for argv in self.exec_cases():
            with self.subTest(argv=argv):
                bare = self.bare_install("echo shell-ran \"$@\"\nexit 9\n")
                done = subprocess.run([str(bare / "bin" / "ardia"), *argv], env=self.environment({}), capture_output=True, timeout=30)
                self.assertEqual((done.returncode, done.stdout.split(b" ")[:4]), (9, [b"shell-ran", b"-I", b"-m", b"ardia_cli"]))

    @unittest.skipUnless(sys.platform == "darwin", "the size rule it checks is macOS's; Linux caps each string at 128 KB, so ardia itself would not start")
    def test_an_argument_list_too_long_for_python_is_reported_and_the_lease_dropped(self):
        for argv in self.exec_cases():
            with self.subTest(argv=argv):
                bare = self.bare_install(f'#!/bin/sh\nexec "{self.python}" "$@"\n')
                program = str(bare / "bin" / "ardia")
                env = self.environment({"ARDIA_FILL": ""})
                words = [program, *argv] + [f"{key}={value}" for key, value in env.items()]
                used = sum(len(os.fsencode(word)) + 1 for word in words) + 8 * len(words) + 16
                done = None
                for slack in range(64):
                    env["ARDIA_FILL"] = "f" * (1024 * 1024 - used - slack)
                    try:
                        done = subprocess.run([program, *argv], env=env, capture_output=True, timeout=30)
                        break
                    except OSError:
                        continue
                self.assertIsNotNone(done, "ardia itself never started")
                self.assertEqual((done.returncode, done.stdout, done.stderr), (127, b"", self.couldnt_run(bare, "Argument list too long")))
                self.assertEqual(os.listdir(bare / ".leases"), [])

    def test_a_lease_is_held_by_ardia_while_it_runs_and_removed_after(self):
        leases = self.root / ".leases"
        leases.mkdir(exist_ok=True)
        seen = []

        def listing():
            seen.extend(os.listdir(leases))
            return {"result": []}

        data = self.case / "data"
        data.mkdir()
        fake = FakeArdia(data / "ArdiaControl.sock", {"hello": {"result": {"app": "Ardia"}}, "windows": listing})
        try:
            running = self.start(["windows"])
            out, err = running.communicate(timeout=30)
        finally:
            fake.close()
            leftover = os.listdir(leases)
            shutil.rmtree(leases, True)
        self.assertEqual(running.returncode, 0, err)
        self.assertEqual(seen, [str(running.pid)])
        self.assertEqual(leftover, [])


@unittest.skipUnless(binary(), "build plugins/cli/rust first (cargo build) or set ARDIA_RUST_CLI")
class RustProcess(EntryProcess, unittest.TestCase):
    entry = "rust"


@unittest.skipUnless(both_programs(), "build plugins/cli/rust (the router) and plugins/cli/ts (bun run build), or set ARDIA_RUST_CLI and ARDIA_TS_CLI")
class TsProcess(EntryProcess, unittest.TestCase):
    entry = "ts"
    hand_backs = (["--data-dir", "/nowhere-�", "windows"],)
    not_routed = b"ardia-ts: this program runs only as part of ardia; run ardia instead\n"

    def logging_python(self, log: Path) -> str:
        return (f'#!/bin/sh\nif [ "$2" = "-m" ]; then\n  for word in "$@"; do printf %s "$word" | /usr/bin/xxd -p | tr -d "\\n" >> "{log}"; echo >> "{log}"; done\n'
                f'  printf "note=" >> "{log}"; printenv ARDIA_NOTE | /usr/bin/xxd -p >> "{log}"\nfi\nexec "{self.python}" "$@"\n')

    def ts_child(self, pid: int) -> int:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            found = subprocess.run(["/usr/bin/pgrep", "-P", str(pid)], capture_output=True, text=True).stdout.split()
            if found:
                return int(found[0])
            time.sleep(0.05)
        self.fail("the router started no child")

    def test_an_ignored_interrupt_stays_ignored_for_python_after_a_hand_back(self):
        release = threading.Event()
        fake = self.slow_listing(release, first={"result": 3})
        try:
            listing = self.start(["tabs"], ignore_interrupts=True)
            self.wait_for(fake, "workspace", 2)
            self.ctrl_c(listing)
            time.sleep(0.5)
            self.assertIsNone(listing.poll(), "an ignored Ctrl-C stopped Python after the hand-back")
            release.set()
            out, err = listing.communicate(timeout=10)
            self.assertEqual((listing.returncode, err), (0, b""))
        finally:
            release.set()
            fake.close()

    def test_ardia_ends_by_the_signal_that_ended_the_typescript_program(self):
        leases = self.root / ".leases"
        for target, sent in (("child", signal.SIGTERM), ("child", signal.SIGKILL), ("router", signal.SIGTERM)):
            with self.subTest(target=target, sent=sent):
                self.case = Path(tempfile.mkdtemp(prefix="c", dir=self.scratch))
                leases.mkdir(exist_ok=True)
                release = threading.Event()
                fake = self.slow_listing(release)
                try:
                    listing = self.start(["tabs"])
                    self.wait_for(fake, "workspace")
                    child = self.ts_child(listing.pid)
                    self.assertEqual(os.listdir(leases), [str(listing.pid)])
                    os.kill(child if target == "child" else listing.pid, sent)
                    listing.communicate(timeout=10)
                    self.assertEqual(listing.returncode, -sent)
                    self.assertEqual(os.listdir(leases), [])
                    with self.assertRaises(ProcessLookupError):
                        os.kill(child, 0)
                finally:
                    release.set()
                    fake.close()
                    shutil.rmtree(leases, True)

    def test_the_typescript_program_ends_when_the_router_is_killed(self):
        for blocked_on in ("the call", "its output"):
            with self.subTest(blocked_on=blocked_on):
                self.case = Path(tempfile.mkdtemp(prefix="c", dir=self.scratch))
                release = threading.Event()
                if blocked_on == "the call":
                    fake = self.slow_listing(release)
                else:
                    tabs = [{"type": "tab", "id": f"tab-{index}", "title": "t" * 40, "url": "https://example.com/" + "p" * 40} for index in range(3000)]
                    (self.case / "data").mkdir()
                    fake = FakeArdia(self.case / "data" / "ArdiaControl.sock", {"hello": {"result": {"app": "Ardia"}},
                                     "workspace": {"result": {"windows": [{"id": "w-1", "spaces": [{"profile": "p", "tabs": tabs}]}]}}})
                try:
                    listing = self.start(["tabs", "--json"])
                    self.wait_for(fake, "workspace")
                    child = self.ts_child(listing.pid)
                    time.sleep(0.5)
                    os.kill(listing.pid, signal.SIGKILL)
                    listing.wait(5)
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        try:
                            os.kill(child, 0)
                        except ProcessLookupError:
                            break
                        time.sleep(0.05)
                    else:
                        os.kill(child, signal.SIGKILL)
                        self.fail("the TypeScript program ran on after the router died")
                    closed = threading.Event()
                    threading.Thread(target=lambda: (listing.stdout.read(), closed.set()), daemon=True).start()
                    self.assertTrue(closed.wait(5), "the output pipe stayed open after the router died")
                finally:
                    release.set()
                    fake.close()

    def test_a_hand_back_reaches_python_byte_for_byte(self):
        log = self.case / "exec.log"
        bare = self.bare_install(self.logging_python(log))
        env = self.environment({"ARDIA_NOTE": "n\udcfe"})
        for argv, through_ts in ((["--data-dir", str(self.case / "d-�"), "windows"], True), (["windows", "--data-dir", str(self.case / "d-\udcff")], False)):
            with self.subTest(argv=argv):
                log.unlink(missing_ok=True)
                (bare / "ts-ran").unlink(missing_ok=True)
                done = subprocess.run([str(bare / "bin" / "ardia"), *argv], env=env, capture_output=True, timeout=30)
                python = subprocess.run([str(self.python), "-I", "-m", "ardia_cli", *argv], env=env, capture_output=True, timeout=30)
                self.assertEqual((done.returncode, done.stdout, done.stderr), (python.returncode, python.stdout, python.stderr))
                self.assertEqual((bare / "ts-ran").exists(), through_ts)
                words = [os.fsencode(word).hex() for word in ["-I", "-m", "ardia_cli", *argv]]
                self.assertEqual(log.read_text(), "\n".join(words) + "\nnote=" + b"n\xfe\n".hex() + "\n")

    def test_without_the_typescript_program_python_serves(self):
        log = self.case / "exec.log"
        bare = self.bare_install(self.logging_python(log))
        shutil.rmtree(bare / "libexec")
        done = subprocess.run([str(bare / "bin" / "ardia"), "--version"], env=self.environment({}), capture_output=True, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue(done.stdout.startswith(b"ardia "))
        self.assertIn(b"--version".hex(), log.read_text())

    def test_an_ignored_sigchld_neither_loses_the_status_nor_reaches_the_child(self):
        reports = (f'#!/bin/sh\nexec "{self.python}" -I -c "import signal, sys; print(signal.getsignal(signal.SIGCHLD) == signal.SIG_IGN)"\n')
        bare = self.bare_install(reports, with_ts=False, served="windows ts\n")
        (bare / "libexec").mkdir()
        child = bare / "libexec" / "ardia-ts"
        child.write_text(f'#!/bin/sh\nexec "{self.python}" -I -c "import os, signal, sys; sys.exit(int(os.environ[\'CODE\']) if signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL else 9)"\n')
        child.chmod(0o755)
        for ignored in (False, True):
            for code, expected in (("253", (0, f"{ignored}\n".encode())), ("7", (7, b""))):
                with self.subTest(ignored=ignored, code=code):
                    def prepare():
                        if ignored:
                            signal.signal(signal.SIGCHLD, signal.SIG_IGN)

                    done = subprocess.run([str(bare / "bin" / "ardia"), "windows"], env=self.environment({"CODE": code}), capture_output=True,
                                          preexec_fn=prepare, timeout=30)
                    self.assertEqual((done.returncode, done.stdout), expected, done.stderr)

    def test_the_typescript_program_refuses_to_run_without_the_router(self):
        program = self.root / "libexec" / "ardia-ts.bin"
        caller = b'{"name":"x"}'.hex()
        read_end, write_end = os.pipe()
        regular = os.open(self.case / "regular", os.O_CREAT | os.O_RDWR)
        good = read_end
        for argv in ([], ["windows"], [f"--ardia-routed=2:2:{good}:7b7d", "windows"], [f"--ardia-routed=2:0:{good}:7b7d", "windows"],
                     [f"--ardia-routed=2:0:{good}:zz", "windows"], ["--ardia-routed=1:0:" + caller, "windows"], [f"--ardia-routed=2:0:{caller}", "windows"],
                     ["windows", f"--ardia-routed=2:0:{good}:{caller}"], [f"--ardia-routed=2:0:0:{caller}", "windows"], [f"--ardia-routed=2:0:1:{caller}", "windows"],
                     [f"--ardia-routed=2:0:{regular}:{caller}", "windows"], [f"--ardia-routed=2:0:900:{caller}", "windows"],
                     [f"--ardia-routed=2:0:{good}:" + b'{"name":[[[]]]}'.hex(), "windows"], [f"--ardia-routed=2:0:{good}:" + (b"[" * 5000).hex(), "windows"]):
            with self.subTest(argv=argv):
                done = subprocess.run([str(program), *argv], env=self.environment({}), capture_output=True, timeout=30, pass_fds=(read_end, regular))
                self.assertEqual((done.returncode, done.stdout, done.stderr), (2, b"", self.not_routed))
        done = subprocess.run([str(program), f"--ardia-routed=2:0:{read_end}:{caller}", "--version"], env=self.environment({}), capture_output=True, timeout=30,
                              pass_fds=(read_end,))
        self.assertEqual((done.returncode, done.stderr), (0, b""))
        self.assertTrue(done.stdout.startswith(b"ardia "))
        for fd in (read_end, write_end, regular):
            os.close(fd)

    def test_an_invalid_served_table_falls_back_to_the_compiled_one(self):
        data = self.case / "data"
        data.mkdir()
        fake = FakeArdia(data / "ArdiaControl.sock", {"hello": {"result": {"app": "Ardia"}}, "windows": {"result": []}})
        log = self.case / "exec.log"
        try:
            for served, by_ts in (("windows ts\ntabs go\n", False), ("windows ts\nwindows ts\n", False), ("windows ts\n", True)):
                with self.subTest(served=served):
                    bare = self.bare_install(self.logging_python(log), served=served)
                    log.unlink(missing_ok=True)
                    done = subprocess.run([str(bare / "bin" / "ardia"), "windows"], env=self.environment({}), capture_output=True, timeout=30)
                    self.assertEqual(done.returncode, 0, done.stderr)
                    self.assertEqual((bare / "ts-ran").exists(), by_ts)
                    self.assertFalse(log.exists(), "Python served it")
        finally:
            fake.close()


class BuildSmoke(unittest.TestCase):
    def test_the_packaging_smoke_runs_leave_no_history_or_telemetry_behind(self):
        script = (CLI / "scripts" / "build.sh").read_text().splitlines()
        runs = [line for line in script if '"$root/bin/ardia"' in line and not line.startswith(("cp ", "chmod ")) and "--version" not in line]
        self.assertTrue(runs)
        for line in runs:
            self.assertRegex(line, r'^ARDIA_CLI_HOME="\$work/[^"]+" ARDIA_TELEMETRY=off "\$root/bin/ardia" ', line)


class Collector(BaseHTTPRequestHandler):
    bodies: list = []

    def do_POST(self):
        Collector.bodies.append(self.rfile.read(int(self.headers["Content-Length"])))
        time.sleep(3)
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):
        pass



if __name__ == "__main__":
    unittest.main()
