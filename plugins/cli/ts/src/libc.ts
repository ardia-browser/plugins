import { realpathSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join } from "node:path";

export const LIBC_FILE = "ardia-libc.so";
export const LIBC_UNAVAILABLE = 252;

export type Name = string | Buffer;

type Native = {
  peerUid(fd: number): number;
  interruptsIgnored(): boolean | number;
  openAt(dir: number, name: string, flags: number, mode: number): number;
  openFileAt(dir: number, name: string, flags: number, mode: number): number | null;
  mkdirAt(dir: number, name: string, mode: number): number;
  renameAt(dir: number, from: string, to: string): number;
  unlinkAt(dir: number, name: Name): number;
  sizeAt(dir: number, name: Name): number;
  statAt(dir: number, name: string): [number, number, bigint, bigint, number] | number;
  armWatchdog(dir: number, name: string, dev: bigint, ino: bigint, ms: number, code: number, fireDelay?: number): number;
  disarmWatchdog(): number;
  renameExclusiveAt(fromDir: number, from: string, toDir: number, to: string): number;
  removeDirAt(dir: number, name: string): number;
  nonBlocking(fd: number): number;
  listAt(dir: number): Buffer[] | number;
  lock(fd: number, exclusive: boolean, wait: boolean): number;
  watchLifeline(fd: number): number;
  writeSome(fd: number, bytes: Uint8Array, offset: number): number;
  strerror(errno: number): string | number;
};

const EXPORTS: readonly (keyof Native)[] = ["peerUid", "interruptsIgnored", "openAt", "openFileAt", "mkdirAt", "renameAt", "unlinkAt", "sizeAt", "statAt", "armWatchdog", "disarmWatchdog", "renameExclusiveAt", "removeDirAt", "nonBlocking", "listAt", "lock", "watchLifeline", "writeSome", "strerror"];
const ERRNO_NAMES = new Map<number, string>(Object.entries(constants.errno).map(([name, value]) => [value, name]));
const EWOULDBLOCK = constants.errno.EWOULDBLOCK ?? constants.errno.EAGAIN;

export class LibcUnavailable extends Error {
  constructor(
    readonly file: string,
    readonly reason: string,
  ) {
    super(`ardia: can't load ${file} (${reason}); reinstall ardia`);
  }
}

let loaded: Native | undefined;

export function libcBeside(executable: string = process.execPath): string {
  let real = executable;
  try {
    real = realpathSync(executable);
  } catch {}
  return join(dirname(real), LIBC_FILE);
}

const TRIED = "tried: '";

function bracketed(text: string, open: number): string | undefined {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === "(") depth += 1;
    else if (text[at] === ")" && --depth === 0) return text.slice(open + 1, at);
  }
  return undefined;
}

export function dlopenReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const tried = text.indexOf(TRIED);
  if (tried >= 0) {
    const quote = text.indexOf("' (", tried + TRIED.length);
    const reason = quote < 0 ? undefined : bracketed(text, quote + 2);
    if (reason) return reason;
  }
  const line = text.split("\n").find((part) => part.trim() !== "")?.trim();
  return line || "it didn't load";
}

export function loadLibc(file: string = libcBeside()): void {
  const module = { exports: {} as Record<string, unknown> };
  try {
    process.dlopen(module, file);
  } catch (error) {
    throw new LibcUnavailable(file, dlopenReason(error));
  }
  const missing = EXPORTS.find((name) => typeof module.exports[name] !== "function");
  if (missing !== undefined) throw new LibcUnavailable(file, `it has no ${missing}`);
  loaded = module.exports as unknown as Native;
}

function native(): Native {
  if (loaded === undefined) throw new LibcUnavailable(libcBeside(), "it wasn't loaded");
  return loaded;
}

export function errnoError(errno: number, syscall: string, given?: Name): NodeJS.ErrnoException {
  const name = given === undefined ? undefined : given.toString();
  const code = ERRNO_NAMES.get(errno) ?? `E${errno}`;
  const error: NodeJS.ErrnoException = new Error(`${code}: ${strerror(errno)}, ${syscall}${name === undefined ? "" : ` '${name}'`}`);
  error.errno = -errno;
  error.code = code;
  error.syscall = syscall;
  if (name !== undefined) error.path = name;
  return error;
}

