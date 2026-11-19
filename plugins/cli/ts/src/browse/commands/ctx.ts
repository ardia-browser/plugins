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

export function pyResolve(filename: string): string {
  const rest: (string | null)[] = filename.split("/").reverse();
  let partCount = rest.length;
  let current = filename.startsWith("/") ? "/" : process.cwd();
  const seen = new Map<string, string | null>();
  while (partCount) {
    const name = rest.pop();
    if (name === null) {
      seen.set(rest.pop() as string, current);
      continue;
    }
    partCount -= 1;
    if (!name || name === ".") continue;
    if (name === "..") {
      current = current.slice(0, current.lastIndexOf("/")) || "/";
      continue;
    }
    const next = current === "/" ? `/${name}` : `${current}/${name}`;
    let target: string;
    try {
      if (!fs.lstatSync(next).isSymbolicLink()) {
        current = next;
        continue;
      }
      if (seen.has(next)) {
        const known = seen.get(next);
        current = known ?? next;
        continue;
      }
      target = fs.readlinkSync(next);
    } catch {
      current = next;
      continue;
    }
    if (target.startsWith("/")) current = "/";
    seen.set(next, null);
    rest.push(next, null);
    const parts = target.split("/").reverse();
    rest.push(...parts);
    partCount += parts.length;
  }
  return current;
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
