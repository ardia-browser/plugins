import fs from "node:fs";
import path from "node:path";
import { dumps } from "../../json.ts";
import { shield, sleep } from "../cdp/cancel.ts";
import type { Ctx } from "../commands/ctx.ts";
import { waitForLoad } from "../commands/core.ts";
import { register } from "../commands/index.ts";
import { parse } from "../commands/parse.ts";
import { BrowseError, Usage } from "../daemon-errors.ts";
import { pyValue, Result } from "../daemon/render.ts";
import { defaultPath } from "../media/paths.ts";
import { flag } from "../metrics.ts";
import type { Page } from "../state/page.ts";
import type { Listener } from "../state/state.ts";
import { record } from "../state/records.ts";
import { parseTimeout } from "../script/timeout.ts";
import { refuseOnBorrowed } from "../commands/borrowed.ts";
import { subcommandFlagProblem } from "../subcommand-flags.ts";
import { devtoolsCall } from "./devtools.ts";
import { appTabFor, askArdia, askArdiaAboutTab, freshAppTab } from "./inspect.ts";
import { activate, captureOf, releaseClaim, removeListener } from "./store.ts";
import { DEFAULT_CATEGORIES, TRACE_EVENT_LIMIT, traceConfig } from "./trace.ts";

export const PERF_TRACE_METHOD = "devtools.perfTrace";
export const PERF_INSIGHT_METHOD = "devtools.perfInsight";
export const MIN_TRACE_MS = 250;
export const MAX_TRACE_MS = 30_000;
export const PERF_CATEGORIES = [...DEFAULT_CATEGORIES, "loading", "rail", "devtools.timeline.frame", "disabled-by-default-devtools.timeline.invalidationTracking"];
export const DEFAULT_TRACE_SECONDS = 5;
export const AFTER_LOAD_SECONDS = 3;
export const LONG_TASK_MS = 50;
export const CRUX_ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";
export const CRUX_KEY_ENV = "ARDIA_CRUX_API_KEY";
const TRACE_END_WAIT = 60;
const CRUX_TIMEOUT_MS = 10_000;

type TraceEvent = { name?: string; cat?: string; ph?: string; ts?: number; dur?: number; pid?: number; tid?: number; args?: Record<string, unknown> };

export type Metric = { name: string; value: number; unit: "ms" | ""; rating: "good" | "needs improvement" | "poor" };
export type Insights = {
  metrics: Metric[];
  longTasks: { count: number; longestMs: number; totalBlockingMs: number; top: { startMs: number; durationMs: number }[] };
  mainThread: Record<string, number>;
  renderBlocking: string[];
  events: number;
};

const THRESHOLDS: Readonly<Record<string, [number, number]>> = {
  LCP: [2500, 4000],
  FCP: [1800, 3000],
  CLS: [0.1, 0.25],
  TBT: [200, 600],
  INP: [200, 500],
};

