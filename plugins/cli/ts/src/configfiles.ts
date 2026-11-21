import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { installedDataDir } from "./control.ts";
import { envSet, expandUser, home, join, LINUX, purePath } from "./paths.ts";
import { utf8 } from "./pystr.ts";

export const MAX_FILE = 1024 * 1024;

export class ConfigError extends Error {}

export function explicitDataRoot(dataDir: string | undefined): string | undefined {
  const root = dataDir !== undefined && dataDir !== "" ? dataDir : envSet("ARDIA_DATA_DIR");
  return root === undefined ? undefined : purePath(expandUser(root));
}

export function configFolder(dataDir: string | undefined): string {
  const explicit = explicitDataRoot(dataDir);
  if (explicit !== undefined) return join(explicit, "config");
  return LINUX ? join(installedDataDir(), "config") : join(home(), ".config", "ardia");
}

function baseOf(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function dirOf(path: string): string {
  const at = path.lastIndexOf("/");
  if (at < 0) return ".";
  return at === 0 ? "/" : path.slice(0, at);
}

export function readText(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    if (!fstatSync(fd).isFile()) throw new ConfigError(`${baseOf(path)} isn't a regular file`);
    while (size <= MAX_FILE) {
      const chunk = Buffer.alloc(MAX_FILE + 1 - size);
      let count: number;
      try {
        count = readSync(fd, chunk, 0, chunk.length, null);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN") continue;
        throw error;
      }
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      size += count;
    }
  } finally {
    closeSync(fd);
  }
  const raw = Buffer.concat(chunks);
  if (raw.length > MAX_FILE) throw new ConfigError(`${baseOf(path)} is larger than 1 MB`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new ConfigError(`${baseOf(path)} isn't UTF-8 text`);
  }
}

function defaultMode(): number {
  const mask = process.umask();
  return 0o666 & ~mask;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function tempName(target: string): string {
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789_";
  const bytes = randomBytes(8);
  const suffix = [...bytes].map((byte) => letters[byte % letters.length]).join("");
  return join(dirOf(target), `.${baseOf(target)}.${suffix}.tmp`);
}

export function writeText(path: string, text: string): void {
  let target = path;
  try {
    if (lstatSync(path).isSymbolicLink()) target = realpathSync(path);
  } catch {}
  if (exists(target)) {
    let regular = false;
    try {
      regular = statSync(target).isFile();
    } catch {}
    if (!regular) throw new ConfigError(`${path} isn't a regular file`);
  }
  let mode: number;
  try {
    mode = statSync(target).mode & 0o7777;
  } catch {
    mode = defaultMode();
  }
  let temp = tempName(target);
  let fd: number | undefined;
  for (let attempt = 0; fd === undefined; attempt += 1) {
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 100) throw error;
      temp = tempName(target);
    }
  }
  try {
    try {
      const data = utf8(text);
      let at = 0;
      while (at < data.length) at += writeSync(fd, data, at, data.length - at);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temp, mode);
    renameSync(temp, target);
  } finally {
    try {
      unlinkSync(temp);
    } catch {}
  }
}
