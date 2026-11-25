import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Found } from "../src/browse/args.ts";
import { BrowseError } from "../src/browse/errors.ts";
import { autoSessionId, deriveAutoSession, type ProcessRow } from "../src/browse/session.ts";
import { CLAIM_EVERY_MS, mcpArgv, mcpManageArgv, SessionDaemon } from "../src/mcp/index.ts";
import { type Client, configPaths, editToml, manage, manageMain, type ManageArgs, parseManage, serverEntry, tomlEntry } from "../src/mcp/install.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "arch-v3-setup-"));
let counter = 0;

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function sandbox(): Record<Client, string> {
  counter += 1;
  const home = path.join(root, `home-${counter}`);
  fs.mkdirSync(home, { recursive: true });
  return configPaths({ ARDIA_MCP_CLAUDE_CONFIG: path.join(home, "claude.json"), ARDIA_MCP_CODEX_CONFIG: path.join(home, "codex", "config.toml"), ARDIA_MCP_CURSOR_CONFIG: path.join(home, "cursor", "mcp.json") }, home);
}

function args(action: ManageArgs["action"], extra: Partial<ManageArgs> = {}): ManageArgs {
  return { action, clients: ["claude", "codex", "cursor"], dryRun: false, json: false, command: null, help: false, ...extra };
}

const CODEX = `model = "gpt-5"
# keep this comment

[mcp_servers.other]
command = "other"
args = ["serve"]

[profiles.fast]
model = "mini"
`;

