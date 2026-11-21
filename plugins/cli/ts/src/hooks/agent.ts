import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { installedDataDir } from "../control.ts";
import { type JsonObject, type Value } from "../json.ts";
import { abspath, envSet, home, join, LINUX, purePath, expandUser, env } from "../paths.ts";
import { dumpsXml, type PlistValue } from "../plist.ts";
import { reprStr } from "../py.ts";
import { pySplitlines, pyStrip } from "../pystrings.ts";
import { run, RunTimedOut } from "../proc/group.ts";
import { cliHome } from "../usage.ts";
import { HooksError } from "./model.ts";

export const LABEL = "dev.ardia.hooks";
export const SERVICE = `${LABEL}.service`;
const RESTART_SECONDS = 10;
const DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
export const TOOL_TIMEOUT = 20;
const SERVICE_PROPERTIES = ["LoadState", "ActiveState", "SubState", "UnitFileState", "MainPID", "ExecMainStatus"];

export type AgentPaths = {
  home: string;
  cliHome: string;
  linux: boolean;
  configHome: string | null;
  stateHome: string | null;
  ardiaConfigHome: string | null;
};

function xdgDir(variable: string, ...fallback: string[]): string {
  const value = env(variable);
  if (value && value.startsWith("/")) return purePath(value);
  return join(home(), ...fallback);
}

export function agentPaths(linux: boolean = LINUX): AgentPaths {
  if (linux) {
    const given = env("ARDIA_CLI_HOME");
    const chosen = given ? given : join(xdgDir("XDG_DATA_HOME", ".local", "share"), "ardia", "cli");
    return {
      home: home(),
      cliHome: purePath(expandUser(chosen)),
      linux: true,
      configHome: xdgDir("XDG_CONFIG_HOME", ".config"),
      stateHome: xdgDir("XDG_STATE_HOME", ".local", "state"),
      ardiaConfigHome: abspath(dirname(installedDataDir(true))),
    };
  }
  return { home: home(), cliHome: cliHome(), linux: false, configHome: null, stateHome: null, ardiaConfigHome: null };
}

export function agentsDir(paths: AgentPaths): string {
  return paths.linux ? join(paths.configHome as string, "systemd", "user") : join(paths.home, "Library", "LaunchAgents");
}

export function plistPath(paths: AgentPaths): string {
  return join(agentsDir(paths), `${LABEL}.plist`);
}

export function unitPath(paths: AgentPaths): string {
  return join(agentsDir(paths), SERVICE);
}

export function definitionPath(paths: AgentPaths): string {
  return paths.linux ? unitPath(paths) : plistPath(paths);
}

export function logsDir(paths: AgentPaths): string {
  return paths.linux ? join(paths.stateHome as string, "ardia") : join(paths.home, "Library", "Logs", "Ardia");
}

export function logPath(paths: AgentPaths): string {
  return join(logsDir(paths), "hooks.log");
}

export async function launcherPath(paths: AgentPaths): Promise<string> {
  const installed = join(paths.cliHome, "current", "bin", "ardia");
  if (paths.linux || existsSync(installed)) return installed;
  const { trustedLauncher } = await import("../computer/apps.ts");
  return trustedLauncher() ?? installed;
}

export function agentPlist(paths: AgentPaths, launcher: string, pathEnv: string | undefined): Map<string, PlistValue> {
  return new Map<string, PlistValue>([
    ["Label", LABEL],
    ["ProgramArguments", [launcher, "hooks", "run", "--log", logPath(paths)]],
    ["RunAtLoad", true],
    ["KeepAlive", true],
    ["ProcessType", "Background"],
    ["WorkingDirectory", paths.home],
    ["EnvironmentVariables", new Map<string, PlistValue>([["PATH", pathEnv || DEFAULT_PATH], ["ARDIA_DATA_DIR", ""]])],
    ["StandardOutPath", "/dev/null"],
    ["StandardErrorPath", "/dev/null"],
  ]);
}

export function agentPlistText(paths: AgentPaths, launcher: string, pathEnv: string | undefined): string {
  return dumpsXml(agentPlist(paths, launcher, pathEnv));
}

export type Completed = { returncode: number; stdout: string; stderr: string };
export type Tool = (argv: string[]) => Promise<Completed>;

export class ToolTimedOut extends Error {
  constructor(readonly timeout: number) {
    super("timed out");
  }
}

