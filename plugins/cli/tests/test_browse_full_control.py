import asyncio
import functools
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ardia_cli.browse import commands, help as browse_help
from ardia_cli.browse.connection import failure
from ardia_cli.browse.errors import Gated, Usage

CLI = Path(__file__).resolve().parents[1]
CHROMIUM = os.environ.get("ARDIA_BROWSE_CHROMIUM", "")
UPDATE = "this Ardia's engine doesn't allow it yet"
PAGE = """<!doctype html><title>files</title>
<input type=file id=f multiple><div id=out></div>
<a id=dl href="data:text/plain;base64,aGVsbG8gZG93bmxvYWQ=" download="hello.txt">get</a>
<script>f.onchange=()=>{out.textContent=[...f.files].map(x=>x.name+':'+x.size).join(',')}</script>
"""


class FakePage:
    def __init__(self, target_id, answers):
        self.target_id = target_id
        self.answers = answers
        self.sent = []

    async def send(self, method, params=None, input_event=False, timeout=30, mutation=False):
        self.sent.append((method, params, timeout, mutation))
        answer = self.answers.get(method, {})
        if isinstance(answer, Exception):
            raise answer
        return answer


class FakeState:
    def __init__(self, answers=None):
        self.answers = answers or {}
        self.pages = {"T1": FakePage("T1", self.answers), "T2": FakePage("T2", self.answers)}
        self.browser_sent = []
        state = self

        class Browser:
            async def send(self, method, params=None, session=None, timeout=30, mutation=False):
                state.browser_sent.append((method, params, session, timeout, mutation))
                return state.answers.get(method, {})

        self.browser = Browser()
        self.current = "T1"
        self.extras = {}

    async def connect(self):
        pass

    async def refresh_targets(self):
        return []

    async def page(self, target_id=None):
        return self.pages[target_id or "T1"]

    async def find_tab(self, ref):
        return {"t1": "T1", "t2": "T2", "work": "T2"}[ref]

    def tab_id(self, target_id):
        return "t" + target_id[1:]


def ctx(state, stdin=None):
    return commands.Ctx(state, {}, os.getcwd(), {}, stdin, "cdp")


def cdp(state, *argv, stdin=None):
    return asyncio.run(commands.COMMANDS["cdp"](ctx(state, stdin), list(argv)))


