import fs from "node:fs";
import http from "node:http";
import { constants } from "node:os";
import { dataRoot, NOT_REACHABLE } from "../control.ts";
import { parseText } from "../json.ts";
import { LINUX } from "../paths.ts";
import { addSecret, redact } from "../redact.ts";
import { parseQsl, quote, urlsplit } from "../pylib/urllib.ts";
import { strerror } from "../libc.ts";
import { closeFd, readFdUpTo } from "./paths.ts";

export const CONTROL_FILE = "ArdiaControl.json";
const BROWSER_PATH = /^\/devtools\/browser\/[0-9A-Za-z-]{1,128}$/;
const TOKEN = /^[\x21-\x7e]{16,1024}$/;
const MAX_CONTROL_FILE = 64 * 1024;
const PORT_TIMEOUT_MS = 3000;
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

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
  return { ws: url, source, explicit: true, active: null, instance: `${parts.netloc}${parts.path}` };
}

async function fromPort(port: number, source: string): Promise<Endpoint> {
  if (!(port > 0 && port < 65536)) throw new EndpointError(`${source} must be between 1 and 65535, not ${port}`);
  let info: unknown;
  try {
    info = parseText((await versionBody(port)).toString("utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const errno = typeof code === "string" && Object.hasOwn(constants.errno, code) ? (constants.errno as Record<string, number>)[code] ?? 0 : 0;
    const reason = errno > 0 ? `[Errno ${errno}] ${strerror(errno)}` : error instanceof Error && error.message ? error.message : "can't connect";
    throw new EndpointError(`no DevTools server answers on 127.0.0.1:${port} (${redact(reason)})`);
  }
  const ws = info instanceof Map ? info.get("webSocketDebuggerUrl") : undefined;
  if (typeof ws !== "string") throw new EndpointError(`127.0.0.1:${port}/json/version has no webSocketDebuggerUrl`);
  return fromWs(ws, `${source} ${port}`);
}

function versionBody(port: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/json/version", timeout: PORT_TIMEOUT_MS, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        if (size <= MAX_CONTROL_FILE) chunks.push(chunk);
        size += chunk.length;
      });
      response.on("end", () => {
        if ((response.statusCode ?? 0) >= 400) reject(new Error(`HTTP Error ${response.statusCode}: ${response.statusMessage ?? ""}`));
        else resolve(Buffer.concat(chunks).subarray(0, MAX_CONTROL_FILE));
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", reject);
  });
}

function portNumber(text: string): number {
  if (!/^\s*[+-]?[0-9]+(_[0-9]+)*\s*$/u.test(text)) throw new EndpointError(`ARDIA_PORT must be a port number, not '${text}'`);
  return Number.parseInt(text.replaceAll("_", ""), 10);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function fromControlFile(file: string): Endpoint {
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
  let control;
  try {
    control = parseText(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    control = undefined;
  }
  if (control === undefined) throw new EndpointError(`${NOT_REACHABLE} (${label} isn't valid JSON)`);
  if (!(control instanceof Map)) throw new EndpointError(`${NOT_REACHABLE} (${label} isn't valid)`);
  const port = control.get("port");
  const browser = control.get("browser");
  const token = control.get("token");
  const pid = control.get("pid");
  const generation = control.get("generation");
  if (!(typeof port === "bigint" && port > 0n && port < 65536n)) throw new EndpointError(`${NOT_REACHABLE} (${label} has no valid port)`);
  if (!(typeof browser === "string" && BROWSER_PATH.test(browser))) throw new EndpointError(`${NOT_REACHABLE} (${label} has no valid browser path)`);
  if (!(typeof token === "string" && TOKEN.test(token))) throw new EndpointError(`${NOT_REACHABLE} (${label} has no valid token)`);
  addSecret(token);
  if (!(typeof pid === "bigint" && pid > 1n && pid < 2n ** 31n && alive(Number(pid)))) throw new EndpointError(NOT_REACHABLE);
  const query = `token=${quote(token, "")}`;
  return {
    ws: `ws://127.0.0.1:${port}${browser}?${query}`,
    source: file,
    explicit: false,
    active: `http://127.0.0.1:${port}/ardia/active?${query}`,
    instance: `${pid}:${typeof generation === "bigint" ? generation : 0n}:${browser}`,
  };
}

function setting(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export async function resolve(config: EndpointConfig): Promise<Endpoint> {
  const ws = setting(config.ws);
  if (ws !== null) return fromWs(ws, "--ws");
  if (typeof config.port === "number" || typeof config.port === "bigint") return fromPort(Number(config.port), "--port");
  const envWs = process.env["ARDIA_WS"];
  if (envWs) return fromWs(envWs, "ARDIA_WS");
  const envPort = process.env["ARDIA_PORT"];
  if (envPort) return fromPort(portNumber(envPort), "ARDIA_PORT");
  const envCdp = process.env["ARDIA_CDP_URL"];
  if (envCdp) return fromWs(envCdp, "ARDIA_CDP_URL");
  const dataDir = setting(config.data_dir);
  return fromControlFile(controlFilePath(dataRoot(dataDir ?? undefined)));
}

export function unreachableMessage(endpoint: Endpoint, error: unknown): string {
  if (!endpoint.explicit) return NOT_REACHABLE;
  const detail = (error instanceof Error && error.message) || (error instanceof Error ? error.name : "Error");
  return redact(`can't connect to ${endpoint.source} (${detail})`);
}
