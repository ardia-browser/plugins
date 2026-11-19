import { createHash } from "node:crypto";
import fs from "node:fs";
import { constants } from "node:os";
import { dumps, parseText, type Value } from "../json.ts";
import { flock, listAt, mkdirAt, openAt, openFileAt, renameAt, statAt, unlinkAt } from "../libc.ts";
import { codeOf, errnoOf, uid } from "../paths.ts";
import { plain } from "../pystr.ts";

const { O_RDONLY, O_RDWR, O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW, O_DIRECTORY, S_IFMT, S_IFSOCK } = fs.constants;
const { ELOOP, ENOTDIR } = constants.errno;
export { O_RDONLY, O_RDWR, O_WRONLY, O_CREAT, O_TRUNC };

export const DIR_NAME = "Browse";
export const MAX_META = 64 * 1024;
const CREATE_RETRIES = 4;
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class PathError extends Error {
  override readonly name = "PathError";
}

export function wellFormed(text: string): string {
  return plain(text).toWellFormed();
}

export function checkName(kind: string, name: unknown): string {
  if (typeof name !== "string" || !SESSION_NAME.test(name)) {
    throw new PathError(`${kind} must be 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit`);
  }
  return name;
}

export function sessionKey(namespace: string, endpointKey: string, session: string): string {
  return createHash("sha256").update(Buffer.from(`${namespace}\0${endpointKey}\0${session}`, "utf8")).digest("hex").slice(0, 24);
}

export function closeFd(fd: number | null | undefined): void {
  if (fd === null || fd === undefined) return;
  try {
    fs.closeSync(fd);
  } catch {}
}

function checkDir(fd: number, label: string): void {
  const info = fs.fstatSync(fd);
  if (!info.isDirectory()) throw new PathError(`${label} isn't a folder`);
  if (info.uid !== uid()) throw new PathError(`${label} belongs to another user`);
  if ((info.mode & 0o077) !== 0) throw new PathError(`${label} must be private (mode 0700)`);
}

function openDir(path: string, open: () => number): number {
  try {
    return open();
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === ELOOP || errno === ENOTDIR) throw new PathError(`${path} is a symbolic link or not a folder`);
    throw error;
  }
}

function mkdirQuietly(dir: number, name: string): void {
  try {
    mkdirAt(dir, name, 0o700);
  } catch (error) {
    if (codeOf(error) !== "EEXIST") throw error;
  }
}

export function openPrivate(root: string, parts: readonly string[], create = true): number {
  let fd: number;
  try {
    fd = openDir(root, () => fs.openSync(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW));
  } catch (error) {
    if (codeOf(error) === "ENOENT") throw new PathError(`${root} doesn't exist`);
    throw error;
  }
  try {
    if (fs.fstatSync(fd).uid !== uid()) throw new PathError(`${root} belongs to another user`);
    for (const part of parts) {
      if (create) mkdirQuietly(fd, part);
      const parent = fd;
      const child = openDir(part, () => openAt(parent, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW, 0));
      closeFd(fd);
      fd = child;
      checkDir(fd, part);
    }
    return fd;
  } catch (error) {
    closeFd(fd);
    throw error;
  }
}

export function openPrivateDirAt(dir: number, name: string, create = true): number {
  if (create) mkdirQuietly(dir, name);
  const fd = openDir(name, () => openAt(dir, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW, 0));
  try {
    checkDir(fd, name);
  } catch (error) {
    closeFd(fd);
    throw error;
  }
  return fd;
}

export function browseDir(root: string, create = true): number {
  return openPrivate(root, [DIR_NAME], create);
}

function openRetrying(name: string, dir: number, flags: number, mode: number): number {
  let retries = flags & O_CREAT ? CREATE_RETRIES : 0;
  for (;;) {
    try {
      const fd = openFileAt(dir, name, flags, mode);
      if (fd === null) throw new PathError(`${name} isn't a regular file of yours`);
      return fd;
    } catch (error) {
      if (codeOf(error) !== "ENOENT" || retries === 0) throw error;
      retries -= 1;
    }
  }
}

export function openPrivateFile(name: string, dir: number, flags = O_RDWR | O_CREAT, mode = 0o600): number {
  const fd = openRetrying(name, dir, flags, mode);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== uid()) throw new PathError(`${name} isn't a regular file of yours`);
    if ((info.mode & 0o077) !== 0) fs.fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    closeFd(fd);
    throw error;
  }
}

export function takeLock(name: string, dir: number, blocking = false): number | null {
  const fd = openPrivateFile(name, dir);
  try {
    if (flock(fd, true, blocking)) return fd;
  } catch (error) {
    closeFd(fd);
    throw error;
  }
  closeFd(fd);
  return null;
}

export function lockHeld(name: string, dir: number): boolean {
  let fd: number;
  try {
    fd = openPrivateFile(name, dir, O_RDONLY);
  } catch (error) {
    if (codeOf(error) === "ENOENT" || error instanceof PathError) return false;
    throw error;
  }
  try {
    return !flock(fd, false, false);
  } finally {
    closeFd(fd);
  }
}

export type SocketId = { dev: number; ino: number };

export function socketIsOurs(name: string, dir: number): SocketId | null {
  let info;
  try {
    info = statAt(dir, name);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
  if ((info.mode & S_IFMT) !== S_IFSOCK) throw new PathError(`${name} isn't a socket`);
  if (info.uid !== uid()) throw new PathError(`${name} belongs to another user`);
  if ((info.mode & 0o077) !== 0) throw new PathError(`${name} must be mode 0600`);
  return { dev: info.dev, ino: info.ino };
}

export function sameSocket(a: SocketId | null, b: SocketId | null): boolean {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
}

export function writeAllFd(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) {
    try {
      offset += fs.writeSync(fd, data, offset, data.length - offset);
    } catch (error) {
      if (codeOf(error) !== "EINTR") throw error;
    }
  }
}

export function writePrivateJson(name: string, dir: number, value: Value): void {
  const temp = `.${name}.${process.pid}.tmp`;
  const fd = openPrivateFile(temp, dir, O_WRONLY | O_CREAT | O_TRUNC);
  try {
    writeAllFd(fd, Buffer.from(wellFormed(dumps(value, "spaced")), "utf8"));
  } finally {
    closeFd(fd);
  }
  renameAt(dir, temp, name);
}

export function readFdUpTo(fd: number, limit: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= limit) {
    const chunk = Buffer.allocUnsafe(Math.min(limit + 1 - total, 65536));
    let got: number;
    try {
      got = fs.readSync(fd, chunk, 0, chunk.length, null);
    } catch (error) {
      if (codeOf(error) === "EINTR") continue;
      throw error;
    }
    if (got === 0) break;
    chunks.push(chunk.subarray(0, got));
    total += got;
  }
  return Buffer.concat(chunks);
}

export function readPrivateJson(name: string, dir: number, limit = MAX_META): Value | undefined {
  let fd: number;
  try {
    fd = openPrivateFile(name, dir, O_RDONLY);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return undefined;
    throw error;
  }
  let raw: Buffer;
  try {
    raw = readFdUpTo(fd, limit);
  } finally {
    closeFd(fd);
  }
  if (raw.length > limit) throw new PathError(`${name} is too large`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    return undefined;
  }
  try {
    return parseText(text);
  } catch {
    return undefined;
  }
}

export function unlinkQuietly(name: string, dir: number): void {
  try {
    unlinkAt(dir, name);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
  }
}

export function listNames(dir: number): string[] {
  return listAt(dir).map((name) => name.toString("utf8"));
}

export function entryInfo(dir: number, name: string) {
  return statAt(dir, name);
}
