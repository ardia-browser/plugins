import { readlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { decodeSurrogateEscape } from "./argv-bytes.ts";
import { accountHomeOf } from "./libc.ts";

export const LINUX = process.platform === "linux";
const LOSSY = "\ufffd";

export class NeedsPython extends Error {
  constructor(reason: string) {
    super(reason);
  }
}

export function env(name: string): string | undefined {
  return process.env[name];
}

export function envSet(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

export function uid(): number {
  return process.getuid?.() ?? -1;
}

export { strerror } from "./libc.ts";

export function errnoOf(error: unknown): number {
  const errno = (error as NodeJS.ErrnoException | undefined)?.errno;
  return typeof errno === "number" ? Math.abs(errno) : 0;
}

export function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function accountHome(): string | undefined {
  try {
    return userInfo().homedir;
  } catch {
    return undefined;
  }
}

const PATH_VARIABLES = ["ARDIA_DATA_DIR", "HOME", "ARDIA_CLI_HOME", "ARDIA_CONFIG_HOME", "XDG_CONFIG_HOME"];

export function pathsAreText(): boolean {
  if (PATH_VARIABLES.some((name) => env(name)?.includes(LOSSY))) return false;
  let cwd: string | undefined;
  try {
    cwd = process.cwd();
  } catch {
    cwd = undefined;
  }
  if (cwd?.includes(LOSSY)) return false;
  return env("HOME") !== undefined || !(accountHome()?.includes(LOSSY) ?? false);
}

export function home(): string {
  return env("HOME") ?? accountHome() ?? "";
}

export function expandUser(text: string): string {
  if (!text.startsWith("~")) return text;
  const slash = text.indexOf("/");
  const user = slash < 0 ? text.slice(1) : text.slice(1, slash);
  const rest = slash < 0 ? "" : text.slice(slash);
  const found = user === "" ? undefined : accountHomeOf(user);
  if (found === null) return text;
  const base = found === undefined ? (env("HOME") ?? accountHome()) : decodeSurrogateEscape(found);
  if (base === undefined) return text;
  const trimmed = base.length > 1 ? base.replace(/\/+$/, "") : base;
  const joined = trimmed + rest;
  return joined === "" ? "/" : joined;
}

export function join(...parts: string[]): string {
  let path = "";
  for (const part of parts) {
    if (part.startsWith("/") || path === "") path = part;
    else path = path.endsWith("/") ? path + part : `${path}/${part}`;
  }
  return path;
}

export function baseName(path: string): string {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  const last = parts[parts.length - 1];
  return last === undefined || last === ".." ? "" : last;
}

function rootOf(text: string): string {
  if (text.startsWith("//") && !text.startsWith("///")) return "//";
  return text.startsWith("/") ? "/" : "";
}

export function purePath(text: string): string {
  if (text === "") return ".";
  const joined = rootOf(text) + text.split("/").filter((part) => part !== "" && part !== ".").join("/");
  return joined === "" ? "." : joined;
}

export function normpath(text: string): string {
  const root = rootOf(text);
  const parts: string[] = [];
  for (const part of text.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      const last = parts[parts.length - 1];
      if (last !== undefined && last !== "..") parts.pop();
      else if (root === "") parts.push("..");
      continue;
    }
    parts.push(part);
  }
  const joined = root + parts.join("/");
  return joined === "" ? "." : joined;
}

function currentDir(): string {
  try {
    return process.cwd();
  } catch {
    return "";
  }
}

export function abspath(text: string): string {
  return normpath(text.startsWith("/") ? text : `${currentDir()}/${text}`);
}

export function realpath(text: string): string {
  const absolute = text.startsWith("/") ? text : `${currentDir()}/${text}`;
  const pending = absolute.split("/").filter((part) => part !== "").reverse();
  let resolved: string[] = [];
  let hops = 0;
  for (let part = pending.pop(); part !== undefined; part = pending.pop()) {
    if (part === ".") continue;
    if (part === "..") {
      resolved.pop();
      continue;
    }
    const next = [...resolved, part];
    let target: string | undefined;
    try {
      target = readlinkSync(`/${next.join("/")}`);
    } catch {
      target = undefined;
    }
    if (target !== undefined && hops < 40) {
      hops += 1;
      if (target.startsWith("/")) resolved = [];
      pending.push(...target.split("/").filter((piece) => piece !== "").reverse());
    } else resolved = next;
  }
  return `/${resolved.join("/")}`;
}
