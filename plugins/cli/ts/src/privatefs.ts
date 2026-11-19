import fs from "node:fs";
import { constants } from "node:os";
import { flock, listAt, mkdirAt, type Name, openAt, openFileAt, renameAt, sizeAt as statSizeAt, unlinkAt } from "./libc.ts";
import { codeOf, errnoOf, uid } from "./paths.ts";
import { sleepMs } from "./printable.ts";

const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_NOFOLLOW, O_DIRECTORY, O_NONBLOCK } = fs.constants;
export { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_NOFOLLOW, O_NONBLOCK };
const { ELOOP, ENOTDIR } = constants.errno;
const CREATE_RETRIES = 4;
const NEWLINE_BYTE = 0x0a;
const LOCK_ATTEMPTS = 5;
const LOCK_RETRY_MS = 2;

export class PathError extends Error {
  constructor() {
    super("an unsafe path");
  }
}

export type Dir = { fd: number };

export function notFound(error: unknown): boolean {
  return codeOf(error) === "ENOENT";
}

export function close(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    fs.closeSync(fd);
  } catch {}
}

export function closeDir(dir: Dir | undefined): void {
  close(dir?.fd);
}

function openDir(open: () => number): Dir {
  try {
    return { fd: open() };
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === ELOOP || errno === ENOTDIR) throw new PathError();
    throw error;
  }
}

function mkdirQuietly(dir: Dir, name: string): void {
  try {
    mkdirAt(dir.fd, name, 0o700);
  } catch (error) {
    if (codeOf(error) !== "EEXIST") throw error;
  }
}

function openChild(dir: Dir, name: string, create: boolean): Dir {
  if (create) mkdirQuietly(dir, name);
  return openDir(() => openAt(dir.fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW, 0));
}

export function openPrivate(root: string, parts: string[], create: boolean): Dir {
  let dir: Dir;
  try {
    dir = openDir(() => fs.openSync(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW));
  } catch (error) {
    if (notFound(error)) throw new PathError();
    throw error;
  }
  try {
    if (fs.fstatSync(dir.fd).uid !== uid()) throw new PathError();
    for (const part of parts) {
      const child = openChild(dir, part, create);
      closeDir(dir);
      dir = child;
      const info = fs.fstatSync(dir.fd);
      if (!info.isDirectory() || info.uid !== uid() || (info.mode & 0o077) !== 0) throw new PathError();
    }
    return dir;
  } catch (error) {
    closeDir(dir);
    throw error;
  }
}

export function openChildDir(dir: Dir, name: string, checkMode: boolean): Dir {
  const child = openChild(dir, name, true);
  const info = fs.fstatSync(child.fd);
  if (!info.isDirectory() || info.uid !== uid() || (checkMode && (info.mode & 0o022) !== 0)) {
    closeDir(child);
    throw new PathError();
  }
  return child;
}

function openRetrying(dir: Dir, name: string, flags: number): number {
  let retries = flags & O_CREAT ? CREATE_RETRIES : 0;
  for (;;) {
    try {
      const fd = openFileAt(dir.fd, name, flags, 0o600);
      if (fd === null) throw new PathError();
      return fd;
    } catch (error) {
      if (!notFound(error) || retries === 0) throw error;
      retries -= 1;
    }
  }
}

export function openPrivateFile(name: string, dir: Dir, flags: number): number {
  const fd = openRetrying(dir, name, flags);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== uid()) throw new PathError();
    if ((info.mode & 0o077) !== 0) fs.fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    close(fd);
    throw error;
  }
}

export function takeLock(name: string, dir: Dir): number | undefined {
  const fd = openPrivateFile(name, dir, O_RDWR | O_CREAT);
  try {
    if (flock(fd, true, false)) return fd;
  } catch (error) {
    close(fd);
    throw error;
  }
  close(fd);
  return undefined;
}

export function takeLockRetrying(name: string, dir: Dir): number | undefined {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    const lock = takeLock(name, dir);
    if (lock !== undefined) return lock;
    if (attempt + 1 < LOCK_ATTEMPTS) sleepMs(LOCK_RETRY_MS);
  }
  return undefined;
}

export function unlinkQuietly(name: Name, dir: Dir): void {
  try {
    unlinkAt(dir.fd, name);
  } catch (error) {
    if (!notFound(error)) throw error;
  }
}

export function renameIn(dir: Dir, from: string, to: string): void {
  renameAt(dir.fd, from, to);
}

export function sizeAt(dir: Dir, name: Name): number {
  return statSizeAt(dir.fd, name);
}

export function listDir(dir: Dir): Buffer[] {
  return listAt(dir.fd);
}

export function readFd(fd: number, limit: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < limit) {
    const chunk = Buffer.allocUnsafe(Math.min(limit - total, 65536));
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

export function writeOnce(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) {
    try {
      const written = fs.writeSync(fd, data, offset, data.length - offset);
      if (written <= 0) throw Object.assign(new Error("EIO: write made no progress"), { code: "EIO" });
      offset += written;
    } catch (error) {
      if (codeOf(error) !== "EINTR") throw error;
    }
  }
}

export function appendWhole(fd: number, data: Uint8Array): void {
  const before = fs.fstatSync(fd).size;
  const last = Buffer.from([NEWLINE_BYTE]);
  if (before > 0) {
    try {
      if (fs.readSync(fd, last, 0, 1, before - 1) !== 1) last[0] = NEWLINE_BYTE;
    } catch {
      last[0] = NEWLINE_BYTE;
    }
  }
  const whole = last[0] === NEWLINE_BYTE ? data : Buffer.concat([Buffer.from([NEWLINE_BYTE]), data]);
  let offset = 0;
  while (offset < whole.length) {
    try {
      const written = fs.writeSync(fd, whole, offset, whole.length - offset);
      if (written <= 0) throw Object.assign(new Error("EIO: write made no progress"), { code: "EIO" });
      offset += written;
    } catch (error) {
      if (codeOf(error) === "EINTR") continue;
      try {
        fs.ftruncateSync(fd, before);
      } catch {}
      throw error;
    }
  }
}

export function writePrivate(name: string, dir: Dir, data: Uint8Array): void {
  const temp = `.${name}.${process.pid}.tmp`;
  const fd = openPrivateFile(temp, dir, O_WRONLY | O_CREAT | O_TRUNC);
  try {
    writeOnce(fd, data);
  } catch (error) {
    close(fd);
    unlinkQuietly(temp, dir);
    throw error;
  }
  close(fd);
  renameIn(dir, temp, name);
}

export function readPrivate(name: string, dir: Dir, limit: number): Buffer | undefined {
  let fd: number;
  try {
    fd = openPrivateFile(name, dir, O_RDONLY);
  } catch (error) {
    if (notFound(error)) return undefined;
    throw error;
  }
  try {
    const raw = readFd(fd, limit + 1);
    if (raw.length > limit) throw new PathError();
    return raw;
  } finally {
    close(fd);
  }
}
