import { formatG, groupThousands } from "../../pylib/format.ts";
import { pyStrip, reprText, splitlines } from "../../pylib/str.ts";
import { PY_SPACE_CLASS } from "../../pylib/re.ts";
import { pyIntArg } from "../pyerror.ts";
import { urljoin, urlsplit } from "../../pylib/urllib.ts";
import { codePoints } from "../../pystr.ts";
import { redact } from "../../redact.ts";
import { checkCancelled, currentSignal, sleep, withSignal } from "../cdp/cancel.ts";
import { BrowseError, ConnectionLost, OutcomeUnknown, Usage } from "../daemon-errors.ts";
import { capNotice, OUTPUT_CAP, Result, spill } from "../daemon/render.ts";
import { HTTPS_ONLY_NOTE, NavigationRefused, siteSilent, startNavigation, waitForLoad } from "../commands/core.ts";
import type { Ctx } from "../commands/ctx.ts";
import { normalizeUrl } from "../commands/parse.ts";
import { READPAGES_EXTRACT, READPAGES_LINKS } from "../js/index.ts";
import { add, count, flag } from "../metrics.ts";
import { Page, quiet } from "../state/page.ts";
import { record } from "../state/records.ts";
import { REATTACH_TRIES } from "../state/state.ts";
import * as temptabs from "../state/temptabs.ts";
import { monotonic } from "../state/wait.ts";
import { FLAGS as URL_FLAGS, postProcess } from "./readurl.ts";
import { run as fetchRun } from "./fetch.ts";
import { pageIsPdf, pageText } from "./pdftext.ts";
import { afterSameDocument, arrivedText, beforeNavigating, settle, SETTLE_LIMIT } from "./settle.ts";

export const READ_TABS = 4;
export const READER_TRIES = 2;
export const HTTP_WORKERS = 4;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const PAGE_TIMEOUT_MS = 20000;
export const LOAD_GRACE = 5.0;
export const MIN_USEFUL = 120;
export const THIN_WAIT = 5.0;
export const THIN_POLL = 0.5;
export const CUT_MARK = 24;
export const PAGE_SHARE = 6000;
export const PAGES_CAP_CEILING = 36000;
export const HTTP_ONLY = ["llms", "require_md", "raw"];
export const VIRTUALIZED_MARK = "rows rendered; the grid is virtualized";
export const EMPTY_PAGE =
  "(no text: the site sent an empty page with no title, which usually means it turns away automated or foreign traffic; reading it again rarely helps)";
export const FRAME_MARK = '[frame "';
const CHALLENGE =
  /just a moment|attention required|verify (that )?you are (a )?human|are you a robot|press (&|and) hold|captcha|human verification|security check|access denied|unusual traffic|request blocked|bot detection/iu;
const CHALLENGE_MAX_TEXT = 1500;
const DIGITS = /^\p{Nd}+$/u;
const PY_SPACE = new RegExp(`[${PY_SPACE_CLASS}]+`, "u");
const TRAILING_SPACE = new RegExp(`[${PY_SPACE_CLASS}]+$`, "u");

export type Options = Record<string, unknown>;
export type PageRecord = Record<string, unknown>;

export function flags(): Record<string, "bool" | "value" | "multi"> {
  return {
    ...(URL_FLAGS as Record<string, "bool" | "value">),
    "--http": "bool",
    "--stdin": "bool",
    "--links": "value",
    "--limit": "value",
    "--selector": "value",
    "--list": "bool",
    "--scroll": "bool",
    "--match": "value",
    "--data": "bool",
    "--fields": "value",
    "--where": "multi",
    "--block": "value",
    "--nav": "bool",
  };
}

export const ALIASES = { "-s": "--selector" };

export function len(text: string): number {
  return /[\ud800-\udfff]/u.test(text) ? codePoints(text).length : text.length;
}

export function readsStdin(options: Options, positional: readonly string[]): boolean {
  return Boolean(options["stdin"] || positional.includes("-"));
}

export function wantsPages(options: Options, positional: readonly string[]): boolean {
  return Boolean(positional.length || options["stdin"] || options["links"] !== undefined);
}

export function relative(url: string): boolean {
  return ["/", "./", "../", "?", "#"].some((start) => url.startsWith(start)) && !url.startsWith("//");
}

