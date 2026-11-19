import { formatG, roundTo } from "../../pylib/format.ts";
import { casefold } from "../../pylib/unicode.ts";
import { sleep } from "../cdp/cancel.ts";
import { BrowseError, Usage } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import type { Ctx } from "../commands/ctx.ts";
import { READPAGES_MAIN_LIST, READPAGES_SCROLL_STEP } from "../js/index.ts";
import { count, flag } from "../metrics.ts";
import { pyFloat, pyIntArg } from "../pyerror.ts";
import type { Element, Page } from "../state/page.ts";
import { quiet } from "../state/page.ts";
import { record } from "../state/records.ts";
import { parseRef } from "../state/refs.ts";
import { monotonic } from "../state/wait.ts";
import { fetchOnly, type Options } from "./pages.ts";

export const SCROLL_ROWS_DEFAULT = 1000;
export const SCROLL_ROWS_MAX = 10000;
export const SCROLL_TIMEOUT_MS = 30000;
export const SCROLL_QUIET = 0.1;
export const SCROLL_SETTLE = 1.5;
export const SCROLL_BUSY_SETTLE = 8.0;
export const SCROLL_POLL = 0.04;
export const SCROLL_END_WAIT = 3.0;
const DIGITS = /^\p{Nd}+$/u;

export type Row = { text: string; index: number | null; id: string; offset: number };
export type Step = Record<string, unknown> & { rows: Row[] };
type Target = string | Element;

export function parseRows(value: unknown, matchingRows = false): number {
  if (value === undefined || value === null) return matchingRows ? SCROLL_ROWS_MAX : SCROLL_ROWS_DEFAULT;
  const number = DIGITS.test(String(value)) ? pyIntArg(String(value)) : null;
  if (number === null || number < 1 || number > SCROLL_ROWS_MAX) throw new Usage(`--limit with --scroll takes a number of rows from 1 to ${SCROLL_ROWS_MAX}, not ${value}`);
  return number;
}

export function scrollTimeout(options: Options): number {
  const value = options["timeout"];
  if (value === undefined || value === null) return SCROLL_TIMEOUT_MS / 1000;
  const number = DIGITS.test(String(value)) ? pyIntArg(String(value)) : null;
  if (number === null || number <= 0) throw new Usage(`--timeout takes milliseconds, not ${value}`);
  return number / 1000;
}

export function rowKey(row: Row): string {
  if (row.index !== null && row.index !== undefined) return JSON.stringify(["index", row.index]);
  if (row.id) return JSON.stringify(["id", row.id]);
  return JSON.stringify(["at", row.offset, row.text]);
}

function rowOrder(a: Row, b: Row): number {
  const key = (row: Row): [number, number, number] => (row.index !== null && row.index !== undefined ? [0, row.index, row.offset] : [1, row.offset, 0]);
  const [x, y] = [key(a), key(b)];
  for (let index = 0; index < 3; index += 1) if (x[index] !== y[index]) return (x[index] as number) - (y[index] as number);
  return 0;
}

export class RowCollector {
  readonly rows = new Map<string, Row>();

  absorb(step: Step): number {
    let added = 0;
    for (const row of step.rows || []) {
      const key = rowKey(row);
      if (!this.rows.has(key)) {
        this.rows.set(key, row);
        added += 1;
      }
    }
    return added;
  }

  ordered(): Row[] {
    return [...this.rows.values()].sort(rowOrder);
  }
}

export function matching(rows: readonly Row[], match: string | null): Row[] {
  if (!match) return [...rows];
  const wanted = casefold(match);
  return rows.filter((row) => casefold(row.text).includes(wanted));
}

export function scrollSummary(total: number, shown: number, match: string | null, stopped: string, limit: number, seconds: number, hiddenTab: string | null = null): string {
  let counted = `${total} row${total !== 1 ? "s" : ""}`;
  if (match) counted = `${shown} of ${counted} match "${match}"`;
  const reasons: Record<string, string> = {
    end: "scrolled to the end of the list",
    limit: `stopped at --limit ${limit}; --limit <n> for more`,
    time: `stopped after ${formatG(seconds)} s before the end of the list; --timeout <ms> for longer`,
  };
  const hidden = hiddenTab && stopped === "end" ? `; the tab is hidden, so the page may not have drawn every row: ardia browse tab ${hiddenTab} --show, then read again` : "";
  return `[${counted}; ${reasons[stopped]}${hidden}]`;
}

export async function scrollStep(page: Page, frame: string, target: Target, action: string, to = 0, float = false): Promise<Step> {
  const step = await page.call(READPAGES_SCROLL_STEP, [target, action, float ? pyFloat(to) : to], { frame, read: true });
  const found = record(step);
  if (!step || found["missing"]) throw new BrowseError(`nothing on the page matches ${typeof target === "string" ? target : target.label}`, null, "no_match");
  const rows = (Array.isArray(found["rows"]) ? found["rows"] : []).map((raw) => {
    const row = record(raw);
    return { text: String(row["text"]), index: typeof row["index"] === "number" ? row["index"] : null, id: String(row["id"] ?? ""), offset: Number(row["offset"]) };
  });
  return { ...found, rows };
}

function fingerprint(step: Step): string {
  return JSON.stringify([step["height"], step.rows.length, step["busy"], step.rows.slice(0, 3).map(rowKey)]);
}

