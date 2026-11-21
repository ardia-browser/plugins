import fs from "node:fs";
import http from "node:http";
import { constants } from "node:os";
import { dataRoot, NOT_REACHABLE } from "../control.ts";
import { parse, parseText } from "../json.ts";
import { codeOf, errnoOf, LINUX, uid } from "../paths.ts";
import { addSecret, redact } from "../redact.ts";
import { parseQsl, quote, urlsplit } from "../pylib/urllib.ts";
import { connectAt, peerPid, peerUid, socketInfoAt, strerror } from "../libc.ts";
import { announcePath } from "./daemon/announce.ts";
import { closeFd, readFdUpTo } from "./paths.ts";
import { Cancelled, checkCancelled, currentSignal } from "./cdp/cancel.ts";
import { isSpace, strip } from "../py.ts";
import { codePoints } from "../pystr.ts";
import { reprText } from "../pylib/str.ts";
import { decimalValue } from "../pylib/unicode.ts";

export const CONTROL_FILE = "ArdiaControl.json";
const BROWSER_PATH = /^\/devtools\/browser\/[0-9A-Za-z-]{1,128}\n?$/;
const TOKEN = /^[\x21-\x7e]{16,1024}\n?$/;
const MAX_CONTROL_FILE = 64 * 1024;
const PORT_TIMEOUT_MS = 3000;
const SOCKET_PROBE_MS = 500;
const EPERM = 1;
const ENOENT = 2;
const EACCES = 13;
const ECONNREFUSED = LINUX ? 111 : 61;
const S_IFMT = 0o170000;
const S_IFSOCK = 0o140000;
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = fs.constants;

export class EndpointError extends Error {
  override readonly name = "EndpointError";
}

export type Endpoint = {
  readonly ws: string;
  readonly source: string;
  readonly explicit: boolean;
  readonly active: string | null;
  readonly instance: string | null;
};

export type EndpointConfig = { ws?: unknown; port?: unknown; data_dir?: unknown };

export function controlFilePath(root: string): string {
  return LINUX ? `${root}/${CONTROL_FILE}` : `${root}/Chromium/${CONTROL_FILE}`;
}

export function registerUrlSecrets(url: string): void {
  for (const [name, value] of parseQsl(urlsplit(url).query, true)) if (name === "token") addSecret(value);
}

function fromWs(url: string, source: string): Endpoint {
  const parts = urlsplit(url);
  if ((parts.scheme !== "ws" && parts.scheme !== "wss") || !parts.netloc || !parts.path.startsWith("/devtools/browser/")) {
    throw new EndpointError(`${source} must be a ws://host:port/devtools/browser/<id> URL`);
  }
  registerUrlSecrets(url);
  const host = parts.netloc.slice(parts.netloc.lastIndexOf("@") + 1);
  return { ws: url, source, explicit: true, active: null, instance: `${host}${parts.path}` };
}

async function fromPort(given: bigint | number, source: string, signal: AbortSignal | null): Promise<Endpoint> {
  const exact = typeof given === "bigint" ? given : BigInt(Math.trunc(given));
  if (!(exact > 0n && exact < 65536n)) throw new EndpointError(`${source} must be between 1 and 65535, not ${exact}`);
  const port = Number(exact);
  let info: unknown;
  try {
    info = parseText((await versionBody(port, signal)).toString("utf8"));
  } catch (error) {
    if (error instanceof Cancelled) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    const errno = typeof code === "string" && Object.hasOwn(constants.errno, code) ? (constants.errno as Record<string, number>)[code] ?? 0 : 0;
    const reason = errno > 0 ? `[Errno ${errno}] ${strerror(errno)}` : error instanceof Error && error.message ? error.message : "can't connect";
    throw new EndpointError(`no DevTools server answers on 127.0.0.1:${port} (${redact(reason)})`);
  }
  const ws = info instanceof Map ? info.get("webSocketDebuggerUrl") : undefined;
  if (typeof ws !== "string") throw new EndpointError(`127.0.0.1:${port}/json/version has no webSocketDebuggerUrl`);
  return fromWs(ws, `${source} ${port}`);
}

