import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_automation import Base

from ardia_cli import call_cli, control, telemetry

METHODS = [
    {"name": "windows", "description": "Windows and their tabs", "mutates": False, "params": None, "result": {"type": "array"}},
    {"name": "history.search", "description": "Search history", "mutates": False,
     "params": {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer"}}}, "result": {"type": "array"}},
    {"name": "tabs.close", "description": "Close tabs", "mutates": True, "params": {"type": "object"}, "result": {"type": "object"}},
]


class CallBase(Base):
    def serve_methods(self, methods=METHODS):
        server = self.serve()
        server.replies["methods"] = lambda params: {"result": methods}
        server.replies["history.search"] = lambda params: {"result": [{"url": "https://a.test/", "title": "A", "visits": 2, "params": params}]}
        server.replies["tabs.close"] = lambda params: {"result": None}
        return server


class Call(CallBase):
    def test_sends_the_method_after_hello_and_prints_json(self):
        server = self.serve_methods()
        status, out, err = self.run_cli("call", "history.search", "-p", "query=invoice", "-p", "limit:=20", "--json")
        self.assertEqual(status, 0, err)
        self.assertEqual([m for m, _ in server.requests], ["hello", "history.search"])
        self.assertEqual(server.requests[1][1], {"query": "invoice", "limit": 20})
        self.assertEqual(json.loads(out)[0]["url"], "https://a.test/")

    def test_params_json_merges_with_pairs(self):
        server = self.serve_methods()
        status, _, err = self.run_cli("call", "history.search", "--params", '{"query": "x", "limit": 5}', "-p", "query=y")
        self.assertEqual(status, 0, err)
        self.assertEqual(server.requests[1][1], {"query": "y", "limit": 5})

    def test_params_from_stdin(self):
        server = self.serve_methods()
        with mock.patch("sys.stdin", io.StringIO('{"query": "from stdin"}')):
            status, _, err = self.run_cli("call", "history.search", "--params", "-")
        self.assertEqual(status, 0, err)
        self.assertEqual(server.requests[1][1], {"query": "from stdin"})

    def test_no_params_sends_none(self):
        server = self.serve_methods()
        status, out, err = self.run_cli("call", "windows")
        self.assertEqual(status, 0, err)
        self.assertEqual(server.requests[1], ("windows", None))
        self.assertIn("kind: normal", out)
        self.assertIn("- id: 11", out)

    def test_readable_output_and_a_null_result(self):
        self.serve_methods()
        status, out, _ = self.run_cli("call", "history.search", "-p", "query=a")
        self.assertEqual(status, 0)
        self.assertIn("- url: https://a.test/", out)
        self.assertIn("  visits: 2", out)
        status, out, _ = self.run_cli("call", "tabs.close", "-p", "ids:=[1,2]")
        self.assertEqual((status, out.strip()), (0, "✓ tabs.close"))

    def test_bad_params_never_reach_ardia(self):
        server = self.serve_methods()
        for argv, said in ((["--params", "[1]"], "must be a JSON object"), (["--params", "{nope"], "isn't valid JSON"),
                           (["-p", "novalue"], "give key=value"), (["-p", "n:={bad"], "after := isn't valid JSON")):
            status, _, err = self.run_cli("call", "history.search", *argv)
            self.assertEqual(status, 1, argv)
            self.assertIn(said, err)
        self.assertEqual(server.requests, [])

    def test_a_refused_method_exits_1_with_ardias_message(self):
        server = self.serve_methods()
        server.replies["tabs.close"] = lambda params: {"error": {"code": "bad_request", "message": "ids must be a list"}}
        status, _, err = self.run_cli("call", "tabs.close")
        self.assertEqual(status, 1)
        self.assertEqual(err.strip(), "ardia call: ids must be a list")

    def test_an_unknown_method_suggests_the_closest(self):
        self.serve_methods()
        status, _, err = self.run_cli("call", "history.serch")
        self.assertEqual(status, 1)
        self.assertIn("unknown method", err)
        self.assertIn("did you mean history.search", err)

    def test_an_unknown_method_on_an_old_ardia_says_to_update(self):
        self.serve()
        status, _, err = self.run_cli("call", "history.search")
        self.assertEqual(status, 1)
        self.assertIn("update Ardia", err)

    def test_not_running_exits_2(self):
        status, _, err = self.run_cli("call", "windows")
        self.assertEqual(status, 2)
        self.assertIn("ardia:", err)

    def test_a_dropped_connection_says_the_outcome_is_unknown(self):
        server = self.serve_methods()
        server.replies["tabs.close"] = lambda params: None
        status, _, err = self.run_cli("call", "tabs.close")
        self.assertEqual(status, 2)
        self.assertIn("tabs.close may or may not have run", err)


    def test_an_answer_with_neither_result_nor_error_is_an_unknown_outcome(self):
        server = self.serve_methods()
        for reply in ({}, {"ok": True}):
            server.replies["tabs.close"] = lambda params, reply=reply: reply
            for argv in (["call", "tabs.close"], ["call", "tabs.close", "--json"]):
                status, out, err = self.run_cli(*argv)
                self.assertEqual((status, out), (2, ""), argv)
                self.assertIn("tabs.close may or may not have run", err)
                self.assertIn("neither a result nor an error", err)

    def test_an_explicit_null_result_is_still_done(self):
        self.serve_methods()
        self.assertEqual(self.run_cli("call", "tabs.close", "--json")[:2], (0, "null\n"))

    def test_a_timeout_must_be_finite_positive_and_bounded(self):
        server = self.serve_methods()
        for value in ("0", "-1", "nan", "inf", "-inf", "1e400", "601", "abc"):
            status, out, err = self.run_cli("call", "windows", "--timeout", value)
            self.assertEqual((status, out), (2, ""), value)
            self.assertIn("--timeout", err)
        self.assertEqual(server.requests, [])
        self.assertEqual(self.run_cli("call", "windows", "--timeout", "600")[0], 0)
        self.assertEqual(self.run_cli("call", "windows", "--timeout", "0.5")[0], 0)

    def test_the_hint_lookup_stays_inside_the_budget(self):
        self.serve_methods()
        seen = []
        real = control.Connection.call

        async def spy(connection, method, params=None, timeout=control.CALL_TIMEOUT, **kwargs):
            seen.append((method, timeout))
            return await real(connection, method, params, timeout, **kwargs)

        with mock.patch.object(control.Connection, "call", spy):
            status, _, err = self.run_cli("call", "history.serch", "--timeout", "2")
        self.assertEqual(status, 1)
        self.assertIn("did you mean history.search", err)
        method, timeout = seen[-1]
        self.assertEqual(method, "methods")
        self.assertTrue(0 < timeout <= 2, timeout)

    def test_no_hint_lookup_when_methods_itself_is_unknown(self):
        server = self.serve()
        status, _, err = self.run_cli("call", "methods")
        self.assertEqual(status, 1)
        self.assertEqual([m for m, _ in server.requests], ["hello", "methods"])
        self.assertIn("update Ardia", err)

    def test_no_hint_lookup_once_the_budget_is_spent(self):
        server = self.serve_methods()
        clock = iter([100.0, 200.0, 300.0, 400.0])
        with mock.patch.object(call_cli, "monotonic", side_effect=lambda: next(clock)):
            status, _, err = self.run_cli("call", "history.serch", "--timeout", "5")
        self.assertEqual(status, 1)
        self.assertNotIn("methods", [m for m, _ in server.requests])
        self.assertNotIn("did you mean", err)

class Methods(CallBase):
    def test_lists_what_ardia_offers(self):
        self.serve_methods()
        status, out, err = self.run_cli("methods")
        self.assertEqual(status, 0, err)
        lines = out.splitlines()
        self.assertEqual(len(lines), 3)
        self.assertRegex(lines[1], r"^history\.search\s+reads\s+Search history$")
        self.assertRegex(lines[2], r"^tabs\.close\s+changes\s+Close tabs$")

    def test_json_and_one_method(self):
        self.serve_methods()
        status, out, _ = self.run_cli("methods", "--json")
        self.assertEqual([m["name"] for m in json.loads(out)], ["windows", "history.search", "tabs.close"])
        status, out, _ = self.run_cli("methods", "history.search")
        self.assertEqual(status, 0)
        self.assertIn("history.search  (reads only)", out)
        self.assertIn("params:", out)
        self.assertIn("query:", out)
        status, out, _ = self.run_cli("methods", "tabs.close", "--json")
        self.assertTrue(json.loads(out)["mutates"])

    def test_takes_a_name_keyed_catalog(self):
        self.serve_methods({"methods": {"a.b": {"description": "x", "mutates": True}, "c": {"description": "y"}}})
        status, out, _ = self.run_cli("methods", "--json")
        self.assertEqual([(m["name"], m.get("mutates")) for m in json.loads(out)], [("a.b", True), ("c", None)])

    def test_a_name_keyed_catalog_with_its_own_methods_entry_isnt_a_wrapper(self):
        catalog = {"methods": {"description": "Every method", "mutates": False, "params": {"type": "object"}},
                   "windows": {"description": "Windows", "mutates": False}}
        self.assertEqual([(r["name"], r["description"]) for r in call_cli.entries(catalog)], [("methods", "Every method"), ("windows", "Windows")])
        only_itself = {"methods": {"description": "Every method", "mutates": False, "params": {}, "result": "[…]"}}
        self.assertEqual([r["name"] for r in call_cli.entries(only_itself)], ["methods"])

    def test_the_three_shapes_still_parse(self):
        app = [{"name": "tabs.close", "area": "tabs", "mutates": True, "description": "Close tabs", "params": {"type": "object"}, "result": "{ok}"}]
        self.assertEqual(call_cli.entries(app), app)
        self.assertEqual([r["name"] for r in call_cli.entries({"methods": app})], ["tabs.close"])
        keyed = {"methods": {"tabs.close": {"description": "Close tabs", "mutates": True}, "methods": {"description": "All"}}}
        self.assertEqual([r["name"] for r in call_cli.entries(keyed)], ["tabs.close", "methods"])

    def test_an_unknown_name(self):
        self.serve_methods()
        status, _, err = self.run_cli("methods", "tabs.clos")
        self.assertEqual(status, 1)
        self.assertIn("did you mean tabs.close", err)

    def test_an_old_ardia_says_so_plainly(self):
        self.serve()
        status, out, err = self.run_cli("methods")
        self.assertEqual((status, out), (1, ""))
        self.assertIn("this Ardia is too old to list its methods", err)
        self.assertIn("update Ardia", err)


class Telemetry(CallBase):
    def test_the_family_is_an_enum_and_params_never_go(self):
        self.assertEqual(call_cli.family("history.search"), "history")
        self.assertEqual(call_cli.family("Cookies.getAll"), "cookies")
        self.assertEqual(call_cli.family("windows"), "windows")
        self.assertEqual(call_cli.family("secret-user-text.method"), "other")
        self.assertEqual(call_cli.family("https://evil.test/a.b"), "other")
        self.serve_methods()
        records = []
        target = telemetry.Target(self.temp, "http://127.0.0.1:1/", "test")
        with mock.patch.object(telemetry, "cli_target", return_value=target), \
                mock.patch.object(telemetry, "keep_local_copy", side_effect=lambda root, rows, sent: records.extend(rows)), \
                mock.patch.object(telemetry, "discard_spool"):
            self.run_cli("call", "history.search", "-p", "query=very-private", "--json")
            self.run_cli("call", "nope.method")
        first, second = (r["properties"] for r in records if r["event"] == "cli_command")
        self.assertEqual((first["command"], first["subcommand"], first["exit_code"]), ("call", "history", 0))
        self.assertEqual(set(first["flags"].split(",")), {"-p", "--json"})
        self.assertEqual((second["subcommand"], second["error_code"]), ("other", "unknown_method"))
        recorded = records
        self.assertNotIn("very-private", json.dumps(recorded))


    def recorded(self, *runs):
        records = []
        target = telemetry.Target(self.temp, "http://127.0.0.1:1/", "test")
        with mock.patch.object(telemetry, "cli_target", return_value=target), \
                mock.patch.object(telemetry, "keep_local_copy", side_effect=lambda root, rows, sent: records.extend(rows)), \
                mock.patch.object(telemetry, "discard_spool"):
            for argv in runs:
                self.run_cli(*argv)
        return [r["properties"] for r in records if r["event"] == "cli_command"]

    def test_ardias_error_code_is_recorded_only_from_the_known_set(self):
        server = self.serve_methods()
        server.replies["tabs.close"] = lambda params: {"error": {"code": "private_marker", "message": "x"}}
        server.replies["methods"] = lambda params: {"error": {"code": "another_marker", "message": "y"}}
        rows = self.recorded(["call", "tabs.close"], ["methods"], ["call", "nope.method"])
        self.assertEqual([row["error_code"] for row in rows], ["other", "other", "unknown_method"])
        self.assertNotIn("marker", json.dumps(rows))

    def test_every_protocol_code_passes_through(self):
        for code in ("bad_request", "unknown_method", "unknown_command", "refused", "no_window", "failed", "unsupported_protocol"):
            self.assertEqual(call_cli.recorded_code(code), code)
        for code in ("private_marker", "", None, 7, "Bad_Request"):
            self.assertEqual(call_cli.recorded_code(code), "other")


class Wire(unittest.TestCase):
    def test_protocol_number_is_unchanged(self):
        self.assertEqual(control.PROTOCOL, 4)


if __name__ == "__main__":
    unittest.main()
