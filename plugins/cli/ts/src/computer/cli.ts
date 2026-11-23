import { isatty } from "node:tty";
import { guardedAfterUpdate } from "../after-update.ts";
import { parseArgs } from "../argparse-env.ts";
import { dumps, type Value } from "../json.ts";
import { execProgram } from "../libc.ts";
import { inert } from "../printable.ts";
import { osErrorText } from "../pyerr.ts";
import { pythonOsError } from "../printable.ts";
import { strerror } from "../paths.ts";
import { shellJoin, shellQuote } from "../pystrings.ts";
import type { CommandIo } from "../cmdio.ts";
import { DRIVER_COMMANDS, label } from "./label.ts";
import { ardiaCommand, CalledProcessError, linkCommand, needsRecovery, placeApp, quietlyOurs, recover, runDriverQuietly, signedByCua, staleNotice, withApplicationsLock, installedByArdia } from "./apps.ts";
import { APP_BINARY, appVersion, driverEnv, ensureDriver, Inconclusive, installedApp, isDirectory, lexists, Refused, tools, verifyApp, VERSION } from "./driver.ts";
import { classifyDriverExit, type Grants, missingGrantsIn, permissionCode } from "./codes.ts";
import { DaemonFailure, daemonListening, explicitSocket, readGrants, startDaemon } from "./daemon.ts";
import { daemonDownLines, daemonLines, notInstalledLine, permissionLines } from "./guidance.ts";
import { supervise } from "./supervise.ts";

const SERVER_NAME = "cua-driver";
const DAEMON_COMMANDS = ["mcp", "call", "serve", "permissions"];
const HANDED_OVER = ["mcp", "serve"];
const UNSUPPORTED = "ardia computer: computer use through cua-driver needs macOS here";
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
export function supported(): boolean {
  return process.platform === "darwin";
}

type Failure = { text: string; code: string };

function failureOf(error: unknown): Failure | undefined {
  if (error instanceof Refused) return { text: error.message, code: error.code };
  if (error instanceof CalledProcessError) return { text: error.message, code: "driver_install_failed" };
  if (typeof (error as NodeJS.ErrnoException | undefined)?.errno === "number") return { text: osErrorText(error), code: "driver_install_failed" };
  return undefined;
}

function fail(io: CommandIo, code: string, lines: readonly string[], status = 1): number {
  for (const line of lines) io.err(line);
  io.errorCode = code;
  return status;
}

async function guarded(io: CommandIo, work: () => Promise<number | undefined>): Promise<number | undefined> {
  try {
    const status = await work();
    if (status !== undefined && status !== 0 && io.errorCode === undefined) io.errorCode = "driver_check_failed";
    return status;
  } catch (error) {
    const failure = failureOf(error);
    if (failure === undefined) throw error;
    return fail(io, failure.code, [`ardia computer: ${failure.text}`]);
  }
}

function parseFailed(io: CommandIo, parsed: { status: number; stdout: string; stderr: string }): number {
  if (parsed.status !== 0) io.errorCode = "usage_error";
  return io.exitWith(parsed);
}

async function setup(io: CommandIo, argv: readonly string[]): Promise<number> {
  const parsed = parseArgs("ardia computer setup", argv);
  if (!parsed.ok) return parseFailed(io, parsed);
  if (!supported()) return fail(io, "unsupported_platform", [UNSUPPORTED]);
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
  if (parsed.values.get("no_grant") === true || !(isatty(0) && isatty(1))) {
    io.out("next: ardia computer permissions grant");
    return 0;
  }
  io.out("Asking macOS for Cua Driver's Accessibility and Screen Recording permissions…");
  return runDriver(io, ["permissions", "grant"]);
}

async function refresh(io: CommandIo): Promise<number> {
  if (!supported()) return 0;
  const dest = installedApp();
  const failed = await guardedAfterUpdate(() => guarded(io, async () => {
    return withApplicationsLock(async () => {
      if (!(await recover((line) => io.err(line)))) return 1;
      if (!isDirectory(dest) || appVersion(dest) === VERSION || !(await installedByArdia(dest))) return 0;
      io.out(await placeApp(await ensureDriver((line) => io.err(line))));
      return 0;
    });
  }));
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
  const parsed = parseArgs("ardia computer mcp-config", argv);
  if (!parsed.ok) return parseFailed(io, parsed);
  try {
    const target = parsed.values.get("target");
    io.out(mcpConfig(typeof target === "string" ? target : "general"));
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    return fail(io, error.code, [`ardia computer: ${error.message}`]);
  }
  return 0;
}

export type Exec = { binary: string; argv: string[] };

function permissionsStatus(argv: readonly string[]): boolean {
  return argv[0] === "permissions" && (argv[1] === undefined || argv[1] === "status" || argv[1].startsWith("-"));
}

