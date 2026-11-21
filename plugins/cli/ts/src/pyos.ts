import fs from "node:fs";
import { constants } from "node:os";
import { errnoOf, strerror } from "./paths.ts";
import { reprText } from "./pyvalue.ts";

const ERRNO = constants.errno as Record<string, number>;
export const ENOENT = ERRNO["ENOENT"] as number;
export const EEXIST = ERRNO["EEXIST"] as number;
export const ENOTDIR = ERRNO["ENOTDIR"] as number;
export const EPIPE = ERRNO["EPIPE"] as number;

export const effects = { done: false };

export class PyOSError extends Error {
  constructor(
    readonly errno: number | undefined,
    readonly strerror: string | undefined,
    readonly filename?: string,
    readonly filename2?: string,
    readonly bare?: string,
  ) {
    super(strerror ?? bare ?? "");
  }

  get notFound(): boolean {
    return this.errno === ENOENT;
  }

  get exists(): boolean {
    return this.errno === EEXIST;
  }

  text(): string {
    if (this.errno === undefined) return this.bare ?? "";
    let out = `[Errno ${this.errno}] ${this.strerror}`;
    if (this.filename !== undefined) out += `: ${reprText(this.filename)}`;
    if (this.filename2 !== undefined) out += ` -> ${reprText(this.filename2)}`;
    return out;
  }
}

export function fromErrno(errno: number, filename?: string, filename2?: string): PyOSError {
  let text: string;
  try {
    text = strerror(errno);
  } catch {
    text = `errno ${errno}`;
  }
  return new PyOSError(errno, text, filename, filename2);
}

export function osError(error: unknown, filename?: string, filename2?: string): unknown {
  if (error instanceof PyOSError) return error;
  const errno = errnoOf(error);
  if (errno === 0 || typeof (error as { code?: unknown }).code !== "string") return error;
  return fromErrno(errno, filename, filename2);
}

export function os<T>(run: () => T, filename?: string, filename2?: string): T {
  try {
    return run();
  } catch (error) {
    throw osError(error, filename, filename2);
  }
}

export function lexists(path: string): boolean {
  try {
    fs.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function statOrNull(path: string, follow: boolean): fs.Stats | null {
  try {
    return follow ? fs.statSync(path) : fs.lstatSync(path);
  } catch {
    return null;
  }
}

export function exists(path: string): boolean {
  return statOrNull(path, true) !== null;
}

export function isFile(path: string): boolean {
  return statOrNull(path, true)?.isFile() ?? false;
}

export function isDir(path: string): boolean {
  return statOrNull(path, true)?.isDirectory() ?? false;
}

export function isSymlink(path: string): boolean {
  return statOrNull(path, false)?.isSymbolicLink() ?? false;
}

export function parentOf(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/u, "") : path;
  const slash = trimmed.lastIndexOf("/");
  if (slash < 0) return ".";
  if (slash === 0) return "/";
  return trimmed.slice(0, slash);
}

export function nameOf(path: string): string {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  return parts.at(-1) ?? "";
}

export function mkdirs(path: string, parents: boolean, existOk: boolean): void {
  try {
    fs.mkdirSync(path, { mode: 0o777 });
    effects.done = true;
  } catch (error) {
    const wrapped = osError(error, path);
    if (parents && wrapped instanceof PyOSError && wrapped.notFound && parentOf(path) !== path) {
      mkdirs(parentOf(path), true, true);
      mkdirs(path, false, existOk);
      return;
    }
    if (!existOk || !isDir(path)) throw wrapped;
  }
}

export function umaskDefault(): number {
  const mask = process.umask(0);
  process.umask(mask);
  return 0o666 & ~mask;
}