export function fetchOnly(options: Options): boolean {
  return Boolean(options["http"] || HTTP_ONLY.some((name) => options[name]));
}

export function singleFetch(options: Options, positional: readonly string[]): boolean {
  return positional.length === 1 && positional[0] !== "-" && !options["stdin"] && options["links"] === undefined && fetchOnly(options);
}

function digitValue(value: unknown): number | null {
  const text = String(value);
  return DIGITS.test(text) ? pyIntArg(text) : null;
}

export function parseLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  const number = digitValue(value);
  if (number === null || number < 1 || number > MAX_LIMIT) throw new Usage(`--limit takes a number of pages from 1 to ${MAX_LIMIT}, not ${value}`);
  return number;
}

export function pagesLimit(options: Options, named: number): number {
  if (options["limit"] !== undefined) return parseLimit(options["limit"]);
  return Math.max(DEFAULT_LIMIT, Math.min(named, MAX_LIMIT));
}

export function pageTimeout(options: Options): number {
  const value = options["timeout"];
  if (value === undefined || value === null) return PAGE_TIMEOUT_MS / 1000;
  const number = digitValue(value);
  if (number === null || number <= 0) throw new Usage(`--timeout takes milliseconds per page, not ${value}`);
  return number / 1000;
}

export function urlLines(text: string | null): string[] {
  const urls: string[] = [];
  for (const raw of splitlines(text || "")) {
    const line = pyStrip(raw);
    if (!line || line.startsWith("#")) continue;
    urls.push(...line.split(PY_SPACE).filter(Boolean));
  }
  return urls;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/gu, "\\$&");
}

export function linkMatcher(pattern: string): (url: string) => boolean {
  if (!pattern.includes("*")) return (url) => url.includes(pattern);
  const regex = new RegExp(pattern.split("*").map(escapeRegex).join("[\\s\\S]*"), "u");
  return (url) => regex.test(url);
}

export function canonicalLink(url: string): string {
  const at = url.indexOf("#");
  if (at < 0) return url;
  const fragment = url.slice(at + 1);
  return fragment.startsWith("/") || fragment.startsWith("!") ? url : url.slice(0, at);
}

