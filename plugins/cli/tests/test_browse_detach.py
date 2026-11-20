import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ardia_cli import command_metrics
from ardia_cli.browse import changes, commands, readpages
from ardia_cli.browse.errors import BrowseError, CdpError
from ardia_cli.browse.state import State

START = "https://mine.example/start"
DEST = "https://mine.example/dest"


class FakeBrowser:
    def __init__(self, state):
        self.state = state
        self.link = mock.Mock()
        self.sent = []
        self.attached = 0
        self.url = START
        self.loader = "L1"
        self.disable_hangs = False
        self.after_load = None
        self.params = []
        self.refuse_on_second_session = set()
        self.after = {}
        self.during = {}

    async def send(self, method, params=None, session=None, timeout=30, mutation=False):
        result = await self.answer(method, params, session)
        hook = self.after.pop(method, None) or self.after.pop((method, (params or {}).get("functionDeclaration")), None)
        if hook:
            asyncio.get_running_loop().call_soon(hook, session)
        return result

    async def answer(self, method, params, session):
        self.sent.append((method, session))
        self.params.append((method, params, session))
        cut = self.during.pop((method, session), None)
        if cut:
            cut()
            await asyncio.sleep(0)
        if method in self.refuse_on_second_session and session != "S1":
            raise CdpError(method, "refused")
        if method == "Page.addScriptToEvaluateOnNewDocument":
            return {"identifier": "9"}
        if method == "Target.attachToTarget":
            self.attached += 1
            return {"sessionId": f"S{self.attached}"}
        if method == "Page.getFrameTree":
            return {"frameTree": {"frame": {"id": "F", "url": self.url, "loaderId": self.loader, "securityOrigin": "https://mine.example"}}}
        if method == "Page.getLayoutMetrics":
            return {"cssVisualViewport": {"clientWidth": 800, "clientHeight": 600}}
        if method == "Page.createIsolatedWorld":
            return {"executionContextId": 7}
        if method == "Runtime.callFunctionOn":
            source = params["functionDeclaration"]
            if source == readpages.SETTLE_PROBE:
                return {"result": {"value": ["complete", "fingerprint", False]}}
            value = "Destination" if "document.title" in source else "complete" if "readyState" in source else False
            return {"result": {"value": value}}
        if method == "Page.navigate":
            self.url, self.loader = params["url"], "L2"
            asyncio.get_running_loop().call_soon(self.loaded, session)
            return {"frameId": "F", "loaderId": "L2"}
        if method == "Network.disable" and self.disable_hangs:
            await asyncio.sleep(30)
        return {}

    def loaded(self, session):
        self.state.on_event("Page.frameNavigated", {"frame": {"id": "F", "url": self.url, "loaderId": "L2"}}, session)
        self.state.on_event("Page.lifecycleEvent", {"frameId": "F", "loaderId": "L2", "name": "load"}, session)
        if self.after_load:
            self.after_load(session)


