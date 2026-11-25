import { sleep } from "../cdp/cancel.ts";
import { register } from "../commands/index.ts";
import type { Ctx } from "../commands/ctx.ts";
import { parse } from "../commands/parse.ts";
import { BrowseError } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import type { Page } from "../state/page.ts";
import { ERROR_DETAIL, type ErrorDetail, record } from "../state/records.ts";
import { MAX_DIAGNOSTICS_LIMIT, readTabDiagnostics, watermarksOf } from "../state/tabtools.ts";
import { askArdia } from "./inspect.ts";
import { inlineMapsOf } from "./logpoints.ts";
import { mapFor, originalPosition } from "./sourcemaps.ts";
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
  const page = await ctx.state.page();
  const marks = watermarksOf(page);
  const diag = await readTabDiagnostics(ctx.state, page, { kind: "console", since: marks.consoleSince, limit: MAX_DIAGNOSTICS_LIMIT });
  if (diag !== null) {
    if (options["clear"]) {
      marks.consoleSince = Math.max(marks.consoleSince, diag.nextSeq);
      marks.consoleClearedAt = Date.now();
      marks.cdpClearedAt = null;
      page.console.clear();
      if (diag.more) {
        throw new BrowseError(
          "Console log had more entries than could be cleared in one pass; run `console --clear` again to finish",
          { cleared: false, more: true, source: "ardia", nextSeq: diag.nextSeq },
        );
      }
      return new Result({ cleared: true, source: "ardia" }, "✓ Console cleared");
    }
    const cdpClearedAt = marks.cdpClearedAt;
    const kept = cdpClearedAt === null ? diag.console : diag.console.filter((entry) => entry.time > cdpClearedAt);
    const messages = kept.map((entry) => ({
      type: entry.level,
      text: entry.message,
      kind: entry.kind,
      source: entry.source,
      line: entry.line,
      timestamp: entry.time,
      seq: entry.seq,
    }));
    const lines = kept.map((entry) => `[${entry.level}] ${entry.message}`);
    if (diag.dropped) lines.unshift(`(${diag.dropped} older tab diagnostic entries dropped)`);
    if (diag.more) lines.push("(more diagnostic entries available)");
    return new Result({ messages, dropped: diag.dropped, more: diag.more, started: false, source: "ardia", nextSeq: diag.nextSeq }, lines.join("\n") || "(no console messages)", true);
  }
  const [, started] = await opened(ctx);
  if (options["clear"]) {
    const now = Date.now();
    marks.consoleClearedAt = now;
    marks.cdpClearedAt = now;
    page.console.clear();
    return new Result({ cleared: true }, "✓ Console cleared");
  }
  const clearedAt = marks.consoleClearedAt;
  const messages = clearedAt === null
    ? [...page.console.items]
    : page.console.items.filter((message) => {
        const ts = record(message)["timestamp"];
        return typeof ts !== "number" || ts > clearedAt;
      });
  const dropped = page.console.dropped;
  const lines = messages.map((message) => `[${String(record(message)["type"])}] ${String(record(message)["text"])}`);
  if (dropped) lines.unshift(`(${dropped} older messages dropped)`);
  if (started && messages.length === 0) {
    lines.push("Console capture started; messages from now on are kept (Runtime is on for this tab until the session ends; the page can detect this)");
  }
  return new Result({ messages, dropped, started }, lines.join("\n") || "(no console messages)", true);
}

export const CAUSES_KEPT = 5;
export const STACK_METHOD = "devtools.stackTrace";
export const CAUSE_FUNCTION_METHOD = "devtools.causeChainFunction";
const STACK_TEXT_LIMIT = 20_000;
export const CHAIN_FUNCTION = `function (limit) {
  const out = [];
  let error = this;
  for (let depth = 0; error !== undefined && error !== null && depth <= (typeof limit === "number" ? limit : 5); depth += 1) {
    out.push({ name: String((error && error.name) || "Error"), message: String((error && error.message) ?? error), stack: String((error && error.stack) || "").slice(0, ${STACK_TEXT_LIMIT}) });
    error = error && error.cause;
  }
  return out;
}`;
const STACK_URL = /\(?((?:https?|file):\/\/[^\s()]+?):\d+:\d+\)?/gu;

type ChainLink = { name: string; message: string; stack: string };

function plainError(error: unknown): Record<string, unknown> {
  const row = record(error);
  return { text: row["text"], url: row["url"], line: row["line"], column: row["column"], timestamp: row["timestamp"] };
}

async function chainFunction(ctx: Ctx): Promise<{ source: string; args: unknown[] }> {
  const answer = await askArdia(ctx, CAUSE_FUNCTION_METHOD, {}, 5).catch(() => null);
  const given = answer?.["functionDeclaration"];
  return typeof given === "string" && given.length < 20_000 ? { source: given, args: [] } : { source: CHAIN_FUNCTION, args: [CAUSES_KEPT] };
}

async function chainOf(page: Page, detail: ErrorDetail | undefined, chain: { source: string; args: unknown[] }): Promise<ChainLink[]> {
  if (!detail?.exceptionId) return [];
  try {
    const answer = await page.send("Runtime.callFunctionOn", { objectId: detail.exceptionId, functionDeclaration: chain.source, arguments: chain.args.map((value) => ({ value })), returnByValue: true }, { timeout: 5 });
    const value = record(answer["result"])["value"];
    if (!Array.isArray(value)) return [];
    return value.slice(0, CAUSES_KEPT + 1).map((item) => {
      const link = record(item);
      return { name: String(link["name"] ?? "Error"), message: String(link["message"] ?? ""), stack: String(link["stack"] ?? "").slice(0, STACK_TEXT_LIMIT) };
    });
  } catch {
    return [];
  }
}