export function rate(name: string, value: number): Metric["rating"] {
  const [good, poor] = THRESHOLDS[name] ?? [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  return value <= good ? "good" : value <= poor ? "needs improvement" : "poor";
}

function metric(name: string, value: number, unit: Metric["unit"]): Metric {
  return { name, value: unit === "ms" ? Math.round(value) : Math.round(value * 1000) / 1000, unit, rating: rate(name, value) };
}

function mainRenderer(events: readonly TraceEvent[]): { pid: number; tid: number } | null {
  const threads: { pid: number; tid: number }[] = [];
  for (const event of events) {
    if (event.ph === "M" && event.name === "thread_name" && record(event.args)["name"] === "CrRendererMain" && typeof event.pid === "number" && typeof event.tid === "number") {
      threads.push({ pid: event.pid, tid: event.tid });
    }
  }
  if (threads.length === 0) return null;
  const started = events.find((event) => event.name === "TracingStartedInBrowser");
  const frames = record(record(started?.args)["data"])["frames"];
  for (const raw of Array.isArray(frames) ? frames : []) {
    const frame = record(raw);
    if ((frame["isOutermostMainFrame"] === true || frame["parent"] === undefined) && typeof frame["processId"] === "number") {
      const found = threads.find((thread) => thread.pid === frame["processId"]);
      if (found !== undefined) return found;
    }
  }
  let best = threads[0] as { pid: number; tid: number };
  let busiest = -1;
  for (const thread of threads) {
    const busy = events.reduce((sum, event) => (event.pid === thread.pid && event.tid === thread.tid && event.name === "RunTask" ? sum + (event.dur ?? 0) : sum), 0);
    if (busy > busiest) {
      busiest = busy;
      best = thread;
    }
  }
  return best;
}

const PHASES: Readonly<Record<string, string>> = {
  EvaluateScript: "scripting",
  FunctionCall: "scripting",
  "v8.compile": "scripting",
  "v8.compileModule": "scripting",
  TimerFire: "scripting",
  EventDispatch: "scripting",
  RunMicrotasks: "scripting",
  ParseHTML: "loading",
  ParseAuthorStyleSheet: "loading",
  Layout: "rendering",
  UpdateLayoutTree: "rendering",
  RecalculateStyles: "rendering",
  PrePaint: "rendering",
  Paint: "painting",
  CompositeLayers: "painting",
  RasterTask: "painting",
};

export const CLS_GAP_US = 1_000_000;
export const CLS_WINDOW_US = 5_000_000;

type Shift = { ts: number; score: number };

export function earliest(events: readonly TraceEvent[]): number {
  let found = Number.POSITIVE_INFINITY;
  for (const event of events) if (typeof event.ts === "number" && event.ts > 0 && event.ts < found) found = event.ts;
  return Number.isFinite(found) ? found : 0;
}

export function sessionWindowCls(shifts: readonly Shift[]): number {
  const ordered = [...shifts].sort((a, b) => a.ts - b.ts);
  let best = 0;
  let total = 0;
  let start = Number.NEGATIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const shift of ordered) {
    if (shift.ts - last > CLS_GAP_US || shift.ts - start > CLS_WINDOW_US) {
      total = 0;
      start = shift.ts;
    }
    total += shift.score;
    last = shift.ts;
    if (total > best) best = total;
  }
  return best;
}

function frameOf(event: TraceEvent | undefined): string | undefined {
  const args = record(event?.args);
  const frame = args["frame"] ?? record(args["data"])["frame"];
  return typeof frame === "string" ? frame : undefined;
}

function navigationIdOf(event: TraceEvent | undefined): string | undefined {
  const id = record(record(event?.args)["data"])["navigationId"];
  return typeof id === "string" ? id : undefined;
}

function mainFrameIds(events: readonly TraceEvent[]): Set<string> {
  const ids = new Set<string>();
  const started = events.find((event) => event.name === "TracingStartedInBrowser");
  const frames = record(record(started?.args)["data"])["frames"];
  for (const raw of Array.isArray(frames) ? frames : []) {
    const frame = record(raw);
    if ((frame["isOutermostMainFrame"] === true || frame["parent"] === undefined) && typeof frame["frame"] === "string") ids.add(frame["frame"]);
  }
  return ids;
}

export function mainNavigation(events: readonly TraceEvent[], onMain: (event: TraceEvent) => boolean = () => true): TraceEvent | undefined {
  const mains = mainFrameIds(events);
  const starts = events.filter((event) => event.name === "navigationStart" && onMain(event));
  const outermost = starts.filter((event) => {
    const data = record(record(event.args)["data"]);
    if (data["isOutermostMainFrame"] === true || data["isLoadingMainFrame"] === true) return true;
    const frame = frameOf(event);
    return frame !== undefined && mains.has(frame);
  });
  const pool = outermost.length > 0 ? outermost : starts;
  return [...pool].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))[0];
}

