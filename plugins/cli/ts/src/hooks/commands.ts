import { existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { writeText, explicitDataRoot } from "../configfiles.ts";
import type { CommandIo } from "../cmdio.ts";
import { dataRoot } from "../control.ts";
import { dumps, type JsonObject, type Value } from "../json.ts";
import { envSet, expandUser, join, purePath } from "../paths.ts";
import { osErrorText, strerrorOr } from "../pyerr.ts";
import { SOCKET_FILE } from "../protocol.ts";
import { pySplitlines, pyStrip } from "../pystrings.ts";
import { routedCaller } from "../routed.ts";
import { connectStream } from "../stream.ts";
import { SpawnFailed } from "../proc/group.ts";
import { pythonOsError } from "../printable.ts";
import {
  agentPaths, agentPlistText, agentState, type AgentPaths, agentsDir, type Completed, definitionPath, domain, LABEL, launchctl, launcherPath, logPath, logsDir, plistPath, SERVICE, serviceState, serviceUnit, systemctl, type Tool, ToolTimedOut, unitPath,
} from "./agent.ts";
import { hooksFile } from "./cli.ts";
import { Log } from "./log.ts";
import { type Hook, HooksError, HookValueError, makeHook, MIN_IDLE, parseDuration, readHooks } from "./model.ts";
import { LAUNCH_STATE, Service, watchHooks } from "./service.ts";

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function scratch(dataDir: string | undefined): boolean {
  return Boolean(dataDir) || Boolean(process.env.ARDIA_DATA_DIR);
}

function agentWord(paths: AgentPaths): string {
  return paths.linux ? "systemd user service" : "LaunchAgent";
}

export async function hooksList(io: CommandIo, dataDir: string | undefined, json: boolean, launch: Tool = launchctl, systemd: Tool = systemctl): Promise<number> {
  const path = hooksFile(dataDir);
  let problem: string | null = null;
  let found: Hook[] = [];
  try {
    found = readHooks(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") problem = `there's no ${path} yet`;
    else if (error instanceof HooksError) problem = `${path}: ${error.message}`;
    else if (typeof (error as NodeJS.ErrnoException).errno === "number") problem = `${path}: ${strerrorOr(error)}`;
    else throw error;
  }
  const paths = agentPaths();
  const installed = lexists(definitionPath(paths));
  let state: JsonObject;
  if (!installed || scratch(dataDir)) state = new Map<string, Value>([["loaded", false]]);
  else state = paths.linux ? await serviceState(systemd) : await agentState(launch);
  const failed = problem !== null && lexists(path) ? 1 : 0;
  if (json) {
    const agent: JsonObject = new Map<string, Value>([["installed", installed], ...state]);
    const document = new Map<string, Value>([
      ["file", path],
      ["problem", problem],
      ["hooks", found.map((hook) => hook.toDict())],
      ["agent", agent],
    ]);
    io.out(dumps(document, "indented"));
    return failed;
  }
  for (const hook of found) {
    const match = hook.patterns.length > 0 ? `  match ${hook.patterns.join(" ")}` : "";
    io.out(`${hook.name}  [${hook.kind()}]  ${hook.trigger()}${match}  ${hook.action()}`);
  }
  if (problem !== null) io.err(`ardia hooks: ${problem}`);
  if (paths.linux) {
    if (!installed) io.out(`systemd user service ${SERVICE}: not installed (ardia hooks install)`);
    else if (state.get("loaded") === null) io.out(`systemd user service ${SERVICE}: installed, state unknown (systemctl --user didn't answer)`);
    else {
      const running = state.get("pid") ? ` (pid ${state.get("pid")})` : "";
      const active = state.get("active") ? "active" : `installed, ${state.get("state") || "not loaded"}`;
      io.out(`systemd user service ${SERVICE}: ${active}${running}`);
    }
  } else if (!installed) io.out(`LaunchAgent ${LABEL}: not installed (ardia hooks install)`);
  else {
    const pid = state.get("pid");
    const running = pid !== undefined && pid !== 0n && pid !== "" ? `, running (pid ${pid})` : "";
    io.out(`LaunchAgent ${LABEL}: ${state.get("loaded") ? "loaded" : "installed, not loaded"}${running}`);
  }
  return failed;
}

function refuseScratch(io: CommandIo, dataDir: string | undefined, verb: string): boolean {
  if (!scratch(dataDir)) return false;
  io.err(`ardia hooks ${verb}: refused while --data-dir or $ARDIA_DATA_DIR picks a data dir; the ${agentWord(agentPaths())} is for the installed Ardia only`);
  return true;
}

class Uncaught extends Error {}

function uncaught(error: unknown): never {
  if (error instanceof SpawnFailed) throw new Uncaught(`${pythonOsError(error.errno)}: ${osErrorText(Object.assign(new Error(), { errno: error.errno, path: "/bin/launchctl" }))}`);
  throw error;
}

async function tool(run: Tool, argv: string[]): Promise<Completed> {
  try {
    return await run(argv);
  } catch (error) {
    if (error instanceof ToolTimedOut) throw error;
    return uncaught(error);
  }
}

function stuck(io: CommandIo, verb: string, error: ToolTimedOut): number {
  io.err(`ardia hooks ${verb}: launchctl didn't answer in ${error.timeout} s; try again, or check launchctl print ${domain()}/${LABEL}`);
  return 1;
}

async function guardedTool(io: CommandIo, verb: string, work: () => Promise<number>): Promise<number> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ToolTimedOut) return stuck(io, verb, error);
    if (error instanceof Uncaught) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export async function hooksInstall(io: CommandIo, dataDir: string | undefined, launch: Tool = launchctl, systemd: Tool = systemctl, pause: (seconds: number) => Promise<void> = sleep): Promise<number> {
  return guardedTool(io, "install", async () => {
    if (refuseScratch(io, dataDir, "install")) return 1;
    const paths = agentPaths();
    const launcher = await launcherPath(paths);
    if (!existsSync(launcher)) {
      io.err(`ardia hooks install: the ardia command isn't installed at ${launcher}; install Command Line in Ardia's Settings › Plugins`);
      return 1;
    }
    const file = hooksFile(dataDir);
    try {
      readHooks(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") io.err(`warning: there's no ${file} yet; the hooks start once it exists`);
      else if (error instanceof HooksError) io.err(`warning: ${error.message}`);
      else if (typeof (error as NodeJS.ErrnoException).errno === "number") io.err(`warning: ${osErrorText(error)}`);
      else throw error;
    }
    if (paths.linux) return serviceInstall(io, paths, launcher, systemd);
    mkdirSync(agentsDir(paths), { recursive: true });
    mkdirSync(logsDir(paths), { recursive: true });
    writeText(plistPath(paths), agentPlistText(paths, launcher, process.env.PATH));
    await tool(launch, ["bootout", `${domain()}/${LABEL}`]);
    let result: Completed | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      result = await tool(launch, ["bootstrap", domain(), plistPath(paths)]);
      if (result.returncode === 0) break;
      await pause(0.5);
    }
    if (result === undefined || result.returncode !== 0) {
      const detail = pyStrip(result?.stderr || result?.stdout || "");
      io.err(`ardia hooks install: launchctl bootstrap failed (${detail || result?.returncode})`);
      return 1;
    }
    io.out(`installed ${LABEL}: ${plistPath(paths)}`);
    io.out(`it runs ${launcher} hooks run at login and keeps it alive; output goes to ${logPath(paths)}`);
    return 0;
  });
}

async function runSystemctl(run: Tool, argv: string[]): Promise<[Completed | null, string | null]> {
  try {
    return [await run(argv), null];
  } catch (error) {
    if (error instanceof SpawnFailed && error.code === "ENOENT") return [null, "systemctl isn't installed; ardia hooks needs a systemd user session"];
    if (error instanceof ToolTimedOut) return [null, `systemctl --user ${argv.join(" ")} failed (Command '${["systemctl", "--user", ...argv].map((word) => `'${word}'`).join(", ")}' timed out after ${error.timeout} seconds)`];
    return [null, `systemctl --user ${argv.join(" ")} failed (${strerrorOr(error)})`];
  }
}

function systemctlFailure(result: Completed, argv: string[]): string {
  const detail = pySplitlines(pyStrip(result.stderr || result.stdout));
  return `systemctl --user ${argv.join(" ")} failed (${detail.length > 0 ? detail[detail.length - 1] : result.returncode})`;
}

async function serviceInstall(io: CommandIo, paths: AgentPaths, launcher: string, run: Tool): Promise<number> {
  let unit: string;
  try {
    unit = serviceUnit(paths, launcher, process.env.PATH);
  } catch (error) {
    if (!(error instanceof HooksError)) throw error;
    io.err(`ardia hooks install: ${error.message}`);
    return 1;
  }
  mkdirSync(agentsDir(paths), { recursive: true });
  mkdirSync(logsDir(paths), { recursive: true });
  writeText(unitPath(paths), unit);
  for (const argv of [["daemon-reload"], ["enable", SERVICE], ["restart", SERVICE]]) {
    const [result, problem] = await runSystemctl(run, argv);
    const reason = result !== null && result.returncode !== 0 ? systemctlFailure(result, argv) : problem;
    if (reason) {
      io.err(`ardia hooks install: ${reason}`);
      return 1;
    }
  }
  io.out(`installed ${SERVICE}: ${unitPath(paths)}`);
  io.out(`it runs ${launcher} hooks run at login and restarts it when it fails; output goes to ${logPath(paths)}`);
  return 0;
}

async function serviceUninstall(io: CommandIo, paths: AgentPaths, run: Tool): Promise<number> {
  const [result, problem] = await runSystemctl(run, ["disable", "--now", SERVICE]);
  const existed = lexists(unitPath(paths));
  if (existed) {
    unlinkSync(unitPath(paths));
    await runSystemctl(run, ["daemon-reload"]);
  }
  if (!existed) {
    io.out(`${SERVICE} wasn't installed`);
    return 0;
  }
  if (problem || (result !== null && result.returncode !== 0)) io.err(`warning: ${problem || systemctlFailure(result as Completed, ["disable", "--now", SERVICE])}`);
  io.out(`uninstalled ${SERVICE}`);
  return 0;
}

export async function hooksUninstall(io: CommandIo, dataDir: string | undefined, launch: Tool = launchctl, systemd: Tool = systemctl): Promise<number> {
  return guardedTool(io, "uninstall", async () => {
    if (refuseScratch(io, dataDir, "uninstall")) return 1;
    const paths = agentPaths();
    if (paths.linux) return serviceUninstall(io, paths, systemd);
    const result = await tool(launch, ["bootout", `${domain()}/${LABEL}`]);
    const existed = lexists(plistPath(paths));
    if (existed) unlinkSync(plistPath(paths));
    if (!existed && result.returncode !== 0) {
      io.out(`${LABEL} wasn't installed`);
      return 0;
    }
    io.out(`uninstalled ${LABEL}`);
    return 0;
  });
}

function socketFor(dataDir: string | undefined): string {
  return join(dataRoot(dataDir), SOCKET_FILE);
}

type Stoppable = { stop(): Promise<void> };

async function runUntilSignal(service: Stoppable, main: (stopped: () => boolean) => Promise<void>): Promise<number> {
  let received: string | undefined;
  let wake: (() => void) | undefined;
  const signalled = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((name) => {
    const handler = () => {
      received ??= name;
      wake?.();
    };
    process.on(name, handler);
    return [name, handler] as const;
  });
  try {
    await Promise.race([main(() => received !== undefined), signalled]);
  } finally {
    for (const [name, handler] of handlers) process.off(name, handler);
    await service.stop();
  }
  return received === "SIGINT" ? 130 : 0;
}

export async function hooksRun(io: CommandIo, dataDir: string | undefined, logOption: string | undefined): Promise<number> {
  const paths = agentPaths();
  const logFile = logOption === "-" ? null : logOption ? purePath(expandUser(logOption)) : logPath(paths);
  const log = new Log(logFile);
  const path = hooksFile(dataDir);
  const socket = socketFor(dataDir);
  const caller = routedCaller();
  const service = new Service(socket, log, true, (where) => connectStream(where, caller), undefined, undefined, join(socket.slice(0, socket.lastIndexOf("/")) || "/", LAUNCH_STATE));
  try {
    return await runUntilSignal(service, async (stopped) => {
      log.write(`ardia hooks run: watching ${path}`);
      try {
        await Promise.all([watchHooks(path, service, log, stopped), service.runForever()]);
      } catch (error) {
        const name = error instanceof Error ? error.constructor.name : "Error";
        log.write(`ardia hooks run stopped: ${name}: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    });
  } finally {
    log.close();
    void io;
  }
}

function idleSeconds(text: string | undefined): number | null {
  if (text === undefined) return null;
  const seconds = parseDuration(text);
  if (seconds === null || seconds < MIN_IDLE) throw new HookValueError(`--idle ${text}: give a duration like 30m, at least 1m`);
  return seconds;
}

export type OnArgs = { dataDir: string | undefined; events: string; match: string[]; timeout: number; idle: string | undefined; fullUrls: boolean; program: string[] | undefined };

export async function cmdOn(io: CommandIo, args: OnArgs): Promise<number> {
  if (!args.program || args.program.length === 0) {
    io.err("ardia on: give the program after --, like: ardia on tab.opened -- ~/bin/hook");
    return 1;
  }
  let hook: Hook;
  try {
    const idle = idleSeconds(args.idle);
    hook = makeHook("on", args.events.split(",").filter((event) => event !== ""), args.match, args.program, args.timeout, idle, args.fullUrls);
  } catch (error) {
    if (!(error instanceof HookValueError)) throw error;
    io.err(`ardia on: ${error.message}`);
    return 1;
  }
  const caller = routedCaller();
  const service = new Service(socketFor(args.dataDir), new Log(), false, (where) => connectStream(where, caller));
  service.setHooks([hook]);
  return runUntilSignal(service, () => service.runForever());
}

export { envSet, explicitDataRoot };