function stackUrls(detail: ErrorDetail | undefined, chain: readonly ChainLink[]): Set<string> {
  const urls = new Set<string>();
  for (const frame of detail?.stack ?? []) if (frame.url) urls.add(frame.url);
  for (const link of chain) for (const found of link.stack.matchAll(STACK_URL)) urls.add(found[1] as string);
  return urls;
}

function frameText(frame: Record<string, unknown>): string {
  const name = typeof frame["functionName"] === "string" && frame["functionName"] ? frame["functionName"] : "(anonymous)";
  const generated = `${String(frame["url"] ?? "")}:${String(frame["line"] ?? "?")}:${String(frame["column"] ?? "?")}`;
  const original = record(frame["original"]);
  if (typeof original["source"] !== "string") return `    at ${name} (${generated})`;
  return `    at ${name} (${original["source"] as string}:${String(original["line"] ?? "?")}:${String(original["column"] ?? "?")})  [${generated}]`;
}

export function ardiaChainLines(answer: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const chain = Array.isArray(answer["chain"]) ? answer["chain"] : [];
  chain.forEach((raw, index) => {
    const link = record(raw);
    const head = `${String(link["name"] ?? "Error")}: ${String(link["message"] ?? "")}`;
    lines.push(index === 0 ? head : `  caused by: ${head}`);
    for (const frame of Array.isArray(link["frames"]) ? link["frames"] : []) lines.push(frameText(record(frame)));
  });
  return lines;
}

function mappedFrame(page: Page, frame: ErrorDetail["stack"][number], maps: ReadonlyMap<string, string>): string {
  const generated = `${frame.url}:${frame.line + 1}:${frame.column + 1}`;
  const name = frame.functionName || "(anonymous)";
  const loaded = frame.url ? mapFor(page, frame.url, maps.get(frame.url)) : null;
  const original = loaded === null ? null : originalPosition(loaded, frame.line, frame.column);
  if (original === null) return `    at ${name} (${generated})`;
  return `    at ${name} (${original.url}:${original.line}:${original.column})  [${generated}]`;
}

async function uncaught(ctx: Ctx, page: Page, errors: readonly unknown[]): Promise<{ lines: string[]; rows: Record<string, unknown>[] }> {
  const lines: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const chainSource = errors.length > 0 ? await chainFunction(ctx) : { source: CHAIN_FUNCTION, args: [CAUSES_KEPT] };
  for (const error of errors) {
    const row = record(error);
    const detail = (error as Record<symbol, ErrorDetail | undefined>)[ERROR_DETAIL];
    const chain = await chainOf(page, detail, chainSource);
    const maps = await inlineMapsOf(ctx, page, stackUrls(detail, chain));
    const asked: Record<string, unknown> = { error: chain.length > 0 ? chain : { exceptionDetails: detail?.details ?? { text: row["text"] } } };
    if (maps.size > 0) asked["sourceMaps"] = Object.fromEntries(maps);
    const fromArdia = await askArdia(ctx, STACK_METHOD, asked, 10).catch(() => null);
    if (fromArdia !== null) {
      lines.push(...ardiaChainLines(fromArdia));
      rows.push({ ...plainError(error), source: "ardia", chain: fromArdia["chain"] ?? [], sourceMaps: fromArdia["sourceMaps"] ?? null });
      continue;
    }
    const head = String(row["text"]).split("\n    at ")[0] as string;
    const stack = (detail?.stack ?? []).map((frame) => mappedFrame(page, frame, maps));
    const causes = chain.slice(1).map((link) => [`${link.name}: ${link.message}`, ...link.stack.split("\n").slice(1, 3)].join("\n"));
    lines.push(head, ...stack, ...causes.map((cause) => `  caused by: ${cause.replaceAll("\n", "\n    ")}`));
    rows.push({ ...plainError(error), source: "cli", stack, causes });
  }
  return { lines, rows };
}

export async function cmdErrors(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options] = parse(argv, { "--clear": "bool", "--uncaught": "bool" });
  const [page, started] = await opened(ctx);
  const errors = [...page.errors.items];
  if (options["clear"]) {
    page.errors.clear();
    return new Result({ cleared: true }, "✓ Errors cleared");
  }
  if (options["uncaught"]) {
    const { lines, rows } = await uncaught(ctx, page, errors);
    if (page.errors.dropped) lines.unshift(`(${page.errors.dropped} older errors dropped)`);
    if (started && errors.length === 0) lines.push("Error capture started; uncaught errors from now on are kept, with their stacks");
    return new Result({ errors: rows, dropped: page.errors.dropped, started }, lines.join("\n") || "(no uncaught errors)", true);
  }
  const lines = errors.map((error) => String(record(error)["text"]));
  if (page.errors.dropped) lines.unshift(`(${page.errors.dropped} older errors dropped)`);
  if (started && errors.length === 0) lines.push("Error capture started; uncaught errors from now on are kept");
  return new Result({ errors: errors.map(plainError), dropped: page.errors.dropped, started }, lines.join("\n") || "(no errors)", true);
}

register("console", cmdConsole);
register("errors", cmdErrors);
