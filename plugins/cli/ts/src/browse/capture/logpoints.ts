import { sleep } from "../cdp/cancel.ts";
import type { Ctx } from "../commands/ctx.ts";
import { register } from "../commands/index.ts";
import { parse } from "../commands/parse.ts";
import { BrowseError, Usage } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import { flag } from "../metrics.ts";
import { ControlRefused } from "../state/apptabs.ts";
import { type ControlLink, openLink } from "../state/controllink.ts";
import type { Page } from "../state/page.ts";
import type { Listener, State } from "../state/state.ts";
import { record } from "../state/records.ts";
import { subcommandFlagProblem } from "../subcommand-flags.ts";
import { startConsole } from "./console.ts";
import { devtoolsCall } from "./devtools.ts";
import { appTabFor, inspectionUnavailable, refusedBy } from "./inspect.ts";
import { generatedPosition, mapFor, ScriptBook, sourceMatches } from "./sourcemaps.ts";
import { activate, releaseClaim, removeListener } from "./store.ts";

export const LOGPOINT_LIMIT = 50;
export const LOGPOINT_TAG = "[logpoint";
export const LOGPOINT_METHOD = "devtools.logpoint";
export const CLEAR_LOGPOINT_METHOD = "devtools.clearLogpoint";
export const LOGPOINT_LEASE = "logpoint";
export const SCRIPTS_SETTLE = 0.3;
const SOCKET_TIMEOUT = 15;

export type Logpoint = { id: string; via: "ardia" | "cdp"; breakpointId: string | null; where: string; generated: string; expression: string; mapped: boolean; label: string };
type Script = { url: string; sourceMapURL: string | null };
type Debugging = { scripts: ScriptBook; listener: Listener; next: number; session: string | null };
type Placement = Record<string, unknown>;

const PLACEMENTS = new WeakMap<Logpoint, Placement>();

const POINTS = new WeakMap<Page, Logpoint[]>();
const DEBUGGING = new WeakMap<Page, Debugging>();
const LINKS = new WeakMap<State, ControlLink>();
const LINKED_PAGES = new WeakMap<State, Set<Page>>();

export function logpointCondition(id: string, where: string, expression: string, condition: string | null): string {
  const label = JSON.stringify(`${LOGPOINT_TAG} ${id} ${where}]`);
  const guard = condition === null ? "" : `if (!(${condition})) return false; `;
  return `(() => { try { ${guard}console.log(${label}, ${expression}); } catch (error) { console.log(${label}, "logpoint error:", String(error)); } return false; })()`;
}

export function splitLocation(text: string): { file: string; line: number; column: number | null } | null {
  const match = /^(.+?):(\d+)(?::(\d+))?$/u.exec(text);
  if (match === null) return null;
  const line = Number(match[2]);
  if (line < 1) return null;
  return { file: match[1] as string, line, column: match[3] === undefined ? null : Number(match[3]) };
}

function pointsOf(page: Page): Logpoint[] {
  let points = POINTS.get(page);
  if (points === undefined) {
    points = [];
    POINTS.set(page, points);
  }
  return points;
}

function holdLease(ctx: Ctx, page: Page): void {
  if (pointsOf(page).length > 0) ctx.state.leases.add(LOGPOINT_LEASE);
  else {
    const others = [...ctx.state.pages.values()].some((other) => (POINTS.get(other)?.length ?? 0) > 0);
    if (!others) ctx.state.leases.delete(LOGPOINT_LEASE);
  }
}

async function linkFor(ctx: Ctx): Promise<ControlLink | null> {
  const known = LINKS.get(ctx.state);
  if (known !== undefined && !known.closed) return known;
  let link: ControlLink | null;
  try {
    link = await openLink(ctx.state);
  } catch (error) {
    if (error instanceof ControlRefused) return null;
    throw error;
  }
  if (link === null) return null;
  LINKS.set(ctx.state, link);
  const state = ctx.state;
  link.onClose(() => {
    if (LINKS.get(state) === link) LINKS.delete(state);
    for (const page of LINKED_PAGES.get(state) ?? []) {
      const points = POINTS.get(page);
      if (points !== undefined) for (let at = points.length - 1; at >= 0; at -= 1) if ((points[at] as Logpoint).via === "ardia") points.splice(at, 1);
    }
    LINKED_PAGES.delete(state);
    const live = [...state.pages.values()].some((page) => (POINTS.get(page)?.length ?? 0) > 0);
    if (!live) state.leases.delete(LOGPOINT_LEASE);
  });
  return link;
}