describe("ardia mcp install / uninstall / status", () => {
  test("env vars point every client at its own file", () => {
    const paths = configPaths({ ARDIA_MCP_CLAUDE_CONFIG: "/x/c.json", CODEX_HOME: "/codex" }, "/home/me");
    expect(paths).toEqual({ claude: "/x/c.json", codex: "/codex/config.toml", cursor: "/home/me/.cursor/mcp.json" });
  });

  test("install adds the entry to all three, keeping every other server and setting", () => {
    const paths = sandbox();
    fs.writeFileSync(paths.claude, JSON.stringify({ numStartups: 4, mcpServers: { github: { type: "stdio", command: "gh-mcp", args: [] } } }, null, 2));
    fs.mkdirSync(path.dirname(paths.codex), { recursive: true });
    fs.writeFileSync(paths.codex, CODEX);
    const outcomes = manage(args("install"), paths);
    expect(outcomes.map((outcome) => [outcome.client, outcome.change, outcome.written])).toEqual([["claude", "added", true], ["codex", "added", true], ["cursor", "added", true]]);
    const claude = JSON.parse(fs.readFileSync(paths.claude, "utf8"));
    expect(claude.numStartups).toBe(4);
    expect(claude.mcpServers.github).toEqual({ type: "stdio", command: "gh-mcp", args: [] });
    expect(claude.mcpServers.ardia).toEqual({ type: "stdio", command: "ardia", args: ["mcp"], env: {} });
    expect(JSON.parse(fs.readFileSync(paths.cursor, "utf8"))).toEqual({ mcpServers: { ardia: { command: "ardia", args: ["mcp"] } } });
    const codex = fs.readFileSync(paths.codex, "utf8");
    expect(codex.startsWith(CODEX.trimEnd())).toBe(true);
    expect(codex.endsWith('[mcp_servers.ardia]\ncommand = "ardia"\nargs = ["mcp"]\n')).toBe(true);
    expect(tomlEntry(codex)).toEqual({ command: "ardia", args: ["mcp"] });
  });

  test("a second install changes nothing and writes nothing", () => {
    const paths = sandbox();
    manage(args("install"), paths);
    const before = Object.fromEntries(Object.entries(paths).map(([client, file]) => [client, [fs.readFileSync(file, "utf8"), fs.statSync(file).ino]]));
    const again = manage(args("install"), paths);
    expect(again.every((outcome) => outcome.change === "unchanged" && !outcome.written)).toBe(true);
    for (const [client, file] of Object.entries(paths)) expect([fs.readFileSync(file, "utf8"), fs.statSync(file).ino]).toEqual(before[client] as never);
  });

  test("--dry-run reports and writes nothing", () => {
    const paths = sandbox();
    const outcomes = manage(args("install", { dryRun: true }), paths);
    expect(outcomes.map((outcome) => outcome.change)).toEqual(["added", "added", "added"]);
    for (const file of Object.values(paths)) expect(fs.existsSync(file)).toBe(false);
  });

  test("a changed command updates only the ardia entry and keeps its other keys", () => {
    const paths = sandbox();
    fs.mkdirSync(path.dirname(paths.codex), { recursive: true });
    fs.writeFileSync(paths.codex, `[mcp_servers.ardia]\ncommand = "old"\nargs = ["x"]\nstartup_timeout_sec = 30\n\n[mcp_servers.ardia.env]\nA = "1"\n\n[other]\nk = 1\n`);
    fs.writeFileSync(paths.claude, JSON.stringify({ mcpServers: { ardia: { type: "stdio", command: "old", args: [], env: { K: "v" } } } }));
    const outcomes = manage(args("install", { clients: ["claude", "codex"], command: "/opt/ardia/bin/ardia" }), paths);
    expect(outcomes.map((outcome) => outcome.change)).toEqual(["updated", "updated"]);
    expect(fs.readFileSync(paths.codex, "utf8")).toBe(`[mcp_servers.ardia]\ncommand = "/opt/ardia/bin/ardia"\nargs = ["mcp"]\nstartup_timeout_sec = 30\n\n[mcp_servers.ardia.env]\nA = "1"\n\n[other]\nk = 1\n`);
    expect(JSON.parse(fs.readFileSync(paths.claude, "utf8")).mcpServers.ardia).toEqual({ type: "stdio", command: "/opt/ardia/bin/ardia", args: ["mcp"], env: { K: "v" } });
  });

  test("uninstall removes only the ardia entry, its sub-tables included", () => {
    const paths = sandbox();
    fs.mkdirSync(path.dirname(paths.codex), { recursive: true });
    fs.writeFileSync(paths.codex, CODEX);
    fs.writeFileSync(paths.claude, JSON.stringify({ x: 1, mcpServers: { github: { command: "gh" } } }));
    manage(args("install"), paths);
    fs.appendFileSync(paths.codex, `\n[mcp_servers.ardia.env]\nTOKEN = "x"\n`);
    const removed = manage(args("uninstall"), paths);
    expect(removed.map((outcome) => outcome.change)).toEqual(["removed", "removed", "removed"]);
    expect(fs.readFileSync(paths.codex, "utf8")).toBe(CODEX);
    expect(JSON.parse(fs.readFileSync(paths.claude, "utf8"))).toEqual({ x: 1, mcpServers: { github: { command: "gh" } } });
    expect(manage(args("uninstall"), paths).map((outcome) => [outcome.change, outcome.written])).toEqual([["absent", false], ["absent", false], ["absent", false]]);
  });

  test("status shows where it is set up, and matches the wanted command", () => {
    const paths = sandbox();
    manage(args("install", { clients: ["cursor"] }), paths);
    const status = manage(args("status"), paths);
    expect(status.map((outcome) => [outcome.client, outcome.entry?.command ?? null, outcome.matches])).toEqual([["claude", null, false], ["codex", null, false], ["cursor", "ardia", true]]);
  });

  test("broken JSON is left alone with a clear error", () => {
    const paths = sandbox();
    fs.writeFileSync(paths.claude, "{ not json");
    expect(() => manage(args("install", { clients: ["claude"] }), paths)).toThrow("isn't valid JSON");
    expect(fs.readFileSync(paths.claude, "utf8")).toBe("{ not json");
    let printed = "";
    expect(manageMain(args("install", { clients: ["claude"], json: true }), (text) => (printed += text), paths)).toBe(1);
    expect(JSON.parse(printed)).toMatchObject({ success: false });
  });

  test("writes keep the file mode and go through a symlinked config to its target", () => {
    const paths = sandbox();
    const real = path.join(path.dirname(paths.claude), "real-claude.json");
    fs.writeFileSync(real, "{}", { mode: 0o640 });
    fs.symlinkSync(real, paths.claude);
    manage(args("install", { clients: ["claude"] }), paths);
    expect(fs.lstatSync(paths.claude).isSymbolicLink()).toBe(true);
    expect(fs.statSync(real).mode & 0o777).toBe(0o640);
    expect(JSON.parse(fs.readFileSync(real, "utf8")).mcpServers.ardia.command).toBe("ardia");
    expect(fs.readdirSync(path.dirname(paths.claude)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("CRLF TOML keeps its line endings", () => {
    const edited = editToml('model = "x"\r\n', "install", serverEntry());
    expect(edited.text).toBe('model = "x"\r\n\r\n[mcp_servers.ardia]\r\ncommand = "ardia"\r\nargs = ["mcp"]\r\n');
  });

  test("without --client, only clients whose config exists are touched", () => {
    const paths = sandbox();
    fs.mkdirSync(path.dirname(paths.cursor), { recursive: true });
    const outcomes = manage({ ...args("install"), clients: null }, paths);
    expect(outcomes.map((outcome) => outcome.client)).toEqual(["cursor"]);
    let printed = "";
    expect(manageMain({ ...args("install"), clients: null }, (text) => (printed += text), sandbox())).toBe(1);
    expect(printed).toContain("--client");
  });

  test("argv: ardia [globals] mcp install|uninstall|status [flags]", () => {
    expect(mcpManageArgv(["--port", "9333", "mcp", "install", "--client", "codex,cursor", "--dry-run", "--json"])).toEqual({
      manage: { action: "install", clients: ["codex", "cursor"], dryRun: true, json: true, command: null, help: false },
    });
    expect(mcpManageArgv(["mcp", "status", "--client=all"])).toMatchObject({ manage: { action: "status", clients: ["claude", "codex", "cursor"] } });
    expect(mcpManageArgv(["mcp", "uninstall", "--client", "vim"])).toEqual({ error: "--client takes claude, codex, cursor or all, not vim" });
    expect(parseManage(["status", "--command", "x"])).toEqual({ error: "ardia mcp status doesn't take --command" });
    expect(mcpManageArgv(["mcp"])).toBeUndefined();
    expect(mcpManageArgv(["mcp", "--session", "s"])).toBeUndefined();
    expect(mcpArgv(["mcp", "--session", "s"])).not.toHaveProperty("error");
  });
});

describe("parallel agents get their own sessions", () => {
  const rows = (entries: [number, number, string, string][]): Map<number, ProcessRow> => new Map(entries.map(([pid, ppid, name, started]) => [pid, { pid, ppid, name, started }]));
  const tree = rows([
    [100, 1, "claude", "Mon Nov 24 10:00:00 2026"],
    [101, 100, "/bin/zsh", "Mon Nov 24 10:00:05 2026"],
    [102, 100, "ardia", "Mon Nov 24 10:00:06 2026"],
    [200, 1, "codex", "Mon Nov 24 10:01:00 2026"],
    [201, 200, "bash", "Mon Nov 24 10:01:01 2026"],
    [300, 1, "Cursor Helper (Plugin)", "Mon Nov 24 10:02:00 2026"],
  ]);
  const cwd = process.cwd();

  test("an agent's shell and its MCP server share one session; other agents get others", () => {
    const fromShell = deriveAutoSession(cwd, tree, 101, "");
    const fromMcp = deriveAutoSession(cwd, tree, 102, "");
    const codex = deriveAutoSession(cwd, tree, 201, "");
    const cursor = deriveAutoSession(cwd, tree, 300, "");
    expect(fromShell).toBe(fromMcp);
    expect(new Set([fromShell, codex, cursor]).size).toBe(3);
  });

  test("worktrees and ARDIA_AGENT_ID split one launcher into separate sessions, and an empty salt keeps old ids", () => {
    const launcher = tree.get(100) as ProcessRow;
    expect(autoSessionId(launcher, "/repo")).toBe(autoSessionId(launcher, "/repo", ""));
    expect(autoSessionId(launcher, "/repo")).not.toBe(autoSessionId(launcher, "/repo-wt"));
    expect(autoSessionId(launcher, "/repo", "agent-a")).not.toBe(autoSessionId(launcher, "/repo", "agent-b"));
  });

  test("ardia mcp registers its automatic session, and refreshes it at most once a minute", async () => {
    const saved = [process.env["AGENT_BROWSER_SESSION"], process.env["ARDIA_BROWSE_AUTO_SESSION"]];
    delete process.env["AGENT_BROWSER_SESSION"];
    delete process.env["ARDIA_BROWSE_AUTO_SESSION"];
    try {
      const claims: string[] = [];
      const found = new Found();
      found.values.set("port", "9333");
      const daemon = new SessionDaemon(found, undefined, () => "auto-abc", async (_root, _namespace, _key, id) => {
        claims.push(id);
        return { notice: null };
      });
      expect(daemon.session).toBe("auto-abc");
      expect(daemon.auto).toBe("auto-abc");
      await Promise.all([daemon.register(1_000_000), daemon.register(1_000_000)]);
      await daemon.register(1_000_000 + CLAIM_EVERY_MS - 1);
      expect(claims).toEqual(["auto-abc"]);
      await daemon.register(1_000_000 + CLAIM_EVERY_MS + 1);
      expect(claims).toEqual(["auto-abc", "auto-abc"]);

      const named = new Found();
      named.values.set("port", "9333");
      named.values.set("session", "work");
      const claimsNamed: string[] = [];
      const fixed = new SessionDaemon(named, undefined, () => "auto-xyz", async (_root, _namespace, _key, id) => (claimsNamed.push(id), { notice: null }));
      expect(fixed.session).toBe("work");
      await fixed.register();
      expect(claimsNamed).toEqual([]);

      const full = new Found();
      full.values.set("port", "9333");
      const refused = new SessionDaemon(full, undefined, () => "auto-full", async () => {
        throw new BrowseError("All 8 automatic sessions are open", 1, "session_limit");
      });
      const answer = await refused.run({ argv: ["here"], stdin: null, json: false, full: false, maxOutput: null });
      expect(answer).toMatchObject({ exit: 1, code: "session_limit" });
    } finally {
      if (saved[0] !== undefined) process.env["AGENT_BROWSER_SESSION"] = saved[0];
      if (saved[1] !== undefined) process.env["ARDIA_BROWSE_AUTO_SESSION"] = saved[1];
    }
  });
});
