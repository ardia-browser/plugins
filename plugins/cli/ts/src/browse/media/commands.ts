import fs from "node:fs";
import path from "node:path";
import { Float, floatRepr } from "../../json.ts";
import { errnoOf, strerror } from "../../paths.ts";
import { pythonOsError } from "../../printable.ts";
import { pyFloatOrUndefined, reprText } from "../../pylib/str.ts";
import { roundHalfEven } from "../../pylib/format.ts";
import type { Ctx } from "../commands/ctx.ts";
import { register } from "../commands/index.ts";
import { need, parse, SELECTOR_ALIAS, SELECTOR_FLAG } from "../commands/parse.ts";
import { resolve } from "../commands/shared.ts";
import { BrowseError, Gated, Usage } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import { flag } from "../metrics.ts";
import { pyError, pyFloat, pyIntArg } from "../pyerror.ts";
import { type Element, type Page, quiet } from "../state/page.ts";
import { type Json, record } from "../state/records.ts";
import { captureOf } from "../capture/store.ts";
import { take } from "../snapshot/take.ts";
import { frameOffset } from "../state/offsets.ts";
import { type AnnotationRow, drawAnnotations, thresholdOf } from "./draw.ts";
import { refNumber } from "../state/refs.ts";
import { defaultPath } from "./paths.ts";
import { type Comparison, comparePngs, encodePng } from "./png.ts";
import { clipScale, type CoordinateFrame, frameLines, frameOf, imageSize, type Mark, markOf, marksText, parseRegion, parseScale, type Region } from "./marks.ts";

export const mediaPairing: { withSnapshot: ((ctx: Ctx, file: string | null) => Promise<Result>) | null } = { withSnapshot: null };

export type Clip = { x: unknown; y: unknown; width: number; height: number; scale: number };
export type Annotation = AnnotationRow & { ref: string; role: string; name?: string };
type Viewport = Json;

function osError(error: unknown, file: string): unknown {
  const errno = errnoOf(error);
  if (!errno) return error;
  return pyError(pythonOsError(errno), `[Errno ${errno}] ${strerror(errno)}: ${reprText(file)}`);
}

export function writeBytes(file: string, data: Uint8Array): void {
  try {
    fs.writeFileSync(file, data);
  } catch (error) {
    throw osError(error, file);
  }
}

export function makeParents(file: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (error) {
    throw osError(error, path.dirname(file));
  }
}

function pyFloatArg(text: string): number {
  const value = pyFloatOrUndefined(text);
  if (value === undefined) throw pyError("ValueError", `could not convert string to float: ${reprText(text)}`);
  return value;
}

export async function capturePng(page: Page, full = false, clip: Clip | null = null, fmt = "png", quality: number | null = null, fullScale = 1, beyond = true): Promise<Uint8Array> {
  const params: Json = { format: fmt, fromSurface: true };
  if (quality !== null && fmt === "jpeg") params["quality"] = quality;
  if (full) {
    const metrics = await page.send("Page.getLayoutMetrics");
    const size = record(metrics["cssContentSize"] || metrics["contentSize"]);
    params["clip"] = { x: 0, y: 0, width: size["width"], height: size["height"], scale: fullScale };
    params["captureBeyondViewport"] = true;
  } else if (clip) {
    params["clip"] = clip;
    params["captureBeyondViewport"] = beyond;
  }
  const result = await page.send("Page.captureScreenshot", params, { timeout: 60 });
  return Buffer.from(String(result["data"] ?? ""), "base64");
}

export function inImage(box: AnnotationRow["box"], region: readonly [number, number, number, number]): boolean {
  const [left, top, right, bottom] = region;
  return box.width > 0 && box.height > 0 && box.x < right && box.x + box.width > left && box.y < bottom && box.y + box.height > top;
}

function num(value: unknown): number {
  return Number(value) || 0;
}