export function distinctLinks(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const given of raw) {
    const url = canonicalLink(given);
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

export function pickLinks(links: readonly string[], pattern: string, skip: string | null = null): string[] {
  const matches = linkMatcher(pattern);
  const current = canonicalLink(skip || "");
  return links.filter((url) => matches(url) && url !== current);
}

export function noLinksMessage(pattern: string, pageUrl: string, links: readonly string[]): string {
  if (links.length === 0) return `The page has no links to read (${pageUrl})`;
  const samples: string[] = [];
  for (const url of links) {
    const parts = urlsplit(url);
    const path = parts.path + (parts.query ? `?${parts.query}` : "");
    if (!samples.includes(path)) samples.push(path);
    if (samples.length === 6) break;
  }
  return `No link on ${pageUrl} matches ${reprText(pattern)} (${links.length} links, such as ${samples.join(", ")})`;
}

export function wantedUrls(options: Options, positional: readonly string[], stdin: string | null, base: string | null = null): string[] {
  const urls = positional.filter((url) => url !== "-");
  if (readsStdin(options, positional)) urls.push(...urlLines(stdin));
  const out: string[] = [];
  for (const given of urls) {
    let url = given;
    if (relative(url)) {
      if (!base) throw new Usage(`${url} is relative; give a full URL, or read it from a session that has a tab`);
      url = urljoin(base, url);
    }
    url = normalizeUrl(url);
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

export function shares(lengths: readonly number[], budget: number): number[] {
  const allowed = new Array<number>(lengths.length).fill(0);
  const order = [...lengths.keys()].sort((a, b) => (lengths[a] as number) - (lengths[b] as number) || a - b);
  let left = Math.max(budget, 0);
  order.forEach((index, position) => {
    allowed[index] = Math.min(lengths[index] as number, Math.floor(left / (order.length - position)));
    left -= allowed[index] as number;
  });
  return allowed;
}

export function cut(text: string, limit: number): string {
  const size = len(text);
  if (size <= limit) return text;
  const points = codePoints(text);
  let at = points.slice(0, limit + 1).lastIndexOf("\n");
  at = at >= limit * 0.8 ? at : limit;
  const kept = points.slice(0, at).join("").replace(TRAILING_SPACE, "");
  return `${kept ? `${kept}\n` : ""}… [+${groupThousands(String(size - at))} characters]`;
}

export function header(page: PageRecord, index: number, total: number): string {
  const place = total > 1 ? `[${index}/${total}] ` : "";
  const url = page["finalUrl"] || page["url"];
  if (page["error"]) return `=== ${place}✗ ${url}\n${page["error"]}`;
  const facts = page["status"] ? [`HTTP ${page["status"]}`] : [];
  if (page["readAt"]) facts.push(`read ${page["readAt"]}`);
  const status = facts.length ? ` (${facts.join(", ")})` : "";
  let note = page["note"] ? `\n(${page["note"]})` : "";
  if (page["scope"]) note += `\n(scope: ${page["scope"]})`;
  return `=== ${place}${page["title"] || "(no title)"}${status}\n${url}${note}`;
}

export function footer(limit: number, cutAny: boolean, hidden: number, wanted: number, saved = ""): string {
  const parts = cutAny ? [`pages cut to fit ${groupThousands(String(limit))} characters`] : [];
  if (hidden) parts.push(`+${hidden} page${hidden !== 1 ? "s" : ""} not shown`);
  const where = saved ? ` (full output: ${saved})` : "";
  return `[${parts.join("; ")}. Narrow it: -s <css> (one region per page), a tighter --links pattern, or --limit <n>; or --max-output ${wanted} for every line${where}]`;
}

export function noteNav(got: Record<string, unknown>): void {
  const sections = Number(got["navSections"]) || 0;
  if (!sections) return;
  add("read_nav_hidden", sections);
  add("read_nav_chars_hidden", Number(got["navChars"]) || 0);
}

export function noteVirtualized(...texts: unknown[]): void {
  if (texts.some((text) => String(text || "").includes(VIRTUALIZED_MARK))) flag("read_virtualized_grid", true);
  if (texts.some((text) => String(text || "").includes(FRAME_MARK))) flag("read_frame_text", true);
}

export function pagesCap(pages: number): number {
  return Math.min(Math.max(PAGE_SHARE * pages, OUTPUT_CAP), PAGES_CAP_CEILING);
}

export function emptyNote(page: PageRecord): string {
  if (page["title"] || (Number(page["status"]) || 200) >= 300) return "(no text)";
  flag("read_empty_page", true);
  return EMPTY_PAGE;
}

export function join(heads: readonly string[], texts: readonly string[], tail: readonly string[]): string {
  const blocks = heads.map((head, index) => (texts[index] ? `${head}\n${texts[index]}` : head));
  const kept = tail.filter((line) => line);
  return [...blocks, ...(kept.length ? [kept.join("\n")] : [])].join("\n\n");
}

export function fit(heads: string[], texts: string[], hidden: number, limit: number, extra: string, wanted: number, saved = ""): string | null {
  const lengths = texts.map(len);
  const needed = lengths.reduce((sum, length) => sum + Math.min(length, MIN_USEFUL), 0);
  const longest = footer(limit, true, hidden, wanted, saved);
  let budget = limit - len(join(heads, heads.map(() => ""), [extra, longest])) - (CUT_MARK + 1) * texts.length;
  let best: string | null = null;
  for (let round = 0; round < 4; round += 1) {
    if (budget < needed) return best;
    const allowed = shares(lengths, budget);
    const cutAny = allowed.some((room, index) => room < (lengths[index] as number));
    const tail = cutAny || hidden ? [extra, footer(limit, cutAny, hidden, wanted, saved)] : [extra];
    const out = join(heads, texts.map((text, index) => cut(text, allowed[index] as number)), tail);
    const size = len(out);
    if (size > limit) {
      budget -= size - limit;
      continue;
    }
    best = out;
    if (!cutAny || limit - size < 40) return out;
    budget += limit - size;
  }
  return best;
}

export function render(records: readonly PageRecord[], options: Options, extra = ""): string {
  const heads = records.map((page, index) => redact(header(page, index + 1, records.length)));
  const texts = records.map((page) => redact(String(page["text"] || (page["error"] ? "" : emptyNote(page)))));
  const tail = redact(extra);
  const limit = options["full"] ? null : options["max_output"] === undefined || options["max_output"] === null ? pagesCap(records.length) : Number(options["max_output"]);
  const whole = join(heads, texts, [tail]);
  const size = len(whole);
  if (!limit || limit <= 0 || size <= limit) return whole;
  const saved = options["json"] ? "" : (spill(whole) ?? "");
  for (let shown = records.length; shown >= 0; shown -= 1) {
    const out = fit(heads.slice(0, shown), texts.slice(0, shown), records.length - shown, limit, tail, size + 300, saved);
    if (out !== null) return out;
  }
  return footer(limit, false, records.length, size + 300, saved);
}

export async function collectLinks(ctx: Ctx, pattern: string): Promise<[string, string[], string[]]> {
  const page = await ctx.state.page();
  await page.refreshFrames();
  const frame = (ctx.state.frameFor(page) || page.mainFrame) as string;
  const got = await page.call(READPAGES_LINKS, [], { frame, read: true });
  const links = distinctLinks(Array.isArray(got) ? got.map(String) : []);
  return [page.url, links, pickLinks(links, pattern, page.url)];
}

export async function openReader(ctx: Ctx, opened: string[]): Promise<Page> {
  const state = ctx.state;
  const targetId = await temptabs.create(state, opened);
  if (!state.targetInfos.has(targetId)) state.targetInfos.set(targetId, { targetId, url: "about:blank", title: "", type: "page" });
  const page = readers.makePage(state, targetId);
  state.pages.set(targetId, page);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.attach(state.browser as NonNullable<typeof state.browser>);
      await page.keepAwake();
      await page.enableNetwork();
      return page;
    } catch (error) {
      if (!(error instanceof BrowseError) || error instanceof ConnectionLost || error.code !== "tab_detached" || attempt >= REATTACH_TRIES) throw error;
      if (!state.targetInfos.has(targetId)) throw error;
      flag("reattached_after_detach", true);
    }
  }
}

export function readAt(): string {
  return `${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export function botCheck(title: string, text: string, status: unknown, counted = true): string | null {
  const blocked = status === 401 || status === 403 || status === 429;
  if (!(blocked || CHALLENGE.test(title || "") || (len(text || "") < CHALLENGE_MAX_TEXT && CHALLENGE.test(text || "")))) return null;
  if (counted) flag("read_bot_check", true);
  const what = status === 429 ? "a rate limit (HTTP 429)" : "a bot check or access block";
  return `this looks like ${what}, not the page's content: wait 30-60 s and read it again, try the site's other pages or another source, and say in your answer which sources stayed blocked`;
}

function thin(got: Record<string, unknown>, selector: string | null): boolean {
  return Boolean(selector && !got["matched"]) || len(String(got["text"] || "").trim()) < MIN_USEFUL;
}

export async function goto(page: Page, url: string, timeout: number, keepPartial = false): Promise<string | null> {
  const deadline = monotonic() + timeout;
  await page.state.reattach(page, url);
  const before = await beforeNavigating(page, url);
  let earlier = new Set(page.network.fetchesStarted.keys());
  const oldLoaders = new Set([...page.frames.values()].map((frame) => frame.loader).filter((loader): loader is string => Boolean(loader)));
  page.network.fetchesBusyUntil = 0;
  let result: Record<string, unknown>;
  try {
    result = await startNavigation(page, url, timeout);
  } catch (error) {
    if (error instanceof NavigationRefused) throw new BrowseError(`Ardia's policy only lets the ardia command open web pages; ${url} isn't one`, null, "policy_refused");
    if (error instanceof OutcomeUnknown) throw siteSilent(url, timeout, error);
    throw error;
  }
  if (result["errorText"]) {
    const errorText = String(result["errorText"]);
    let note = "";
    if (errorText.includes("ERR_BLOCKED_BY_CLIENT") && url.toLowerCase().startsWith("http://")) {
      flag("navigation_https_only_hint", true);
      note = `. ${HTTPS_ONLY_NOTE}`;
    }
    throw new BrowseError(`couldn't load it: ${errorText}${note}`, null, "navigation_failed");
  }
  const loader = typeof result["loaderId"] === "string" && result["loaderId"] ? result["loaderId"] : null;
  if (loader !== null) {
    try {
      await waitForLoad(page, loader, Math.max(deadline - monotonic(), 0.1), "domcontentloaded");
    } catch (error) {
      if (!keepPartial || !(error instanceof BrowseError) || error.code !== "timeout" || !(await arrivedText(page, loader))) throw error;
      flag("read_partial_page", true);
      await page.refreshFrames();
      return `the page was still loading after ${formatG(timeout)} s; this is the part that had arrived`;
    }
    try {
      await waitForLoad(page, loader, Math.min(LOAD_GRACE, Math.max(deadline - monotonic(), 0.1)), "load");
    } catch (error) {
      if (!quiet(error)) throw error;
    }
    earlier = new Set([...earlier, ...[...page.network.fetchLoaders].filter(([, fetchLoader]) => oldLoaders.has(fetchLoader)).map(([id]) => id)]);
    await settle(page, Math.min(deadline, monotonic() + SETTLE_LIMIT), earlier);
  } else await afterSameDocument(page, before, deadline, earlier);
  await page.state.reattach(page, url);
  await page.refreshFrames();
  return null;
}

