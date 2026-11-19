import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { type JsonObject, type Value } from "../../src/json.ts";
import { browseDir, closeFd, sessionKey, socketIsOurs } from "../../src/browse/paths.ts";
import { awaitDaemon, type DaemonChoice, spawnDaemon } from "../../src/browse/daemon/spawn.ts";
import "../libc-loaded.ts";

export const TS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
export const CLI_DIR = path.resolve(TS_DIR, "..");
export const PROGRAM = process.env["ARDIA_M3_TS_PROGRAM"] ?? path.join(TS_DIR, "dist", "ardia-ts");
export const PYTHON = process.env["ARDIA_TEST_PYTHON"] ?? "python3";
export const PYTHON_CODE = `import sys; sys.path.insert(0, ${JSON.stringify(CLI_DIR)}); from ardia_cli.browse import daemon; daemon.main()`;

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

export function pythonChoice(): DaemonChoice {
  return { kind: "python", python: PYTHON, code: PYTHON_CODE };
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
    socket.once("close", () => {
      clearTimeout(timer);
      resolve({ text: Buffer.concat(chunks).toString("utf8"), closed: true });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      if (chunks.length === 0 && (error as NodeJS.ErrnoException).code !== "EPIPE" && (error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
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

export async function lockHolder(file: string): Promise<{ release(): void }> {
  const child = spawn(PYTHON, ["-c", "import fcntl,os,sys; fd=os.open(sys.argv[1], os.O_RDWR|os.O_CREAT, 0o600); fcntl.flock(fd, fcntl.LOCK_EX); print('held', flush=True); sys.stdin.read()", file], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  await new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
  return {
    release: () => {
      child.stdin?.end();
      child.kill();
    },
  };
}

export function staleSocket(file: string): void {
  spawnSync(PYTHON, ["-c", "import socket,sys,os; os.umask(0o177); s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()", file]);
}