function versionBody(port: number, signal: AbortSignal | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Cancelled());
      return;
    }
    let settled = false;
    const finish = (fail: unknown, body?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", aborted);
      if (fail === null) resolve(body as Buffer);
      else reject(fail);
    };
    const request = http.get({ host: "127.0.0.1", port, path: "/json/version", timeout: PORT_TIMEOUT_MS, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        if (size <= MAX_CONTROL_FILE) chunks.push(chunk);
        size += chunk.length;
      });
      response.on("end", () => {
        if ((response.statusCode ?? 0) >= 400) finish(new Error(`HTTP Error ${response.statusCode}: ${response.statusMessage ?? ""}`));
        else finish(null, Buffer.concat(chunks).subarray(0, MAX_CONTROL_FILE));
      });
      response.on("error", (error) => finish(error));
    });
    const aborted = () => {
      finish(new Cancelled());
      request.destroy();
    };
    const deadline = setTimeout(() => {
      finish(new Error("timed out"));
      request.destroy();
    }, PORT_TIMEOUT_MS);
    signal?.addEventListener("abort", aborted, { once: true });
    request.on("timeout", () => {
      finish(new Error("timed out"));
      request.destroy();
    });
    request.on("error", (error) => finish(error));
  });
}

function intSpace(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x80 ? " \t\n\v\f\r".includes(ch) : isSpace(ch);
}

export function pythonInt(text: string): bigint | null {
  const body = strip(text, intSpace);
  let sign = 1n;
  let at = 0;
  if (body.startsWith("+") || body.startsWith("-")) {
    if (body.startsWith("-")) sign = -1n;
    at = 1;
  }
  const points = codePoints(body.slice(at));
  if (points.length === 0 || points[0] === "_" || points[points.length - 1] === "_") return null;
  let digits = "";
  let previous = "";
  for (const point of points) {
    if (point === "_") {
      if (previous === "_") return null;
    } else {
      const value = decimalValue(point.codePointAt(0) as number);
      if (value < 0) return null;
      digits += String(value);
    }
    previous = point;
  }
  return sign * BigInt(digits);
}

export function portNumber(text: string): bigint {
  const value = pythonInt(text);
  if (value === null) throw new EndpointError(`ARDIA_PORT must be a port number, not ${reprText(text)}`);
  return value;
}

export type PidState = "running" | "gone" | "unsignalable";

export function pidState(pid: number, signal: (pid: number, sig: 0) => unknown = (target, sig) => process.kill(target, sig)): PidState {
  try {
    signal(pid, 0);
    return "running";
  } catch (error) {
    return codeOf(error) === "EPERM" ? "unsignalable" : "gone";
  }
}

export type SocketProbe = (folder: string, name: string, pid: number) => void;

export class SocketUntrusted extends Error {
  override readonly name = "SocketUntrusted";
}

function verifiedSocket(folder: string, name: string, pid: number): void {
  const dir = fs.openSync(folder, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    const info = socketInfoAt(dir, name);
    if ((info.mode & S_IFMT) !== S_IFSOCK) throw new SocketUntrusted("isn't a socket");
    if (info.uid !== uid()) throw new SocketUntrusted("belongs to another user");
    const fd = connectAt(dir, name, SOCKET_PROBE_MS);
    try {
      if (peerUid(fd) !== uid()) throw new SocketUntrusted("isn't served by your user");
      if (peerPid(fd) !== pid) throw new SocketUntrusted(`is served by another process than pid ${pid}, so the control file is stale`);
    } finally {
      closeFd(fd);
    }
  } finally {
    closeFd(dir);
  }
}

export function sandboxHint(pid: number, socketPath: string, probe: SocketProbe = verifiedSocket): string | undefined {
  const at = socketPath.lastIndexOf("/");
  const lead = `pid ${pid} can't be signalled`;
  try {
    probe(at <= 0 ? "/" : socketPath.slice(0, at), socketPath.slice(at + 1), pid);
    return undefined;
  } catch (error) {
    if (error instanceof SocketUntrusted) return `${lead} and ${socketPath} ${error.message}`;
    const errno = errnoOf(error);
    if (errno === ENOENT) return `${lead} and there's no ${socketPath}`;
    if (errno === ECONNREFUSED) return `${lead} and nothing accepts on ${socketPath}`;
    const reason = errno > 0 ? strerror(errno) : "couldn't connect";
    if (errno === EPERM || errno === EACCES) return `${lead} and ${socketPath} refused a connection (${reason}); a sandbox or the folder's permissions may be blocking it`;
    return `${lead} and ${socketPath} couldn't be reached (${reason})`;
  }
}

function pyInt(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1n : 0n;
  return undefined;
}

function pyIntText(value: unknown): string {
  return typeof value === "boolean" ? (value ? "True" : "False") : String(value);
}

