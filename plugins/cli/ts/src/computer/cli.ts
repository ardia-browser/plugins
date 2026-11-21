import { isatty } from "node:tty";
import { requireDefaultWidth, parseOptions } from "../argparse.ts";
import { dumps, type Value } from "../json.ts";
import { execProgram } from "../libc.ts";
import { inert } from "../printable.ts";
import { osErrorText } from "../pyerr.ts";
import { shellJoin, shellQuote } from "../pystrings.ts";
import type { CommandIo } from "../cmdio.ts";
import { DRIVER_COMMANDS, label } from "./label.ts";
import { ardiaCommand, CalledProcessError, linkCommand, needsRecovery, placeApp, quietlyOurs, recover, runDriverQuietly, signedByCua, staleNotice, withApplicationsLock, installedByArdia } from "./apps.ts";
import { APP_BINARY, APP_NAME, appVersion, driverEnv, ensureDriver, Inconclusive, installedApp, isDirectory, lexists, Refused, tools, verifyApp, VERSION } from "./driver.ts";

const SERVER_NAME = "cua-driver";
const DAEMON_COMMANDS = ["mcp", "call", "serve", "permissions"];
const TARGETS = ["general", "claude-code", "codex", "cursor", "opencode"];
const PINNED_MESSAGE = `ardia computer: cua-driver is pinned at ${VERSION} and updates with the ardia command (the app installs new versions), not through cua's installer`;
const REFUSED: Record<string, string> = {
  update: PINNED_MESSAGE,
  channel: PINNED_MESSAGE,
  skills: "ardia computer: run `ardia skills install --target <agent>`; it installs cua-driver's skill pinned to this driver next to ardia's",
};
export const HELP = `usage: ardia computer <cua-driver command> [args]
       ardia computer setup
       ardia computer mcp-config [--target general|claude-code|codex|cursor|opencode]

Operates native Mac apps (computer use) through cua-driver ${VERSION} (github.com/trycua/cua, MIT), pinned and
checked by ardia. Use ardia browse for web pages in Ardia.

  setup        download the pinned driver, put CuaDriver.app in /Applications (macOS ties the Accessibility and
               Screen Recording permissions to it), link a cua-driver command to this one, then ask for the
               permissions
  mcp-config   print the MCP server entry for an agent, pointing at ardia computer mcp
  help         cua-driver's own help (every other command goes to cua-driver unchanged)

Common commands: mcp, list-tools, describe <tool>, call <tool> '<json>', permissions status|grant, doctor, stop.
update, channel and skills are ardia's job here: the driver updates with ardia, and ardia skills install adds its skill.
`;
const SETUP_USAGE = "usage: ardia computer setup [-h] [--no-grant]\n";
const SETUP_HELP = `${SETUP_USAGE}
Download the pinned cua-driver, put CuaDriver.app in /Applications and ask for
its permissions.

options:
  -h, --help  show this help message and exit
  --no-grant  stop before asking for the permissions
`;
const MCP_USAGE = `usage: ardia computer mcp-config [-h]
                                 [--target {general,claude-code,codex,cursor,opencode}]
`;
const MCP_HELP = `${MCP_USAGE}
Print the MCP server entry for an agent. It runs ardia computer mcp, so it
keeps working across ardia and cua-driver updates.

options:
  -h, --help            show this help message and exit
  --target {general,claude-code,codex,cursor,opencode}
                        claude-code and codex print the command that adds it;
                        the others print the JSON to paste (default: general)
`;

export function supported(): boolean {
  return process.platform === "darwin";
}

function failureText(error: unknown): string | undefined {
  if (error instanceof Refused || error instanceof CalledProcessError) return error.message;
  if (typeof (error as NodeJS.ErrnoException | undefined)?.errno === "number") return osErrorText(error);
  return undefined;
}

async function guarded(io: CommandIo, work: () => Promise<number | undefined>): Promise<number | undefined> {
  try {
    return await work();
  } catch (error) {
    const text = failureText(error);
    if (text === undefined) throw error;
    io.err(`ardia computer: ${text}`);
    return 1;
  }
}

async function setup(io: CommandIo, argv: readonly string[]): Promise<number> {
  const parsed = parseOptions(argv, [{ long: "--help", short: "-h", kind: "help" }, { long: "--no-grant", kind: "flag" }], "ardia computer setup", SETUP_USAGE, SETUP_HELP);
  if (parsed.kind === "exit") return io.exitWith(parsed);
  if (!supported()) {
    io.err("ardia computer: computer use through cua-driver needs macOS here");
    return 1;
  }
  const failed = await guarded(io, async () => {
    const recovered = await withApplicationsLock(async () => {
      if (!(await recover((line) => io.err(line)))) return false;
      io.out(await placeApp(await ensureDriver((line) => io.err(line))));
      return true;
    });
    if (!recovered) return 1;
    io.out(linkCommand());
    return undefined;
  });
  if (failed !== undefined) return failed;
  const dest = installedApp();
  if ((await quietlyOurs(dest)) && (await signedByCua(dest))) {
    if ((await runDriverQuietly(`${dest}/${APP_BINARY}`, "telemetry", "disable")) === 0) io.out("cua-driver telemetry off (cua-driver telemetry enable turns it back on)");
  }
  if (parsed.flags.has("--no-grant") || !(isatty(0) && isatty(1))) {
    io.out("next: ardia computer permissions grant");
    return 0;
  }
  io.out("Asking macOS for Cua Driver's Accessibility and Screen Recording permissions…");
  return runDriver(io, ["permissions", "grant"]);
}

