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

export function pyResolve(target: string): string {
  const absolute = path.resolve(target);
  const tail: string[] = [];
  let head = absolute;
  for (;;) {
    try {
      const real = fs.realpathSync(head);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return absolute;
      tail.push(path.basename(head));
      head = parent;
    }
  }
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
    return pyResolve(path.resolve(this.cwd, expandUser(value)));
  }
}

export type Handler = (ctx: Ctx, argv: string[]) => Promise<Result>;