export async function extractFilled(page: Page, selector: string | null, timeout: number, nav = false): Promise<Record<string, unknown>> {
  const deadline = monotonic() + Math.min(THIN_WAIT, timeout);
  let got = record(await page.call(READPAGES_EXTRACT, [selector, nav], { frame: page.mainFrame, read: true }));
  if ((Number(got["status"]) || 0) >= 400 || botCheck(String(got["title"] || ""), String(got["text"] || ""), got["status"], false)) return got;
  let waited = false;
  while (thin(got, selector) && monotonic() + THIN_POLL < deadline) {
    waited = true;
    await sleep(THIN_POLL);
    try {
      got = record(await page.call(READPAGES_EXTRACT, [selector, nav], { frame: page.mainFrame, read: true }));
    } catch (error) {
      if (!(error instanceof BrowseError) || !["document_changed", "page_navigated", "frame_gone"].includes(error.code ?? "")) throw error;
      await settle(page, Math.min(deadline, monotonic() + SETTLE_LIMIT));
    }
  }
  if (waited) flag("read_waited_for_content", true);
  return got;
}

async function extractAfterDetach(page: Page, url: string, selector: string | null, timeout: number, nav: boolean): Promise<Record<string, unknown>> {
  const loaded = page.loader(page.mainFrame);
  try {
    return await extractFilled(page, selector, timeout, nav);
  } catch (error) {
    if (!(error instanceof BrowseError) || error instanceof ConnectionLost || error.code !== "tab_detached") throw error;
    await page.state.reattach(page, url);
    await page.refreshFrames();
    if (page.loader(page.mainFrame) !== loaded) throw error;
    return extractFilled(page, selector, timeout, nav);
  }
}

