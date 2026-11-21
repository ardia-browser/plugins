import { closeSync, fstatSync, openSync } from "node:fs";
import { constants } from "node:os";
import { NOT_REACHABLE } from "./control.ts";
import { parse } from "./json.ts";
import { baseName, errnoOf, join, LINUX, strerror, uid } from "./paths.ts";
import { O_NOFOLLOW, O_NONBLOCK, O_RDONLY, readFd } from "./privatefs.ts";

const CONTROL_FILE = "ArdiaControl.json";
const MAX_CONTROL_FILE = 64 * 1024;
const BROWSER_PATH = /^\/devtools\/browser\/[0-9A-Za-z-]{1,128}\n?$/;
const TOKEN = /^[\x21-\x7e]{16,1024}\n?$/;

export class EndpointError extends Error {}

export function chromiumDir(root: string): string {
  return LINUX ? root : join(root, "Chromium");
}

function alive(pid: bigint): boolean {
  if (pid > BigInt(Number.MAX_SAFE_INTEGER)) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function intLike(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1n : 0n;
  return undefined;
}

export function requireControl(root: string): void {
  const path = join(chromiumDir(root), CONTROL_FILE);
  const name = baseName(path);
  let fd: number;
  try {
    fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === constants.errno.ENOENT) throw new EndpointError(NOT_REACHABLE);
    const reason = errno === constants.errno.ELOOP ? "is a symbolic link" : strerror(errno);
    throw new EndpointError(`${NOT_REACHABLE} (${name} ${reason})`);
  }
  let raw: Buffer;
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new EndpointError(`${NOT_REACHABLE} (${name} isn't a regular file)`);
    if (info.uid !== uid()) throw new EndpointError(`${NOT_REACHABLE} (${name} belongs to another user)`);
    if ((info.mode & 0o7777) !== 0o600) throw new EndpointError(`${NOT_REACHABLE} (${name} must be mode 0600)`);
    raw = readFd(fd, MAX_CONTROL_FILE + 1);
  } finally {
    closeSync(fd);
  }
  const control = parse(raw, 1000);
  if (control === undefined) throw new EndpointError(`${NOT_REACHABLE} (${name} isn't valid JSON)`);
  if (!(control instanceof Map)) throw new EndpointError(`${NOT_REACHABLE} (${name} isn't valid)`);
  const port = intLike(control.get("port"));
  const browser = control.get("browser");
  const token = control.get("token");
  const pid = intLike(control.get("pid"));
  if (port === undefined || !(port > 0n && port < 65536n)) throw new EndpointError(`${NOT_REACHABLE} (${name} has no valid port)`);
  if (typeof browser !== "string" || !BROWSER_PATH.test(browser)) throw new EndpointError(`${NOT_REACHABLE} (${name} has no valid browser path)`);
  if (typeof token !== "string" || !TOKEN.test(token)) throw new EndpointError(`${NOT_REACHABLE} (${name} has no valid token)`);
  if (pid === undefined || pid <= 1n || !alive(pid)) throw new EndpointError(NOT_REACHABLE);
}
