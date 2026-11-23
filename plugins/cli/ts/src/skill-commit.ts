import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { stopPoint } from "./after-update.ts";
import { swapAt } from "./libc.ts";
import { join } from "./paths.ts";

export class SkillError extends Error {}

const FOLDER_SUFFIXES = (dirs: string[]): string[] => [...new Set(dirs)].flatMap((dir) => [`${dir}/ardia`, `${dir}/cua-driver`]);

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

export function anchorOf(folder: string, dirs: string[]): [string, string[]] {
  for (const suffix of FOLDER_SUFFIXES(dirs)) {
    if (folder.endsWith(`/${suffix}`)) return [folder.slice(0, -suffix.length - 1) || "/", suffix.split("/")];
  }
  throw new SkillError(`${folder} isn't a skills folder ardia installs into`);
}

export function safeParent(folder: string, dirs: string[], create: boolean): string {
  const [anchor, parts] = anchorOf(folder, dirs);
  try {
    if (!statSync(anchor).isDirectory()) throw new SkillError(`${anchor} isn't a folder`);
  } catch (error) {
    if (error instanceof SkillError) throw error;
    if (!create) throw new SkillError(`${anchor} doesn't exist`);
    throw error;
  }
  let at = anchor;
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    const info = lstatOrUndefined(at);
    if (info === undefined) {
      if (!create) throw new SkillError(`${at} doesn't exist`);
      mkdirSync(at);
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new SkillError(`${at} isn't a plain folder; move it away first`);
  }
  return at;
}

export function chainIsSafe(folder: string, dirs: string[]): boolean {
  try {
    safeParent(folder, dirs, false);
    return true;
  } catch {
    return false;
  }
}

function carry(from: string, into: string, skip: Set<string>, relative = ""): void {
  for (const name of readdirSync(from).sort()) {
    stopPoint();
    const inner = relative === "" ? name : `${relative}/${name}`;
    const source = join(from, name);
    const target = join(into, name);
    const info = lstatSync(source);
    if (info.isDirectory()) {
      mkdirSync(target);
      carry(source, target, skip, inner);
      chmodSync(target, info.mode & 0o7777);
    } else if (skip.has(inner)) continue;
    else if (info.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
    else if (info.isFile()) {
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      chmodSync(target, info.mode & 0o7777);
    }
  }
}

function writeInto(stage: string, shown: string, name: string, data: Buffer): void {
  let at = stage;
  let display = shown;
  for (const part of name.split("/").slice(0, -1)) {
    at = join(at, part);
    display = join(display, part);
    const info = lstatOrUndefined(at);
    if (info === undefined) mkdirSync(at);
    else if (info.isSymbolicLink() || !info.isDirectory()) throw new SkillError(`${display} isn't a plain folder; move it away first`);
  }
  const target = join(at, name.split("/").at(-1) as string);
  const existing = lstatOrUndefined(target);
  if (existing !== undefined) {
    if (existing.isDirectory() && !existing.isSymbolicLink()) throw new SkillError(`${join(display, name.split("/").at(-1) as string)} is a folder; move it away first`);
    rmSync(target, { force: true });
  }
  writeFileSync(target, data, { flag: "wx", mode: 0o644 });
  chmodSync(target, 0o644);
}

const SWAP_UNSUPPORTED = new Set(["ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOSYS", "EXDEV"]);

function asideOf(parent: string, name: string): string {
  return join(parent, `.${name}.old`);
}

export function recoverAside(parent: string, name: string): void {
  const aside = asideOf(parent, name);
  const left = lstatOrUndefined(aside);
  if (left === undefined || left.isSymbolicLink() || !left.isDirectory()) return;
  if (lstatOrUndefined(join(parent, name)) === undefined) renameSync(aside, join(parent, name));
  else rmSync(aside, { recursive: true, force: true });
}

function swapped(parent: string, stageName: string, name: string): boolean {
  const dir = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    swapAt(dir, stageName, name);
    return true;
  } catch (error) {
    if (SWAP_UNSUPPORTED.has(String((error as { code?: unknown }).code))) return false;
    throw error;
  } finally {
    closeSync(dir);
  }
}

export function commitPack(folder: string, dirs: string[], previous: string[], files: [string, Buffer][], markerName: string, marker: Buffer): void {
  const parent = safeParent(folder, dirs, true);
  const found = lstatOrUndefined(folder);
  if (found !== undefined && !found.isDirectory() && !found.isSymbolicLink()) throw new SkillError(`${folder} isn't a folder; move it away first`);
  const name = folder.slice(folder.lastIndexOf("/") + 1);
  recoverAside(parent, name);
  const stage = mkdtempSync(join(parent, `.${name}.stage-`));
  try {
    const existing = lstatOrUndefined(folder);
    if (existing !== undefined && existing.isDirectory() && !existing.isSymbolicLink()) {
      carry(folder, stage, new Set([...previous, ...files.map(([file]) => file), markerName]));
    }
    for (const [file, data] of files) {
      stopPoint();
      writeInto(stage, folder, file, data);
    }
    stopPoint();
    writeInto(stage, folder, markerName, marker);
    chmodSync(stage, existing !== undefined && existing.isDirectory() && !existing.isSymbolicLink() ? existing.mode & 0o7777 : 0o777 & ~process.umask());
    stopPoint();
    if (existing === undefined) renameSync(stage, folder);
    else if (!swapped(parent, stage.slice(stage.lastIndexOf("/") + 1), name)) {
      const old = asideOf(parent, name);
      renameSync(folder, old);
      try {
        renameSync(stage, folder);
      } catch (error) {
        renameSync(old, folder);
        throw error;
      }
      rmSync(old, { recursive: true, force: true });
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function replaceFile(folder: string, dirs: string[], name: string, data: Buffer): void {
  safeParent(folder, dirs, false);
  const info = lstatOrUndefined(folder);
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) throw new SkillError(`${folder} isn't a plain folder; move it away first`);
  stopPoint();
  const staging = join(folder, `.ardia-skill-${randomBytes(6).toString("base64url")}`);
  try {
    writeFileSync(staging, data, { flag: "wx", mode: 0o644 });
    chmodSync(staging, 0o644);
    renameSync(staging, join(folder, name));
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
}
