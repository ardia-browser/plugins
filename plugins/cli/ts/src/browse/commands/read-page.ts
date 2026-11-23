import { urljoin } from "../../pylib/urllib.ts";
import { formatG } from "../../pylib/format.ts";
import { sleep } from "../cdp/cancel.ts";
import { BrowseError, Usage } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import { COMMANDS_READ_SCOPED } from "../js/index.ts";
import { flag } from "../metrics.ts";
import { fastResult, fetchUrl, run as fetchRun } from "../read/fetch.ts";
import { BODY_TEXT, fastRead, pickReadable } from "../read/fastpath.ts";
import { oopifText } from "../read/frames.ts";
import * as pagedata from "../read/pagedata.ts";
import * as pages from "../read/pages.ts";
import { cmdGet } from "./read.ts";
import { pageIsPdf, pageText } from "../read/pdftext.ts";
import { postProcess } from "../read/readurl.ts";
import { runScroll, scrolls } from "../read/scroll.ts";
import type { Page } from "../state/page.ts";
import { quiet } from "../state/page.ts";
import * as pierce from "../state/pierce.ts";
import { record } from "../state/records.ts";
import { monotonic } from "../state/wait.ts";
import type { Ctx } from "./ctx.ts";
import { register } from "./index.ts";
import { parse } from "./parse.ts";
import { frameOrMain } from "./shared.ts";

export async function readScoped(page: Page, given: string, selector: string): Promise<[string, string]> {
  let frame = given;
  const deadline = monotonic() + pages.THIN_WAIT;
  let got: Record<string, unknown> = { matched: 0, text: "" };
  const inMain = frame === page.mainFrame;
  let tries = 0;
  for (;;) {
    try {
      got = record(await page.call(COMMANDS_READ_SCOPED, [selector], { frame, read: true }));
      const pierced = tries % pierce.cadence.read === 0 || monotonic() + pages.THIN_POLL >= deadline;
      tries += 1;
      if (!got["matched"] && pierced) got = (await pierce.readAll(page, frame, selector)) ?? got;
    } catch (error) {
      if (!(error instanceof BrowseError) || !["document_changed", "page_navigated", "frame_gone"].includes(error.code ?? "") || (error.code === "frame_gone" && !inMain)) {
        throw error;
      }
      got = { matched: 0, text: "" };
      if (inMain) frame = page.mainFrame as string;
    }
    if ((got["matched"] && String(got["text"] || "").trim()) || monotonic() + pages.THIN_POLL >= deadline) break;
    await sleep(pages.THIN_POLL);
  }
  const matched = Number(got["matched"]) || 0;
  if (!matched) {
    throw new BrowseError(`Nothing on the page matches ${selector} (waited ${formatG(pages.THIN_WAIT)} s for it). Read without -s, or check it with snapshot -i`, null, "not_found");
  }
  const text = String(got["text"] || "");
  if (text.trim()) return [text, ""];
  flag("read_scope_empty", true);
  const what = matched === 1 ? "1 element" : `${matched} elements`;
  return [
    text,
    `(${selector} matched ${what} with no text after ${formatG(pages.THIN_WAIT)} s: the page may still be loading into it, or its content ` +
      "is elsewhere. Read without -s, or snapshot -i to see what's there)",
  ];
}

export async function pageScope(page: Page, frame: string): Promise<string> {
  let scope: unknown;
  try {
    scope = await page.call("() => ardiaBrowse.scope()", [], { frame, read: true });
  } catch (error) {
    if (quiet(error)) return "";
    throw error;
  }
  if (scope) flag("read_scope_shown", true);
  return scope ? String(scope) : "";
}

