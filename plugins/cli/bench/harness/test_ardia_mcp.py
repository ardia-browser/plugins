import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ardia_side

OPTS = {"port": 9371, "cli": "installed", "humanize": False}


class AgentNames(unittest.TestCase):
    def test_mcp_prefix_splits_and_plain_agents_stay_plain(self):
        self.assertEqual(ardia_side.split_agent("mcp-codex"), ("codex", True))
        self.assertEqual(ardia_side.split_agent("mcp-claude"), ("claude", True))
        self.assertEqual(ardia_side.split_agent("codex"), ("codex", False))
        self.assertEqual(ardia_side.split_agent("claude"), ("claude", False))

    def test_unknown_agent_is_refused_before_any_setup(self):
        with self.assertRaises(SystemExit) as caught:
            ardia_side.run("shop", "mcp-gemini", "r", tempfile.gettempdir())
        self.assertIn("mcp-codex", str(caught.exception))


class PlainCommandsUnchanged(unittest.TestCase):
    def test_claude_command_is_the_original(self):
        self.assertEqual(ardia_side.claude_command("m", "high", "P"), [
            "claude", "-p", "--model", "m", "--effort", "high", "--output-format", "stream-json", "--verbose",
            "--dangerously-skip-permissions", "--setting-sources", "project", "--strict-mcp-config",
            "--no-session-persistence", "P"])

    def test_codex_command_ends_with_the_prompt_and_has_no_mcp_server(self):
        cmd = ardia_side.codex_command("m", "high", "/w", "P")
        self.assertEqual(cmd[:3], ["codex", "exec", "--json"])
        self.assertEqual(cmd[-1], "P")
        self.assertFalse(any("mcp_servers" in part for part in cmd))


class McpWiring(unittest.TestCase):
    def setUp(self):
        self.server = ardia_side.mcp_server(OPTS, Path("/tmp/data-x"))

    def test_server_runs_ardia_mcp_on_the_instance_port(self):
        self.assertEqual(self.server["command"], str(ardia_side.INSTALLED_ARDIA))
        self.assertEqual(self.server["args"], ["--port", "9371", "mcp"])
        self.assertEqual(self.server["env"]["ARDIA_DATA_DIR"], "/tmp/data-x")
        self.assertIn(str(ardia_side.INSTALLED_ARDIA.parent), self.server["env"]["PATH"].split(":"))
        self.assertNotIn("AGENT_BROWSER_HUMANIZE", self.server["env"])
        humanized = ardia_side.mcp_server(dict(OPTS, humanize=True), Path("/tmp/d"))
        self.assertEqual(humanized["env"]["AGENT_BROWSER_HUMANIZE"], "1")

    def test_claude_gets_an_mcp_config_file_and_keeps_strict_mcp(self):
        with tempfile.TemporaryDirectory() as folder:
            path = ardia_side.write_mcp_config(Path(folder) / "ardia-mcp.json", self.server)
            config = json.loads(path.read_text())
            entry = config["mcpServers"]["ardia"]
            self.assertEqual(entry["type"], "stdio")
            self.assertEqual(entry["args"], ["--port", "9371", "mcp"])
            cmd = ardia_side.mcp_claude_command("m", "high", "P", path)
            self.assertEqual(cmd[:4], ["claude", "-p", "--mcp-config", str(path)])
            self.assertIn("--strict-mcp-config", cmd)
            self.assertEqual(cmd[-1], "P")

    def test_codex_gets_the_server_through_config_flags(self):
        cmd = ardia_side.mcp_codex_command("m", "high", "/w", "P", self.server)
        self.assertEqual(cmd[-1], "P")
        flags = [cmd[i + 1] for i, part in enumerate(cmd) if part == "-c"]
        self.assertIn(f'mcp_servers.ardia.command={json.dumps(str(ardia_side.INSTALLED_ARDIA))}', flags)
        self.assertIn('mcp_servers.ardia.args=["--port", "9371", "mcp"]', flags)
        self.assertIn("mcp_servers.ardia.tool_timeout_sec=600", flags)
        env_flag = next(f for f in flags if f.startswith("mcp_servers.ardia.env="))
        self.assertIn('ARDIA_DATA_DIR = "/tmp/data-x"', env_flag)

    def test_prompt_line_names_both_tools_and_the_port(self):
        line = ardia_side.mcp_line(OPTS)
        for word in ("browser_repl", "browser_act", "9371", "--marks"):
            self.assertIn(word, line)


class McpStats(unittest.TestCase):
    def test_claude_counts_ardia_tool_calls_results_and_errors(self):
        lines = [
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "a", "name": "mcp__ardia__browser_act", "input": {"command": "here"}},
                {"type": "tool_use", "id": "b", "name": "mcp__ardia__browser_repl", "input": {"code": "page.fetch('/api/check')"}},
                {"type": "tool_use", "id": "c", "name": "Bash", "input": {"command": "ls"}},
                {"type": "tool_use", "id": "d", "name": "mcp__other__x", "input": {}}]}},
            {"type": "assistant", "parent_tool_use_id": "z", "message": {"content": [
                {"type": "tool_use", "id": "e", "name": "mcp__ardia__browser_act", "input": {}}]}},
            {"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "a", "content": [{"type": "text", "text": "hello"}]},
                {"type": "tool_result", "tool_use_id": "b", "content": "boom", "is_error": True},
                {"type": "tool_result", "tool_use_id": "c", "content": "ignored"}]}},
        ]
        self.assertEqual(ardia_side.mcp_stats("claude", lines), {
            "mcp_calls": 2, "mcp_by_tool": {"browser_act": 1, "browser_repl": 1}, "mcp_errors": 1,
            "mcp_output_chars": 9, "mcp_source_peeks": 0, "mcp_direct_api": 1, "shell_commands": 1})

    def test_codex_counts_only_the_ardia_server(self):
        lines = [
            {"type": "item.completed", "item": {"type": "mcp_tool_call", "server": "ardia", "tool": "browser_repl",
                                                "status": "completed", "result": {"content": [{"type": "text", "text": "ok!"}]}}},
            {"type": "item.completed", "item": {"type": "mcp_tool_call", "server": "ardia", "tool": "browser_act",
                                                "status": "completed", "result": {"content": [], "isError": True}}},
            {"type": "item.completed", "item": {"type": "mcp_tool_call", "server": "ardia", "tool": "browser_act",
                                                "status": "failed", "error": {"message": "x"}}},
            {"type": "item.completed", "item": {"type": "mcp_tool_call", "server": "other", "tool": "t"}},
            {"type": "item.completed", "item": {"type": "command_execution", "command": "ls"}},
        ]
        self.assertEqual(ardia_side.mcp_stats("codex", lines), {
            "mcp_calls": 3, "mcp_by_tool": {"browser_repl": 1, "browser_act": 2}, "mcp_errors": 2,
            "mcp_output_chars": 3, "mcp_source_peeks": 0, "mcp_direct_api": 0, "shell_commands": 1})


if __name__ == "__main__":
    unittest.main()
