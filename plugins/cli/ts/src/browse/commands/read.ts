import { roundTo, formatG } from "../../pylib/format.ts";
import { unifiedDiff } from "../../pylib/difflib.ts";
import { splitlines } from "../../pylib/str.ts";
import { urlsplit } from "../../pylib/urllib.ts";
import { asData, renderReport } from "../changes/text.ts";
import { diff as diffViews, type View } from "../changes/report.ts";
import { previous } from "../changes/views.ts";
import { BrowseError, Usage } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import { hydration } from "../act/react.ts";
import { capturePng, comparison, diffScreenshot } from "../media/commands.ts";
import { take } from "../snapshot/take.ts";
import type { Element, Page } from "../state/page.ts";
import { frameOffset } from "../state/offsets.ts";
import * as pierce from "../state/pierce.ts";
import { record } from "../state/records.ts";
import { navigate, pageTitle } from "./core.ts";
import type { Ctx } from "./ctx.ts";
import { register } from "./index.ts";
import { need, normalizeUrl, parse } from "./parse.ts";
import { readTextPy } from "./pyfile.ts";
import { currentOrNew, frameOrMain, originOf, pyIntArg, resolve } from "./shared.ts";
import "../snapshot/collect.ts";

export type Header = { key: string; data: unknown; line: string };
export const snapshotHeaders: ((ctx: Ctx, page: Page) => Promise<Header | null>)[] = [];
export const mediaHooks: {
  diffScreenshot: (ctx: Ctx, argv: string[]) => Promise<Result>;
  capturePng: (page: Page, full: boolean) => Promise<Uint8Array>;
  comparePngs: (a: Uint8Array, b: Uint8Array) => unknown;
  hydration: (page: Page) => Promise<unknown>;
} = {
  diffScreenshot: (ctx, argv) => diffScreenshot(ctx, argv),
  capturePng: (page, full) => capturePng(page, full),
  comparePngs: (before, after) => comparison(before, after, 0.1, null),
  hydration: (page) => hydration(page),
};

const TEXT_OF = "(el) => (el.innerText != null ? el.innerText : el.textContent || '').trim()";

function intOption(value: unknown): number | null {
  return value !== undefined && value !== null ? pyIntArg(String(value)) : null;
}

export async function cmdSnapshot(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(
    argv,
    { "--interactive": "bool", "--compact": "bool", "--depth": "value", "--selector": "value", "--urls": "bool", "--cursor": "bool", "--diff": "bool" },
    { "-i": "--interactive", "-c": "--compact", "-d": "--depth", "-s": "--selector", "-u": "--urls", "-C": "--cursor" },
  );
  const selector = (options["selector"] as string | undefined) || (args[0] ?? null);
  const depth = intOption(options["depth"]);
  if (options["diff"] && (selector || depth !== null)) throw new Usage("snapshot --diff compares the whole page, so it takes no -s or -d");
  const page = await ctx.state.page();
  await page.refreshFrames();
  const before = options["diff"] ? previous(ctx.state, page) : null;
  const [text] = await take(ctx.state, page, {
    interactive: Boolean(options["interactive"]),
    compact: Boolean(options["compact"]),
    depth,
    selector,
    urls: Boolean(options["urls"]),
  });
  const origin = originOf(page, page.mainFrame) || page.url;
  const data: Record<string, unknown> = { origin: origin.endsWith("/") ? origin : `${origin}/`, refs: ctx.state.refsJson(), snapshot: text };
  let body = text || "(empty page)";
  if (options["diff"]) {
    if (before === null) {
      data["changes"] = null;
      body = `(no earlier snapshot of this document in this session, so here is all of it)\n${body}`;
    } else {
      const report = diffViews(before, ctx.state.views.get(page.targetId) as View);
      data["changes"] = asData(report);
      body = renderReport(report);
    }
  }
  for (const header of snapshotHeaders) {
    const found = await header(ctx, page);
    if (found === null) continue;
    data[found.key] = found.data;
    body = `${found.line}\n${body}`;
  }
  return new Result(data, body, true);
}

