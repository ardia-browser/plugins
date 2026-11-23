import { pyLen, pyStrip } from "../../pylib/str.ts";
import { redact } from "../../redact.ts";
import { Cancelled, currentSignal, later, shield, sleep, untilCancelled, withSignal } from "../cdp/cancel.ts";
import type { Ctx } from "../commands/ctx.ts";
import { parse } from "../commands/parse.ts";
import { BrowseError, CdpError, ConnectionLost, Gated, Usage } from "../daemon-errors.ts";
import { refusedRetry } from "../act/retry.ts";
import { raceDialog, ReceiptWatch, refuseIfDialog } from "./dialogs.ts";
import { REACTION_STATE, UNWATCH_REACTION, WATCH_REACTION, WATCH_REACTION_FOCUSED } from "./noise.ts";
import { budget, throttleOf } from "./throttle.ts";
import { Result } from "../daemon/render.ts";
import { CHANGES_TEXT_JS } from "../js/index.ts";
import { clock, count, flag, spent } from "../metrics.ts";
import { type Node, walk } from "../snapshot/tree.ts";
import { Element, type Page } from "../state/page.ts";
import type { Json } from "../state/records.ts";
import { Refs } from "../state/refs.ts";
import type { Listener, State } from "../state/state.ts";
import { monotonic } from "../state/wait.ts";
import { tokenHex } from "../tokens.ts";
import { backendsOf } from "../snapshot/collect.ts";
import { capture, readableType, type WatchLike } from "../flows/flowlog.ts";
import { hint } from "../flows/flows.ts";
import { noteHeader } from "../../notes-files.ts";
import { pageSite } from "../../notes.ts";
import { background, knownCollector } from "./background.ts";
import { cleanUrl } from "./urls.ts";
import { diff, freshRows, moved, NAVIGATED_TEXT, OPENED_TEXT, type Report, type TextBlock, type View, type Write } from "./report.ts";
import { addsText, asData, openedAnchors, renderReport } from "./text.ts";
import { markShown, remember, view, viewFrame } from "./views.ts";

async function collect(state: State, page: Page): Promise<Node[]> {
  const snapshots = Refs.snapshots;
  if (snapshots === null) throw new Error("the snapshot collector isn't registered");
  return (await snapshots.collect(state, page)) as Node[];
}

function adoptRefs(state: State, page: Page, nodes: Node[]): void {
  const snapshots = Refs.snapshots;
  if (snapshots !== null) state.setRefs(snapshots.refsOf(state, page, nodes), null, page);
}

export const SETTLE_LIMIT = 1.5;
export const REACTION_WINDOW = 0.6;
export const REACTION_QUIET = 0.15;
export const REACTION_LIMIT = 1.5;
export const REACTION_CALL_TIMEOUT = 1.0;
export const FIRST_QUIET = 0.05;
export const QUIET = 0.12;
export const POLL = 0.025;
export const STOP_TIMEOUT = 2.0;
export const STALE_REQUEST = 1.5;
export const SWEPT_TYPES = new Set(["XHR", "Fetch", "Ping", "Other", "Preflight", "CSPViolationReport", "Manifest", "Prefetch"]);
export const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const LONG_LIVED = new Set(["EventSource", "WebSocket"]);
export const BODY_TYPES = new Set(["XHR", "Fetch", "Document"]);
export const WATCH_BUFFER = 1024 * 1024;
export const MAX_TEXT_MARKS = 200;
export const MIN_FRAME_TEXT = 200;
const MARKER = /\x01([0-9]+)\x01/gu;

export type ObserveHooks = {
  arrivalNotes: (state: State, before: View | null, after: View) => string | null;
  capture: (page: Page, watch: WatchLike) => Promise<void>;
};

export function siteNotes(state: State, before: View | null, after: View): string | null {
  const root = state.dataRoot;
  if (!root || (before !== null && pageSite(before.url) === pageSite(after.url))) return null;
  const lines = [noteHeader(root, after.url)[1], hint(state, after.url)];
  return lines.filter((line) => line).join("\n") || null;
}

export const observeHooks: ObserveHooks = {
  arrivalNotes: (state, before, after) => siteNotes(state, before, after),
  capture: (page, watch) => capture(page, watch),
};

