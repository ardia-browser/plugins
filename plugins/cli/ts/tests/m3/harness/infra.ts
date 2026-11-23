import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { FIXTURES } from "./paths.ts";

export const DEFAULT_BASE = 9600;
export const BLOCK = 20;
export const RECORDED_FIXTURE = DEFAULT_BASE + BLOCK - 1;
const PROBE_MS = 200;
const TAKE_MS = 600_000;
const CHROME_START_MS = 30_000;
export const CHROME_ENV = "ARDIA_M3_CHROME";
export const CHROME_FLAGS = ["--headless", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
  "--disable-sync", "--disable-default-apps", "--mute-audio", "--hide-scrollbars", "--force-color-profile=srgb"];

export class PortsBusy extends Error {
  override readonly name = "PortsBusy";
}

export function portBase(): number {
  if (process.env["ARDIA_M3_PORTS"]) {
    throw new PortsBusy("ARDIA_M3_PORTS is gone: set ARDIA_M3_PORT_BASE to your block's first port (D3 9400, D4 9420, D5 9440, F1-early 9460, reviewers 9500 and up); the block is that port and the 19 after it");
  }
  const text = process.env["ARDIA_M3_PORT_BASE"] ?? String(DEFAULT_BASE);
  if (!/^[0-9]+$/.test(text) || Number(text) < 1024 || Number(text) > 65535 - BLOCK) {
    throw new PortsBusy(`ARDIA_M3_PORT_BASE must be a port from 1024 to ${65535 - BLOCK}, not ${JSON.stringify(text)}`);
  }
  return Number(text);
}

export function portRange(): [number, number] {
  const base = portBase();
  return [base, base + BLOCK - 1];
}

function listens(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, PROBE_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function bound(port: number): Promise<boolean> {
  if (!(await listens(port))) return true;
  return answers(port);
}

export async function checkBlock(low: number, high: number): Promise<void> {
  const ports = Array.from({ length: high - low + 1 }, (_, index) => low + index);
  const taken = (await Promise.all(ports.map(async (port) => ((await bound(port)) ? port : null)))).filter((port) => port !== null);
  if (taken.length > 0) {
    throw new PortsBusy(`ports ${taken.join(", ")} of the block ${low}-${high} are already bound (another agent's harness, or a run of yours still going); refusing to start so no daemon talks to someone else's tap. Wait for it, or set ARDIA_M3_PORT_BASE to your own block`);
  }
}

export type Pair = [number, number];

export class Ports {
  readonly fixture: number;
  private readonly free: Pair[] = [];
  private readonly waiting: ((pair: Pair) => void)[] = [];

  private constructor(low: number, high: number) {
    this.fixture = high;
    for (let chrome = low; chrome < high - 2; chrome += 2) this.free.push([chrome, chrome + 1]);
  }

  static async claim(): Promise<Ports> {
    const [low, high] = portRange();
    await checkBlock(low, high);
    return new Ports(low, high);
  }

  get size(): number {
    return this.free.length;
  }

  take(): Promise<Pair> {
    const pair = this.free.shift();
    if (pair !== undefined) return Promise.resolve(pair);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no port pair came free in 600 s")), TAKE_MS);
      this.waiting.push((given) => {
        clearTimeout(timer);
        resolve(given);
      });
    });
  }

  give(pair: Pair): void {
    const next = this.waiting.shift();
    if (next !== undefined) next(pair);
    else this.free.push(pair);
  }
}

export function bun(): string {
  return process.execPath;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".css": "text/css",
  ".txt": "text/plain",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".gz": "application/gzip",
};
const NOT_FOUND = `<!DOCTYPE HTML>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <title>Error response</title>
    </head>
    <body>
        <h1>Error response</h1>
        <p>Error code: 404</p>
        <p>Message: File not found.</p>
        <p>Error code explanation: 404 - Nothing matches the given URI.</p>
    </body>
</html>
`;

function translate(root: string, pathname: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  const words = path.posix.normalize(decoded).split("/").filter((word) => word && word !== "." && word !== "..");
  let found = path.join(root, ...words);
  if (pathname.endsWith("/")) found += "/";
  return found;
}

function notFound(): Response {
  return new Response(NOT_FOUND, { status: 404, headers: { "Content-Type": "text/html;charset=utf-8", Connection: "close", "Cache-Control": "no-store" } });
}