function dropLinkIfIdle(ctx: Ctx): void {
  const link = LINKS.get(ctx.state);
  if (link === undefined) return;
  const pages = LINKED_PAGES.get(ctx.state) ?? new Set<Page>();
  if ([...pages].some((page) => (POINTS.get(page) ?? []).some((point) => point.via === "ardia"))) return;
  link.close();
}

export function closeLogpointLink(state: State): void {
  LINKS.get(state)?.close();
}

async function enableDebugger(page: Page): Promise<void> {
  await devtoolsCall(page, "logpoint", "Debugger.enable");
  await devtoolsCall(page, "logpoint", "Debugger.setSkipAllPauses", { skip: true });
}

async function rejoined(page: Page, state: Debugging): Promise<void> {
  state.scripts.clear();
  await enableDebugger(page);
  state.session = page.session;
  for (const point of POINTS.get(page) ?? []) {
    const placement = PLACEMENTS.get(point);
    if (point.via !== "cdp" || placement === undefined) continue;
    const placed = await devtoolsCall(page, "logpoint", "Debugger.setBreakpointByUrl", placement);
    point.breakpointId = String(placed["breakpointId"]);
  }
  await sleep(SCRIPTS_SETTLE);
}

async function debugging(ctx: Ctx, page: Page): Promise<Debugging> {
  const known = DEBUGGING.get(page);
  if (known !== undefined) {
    if (known.session !== page.session) await rejoined(page, known);
    return known;
  }
  const state: Debugging = { scripts: new ScriptBook(), listener: () => {}, next: 1, session: page.session };
  state.listener = bookListener(page, state.scripts);
  ctx.state.listeners.push(state.listener);
  try {
    await activate(ctx, page, "logpoint", () => enableDebugger(page));
  } catch (error) {
    removeListener(ctx.state, state.listener);
    throw error;
  }
  DEBUGGING.set(page, state);
  await sleep(SCRIPTS_SETTLE);
  return state;
}

async function stopDebugging(ctx: Ctx, page: Page): Promise<void> {
  const state = DEBUGGING.get(page);
  if (state === undefined) return;
  removeListener(ctx.state, state.listener);
  DEBUGGING.delete(page);
  releaseClaim(ctx, page.targetId, "logpoint");
  try {
    await page.send("Debugger.disable");
  } catch {}
}

export function bookListener(page: Page, book: ScriptBook): Listener {
  return (eventPage, method, params) => {
    if (eventPage !== page) return;
    if (method === "Page.frameNavigated" && !record(params["frame"])["parentId"]) book.clear();
    else if (method === "Runtime.executionContextsCleared") book.clear();
    else if (method === "Debugger.scriptParsed" && typeof params["scriptId"] === "string") {
      const url = typeof params["url"] === "string" ? params["url"] : "";
      if (url) book.add(params["scriptId"], url, typeof params["sourceMapURL"] === "string" ? params["sourceMapURL"] : null);
    }
  };
}

