import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { flock, listAt, mkdirAt, openAt, removeDirAt, renameAt, statAt, type StatAt, swapAt, unlinkAt } from "../libc.ts";
import { errnoOf, strerror, uid } from "../paths.ts";
import { reprText } from "../pylib/str.ts";

export const MAX_FILE = 64 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY, O_RDWR } = fs.constants;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;
const ENOENT = 2;
const EEXIST = 17;
const ELOOP = process.platform === "linux" ? 40 : 62;
const ENOTDIR = 20;

export class StoreError extends Error {
  override readonly name = "StoreError";
}

export class OsError extends Error {
  override readonly name = "OSError";
  constructor(
    readonly errno: number,
    readonly filename?: string,
    readonly filename2?: string,
  ) {
    super(`[Errno ${errno}] ${strerror(errno)}${filename === undefined ? "" : `: ${reprText(filename)}`}${filename2 === undefined ? "" : ` -> ${reprText(filename2)}`}`);
  }

  get strerror(): string {
    return strerror(this.errno);
  }
}

export function os<T>(run: () => T, filename?: string, filename2?: string): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof OsError || error instanceof StoreError) throw error;
    const errno = errnoOf(error);
    if (errno === 0) throw error;
    throw new OsError(errno, filename, filename2);
  }
}

export function isDir(mode: number): boolean {
  return (mode & S_IFMT) === S_IFDIR;
}

export function isLink(mode: number): boolean {
  return (mode & S_IFMT) === S_IFLNK;
}

export function tokenHex(): string {
  return randomBytes(6).toString("hex");
}

export function closeFd(fd: number | null | undefined): void {
  if (fd === null || fd === undefined) return;
  try {
    fs.closeSync(fd);
  } catch {}
}

export function lstatAt(dir: number, name: string): StatAt {
  return os(() => statAt(dir, name, false), name);
}

export function openDir(parent: number, name: string, create: boolean): number {
  if (create) {
    try {
      mkdirAt(parent, name, 0o700);
    } catch (error) {
      if (errnoOf(error) !== EEXIST) throw new OsError(errnoOf(error), name);
    }
  }
  let fd: number;
  try {
    fd = openAt(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === ELOOP || errno === ENOTDIR) throw new StoreError(`${name} is a symbolic link or not a folder; the ardia command only uses real folders`);
    throw new OsError(errno, name);
  }
  const info = os(() => fs.fstatSync(fd));
  if (info.uid !== uid()) {
    closeFd(fd);
    throw new StoreError(`${name} belongs to another user`);
  }
  return fd;
}

export function readFile(dir: number, name: string): Buffer | null {
  let fd: number;
  try {
    fd = openAt(dir, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === ENOENT) return null;
    if (errno === ELOOP) throw new StoreError(`${name} is a symbolic link`);
    throw new OsError(errno, name);
  }
  try {
    if ((os(() => fs.fstatSync(fd)).mode & S_IFMT) !== S_IFREG) throw new StoreError(`${name} isn't a regular file`);
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(CHUNK);
      const count = os(() => fs.readSync(fd, chunk, 0, CHUNK, null));
      if (count === 0) break;
      size += count;
      if (size > MAX_FILE) throw new StoreError(`${name} is too big`);
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks);
  } finally {
    closeFd(fd);
  }
}

export function writeFile(dir: number, name: string, data: Uint8Array, mode = 0o644): void {
  const fd = os(() => openAt(dir, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode), name);
  try {
    let offset = 0;
    while (offset < data.byteLength) offset += os(() => fs.writeSync(fd, data, offset, data.byteLength - offset));
    os(() => fs.fsyncSync(fd));
  } finally {
    closeFd(fd);
  }
}

export function renameIn(dir: number, from: string, to: string): void {
  os(() => renameAt(dir, from, to), from, to);
}

export function writeAtomic(dir: number, name: string, data: Uint8Array): void {
  const temp = `.${name}-${tokenHex()}`;
  try {
    writeFile(dir, temp, data);
    renameIn(dir, temp, name);
  } catch (error) {
    try {
      unlinkAt(dir, temp);
    } catch {}
    throw error;
  }
}

export function exists(dir: number, name: string): boolean {
  try {
    statAt(dir, name, false);
    return true;
  } catch (error) {
    if (errnoOf(error) === ENOENT) return false;
    throw new OsError(errnoOf(error), name);
  }
}

function clearTree(parent: number, name: string): void {
  let fd: number;
  try {
    fd = openAt(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch {
    return;
  }
  try {
    let names: Buffer[] = [];
    try {
      names = listAt(fd);
    } catch {}
    for (const child of names) {
      let info: StatAt | undefined;
      try {
        info = statAt(fd, child, false);
      } catch {}
      if (info !== undefined && isDir(info.mode)) {
        clearTree(fd, child.toString("utf8"));
        try {
          removeDirAt(fd, child);
        } catch {}
      } else {
        try {
          unlinkAt(fd, child);
        } catch {}
      }
    }
  } finally {
    closeFd(fd);
  }
}

export function removeTree(dir: number, name: string): void {
  let info: StatAt;
  try {
    info = statAt(dir, name, false);
  } catch (error) {
    if (errnoOf(error) === ENOENT) return;
    throw new OsError(errnoOf(error), name);
  }
  if (isDir(info.mode)) {
    clearTree(dir, name);
    try {
      removeDirAt(dir, name);
    } catch {}
    return;
  }
  try {
    unlinkAt(dir, name);
  } catch {}
}

export function swap(dir: number, first: string, second: string): void {
  try {
    swapAt(dir, first, second);
  } catch (error) {
    throw new OsError(errnoOf(error), second);
  }
}

export function stagingDir(parent: number, prefix: string): [string, number] {
  const name = `.${prefix}-${tokenHex()}`;
  os(() => mkdirAt(parent, name, 0o755), name);
  return [name, openDir(parent, name, false)];
}

export function makeDir(parent: number, name: string, mode: number): void {
  os(() => mkdirAt(parent, name, mode), name);
}

export function listNames(dir: number): string[] {
  return os(() => listAt(dir)).map((name) => name.toString("utf8"));
}

export function openLock(dir: number): number {
  return os(() => openAt(dir, ".lock", O_RDWR | O_CREAT | O_NOFOLLOW, 0o600), ".lock");
}

export function tryLock(fd: number): boolean {
  return os(() => flock(fd, true, false));
}