function checked(result: number, syscall: string, name?: Name): number {
  if (result < 0) throw errnoError(-result, syscall, name);
  return result;
}

export function peerUid(socket: number): number {
  return checked(native().peerUid(socket), "getsockopt");
}

export function interruptsIgnored(): boolean {
  const ignored = native().interruptsIgnored();
  if (typeof ignored === "number") throw errnoError(-ignored, "sigaction");
  return ignored;
}

export function openAt(dir: number, name: string, flags: number, mode = 0o600): number {
  return checked(native().openAt(dir, name, flags, mode), "openat", name);
}

export function openFileAt(dir: number, name: string, flags: number, mode = 0o600): number | null {
  const opened = native().openFileAt(dir, name, flags, mode);
  return opened === null ? null : checked(opened, "openat", name);
}

export function mkdirAt(dir: number, name: string, mode: number): void {
  checked(native().mkdirAt(dir, name, mode), "mkdirat", name);
}

export function renameAt(dir: number, from: string, to: string): void {
  checked(native().renameAt(dir, from, to), "renameat", from);
}

export function unlinkAt(dir: number, name: Name): void {
  checked(native().unlinkAt(dir, name), "unlinkat", name);
}

export function sizeAt(dir: number, name: Name): number {
  return checked(native().sizeAt(dir, name), "fstatat", name);
}

export type EntryInfo = { mode: number; uid: number; dev: bigint; ino: bigint; mtime: number };

export function statAt(dir: number, name: string): EntryInfo {
  const info = native().statAt(dir, name);
  if (typeof info === "number") throw errnoError(-info, "fstatat", name);
  const [mode, owner, dev, ino, mtime] = info;
  return { mode, uid: owner, dev, ino, mtime };
}

export function armWatchdog(dir: number, name: string, dev: bigint, ino: bigint, ms: number, code: number): number {
  return native().armWatchdog(dir, name, dev, ino, Math.max(1, Math.min(86_400_000, Math.round(ms))), code);
}

export function disarmWatchdog(): number {
  return native().disarmWatchdog();
}

export function renameExclusiveAt(fromDir: number, from: string, toDir: number, to: string): void {
  checked(native().renameExclusiveAt(fromDir, from, toDir, to), "renameatx_np", to);
}

export function removeDirAt(dir: number, name: string): void {
  checked(native().removeDirAt(dir, name), "unlinkat", name);
}

export function nonBlocking(fd: number): void {
  checked(native().nonBlocking(fd), "fcntl");
}

export function listAt(dir: number): Buffer[] {
  const names = native().listAt(dir);
  if (typeof names === "number") throw errnoError(-names, "openat");
  return names;
}

export function flock(fd: number, exclusive: boolean, wait: boolean): boolean {
  const result = native().lock(fd, exclusive, wait);
  if (result === -EWOULDBLOCK && !wait) return false;
  checked(result, "flock");
  return true;
}

export function watchLifeline(fd: number): void {
  checked(native().watchLifeline(fd), "pthread_create");
}

export function writeSome(fd: number, bytes: Uint8Array, offset = 0): number {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const written = native().writeSome(fd, buffer, offset);
  if (written < 0) throw errnoError(-written, "write");
  if (written === 0 && offset < buffer.length) throw errnoError(constants.errno.EIO, "write");
  return written;
}

export function writtenBefore(error: unknown): number {
  const written = (error as { written?: unknown } | undefined)?.written;
  return typeof written === "number" ? written : 0;
}

export function writeWhole(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    try {
      offset += writeSome(fd, bytes, offset);
    } catch (error) {
      throw Object.assign(error as NodeJS.ErrnoException, { written: offset });
    }
  }
}

export function strerror(errno: number): string {
  const text = native().strerror(errno);
  if (typeof text === "number") throw errnoError(-text, "strerror_r");
  return text;
}