export async function inlineMapsOf(ctx: Ctx, page: Page, urls: ReadonlySet<string>): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const take = (scripts: Iterable<Script>) => {
    for (const script of scripts) if (urls.has(script.url) && script.sourceMapURL !== null && !found.has(script.url)) found.set(script.url, script.sourceMapURL);
  };
  const active = DEBUGGING.get(page);
  if (active !== undefined) {
    take(active.scripts.values());
    return found;
  }
  if (!ctx.state.created.has(page.targetId) || urls.size === 0) return found;
  const seen = new ScriptBook();
  const listener = bookListener(page, seen);
  ctx.state.listeners.push(listener);
  try {
    await page.send("Debugger.enable");
    await page.send("Debugger.setSkipAllPauses", { skip: true }).catch(() => {});
    await sleep(SCRIPTS_SETTLE);
  } catch {
    return found;
  } finally {
    removeListener(ctx.state, listener);
    if (!DEBUGGING.has(page)) await page.send("Debugger.disable").catch(() => {});
  }
  take(seen.values());
  return found;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function placeLocally(page: Page, state: Debugging, file: string, line: number, column: number | null, condition: string): Promise<{ breakpointId: string; generated: string; mapped: boolean; placement: Placement }> {
  const scripts = [...state.scripts.values()];
  const direct = scripts.find((script) => script.url === file || sourceMatches(script.url, file));
  if (direct !== undefined || /^https?:/u.test(file)) {
    const url = direct?.url ?? file;
    const placement: Placement = { url, lineNumber: line - 1, columnNumber: column === null ? undefined : column - 1, condition };
    const placed = await devtoolsCall(page, "logpoint", "Debugger.setBreakpointByUrl", placement);
    return { breakpointId: String(placed["breakpointId"]), generated: `${url}:${line}${column === null ? "" : `:${column}`}`, mapped: false, placement };
  }
  for (const script of scripts) {
    const loaded = mapFor(page, script.url, script.sourceMapURL);
    if (loaded === null) continue;
    const found = generatedPosition(loaded, file, line, column);
    if (found === null) continue;
    const placement: Placement = { urlRegex: `^${escapeRegex(script.url)}$`, lineNumber: found.line, columnNumber: found.column, condition };
    const placed = await devtoolsCall(page, "logpoint", "Debugger.setBreakpointByUrl", placement);
    flag("logpoint_source_mapped", true);
    return { breakpointId: String(placed["breakpointId"]), generated: `${script.url}:${found.line + 1}:${found.column + 1}`, mapped: true, placement };
  }
  throw new BrowseError(
    `No script on this page is ${file}, and no inline source map names it. \`ardia browse logpoint scripts\` lists the scripts it can see; give one of those, or a source path an inline (data:) source map names`,
    { file },
    "not_found",
  );
}

function refuseForeignTab(ctx: Ctx, page: Page): void {
  if (ctx.state.created.has(page.targetId)) return;
  const tab = ctx.state.tabId(page.targetId);
  throw new BrowseError(
    `logpoint works only on tabs this session opened, and [${tab}] isn't one: logpoints run code in the page, so they stay out of the user's own tabs. Open the page in a tab of your own with \`ardia browse open <url>\``,
    { tabId: tab },
    "not_own_tab",
  );
}

async function placeThroughArdia(ctx: Ctx, page: Page, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const tab = await appTabFor(ctx, page);
  if (tab === null) return null;
  const link = await linkFor(ctx);
  if (link === null) return null;
  try {
    return record(await link.call(LOGPOINT_METHOD, { tab, ...params }, SOCKET_TIMEOUT));
  } catch (error) {
    if (error instanceof ControlRefused && error.code === "timeout") {
      link.close();
      throw new BrowseError(
        `Ardia didn't answer ${LOGPOINT_METHOD} in time, so its connection was closed, which removes any logpoint it set late (and the other logpoints it held for this session)`,
        { method: LOGPOINT_METHOD },
        "timeout",
      );
    }
    if (inspectionUnavailable(error)) {
      dropLinkIfIdle(ctx);
      return null;
    }
    if (error instanceof ControlRefused) throw refusedBy(LOGPOINT_METHOD, error, "not_own_tab");
    throw error;
  }
}

export function ardiaPlace(answer: Record<string, unknown>, fallback: string): string {
  const url = answer["url"];
  const line = answer["line"];
  if (typeof url !== "string" || typeof line !== "number") return fallback;
  return `${url}:${line}${typeof answer["column"] === "number" ? `:${answer["column"] as number}` : ""}`;
}