export function paintOfNavigation(event: TraceEvent, start: TraceEvent | undefined): boolean {
  if (start === undefined) return true;
  const frame = frameOf(start);
  if (frame !== undefined && frameOf(event) !== undefined && frameOf(event) !== frame) return false;
  const id = navigationIdOf(start);
  const own = navigationIdOf(event);
  return id === undefined || own === undefined || own === id;
}

export function analyze(events: readonly TraceEvent[]): Insights {
  const main = mainRenderer(events);
  const onMain = (event: TraceEvent) => main === null || (event.pid === main.pid && event.tid === main.tid);
  const start = mainNavigation(events, onMain);
  const navigation = start?.ts;
  const origin = navigation ?? earliest(events);
  const since = (ts: number | undefined) => ((ts ?? origin) - origin) / 1000;
  const metrics: Metric[] = [];
  const ofPage = (event: TraceEvent) => (navigation === undefined || (event.ts ?? 0) >= navigation) && paintOfNavigation(event, start);
  const fcp = events.find((event) => event.name === "firstContentfulPaint" && ofPage(event));
  if (navigation !== undefined && fcp !== undefined) metrics.push(metric("FCP", since(fcp.ts), "ms"));
  const lcps = events.filter((event) => event.name === "largestContentfulPaint::Candidate" && ofPage(event));
  const lcp = lcps[lcps.length - 1];
  if (navigation !== undefined && lcp !== undefined) metrics.push(metric("LCP", since(lcp.ts), "ms"));
  const shifts: Shift[] = [];
  for (const event of events) {
    if (event.name !== "LayoutShift" || typeof event.ts !== "number") continue;
    const data = record(record(event.args)["data"]);
    if (data["had_recent_input"] === true) continue;
    const score = Number(data["weighted_score_delta"] ?? data["score"] ?? 0);
    if (Number.isFinite(score)) shifts.push({ ts: event.ts, score });
  }
  if (shifts.length > 0 || navigation !== undefined) metrics.push(metric("CLS", sessionWindowCls(shifts), ""));
  const tasks = events.filter((event) => event.name === "RunTask" && event.ph === "X" && onMain(event) && (event.dur ?? 0) / 1000 > LONG_TASK_MS);
  const fcpTs = fcp?.ts ?? origin;
  const blocking = tasks.filter((task) => (task.ts ?? 0) >= fcpTs).reduce((sum, task) => sum + ((task.dur ?? 0) / 1000 - LONG_TASK_MS), 0);
  metrics.push(metric("TBT", blocking, "ms"));
  const top = [...tasks].sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0)).slice(0, 5).map((task) => ({ startMs: Math.round(since(task.ts)), durationMs: Math.round((task.dur ?? 0) / 1000) }));
  const mainThread: Record<string, number> = {};
  for (const event of events) {
    const phase = event.name === undefined ? undefined : PHASES[event.name];
    if (phase === undefined || event.ph !== "X" || !onMain(event)) continue;
    mainThread[phase] = (mainThread[phase] ?? 0) + (event.dur ?? 0) / 1000;
  }
  for (const key of Object.keys(mainThread)) mainThread[key] = Math.round(mainThread[key] as number);
  const renderBlocking = [
    ...new Set(
      events
        .filter((event) => event.name === "ResourceSendRequest")
        .map((event) => record(record(event.args)["data"]))
        .filter((data) => data["renderBlocking"] === "blocking" || data["renderBlocking"] === "in_body_parser_blocking")
        .map((data) => String(data["url"] ?? ""))
        .filter(Boolean),
    ),
  ];
  return {
    metrics,
    longTasks: { count: tasks.length, longestMs: top[0]?.durationMs ?? 0, totalBlockingMs: Math.round(blocking), top },
    mainThread,
    renderBlocking,
    events: events.length,
  };
}

function metricText(item: Metric): string {
  const value = item.unit === "ms" ? `${item.value.toLocaleString("en-US")} ms` : String(item.value);
  return `${item.name} ${value} (${item.rating})`;
}