export async function settleRows(page: Page, frame: string, target: Target, collector: RowCollector, deadline: number): Promise<Step> {
  const started = monotonic();
  let last: string | null = null;
  let since = started;
  for (;;) {
    const step = await scrollStep(page, frame, target, "peek");
    collector.absorb(step);
    const now = monotonic();
    const seen = fingerprint(step);
    if (seen !== last) {
      last = seen;
      since = now;
    } else if (!step["busy"] && now - since >= SCROLL_QUIET) return step;
    const limit = step["busy"] ? SCROLL_BUSY_SETTLE : SCROLL_SETTLE;
    if (now - started >= limit || now >= deadline) return step;
    await sleep(SCROLL_POLL);
  }
}

export async function waitAtBottom(page: Page, frame: string, target: Target, collector: RowCollector, current: Step, until: number): Promise<Step | null> {
  const height = Number(current["height"]);
  const rows = collector.rows.size;
  let nudged = false;
  while (monotonic() < until) {
    await sleep(0.25);
    if (!nudged && monotonic() >= until - SCROLL_END_WAIT / 2) {
      nudged = true;
      await scrollStep(page, frame, target, "restore", Math.max(Number(current["position"]) - Number(current["view"]) * 0.5, 0), true);
      await scrollStep(page, frame, target, "next");
    }
    const step = await scrollStep(page, frame, target, "peek");
    collector.absorb(step);
    if (Number(step["height"]) > height || collector.rows.size > rows) {
      flag("read_scroll_waited_at_end", true);
      return settleRows(page, frame, target, collector, until + SCROLL_SETTLE);
    }
  }
  return null;
}

export async function scrollRows(page: Page, frame: string, target: Target, limit: number, timeout: number): Promise<[Row[], string, Step]> {
  const deadline = monotonic() + timeout;
  const collector = new RowCollector();
  const first = await scrollStep(page, frame, target, "start");
  const origin = Number(first["before"]);
  let stopped = "end";
  try {
    let current = await settleRows(page, frame, target, collector, deadline);
    for (;;) {
      if (collector.rows.size >= limit) {
        stopped = "limit";
        break;
      }
      if (monotonic() >= deadline) {
        stopped = "time";
        break;
      }
      const height = Number(current["height"]);
      const moved = await scrollStep(page, frame, target, "next");
      collector.absorb(moved);
      current = await settleRows(page, frame, target, collector, deadline);
      if (!moved["moved"] && Number(current["height"]) <= height && Number(current["position"]) + Number(current["view"]) >= Number(current["height"]) - 2) {
        const grown = await waitAtBottom(page, frame, target, collector, current, Math.min(deadline, monotonic() + SCROLL_END_WAIT));
        if (grown === null) break;
        current = grown;
      }
    }
  } finally {
    try {
      await scrollStep(page, frame, target, "restore", origin);
    } catch (error) {
      if (!quiet(error)) throw error;
    }
  }
  return [collector.ordered().slice(0, limit), stopped, first];
}

export function scrolls(options: Options): boolean {
  return Boolean(options["scroll"] || (options["match"] !== undefined && options["match"] !== null));
}

export async function runScroll(ctx: Ctx, options: Options, positional: readonly string[]): Promise<Result> {
  const selector = (options["selector"] as string | undefined) ?? null;
  if (!options["scroll"]) throw new Usage("--match goes with --scroll: read -s <list> --scroll --match <text>");
  if (positional.length || options["stdin"] || options["links"] !== undefined || fetchOnly(options)) {
    throw new Usage("--scroll reads one list on the session's tab: read [-s <list>] --scroll [--limit n] [--match <text>]");
  }
  const match = (options["match"] as string | undefined) ?? null;
  const limit = parseRows(options["limit"], Boolean(match));
  const timeout = scrollTimeout(options);
  let page: Page;
  let frame: string;
  let target: Target;
  if (!selector) {
    page = await ctx.state.page();
    frame = (ctx.state.frameFor(page) || page.mainFrame) as string;
    const remote = await page.call(READPAGES_MAIN_LIST, [], { frame, byValue: false, read: true });
    const found = await page.elementFrom(remote, frame, "the page's main list");
    if (found === null) throw new BrowseError("No repeated list stands out on this page; name it: read -s <list> --scroll", null, "no_list");
    target = found;
    flag("read_scroll_guessed", true);
  } else if (parseRef(selector)) {
    let element: Element;
    [page, element] = await ctx.state.locate(selector);
    frame = element.frame;
    target = element;
  } else {
    page = await ctx.state.page();
    frame = (ctx.state.frameFor(page) || page.mainFrame) as string;
    target = selector;
  }
  const started = monotonic();
  const [rows, stopped, first] = await scrollRows(page, frame, target, limit, timeout);
  const seconds = roundTo(monotonic() - started, 1);
  const shown = matching(rows, match);
  flag("read_scrolled", true);
  count("read_rows", rows.length);
  if (match) flag("read_matched", true);
  const hiddenTab = first["hidden"] ? ctx.state.tabId(page.targetId) : null;
  const summary = scrollSummary(rows.length, shown.length, match, stopped, limit, seconds, hiddenTab);
  const text = [...shown.map((row) => row.text), summary].join("\n");
  const data = { rows: shown.map((row) => row.text), total: rows.length, matched: match ? shown.length : null, stopped, scroller: first["scroller"] ?? null, url: page.url };
  return new Result(data, text, true);
}
