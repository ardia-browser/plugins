import fs from "node:fs";
import path from "node:path";
import { DEFAULT_TIMEOUT_MS } from "../limits.ts";
import type { Options, Result } from "../daemon/render.ts";
import type { State } from "../state/state.ts";

function expandUser(value: string): string {
  if (!value.startsWith("~")) return value;
  const cut = value.indexOf("/");
  const user = cut < 0 ? value.slice(1) : value.slice(1, cut);
  if (user !== "") return value;
  const home = process.env["HOME"];
  return home === undefined ? value : home.replace(/\/+$/u, "") + (cut < 0 ? "" : value.slice(cut)) || "/";
}

function joinPath(head: string, tail: string): string {
  if (tail.startsWith("/")) return tail;
  if (head === "" || head.endsWith("/")) return head + tail;
  return `${head}/${tail}`;
}

function splitPath(target: string): [string, string] {
  const cut = target.lastIndexOf("/") + 1;
  let head = target.slice(0, cut);
  if (head !== "" && !/^\/+$/u.test(head)) head = head.replace(/\/+$/u, "");
  return [head, target.slice(cut)];
}

function lstatLink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function joinRealpath(start: string, given: string, seen: Map<string, string | null>): [string, boolean] {
  let current = start;
  let rest = given;
  if (rest.startsWith("/")) {
    rest = rest.slice(1);
    current = "/";
  }
  while (rest) {
    const cut = rest.indexOf("/");
    const name = cut < 0 ? rest : rest.slice(0, cut);
    rest = cut < 0 ? "" : rest.slice(cut + 1);
    if (name === "" || name === ".") continue;
    if (name === "..") {
      if (current) {
        const [head, tail] = splitPath(current);
        current = tail === ".." ? joinPath(joinPath(head, ".."), "..") : head;
      } else current = "..";
      continue;
    }
    const next = joinPath(current, name);
    if (!lstatLink(next)) {
      current = next;
      continue;
    }
    if (seen.has(next)) {
      const known = seen.get(next);
      if (known !== null && known !== undefined) {
        current = known;
        continue;
      }
      return [joinPath(next, rest), false];
    }
    seen.set(next, null);
    const [resolved, ok] = joinRealpath(current, fs.readlinkSync(next), seen);
    current = resolved;
    if (!ok) return [joinPath(current, rest), false];
    seen.set(next, current);
  }
  return [current, true];
}

function normpath(target: string): string {
  const leading = target.startsWith("//") && !target.startsWith("///") ? "//" : target.startsWith("/") ? "/" : "";
  const parts: string[] = [];
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== ".." || (!leading && parts.length === 0) || parts.at(-1) === "..") parts.push(part);
    else if (parts.length > 0) parts.pop();
  }
  return leading + parts.join("/") || leading || ".";
}

export function pyResolve(target: string): string {
  return normpath(joinRealpath("", target, new Map())[0]);
}

export class Ctx {
  constructor(
    readonly state: State,
    readonly options: Options,
    readonly cwd: string,
    readonly env: Record<string, unknown>,
    readonly stdin: string | null,
    readonly command = "",
  ) {}

  get humanize(): boolean {
    return Boolean(this.options["humanize"]);
  }

  get timeout(): number {
    return Number(this.options["timeout_ms"] || DEFAULT_TIMEOUT_MS) / 1000;
  }

  path(value: string): string {
    return pyResolve(joinPath(this.cwd, expandUser(value)));
  }
}

export type Handler = (ctx: Ctx, argv: string[]) => Promise<Result>;
