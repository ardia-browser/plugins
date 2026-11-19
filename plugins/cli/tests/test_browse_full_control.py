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
                if method == "Target.attachToTarget":
                    state.attaches += 1
                    return {"sessionId": f"S-{params['targetId']}-{state.attaches}"}
                if method == "Target.attachToBrowserTarget":
                    state.attaches += 1
                    return {"sessionId": f"S-browser-{state.attaches}"}
                answer = state.answers.get(method, {})
                if isinstance(answer, Exception):
                    raise answer
                return answer

        self.attaches = 0
        self.page_calls = []
        self.browser = Browser()
        self.current = "T1"
        self.extras = {}
        from ardia_cli.browse.tabs import Registry

        self.registry = Registry(None, "k", "fake")
        self.instance = None

    async def connect(self):
        pass

    async def refresh_targets(self):
        return []

    async def page(self, target_id=None):
        self.page_calls.append(target_id)
        return self.pages[target_id or "T1"]

    async def find_tab(self, ref):
        return {"t1": "T1", "t2": "T2", "work": "T2"}[ref]

    def tab_id(self, target_id):
        return "t" + target_id[1:]


class LinkSocket:
    def __init__(self):
        self.sent = []
        self.inbox = asyncio.Queue()

    async def send(self, text):
        self.sent.append(json.loads(text))

    def __aiter__(self):
        return self

    async def __anext__(self):
        message = await self.inbox.get()
        if message is None:
            raise StopAsyncIteration
        return json.dumps(message)

    async def close(self):
        self.inbox.put_nowait(None)

    def methods(self, name):
        return [message for message in self.sent if message["method"] == name]


def linked_browser():
    from ardia_cli.browse.connection import Browser
    from ardia_cli.cdp import Connection

    browser = Browser(None, lambda *event: None)
    browser.link = Connection("ws://fake")
    browser.link.socket = LinkSocket()
    browser.link.reader = asyncio.ensure_future(browser.link._read())
    return browser, browser.link.socket


async def settle(rounds=50):
    for _ in range(rounds):
        await asyncio.sleep(0)


def raw_sent(state):
    return [row for row in state.browser_sent if not row[0].startswith("Target.attachTo")]


def ctx(state, stdin=None):
    return commands.Ctx(state, {}, os.getcwd(), {}, stdin, "cdp")


def cdp(state, *argv, stdin=None):
    return asyncio.run(commands.COMMANDS["cdp"](ctx(state, stdin), list(argv)))