class RawCdp(unittest.TestCase):
    def test_sends_to_the_sessions_tab(self):
        state = FakeState({"Page.getLayoutMetrics": {"cssLayoutViewport": {"clientWidth": 800}}})
        result = cdp(state, "Page.getLayoutMetrics")
        self.assertEqual(state.pages["T1"].sent, [("Page.getLayoutMetrics", {}, 30, True)])
        self.assertEqual(result.data, {"method": "Page.getLayoutMetrics", "target": "t1", "result": {"cssLayoutViewport": {"clientWidth": 800}}})
        self.assertEqual(json.loads(result.text), {"cssLayoutViewport": {"clientWidth": 800}})
        self.assertTrue(result.page_content)

    def test_params_from_flags_and_stdin(self):
        state = FakeState()
        cdp(state, "Runtime.evaluate", "--param", "expression=document.title", "--param", "returnByValue:=true", "--timeout", "5s")
        self.assertEqual(state.pages["T1"].sent[0][:3], ("Runtime.evaluate", {"expression": "document.title", "returnByValue": True}, 5))
        cdp(state, "Runtime.evaluate", "--params", "-", "--param", "awaitPromise:=true", stdin='{"expression": "1+1"}')
        self.assertEqual(state.pages["T1"].sent[1][1], {"expression": "1+1", "awaitPromise": True})

    def test_targets_the_browser_or_another_tab(self):
        state = FakeState({"Browser.getVersion": {"product": "Chrome/1"}})
        result = cdp(state, "Browser.getVersion", "--target", "browser")
        self.assertEqual(state.browser_sent, [("Browser.getVersion", {}, None, 30, True)])
        self.assertEqual(result.data["target"], "browser")
        result = cdp(state, "DOM.getDocument", "--target", "work")
        self.assertEqual(state.pages["T2"].sent[0][0], "DOM.getDocument")
        self.assertEqual(result.data["target"], "t2")

    def test_an_empty_answer_says_done(self):
        result = cdp(FakeState(), "Page.bringToFront")
        self.assertEqual((result.text, result.page_content), ("✓ Page.bringToFront", False))

    def test_bad_input_is_a_usage_error(self):
        for argv, said in ((["page.bad"], "isn't a DevTools method name"), (["Page.x", "extra"], "params go in --params"),
                           (["Page.x", "--params", "[1]"], "must be a JSON object"), (["Page.x", "--param", "nokey"], "--param nokey"),
                           ([], "Usage: ardia browse cdp")):
            with self.assertRaises(Usage) as caught:
                cdp(FakeState(), *argv)
            self.assertIn(said, caught.exception.message, argv)

    def test_an_older_engines_refusal_says_to_update(self):
        refused = failure("Storage.getCookies", SimpleNamespace(detail="ardia: Storage.getCookies isn't allowed for the ardia command", code=-32000))
        state = FakeState({"Storage.getCookies": refused})
        with self.assertRaises(Gated) as caught:
            cdp(state, "Storage.getCookies")
        self.assertTrue(caught.exception.message.startswith("`cdp` needs Storage.getCookies, and " + UPDATE))
        self.assertTrue(caught.exception.message.endswith(": update Ardia"))

    def test_a_borrowed_tab_takes_raw_calls_only_when_named(self):
        from ardia_cli.browse.errors import BrowseError

        state = FakeState()
        state.extras["attached"] = "T1"
        for method in ("Page.navigate", "Runtime.evaluate"):
            with self.assertRaises(BrowseError) as caught:
                cdp(state, method, "--param", "url=https://example.test/")
            self.assertEqual(caught.exception.code, "borrowed_tab")
            self.assertIn("your tab [t1] (picked with `tab active`)", caught.exception.message)
            self.assertIn(f"`ardia browse cdp {method} --target t1`", caught.exception.message)
        self.assertEqual(state.pages["T1"].sent, [])
        state.tab_ids = {"t1": "T1"}
        cdp(state, "Page.navigate", "--param", "url=https://example.test/", "--target", "t1")
        self.assertEqual(state.pages["T1"].sent[0][0], "Page.navigate")

    def test_cdp_is_a_known_mutating_command(self):
        self.assertIn("cdp", commands.MUTATING)
        self.assertIn("cdp", browse_help.COMMANDS)
        self.assertIn("Raw CDP:", browse_help.OVERVIEW)



class CheckedBeforeConnecting(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix="cdpcheck"))
        self.addCleanup(shutil.rmtree, self.temp, True)

    def browse(self, *argv, stdin=""):
        import contextlib
        import io
        from unittest import mock

        from ardia_cli.browse import cli as browse_cli, client

        err = io.StringIO()
        fake_stdin = io.TextIOWrapper(io.BytesIO(stdin if isinstance(stdin, bytes) else stdin.encode("utf-8", "surrogatepass")), encoding="utf-8")
        with mock.patch.dict(os.environ, {"ARDIA_DATA_DIR": str(self.temp), "ARDIA_TELEMETRY": "0"}), \
                mock.patch.object(client, "ensure_daemon", side_effect=AssertionError("connected")), \
                mock.patch("sys.stdin", fake_stdin), contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            status = browse_cli.run(["--port", "9", *argv])
        return status, err.getvalue()

    def test_bad_timeouts_fail_before_connecting(self):
        for value in ("0", "-1", "nan", "inf", "9" * 400, "601s", "11m"):
            status, err = self.browse("cdp", "Page.getLayoutMetrics", "--timeout", value)
            self.assertEqual(status, 1, value)
            self.assertIn("--timeout", err)

    def test_bad_params_fail_before_connecting(self):
        for argv, stdin, said in ((["--params", "-"], b'{"a": "\xff"}', "isn't UTF-8"), (["--params", "-"], b"", "is empty"),
                                  (["--params", '{"a": "\\ud800"}'], "", "lone surrogate"), (["--params", '{"n": NaN}'], "", "NaN"),
                                  (["--params", '{"n": 1e400}'], "", "too large"), (["--params", '{"a": 1, "a": 2}'], "", "twice"),
                                  (["--param", "n:=Infinity"], "", "Infinity"),
                                  (["--params", "-"], json.dumps({"q": "é" * 600000}, ensure_ascii=False).encode(), "over 1 MB")):
            status, err = self.browse("cdp", "Runtime.evaluate", *argv, stdin=stdin)
            self.assertEqual(status, 1, argv)
            self.assertIn(said, err, argv)
            self.assertNotIn("Traceback", err)

    def test_a_huge_timeout_never_overflows_the_client_deadline(self):
        import math

        from ardia_cli.browse import limits

        for argv in (["cdp", "Page.x", "--timeout", "9" * 400], ["wait", "--timeout", "9" * 300], ["script", "--timeout", "1e5"]):
            self.assertTrue(math.isfinite(limits.answer_deadline({"argv": argv})), argv)
            self.assertLess(limits.answer_deadline({"argv": argv}), 10 ** 7)

