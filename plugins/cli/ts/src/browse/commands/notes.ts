import { parseArgs } from "../../notes.ts";
import { runRequest } from "../../notes-files.ts";
import { BrowseError, Usage } from "../daemon-errors.ts";
import type { Result } from "../daemon/render.ts";
import type { Ctx } from "./ctx.ts";
import { register } from "./index.ts";

export async function cmdNotes(ctx: Ctx, given: string[]): Promise<Result> {
  let argv = given;
  let tab: string | null = null;
  const at = argv.indexOf("--tab");
  if (at >= 0) {
    if (at + 1 >= argv.length) throw new Usage("--tab needs a tab id (t1, or the tab-… id `ardia windows` prints)");
    tab = argv[at + 1] as string;
    argv = [...argv.slice(0, at), ...argv.slice(at + 2)];
  }
  const request = parseArgs(argv);
  if (request.text === "-") request.text = ctx.stdin || "";
  let url: string | null = null;
  if (request.site === null && request.action !== "list") {
    let page;
    if (tab !== null) {
      await ctx.state.connect();
      await ctx.state.refreshTargets();
      page = await ctx.state.page(await ctx.state.findTab(tab));
    } else page = await ctx.state.page();
    await page.refreshFrames();
    url = page.url;
  }
  const root = ctx.state.dataRoot;
  if (root === null) throw new BrowseError("This session has no data folder for notes");
  return runRequest(root, request, url);
}

register("notes", cmdNotes);