async function annotations(ctx: Ctx, page: Page, full: boolean, within: Region | null = null): Promise<[Annotation[], Viewport]> {
  await take(ctx.state, page, { interactive: true });
  const rows: Annotation[] = [];
  const metrics = await page.send("Page.getLayoutMetrics");
  const viewport = record(metrics["cssVisualViewport"]);
  const width = num(viewport["clientWidth"]);
  const height = num(viewport["clientHeight"]);
  let region: [number, number, number, number] = [0, 0, width, height];
  if (full) {
    const content = record(metrics["cssContentSize"] || metrics["contentSize"]);
    const scrollX = num(viewport["pageX"]);
    const scrollY = num(viewport["pageY"]);
    region = [-scrollX, -scrollY, (num(content["width"]) || width) - scrollX, (num(content["height"]) || height) - scrollY];
  }
  if (within !== null) region = [within.x, within.y, within.x + within.width, within.y + within.height];
  for (const ref of ctx.state.snapshotRefs()) {
    let quads: unknown[] = [];
    try {
      const found = (await page.send("DOM.getContentQuads", { backendNodeId: ref.backend }))["quads"];
      quads = Array.isArray(found) ? found : [];
    } catch (error) {
      if (!quiet(error)) throw error;
    }
    if (quads.length === 0) continue;
    const quad = (quads[0] as number[]).map(Number);
    const xs = quad.filter((_, index) => index % 2 === 0);
    const ys = quad.filter((_, index) => index % 2 === 1);
    const box = {
      x: roundHalfEven(Math.min(...xs)),
      y: roundHalfEven(Math.min(...ys)),
      width: roundHalfEven(Math.max(...xs) - Math.min(...xs)),
      height: roundHalfEven(Math.max(...ys) - Math.min(...ys)),
    };
    const entry: Annotation = { number: refNumber(ref.id) ?? 0, ref: ref.id, role: ref.role, box };
    if (ref.name) entry.name = ref.name;
    if (inImage(box, region)) rows.push(entry);
  }
  return [rows, viewport];
}

async function viewportOf(page: Page): Promise<Json> {
  return record(await page.call("() => ardiaBrowse.viewport()", [], { frame: page.mainFrame, read: true }));
}

async function rect(page: Page, element: Element): Promise<Json> {
  return record(await page.call("(el) => ardiaBrowse.rect(el)", [element], { frame: element.frame }));
}

function isPath(arg: string): boolean {
  const lower = arg.toLowerCase();
  return lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || (arg.includes("/") && !arg.startsWith("@"));
}

function viewKey(page: Page, selector: string | null, full: boolean, fmt: string, annotate: boolean, shape: unknown = null): string {
  return JSON.stringify(shape === null ? [page.targetId, selector, full, fmt, annotate] : [page.targetId, selector, full, fmt, annotate, shape]);
}

type Layout = { viewport: { width: number; height: number }; scrollX: number; scrollY: number; dpr: number; content: { width: number; height: number } };

async function layoutOf(page: Page): Promise<Layout> {
  const metrics = await page.send("Page.getLayoutMetrics");
  const css = record(metrics["cssVisualViewport"]);
  const device = record(metrics["visualViewport"]);
  const content = record(metrics["cssContentSize"] || metrics["contentSize"]);
  const width = num(css["clientWidth"]);
  const height = num(css["clientHeight"]);
  const deviceWidth = num(device["clientWidth"]);
  const measured = width > 0 && deviceWidth > 0 ? deviceWidth / width : 1;
  let reported = 0;
  try {
    reported = num(await page.call("() => window.devicePixelRatio", [], { frame: page.mainFrame, read: true }));
  } catch (error) {
    if (!quiet(error)) throw error;
  }
  const dpr = reported >= 0.5 && reported <= 8 ? reported : measured >= 0.5 && measured <= 8 ? measured : 1;
  return {
    viewport: { width, height },
    scrollX: num(css["pageX"]),
    scrollY: num(css["pageY"]),
    dpr,
    content: { width: num(content["width"]) || width, height: num(content["height"]) || height },
  };
}

export function unchanged(before: Uint8Array, after: Uint8Array, fmt: string, percent: number): boolean {
  if (Buffer.from(before.buffer, before.byteOffset, before.byteLength).equals(after)) return true;
  if (fmt !== "png" || percent <= 0) return false;
  const { result } = comparePngs(before, after, 0.1);
  return result.diffPixels !== null && (result.diffPercent ?? 100) <= percent;
}

