
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { type JsonObject, type Value } from "../../src/json.ts";
import { browseDir, closeFd, sessionKey, socketIsOurs } from "../../src/browse/paths.ts";
import { awaitDaemon, type DaemonChoice, spawnDaemon } from "../../src/browse/daemon/spawn.ts";
import "../libc-loaded.ts";
export { lockHolder, staleSocket } from "../peers.ts";

export const TS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
export const CLI_DIR = path.resolve(TS_DIR, "..");
export const PROGRAM = process.env["ARDIA_M3_TS_PROGRAM"] ?? path.join(TS_DIR, "dist", "ardia-ts");

export type Scratch = { root: string; data: string; browse: string; done(): void };

export function scratch(): Scratch {
  const root = fs.mkdtempSync("/tmp/ardia-d2-");
  const data = path.join(root, "data");
  fs.mkdirSync(data, { mode: 0o700 });
  return {
    root,
    data,
    browse: path.join(data, "Browse"),
    done: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export function keyOf(session: string, port = 9): string {
  return sessionKey("", `port:${port}`, session);
}

export function config(data: string, session: string, extra: Record<string, Value> = {}, port = 9): JsonObject {
  return new Map<string, Value>([
    ["session", session],
    ["namespace", ""],
    ["key", keyOf(session, port)],
    ["data_root", data],
    ["ws", null],
    ["port", BigInt(port)],
    ["data_dir", data],
    ["endpoint_label", `--port ${port}`],
    ["idle_timeout_ms", null],
    ["debug", true],
    ["no_auto_dialog", false],
    ["pin_tab", null],
    ...Object.entries(extra),
  ]);
}

export function tsChoice(): DaemonChoice {
  return { kind: "ts", program: PROGRAM };
}

export function connectTo(file: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.connect(file);
    socket.once("connect", () => resolve(socket));
    socket.once("error", () => resolve(null));
  });
}

export function socketFile(data: string, key: string): string {
  return path.join(data, "Browse", `${key}.sock`);
}

export async function connectSession(data: string, key: string): Promise<net.Socket | null> {
  const dir = browseDir(data);
  try {
    if (socketIsOurs(`${key}.sock`, dir) === null) return null;
  } finally {
    closeFd(dir);
  }
  return connectTo(socketFile(data, key));
}

export async function start(data: string, session: string, choice = tsChoice(), extra: Record<string, Value> = {}, port = 9) {
  const key = keyOf(session, port);
  const dir = browseDir(data);
  try {
    const spawned = spawnDaemon(dir, key, config(data, session, extra, port), choice);
    const socket = await awaitDaemon(dir, key, spawned, () => connectSession(data, key));
    socket.destroy();
    return { key, spawned, pid: spawned.child.pid as number };
  } finally {
    closeFd(dir);
  }
}

export function raw(file: string, payload: Buffer | string, options: { end?: boolean; timeoutMs?: number } = {}): Promise<{ text: string; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(file);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ text: Buffer.concat(chunks).toString("utf8"), closed: false });
    }, options.timeoutMs ?? 20_000);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    const hungUp = () => {
      clearTimeout(timer);
      resolve({ text: Buffer.concat(chunks).toString("utf8"), closed: true });
    };
    socket.once("end", () => {
      hungUp();
      socket.destroy();
    });
    socket.once("close", hungUp);
    socket.once("error", (error) => {
      clearTimeout(timer);
      const code = (error as NodeJS.ErrnoException).code;
      if (chunks.length === 0 && code !== "EPIPE" && code !== "ECONNRESET") reject(error);
      else resolve({ text: Buffer.concat(chunks).toString("utf8"), closed: true });
    });
    socket.once("connect", () => {
      socket.write(payload);
      if (options.end) socket.end();
    });
  });
}

export async function ask(data: string, key: string, argv: string[], options: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const line = `${JSON.stringify({ argv, options, cwd: "/", env: {}, stdin: null, ...extra })}\n`;
  const { text } = await raw(socketFile(data, key), line);
  return JSON.parse(text) as Record<string, unknown>;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function until(check: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return check();
}

export async function sessionMeta(data: string, key: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const file = path.join(data, "Browse", `${key}.json`);
  if (!(await until(() => fs.existsSync(file), timeoutMs))) throw new Error(`${key}.json never appeared`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

export function quietWatchdog<T extends object>(daemon: T): T {
  return Object.assign(daemon, { watchdog: { arm: () => 0, disarm: () => 0 } });
}

export const PORT_BASE = Number(process.env["ARDIA_M3_PORT_BASE"] ?? "9400");
export const D2_FIRST_PORT = Number(process.env["ARDIA_D2_CHROME_PORT"] ?? String(PORT_BASE + 10));