async function resolveBinary(io: CommandIo, argv: readonly string[]): Promise<{ binary: string; installed: boolean } | number> {
  const app = installedApp();
  try {
    if (needsRecovery()) await withApplicationsLock(async () => recover((line) => io.err(line)));
  } catch (error) {
    const failure = error instanceof CalledProcessError ? undefined : failureOf(error);
    if (failure === undefined) throw error;
    return fail(io, failure.code, [`ardia computer: ${failure.text}`]);
  }
  if (lexists(app)) {
    try {
      await verifyApp(app);
    } catch (error) {
      if (error instanceof Inconclusive) return fail(io, error.code, [`ardia computer: ${error.message}; try again`]);
      if (error instanceof Refused) return fail(io, error.code, [`ardia computer: ${error.message}. ardia won't run it: move it away and run ardia computer setup`]);
      throw error;
    }
    const notice = staleNotice(app);
    if (notice) io.err(notice);
    return { binary: `${app}/${APP_BINARY}`, installed: true };
  }
  if (argv.length > 0 && DAEMON_COMMANDS.includes(argv[0] as string)) return fail(io, "driver_not_installed", [notInstalledLine(tools.applications, `ardia computer ${argv[0]}`)]);
  try {
    return { binary: `${await ensureDriver((line) => io.err(line))}/${APP_BINARY}`, installed: false };
  } catch (error) {
    const failure = error instanceof CalledProcessError ? undefined : failureOf(error);
    if (failure === undefined) throw error;
    return fail(io, failure.code, [`ardia computer: ${failure.text}`]);
  }
}

async function ensureDaemon(io: CommandIo, binary: string): Promise<number | undefined> {
  if (await daemonListening()) return undefined;
  try {
    await startDaemon(installedApp());
  } catch (error) {
    if (!(error instanceof DaemonFailure)) throw error;
    return fail(io, error.code, daemonLines(error.message, error.code));
  }
  const report = await readGrants(binary);
  const code = report?.running ? permissionCode(report.grants) : undefined;
  if (report?.running && code !== undefined) return fail(io, code, permissionLines(installedApp(), report.grants));
  return undefined;
}

async function grantsAfterFailure(binary: string): Promise<{ code: string; grants?: Grants } | undefined> {
  const report = await readGrants(binary);
  if (report === undefined) return undefined;
  if (!report.running) return { code: "daemon_not_running" };
  const code = permissionCode(report.grants);
  return code === undefined ? undefined : { code, grants: report.grants };
}

async function runSupervised(io: CommandIo, binary: string, installed: boolean, argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? "";
  const guided = installed && (command === "call" || command === "permissions");
  const ownSocket = explicitSocket(argv);
  if (installed && command === "call" && !ownSocket && !argv.some((word) => word === "-h" || word === "--help")) {
    const refused = await ensureDaemon(io, binary);
    if (refused !== undefined) return refused;
  }
  io.flush();
  const ran = await supervise(binary, [binary, ...argv], driverEnv());
  if (ran.spawnErrno !== undefined) return fail(io, "driver_spawn_failed", [`${pythonOsError(ran.spawnErrno)}: [Errno ${ran.spawnErrno}] ${strerror(ran.spawnErrno)}: '${binary}'`]);
  if (ran.status === 0) {
    if (guided && permissionsStatus(argv)) {
      const report = await readGrants(binary);
      if (report?.running && permissionCode(report.grants) !== undefined) for (const line of permissionLines(installedApp(), report.grants)) io.err(line);
    }
    return 0;
  }
  let code = classifyDriverExit(command, ran.status, ran.tail);
  let grants = missingGrantsIn(ran.tail);
  if (guided && !ownSocket && grants === undefined && code !== "bad_arguments" && code !== "driver_signal") {
    const found = await grantsAfterFailure(binary);
    if (found !== undefined) {
      code = found.code;
      grants = found.grants;
    }
  }
  if (guided && grants !== undefined) return fail(io, code, permissionLines(installedApp(), grants), ran.status);
  if (guided && code === "daemon_not_running") return fail(io, code, daemonDownLines(ownSocket), ran.status);
  io.errorCode = code;
  return ran.status;
}

async function runDriver(io: CommandIo, argv: readonly string[]): Promise<number> {
  if (!supported()) return fail(io, "unsupported_platform", [UNSUPPORTED]);
  const resolved = await resolveBinary(io, argv);
  if (typeof resolved === "number") return resolved;
  const { binary, installed } = resolved;
  if (argv.length > 0 && HANDED_OVER.includes(argv[0] as string)) {
    io.exec = { binary, argv: [binary, ...argv] };
    return 0;
  }
  return runSupervised(io, binary, installed, argv);
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
  if (first in REFUSED && Object.hasOwn(REFUSED, first)) return fail(io, "driver_command_refused", [REFUSED[first] as string], 2);
  return runDriver(io, first === "help" ? ["--help", ...argv.slice(1)] : argv);
}

export function execDriver(exec: Exec): never {
  return execProgram(exec.binary, exec.argv, driverEnv());
}

export { inert, label, DRIVER_COMMANDS };