export function insightLines(insights: Insights): string[] {
  const lines: string[] = [];
  if (insights.metrics.length > 0) lines.push(insights.metrics.map(metricText).join("  "));
  const tasks = insights.longTasks;
  if (tasks.count > 0) {
    const where = tasks.top.map((task) => `${task.durationMs} ms at ${(task.startMs / 1000).toFixed(1)} s`).join(", ");
    lines.push(`long tasks: ${tasks.count} over ${LONG_TASK_MS} ms (${where})`);
  } else lines.push(`long tasks: none over ${LONG_TASK_MS} ms`);
  const phases = Object.entries(insights.mainThread).sort((a, b) => b[1] - a[1]);
  if (phases.length > 0) lines.push(`main thread: ${phases.map(([phase, ms]) => `${phase} ${ms.toLocaleString("en-US")} ms`).join(", ")}`);
  if (insights.renderBlocking.length > 0) {
    const shown = insights.renderBlocking.slice(0, 5);
    const more = insights.renderBlocking.length - shown.length;
    lines.push(`render-blocking: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`);
  }
  return lines;
}

export async function recordTrace(ctx: Ctx, page: Page, reload: boolean, seconds: number): Promise<TraceEvent[]> {
  const capture = captureOf(ctx.state);
  if (capture.tracing !== null) throw new BrowseError("A trace is already recording (`trace start`); stop it first with `ardia browse trace stop`", null, "session_busy");
  const events: TraceEvent[] = [];
  let finish = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const listener: Listener = (eventPage, method, params) => {
    if (eventPage === null || eventPage.targetId !== page.targetId) return;
    if (method === "Tracing.dataCollected") {
      const value = params["value"];
      for (const event of Array.isArray(value) ? value : []) if (events.length < TRACE_EVENT_LIMIT) events.push(event as TraceEvent);
    } else if (method === "Tracing.tracingComplete") finish();
  };
  ctx.state.listeners.push(listener);
  let started = false;
  try {
    try {
      await activate(ctx, page, "trace", () => {
        started = true;
        return devtoolsCall(page, "perf", "Tracing.start", { traceConfig: traceConfig(PERF_CATEGORIES), transferMode: "ReportEvents" });
      });
      if (reload) {
        await devtoolsCall(page, "perf", "Page.reload", { ignoreCache: false });
        await waitForLoad(page, null, Math.max(seconds, 30)).catch(() => {});
        await sleep(Math.min(seconds, AFTER_LOAD_SECONDS));
      } else await sleep(seconds);
    } finally {
      if (started) {
        await shield(() => page.send("Tracing.end")).catch(() => finish());
        await shield(() => Promise.race([done, sleep(TRACE_END_WAIT)]));
      }
    }
  } finally {
    removeListener(ctx.state, listener);
    releaseClaim(ctx, page.targetId, "trace");
  }
  return events;
}

const FIELD_METRICS: [string, string, string][] = [
  ["largest_contentful_paint", "LCP", "ms"],
  ["interaction_to_next_paint", "INP", "ms"],
  ["cumulative_layout_shift", "CLS", ""],
  ["first_contentful_paint", "FCP", "ms"],
  ["experimental_time_to_first_byte", "TTFB", "ms"],
];

function share(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "?";
}

export function ardiaFieldLines(field: Record<string, unknown>): string[] {
  if (field["found"] === false) return ["field data: none for this origin"];
  const metrics = record(field["metrics"]);
  const parts: string[] = [];
  for (const [key, label, unit] of FIELD_METRICS) {
    const item = record(metrics[key]);
    const p75 = typeof item["p75"] === "string" ? Number(item["p75"]) : item["p75"];
    if (typeof p75 !== "number" || !Number.isFinite(p75)) continue;
    const shown = unit === "ms" ? `${Math.round(p75).toLocaleString("en-US")} ms` : String(p75);
    parts.push(`${label} p75 ${shown} (${rate(label, p75)}; ${share(item["good"])} good, ${share(item["poor"])} poor)`);
  }
  return parts.length > 0 ? [`field data (28 days, real users): ${parts.join("  ")}`] : ["field data: none for this origin"];
}