class RawCdp(unittest.TestCase):
    def test_sends_to_the_sessions_tab(self):
        state = FakeState({"Page.getLayoutMetrics": {"cssLayoutViewport": {"clientWidth": 800}}})
        result = cdp(state, "Page.getLayoutMetrics")
        self.assertEqual(raw_sent(state), [("Page.getLayoutMetrics", {}, "S-T1-1", 30, True)])
        self.assertEqual(state.pages["T1"].sent, [])
        self.assertEqual(result.data, {"method": "Page.getLayoutMetrics", "target": "t1", "session": "attached",
                                       "result": {"cssLayoutViewport": {"clientWidth": 800}}})
        self.assertEqual(json.loads(result.text), {"cssLayoutViewport": {"clientWidth": 800}})
        self.assertTrue(result.page_content)

    def test_params_from_flags_and_stdin(self):
        state = FakeState()
        cdp(state, "Runtime.evaluate", "--param", "expression=document.title", "--param", "returnByValue:=true", "--timeout", "5s")
        self.assertEqual(raw_sent(state)[0][:4], ("Runtime.evaluate", {"expression": "document.title", "returnByValue": True}, "S-T1-1", 5))
        cdp(state, "Runtime.evaluate", "--params", "-", "--param", "awaitPromise:=true", stdin='{"expression": "1+1"}')
        self.assertEqual(raw_sent(state)[1][1], {"expression": "1+1", "awaitPromise": True})

    def test_targets_the_browser_or_another_tab(self):
        state = FakeState({"Browser.getVersion": {"product": "Chrome/1"}})
        result = cdp(state, "Browser.getVersion", "--target", "browser")
        self.assertEqual(raw_sent(state), [("Browser.getVersion", {}, "S-browser-1", 30, True)])
        self.assertEqual(result.data["target"], "browser")
        result = cdp(state, "DOM.getDocument", "--target", "work")
        self.assertEqual(raw_sent(state)[1][:3], ("DOM.getDocument", {}, "S-T2-2"))
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
        self.assertEqual(state.browser_sent, [])
        cdp(state, "Page.navigate", "--param", "url=https://example.test/", "--target", "t1")
        self.assertEqual(raw_sent(state)[0][0], "Page.navigate")

    def test_raw_calls_get_their_own_session_kept_for_the_connection(self):
        state = FakeState()
        first = cdp(state, "Runtime.disable")
        second = cdp(state, "Runtime.enable")
        self.assertEqual((first.data["session"], second.data["session"]), ("attached", "kept"))
        self.assertEqual([row[2] for row in raw_sent(state)], ["S-T1-1", "S-T1-1"])
        self.assertEqual(state.pages["T1"].sent, [])
        self.assertNotIn("notice", state.extras)

    def test_a_reopened_connection_gets_a_fresh_raw_session_and_says_so(self):
        state = FakeState()
        cdp(state, "Runtime.enable")
        cdp(state, "Runtime.enable", "--target", "browser")
        old_browser = state.browser
        state.browser = type(old_browser)()
        again = cdp(state, "Runtime.evaluate")
        self.assertEqual(again.data["session"], "reattached")
        self.assertIn("off again", state.extras["notice"])
        self.assertEqual(raw_sent(state)[-1][2], "S-T1-3")
        state.extras.pop("notice")
        self.assertEqual(cdp(state, "Runtime.evaluate").data["session"], "kept")
        self.assertEqual(cdp(state, "Browser.getVersion", "--target", "browser").data["session"], "reattached")

    def test_a_detached_raw_session_is_attached_again(self):
        from ardia_cli.browse import rawcdp

        state = FakeState()
        cdp(state, "Runtime.enable")
        rawcdp.forget_session(state, "S-T1-1")
        self.assertEqual(cdp(state, "Runtime.evaluate").data["session"], "reattached")
        rawcdp.forget_target(state, "T1")
        self.assertEqual(cdp(state, "Runtime.evaluate").data["session"], "attached")

    def test_a_session_ardia_already_dropped_is_replaced_once(self):
        from ardia_cli.browse.errors import CdpError

        state = FakeState()
        cdp(state, "Runtime.enable")
        state.answers["Runtime.evaluate"] = CdpError("Runtime.evaluate", "Session with given id not found.")
        original = state.browser.send

        async def send(method, params=None, session=None, timeout=30, mutation=False):
            if method == "Runtime.evaluate" and session == "S-T1-2":
                state.browser_sent.append((method, params, session, timeout, mutation))
                return {"value": 1}
            return await original(method, params, session, timeout, mutation)

        state.browser.send = send
        result = cdp(state, "Runtime.evaluate")
        self.assertEqual((result.data["session"], result.data["result"]), ("reattached", {"value": 1}))

    def test_without_a_browser_session_browser_calls_share_the_root(self):
        from ardia_cli.browse.errors import CdpError

        state = FakeState({"Browser.getVersion": {"product": "x"}})
        original = state.browser.send

        async def send(method, params=None, session=None, timeout=30, mutation=False):
            if method == "Target.attachToBrowserTarget":
                raise CdpError(method, "Not allowed")
            return await original(method, params, session, timeout, mutation)

        state.browser.send = send
        self.assertEqual(cdp(state, "Browser.getVersion", "--target", "browser").data["session"], "shared")
        self.assertEqual(raw_sent(state)[-1][2], None)
        self.assertEqual(cdp(state, "Browser.getVersion", "--target", "browser").data["session"], "shared")

    def test_an_empty_target_is_refused_not_sent_to_the_current_tab(self):
        for value in ("", " ", "\t"):
            state = FakeState()
            with self.assertRaises(Usage) as caught:
                cdp(state, "Runtime.evaluate", f"--target={value}")
            self.assertIn("--target", caught.exception.message)
            self.assertEqual(state.browser_sent, [])
            with self.assertRaises(Usage):
                cdp(state, "Runtime.evaluate", "--target", value)
            self.assertEqual(state.browser_sent, [])

    def test_a_named_tab_gets_only_the_raw_session(self):
        state = FakeState()
        cdp(state, "Runtime.evaluate", "--target", "t2")
        self.assertNotIn("T2", state.page_calls)
        self.assertEqual(state.pages["T2"].sent, [])
        self.assertEqual([row[0] for row in state.browser_sent], ["Target.attachToTarget", "Runtime.evaluate"])

    def test_ardias_own_stale_session_error_is_replaced_once(self):
        from ardia_cli.browse.errors import CdpError

        stale = (CdpError("Runtime.evaluate", "ardia: no attached session has that sessionId"),
                 CdpError("Runtime.evaluate", "No session with given id"),
                 failure("Runtime.evaluate", SimpleNamespace(detail="gone", code=-32001)))
        for error in stale:
            state = FakeState()
            cdp(state, "Runtime.enable")
            state.answers["Runtime.evaluate"] = error
            original = state.browser.send

            async def send(method, params=None, session=None, timeout=30, mutation=False, original=original, state=state):
                if method == "Runtime.evaluate" and session == "S-T1-2":
                    state.browser_sent.append((method, params, session, timeout, mutation))
                    return {"value": 1}
                return await original(method, params, session, timeout, mutation)

            state.browser.send = send
            result = cdp(state, "Runtime.evaluate")
            self.assertEqual((result.data["session"], result.data["result"]), ("reattached", {"value": 1}), error.cdp_message)
        state = FakeState({"Runtime.evaluate": CdpError("Runtime.evaluate", "Invalid parameters")})
        with self.assertRaises(CdpError):
            cdp(state, "Runtime.evaluate")
        self.assertEqual(state.attaches, 1)

    def test_a_session_created_after_the_attach_was_given_up_is_detached(self):
        from unittest import mock

        from ardia_cli.browse import rawcdp
        from ardia_cli.browse.errors import CdpTimeout

        def slow_state():
            state = FakeState()
            state.replies = []
            original = state.browser.send

            async def send(method, params=None, session=None, timeout=30, mutation=False):
                if method == "Target.attachToTarget":
                    state.browser_sent.append((method, params, session, timeout, mutation))
                    reply = asyncio.get_running_loop().create_future()
                    state.replies.append(reply)
                    await asyncio.wait_for(asyncio.shield(reply), timeout)
                    return {"sessionId": "S-late"}
                return await original(method, params, session, timeout, mutation)

            state.browser.send = send
            return state

        async def cancelled():
            state = slow_state()
            call = asyncio.ensure_future(commands.COMMANDS["cdp"](ctx(state), ["Runtime.evaluate"]))
            while not state.replies:
                await asyncio.sleep(0)
            call.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await call
            state.replies[0].set_result(None)
            for _ in range(20):
                await asyncio.sleep(0)
            return state

        async def timed_out():
            state = slow_state()
            with mock.patch.object(rawcdp, "ATTACH_TIMEOUT", 0.05):
                with self.assertRaises(CdpTimeout):
                    await commands.COMMANDS["cdp"](ctx(state), ["Runtime.evaluate"])
            state.replies[0].set_result(None)
            for _ in range(20):
                await asyncio.sleep(0)
            return state

        for run in (cancelled, timed_out):
            state = asyncio.run(run())
            cached = "S-late" in rawcdp.of(state).sessions.values()
            detached = ("Target.detachFromTarget", {"sessionId": "S-late"}) in [row[:2] for row in state.browser_sent]
            self.assertTrue(cached or detached, (run.__name__, state.browser_sent))

    def test_an_attach_answered_after_any_wait_is_detached(self):
        from unittest import mock

        from ardia_cli.browse import rawcdp
        from ardia_cli.browse.errors import CdpTimeout

        async def late(argv, give_up):
            state = FakeState()
            state.browser, sock = linked_browser()
            with mock.patch.object(rawcdp, "ATTACH_TIMEOUT", 0.05), mock.patch.object(rawcdp, "LATE_ATTACH_GRACE", 0.05, create=True):
                call = asyncio.ensure_future(commands.COMMANDS["cdp"](ctx(state), argv))
                while not sock.sent:
                    await asyncio.sleep(0)
                if give_up == "cancel":
                    call.cancel()
                with self.assertRaises((asyncio.CancelledError, CdpTimeout)):
                    await call
                await asyncio.sleep(0.3)
            sock.inbox.put_nowait({"id": sock.sent[0]["id"], "result": {"sessionId": "S-late"}})
            await settle()
            detached = [message["params"] for message in sock.methods("Target.detachFromTarget")]
            await state.browser.close()
            return detached, rawcdp.of(state).sessions

        for argv in (["Runtime.evaluate"], ["Browser.getVersion", "--target", "browser"]):
            for give_up in ("cancel", "timeout"):
                detached, sessions = asyncio.run(late(argv, give_up))
                self.assertEqual(detached, [{"sessionId": "S-late"}], (argv, give_up))
                self.assertNotIn("S-late", sessions.values(), (argv, give_up))

    def test_the_pages_own_attach_answered_late_is_detached(self):
        from unittest import mock

        from ardia_cli.browse import connection
        from ardia_cli.browse.page import Page

        async def late(give_up):
            state = SimpleNamespace(sessions={})
            browser, sock = linked_browser()
            page = Page(state, "T1")
            with mock.patch.object(connection, "ATTACH_WAIT", 0.05, create=True):
                attaching = asyncio.ensure_future(page.attach(browser))
                while not sock.sent:
                    await asyncio.sleep(0)
                if give_up == "cancel":
                    attaching.cancel()
                with self.assertRaises((asyncio.CancelledError, asyncio.TimeoutError, connection.CdpTimeout)):
                    await asyncio.wait_for(attaching, 1)
                await asyncio.sleep(0.2)
            sock.inbox.put_nowait({"id": sock.sent[0]["id"], "result": {"sessionId": "S-page-late"}})
            await settle()
            detached = [message["params"] for message in sock.methods("Target.detachFromTarget")]
            await browser.close()
            return detached, state.sessions, page.session_id

        for give_up in ("cancel", "timeout"):
            detached, sessions, session = asyncio.run(late(give_up))
            self.assertEqual(detached, [{"sessionId": "S-page-late"}], give_up)
            self.assertEqual((sessions, session), ({}, None), give_up)

    def test_the_notice_says_whether_the_connection_or_only_the_session_changed(self):
        from ardia_cli.browse import rawcdp
        from ardia_cli.browse.errors import CdpError

        state = FakeState()
        cdp(state, "Runtime.enable")
        rawcdp.forget_session(state, "S-T1-1")
        self.assertEqual(cdp(state, "Runtime.evaluate").data["session"], "reattached")
        self.assertIn("same DevTools connection", state.extras.pop("notice"))
        state.browser = type(state.browser)()
        self.assertEqual(cdp(state, "Runtime.evaluate").data["session"], "reattached")
        self.assertIn("connection was reopened", state.extras.pop("notice"))
        state.answers["Runtime.evaluate"] = CdpError("Runtime.evaluate", "No session with given id")
        original = state.browser.send

        async def send(method, params=None, session=None, timeout=30, mutation=False):
            if method == "Runtime.evaluate" and session != "S-T1-3":
                state.browser_sent.append((method, params, session, timeout, mutation))
                return {"value": 1}
            return await original(method, params, session, timeout, mutation)

        state.browser.send = send
        self.assertEqual(cdp(state, "Runtime.evaluate").data["session"], "reattached")
        notice = state.extras.pop("notice")
        self.assertIn("same DevTools connection", notice)
        self.assertNotIn("reopened", notice)

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

    def test_an_empty_target_fails_before_connecting(self):
        for argv in (["--target="], ["--target", ""], ["--target", "  "]):
            status, err = self.browse("cdp", "Runtime.evaluate", *argv)
            self.assertEqual(status, 1, argv)
            self.assertIn("--target", err)

    def test_finite_deadlines_are_what_they_were_before_the_cap(self):
        from ardia_cli.browse import limits

        def before(payload):
            argv = payload.get("argv") or [""]
            options = payload.get("options") or {}
            timeout = float(options.get("timeout_ms") or limits.DEFAULT_TIMEOUT_MS) / 1000
            name, rest = str(argv[0]), [str(arg) for arg in argv[1:]]
            waits = max(limits.queue_wait(name, rest, patient=bool(payload.get("patient_queue"))), limits.BEHIND_SCRIPT_WAIT)
            return waits + limits.command_limit(name, rest, timeout) + limits.LIMIT_MARGIN

        payloads = [{"argv": ["wait", "86400000"]}, {"argv": ["wait", "86399999"]}, {"argv": ["wait", "86400001"]},
                    {"argv": ["wait", "--text", "x", "--timeout", "86400000"]}, {"argv": ["wait", "x"], "options": {"timeout_ms": 86400000}},
                    {"argv": ["wait", "x"], "options": {"timeout_ms": 10 ** 12}}, {"argv": ["script", "--timeout", "1d"]},
                    {"argv": ["script", "--timeout", "1440m"]}, {"argv": ["script", "--timeout", "86399s"]},
                    {"argv": ["read", "a", "--timeout", "86400s"], "patient_queue": True}, {"argv": ["cdp", "Page.x", "--timeout", "10m"]},
                    {"argv": ["get", "url"], "options": {"timeout_ms": "inf"}}, {"argv": ["click", "@e1"]}]
        for payload in payloads:
            self.assertEqual(limits.answer_deadline(payload), before(payload), payload)
        self.assertEqual(limits.answer_deadline({"argv": ["wait", "86400000"]}), 300 + 86430 + 30)
        self.assertEqual(limits.answer_deadline({"argv": ["script", "--timeout", "1440m"]}), 172860)

    def test_an_unbounded_deadline_is_capped_above_the_daemons_budget(self):
        import math
        import socket as sockets

        from ardia_cli.browse import limits

        for payload in ({"argv": ["wait", "x"], "options": {"timeout_ms": "inf"}}, {"argv": ["wait", "--text", "x"], "options": {"timeout_ms": "1e400"}},
                        {"argv": ["wait", "x"], "options": {"timeout_ms": 10 ** 16}}, {"argv": ["cdp", "Page.x"], "options": {"timeout_ms": "1e300"}},
                        {"argv": ["read", "a"], "options": {"timeout_ms": "inf"}, "patient_queue": True}):
            deadline = limits.answer_deadline(payload)
            self.assertTrue(math.isfinite(deadline), payload)
            probe = sockets.socket()
            probe.settimeout(deadline)
            probe.close()
            name, rest = payload["argv"][0], payload["argv"][1:]
            timeout = float(payload["options"]["timeout_ms"]) / 1000
            budget = limits.command_limit(name, rest, timeout)
            allowance = max(limits.queue_wait(name, rest, patient=bool(payload.get("patient_queue"))), limits.BEHIND_SCRIPT_WAIT)
            self.assertTrue(math.isfinite(budget), payload)
            self.assertGreaterEqual(deadline, budget + allowance, payload)

    def test_flags_are_checked_before_stdin_is_read(self):
        import contextlib
        import io
        from unittest import mock

        from ardia_cli.browse import cli as browse_cli, client

        class Unread(io.StringIO):
            def read(self, *args):
                raise AssertionError("stdin was read")

            def isatty(self):
                return False

        for argv in (["--target=", "--params", "-"], ["--params", "-", "--timeout", "0"], ["--params", "-", "--target", " "]):
            err = io.StringIO()
            with mock.patch.dict(os.environ, {"ARDIA_DATA_DIR": str(self.temp), "ARDIA_TELEMETRY": "0"}), \
                    mock.patch.object(client, "ensure_daemon", side_effect=AssertionError("connected")), \
                    mock.patch("sys.stdin", Unread()), contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
                status = browse_cli.run(["--port", "9", "cdp", "Runtime.evaluate", *argv])
            self.assertEqual(status, 1, argv)
            self.assertNotIn("stdin was read", err.getvalue(), argv)
            self.assertIn("--t", err.getvalue(), argv)

    def test_a_huge_timeout_never_overflows_the_client_deadline(self):
        import math

        from ardia_cli.browse import limits

        for argv in (["cdp", "Page.x", "--timeout", "9" * 400], ["wait", "--timeout", "9" * 300], ["script", "--timeout", "1e5"]):
            self.assertTrue(math.isfinite(limits.answer_deadline({"argv": argv})), argv)
            self.assertLess(limits.answer_deadline({"argv": argv}), 10 ** 7)