export async function cmdScreenshot(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(
    argv,
    {
      "--full": "bool",
      "--annotate": "bool",
      "--screenshot-dir": "value",
      "--screenshot-format": "value",
      "--screenshot-quality": "value",
      "--out": "value",
      "--if-changed": "bool",
      "--threshold": "value",
      "--with-snapshot": "bool",
      "--scale": "value",
      "--region": "value",
      "--marks": "bool",
      ...SELECTOR_FLAG,
    },
    { "-f": "--full", ...SELECTOR_ALIAS },
  );
  for (const key of ["screenshot_dir", "screenshot_format", "screenshot_quality"]) {
    if (options[key]) ctx.options[key] = options[key];
  }
  const full = Boolean(options["full"] || ctx.options["full"]);
  const annotate = Boolean(options["annotate"] || ctx.options["annotate"]);
  let fmt = String(ctx.options["screenshot_format"] || ctx.env["AGENT_BROWSER_SCREENSHOT_FORMAT"] || "png").toLowerCase();
  if (fmt === "jpg") fmt = "jpeg";
  if (fmt !== "png" && fmt !== "jpeg") throw new BrowseError("--screenshot-format takes png or jpeg");
  const qualityGiven = ctx.options["screenshot_quality"] || ctx.env["AGENT_BROWSER_SCREENSHOT_QUALITY"];
  const quality = qualityGiven ? pyIntArg(String(qualityGiven)) : null;
  let selector: string | null = typeof options["selector"] === "string" ? (options["selector"] as string) : null;
  if (selector === "" || selector === "--") throw new Usage("-s/--selector needs a selector");
  if (selector !== null) {
    flag("guessed_syntax", true);
    if (options["out"] && args.length > 0) throw new Usage("screenshot takes its path once: as a word or as --out, not both");
    if (args.length > 1) throw new Usage("with -s/--selector, screenshot takes one path");
    if (args.length === 1 && !isPath(args[0] as string)) throw new Usage(`give the selector once: ${args[0]} isn't a file path, and -s/--selector already names the element`);
  }
  let target = (options["out"] as string | undefined) || null;
  for (const arg of args) {
    if (target === null && isPath(arg)) target = arg;
    else if (selector === null) selector = arg;
    else target = arg;
  }
  if (annotate && fmt !== "png") throw new BrowseError("--annotate draws on a PNG; drop --screenshot-format jpeg");
  const scale = parseScale(options["scale"]);
  const region = parseRegion(options["region"]);
  const marks = Boolean(options["marks"]);
  if (marks && fmt !== "png") throw new BrowseError("--marks draws on a PNG; drop --screenshot-format jpeg");
  if (marks && annotate) throw new Usage("--marks already draws each ref's badge, so give --marks or --annotate, not both");
  if (region !== null && (full || selector !== null)) throw new Usage("--region crops the viewport, so it doesn't go with --full or a selector");
  if (options["with_snapshot"]) {
    if (scale !== null || region !== null || marks) throw new Usage("screenshot --with-snapshot takes only a path (no --scale, --region or --marks)");
    if (selector !== null || full || annotate || fmt !== "png" || options["if_changed"]) {
      throw new Usage("screenshot --with-snapshot pairs the whole viewport with its snapshot, so it takes only a path (no selector, --full, --annotate, --if-changed or jpeg)");
    }
    if (mediaPairing.withSnapshot === null) throw new Usage("screenshot --with-snapshot isn't available here");
    return mediaPairing.withSnapshot(ctx, target);
  }
  if (scale !== null || region !== null || marks) return framedScreenshot(ctx, { selector, full, fmt, quality, target, scale: scale ?? 1, region, marks, annotate, ifChanged: Boolean(options["if_changed"]), threshold: options["threshold"] ?? null });
  let page = await ctx.state.page();
  let clip: Clip | null = null;
  if (selector) {
    let element: Element;
    [page, element] = await ctx.state.locate(selector);
    await page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: element.backendId });
    const box = await rect(page, element);
    const [ox, oy] = await frameOffset(page, element.frame);
    const vp = await viewportOf(page);
    clip = {
      x: pyFloat(num(box["x"]) + ox + num(vp["scrollX"])),
      y: pyFloat(num(box["y"]) + oy + num(vp["scrollY"])),
      width: Math.max(1, num(box["width"])),
      height: Math.max(1, num(box["height"])),
      scale: 1,
    };
  }
  let rows: Annotation[] | null = null;
  let viewport: Viewport = {};
  if (annotate) [rows, viewport] = await annotations(ctx, page, full);
  let data = await capturePng(page, full, clip, fmt, quality);
  if (rows !== null) {
    let offset: [number, number] | null = null;
    if (full) {
      const vp = await viewportOf(page);
      offset = [num(vp["scrollX"]), num(vp["scrollY"])];
    }
    data = drawAnnotations(data, rows, { clientWidth: num(viewport["clientWidth"]) }, offset);
  }
  const shots = captureOf(ctx.state).lastShots;
  const view = viewKey(page, selector, full, fmt, annotate);
  const before = shots.get(view);
  shots.set(view, data);
  if (options["if_changed"] && before !== undefined && unchanged(before, data, fmt, thresholdOf(options["threshold"] ?? null))) {
    flag("screenshot_unchanged", true);
    return new Result({ path: null, unchanged: true }, "= Unchanged since the last screenshot of this view, so nothing was saved");
  }
  const file = target ? ctx.path(target) : defaultPath(ctx, fmt === "jpeg" ? "jpg" : "png");
  makeParents(file);
  writeBytes(file, data);
  const shown = target || file;
  let text = `✓ Screenshot saved to ${shown}`;
  const result: Record<string, unknown> = { path: shown };
  if (rows !== null) {
    result["annotations"] = rows;
    const legend = rows.map((row) => `   [${row.number}] @${row.ref} ${row.role}` + (row.name ? ` "${row.name}"` : ""));
    text = [text, ...legend].join("\n");
  }
  return new Result(result, text, rows !== null);
}