async function runTool(argv: string[]): Promise<Completed> {
  try {
    const ran = await run(argv, { timeout: TOOL_TIMEOUT });
    return { returncode: ran.code, stdout: ran.stdout.toString("utf8"), stderr: ran.stderr.toString("utf8") };
  } catch (error) {
    if (error instanceof RunTimedOut) throw new ToolTimedOut(TOOL_TIMEOUT);
    throw error;
  }
}

export const launchctl: Tool = (argv) => runTool(["/bin/launchctl", ...argv]);
export const systemctl: Tool = (argv) => runTool(["systemctl", "--user", ...argv]);

export function domain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

export async function agentState(tool: Tool = launchctl): Promise<JsonObject> {
  let result: Completed;
  try {
    result = await tool(["print", `${domain()}/${LABEL}`]);
  } catch {
    return new Map<string, Value>([["loaded", null]]);
  }
  if (result.returncode !== 0) return new Map<string, Value>([["loaded", false]]);
  const state: JsonObject = new Map<string, Value>([["loaded", true]]);
  for (const line of pySplitlines(result.stdout)) {
    const stripped = pyStrip(line);
    const at = stripped.indexOf(" = ");
    if (at < 0) continue;
    const key = stripped.slice(0, at);
    const value = stripped.slice(at + 3);
    const name = key.replace(/ /g, "_");
    if (["state", "pid", "last exit code"].includes(key) && !state.has(name)) state.set(name, /^-?[0-9]+$/.test(value) ? BigInt(value) : value);
  }
  return state;
}

export function systemdText(value: string): string {
  if ([...value].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) throw new HooksError(`${reprStr(value)} has control characters, which a systemd unit can't hold`);
  return value.replace(/%/g, "%%");
}

export function systemdQuote(value: string, expandsVariables = true): string {
  let text = systemdText(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  if (expandsVariables) text = text.replace(/\$/g, "$$$$");
  return `"${text}"`;
}

export function serviceUnit(paths: AgentPaths, launcher: string, pathEnv: string | undefined): string {
  const command = [launcher, "hooks", "run", "--log", logPath(paths)].map((part) => systemdQuote(part)).join(" ");
  const pinned = [`PATH=${pathEnv || DEFAULT_PATH}`, "ARDIA_DATA_DIR="];
  if (paths.ardiaConfigHome !== null) pinned.push(`ARDIA_CONFIG_HOME=${paths.ardiaConfigHome}`);
  const environment = pinned.map((item) => systemdQuote(item, false)).join(" ");
  return `[Unit]
Description=Ardia hooks (ardia hooks run)
StartLimitIntervalSec=0

[Service]
Type=exec
ExecStart=${command}
WorkingDirectory=${systemdText(paths.home)}
Environment=${environment}
Restart=on-failure
RestartSec=${RESTART_SECONDS}
StandardOutput=null
StandardError=null

[Install]
WantedBy=default.target
`;
}

export async function serviceState(tool: Tool = systemctl): Promise<JsonObject> {
  let result: Completed;
  try {
    result = await tool(["show", SERVICE, `--property=${SERVICE_PROPERTIES.join(",")}`]);
  } catch {
    return new Map<string, Value>([["loaded", null]]);
  }
  if (result.returncode !== 0) return new Map<string, Value>([["loaded", null]]);
  const values = new Map<string, string>();
  for (const line of pySplitlines(result.stdout)) {
    const stripped = pyStrip(line);
    const at = stripped.indexOf("=");
    if (at >= 0) values.set(stripped.slice(0, at), stripped.slice(at + 1));
  }
  if (values.get("LoadState") !== "loaded") return new Map<string, Value>([["loaded", false]]);
  const state: JsonObject = new Map<string, Value>([
    ["loaded", true],
    ["active", values.get("ActiveState") === "active"],
    ["state", values.get("ActiveState") ?? ""],
    ["substate", values.get("SubState") ?? ""],
    ["enabled", values.get("UnitFileState") ?? ""],
  ]);
  const pid = values.get("MainPID") ?? "0";
  if (/^[0-9]+$/.test(pid) && BigInt(pid) > 0n) state.set("pid", BigInt(pid));
  const status = values.get("ExecMainStatus") ?? "";
  if (/^-?[0-9]+$/.test(status)) state.set("last_exit_code", BigInt(status));
  return state;
}

export { envSet };