export async function readIn(page: Page, url: string, selector: string | null, timeout: number, options: Options): Promise<PageRecord> {
  const out: PageRecord = { url, source: "browser" };
  let partial: string | null;
  let got: Record<string, unknown>;
  try {
    partial = await goto(page, url, timeout, true);
    if (await pageIsPdf(page)) {
      Object.assign(out, { finalUrl: page.url, title: page.url.slice(page.url.lastIndexOf("/") + 1), source: "pdf", text: postProcess(await pageText(page), options) });
      if (selector) out["note"] = `${url} is a PDF, so -s ${selector} doesn't apply; this is the whole document's text`;
      return out;
    }
    got = await extractAfterDetach(page, url, selector, timeout, Boolean(options["nav"]));
  } catch (error) {
    if (!quiet(error) || (error instanceof OutcomeUnknown && page.state.targetInfos.has(page.targetId))) throw error;
    out["error"] = (error as BrowseError).text;
    return out;
  }
  Object.assign(out, { finalUrl: page.url, title: got["title"] || "", status: got["status"] ?? null, readAt: readAt(), text: postProcess(String(got["text"] || ""), options) });
  noteNav(got);
  if (got["scope"]) {
    out["scope"] = got["scope"];
    flag("read_scope_shown", true);
  }
  const challenge = botCheck(String(out["title"]), String(out["text"]), out["status"]);
  const notes = [partial, challenge].filter((note) => note);
  if (notes.length) out["note"] = notes.join("; ");
  if (selector && !got["matched"]) out["error"] = `nothing on the page matches ${selector}`;
  return out;
}