export function forgetPage(state: State, page: Page | undefined): void {
  if (page === undefined) return;
  POINTS.delete(page);
  const debug = DEBUGGING.get(page);
  if (debug !== undefined) removeListener(state, debug.listener);
  DEBUGGING.delete(page);
  LINKED_PAGES.get(state)?.delete(page);
  const live = [...state.pages.values()].some((other) => other !== page && (POINTS.get(other)?.length ?? 0) > 0);
  if (!live) {
    state.leases.delete(LOGPOINT_LEASE);
    LINKS.get(state)?.close();
  }
}

const HOOKED = new WeakSet<State>();

function hookForget(state: State): void {
  if (HOOKED.has(state)) return;
  HOOKED.add(state);
  state.onForget.push((_target, page) => forgetPage(state, page));
}

function tabClosedWhilePlacing(ctx: Ctx, page: Page): BrowseError {
  return new BrowseError(`The tab [${ctx.state.tabId(page.targetId)}] closed while the logpoint was being set, so there's no logpoint`, null, "tab_gone");
}

async function clearLate(ctx: Ctx, id: string): Promise<void> {
  const link = LINKS.get(ctx.state);
  if (!id || link === undefined || link.closed) return;
  try {
    await link.call(CLEAR_LOGPOINT_METHOD, { id }, SOCKET_TIMEOUT);
  } catch {
    link.close();
  }
  dropLinkIfIdle(ctx);
}

function listText(points: readonly Logpoint[]): string {
  if (points.length === 0) return "No logpoints";
  return points.map((point) => `${point.id}  ${point.where}${point.mapped ? `  (${point.generated})` : ""}  ${point.expression}`).join("\n");
}

async function removeOne(ctx: Ctx, page: Page, point: Logpoint): Promise<void> {
  if (point.via === "ardia") {
    const link = LINKS.get(ctx.state);
    if (link === undefined || link.closed) return;
    try {
      await link.call(CLEAR_LOGPOINT_METHOD, { id: point.id }, SOCKET_TIMEOUT);
    } catch (error) {
      if (error instanceof ControlRefused) throw refusedBy(CLEAR_LOGPOINT_METHOD, error);
      throw error;
    }
    return;
  }
  await devtoolsCall(page, "logpoint", "Debugger.removeBreakpoint", { breakpointId: point.breakpointId });
}

async function removePoints(ctx: Ctx, page: Page, ids: readonly string[]): Promise<Result> {
  const points = pointsOf(page);
  for (const id of ids) if (!points.some((point) => point.id === id)) throw new BrowseError(`No logpoint ${id}; \`ardia browse logpoint list\` shows them`, { id }, "not_found");
  const removed: string[] = [];
  try {
    for (const id of ids) {
      const point = points.find((candidate) => candidate.id === id) as Logpoint;
      await removeOne(ctx, page, point);
      points.splice(points.indexOf(point), 1);
      removed.push(id);
    }
  } finally {
    if (!points.some((point) => point.via === "cdp")) await stopDebugging(ctx, page);
    dropLinkIfIdle(ctx);
    holdLease(ctx, page);
  }
  return new Result({ removed }, removed.length > 0 ? `✓ Removed ${removed.join(", ")}` : "No logpoints");
}