function served(file: string, head: boolean): Response {
  let size: number;
  let modified: Date;
  try {
    const info = statSync(file);
    if (!info.isFile()) return notFound();
    size = info.size;
    modified = info.mtime;
  } catch {
    return notFound();
  }
  const headers = { "Content-type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "Content-Length": String(size),
    "Last-Modified": modified.toUTCString(), "Cache-Control": "no-store" };
  return new Response(head ? null : readFileSync(file), { status: 200, headers });
}

export class FixtureServer {
  readonly base: string;
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor(port: number, root: string = FIXTURES) {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(request) {
        if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 501, headers: { "Cache-Control": "no-store" } });
        const url = new URL(request.url);
        let file = translate(root, url.pathname);
        let isDir = false;
        try {
          isDir = statSync(file).isDirectory();
        } catch {}
        if (isDir) {
          if (!url.pathname.endsWith("/")) return new Response(null, { status: 301, headers: { Location: `${url.pathname}/${url.search}`, "Content-Length": "0", "Cache-Control": "no-store" } });
          file = path.join(file, "index.html");
        } else if (url.pathname.endsWith("/")) return notFound();
        return served(file, request.method === "HEAD");
      },
    });
    this.base = `http://127.0.0.1:${port}`;
  }

  stop(): void {
    void this.server.stop(true);
  }
}

export function spawnGroup(argv: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; log?: string; stdin?: "pipe" | "ignore" }): ChildProcess {
  const log = options.log === undefined ? "ignore" : openSync(options.log, "w");
  try {
    return spawn(argv[0] as string, argv.slice(1), { cwd: options.cwd, env: options.env ?? process.env, detached: true, stdio: [options.stdin ?? "ignore", "pipe", log] });
  } finally {
    if (typeof log === "number") closeSync(log);
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {}
}

export function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export async function stop(child: ChildProcess | null, graceMs = 5000): Promise<void> {
  if (child === null) return;
  signalGroup(child, "SIGCONT");
  signalGroup(child, "SIGTERM");
  await exited(child, graceMs);
  signalGroup(child, "SIGKILL");
  await exited(child, graceMs);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function firstLine(child: ChildProcess, ms: number): Promise<string> {
  const stdout = child.stdout;
  if (stdout === null) return "";
  return new Promise((resolve) => {
    let text = "";
    const done = (line: string) => {
      clearTimeout(timer);
      stdout.off("data", onData);
      child.off("exit", onExit);
      resolve(line);
    };
    const onData = (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const end = text.indexOf("\n");
      if (end >= 0) done(text.slice(0, end));
    };
    const onExit = () => done(text);
    const timer = setTimeout(() => done(text), ms);
    stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

export function chromeBinary(): string {
  const found = process.env[CHROME_ENV];
  if (!found || !existsSync(found)) {
    throw new Error(`live modes need ${CHROME_ENV}, a pinned chrome-headless-shell (Chrome for Testing 158.0.8127.18, Playwright's chromium_headless_shell-1254; docs/m3-harness.md)`);
  }
  return found;
}

async function ours(port: number, profile: string): Promise<boolean> {
  let lines: string[];
  try {
    lines = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
  } catch {
    return false;
  }
  if (lines[0]?.trim() !== String(port) || !lines[1]?.startsWith("/devtools/browser/")) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const info = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    return typeof info.webSocketDebuggerUrl === "string" && new URL(info.webSocketDebuggerUrl).pathname === lines[1].trim();
  } catch {
    return false;
  }
}

export async function launchChrome(port: number, profile: string, window: [number, number]): Promise<ChildProcess> {
  mkdirSync(profile, { recursive: true });
  const log = openSync(path.join(path.dirname(profile), "chrome.log"), "w");
  let chrome: ChildProcess;
  try {
    chrome = spawn(chromeBinary(), [...CHROME_FLAGS, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${window[0]},${window[1]}`, "about:blank"],
      { detached: true, stdio: ["ignore", log, log] });
  } finally {
    closeSync(log);
  }
  const deadline = performance.now() + CHROME_START_MS;
  while (performance.now() < deadline) {
    if (chrome.exitCode !== null || chrome.signalCode !== null) break;
    if (await ours(port, profile)) return chrome;
    await sleep(100);
  }
  await stop(chrome);
  throw new Error(`the Chromium started on port ${port} didn't answer as itself within ${CHROME_START_MS / 1000} s (its DevToolsActivePort and /json/version must agree; another browser may hold the port; see chrome.log beside ${profile})`);
}
