import { sleep } from "../cdp/cancel.ts";
import { register } from "../commands/index.ts";
import type { Ctx } from "../commands/ctx.ts";
import { parse } from "../commands/parse.ts";
import { Result } from "../daemon/render.ts";
import type { Page } from "../state/page.ts";
import { record } from "../state/records.ts";
import { activate } from "./store.ts";

export const RUNTIME_SETTLE = 0.2;

export async function startConsole(ctx: Ctx, page: Page): Promise<void> {
  await activate(ctx, page, "console", () => page.enableRuntime());
  ctx.state.leases.add("console");
}

async function opened(ctx: Ctx): Promise<[Page, boolean]> {
  const page = await ctx.state.page();
  const started = !page.runtimeOn;
  await startConsole(ctx, page);
  if (started) await sleep(RUNTIME_SETTLE);
  return [page, started];
}

export async function cmdConsole(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options] = parse(argv, { "--clear": "bool" });
  const [page, started] = await opened(ctx);
  const messages = [...page.console.items];
  const dropped = page.console.dropped;
  if (options["clear"]) {
    page.console.clear();
    return new Result({ cleared: true }, "✓ Console cleared");
  }
  const lines = messages.map((message) => `[${String(record(message)["type"])}] ${String(record(message)["text"])}`);
  if (dropped) lines.unshift(`(${dropped} older messages dropped)`);
  if (started && messages.length === 0) {
    lines.push("Console capture started; messages from now on are kept (Runtime is on for this tab until the session ends)");
  }
  return new Result({ messages, dropped, started }, lines.join("\n") || "(no console messages)", true);
}

export async function cmdErrors(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options] = parse(argv, { "--clear": "bool" });
  const [page, started] = await opened(ctx);
  const errors = [...page.errors.items];
  if (options["clear"]) {
    page.errors.clear();
    return new Result({ cleared: true }, "✓ Errors cleared");
  }
  const lines = errors.map((error) => String(record(error)["text"]));
  if (page.errors.dropped) lines.unshift(`(${page.errors.dropped} older errors dropped)`);
  if (started && errors.length === 0) lines.push("Error capture started; uncaught errors from now on are kept");
  return new Result({ errors, dropped: page.errors.dropped, started }, lines.join("\n") || "(no errors)", true);
}

register("console", cmdConsole);
register("errors", cmdErrors);
