import fs from "node:fs";
import { dataRoot, NOT_REACHABLE } from "../control.ts";
import { parse, type Value } from "../json.ts";
import { envSet, errnoOf, expandUser, LINUX, purePath, strerror, uid } from "../paths.ts";

const CONTROL_FILE = "ArdiaControl.json";
const BROWSER_PATH = /^\/devtools\/browser\/[0-9A-Za-z-]{1,128}\n?$/;
const TOKEN = /^[\x21-\x7e]{16,1024}\n?$/;
const MAX_CONTROL_FILE = 64 * 1024;
const ENOENT = 2;
const ELOOP = LINUX ? 40 : 62;

export class EndpointError extends Error {
  override readonly name = "EndpointError";
}

export function controlFilePath(root: string): string {
  return LINUX ? `${root}/${CONTROL_FILE}` : `${root}/Chromium/${CONTROL_FILE}`;
}

export function explicitDataRoot(dataDir: string | undefined): string | null {
  const root = dataDir || envSet("ARDIA_DATA_DIR");
  return root ? purePath(expandUser(root)) : null;
}

export { dataRoot };

function unreachable(detail?: string): EndpointError {
  return new EndpointError(detail === undefined ? NOT_REACHABLE : `${NOT_REACHABLE} (${CONTROL_FILE} ${detail})`);
}

function isPort(value: Value | undefined): boolean {
  if (value === true) return true;
  return typeof value === "bigint" && value > 0n && value < 65536n;
}

function alive(pid: bigint): boolean {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export function requireControl(root: string): void {
  const path = controlFilePath(root);
  let fd: number;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === ENOENT) throw new EndpointError(NOT_REACHABLE);
    if (errno === 0) throw error;
    throw unreachable(errno === ELOOP ? "is a symbolic link" : strerror(errno));
  }
  let raw: Buffer;
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile()) throw unreachable("isn't a regular file");
    if (info.uid !== uid()) throw unreachable("belongs to another user");
    if ((info.mode & 0o7777) !== 0o600) throw unreachable("must be mode 0600");
    const buffer = Buffer.alloc(MAX_CONTROL_FILE + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, null);
    raw = buffer.subarray(0, count);
  } finally {
    fs.closeSync(fd);
  }
  const control = parse(raw, Number.POSITIVE_INFINITY);
  if (control === undefined) throw unreachable("isn't valid JSON");
  if (!(control instanceof Map)) throw unreachable("isn't valid");
  const browser = control.get("browser");
  const token = control.get("token");
  const pid = control.get("pid");
  if (!isPort(control.get("port"))) throw unreachable("has no valid port");
  if (!(typeof browser === "string" && BROWSER_PATH.test(browser))) throw unreachable("has no valid browser path");
  if (!(typeof token === "string" && TOKEN.test(token))) throw unreachable("has no valid token");
  if (!(typeof pid === "bigint" && pid > 1n && alive(pid))) throw new EndpointError(NOT_REACHABLE);
}