class OlderEngine(unittest.TestCase):
    def test_upload_and_download_say_update_ardia(self):
        for method, command in (("DOM.setFileInputFiles", "upload"), ("Browser.setDownloadBehavior", "download"),
                                ("Browser.setDownloadBehavior", "wait --download"), ("Network.getCookies", "cookies get")):
            error = Gated(method, command)
            self.assertEqual(error.message, f"`{command}` needs {method}, and {UPDATE} ({method} isn't allowed for the ardia command): update Ardia")
            self.assertEqual((error.code, error.data), ("policy_refused", {"method": method, "reason": ""}))
            for old in ("once the engine's token policy allows it", "--port", "on purpose"):
                self.assertNotIn(old, error.message)

    def test_the_engines_refusal_reaches_the_command(self):
        for method in ("DOM.setFileInputFiles", "Browser.setDownloadBehavior"):
            refused = failure(method, SimpleNamespace(detail=f"ardia: {method} isn't allowed for the ardia command", code=-32000))
            self.assertIsInstance(refused, Gated)
            self.assertIn("update Ardia", refused.during("upload").message)

    def test_help_no_longer_calls_anything_gated(self):
        text = browse_help.OVERVIEW + "".join(browse_help.COMMANDS.values())
        for old in ("(gated", "Gated by", "gated by", "doesn't allow yet", "not allowed by Ardia's policy"):
            self.assertNotIn(old, text)
        self.assertIn("update Ardia", browse_help.OVERVIEW)
        self.assertIn("DOM.setFileInputFiles", browse_help.COMMANDS["upload"])
        self.assertIn("wait --download", browse_help.COMMANDS["download"])

    def test_webui_pages_are_tabs_and_open_as_is(self):
        from ardia_cli.browse.state import PAGE_SCHEMES

        for url in ("chrome://settings/", "chrome-extension://abc/popup.html", "devtools://devtools/bundled/inspector.html"):
            self.assertTrue(url.startswith(PAGE_SCHEMES), url)
            self.assertEqual(commands.normalize_url(url), url)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@unittest.skipUnless(CHROMIUM, "set ARDIA_BROWSE_CHROMIUM to a Chromium binary (run headless) to test against a plain DevTools server")
class PlainDevToolsServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        base = Path.home() / "ardia-scratch"
        cls.temp = Path(tempfile.mkdtemp(prefix="fullcontrol", dir=base if base.is_dir() else None))
        (cls.temp / "site").mkdir()
        (cls.temp / "site" / "page.html").write_text(PAGE)
        (cls.temp / "up.txt").write_text("upload me\n")
        handler = functools.partial(QuietHandler, directory=str(cls.temp / "site"))
        cls.http = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.http.serve_forever, daemon=True).start()
        cls.port = free_port()
        cls.chromium = subprocess.Popen([CHROMIUM, "--headless=new", f"--remote-debugging-port={cls.port}", f"--user-data-dir={cls.temp / 'profile'}",
                                         "--no-first-run", "--no-default-browser-check", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                socket.create_connection(("127.0.0.1", cls.port), 0.5).close()
                break
            except OSError:
                time.sleep(0.2)
        (cls.temp / "data").mkdir()
        cls.env = dict(os.environ, ARDIA_DATA_DIR=str(cls.temp / "data"), ARDIA_TELEMETRY="0", PYTHONPATH=str(CLI))
        cls.url = f"http://127.0.0.1:{cls.http.server_address[1]}/page.html"
        for session in ("warm", "warm-again"):
            cls.browse("open", cls.url, session=session, check=False)

    @classmethod
    def tearDownClass(cls):
        for session in ("warm", "warm-again", "up", "dl", "raw", "ui", "fw", "fk", "bo", "bb"):
            cls.browse("close", session=session, check=False)
        cls.chromium.terminate()
        try:
            cls.chromium.wait(10)
        except subprocess.TimeoutExpired:
            cls.chromium.kill()
        cls.http.shutdown()
        shutil.rmtree(cls.temp, True)

    @classmethod
    def browse(cls, *args, session, check=True, stdin=None):
        done = subprocess.run([sys.executable, "-m", "ardia_cli", "browse", "--port", str(cls.port), "--session", session, *args],
                              capture_output=True, text=True, timeout=90, env=cls.env, input=stdin)
        if check and done.returncode != 0:
            raise AssertionError(f"{args}: {done.returncode}\n{done.stdout}\n{done.stderr}")
        return done

    def test_upload_sets_the_inputs_files(self):
        self.browse("open", self.url, session="up")
        done = self.browse("upload", "#f", str(self.temp / "up.txt"), str(self.temp / "site" / "page.html"), session="up")
        self.assertIn("2 files", done.stdout)
        self.assertEqual(self.browse("get", "text", "#out", session="up").stdout.strip(), f"up.txt:10,page.html:{len(PAGE)}")

    def test_download_saves_the_file(self):
        self.browse("open", self.url, session="dl")
        target = self.temp / "saved.txt"
        self.browse("download", "#dl", str(target), session="dl")
        self.assertEqual(target.read_text(), "hello download")

    def test_wait_download_catches_the_next_one(self):
        self.browse("open", self.url, session="fw")
        tab = next(row["tabId"] for row in json.loads(self.browse("tab", "list", "--json", session="fw").stdout)["data"]["tabs"] if row["url"] == self.url)
        self.browse("tab", tab, session="fk")
        target = self.temp / "waited.txt"
        waiting = subprocess.Popen([sys.executable, "-m", "ardia_cli", "browse", "--port", str(self.port), "--session", "fw", "wait", "--download", str(target),
                                    "--timeout", "20000"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env)
        time.sleep(2)
        self.browse("eval", "document.getElementById('dl').click()", session="fk")
        out, err = waiting.communicate(timeout=40)
        self.assertEqual(waiting.returncode, 0, err)
        self.assertEqual(target.read_text(), "hello download")

    def test_raw_cdp(self):
        self.browse("open", self.url, session="raw")
        said = json.loads(self.browse("cdp", "Runtime.evaluate", "--param", "expression=document.title", "--param", "returnByValue:=true", "--json", session="raw").stdout)
        self.assertEqual(said["data"]["result"]["result"]["value"], "files")
        version = json.loads(self.browse("cdp", "Browser.getVersion", "--target", "browser", "--json", session="raw").stdout)
        self.assertIn("Chrome", version["data"]["result"]["product"])
        piped = self.browse("cdp", "Runtime.evaluate", "--params", "-", stdin='{"expression": "6*7", "returnByValue": true}', session="raw")
        self.assertEqual(json.loads(piped.stdout)["result"]["value"], 42)
        failed = self.browse("cdp", "Nope.method", check=False, session="raw")
        self.assertEqual(failed.returncode, 1)
        self.assertIn("Nope.method", failed.stderr)

    def test_raw_cdp_leaves_a_borrowed_tab_alone_unless_named(self):
        self.browse("open", self.url + "?borrowed", session="bo")
        picked = json.loads(self.browse("tab", "active", "--json", session="bb").stdout)["data"]
        mine, before = picked["tabId"], picked["url"]
        refused = self.browse("cdp", "Page.navigate", "--param", "url=about:blank#moved", "--json", check=False, session="bb")
        self.assertEqual(refused.returncode, 1)
        said = json.loads(refused.stdout)
        self.assertEqual(said["code"], "borrowed_tab")
        self.assertIn(f"--target {mine}", said["error"])
        named = self.browse("cdp", "Runtime.evaluate", "--param", "expression=location.href", "--param", "returnByValue:=true",
                            "--target", mine, session="bb")
        self.assertEqual(json.loads(named.stdout)["result"]["value"], before)

    def test_webui_tab_is_listed(self):
        self.browse("tab", "new", "chrome://version", session="ui")
        self.assertEqual(self.browse("get", "url", session="ui").stdout.strip(), "chrome://version/")
        self.assertIn("chrome://version/", self.browse("tab", "list", session="ui").stdout)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    unittest.main()