export const readers = {
  makePage: (state: Ctx["state"], targetId: string): Page => new Page(state, targetId),
  readIn,
};

export async function inLanes<T>(work: readonly T[], width: number, lane: (take: () => T | undefined) => Promise<void>): Promise<void> {
  const queue = [...work];
  const take = () => queue.shift();
  const outer = currentSignal();
  const stop = new AbortController();
  const forward = () => stop.abort();
  outer?.addEventListener("abort", forward, { once: true });
  if (outer?.aborted) stop.abort();
  let first: unknown = null;
  try {
    await Promise.all(
      Array.from({ length: Math.min(width, work.length) }, () =>
        withSignal(stop.signal, () => lane(take)).catch((error: unknown) => {
          if (first === null) first = error;
          stop.abort();
        }),
      ),
    );
  } finally {
    outer?.removeEventListener("abort", forward);
  }
  checkCancelled(outer);
  if (first !== null) throw first;
}

export async function readTabs(ctx: Ctx, urls: readonly string[], selector: string | null, timeout: number, options: Options): Promise<PageRecord[]> {
  const state = ctx.state;
  await state.connect();
  await temptabs.sweep(state);
  const records: PageRecord[] = new Array(urls.length);
  const opened: string[] = [];
  try {
    await inLanes(
      urls.map((url, index) => [index, url] as const),
      READ_TABS,
      async (take) => {
        let page: Page | null = null;
        for (let item = take(); item !== undefined; item = take()) {
          const [index, url] = item;
          for (let attempt = 0; attempt < READER_TRIES; attempt += 1) {
            if (page === null || page.sessionId === null) page = await openReader(ctx, opened);
            const sent = page.navigationsSent;
            records[index] = await readers.readIn(page, url, selector, timeout, options);
            if (page.sessionId !== null || !("error" in (records[index] as PageRecord)) || page.navigationsSent !== sent || attempt + 1 === READER_TRIES) break;
            add("read_tabs_reopened");
          }
        }
      },
    );
  } finally {
    await temptabs.release(state, opened);
  }
  return records;
}

export async function readHttpOne(url: string, options: Options): Promise<PageRecord> {
  const one = await fetchOneOrPage(url, options, {});
  return one instanceof Result ? pageFrom(url, one) : one;
}

export async function fetchOneOrPage(url: string, options: Options, globalOptions: Options): Promise<Result | PageRecord> {
  let result: Result;
  try {
    result = await fetchRun(url, { ...options }, globalOptions);
  } catch (error) {
    if (!quiet(error)) throw error;
    return { url, source: "http", error: (error as BrowseError).text };
  }
  return result.body ? result : pageFrom(url, result);
}

function pageFrom(url: string, result: Result): PageRecord {
  const out: PageRecord = { url, source: "http" };
  const data = result.data as Record<string, unknown>;
  Object.assign(out, { finalUrl: data["finalUrl"] || url, title: data["title"] || "", text: data["content"] || "", readAt: readAt() });
  const challenge = botCheck(String(out["title"]), String(out["text"]), out["status"]);
  if (challenge) out["note"] = challenge;
  return out;
}

export async function readHttp(urls: readonly string[], options: Options): Promise<PageRecord[]> {
  const records: PageRecord[] = new Array(urls.length);
  await inLanes(
    urls.map((url, index) => [index, url] as const),
    HTTP_WORKERS,
    async (take) => {
      for (let item = take(); item !== undefined; item = take()) records[item[0]] = await readHttpOne(item[1], options);
    },
  );
  return records;
}

