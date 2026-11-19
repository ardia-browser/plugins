import fs from "node:fs";
import { codeOf, errnoOf, uid } from "./paths.ts";
import { sleepMs } from "./printable.ts";

const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_NOFOLLOW, O_DIRECTORY, O_NONBLOCK } = fs.constants;
export { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_NOFOLLOW, O_NONBLOCK };
const O_EXLOCK = 0x20;
const ELOOP = 62;
const ENOTDIR = 20;

export class PathError extends Error {
  constructor() {
    super("an unsafe path");
  }
}

export type Dir = { path: string; fd: number; dev: number; ino: number };

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

function within<T>(dir: Dir, work: () => T): T {
  const saved = (() => {
    try {
      return process.cwd();
    } catch {
      return undefined;
    }
  })();
  process.chdir(dir.path);
  try {
    const here = fs.statSync(".");
    if (here.dev !== dir.dev || here.ino !== dir.ino) throw new PathError();
    return work();
  } finally {
    if (saved !== undefined) {
      try {
        process.chdir(saved);
      } catch {}
    }
  }
}

function asDir(path: string, fd: number): Dir {
  const info = fs.fstatSync(fd);
  return { path, fd, dev: info.dev, ino: info.ino };
}

function openDirAt(path: string, open: () => number): Dir {
  let fd: number;
  try {
    fd = open();
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === ELOOP || errno === ENOTDIR) throw new PathError();
    throw error;
  }
  return asDir(path, fd);
}

function mkdirQuietly(name: string): void {
  try {
    fs.mkdirSync(name, { mode: 0o700 });
  } catch (error) {
    if (codeOf(error) !== "EEXIST") throw error;
  }
}

function childPath(dir: Dir, name: string): string {
  return dir.path.endsWith("/") ? dir.path + name : `${dir.path}/${name}`;
}

function openChild(dir: Dir, name: string, create: boolean): Dir {
  return within(dir, () => {
    if (create) mkdirQuietly(name);
    return openDirAt(childPath(dir, name), () => fs.openSync(name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW));
  });
}

export function openPrivate(root: string, parts: string[], create: boolean): Dir {
  let dir: Dir;
  try {
    dir = openDirAt(root, () => fs.openSync(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW));
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

export function openPrivateFile(name: string, dir: Dir, flags: number): number {
  return within(dir, () => {
    let retries = flags & O_CREAT ? 4 : 0;
    let fd: number;
    for (;;) {
      try {
        fd = fs.openSync(name, flags | O_NOFOLLOW, 0o600);
        break;
      } catch (error) {
        if (notFound(error) && retries > 0) retries -= 1;
        else throw error;
      }
    }
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== uid()) {
      close(fd);
      throw new PathError();
    }
    if ((info.mode & 0o077) !== 0) {
      try {
        fs.fchmodSync(fd, 0o600);
      } catch {}
    }
    return fd;
  });
}

export function takeLock(name: string, dir: Dir): number | undefined {
  try {
    return openPrivateFile(name, dir, O_RDWR | O_CREAT | O_EXLOCK | O_NONBLOCK);
  } catch (error) {
    if (codeOf(error) === "EAGAIN") return undefined;
    throw error;
  }
}

export function takeLockRetrying(name: string, dir: Dir): number | undefined {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const lock = takeLock(name, dir);
    if (lock !== undefined) return lock;
    if (attempt < 4) sleepMs(2);
  }
  return undefined;
}

export function unlinkQuietly(name: string, dir: Dir): void {
  try {
    within(dir, () => fs.unlinkSync(name));
  } catch {}
}

export function renameIn(dir: Dir, from: string, to: string): void {
  within(dir, () => fs.renameSync(from, to));
}

export function sizeAt(dir: Dir, name: string): number {
  return within(dir, () => fs.lstatSync(name).size);
}

export function listDir(dir: Dir): string[] {
  return within(dir, () => fs.readdirSync("."));
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

export function writeFd(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) {
    try {
      offset += fs.writeSync(fd, data, offset, data.length - offset);
    } catch (error) {
      if (codeOf(error) !== "EINTR") throw error;
    }
  }
}

export function writePrivate(name: string, dir: Dir, data: Uint8Array): void {
  const temp = `.${name}.${process.pid}.tmp`;
  const fd = openPrivateFile(temp, dir, O_WRONLY | O_CREAT | O_TRUNC);
  try {
    writeFd(fd, data);
  } finally {
    close(fd);
  }
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
