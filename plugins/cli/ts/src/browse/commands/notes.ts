import { parseArgs, trustedSite } from "../../notes.ts";
import { runRequest } from "../../notes-files.ts";
import { BrowseError, Usage } from "../daemon-errors.ts";
import type { Result } from "../daemon/render.ts";
import type { Page } from "../state/page.ts";
import type { Ctx } from "./ctx.ts";
import { register } from "./index.ts";

export function verifiedSite(page: Pick<Page, "frames" | "mainFrame">): { site: string | null; origin: string } {
  const origin = (page.mainFrame === null ? undefined : page.frames.get(page.mainFrame)?.origin) || "null";
  return { site: trustedSite(origin), origin };
}

function notOnTab(origin: string, url: string | null): BrowseError {
  return new BrowseError(
    `The tab's document isn't on an https origin (${origin}${url ? `, at ${url}` : ""}), so there's no site to keep notes for here; plain http is only trusted on localhost`,
    null,
    "bad_site",
  );
}

export function notesTab(given: readonly string[]): { tab: string | null; rest: string[] } {
  const rest: string[] = [];
  let tab: string | null = null;
  for (let index = 0; index < given.length; index += 1) {
    const word = given[index] as string;
    let value: string | null = null;
    if (word === "--tab") {
      if (index + 1 >= given.length) throw new Usage("--tab needs a tab id (t1, or the tab-… id `ardia windows` prints)");
      value = given[index + 1] as string;
      index += 1;
    } else if (word.startsWith("--tab=")) value = word.slice("--tab=".length);
    else {
      rest.push(word);
      continue;
    }
    if (tab !== null) throw new Usage("Give --tab once");
    if (value.trim() === "") throw new Usage("--tab needs a tab id (t1, or the tab-… id `ardia windows` prints)");
    tab = value;
  }
  return { tab, rest };
}

export async function cmdNotes(ctx: Ctx, given: string[]): Promise<Result> {
  const { tab, rest: argv } = notesTab(given);
  const request = parseArgs(argv);
  if (request.text === "-") request.text = ctx.stdin || "";
  let url: string | null = null;
  const onTab = request.action !== "list" && request.action !== "approve" && (request.site === null || tab !== null);
  if (onTab) {
    let page;
    if (tab !== null) {
      await ctx.state.connect();
      await ctx.state.refreshTargets();
      page = await ctx.state.page(ctx.boundTarget ?? (await ctx.state.findTab(tab)));
    } else page = await ctx.state.page();
    await page.refreshFrames();
    const verified = verifiedSite(page);
    if (verified.site === null) throw notOnTab(verified.origin, page.url);
    if (request.site !== null && request.site !== verified.site) {
      throw new BrowseError(
        `The tab is on ${verified.site}, not ${request.site}; notes for a tab are kept under its own site, so leave the site out or name ${verified.site}`,
        { tab: verified.site, given: request.site },
        "site_mismatch",
      );
    }
    request.site = verified.site;
    url = verified.origin;
  }
  const root = ctx.state.dataRoot;
  if (root === null) throw new BrowseError("This session has no data folder for notes");
  return runRequest(root, request, url);
}

register("notes", cmdNotes);
