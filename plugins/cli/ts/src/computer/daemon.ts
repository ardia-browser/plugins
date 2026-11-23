import { createConnection } from "node:net";
import { home, join } from "../paths.ts";
import { RunCancelled, RunTimedOut } from "../proc/group.ts";
import { APP_NAME, driverEnv, runTool, tools } from "./driver.ts";
import { type Grants, grantsOf } from "./codes.ts";

const CONNECT_TIMEOUT_MS = 500;
const POLL_MS = 100;
const OPEN_TIMEOUT_S = 30;
const STATUS_TIMEOUT_S = 10;

export const daemonTiming = { startTimeoutMs: 15_000 };

export class DaemonFailure extends Error {
  constructor(
    message: string,
    readonly code: "daemon_start_failed" | "daemon_timeout",
  ) {
    super(message);
  }
}

export class Stopped extends Error {}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function defaultSocket(): string {
  return tools.socket ?? join(home(), "Library", "Caches", "cua-driver", "cua-driver.sock");
}

export function explicitSocket(argv: readonly string[]): boolean {
  return argv.some((word) => word === "--socket" || word.startsWith("--socket="));
}

export function daemonListening(socket: string = defaultSocket()): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = createConnection({ path: socket });
    const done = (up: boolean) => {
      clearTimeout(timer);
      connection.removeAllListeners();
      connection.on("error", () => {});
      connection.destroy();
      resolve(up);
    };
    const timer = setTimeout(() => done(false), CONNECT_TIMEOUT_MS);
    connection.once("connect", () => done(true));
    connection.once("error", () => done(false));
  });
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
}

export async function startDaemon(app: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Stopped();
  const argv = [tools.open, "-g", "-a", app, "--args", "serve"];
  let opened;
  try {
    opened = await runTool(argv, OPEN_TIMEOUT_S, undefined, signal);
  } catch (error) {
    if (error instanceof RunCancelled) throw new Stopped();
    if (error instanceof RunTimedOut) throw new DaemonFailure(`macOS didn't open ${APP_NAME} within ${OPEN_TIMEOUT_S} s`, "daemon_timeout");
    throw new DaemonFailure(`couldn't ask macOS to open ${APP_NAME}`, "daemon_start_failed");
  }
  if (opened.code !== 0) {
    const why = firstLine(opened.stderr || opened.stdout);
    throw new DaemonFailure(`macOS couldn't open ${app}${why === "" ? ` (open exit ${opened.code})` : `: ${why}`}`, "daemon_start_failed");
  }
  const deadline = performance.now() + daemonTiming.startTimeoutMs;
  while (performance.now() < deadline) {
    if (signal?.aborted) throw new Stopped();
    if (await daemonListening()) return;
    await pause(POLL_MS, signal);
  }
  if (signal?.aborted) throw new Stopped();
  throw new DaemonFailure(`Cua Driver's background service didn't start within ${Math.ceil(daemonTiming.startTimeoutMs / 1000)} s`, "daemon_timeout");
}

export type GrantReport = { running: false } | { running: true; grants: Grants } | undefined;

export async function readGrants(binary: string, signal?: AbortSignal): Promise<GrantReport> {
  let result;
  try {
    result = await runTool([binary, "permissions", "status", "--json"], STATUS_TIMEOUT_S, driverEnv(), signal);
  } catch (error) {
    if (error instanceof RunCancelled) throw new Stopped();
    return undefined;
  }
  if (result.code !== 0) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  const report = grantsOf(payload);
  if (report === undefined) return undefined;
  return report.running && report.grants !== undefined ? { running: true, grants: report.grants } : { running: false };
}
