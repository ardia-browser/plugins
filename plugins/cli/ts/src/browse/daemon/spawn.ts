import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { dumps, type JsonObject } from "../../json.ts";
import { utf8 } from "../../pystr.ts";
import { servedTable, type ServingSide } from "../../served.ts";
import { EndpointError, envEndpoint } from "../endpoint.ts";
import { closeFd, lockHeld, O_CREAT, O_RDONLY, O_TRUNC, O_WRONLY, openPrivateFile } from "../paths.ts";

export const START_TIMEOUT_MS = 15_000;
export const SERVED_ROW = "browse-daemon";
export const CHOICE_ENV = "ARDIA_BROWSE_DAEMON";
export const PYTHON_DAEMON = "from ardia_cli.browse import daemon; daemon.main()";
const LOG_TAIL = 2000;
const EAGER_POLL_MS = 5;
const EAGER_FOR_MS = 1000;
const POLL_MS = 30;

export type DaemonChoice = { kind: "ts"; program: string } | { kind: "python"; python: string; code: string };

export const ENDPOINT_ENV = ["ARDIA_WS", "ARDIA_PORT", "ARDIA_CDP_URL", "AGENT_BROWSER_CDP"] as const;
export const PLUGIN_ENV_PREFIX = "ARDIA_PLUGIN_";
export const PLUGIN_SWITCH = "ARDIA_BROWSE_FOR_PLUGIN";

export function daemonEnvironment(config: JsonObject, env: NodeJS.ProcessEnv = process.env): { config: JsonObject; env: NodeJS.ProcessEnv } {
  const folded = new Map(config);
  const dropped = (name: string) => (ENDPOINT_ENV as readonly string[]).includes(name) || name.startsWith(PLUGIN_ENV_PREFIX) || name === PLUGIN_SWITCH;
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!dropped(name)) kept[name] = value;
  }
  const unset = (field: string) => folded.get(field) === undefined || folded.get(field) === null;
  if (!unset("ws") || !unset("port")) return { config: folded, env: kept };
  let found;
  try {
    found = envEndpoint(env);
  } catch (error) {
    if (!(error instanceof EndpointError)) throw error;
    kept["ARDIA_PORT"] = env["ARDIA_PORT"];
    return { config: folded, env: kept };
  }
  if (found === null) return { config: folded, env: kept };
  if (found.kind === "ws") folded.set("ws", found.url);
  else if (found.port > 0n && found.port < 65536n) folded.set("port", found.port);
  else kept["ARDIA_PORT"] = env["ARDIA_PORT"];
  return { config: folded, env: kept };
}

export class DaemonDidNotStart extends Error {
  override readonly name = "DaemonDidNotStart";
}

export function daemonKind(env: NodeJS.ProcessEnv = process.env, served: Map<string, ServingSide> = servedTable()): "ts" | "python" {
  const asked = env[CHOICE_ENV];
  if (asked === "ts" || asked === "python") return asked;
  return served.get(SERVED_ROW) === "ts" ? "ts" : "python";
}

export function chooseDaemon(python: string | null, env: NodeJS.ProcessEnv = process.env, served: Map<string, ServingSide> = servedTable()): DaemonChoice | null {
  if (daemonKind(env, served) === "ts") return { kind: "ts", program: process.execPath };
  return python === null ? null : { kind: "python", python, code: PYTHON_DAEMON };
}

export type Spawned = {
  readonly child: ChildProcess;
  readonly written: Promise<void>;
  exited(): boolean;
};

export function spawnDaemon(dir: number, key: string, config: JsonObject, choice: DaemonChoice): Spawned {
  const [program, args] = choice.kind === "ts" ? [choice.program, ["daemon"]] : [choice.python, ["-I", "-c", choice.code]];
  const prepared = daemonEnvironment(config);
  const log = openPrivateFile(`${key}.log`, dir, O_WRONLY | O_CREAT | O_TRUNC);
  let child: ChildProcess;
  try {
    child = spawn(program, args, { stdio: ["pipe", log, log], detached: true, cwd: "/", env: prepared.env });
  } finally {
    closeFd(log);
  }
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.once("error", () => {
    exited = true;
  });
  const written = new Promise<void>((resolve) => {
    const stdin = child.stdin;
    if (stdin === null) {
      resolve();
      return;
    }
    stdin.once("error", () => resolve());
    stdin.end(utf8(dumps(prepared.config, "spaced")), () => resolve());
  });
  child.unref();
  return { child, written, exited: () => exited };
}

export function logTail(dir: number, key: string): string {
  let fd: number;
  try {
    fd = openPrivateFile(`${key}.log`, dir, O_RDONLY);
  } catch {
    return "";
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - LOG_TAIL);
    const buffer = Buffer.alloc(size - start);
    let got = 0;
    while (got < buffer.length) {
      const read = fs.readSync(fd, buffer, got, buffer.length - got, start + got);
      if (read === 0) break;
      got += read;
    }
    return buffer.subarray(0, got).toString("utf8").trim();
  } finally {
    closeFd(fd);
  }
}

export function pollDelay(elapsedMs: number): number {
  return elapsedMs < EAGER_FOR_MS ? EAGER_POLL_MS : POLL_MS;
}

export async function awaitDaemon<T>(dir: number, key: string, spawned: Spawned, connect: () => Promise<T | null>, timeoutMs = START_TIMEOUT_MS): Promise<T> {
  await spawned.written;
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const link = await connect();
    if (link !== null) return link;
    if (spawned.exited()) {
      const late = await connect();
      if (late !== null) return late;
      if (!lockHeld(`${key}.lock`, dir)) throw new DaemonDidNotStart(`the ardia browse daemon exited before it listened: ${logTail(dir, key) || "no output"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollDelay(performance.now() - started)));
  }
  throw new DaemonDidNotStart("the ardia browse daemon didn't start in 15 s");
}

export async function startDaemon<T>(dir: number, key: string, config: JsonObject, choice: DaemonChoice, connect: () => Promise<T | null>): Promise<T> {
  return awaitDaemon(dir, key, spawnDaemon(dir, key, config, choice), connect);
}