export function resultFor(records: PageRecord[], options: Options, globalOptions: Options, extra = "", dataExtra: Record<string, unknown> = {}): Result {
  const text = render(records, globalOptions, extra);
  const result = new Result({ pages: records, ...dataExtra }, text, true);
  if (text !== render(records, { ...globalOptions, full: true }, extra)) {
    const notice = capNotice(text);
    if (notice) {
      result.notice = notice;
      result.whole = true;
      (result as { text: string | null }).text = text.slice(0, text.length - notice.length).replace(/\n$/u, "");
    }
  }
  result.outputCap = pagesCap(records.length);
  count("read_pages", records.length);
  noteVirtualized(...records.map((page) => page["text"]));
  if (records.some((page) => page["error"])) result.failed = true;
  return result;
}

export function limitNote(found: number, limit: number, flagName: string): string {
  if (found <= limit) return "";
  return `[read the first ${limit} of ${found} pages; ${flagName} ${Math.min(found, MAX_LIMIT)} for more]`;
}

export async function readLocal(options: Options, positional: string[], stdin: string | null, globalOptions: Options): Promise<Result> {
  const urls = wantedUrls(options, positional, stdin);
  if (urls.length === 0) throw new Usage("Usage: ardia browse read <url>... [--stdin] [--links <pattern>] [-s <selector>] [--http]");
  const limit = pagesLimit(options, urls.length);
  pageTimeout(options);
  if (options["selector"]) throw new Usage("-s needs the browser's DOM; drop --http to read the pages in Ardia");
  const extra = limitNote(urls.length, limit, "--limit");
  if (urls.length === 1 && globalOptions["out_body"]) {
    const one = await fetchOneOrPage(urls[0] as string, options, globalOptions);
    if (one instanceof Result) return one;
    return resultFor([one], options, globalOptions, extra);
  }
  return resultFor(await readHttp(urls.slice(0, limit), options), options, globalOptions, extra);
}

export function runsLocally(options: Options, positional: readonly string[]): boolean {
  const wants = positional.length > 0 || Boolean(options["stdin"]) || options["links"] !== undefined;
  return wants && options["links"] === undefined && fetchOnly(options) && !positional.some(relative);
}

export const MAX_STDIN = 1024 * 1024;

export async function run(ctx: Ctx, options: Options, positional: string[]): Promise<Result> {
  let limit = parseLimit(options["limit"]);
  const timeout = pageTimeout(options);
  const selector = (options["selector"] as string | undefined) ?? null;
  let base: string | null = null;
  if (positional.some(relative) || (readsStdin(options, positional) && urlLines(ctx.stdin).some(relative))) {
    const page = await ctx.state.page();
    await page.refreshFrames();
    base = page.url;
  }
  let urls = wantedUrls(options, positional, ctx.stdin, base);
  const named = urls.length;
  let dataExtra: Record<string, unknown> = {};
  if (options["links"] !== undefined) {
    const pattern = options["links"] as string;
    const [source, links, picked] = await collectLinks(ctx, pattern);
    if (picked.length === 0) throw new BrowseError(noLinksMessage(pattern, source, links), { links: links.length }, "no_links");
    dataExtra = { listing: source, matched: picked.length };
    urls = [...urls, ...picked.filter((url) => !urls.includes(url))];
    if (options["list"]) {
      const shown = options["limit"] !== undefined ? picked.slice(0, limit) : picked;
      const text = shown.join("\n") + (shown.length < picked.length ? `\n${limitNote(picked.length, limit, "--limit")}` : "");
      return new Result({ links: shown, matched: picked.length, listing: source }, text, true);
    }
  } else if (options["list"]) throw new Usage("--list goes with --links <pattern>: it prints the links that read would visit");
  if (urls.length === 0) throw new Usage("Usage: ardia browse read <url>... [--stdin] [--links <pattern>] [-s <selector>] [--http]");
  limit = pagesLimit(options, named);
  const extra = limitNote(urls.length, limit, "--limit");
  urls = urls.slice(0, limit);
  let records: PageRecord[];
  if (fetchOnly(options)) {
    if (selector) throw new Usage("-s needs the browser's DOM; drop --http to read the pages in Ardia");
    if (urls.length === 1 && named === 1 && ctx.options["out_body"]) {
      const one = await fetchOneOrPage(urls[0] as string, options, ctx.options);
      if (one instanceof Result) return one;
      records = [one];
    } else records = await readHttp(urls, options);
  } else records = await readTabs(ctx, urls, selector, timeout, options);
  return resultFor(records, options, ctx.options, extra, dataExtra);
}
