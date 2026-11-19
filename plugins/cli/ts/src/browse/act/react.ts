import { fixed, right } from "../../py.ts";
import { dumps } from "../../json.ts";
import type { Ctx } from "../commands/ctx.ts";
import { register } from "../commands/index.ts";
import { need, parse } from "../commands/parse.ts";
import { BrowseError, Usage } from "../daemon-errors.ts";
import { pyValue, Result } from "../daemon/render.ts";
import { REACT_HOOK } from "../js/index.ts";
import type { Page } from "../state/page.ts";
import { asRecord } from "./common.ts";

export const HOOK = REACT_HOOK;
export const EVAL_TIMEOUT = 60.0;

export async function evaluateMain(page: Page, expression: string, timeout = EVAL_TIMEOUT): Promise<unknown> {
  const result = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: false }, { timeout, mutation: true });
  if (Object.hasOwn(result, "exceptionDetails")) {
    const details = asRecord(result["exceptionDetails"]);
    const description = String(asRecord(details["exception"])["description"] || details["text"] || "error");
    throw new BrowseError(`Evaluation error: ${description}`, null, "page_script_error");
  }
  const remote = asRecord(result["result"]);
  if (remote["type"] === "undefined") return null;
  if (Object.hasOwn(remote, "value")) return remote["value"];
  return remote["unserializableValue"] || remote["description"] || null;
}

function hooked(page: Page): boolean {
  return [...page.initScripts.values()].includes("react");
}

async function reactCall(ctx: Ctx, expression: string): Promise<unknown> {
  const page = await ctx.state.page();
  if (!hooked(page)) throw new BrowseError("React commands need the hook installed before the page loads: `ardia browse open --enable react-devtools <url>`");
  const ready = await evaluateMain(page, "!!(window.__ardiaReact && window.__ardiaReact.ready())");
  if (!ready) throw new BrowseError("No React root has committed in this page yet (is it a React app, and was it loaded after `--enable react-devtools`?)");
  return evaluateMain(page, expression);
}

export async function hydration(page: Page): Promise<unknown> {
  try {
    return await evaluateMain(page, "window.__ardiaReact ? window.__ardiaReact.hydration() : null");
  } catch (error) {
    if (error instanceof BrowseError) return null;
    throw error;
  }
}

type Row = Record<string, unknown>;

function pyIntText(text: string): number {
  const trimmed = text.trim().replaceAll("_", "");
  if (!/^[+-]?[0-9]+$/u.test(trimmed)) throw new BrowseError(`invalid literal for int() with base 10: '${text}'`);
  return Number(trimmed);
}

async function cmdReact(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--only-dynamic": "bool" });
  need(args, 1, "react tree | inspect <id> | renders start|stop | suspense [--only-dynamic]");
  const action = args[0];
  if (action === "tree") {
    const rows = ((await reactCall(ctx, "window.__ardiaReact.tree()")) as Row[] | null) ?? [];
    const lines = [
      "depth id parent name",
      ...rows.map((row) => `${String(row["depth"])} ${String(row["id"])} ${row["parent"] !== null && row["parent"] !== undefined ? String(row["parent"]) : "-"} ${"  ".repeat(Number(row["depth"]))}${String(row["name"])}`),
    ];
    return new Result({ components: rows }, lines.join("\n"), true);
  }
  if (action === "inspect") {
    need(args, 2, "react inspect <id>");
    const data = await reactCall(ctx, `window.__ardiaReact.inspect(${pyIntText(args[1] as string)})`);
    if (data === null || data === undefined) throw new BrowseError(`No fiber ${args[1]}; run \`ardia browse react tree\` for current ids`);
    return new Result(data, dumps(pyValue(data), "indented"), true);
  }
  if (action === "renders") {
    need(args, 2, "react renders start|stop");
    if (args[1] === "start") {
      await reactCall(ctx, "window.__ardiaReact.rendersStart()");
      return new Result({ recording: true }, "✓ Recording renders");
    }
    if (args[1] === "stop") {
      const data = asRecord(await reactCall(ctx, "window.__ardiaReact.rendersStop()"));
      const components = (data["components"] as Row[] | undefined) ?? [];
      const lines = [`commits: ${String(data["commits"])}  duration: ${fixed(Number(data["durationMs"]), 0)}ms`];
      for (const row of components.slice(0, 50)) lines.push(`${right(String(row["count"]), 5)}  ${String(row["name"])}`);
      return new Result(data, lines.join("\n"));
    }
    throw new Usage("Usage: ardia browse react renders start|stop");
  }
  if (action === "suspense") {
    let rows = ((await reactCall(ctx, "window.__ardiaReact.suspense()")) as Row[] | null) ?? [];
    if (options["only_dynamic"]) rows = rows.filter((row) => row["kind"] === "dynamic");
    const dynamic = rows.filter((row) => row["kind"] === "dynamic");
    const fixedRows = rows.filter((row) => row["kind"] === "static");
    const lines = [`boundaries: ${rows.length}  dynamic: ${dynamic.length}  static: ${fixedRows.length}`];
    for (const [title, group] of [
      ["dynamic", dynamic],
      ["static", fixedRows],
    ] as const) {
      if (group.length === 0) continue;
      lines.push(`${title}:`);
      for (const row of group) lines.push(`  #${String(row["id"])} in ${String(row["parent"] || "root")}${row["suspended"] ? " (suspended now)" : ""}`);
    }
    return new Result({ boundaries: rows, dynamic: dynamic.length, static: fixedRows.length }, lines.join("\n"));
  }
  throw new Usage(`Unknown react subcommand: ${action}`);
}

register("react", cmdReact);