export async function cmdLogpoint(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--condition": "value", "--column": "value" });
  const action = args[0] ?? "list";
  const problem = subcommandFlagProblem("logpoint", action, argv);
  if (problem !== undefined) throw new Usage(problem);
  const page = await ctx.state.page();
  const active = DEBUGGING.get(page);
  if (active !== undefined && active.session !== page.session) await rejoined(page, active);
  const points = pointsOf(page);
  if (action === "list") return new Result({ logpoints: points }, listText(points));
  if (action === "rm" || action === "clear") {
    const ids = action === "clear" || args[1] === "--all" ? points.map((point) => point.id) : args.slice(1);
    if (action === "rm" && ids.length === 0) throw new Usage("Usage: ardia browse logpoint rm <id>... | logpoint clear");
    return removePoints(ctx, page, ids);
  }
  if (action === "scripts") {
    refuseForeignTab(ctx, page);
    const state = await debugging(ctx, page);
    const urls = [...new Set([...state.scripts.values()].map((script) => `${script.url}${script.sourceMapURL ? "  (inline source map)" : ""}`))];
    if (!points.some((point) => point.via === "cdp")) await stopDebugging(ctx, page);
    return new Result({ scripts: urls }, urls.length > 0 ? urls.join("\n") : "No scripts with a URL on this page");
  }
  if (action !== "add") throw new Usage("Usage: ardia browse logpoint add <file:line[:column]> <expression> [--condition js] | list | rm <id> | clear | scripts");
  refuseForeignTab(ctx, page);
  const location = splitLocation(args[1] ?? "");
  const expression = args.slice(2).join(" ").trim();
  if (location === null || expression === "") throw new Usage("Usage: ardia browse logpoint add <file:line[:column]> <expression> [--condition js]");
  const column = typeof options["column"] === "string" ? Number(options["column"]) : location.column;
  if (column !== null && (!Number.isInteger(column) || column < 1)) throw new Usage("--column takes a column from 1");
  if (points.length >= LOGPOINT_LIMIT) throw new BrowseError(`This tab has ${LOGPOINT_LIMIT} logpoints already; remove some first`, null, "registry_full");
  const condition = typeof options["condition"] === "string" ? options["condition"] : null;
  await startConsole(ctx, page);
  const where = `${location.file}:${location.line}${column === null ? "" : `:${column}`}`;
  const asked: Record<string, unknown> = { url: location.file, line: location.line, expression };
  if (column !== null) asked["column"] = column;
  if (condition !== null) asked["condition"] = condition;
  hookForget(ctx.state);
  const fromArdia = await placeThroughArdia(ctx, page, asked);
  if (ctx.state.pages.get(page.targetId) !== page) {
    if (fromArdia !== null) await clearLate(ctx, String(fromArdia["id"] ?? ""));
    holdLease(ctx, page);
    throw tabClosedWhilePlacing(ctx, page);
  }
  let point: Logpoint;
  if (fromArdia !== null) {
    const id = String(fromArdia["id"] ?? `lp${points.length + 1}`);
    const mapped = typeof record(fromArdia["original"])["source"] === "string";
    const generated = ardiaPlace(fromArdia, where);
    point = { id, via: "ardia", breakpointId: null, where, generated, expression, mapped, label: typeof fromArdia["label"] === "string" ? (fromArdia["label"] as string) : `${LOGPOINT_TAG} ${id}` };
    const linked = LINKED_PAGES.get(ctx.state) ?? new Set<Page>();
    linked.add(page);
    LINKED_PAGES.set(ctx.state, linked);
    if (mapped) flag("logpoint_source_mapped", true);
  } else {
    const state = await debugging(ctx, page);
    const id = `lp${state.next}`;
    let placed;
    try {
      placed = await placeLocally(page, state, location.file, location.line, column, logpointCondition(id, where, expression, condition));
    } catch (error) {
      if (!points.some((other) => other.via === "cdp")) await stopDebugging(ctx, page);
      throw error;
    }
    state.next += 1;
    point = { id, via: "cdp", breakpointId: placed.breakpointId, where, generated: placed.generated, expression, mapped: placed.mapped, label: `${LOGPOINT_TAG} ${id} ${where}]` };
    PLACEMENTS.set(point, placed.placement);
  }
  if (ctx.state.pages.get(page.targetId) !== page) {
    if (point.via === "ardia") await clearLate(ctx, point.id);
    holdLease(ctx, page);
    throw tabClosedWhilePlacing(ctx, page);
  }
  pointsOf(page).push(point);
  holdLease(ctx, page);
  const mapped = point.mapped && point.generated !== where ? ` (source-mapped to ${point.generated})` : "";
  return new Result(point, `✓ Logpoint ${point.id} at ${where}${mapped}; it logs without pausing. \`ardia browse console\` shows its lines (they start with ${point.label})`);
}

register("logpoint", cmdLogpoint);
