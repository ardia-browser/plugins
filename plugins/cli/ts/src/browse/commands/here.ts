import { Usage } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import { flag } from "../metrics.ts";
import { Ctx } from "./ctx.ts";
import { register } from "./index.ts";
import { parse } from "./parse.ts";
import { cmdRead } from "./read-page.ts";
import { cmdSnapshot } from "./snapshot.ts";
import { cmdTab } from "./tabs.ts";

export const HERE_USAGE = "Usage: ardia browse here [--read] [--all]";

export async function cmdHere(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--read": "bool", "--all": "bool" });
  if (args.length > 0) throw new Usage(`${HERE_USAGE} (here takes your active tab; to pick another, use \`ardia browse tab <t1|tab-…>\`)`);
  const tab = await cmdTab(ctx, ["active"]);
  flag("here", true);
  const reading = Boolean(options["read"]);
  if (reading) flag("here_read", true);
  const sub = new Ctx(ctx.state, ctx.options, ctx.cwd, ctx.env, ctx.stdin, reading ? "read" : "snapshot");
  const body = reading ? await cmdRead(sub, []) : await cmdSnapshot(sub, ["-i", ...(options["all"] ? ["--all"] : [])]);
  const data = { ...(tab.data as Record<string, unknown>), [reading ? "read" : "snapshot"]: body.data };
  const result = new Result(data, [tab.text, body.text].filter((part) => part).join("\n"), true);
  result.notice = body.notice;
  return result;
}

register("here", cmdHere);
