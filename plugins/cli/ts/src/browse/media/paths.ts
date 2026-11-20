import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "../commands/ctx.ts";
import { tempRoot } from "../daemon/render.ts";

function makeFolder(folder: string): void {
  const parent = path.dirname(folder);
  if (parent !== folder) fs.mkdirSync(parent, { recursive: true });
  try {
    fs.mkdirSync(folder, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !fs.statSync(folder).isDirectory()) throw error;
  }
}

export function defaultPath(ctx: Ctx, extension: string): string {
  const given = (ctx.env["AGENT_BROWSER_SCREENSHOT_DIR"] as string | undefined) || (ctx.options["screenshot_dir"] as string | undefined);
  const folder = given ? ctx.path(given) : path.join(tempRoot(), "ardia-browse", "screenshots");
  makeFolder(folder);
  return path.join(folder, `screenshot-${Date.now()}.${extension}`);
}