type Framed = {
  selector: string | null;
  full: boolean;
  fmt: string;
  quality: number | null;
  target: string | null;
  scale: number;
  region: Region | null;
  marks: boolean;
  annotate: boolean;
  ifChanged: boolean;
  threshold: unknown;
};

async function framedScreenshot(ctx: Ctx, want: Framed): Promise<Result> {
  if (want.full && want.selector !== null) throw new Usage("screenshot --full captures the whole page, so it doesn't go with a selector");
  let page = await ctx.state.page();
  let layout = await layoutOf(page);
  let area: Region;
  if (want.selector !== null) {
    let element: Element;
    [page, element] = await ctx.state.locate(want.selector);
    await page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: element.backendId });
    layout = await layoutOf(page);
    const box = await rect(page, element);
    const [ox, oy] = await frameOffset(page, element.frame);
    area = { x: num(box["x"]) + ox, y: num(box["y"]) + oy, width: Math.max(1, num(box["width"])), height: Math.max(1, num(box["height"])) };
  } else if (want.full) {
    area = { x: -layout.scrollX, y: -layout.scrollY, width: layout.content.width, height: layout.content.height };
  } else area = want.region ?? { x: 0, y: 0, width: layout.viewport.width, height: layout.viewport.height };
  const scaleForClip = clipScale(want.scale, layout.dpr);
  const clip: Clip = { x: pyFloat(area.x + layout.scrollX), y: pyFloat(area.y + layout.scrollY), width: area.width, height: area.height, scale: scaleForClip };
  let rows: Annotation[] | null = null;
  if (want.marks || want.annotate) [rows] = await annotations(ctx, page, want.full, want.full ? null : area);
  let data = want.full ? await capturePng(page, true, null, want.fmt, want.quality, scaleForClip) : await capturePng(page, false, clip, want.fmt, want.quality, 1, want.region !== null || want.selector !== null);
  const frame: CoordinateFrame = frameOf(layout.viewport, area, imageSize(data), layout.dpr);
  let marked: Mark[] | null = null;
  if (rows !== null) {
    data = drawAnnotations(data, rows, { clientWidth: area.width }, [-area.x, -area.y]);
    if (want.marks) marked = rows.map((row) => markOf(row, frame));
  }
  const shots = captureOf(ctx.state).lastShots;
  const view = viewKey(page, want.selector, want.full, want.fmt, want.marks || want.annotate, [want.scale, want.region]);
  const before = shots.get(view);
  shots.set(view, data);
  if (want.ifChanged && before !== undefined && unchanged(before, data, want.fmt, thresholdOf(want.threshold as never))) {
    flag("screenshot_unchanged", true);
    return new Result({ path: null, unchanged: true }, "= Unchanged since the last screenshot of this view, so nothing was saved");
  }
  const file = want.target ? ctx.path(want.target) : defaultPath(ctx, want.fmt === "jpeg" ? "jpg" : "png");
  makeParents(file);
  writeBytes(file, data);
  const shown = want.target || file;
  const wholeViewport = want.selector === null && !want.full && want.region === null;
  const result: Record<string, unknown> = {
    path: shown,
    viewport: frame.viewport,
    image: frame.image,
    scale: new Float(frame.scale),
    dpr: new Float(frame.dpr),
    region: frame.region,
  };
  const lines = [`✓ Screenshot saved to ${shown}`, ...frameLines(frame, wholeViewport)];
  if (marked !== null) {
    result["marks"] = marked;
    lines.push(...marksText(marked));
  } else if (rows !== null) {
    result["annotations"] = rows;
    lines.push(...rows.map((row) => `   [${row.number}] @${row.ref} ${row.role}` + (row.name ? ` "${row.name}"` : "")));
  }
  return new Result(result, lines.join("\n"), rows !== null);
}

