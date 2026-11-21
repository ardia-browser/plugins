import { formatG } from "../../pylib/format.ts";
import { sleep } from "../cdp/cancel.ts";
import { BrowseError, Usage } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import { COMMANDS_READ_SCOPED } from "../js/index.ts";
import { flag } from "../metrics.ts";
import { run as fetchRun } from "../read/fetch.ts";
import { oopifText } from "../read/frames.ts";
import * as pagedata from "../read/pagedata.ts";
import * as pages from "../read/pages.ts";
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
  if (pages.singleFetch(options, args)) return fetchRun(args[0] as string, options, ctx.options);
  if (pages.wantsPages(options, args)) return pages.run(ctx, options, args);
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
    const read = await page.call("() => ardiaBrowse.readable()", [], { frame, read: true });
    content = typeof read === "string" ? read : read === null || read === undefined ? "" : String(read);
    const framed = await oopifText(page, frame);
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

register("read", cmdRead);

export function linksArgs(argv: readonly string[]): string[] {
  const [options, given] = parse(argv, { "--limit": "value" });
  if (given.length > 1) throw new Usage(`links takes one pattern, not ${given.length} (links [pattern] [--limit n])`);
  const out = ["--links", given[0] ?? "*", "--list"];
  if (options["limit"] !== undefined) out.push("--limit", String(options["limit"]));
  return out;
}

register("links", (ctx, argv) => {
  flag("guessed_syntax", true);
  return cmdRead(ctx, linksArgs(argv));
});
