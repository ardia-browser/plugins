import fs from "node:fs";
import { pyStr } from "../../pylib/plain.ts";
import { pyStrip } from "../../pylib/str.ts";
import { navigate } from "../commands/core.ts";
import type { Ctx } from "../commands/ctx.ts";
import { register } from "../commands/index.ts";
import { normalizeUrl, parse } from "../commands/parse.ts";
import { currentOrNew } from "../commands/shared.ts";
import { BrowseError } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import { AUDIT_RUN } from "../js/index.ts";
import AXE_PATH from "../../../vendor/axe.min.js" with { type: "file" };
import type { Page } from "../state/page.ts";
import { type Json, record } from "../state/records.ts";

export const AXE_MISSING = "axe-core isn't bundled with this ardia command; reinstall it (plugins/cli/scripts/build.sh embeds ts/vendor/axe.min.js)";

export function axeSource(file: string = AXE_PATH): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    throw new BrowseError(AXE_MISSING);
  }
}

function nodesWord(count: unknown): string {
  return count === 1 ? "node" : "nodes";
}

export function auditLines(data: Json): string[] {
  const counts = record(data["counts"]);
  const lines = [`violations: ${pyStr(counts["violations"])}  incomplete: ${pyStr(counts["incomplete"])}  passes: ${pyStr(counts["passes"])}`];
  for (const [title, key] of [
    ["Violations", "violations"],
    ["Needs review", "incomplete"],
  ] as const) {
    const items = Array.isArray(data[key]) ? (data[key] as unknown[]).map(record) : [];
    if (items.length === 0) continue;
    lines.push(`${title}:`);
    for (const item of items) {
      lines.push(`  [${pyStr(item["impact"] || "n/a")}] ${pyStr(item["id"])}: ${pyStr(item["help"])} (${pyStr(item["nodeCount"])} ${nodesWord(item["nodeCount"])})`);
      lines.push(`    ${pyStr(item["helpUrl"])}`);
      const nodes = Array.isArray(item["nodes"]) ? (item["nodes"] as unknown[]).slice(0, 5).map(record) : [];
      for (const node of nodes) {
        const target = Array.isArray(node["target"]) ? (node["target"] as unknown[]) : [];
        lines.push(`    - ${target.map((part) => pyStr(part)).join(" > ")}`);
      }
    }
  }
  return lines;
}

export async function cmdA11y(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--tags": "value", "--selector": "value" });
  let page: Page;
  if (args.length > 0) {
    page = await currentOrNew(ctx);
    await navigate(ctx, page, normalizeUrl(args[0] as string));
  } else page = await ctx.state.page();
  const frame = ctx.state.frameFor(page) || page.mainFrame;
  const present = await page.call("() => typeof axe !== 'undefined'", [], { frame, read: true });
  if (!present) {
    const context = await page.world(frame);
    const result = await page.send("Runtime.evaluate", { expression: `${axeSource()}\n;true`, contextId: context, returnByValue: true }, { timeout: 60 });
    if (Object.hasOwn(result, "exceptionDetails")) throw new BrowseError("axe-core failed to load in this page");
  }
  const tags = options["tags"] ? (options["tags"] as string).split(",").map((tag) => pyStrip(tag)) : [];
  const data = record(await page.call(AUDIT_RUN, [(options["selector"] as string | undefined) ?? null, tags], { frame, timeout: 120, read: true }));
  return new Result(data, auditLines(data).join("\n"), true);
}

register("a11y", cmdA11y);