class TargetHold(unittest.TestCase):
    def registries(self):
        from ardia_cli.browse import paths
        from ardia_cli.browse.tabs import Registry

        folder = Path(tempfile.mkdtemp(prefix="hold"))
        self.addCleanup(shutil.rmtree, folder, True)
        fd = paths.browse_dir(folder)
        self.addCleanup(os.close, fd)
        for key in ("ka", "kb"):
            self.addCleanup(os.close, paths.take_lock(f"{key}.lock", fd))
        return Registry(fd, "ka", "one"), Registry(fd, "kb", "two")

    def test_a_held_tab_cant_be_closed_by_its_owner_until_the_call_ends(self):
        one, two = self.registries()
        one.note_opened("I", "A")
        two.note_using("I", "B")
        with two.holding("I", "A"):
            self.assertFalse(one.reserve_close("I", "A"))
            self.assertEqual(one.others("I")[1], {"B": ["two"], "A": ["two"]})
            self.assertEqual(two.others("I")[1], {})
        self.assertEqual(one.others("I")[1], {"B": ["two"]})
        self.assertTrue(one.reserve_close("I", "A"))

    def test_a_tab_being_closed_cant_be_held(self):
        from ardia_cli.browse.errors import BrowseError

        one, two = self.registries()
        one.note_opened("I", "A")
        self.assertTrue(one.reserve_close("I", "A"))
        with self.assertRaises(BrowseError) as caught:
            with two.holding("I", "A"):
                pass
        self.assertEqual(caught.exception.code, "tab_closing")

    def test_forget_drops_holds_left_behind(self):
        one, two = self.registries()
        one.note_opened("I", "A")
        hold = two.holding("I", "A")
        hold.__enter__()
        two.forget()
        self.assertTrue(one.reserve_close("I", "A"))

    def test_cdp_holds_a_target_tab_for_the_call(self):
        state = FakeState()
        held = []

        class Registry:
            def holding(self, instance, target):
                import contextlib

                @contextlib.contextmanager
                def hold():
                    held.append(("on", target))
                    yield
                    held.append(("off", target))

                return hold()

        state.registry = Registry()
        state.instance = "I"
        original = state.browser.send

        async def send(method, *args, **kwargs):
            held.append(("send", method))
            return await original(method, *args, **kwargs)

        state.browser.send = send
        cdp(state, "Runtime.evaluate", "--target", "t2")
        self.assertEqual(held, [("on", "T2"), ("send", "Target.attachToTarget"), ("send", "Runtime.evaluate"), ("off", "T2")])
        held.clear()
        cdp(state, "Runtime.evaluate")
        self.assertEqual([row for row in held if row[0] != "send"], [])