async function refresh(io: CommandIo): Promise<number> {
  if (!supported()) return 0;
  const dest = installedApp();
  const failed = await guarded(io, async () => {
    return withApplicationsLock(async () => {
      if (!(await recover((line) => io.err(line)))) return 1;
      if (!isDirectory(dest) || appVersion(dest) === VERSION || !(await installedByArdia(dest))) return 0;
      io.out(await placeApp(await ensureDriver((line) => io.err(line))));
      return 0;
    });
  });
  return failed ?? 0;
}

export function mcpConfig(target: string): string {
  const command = ardiaCommand();
  const args = ["computer", "mcp"];
  if (target === "claude-code") {
    const entry = dumps(new Map<string, Value>([["command", command], ["args", args]]), "spaced", true);
    return `claude mcp add-json --scope user ${SERVER_NAME} ${shellQuote(entry)}`;
  }
  if (target === "codex") return `codex mcp add ${SERVER_NAME} -- ${shellJoin([command, ...args])}`;
  if (target === "opencode") {
    const server = new Map<string, Value>([["type", "local"], ["command", [command, ...args]], ["enabled", true]]);
    return dumps(new Map<string, Value>([["mcp", new Map<string, Value>([[SERVER_NAME, server]])]]), "indented", true);
  }
  const entry = new Map<string, Value>([["command", command], ["args", args]]);
  if (target === "cursor") entry.set("type", "stdio");
  return dumps(new Map<string, Value>([["mcpServers", new Map<string, Value>([[SERVER_NAME, entry]])]]), "indented", true);
}

function printMcpConfig(io: CommandIo, argv: readonly string[]): number {
  const parsed = parseOptions(argv, [{ long: "--help", short: "-h", kind: "help" }, { long: "--target", kind: "value", choices: TARGETS }], "ardia computer mcp-config", MCP_USAGE, MCP_HELP, { usageLine: "usage: ardia computer mcp-config [-h] [--target {general,claude-code,codex,cursor,opencode}]\n" });
  if (parsed.kind === "exit") return io.exitWith(parsed);
  try {
    io.out(mcpConfig(parsed.values.get("--target") ?? "general"));
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    io.err(`ardia computer: ${error.message}`);
    return 1;
  }
  return 0;
}

export type Exec = { binary: string; argv: string[] };

async function runDriver(io: CommandIo, argv: readonly string[]): Promise<number> {
  if (!supported()) {
    io.err("ardia computer: computer use through cua-driver needs macOS here");
    return 1;
  }
  const app = installedApp();
  try {
    if (needsRecovery()) await withApplicationsLock(async () => recover((line) => io.err(line)));
  } catch (error) {
    const text = error instanceof Refused ? error.message : typeof (error as NodeJS.ErrnoException)?.errno === "number" ? osErrorText(error) : undefined;
    if (text === undefined) throw error;
    io.err(`ardia computer: ${text}`);
    return 1;
  }
  let binary: string;
  if (lexists(app)) {
    try {
      await verifyApp(app);
    } catch (error) {
      if (error instanceof Inconclusive) {
        io.err(`ardia computer: ${error.message}; try again`);
        return 1;
      }
      if (error instanceof Refused) {
        io.err(`ardia computer: ${error.message}. ardia won't run it: move it away and run ardia computer setup`);
        return 1;
      }
      throw error;
    }
    binary = `${app}/${APP_BINARY}`;
    const notice = staleNotice(app);
    if (notice) io.err(notice);
  } else if (argv.length > 0 && DAEMON_COMMANDS.includes(argv[0] as string)) {
    io.err(`ardia computer: Cua Driver isn't set up yet. Run ardia computer setup: it puts ${APP_NAME} in ${tools.applications}, which macOS ties the Accessibility and Screen Recording permissions to`);
    return 1;
  } else {
    try {
      binary = `${await ensureDriver((line) => io.err(line))}/${APP_BINARY}`;
    } catch (error) {
      const text = error instanceof Refused ? error.message : typeof (error as NodeJS.ErrnoException)?.errno === "number" ? osErrorText(error) : undefined;
      if (text === undefined) throw error;
      io.err(`ardia computer: ${text}`);
      return 1;
    }
  }
  io.exec = { binary, argv: [binary, ...argv] };
  return 0;
}

export async function computerMain(io: CommandIo, argv: readonly string[]): Promise<number> {
  const first = argv[0];
  if (first === undefined || first === "-h" || first === "--help") {
    io.write(HELP);
    return 0;
  }
  if (first === "setup") return setup(io, argv.slice(1));
  if (first === "mcp-config") return printMcpConfig(io, argv.slice(1));
  if (first === "refresh" && argv.length === 1) return refresh(io);
  if (first in REFUSED && Object.hasOwn(REFUSED, first)) {
    io.err(REFUSED[first] as string);
    return 2;
  }
  return runDriver(io, first === "help" ? ["--help", ...argv.slice(1)] : argv);
}

export function execDriver(exec: Exec): never {
  return execProgram(exec.binary, exec.argv, driverEnv());
}

export { inert, label, requireDefaultWidth, DRIVER_COMMANDS };