export async function cmdRead(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, pages.flags(), pages.ALIASES);
  if (options["data"]) {
    if (args.length || options["links"] !== undefined) throw new Usage("read --data reads this tab's embedded JSON; open the page first, then run `read --data`");
    const page = await ctx.state.page();
    return pagedata.run(page, frameOrMain(ctx, page), options);
  }
  if (scrolls(options)) return runScroll(ctx, options, args);
  if (pages.singleFetch(options, args)) {
    const given = args[0] as string;
    if (!pages.relative(given)) return fetchRun(given, options, ctx.options);
    const page = await ctx.state.page();
    await page.refreshFrames();
    return fetchRun(urljoin(page.url, given), options, ctx.options);
  }
  if (pages.wantsPages(options, args)) return pages.run(ctx, options, args);
  if (options["fast"] && !options["selector"]) return readFast(ctx, options);
  if (options["llms"] || options["require_md"] || options["http"]) {
    const page = await ctx.state.page();
    return fetchRun(page.url, options, ctx.options);
  }
  const page = await ctx.state.page();
  const frame = frameOrMain(ctx, page);
  const selector = (options["selector"] as string | undefined) ?? null;
  if (frame === page.mainFrame && (await pageIsPdf(page))) {
    const content = postProcess(await pageText(page), options);
    return new Result({ content, contentType: "application/pdf", finalUrl: page.url, source: "pdf", truncated: false, url: page.url }, content, true);
  }
  let emptyNote = "";
  let content: string;
  if (selector) [content, emptyNote] = await readScoped(page, frame, selector);
  else {
    const nav = Boolean(options["nav"]);
    const read = record(await page.call("(nav) => ardiaBrowse.readPage(nav)", [nav], { frame, read: true }));
    content = String(read["text"] ?? "");
    pages.noteNav(read);
    const framed = await oopifText(page, frame, nav);
    if (framed) content = content ? `${content}\n\n${framed}` : framed;
  }
  content = postProcess(content, options);
  pages.noteVirtualized(content);
  const scope = options["selector"] ? "" : await pageScope(page, frame);
  const readTime = pages.readAt();
  let shown = scope ? `${content}\n[scope: ${scope}]` : content || emptyNote;
  shown = shown ? `${shown}\n[read ${readTime}]` : shown;
  return new Result(
    { content, contentType: "text/html", finalUrl: page.url, source: "active-tab-html", truncated: false, url: page.url, scope: scope || null, readAt: readTime },
    shown,
    true,
  );
}

export const FAST_PROBE_SECONDS = 4;

async function readFast(ctx: Ctx, options: Record<string, unknown>): Promise<Result> {
  const page = await ctx.state.page();
  await page.refreshFrames();
  const filter = (options["filter"] as string | undefined) ?? null;
  const probe = Math.min(Number(options["timeout"] || 10000) / 1000, FAST_PROBE_SECONDS);
  const found = /^https?:/iu.test(page.url) ? await fastRead(page.url, probe, fetchUrl, { outline: options["outline"], filter }, false) : null;
  if (found !== null) {
    flag("read_fast_doc", true);
    return fastResult(page.url, found);
  }
  const frame = frameOrMain(ctx, page);
  const nav = Boolean(options["nav"]);
  const read = record(await page.call("(nav) => ardiaBrowse.readPage(nav)", [nav], { frame, read: true }));
  const visible = String((await page.call(BODY_TEXT, [], { frame, read: true })) ?? "");
  const picked = pickReadable(String(read["text"] ?? ""), visible);
  if (picked.method === "raw") flag("read_fast_raw", true);
  const content = postProcess(picked.content, options);
  const note = `[read via ${picked.method} from the tab, ${Math.round(picked.kept * 100)}% of the visible text kept by the reader]`;
  return new Result(
    { content, contentType: "text/html", finalUrl: page.url, method: picked.method, source: "active-tab-html", retained: Math.round(picked.kept * 1000) / 1000, truncated: false, url: page.url },
    content ? `${content}\n${note}` : note,
    true,
  );
}

register("read", cmdRead);

export function linksArgs(argv: readonly string[]): string[] {
  const [options, given] = parse(argv, { "--limit": "value" });
  if (given.length > 1) throw new Usage(`links takes one pattern, not ${given.length} (links [pattern] [--limit n])`);
  const out = ["--links", given[0] ?? "*", "--list"];
  if (options["limit"] !== undefined) out.push("--limit", String(options["limit"]));
  return out;
}

const URL_LIKE = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/|www\.)/u;

export function textArgs(argv: readonly string[]): ["get" | "read", string[], string] {
  const [options, given] = parse([...argv], pages.flags(), pages.ALIASES);
  const sole = given.length === 1 ? (given[0] as string) : null;
  if (sole !== null && sole !== "-" && !URL_LIKE.test(sole) && Object.keys(options).length === 0) {
    return ["get", ["text", sole], `text ${sole} ran as \`get text ${sole}\`; ardia browse has no text command`];
  }
  return ["read", [...argv], `text ran as \`read${argv.length ? ` ${argv.join(" ")}` : ""}\`; ardia browse has no text command`];
}

register("text", async (ctx, argv) => {
  flag("guessed_syntax", true);
  const [command, args, note] = textArgs(argv);
  const result = command === "get" ? await cmdGet(ctx, args) : await cmdRead(ctx, args);
  result.notice = [note, result.notice].filter(Boolean).join("\n");
  return result;
});

register("links", (ctx, argv) => {
  flag("guessed_syntax", true);
  return cmdRead(ctx, linksArgs(argv));
});