class OpenAfterDetach(unittest.TestCase):
    def setUp(self):
        self.state = State({"session": "t", "data_root": "/nowhere"}, lambda: None)
        self.state.instance = "I"
        self.state.target_infos = {"T": {"targetId": "T", "url": START, "type": "page"}}
        self.state.current = "T"
        self.browser = FakeBrowser(self.state)
        self.state.browser = self.browser
        self.metrics = command_metrics.Metrics("open", False, True)

        async def connect():
            return None

        async def before_navigating(page, url):
            return None

        async def arrival(ctx, page, came_from):
            return None

        self.state.connect = connect
        for patch in (mock.patch.object(readpages, "before_navigating", before_navigating), mock.patch.object(changes, "arrival", arrival),
                      mock.patch.object(changes, "STOP_TIMEOUT", 0.05)):
            patch.start()
            self.addCleanup(patch.stop)

    def open(self):
        async def run():
            command_metrics.current.set(self.metrics)
            await self.state.page("T")
            ctx = commands.Ctx(self.state, {}, "/", {}, None, "open")
            return await commands.cmd_open(ctx, [DEST])

        return asyncio.run(run())

    def test_an_open_whose_network_disable_goes_unanswered_keeps_its_tab_and_finishes(self):
        self.browser.disable_hangs = True
        result = self.open()
        self.assertEqual(result.data["url"], DEST)
        self.assertEqual(result.data["title"], "Destination")
        self.assertEqual(self.browser.attached, 1)
        self.assertNotIn("Target.detachFromTarget", [method for method, _ in self.browser.sent])
        self.assertEqual(self.state.pages["T"].session_id, "S1")
        self.assertTrue(self.metrics.values.get("network_disable_unconfirmed"))
        self.assertNotIn("reattached_after_detach", self.metrics.values)

    def detach_after_load(self):
        self.browser.after_load = lambda session: self.state.on_event("Target.detachedFromTarget", {"sessionId": session, "targetId": "T"}, None)

    def test_an_open_whose_session_ardia_ended_while_the_tab_stayed_open_attaches_again_and_finishes(self):
        self.detach_after_load()
        result = self.open()
        self.assertEqual(result.data["url"], DEST)
        self.assertEqual(result.data["title"], "Destination")
        self.assertEqual(self.browser.attached, 2)
        self.assertEqual(self.state.pages["T"].session_id, "S2")
        self.assertTrue(self.metrics.values.get("reattached_after_detach"))

    def test_a_renderer_that_exits_keeps_the_session_and_opens_no_other(self):
        def exits(session):
            for _ in range(3):
                self.state.on_event("Inspector.detached", {"reason": "Render process gone."}, session)

        self.browser.after_load = exits
        result = self.open()
        self.assertEqual(result.data["title"], "Destination")
        self.assertEqual(self.browser.attached, 1)
        self.assertNotIn("Target.detachFromTarget", [method for method, _ in self.browser.sent])
        self.assertEqual(self.state.pages["T"].session_id, "S1")
        self.assertTrue(self.metrics.values.get("renderer_exit_kept_session"))
        self.assertNotIn("reattached_after_detach", self.metrics.values)

    def set_up_session(self):
        async def setup():
            page = await self.state.page("T")
            page.init_scripts["1"] = "window.hooked = 1"
            page.script_sources["1"] = "window.hooked = 1"
            page.overrides["Emulation.setGeolocationOverride"] = {"latitude": 1.0, "longitude": 2.0, "accuracy": 10}
            self.state.extras["claims"] = {("T", "route")}
            self.state.extras["credentials"] = {"username": "u", "password": "p"}

        asyncio.run(setup())

    def on_second_session(self):
        return [(method, params) for method, params, session in self.browser.params if session == "S2"]

    def test_a_reattach_puts_back_init_scripts_overrides_and_routes(self):
        self.set_up_session()
        self.detach_after_load()
        result = self.open()
        self.assertEqual(result.data["title"], "Destination")
        again = self.on_second_session()
        self.assertIn(("Page.addScriptToEvaluateOnNewDocument", {"source": "window.hooked = 1"}), again)
        self.assertIn(("Emulation.setGeolocationOverride", {"latitude": 1.0, "longitude": 2.0, "accuracy": 10}), again)
        self.assertIn(("Fetch.enable", {"patterns": [{"urlPattern": "*", "requestStage": "Request"}], "handleAuthRequests": True}), again)
        page = self.state.pages["T"]
        self.assertEqual(page.script_ids, {"1": "9"})
        self.assertTrue(self.metrics.values.get("setup_restored"))

    def test_a_reattach_that_cant_put_back_its_setup_fails_and_names_what_was_lost(self):
        self.set_up_session()
        self.browser.refuse_on_second_session = {"Emulation.setGeolocationOverride", "Page.addScriptToEvaluateOnNewDocument"}
        self.detach_after_load()
        with self.assertRaises(BrowseError) as failed:
            self.open()
        self.assertEqual(failed.exception.code, "setup_lost")
        self.assertIn("init script 1", failed.exception.message)
        self.assertIn("the geolocation", failed.exception.message)
        page = self.state.pages["T"]
        self.assertEqual((page.init_scripts, page.overrides), ({}, {}))
        self.assertTrue(self.metrics.values.get("setup_restore_failed"))

    def test_an_open_whose_tab_closed_still_fails_as_detached(self):
        self.browser.after_load = lambda session: self.state.on_event("Target.targetDestroyed", {"targetId": "T"}, None)
        with self.assertRaises(BrowseError) as failed:
            self.open()
        self.assertEqual(failed.exception.code, "tab_detached")
        self.assertEqual(self.browser.attached, 1)
        self.assertNotIn("reattached_after_detach", self.metrics.values)

    def detach(self, session="S1"):
        self.state.on_event("Target.detachedFromTarget", {"sessionId": session, "targetId": "T"}, None)

    def navigations(self):
        return [session for method, session in self.browser.sent if method == "Page.navigate"]

    def test_an_open_whose_session_ended_before_its_navigation_was_sent_attaches_again_and_sends_it_once(self):
        self.browser.after["Network.enable"] = self.detach
        result = self.open()
        self.assertEqual(result.data["url"], DEST)
        self.assertEqual(result.data["title"], "Destination")
        self.assertEqual(self.browser.attached, 2)
        self.assertEqual(self.navigations(), ["S2"])
        self.assertTrue(self.metrics.values.get("reattached_after_detach"))

    def test_an_open_whose_new_session_ends_while_it_is_being_set_up_attaches_again(self):
        self.detach_after_load()
        self.browser.during[("Page.getFrameTree", "S2")] = lambda: self.detach("S2")
        result = self.open()
        self.assertEqual(result.data["title"], "Destination")
        self.assertEqual(self.browser.attached, 3)
        self.assertEqual(self.state.pages["T"].session_id, "S3")
        self.assertEqual(self.navigations(), ["S1"])

    def test_an_open_whose_new_session_ends_while_network_monitoring_is_put_back_puts_it_back_on_the_next(self):
        async def monitor():
            page = await self.state.page("T")
            await page.enable_network()

        asyncio.run(monitor())
        self.detach_after_load()
        self.browser.during[("Network.enable", "S2")] = lambda: self.detach("S2")
        result = self.open()
        self.assertEqual(result.data["title"], "Destination")
        self.assertEqual(self.browser.attached, 3)
        self.assertEqual([session for method, session in self.browser.sent if method == "Network.enable"][-2:], ["S2", "S3"])
        self.assertTrue(self.state.pages["T"].network_on)

    def test_an_open_whose_new_session_ends_while_the_runtime_is_put_back_puts_it_back_on_the_next(self):
        async def monitor():
            page = await self.state.page("T")
            await page.enable_runtime()

        asyncio.run(monitor())
        self.detach_after_load()
        self.browser.during[("Runtime.enable", "S2")] = lambda: self.detach("S2")
        result = self.open()
        self.assertEqual(result.data["title"], "Destination")
        self.assertEqual(self.browser.attached, 3)
        self.assertEqual([session for method, session in self.browser.sent if method == "Runtime.enable"][-2:], ["S2", "S3"])
        self.assertTrue(self.state.pages["T"].runtime_on)

    def test_an_open_whose_tab_closes_while_it_is_attached_again_still_fails_as_detached(self):
        self.detach_after_load()
        self.browser.during[("Page.getFrameTree", "S2")] = lambda: self.state.on_event("Target.targetDestroyed", {"targetId": "T"}, None)
        with self.assertRaises(BrowseError) as failed:
            self.open()
        self.assertEqual(failed.exception.code, "tab_detached")
        self.assertEqual(self.browser.attached, 2)

    def test_an_open_whose_navigation_was_cut_off_by_the_detach_after_it_took_is_not_sent_again(self):
        def navigated_then_detached():
            self.browser.url, self.browser.loader = DEST, "L2"
            self.detach()

        self.browser.during[("Page.navigate", "S1")] = navigated_then_detached
        result = self.open()
        self.assertEqual(result.data["url"], DEST)
        self.assertEqual(result.data["title"], "Destination")
        self.assertEqual(self.navigations(), ["S1"])
        self.assertEqual(self.browser.attached, 2)
        self.assertTrue(self.metrics.values.get("reattached_after_detach"))

    def test_an_open_whose_navigation_was_cut_off_by_the_detach_without_taking_stays_unknown_and_is_not_sent_again(self):
        self.browser.during[("Page.navigate", "S1")] = self.detach
        with self.assertRaises(BrowseError) as failed:
            self.open()
        self.assertEqual(failed.exception.code, "outcome_unknown")
        self.assertEqual(self.navigations(), ["S1"])

    def goto(self, before=None):
        async def run():
            command_metrics.current.set(self.metrics)
            page = await self.state.page("T")
            if before:
                before()
            ctx = commands.Ctx(self.state, {}, "/", {}, None, "read")
            await readpages.goto(ctx, page, DEST, 5)
            return page

        with mock.patch.object(readpages, "SETTLE_QUIET", 0.01), mock.patch.object(readpages, "SETTLE_POLL", 0.01):
            return asyncio.run(run())

    def test_a_read_whose_session_ended_before_its_navigation_was_sent_attaches_again_and_sends_it_once(self):
        page = self.goto(before=self.detach)
        self.assertEqual(page.url, DEST)
        self.assertEqual(page.session_id, "S2")
        self.assertEqual(self.navigations(), ["S2"])

    def test_a_read_whose_session_ended_while_the_page_settled_attaches_again_and_finishes(self):
        self.browser.after[("Runtime.callFunctionOn", readpages.SETTLE_PROBE)] = self.detach
        page = self.goto()
        self.assertEqual(page.url, DEST)
        self.assertEqual(page.session_id, "S2")
        self.assertEqual(self.navigations(), ["S1"])
        self.assertTrue(self.metrics.values.get("reattached_after_detach"))

    def test_a_read_of_a_tab_that_closed_fails_as_detached_and_names_the_page(self):
        with self.assertRaises(BrowseError) as failed:
            self.goto(before=lambda: self.state.on_event("Target.targetDestroyed", {"targetId": "T"}, None))
        self.assertEqual(failed.exception.code, "tab_detached")
        self.assertIn(DEST, failed.exception.message)

    def test_a_read_in_a_blank_tab_that_closed_names_the_page_it_was_opening(self):
        self.browser.url = "about:blank"
        self.state.target_infos["T"]["url"] = "about:blank"
        with self.assertRaises(BrowseError) as failed:
            self.goto(before=lambda: self.state.on_event("Target.targetDestroyed", {"targetId": "T"}, None))
        self.assertEqual(failed.exception.code, "tab_detached")
        self.assertIn(DEST, failed.exception.message)

    def test_an_open_in_a_blank_tab_that_closed_names_the_page_it_was_opening(self):
        self.browser.url = "about:blank"
        self.state.target_infos["T"]["url"] = "about:blank"
        self.browser.after["Network.enable"] = lambda session: self.state.on_event("Target.targetDestroyed", {"targetId": "T"}, None)
        with self.assertRaises(BrowseError) as failed:
            self.open()
        self.assertEqual(failed.exception.code, "tab_detached")
        self.assertIn(DEST, failed.exception.message)


if __name__ == "__main__":
    unittest.main()