export function cruxLines(answer: Record<string, unknown>): string[] {
  const metrics = record(record(answer["record"])["metrics"]);
  const names: [string, string, string][] = [
    ["largest_contentful_paint", "LCP", "ms"],
    ["interaction_to_next_paint", "INP", "ms"],
    ["cumulative_layout_shift", "CLS", ""],
    ["first_contentful_paint", "FCP", "ms"],
  ];
  const parts: string[] = [];
  for (const [key, label, unit] of names) {
    const p75 = record(record(metrics[key])["percentiles"])["p75"];
    if (p75 === undefined || p75 === null) continue;
    const value = Number(p75);
    if (!Number.isFinite(value)) continue;
    parts.push(`${label} p75 ${unit === "ms" ? `${Math.round(value).toLocaleString("en-US")} ms` : value} (${rate(label, value)})`);
  }
  return parts.length > 0 ? [`field data (28 days, real users): ${parts.join("  ")}`] : ["field data: none for this origin"];
}

async function cruxField(origin: string, key: string): Promise<string[]> {
  try {
    const answer = await fetch(`${CRUX_ENDPOINT}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin }),
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(CRUX_TIMEOUT_MS),
    });
    if (answer.status === 404) return ["field data: none for this origin"];
    if (!answer.ok) return [`field data: the report service answered ${answer.status}`];
    return cruxLines(record(await answer.json()));
  } catch (error) {
    return [`field data: couldn't reach the report service (${error instanceof Error ? error.message : String(error)})`];
  }
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function metricValue(raw: unknown): { value: number; rating?: string } | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return { value: raw };
  const item = record(raw);
  const value = item["value"] ?? item["ms"] ?? item["score"];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return typeof item["rating"] === "string" ? { value, rating: item["rating"] } : { value };
}

export function ardiaPerfLines(answer: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const metrics = record(answer["metrics"]);
  const parts: string[] = [];
  for (const [key, label] of [["fcp", "FCP"], ["lcp", "LCP"], ["ttfb", "TTFB"], ["tbt", "TBT"], ["inp", "INP"], ["cls", "CLS"]] as const) {
    const found = metricValue(metrics[key]);
    if (found === null) continue;
    const shown = label === "CLS" ? String(Math.round(found.value * 1000) / 1000) : `${Math.round(found.value).toLocaleString("en-US")} ms`;
    parts.push(`${label} ${shown} (${found.rating ?? rate(label, found.value)})`);
  }
  if (parts.length > 0) lines.push(parts.join("  "));
  for (const raw of Array.isArray(answer["insights"]) ? answer["insights"] : []) {
    const item = record(raw);
    const title = typeof item["title"] === "string" ? item["title"] : typeof item["id"] === "string" ? item["id"] : "";
    if (!title) continue;
    const rating = typeof item["rating"] === "string" ? `[${item["rating"] as string}] ` : "";
    const summary = typeof item["summary"] === "string" && item["summary"] ? `: ${item["summary"] as string}` : "";
    const savings = typeof item["savingsMs"] === "number" && item["savingsMs"] > 0 ? ` (could save ${Math.round(item["savingsMs"] as number)} ms)` : "";
    lines.push(`${rating}${title}${summary}${savings}`);
  }
  const field = answer["fieldData"];
  if (field !== null && field !== undefined) {
    const data = record(field);
    if (typeof data["skipped"] === "string") lines.push(`field data: skipped: ${data["skipped"] as string}`);
    else lines.push(...ardiaFieldLines(data));
  }
  if (typeof answer["rating"] === "string") lines.push(`overall: ${answer["rating"] as string}`);
  return lines;
}

function traceFile(ctx: Ctx, given: unknown): string {
  if (typeof given === "string" && given !== "") return ctx.path(given);
  return path.join(path.dirname(defaultPath(ctx, "png")), `perf-${Math.floor(Date.now() / 1000)}.json`);
}

function traceMs(seconds: number): number {
  return Math.min(MAX_TRACE_MS, Math.max(MIN_TRACE_MS, Math.round(seconds * 1000)));
}

function readTraceFile(ctx: Ctx, given: string): TraceEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(ctx.path(given), "utf8"));
  } catch (error) {
    throw new Usage(`--trace takes a trace JSON file (a list of events or {traceEvents}): ${error instanceof Error ? error.message : String(error)}`);
  }
  const events = Array.isArray(parsed) ? parsed : record(parsed)["traceEvents"];
  if (!Array.isArray(events) || events.length === 0) throw new Usage(`${given} has no trace events`);
  return events as TraceEvent[];
}