function boxText(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

export async function cmdGet(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  need(args, 1, "get text|html|value|attr|title|url|count|box|styles|cdp-url [selector]");
  const what = args[0] as string;
  if (what === "cdp-url") {
    await ctx.state.connect();
    const endpoint = ctx.state.endpoint;
    const url = endpoint?.ws ?? "";
    const parts = urlsplit(url);
    if (!endpoint?.explicit || parts.query || parts.netloc.includes("@") || url.toLowerCase().includes("token")) {
      throw new BrowseError("This CDP URL carries a control token, so ardia browse never prints it; drive the page with ardia browse commands (`eval` for JavaScript)");
    }
    return new Result({ cdpUrl: url }, url);
  }
  let page = await ctx.state.page();
  if (what === "title") {
    const title = await pageTitle(page);
    return new Result({ title }, title, true);
  }
  if (what === "url") {
    await page.refreshFrames();
    return new Result({ url: page.url }, page.url);
  }
  if (what === "count") {
    need(args, 2, "get count <selector>");
    const frame = frameOrMain(ctx, page);
    let count = Number(await page.call("(s) => ardiaBrowse.queryAll(s).length", [args[1]], { frame, read: true }));
    if (count === 0) count = await pierce.countAll(page, frame, args[1] as string);
    return new Result({ count, selector: args[1] }, String(count));
  }
  need(args, 2, `get ${what} <selector>`);
  let element: Element;
  [page, element] = await resolve(ctx, args[1] as string);
  let origin = originOf(page, element.frame);
  origin = origin && !origin.endsWith("/") ? `${origin}/` : origin;
  const frame = element.frame;
  if (what === "text") {
    const value = await page.call(TEXT_OF, [element], { frame });
    return new Result({ origin, text: value }, String(value ?? ""), true);
  }
  if (what === "html") {
    const value = await page.call("(el) => el.innerHTML", [element], { frame });
    return new Result({ origin, html: value }, String(value ?? ""), true);
  }
  if (what === "value") {
    const value = await page.call("(el) => 'value' in el ? el.value : (el.isContentEditable ? el.innerText : null)", [element], { frame });
    return new Result({ value }, value === null || value === undefined ? "" : String(value), true);
  }
  if (what === "attr") {
    need(args, 3, "get attr <selector> <name>");
    const value = await page.call("(el, n) => el.getAttribute(n)", [element, args[2]], { frame });
    return new Result({ attribute: args[2], value }, value === null || value === undefined ? "" : String(value), true);
  }
  if (what === "box") {
    const rect = record(await page.call("(el) => ardiaBrowse.rect(el)", [element], { frame }));
    const [ox, oy] = await frameOffset(page, frame);
    const box: Record<string, number> = { x: Number(rect["x"]) + ox, y: Number(rect["y"]) + oy, width: Number(rect["width"]), height: Number(rect["height"]) };
    const text = ["x", "y", "width", "height"].map((key) => `${`${key}:`.padEnd(8)}${boxText(box[key] as number)}`).join("\n");
    return new Result(box, text);
  }
  if (what === "styles") {
    const styles = record(await page.call("(el) => ardiaBrowse.styles(el)", [element], { frame }));
    return new Result({ styles }, Object.entries(styles).map(([key, value]) => `${key}: ${value}`).join("\n"));
  }
  throw new Usage(`Unknown get subcommand: ${what}`);
}

export async function cmdIs(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  need(args, 2, "is visible|enabled|checked <selector>");
  const what = args[0] as string;
  const [page, element] = await resolve(ctx, args[1] as string);
  const origin = originOf(page, element.frame);
  let value: unknown;
  if (what === "visible") value = await page.call("(el) => ardiaBrowse.visible(el)", [element], { frame: element.frame });
  else if (what === "enabled" || what === "checked") {
    const info = record(await page.call("(el) => ardiaBrowse.info(el)", [element], { frame: element.frame }));
    value = what === "enabled" ? !info["disabled"] : info["checked"];
  } else throw new Usage(`Unknown is subcommand: ${what} (visible, enabled, checked)`);
  return new Result({ origin: origin ? `${origin}/` : origin, [what]: Boolean(value) }, value ? "true" : "false");
}

function ms(value: unknown): string {
  if (value === null || value === undefined) return "-";
  const number = Number(value);
  return number < 10 ? `${number.toFixed(1)}ms` : `${roundTo(number, 0).toFixed(0)}ms`;
}

export async function cmdVitals(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  const page = args.length ? await currentOrNew(ctx) : await ctx.state.page();
  if (args.length) await navigate(ctx, page, normalizeUrl(args[0] as string));
  const data = record(await page.call("() => ardiaBrowse.vitals()", [], { frame: page.mainFrame, read: true }));
  const react = [...page.initScripts.values()].includes("react");
  data["hydration"] = react ? await mediaHooks.hydration(page) : null;
  const hydration = record(data["hydration"] ?? {});
  const text = [
    `url: ${data["url"]}`,
    `ttfb: ${ms(data["ttfb"])}  fcp: ${ms(data["fcp"])}  lcp: ${ms(data["lcp"])}  cls: ${formatG(roundTo(Number(data["cls"]), 4))}  inp: ${ms(data["inp"])}`,
    `lcp: element: ${data["lcpElement"] || "-"}`,
    `hydration: ${ms(hydration["duration"])}  phases: ${hydration["phases"] ?? 0}  hydratedComponents: ${hydration["components"] ?? 0}`,
  ].join("\n");
  return new Result(data, text);
}

export function diffResult(before: string, after: string): Result {
  const beforeLines = splitlines(before);
  const lines = unifiedDiff(beforeLines, splitlines(after), "before", "after", "", "", 3, "");
  const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const removals = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const unchanged = before ? beforeLines.length - removals : 0;
  const text = lines.join("\n");
  return new Result({ diff: text, additions, removals, unchanged: Math.max(unchanged, 0), changed: lines.length > 0 }, text || "No changes", true);
}

export async function cmdDiff(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv.slice(0, 1));
  need(args, 1, "diff snapshot|screenshot|url ...");
  const kind = args[0] as string;
  const rest = argv.slice(1);
  if (kind === "snapshot") {
    const [options] = parse(
      rest,
      { "--baseline": "value", "--selector": "value", "--compact": "bool", "--depth": "value", "--interactive": "bool" },
      { "-b": "--baseline", "-s": "--selector", "-c": "--compact", "-d": "--depth", "-i": "--interactive" },
    );
    const before = options["baseline"] ? readTextPy(ctx.path(options["baseline"] as string)) : (ctx.state.lastSnapshot ?? "");
    const page = await ctx.state.page();
    const [after] = await take(ctx.state, page, {
      interactive: Boolean(options["interactive"]),
      compact: Boolean(options["compact"]),
      depth: options["depth"] ? pyIntArg(options["depth"] as string) : null,
      selector: (options["selector"] as string | undefined) ?? null,
    });
    return diffResult(before, after);
  }
  if (kind === "screenshot") {
    return mediaHooks.diffScreenshot(ctx, rest);
  }
  if (kind === "url") {
    const [options, positional] = parse(
      rest,
      { "--screenshot": "bool", "--full": "bool", "--wait-until": "value", "--selector": "value", "--compact": "bool", "--depth": "value" },
      { "-s": "--selector", "-c": "--compact", "-d": "--depth" },
    );
    need(positional, 2, "diff url <url1> <url2>");
    const page = await currentOrNew(ctx);
    const shots: Uint8Array[] = [];
    const texts: string[] = [];
    for (const url of positional.slice(0, 2)) {
      await navigate(ctx, page, normalizeUrl(url), (options["wait_until"] as string | undefined) || "load");
      const [text] = await take(ctx.state, page, {
        compact: Boolean(options["compact"]),
        depth: options["depth"] ? pyIntArg(options["depth"] as string) : null,
        selector: (options["selector"] as string | undefined) ?? null,
      });
      texts.push(text);
      if (options["screenshot"]) shots.push(await mediaHooks.capturePng(page, Boolean(options["full"])));
    }
    const result = diffResult(texts[0] as string, texts[1] as string);
    if (shots.length) (result.data as Record<string, unknown>)["screenshot"] = mediaHooks.comparePngs(shots[0] as Uint8Array, shots[1] as Uint8Array);
    return result;
  }
  throw new Usage(`Unknown diff kind: ${kind} (snapshot, screenshot, url)`);
}

register("snapshot", cmdSnapshot);
register("get", cmdGet);
register("is", cmdIs);
register("vitals", cmdVitals);
register("diff", cmdDiff);