class LargeResults(unittest.TestCase):
    def test_text_mode_prints_the_whole_result_never_part_of_it(self):
        from ardia_cli.browse import daemon

        state = FakeState({"Runtime.evaluate": {"result": {"type": "string", "value": "x" * 20000}}})
        result = cdp(state, "Runtime.evaluate")
        for options in ({}, {"max_output": 100}):
            code, out, err = daemon.render(options, result=result, name="cdp")
            self.assertEqual((code, err), (0, ""))
            self.assertNotIn(daemon.CAP_NOTICE, out)
            self.assertEqual(json.loads(out)["result"]["value"], "x" * 20000)
        code, out, err = daemon.render({}, result=commands.Result({}, "y" * 20000), name="get")
        self.assertIn(daemon.CAP_NOTICE, out)

    def test_an_answer_over_the_daemon_limit_says_what_cdp_did(self):
        from unittest import mock

        from ardia_cli.browse import daemon

        with mock.patch.object(daemon, "MAX_RESPONSE", 1000):
            answer = json.loads(daemon.encode_answer(0, "z" * 2000, "", name="cdp"))
            self.assertEqual(answer["exit"], 1)
            self.assertEqual(answer.get("code"), "result_too_large")
            self.assertIn("The result of `cdp`", answer["err"])
            self.assertIn("it did run", answer["err"])
            self.assertNotIn("snapshot -s", answer["err"])
            other = json.loads(daemon.encode_answer(0, "z" * 2000, "", name="snapshot"))
            self.assertIn("snapshot -s", other["err"])

    @unittest.expectedFailure
    def test_a_redacted_token_keeps_the_result_valid_json(self):
        from ardia_cli.browse import daemon

        state = FakeState({"Runtime.evaluate": {"result": {"type": "string", "value": 'https://example.test/?token=abc"tail'}}})
        result = cdp(state, "Runtime.evaluate")
        for options in ({}, {"json": True}):
            code, out, err = daemon.render(options, result=result, name="cdp")
            self.assertEqual(code, 0)
            json.loads(out)

    def test_json_callers_get_result_too_large_as_an_error_object(self):
        import contextlib
        import io
        from unittest import mock

        from ardia_cli.browse import cli as browse_cli, client, daemon

        temp = Path(tempfile.mkdtemp(prefix="cdpbig"))
        self.addCleanup(shutil.rmtree, temp, True)

        def fake_daemon(*_):
            ours, theirs = socket.socketpair()

            def serve():
                with theirs, theirs.makefile("rb") as reader:
                    request = json.loads(reader.readline())
                    theirs.sendall(daemon.encode_reply(request, 0, "z" * 2000, ""))

            threading.Thread(target=serve, daemon=True).start()
            return ours

        for as_json in (True, False):
            out, err = io.StringIO(), io.StringIO()
            with mock.patch.dict(os.environ, {"ARDIA_DATA_DIR": str(temp), "ARDIA_TELEMETRY": "0"}), \
                    mock.patch.object(client, "ensure_daemon", fake_daemon), mock.patch.object(daemon, "MAX_RESPONSE", 1000), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                status = browse_cli.run(["--port", "9", "cdp", "Runtime.evaluate", *(["--json"] if as_json else [])])
            self.assertEqual(status, 1)
            if as_json:
                said = json.loads(out.getvalue())
                self.assertEqual((said["success"], said["code"]), (False, "result_too_large"))
                self.assertIn("it did run", said["error"])
                self.assertEqual(err.getvalue(), "")
            else:
                self.assertEqual(out.getvalue(), "")
                self.assertIn("it did run", err.getvalue())

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
        for session in ("warm", "warm-again", "up", "dl", "raw", "ui", "fw", "fk", "bo", "bb", "ho", "hc", "rs", "big", "da", "db"):
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

    def test_a_tab_named_by_target_stays_open_for_the_call(self):
        opened = json.loads(self.browse("tab", "new", self.url + "?held", "--json", session="ho").stdout)["data"]["tabId"]
        slow = subprocess.Popen([sys.executable, "-m", "ardia_cli", "browse", "--port", str(self.port), "--session", "hc", "cdp", "Runtime.evaluate",
                                 "--param", "expression=new Promise(r => setTimeout(() => r(7), 4000))", "--param", "awaitPromise:=true",
                                 "--param", "returnByValue:=true", "--target", opened], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            rows = json.loads(self.browse("tab", "list", "--json", session="ho").stdout)["data"]["tabs"]
            if any(row["tabId"] == opened and "hc" in row.get("usedBy", []) for row in rows):
                break
            time.sleep(0.2)
        refused = self.browse("tab", "close", opened, "--json", check=False, session="ho")
        out, err = slow.communicate(timeout=60)
        self.assertEqual(slow.returncode, 0, err)
        self.assertEqual(json.loads(out)["result"]["value"], 7)
        self.assertEqual(refused.returncode, 1, refused.stdout)
        self.assertEqual(json.loads(refused.stdout)["code"], "tab_in_use")
        self.browse("tab", "close", opened, session="ho")

    def test_raw_domain_changes_dont_touch_the_sessions_own_capture(self):
        self.browse("open", self.url + "?raw-session", session="rs")
        self.browse("console", session="rs")
        first = json.loads(self.browse("cdp", "Runtime.disable", "--json", session="rs").stdout)["data"]
        self.assertEqual(first["session"], "attached")
        again = json.loads(self.browse("cdp", "Runtime.enable", "--json", session="rs").stdout)["data"]
        self.assertEqual(again["session"], "kept")
        self.browse("cdp", "Runtime.disable", session="rs")
        self.browse("eval", "console.log('after-raw-disable')", session="rs")
        self.assertIn("after-raw-disable", self.browse("console", session="rs").stdout)

    def test_a_large_raw_result_prints_whole(self):
        self.browse("open", self.url + "?big", session="big")
        done = self.browse("cdp", "Runtime.evaluate", "--param", "expression='x'.repeat(20000)", "--param", "returnByValue:=true", session="big")
        self.assertNotIn("output capped", done.stdout + done.stderr)
        self.assertEqual(json.loads(done.stdout)["result"]["value"], "x" * 20000)

    def test_a_named_tab_keeps_its_owners_dialog_setting(self):
        self.browse("--no-auto-dialog", "open", self.url + "?dialogs", session="da")
        tab = next(row["tabId"] for row in json.loads(self.browse("tab", "list", "--json", session="da").stdout)["data"]["tabs"]
                   if row["url"] == self.url + "?dialogs")
        self.browse("cdp", "Runtime.evaluate", "--param", "expression=setTimeout(() => alert('late'), 1500)", "--target", tab, session="db")
        deadline = time.monotonic() + 15
        status = {}
        while time.monotonic() < deadline:
            status = json.loads(self.browse("dialog", "status", "--json", session="da").stdout)["data"]
            if status.get("hasDialog"):
                break
            time.sleep(0.3)
        self.assertEqual(status.get("message"), "late")
        time.sleep(1.5)
        self.assertTrue(json.loads(self.browse("dialog", "status", "--json", session="da").stdout)["data"]["hasDialog"])
        self.browse("dialog", "accept", session="da")

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