function refuseUnownedReload(ctx: Ctx, page: Page): void {
  if (ctx.state.created.has(page.targetId)) return;
  const tab = ctx.state.tabId(page.targetId);
  throw new BrowseError(
    `perf --reload reloads only a tab this session opened, and [${tab}] isn't one. Open the page in a tab of your own with \`ardia browse open <url>\`, or trace without --reload`,
    { tabId: tab },
    "not_own_tab",
  );
}

export const CRUX_KEY = /^[A-Za-z0-9_-]{10,200}$/u;

export const EXPLICIT_ENDPOINT_SKIP = "this session talks to a DevTools endpoint named with --port or --ws, where nothing can confirm the tab isn't in a private window";

export function explicitEndpoint(ctx: Ctx): boolean {
  return ctx.state.endpoint === null || ctx.state.endpoint.explicit !== false;
}

export function hasNavigation(events: readonly TraceEvent[]): boolean {
  return events.some((event) => event.name === "navigationStart");
}

export const NO_LOAD_SKIP = "the trace has no page load to tie field data to; add --reload";

export function earlyFieldSkip(ctx: Ctx, reload: boolean): string | null {
  if (explicitEndpoint(ctx)) return EXPLICIT_ENDPOINT_SKIP;
  if (!reload) return NO_LOAD_SKIP;
  return null;
}

export function cruxKey(ctx: Ctx): string {
  const key = ctx.env[CRUX_KEY_ENV];
  if (typeof key !== "string" || !CRUX_KEY.test(key)) throw new Usage(`--crux needs a Chrome UX Report API key (letters, digits, - and _) in ${CRUX_KEY_ENV}`);
  return key;
}

export type FieldDecision = { origin: string } | { skipped: string };

export const NAVIGATED_SKIP = "the page changed origin during the trace, so field data wouldn't match it";

export async function fieldDataDecision(
  ctx: Ctx,
  page: Page,
  reload: boolean,
  before: string,
  events: readonly TraceEvent[],
  lookup: (ctx: Ctx, page: Page) => Promise<string | null> = freshAppTab,
): Promise<FieldDecision> {
  if (explicitEndpoint(ctx)) return { skipped: EXPLICIT_ENDPOINT_SKIP };
  if (!reload || !hasNavigation(events)) return { skipped: NO_LOAD_SKIP };
  const traced = originOf(before);
  if (traced === null) return { skipped: "only http and https pages have it" };
  if (originOf(page.url) !== traced) return { skipped: NAVIGATED_SKIP };
  if ((await lookup(ctx, page)) === null) return { skipped: "Ardia doesn't list this tab, so it can't confirm the tab isn't in a private window" };
  if (originOf(page.url) !== traced) return { skipped: NAVIGATED_SKIP };
  return { origin: traced };
}