export class TimedOut extends Error {}

export function within<T>(work: Promise<T>, seconds: number): Promise<T> {
  let stop = () => {};
  const timer = new Promise<never>((_, reject) => {
    stop = later(seconds * 1000, () => reject(new TimedOut()));
  });
  return untilCancelled(Promise.race([work, timer])).finally(stop);
}

type RequestRecord = {
  method: string;
  url: string;
  raw: string;
  headers: unknown;
  type: string;
  statuses: unknown[];
  done: boolean;
  answered?: boolean;
  mime?: string;
  failed?: string;
  background: boolean;
  listed: boolean;
  wrote?: { method: string; url: string };
  started: number;
  frame: string | null;
};

function dict(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

export class NetworkWatch {
  enabledHere = false;
  watching = false;
  readonly records = new Map<string, RequestRecord>();
  readonly order: string[] = [];
  lastEvent = 0;
  counting = false;
  ignored = 0;
  readonly earlier = new Set<string>();
  navigationError: string | null = null;
  readonly limit: number;
  readonly stale: number;
  readonly listener: Listener = (eventPage, method, params) => this.onEvent(eventPage, method, params);

  constructor(readonly page: Page) {
    this.limit = budget(page, SETTLE_LIMIT);
    this.stale = (this.limit / SETTLE_LIMIT) * STALE_REQUEST;
  }

  private touch(entry: RequestRecord): void {
    if (LONG_LIVED.has(entry.type)) {
      flag("settle_ignored_streams", true);
      return;
    }
    if (!entry.background) this.lastEvent = monotonic();
  }

  swept(entry: RequestRecord, now: number): boolean {
    return SWEPT_TYPES.has(entry.type) && READ_METHODS.has(entry.method) && now - entry.started >= this.stale;
  }

  private onEvent(eventPage: Page | null, method: string, params: Json): void {
    if (eventPage !== this.page || !method.startsWith("Network.")) return;
    const requestId = params["requestId"];
    if (typeof requestId !== "string" || !requestId) return;
    if (!this.counting || this.earlier.has(requestId)) {
      this.earlier.add(requestId);
      flag("earlier_requests_ignored", true);
      return;
    }
    if (method === "Network.requestWillBeSent") {
      let entry = this.records.get(requestId);
      const request = dict(params["request"]);
      if (entry === undefined && params["redirectResponse"]) {
        this.earlier.add(requestId);
        flag("earlier_requests_ignored", true);
        return;
      }
      if (entry !== undefined && params["redirectResponse"]) {
        const wasBackground = entry.background;
        const hop = String(request["url"] || "");
        const hopMethod = String(request["method"] || entry.method);
        entry.background = background(String(params["type"] || entry.type), hop, hopMethod, this.page.url);
        if (!entry.listed && !READ_METHODS.has(hopMethod.toUpperCase()) && !knownCollector(hop, hopMethod, this.page.url)) {
          entry.listed = true;
          entry.wrote = { method: hopMethod.toUpperCase(), url: cleanUrl(hop) };
        }
        if (wasBackground && !entry.background) this.ignored -= 1;
        else if (!wasBackground && entry.background) this.ignored += 1;
      }
      if (entry === undefined) {
        const raw = String(request["url"] || "");
        const type = String(params["type"] || "Other");
        entry = {
          method: String(request["method"] || "GET").toUpperCase(),
          url: cleanUrl(raw),
          raw,
          headers: request["headers"] || {},
          type,
          statuses: [],
          done: false,
          background: background(type, raw, String(request["method"] || "GET"), this.page.url),
          listed: !READ_METHODS.has(String(request["method"] || "GET").toUpperCase()) && !knownCollector(raw, String(request["method"] || "GET"), this.page.url),
          started: monotonic(),
          frame: typeof params["frameId"] === "string" ? params["frameId"] : null,
        };
        this.records.set(requestId, entry);
        this.order.push(requestId);
        if (entry.background) this.ignored += 1;
      }
      this.touch(entry);
      const redirect = dict(params["redirectResponse"]);
      if (params["redirectResponse"] && redirect["status"] !== undefined && redirect["status"] !== null) entry.statuses.push(redirect["status"]);
    } else {
      const entry = this.records.get(requestId);
      if (entry === undefined) return;
      this.touch(entry);
      if (method === "Network.responseReceived") {
        const response = dict(params["response"]);
        if (response["status"] !== undefined && response["status"] !== null) entry.statuses.push(response["status"]);
        entry.mime = String(response["mimeType"] || "");
        entry.answered = true;
      } else if (method === "Network.loadingFinished") entry.done = true;
      else if (method === "Network.loadingFailed") {
        entry.done = true;
        entry.failed = params["canceled"] ? "canceled" : [...String(params["errorText"] || "failed")].slice(0, 200).join("");
        const navigationFailed = entry.type === "Document" && !params["canceled"] && (entry.frame === null || entry.frame === this.page.mainFrame);
        if (navigationFailed && netError(entry.failed)) {
          this.navigationError = entry.failed;
          flag("navigation_net_error", true);
        }
      }
    }
  }

  async start(): Promise<void> {
    this.page.state.listeners.push(this.listener);
    this.watching = true;
    this.lastEvent = monotonic();
    if (this.page.networkOn || this.page.networkWatched) {
      this.counting = true;
      return;
    }
    this.enabledHere = true;
    try {
      const session = this.page.session;
      await this.page.send("Network.enable", { maxTotalBufferSize: WATCH_BUFFER, maxResourceBufferSize: WATCH_BUFFER });
      this.counting = true;
      if (typeof session === "string" && session === this.page.session) {
        this.page.networkWatched = true;
        this.enabledHere = false;
      }
    } catch (error) {
      if (error instanceof CdpError || error instanceof Gated) this.enabledHere = false;
      await this.stop();
      if (error instanceof BrowseError && !(error instanceof ConnectionLost)) return;
      throw error;
    }
  }

  busy(): boolean {
    const now = monotonic();
    let swept = false;
    const busy = [...this.records.values()].some((entry) => {
      if (entry.done || entry.answered || entry.background || LONG_LIVED.has(entry.type)) return false;
      if (this.swept(entry, now)) {
        swept = true;
        return false;
      }
      return true;
    });
    if (swept && !busy) flag("settle_swept_stale_requests", true);
    return busy;
  }

  foreground(): boolean {
    return [...this.records.values()].some((entry) => !entry.background);
  }

  async settleLine(from: number): Promise<boolean> {
    const started = monotonic();
    const deadline = started + this.limit;
    const own = () => this.order.slice(from).some((id) => !this.records.get(id)?.background);
    const quiet = () => monotonic() - Math.max(this.lastEvent, started) >= (own() ? QUIET : FIRST_QUIET);
    const mine = () => !quiet() || this.order.slice(from).some((id) => {
      const entry = this.records.get(id);
      if (entry === undefined || entry.done || entry.background || LONG_LIVED.has(entry.type) || this.swept(entry, monotonic())) return false;
      return !entry.answered || (entry.method === "GET" && BODY_TYPES.has(entry.type) && readableType(entry) !== null);
    });
    while (mine()) {
      if (monotonic() >= deadline) return false;
      await sleep(POLL);
    }
    return true;
  }

  async settle(pageBusy: (() => Promise<boolean>) | null = null): Promise<boolean> {
    const started = monotonic();
    const deadline = started + this.limit;
    for (;;) {
      const now = monotonic();
      const quiet = this.foreground() || this.ignored > 0 ? QUIET : FIRST_QUIET;
      let waiting = this.watching && (this.busy() || now - Math.max(this.lastEvent, started) < quiet);
      if (!waiting && pageBusy !== null) waiting = await pageBusy();
      if (!waiting) {
        if (this.ignored > 0) flag("settle_ignored_background", true);
        return true;
      }
      if (now >= deadline) return false;
      await sleep(POLL);
    }
  }

  async stop(): Promise<void> {
    const listeners = this.page.state.listeners;
    const at = listeners.indexOf(this.listener);
    if (at >= 0) listeners.splice(at, 1);
    this.watching = false;
    if (!this.enabledHere) return;
    this.enabledHere = false;
    if (this.page.networkOn || this.page.sessionId === null) return;
    const cleanup = shield(() => this.disable());
    try {
      await untilCancelled(cleanup);
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
      await cleanup;
      throw error;
    }
  }

  async disable(): Promise<void> {
    try {
      await within(this.page.send("Network.disable"), STOP_TIMEOUT);
    } catch {
      flag("network_disable_unconfirmed", true);
    }
  }

  writes(): Write[] {
    const rows: Write[] = [];
    for (const requestId of this.order) {
      const entry = this.records.get(requestId) as RequestRecord;
      if (!entry.listed) continue;
      const row: Write = { method: entry.wrote?.method ?? entry.method, url: entry.wrote?.url ?? entry.url, type: entry.type, statuses: [...entry.statuses] };
      row["status"] = entry.statuses.length > 0 ? entry.statuses.at(-1) : null;
      if (entry.failed) row["failed"] = entry.failed;
      else if (!entry.done && !entry.answered) row["pending"] = true;
      rows.push(row);
    }
    return rows;
  }
}

export function netError(text: string | undefined): boolean {
  return typeof text === "string" && text.startsWith("net::ERR_") && text !== "net::ERR_ABORTED";
}

export async function navigationBusy(page: Page, navigations: number): Promise<boolean> {
  if (page.navigations === navigations) return false;
  const main = page.mainFrame;
  const current = main === null ? undefined : page.lifecycle.get(main);
  return !(current && current.loader === page.loader(main) && current.names.has("DOMContentLoaded"));
}

export type Reaction = [Element | null, string | null];
type Pending = { page: Page; frame: string; id: string };
const pendingReactions = new WeakMap<State, Pending>();

async function reactionCall(page: Page, expression: string, args: unknown[], frame: string | null, timeout: number): Promise<unknown> {
  return within(page.call(expression, args, { frame, read: true, timeout }), timeout);
}

export async function watchReaction(state: State, page: Page, react: Reaction): Promise<void> {
  const [element, given] = react;
  let frame = given;
  const watchId = tokenHex(6);
  let started: unknown;
  try {
    if (element !== null) {
      frame = element.frame;
      started = await reactionCall(page, WATCH_REACTION, [element, watchId], frame, REACTION_CALL_TIMEOUT);
    } else {
      started = await reactionCall(page, WATCH_REACTION_FOCUSED, [watchId], frame, REACTION_CALL_TIMEOUT);
    }
  } catch (error) {
    if (error instanceof BrowseError || error instanceof TimedOut) return;
    throw error;
  }
  if (started) pendingReactions.set(state, { page, frame: (frame || page.mainFrame) as string, id: watchId });
}

export function reactionWaits(name: string | null, argv: readonly string[]): boolean {
  if (name !== null && ["keyboard", "keydown", "keyup", "tab", "notes", "frame"].includes(name)) return false;
  if (name === "get" && (argv[0] === "url" || argv[0] === "title")) return false;
  if (name !== "press") return true;
  try {
    return parse(argv, { "--no-humanize": "bool" })[1].length >= 2;
  } catch (error) {
    if (error instanceof Usage) return true;
    throw error;
  }
}

export function hasPendingReaction(state: State): boolean {
  return pendingReactions.has(state);
}

export async function settleReaction(state: State, name: string | null = null, argv: readonly string[] = []): Promise<void> {
  const pending = pendingReactions.get(state);
  if (pending === undefined || !reactionWaits(name, argv)) return;
  pendingReactions.delete(state);
  const { page, frame, id } = pending;
  const limit = budget(page, REACTION_LIMIT);
  const deadline = monotonic() + limit + REACTION_CALL_TIMEOUT;
  try {
    let waited = true;
    while (monotonic() < deadline) {
      const budget = Math.max(Math.min(REACTION_CALL_TIMEOUT, deadline - monotonic()), 0.05);
      const watch = dict(await reactionCall(page, REACTION_STATE, [id], frame, budget));
      if (Object.keys(watch).length === 0) {
        waited = false;
        break;
      }
      const reacted = watch["sinceLast"] !== null && watch["sinceLast"] !== undefined;
      if (Number(watch["sinceInput"]) >= limit * 1000) break;
      if (Number(watch["sinceInput"]) >= REACTION_WINDOW * 1000 && !watch["busy"] && (!reacted || Number(watch["sinceLast"]) >= REACTION_QUIET * 1000)) {
        if (reacted) flag("waited_for_reaction", true);
        waited = false;
        break;
      }
      await sleep(POLL * 2);
    }
    if (waited) flag("waited_for_reaction", true);
  } catch (error) {
    if (!(error instanceof BrowseError) && !(error instanceof TimedOut)) throw error;
  } finally {
    try {
      await reactionCall(page, UNWATCH_REACTION, [id], frame, REACTION_CALL_TIMEOUT);
    } catch (error) {
      if (!(error instanceof BrowseError) && !(error instanceof TimedOut)) throw error;
    }
  }
}

function errorView(page: Page): View {
  return { target: page.targetId, loader: "", url: page.url, title: "", entries: [], containers: new Set() };
}

export type Seen = { page: Page; view: View; frame: string; loader: string | null; navigations: number };
type Group = { page: Page; session: string | null; before: View | null; watch: NetworkWatch; navigations: number; receipts: ReceiptWatch };

export class BatchObserve {
  previous: Seen | null = null;
  current: Seen | null = null;
  defer = false;
  pending: Group | null = null;
  flushed: Report | null = null;
  flushedPartly = false;

  nextLine(defer: boolean): void {
    this.previous = this.current;
    this.current = null;
    this.defer = defer;
  }
}

const batches = new WeakMap<State, BatchObserve>();

export function beginBatch(state: State): BatchObserve {
  const batch = new BatchObserve();
  batches.set(state, batch);
  return batch;
}

export async function endBatch(state: State, batch: BatchObserve): Promise<void> {
  if (batches.get(state) === batch) batches.delete(state);
  const group = batch.pending;
  batch.pending = null;
  if (group !== null) {
    group.receipts.stop();
    await group.watch.stop();
  }
}

export function deferring(state: State): boolean {
  return Boolean(batches.get(state)?.defer);
}

export function reusable(state: State, page: Page, seen: Seen | null): View | null {
  if (seen === null || seen.page !== page || seen.navigations !== page.navigations) return null;
  const frame = viewFrame(state, page);
  const loader = page.loader(frame);
  return frame === seen.frame && loader === seen.loader && (loader || "") === seen.view.loader ? seen.view : null;
}

async function viewBefore(state: State, page: Page): Promise<View | null> {
  try {
    return await view(state, page);
  } catch (error) {
    if (error instanceof ConnectionLost || !(error instanceof BrowseError)) throw error;
    return null;
  }
}

export async function flushBatch(ctx: Ctx, batch: BatchObserve): Promise<Report | null> {
  const group = batch.pending;
  batch.pending = null;
  if (group === null) return null;
  const unknown = async (why: string) => {
    group.receipts.stop();
    await group.watch.stop();
    const report = diff(null, errorView(group.page), group.watch.writes());
    report.document = "unknown";
    report.error = why;
    return report;
  };
  if (group.session !== group.page.session) return unknown("Ardia detached the tab during these lines, so their changes couldn't be followed");
  try {
    return decorate(await finish(ctx, group.page, group.before, group.watch, group.navigations, batch, null), group.page, group.watch, group.receipts);
  } catch (error) {
    if (!(error instanceof BrowseError)) throw error;
    return unknown(error.message);
  }
}

export function decorate(report: Report, page: Page, watch: NetworkWatch, receipts: ReceiptWatch | null): Report {
  if (receipts !== null) {
    receipts.stop();
    const { dialogs, downloads } = receipts.receipt();
    if (dialogs.length > 0) report.dialogs = dialogs;
    if (downloads.length > 0) report.downloads = downloads;
  }
  if (watch.navigationError) report.navigationError = watch.navigationError;
  const throttle = throttleOf(page);
  if (throttle !== null) report.throttle = throttle;
  if (watch.limit !== SETTLE_LIMIT) report.settleLimit = watch.limit;
  return report;
}

export function landedReport(page: Page, watch: NetworkWatch, why: string): Report {
  flag("action_landed_settle_lost", true);
  const report = diff(null, errorView(page), watch.writes());
  report.document = "unknown";
  report.error = `it landed, but ${why.replace(/\.$/u, "")}, so what it changed wasn't checked (it wasn't sent again)`;
  return report;
}

export function actionName(ctx: Ctx): string {
  return ctx.command ? `\`${ctx.command}\`` : "the action";
}

export async function guarded<T>(ctx: Ctx, page: Page, run: () => Promise<T>): Promise<T> {
  const parent = currentSignal();
  const child = new AbortController();
  const forward = () => child.abort();
  if (parent !== null) {
    if (parent.aborted) child.abort();
    else parent.addEventListener("abort", forward, { once: true });
  }
  try {
    return await raceDialog(page, withSignal(child.signal, run), actionName(ctx));
  } catch (error) {
    if (error instanceof BrowseError && error.code === "dialog_blocked") child.abort();
    if (error instanceof BrowseError && !(error instanceof ConnectionLost)) throw refusedRetry(ctx.command, error);
    throw error;
  } finally {
    parent?.removeEventListener("abort", forward);
  }
}

function lineOf(watch: NetworkWatch, from: number): WatchLike {
  return { records: watch.records, order: watch.order.slice(from) };
}

async function finish(
  ctx: Ctx,
  page: Page,
  before: View | null,
  watch: NetworkWatch,
  navigations: number,
  batch: BatchObserve | undefined,
  captureFrom: number | null,
): Promise<Report> {
  const state = ctx.state;
  let settledNow: boolean;
  try {
    const settling = clock();
    settledNow = await watch.settle(() => navigationBusy(page, navigations));
    spent("settle_ms", settling);
    if (captureFrom !== null) await observeHooks.capture(page, lineOf(watch, captureFrom));
  } finally {
    await watch.stop();
  }
  let nodes: Node[];
  let after: View;
  try {
    await state.reattach(page);
    nodes = await collect(state, page);
    adoptRefs(state, page, nodes);
    after = await remember(state, page, nodes);
  } catch (error) {
    if (error instanceof ConnectionLost || !(error instanceof BrowseError)) throw error;
    const report = diff(null, errorView(page), watch.writes());
    report.document = "unknown";
    report.error = error.message;
    return report;
  }
  if (batch !== undefined) {
    const frame = viewFrame(state, page);
    batch.current = { page, view: after, frame, loader: page.loader(frame), navigations: page.navigations };
  }
  const report = diff(before, after, watch.writes());
  report.notes = report.document === "new" ? arrivalNotes(state, before, after) : null;
  markShown(state, report, after);
  if (!settledNow) report.unsettled = true;
  if (before === null) report.document = "unknown";
  await addText(ctx, page, nodes, report, before);
  return report;
}

export async function observe<T>(ctx: Ctx, page: Page, run: () => Promise<T>, react: Reaction | null = null): Promise<[T, Report | null]> {
  const state = ctx.state;
  const batch = batches.get(state);
  if (batch?.pending && (batch.pending.page !== page || batch.pending.session !== page.session)) batch.flushed = await flushBatch(ctx, batch);
  await refuseIfDialog(page, actionName(ctx));
  if (ctx.options["no_changes"] || ctx.options["settle_only"]) {
    if (batch?.pending) batch.flushed = await flushBatch(ctx, batch);
    if (react !== null) await watchReaction(state, page, react);
    const work = () => guarded(ctx, page, run);
    return [ctx.options["no_changes"] ? await work() : await settled(page, work), null];
  }
  const group = batch?.pending ?? null;
  const reused = group === null && batch !== undefined ? reusable(state, page, batch.previous) : null;
  const before = group !== null ? group.before : (reused ?? (await viewBefore(state, page)));
  const watch = group !== null ? group.watch : new NetworkWatch(page);
  const receipts = group !== null ? group.receipts : new ReceiptWatch(page);
  const navigations = group !== null ? group.navigations : page.navigations;
  const holding = batch !== undefined && batch.defer;
  const session = group !== null ? group.session : page.session;
  let lineStart = 0;
  let value: T;
  try {
    if (group === null) {
      receipts.start();
      await watch.start();
    }
    lineStart = watch.order.length;
    if (react !== null) await watchReaction(state, page, react);
    value = await guarded(ctx, page, run);
  } catch (error) {
    if (batch !== undefined && (group !== null || holding)) batch.pending = { page, session, before, watch, navigations, receipts };
    else {
      receipts.stop();
      await watch.stop();
    }
    throw error;
  }
  if (holding) {
    batch.pending = { page, session, before, watch, navigations, receipts };
    await watch.settleLine(lineStart);
    await observeHooks.capture(page, lineOf(watch, lineStart));
    return [value, null];
  }
  if (batch !== undefined) batch.pending = null;
  try {
    return [value, decorate(await finish(ctx, page, before, watch, navigations, batch, lineStart), page, watch, receipts)];
  } catch (error) {
    receipts.stop();
    if (error instanceof ConnectionLost) {
      await watch.stop();
      return [value, landedReport(page, watch, error.message)];
    }
    if (batch !== undefined && group !== null && error instanceof BrowseError) {
      await watch.stop();
      const report = diff(null, errorView(page), watch.writes());
      report.document = "unknown";
      report.error = error.message;
      batch.flushed = report;
      batch.flushedPartly = true;
    }
    throw error;
  }
}

export async function settled<T>(page: Page, run: () => Promise<T>): Promise<T> {
  const watch = new NetworkWatch(page);
  const navigations = page.navigations;
  try {
    await watch.start();
    const value = await run();
    const settling = clock();
    await watch.settle(() => navigationBusy(page, navigations));
    spent("settle_ms", settling);
    await observeHooks.capture(page, watch);
    return value;
  } finally {
    await watch.stop();
  }
}

export async function arrival(ctx: Ctx, page: Page, cameFrom: string): Promise<Report | null> {
  const state = ctx.state;
  let nodes: Node[];
  let after: View;
  try {
    await page.refreshFrames();
    nodes = await collect(state, page);
    adoptRefs(state, page, nodes);
    after = await remember(state, page, nodes);
  } catch (error) {
    if (error instanceof ConnectionLost || !(error instanceof BrowseError)) throw error;
    return null;
  }
  const batch = batches.get(state);
  if (batch !== undefined) {
    const frame = viewFrame(state, page);
    batch.current = { page, view: after, frame, loader: page.loader(frame), navigations: page.navigations };
  }
  const report = diff(null, after);
  report.notes = arrivalNotes(state, { ...errorView(page), url: cameFrom }, after);
  markShown(state, report, after);
  await addText(ctx, page, nodes, report, null);
  flag("open_report", true);
  return report;
}

function arrivalNotes(state: State, before: View | null, after: View): string | null {
  return observeHooks.arrivalNotes(state, before, after);
}

async function addText(ctx: Ctx, page: Page, nodes: Node[], report: Report, before: View | null): Promise<void> {
  if (ctx.options["no_text"] || report.document === "unknown") return;
  const frame = viewFrame(ctx.state, page);
  let anchors: Node[];
  let budget: number;
  if (moved(report)) {
    anchors = [];
    budget = NAVIGATED_TEXT;
  } else {
    anchors = openedAnchors(report, nodes, before).filter((node) => node.frame === frame);
    budget = OPENED_TEXT;
    if (anchors.length === 0) return;
  }
  const refs = new Map<string, string>();
  for (const node of walk(nodes)) if (node.ref && node.backend !== null) refs.set(JSON.stringify([node.frame, node.backend]), node.ref);
  let text: TextBlock | null;
  try {
    text = await pageText(ctx.state, page, frame, budget, anchors, refs);
  } catch (error) {
    if (error instanceof ConnectionLost || !(error instanceof BrowseError)) throw error;
    return;
  }
  if (text === null || !addsText(text.lines, freshRows(report))) return;
  report.text = text;
  flag("change_text", true);
  count("change_text_chars", text.lines.reduce((total, line) => total + pyLen(line) + 1, 0));
}

async function pageText(state: State, page: Page, frame: string, budget: number, anchors: readonly Node[], refs: Map<string, string>, nested = false): Promise<TextBlock | null> {
  const elements: Element[] = [];
  for (const node of anchors) {
    const element = await page.resolveBackend(node.backend as number, node.frame as string, "opened content");
    if (element !== null) elements.push(element);
  }
  if (anchors.length > 0 && elements.length === 0) return null;
  const found = dict(await page.call(CHANGES_TEXT_JS, [budget, ...elements], { frame, read: true }));
  if (!found["text"]) return null;
  const kinds = Array.isArray(found["kinds"]) ? (found["kinds"] as unknown[]) : [];
  const names = Array.isArray(found["names"]) ? (found["names"] as unknown[]) : [];
  let marked: Element[] = [];
  if (kinds.length > 0) {
    const ids = await backendsOf(page, frame, "ardiaBrowseTextEls", MAX_TEXT_MARKS);
    const usable = ids.indexOf(0);
    marked = (usable < 0 ? ids : ids.slice(0, usable)).map((id) => new Element(frame, "", id, "text"));
  }
  const inline = new Set<string>();
  const inner = new Map<number, string>();
  const replace = (index: number): string => {
    if (index >= marked.length || index >= kinds.length) return "";
    const element = marked[index] as Element;
    const kind = kinds[index];
    let ref = refs.get(JSON.stringify([frame, element.backendId]));
    if (kind === "image") return `: screenshot @${ref || state.addRef(page, element, "image", String(names[index] ?? ""))}`;
    if (kind === "frame") {
      ref = ref || state.addRef(page, element, "Iframe", String(names[index] ?? ""));
      inner.set(index, ref);
      inline.add(ref);
      return `: frame @${ref}; read`;
    }
    if (!ref) return "";
    inline.add(ref);
    return ` [@${ref}]`;
  };
  const lines: string[] = [];
  const framesAt: [number, number][] = [];
  for (const raw of String(found["text"]).split("\n")) {
    const indexes = [...raw.matchAll(MARKER)].map((match) => Number(match[1]));
    const replaced = raw.replace(MARKER, (_, index: string) => replace(Number(index))).replaceAll("\x01", "");
    const line = pyStrip(redact(replaced).replace(/ {2,}/gu, " "));
    if (line) {
      lines.push(line);
      for (const index of indexes) if (inner.has(index)) framesAt.push([lines.length, index]);
    }
  }
  let more = Boolean(found["more"]);
  let left = budget - lines.reduce((total, line) => total + pyLen(line) + 1, 0);
  for (const [at, index] of nested ? [] : [...framesAt].reverse()) {
    const child = await frameOf(page, marked[index] as Element);
    if (child === null || left < MIN_FRAME_TEXT) continue;
    const sub = await pageText(state, page, child, left, [], refs, true);
    if (sub) {
      lines.splice(at, 0, ...sub.lines);
      for (const ref of sub.refs) inline.add(ref);
      more = more || Boolean(sub.more);
      left -= sub.lines.reduce((total, line) => total + pyLen(line) + 1, 0);
    }
  }
  if (lines.length === 0) return null;
  return { lines, refs: [...inline], more, where: typeof found["where"] === "string" ? found["where"] : "" };
}

async function frameOf(page: Page, element: Element): Promise<string | null> {
  let described: Json;
  try {
    described = await page.send("DOM.describeNode", { backendNodeId: element.backendId });
  } catch (error) {
    if (error instanceof BrowseError) return null;
    throw error;
  }
  const child = dict(described["node"])["frameId"];
  return typeof child === "string" && child && page.frames.has(child) ? child : null;
}

export function attach(result: Result, report: Report | null): Result {
  if (report === null) return result;
  const data = { ...(result.data as Record<string, unknown>), changes: asData(report) };
  let text = renderReport(report, report.document !== "unknown");
  if (report.document === "unknown" && report.added.length > 0) text = text.replace("changes:\n", "changes (no view of the page before, so everything shows as added):\n");
  const attached = new Result(data, `${result.text !== null ? result.text : "✓ Done"}\n${text}`, result.pageContent || Boolean(report.text));
  attached.failed = result.failed;
  attached.batch = result.batch;
  attached.outputCap = result.outputCap;
  return attached;
}