export function fromControlFile(file: string, signal: (pid: number, sig: 0) => unknown = (target, sig) => process.kill(target, sig)): Endpoint {
  const label = file.slice(file.lastIndexOf("/") + 1);
  let fd: number;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new EndpointError(NOT_REACHABLE);
    const errno = -((error as NodeJS.ErrnoException).errno ?? 0);
    const reason = code === "ELOOP" ? "is a symbolic link" : strerror(errno);
    throw new EndpointError(`${NOT_REACHABLE} (${label} ${reason})`);
  }
  let raw: Buffer;
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile()) throw new EndpointError(`${NOT_REACHABLE} (${label} isn't a regular file)`);
    if (info.uid !== process.getuid?.()) throw new EndpointError(`${NOT_REACHABLE} (${label} belongs to another user)`);
    if ((info.mode & 0o7777) !== 0o600) throw new EndpointError(`${NOT_REACHABLE} (${label} must be mode 0600)`);
    raw = readFdUpTo(fd, MAX_CONTROL_FILE);
  } finally {
    closeFd(fd);
  }
  const control = parse(raw, Number.POSITIVE_INFINITY);
  if (control === undefined) throw new EndpointError(`${NOT_REACHABLE} (${label} isn't valid JSON)`);
  if (!(control instanceof Map)) throw new EndpointError(`${NOT_REACHABLE} (${label} isn't valid)`);
  const port = control.get("port");
  const browser = control.get("browser");
  const token = control.get("token");
  const pid = control.get("pid");
  const generation = control.get("generation");
  const portNumber = pyInt(port);
  if (!(portNumber !== undefined && portNumber > 0n && portNumber < 65536n)) throw new EndpointError(`${NOT_REACHABLE} (${label} has no valid port)`);
  if (!(typeof browser === "string" && BROWSER_PATH.test(browser))) throw new EndpointError(`${NOT_REACHABLE} (${label} has no valid browser path)`);
  if (!(typeof token === "string" && TOKEN.test(token))) throw new EndpointError(`${NOT_REACHABLE} (${label} has no valid token)`);
  addSecret(token);
  const pidNumber = pyInt(pid);
  if (!(pidNumber !== undefined && pidNumber > 1n && pidNumber < 2n ** 31n)) throw new EndpointError(NOT_REACHABLE);
  const state = pidState(Number(pidNumber), signal);
  if (state === "gone") throw new EndpointError(NOT_REACHABLE);
  const problem = state === "unsignalable" ? sandboxHint(Number(pidNumber), announcePath(file)) : undefined;
  if (problem !== undefined) throw new EndpointError(`${NOT_REACHABLE} (${problem})`);
  const query = `token=${quote(token, "")}`;
  return {
    ws: `ws://127.0.0.1:${pyIntText(port)}${browser}?${query}`,
    source: file,
    explicit: false,
    active: `http://127.0.0.1:${pyIntText(port)}/ardia/active?${query}`,
    instance: `${pyIntText(pid)}:${pyInt(generation) === undefined ? "0" : pyIntText(generation)}:${browser}`,
  };
}

function setting(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export type EnvEndpoint = { kind: "ws"; url: string; source: string } | { kind: "port"; port: bigint; source: string };

export function envEndpoint(env: NodeJS.ProcessEnv = process.env): EnvEndpoint | null {
  const ws = env["ARDIA_WS"];
  if (ws) return { kind: "ws", url: ws, source: "ARDIA_WS" };
  const port = env["ARDIA_PORT"];
  if (port) return { kind: "port", port: portNumber(port), source: "ARDIA_PORT" };
  const cdp = env["ARDIA_CDP_URL"];
  if (cdp) return { kind: "ws", url: cdp, source: "ARDIA_CDP_URL" };
  return null;
}

export async function resolve(config: EndpointConfig, signal: AbortSignal | null = currentSignal()): Promise<Endpoint> {
  checkCancelled(signal);
  const ws = setting(config.ws);
  if (ws !== null) return fromWs(ws, "--ws");
  if (typeof config.port === "number" || typeof config.port === "bigint") return fromPort(typeof config.port === "bigint" ? config.port : Number(config.port), "--port", signal);
  const fromEnv = envEndpoint();
  if (fromEnv !== null) return fromEnv.kind === "ws" ? fromWs(fromEnv.url, fromEnv.source) : fromPort(fromEnv.port, fromEnv.source, signal);
  const dataDir = setting(config.data_dir);
  const found = fromControlFile(controlFilePath(dataRoot(dataDir ?? undefined)));
  checkCancelled(signal);
  return found;
}

export function unreachableMessage(endpoint: Endpoint, error: unknown): string {
  if (!endpoint.explicit) return NOT_REACHABLE;
  const detail = (error instanceof Error && error.message) || (error instanceof Error ? error.name : "Error");
  return redact(`can't connect to ${endpoint.source} (${detail})`);
}