export async function cmdPdf(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--landscape": "bool", "--format": "value" });
  if (args.length === 0) throw new BrowseError("Usage: ardia browse pdf <path>");
  const page = await ctx.state.page();
  const result = await page.send("Page.printToPDF", { printBackground: true, landscape: Boolean(options["landscape"]) }, { timeout: 120 });
  const file = ctx.path(args[0] as string);
  makeParents(file);
  writeBytes(file, Buffer.from(String(result["data"] ?? ""), "base64"));
  return new Result({ path: args[0] }, `✓ PDF saved to ${args[0]}`);
}

export function comparison(before: Uint8Array, after: Uint8Array, threshold: number, output: string | null): Record<string, unknown> {
  const { result, diff } = comparePngs(before, after, threshold);
  const shaped: Record<string, unknown> = { ...result };
  if (result.diffPercent !== undefined) shaped["diffPercent"] = new Float(result.diffPercent);
  if (output && diff !== null) {
    writeBytes(output, encodePng(diff));
    shaped["diffPath"] = output;
  }
  return shaped;
}

export function comparisonText(result: Comparison | Record<string, unknown>): string {
  const shaped = result as Record<string, unknown>;
  if (shaped["reason"]) return `✗ Screenshots differ: ${String(shaped["reason"])}`;
  if (shaped["match"]) return "✓ Screenshots match";
  const percent = shaped["diffPercent"];
  const shownPercent = percent instanceof Float ? floatRepr(percent.value) : String(percent);
  return `✗ ${String(shaped["diffPixels"])} of ${String(shaped["totalPixels"])} pixels differ (${shownPercent}%)\n  diff image: ${String(shaped["diffPath"])}`;
}

export async function diffScreenshot(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options] = parse(
    argv,
    { "--baseline": "value", "--output": "value", "--threshold": "value", "--selector": "value", "--full": "bool" },
    { "-b": "--baseline", "-o": "--output", "-t": "--threshold", "-s": "--selector" },
  );
  if (!options["baseline"]) throw new BrowseError("Usage: ardia browse diff screenshot --baseline <file> [--output <file>] [--threshold 0.1]");
  const baselineFile = ctx.path(options["baseline"] as string);
  let baseline: Uint8Array;
  try {
    baseline = fs.readFileSync(baselineFile);
  } catch (error) {
    throw osError(error, baselineFile);
  }
  let page = await ctx.state.page();
  let clip: Clip | null = null;
  if (options["selector"]) {
    let element: Element;
    [page, element] = await ctx.state.locate(options["selector"] as string);
    const box = await rect(page, element);
    const vp = await viewportOf(page);
    clip = { x: num(box["x"]) + num(vp["scrollX"]), y: num(box["y"]) + num(vp["scrollY"]), width: num(box["width"]), height: num(box["height"]), scale: 1 };
  }
  const current = await capturePng(page, Boolean(options["full"]), clip);
  const output = options["output"] ? ctx.path(options["output"] as string) : defaultPath(ctx, "png").replaceAll("screenshot-", "diff-");
  const result = comparison(baseline, current, options["threshold"] ? pyFloatArg(options["threshold"] as string) : 0.1, output);
  return new Result(result, comparisonText(result));
}

export async function cmdHighlight(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  need(args, 1, "highlight <selector>");
  const [page, element] = await resolve(ctx, args[0] as string);
  try {
    await page.send("DOM.enable");
    await page.send("Overlay.enable");
    await page.send("Overlay.highlightNode", {
      backendNodeId: element.backendId,
      highlightConfig: { contentColor: { r: 111, g: 168, b: 220, a: 0.66 }, borderColor: { r: 255, g: 0, b: 0, a: 1 }, showInfo: true },
    });
  } catch (error) {
    if (error instanceof Gated) throw error.during("highlight");
    throw error;
  }
  return new Result({ highlighted: args[0] });
}

register("screenshot", cmdScreenshot);
register("pdf", cmdPdf);
register("highlight", cmdHighlight);