export async function cmdPerf(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--reload": "bool", "--duration": "value", "--out": "value", "--crux": "bool", "--trace": "value" });
  const what = args[0];
  if ((what !== "trace" && what !== "insight") || args.length > 1) {
    throw new Usage("Usage: ardia browse perf trace [--duration 5s] [--reload] [--out file.json] | perf insight [--reload] [--duration 3s] [--crux] | perf insight --trace file.json");
  }
  const problem = subcommandFlagProblem("perf", what, argv);
  if (problem !== undefined) throw new Usage(problem);
  const crux = Boolean(options["crux"]);
  const reload = Boolean(options["reload"]);
  const given = typeof options["trace"] === "string" ? options["trace"] : null;
  if (given !== null && (crux || reload || options["duration"])) throw new Usage("perf insight --trace analyzes a saved trace: --reload, --duration and --crux go with a live one");
  if (given !== null) {
    const events = readTraceFile(ctx, given);
    const fromArdia = await askArdia(ctx, PERF_INSIGHT_METHOD, { trace: events }, 30);
    if (fromArdia !== null) return new Result({ source: "ardia", ...fromArdia }, ardiaPerfLines(fromArdia).join("\n") || "✓ Done");
    const insights = analyze(events);
    return new Result({ source: "cli", ...insights }, insightLines(insights).join("\n"));
  }
  if (crux) flag("perf_crux", true);
  const seconds = options["duration"] ? parseTimeout(options["duration"] as string) : what === "insight" && reload ? AFTER_LOAD_SECONDS : DEFAULT_TRACE_SECONDS;
  const page = await ctx.state.page();
  const early = crux ? earlyFieldSkip(ctx, reload) : null;
  const earlySkip = early === null ? null : { skipped: early };
  const askField = crux && early === null;
  if (reload) {
    refuseOnBorrowed(ctx, page, "reload");
    refuseUnownedReload(ctx, page);
  }
  if (what === "insight") {
    const params: Record<string, unknown> = { durationMs: traceMs(seconds), reload };
    if (askField && (await appTabFor(ctx, page)) !== null) Object.assign(params, { includeFieldData: true, fieldDataKey: cruxKey(ctx) });
    const fromArdia = await askArdiaAboutTab(ctx, page, PERF_TRACE_METHOD, params, seconds + (reload ? 30 : 0));
    if (fromArdia !== null) {
      const answer: Record<string, unknown> = earlySkip === null ? fromArdia : { ...fromArdia, fieldData: earlySkip };
      return new Result({ source: "ardia", ...answer }, ardiaPerfLines(answer).join("\n") || "✓ Done");
    }
  }
  const before = page.url;
  const events = await recordTrace(ctx, page, reload, seconds);
  if (events.length === 0) throw new BrowseError("The trace came back empty; try again with a longer --duration", null, "no_data");
  const insights = analyze(events);
  if (what === "trace") {
    const file = traceFile(ctx, options["out"]);
    fs.writeFileSync(file, dumps(new Map([["traceEvents", pyValue(events)]]), "compact", true), "utf8");
    const fromArdia = await askArdia(ctx, PERF_INSIGHT_METHOD, { trace: events }, 30);
    const lines = fromArdia === null ? insightLines(insights) : ardiaPerfLines(fromArdia);
    lines.unshift(`✓ Trace saved to ${typeof options["out"] === "string" ? options["out"] : file} (${events.length.toLocaleString("en-US")} events, ${seconds} s${reload ? " from a reload" : ""})`);
    return new Result({ source: fromArdia === null ? "cli" : "ardia", path: file, ...(fromArdia ?? insights) }, lines.join("\n"));
  }
  const lines = insightLines(insights);
  if (!reload && !insights.metrics.some((item) => item.name === "LCP")) lines.push("load metrics need a page load: add --reload");
  let fieldData: Record<string, unknown> | null = null;
  if (crux) {
    const decision = await fieldDataDecision(ctx, page, reload, before, events);
    if ("skipped" in decision) {
      fieldData = decision;
      lines.push(`field data: skipped: ${decision.skipped}`);
    } else {
      const found = await cruxField(decision.origin, cruxKey(ctx));
      fieldData = { origin: decision.origin, summary: found };
      lines.push(...found);
    }
  }
  return new Result({ source: "cli", ...insights, ...(fieldData === null ? {} : { fieldData }) }, lines.join("\n"));
}

register("perf", cmdPerf);
