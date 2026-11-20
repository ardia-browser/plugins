import { BrowseError, ConnectionLost } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import { type Page } from "../state/page.ts";
import { waitUntil } from "../state/wait.ts";
import { type Ctx } from "./ctx.ts";
import { register } from "./index.ts";
import { need, parse } from "./parse.ts";

export function borrowedTab(ctx: Ctx): string | null {
  const state = ctx.state;
  return state.current && state.current === state.attached ? state.attached : null;
}

export function refuseOnBorrowed(ctx: Ctx, page: Page, what: string): void {
  const borrowed = borrowedTab(ctx);
  if (borrowed && borrowed === page.targetId) {
    const tab = ctx.state.tabId(borrowed);
    throw new BrowseError(
      `This session is using your tab [${tab}] (picked with \`tab active\`), so it won't ${what} it. To drive that tab anyway, ` +
        `pick it with \`ardia browse tab ${tab}\`; to browse on your own, use \`ardia browse open <url>\``,
      { tabId: tab },
      "borrowed_tab",
    );
  }
}

function entryUrl(entry: unknown): unknown {
  return entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>)["url"] : undefined;
}

export async function cmdHistory(ctx: Ctx, _argv: string[]): Promise<Result> {
  const page = await ctx.state.page();
  refuseOnBorrowed(ctx, page, `go ${ctx.command} in`);
  const history = await page.send("Page.getNavigationHistory");
  const index = typeof history["currentIndex"] === "number" ? history["currentIndex"] : 0;
  const entries = Array.isArray(history["entries"]) ? history["entries"] : [];
  const step = ctx.command === "back" ? -1 : 1;
  if (!(0 <= index + step && index + step < entries.length) || (index + step === 0 && entryUrl(entries[0]) === "about:blank" && ctx.state.opened.has(page.targetId))) {
    return new Result({ url: page.url }, page.url);
  }
  const before = page.navigations;
  const beforeUrl = page.url;
  await page.call(`() => { history.go(${step}); return true; }`, [], { frame: page.mainFrame });
  const moved = async (): Promise<boolean> => {
    if (page.navigations !== before) {
      try {
        return Boolean(await page.call("() => document.readyState === 'complete'", [], { frame: page.mainFrame, read: true }));
      } catch (error) {
        if (error instanceof ConnectionLost || !(error instanceof BrowseError)) throw error;
        return false;
      }
    }
    return page.url !== beforeUrl;
  };
  await waitUntil(moved, ctx.timeout, 0.05, "the history navigation");
  await page.refreshFrames();
  return new Result({ url: page.url }, page.url);
}

function settled(page: Page, before: number): boolean {
  if (page.navigations === before) return false;
  const main = page.mainFrame;
  const current = main === null ? undefined : page.lifecycle.get(main);
  return Boolean(current && current.loader === page.loader(main) && current.names.has("load"));
}

export async function cmdReload(ctx: Ctx, _argv: string[]): Promise<Result> {
  const page = await ctx.state.page();
  refuseOnBorrowed(ctx, page, "reload");
  if (page.crashed) {
    await page.revive(ctx.timeout);
    return new Result({ url: page.url, crashed: true }, `${page.url}\n→ The page had crashed; it was reloaded`);
  }
  const before = page.navigations;
  await page.send("Page.reload", {});
  await waitUntil(async () => settled(page, before), ctx.timeout, 0.05, "the reload");
  await page.refreshFrames();
  return new Result({ url: page.url }, page.url);
}

export async function cmdPushstate(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  need(args, 1, "pushstate <url>");
  const page = await ctx.state.page();
  refuseOnBorrowed(ctx, page, "change the address of");
  const url = await page.call("(u) => ardiaBrowse.pushState(u)", [args[0]], { frame: page.mainFrame });
  page.url = url as string;
  return new Result({ url }, url as string);
}

register(["back", "forward"], cmdHistory);
register("reload", cmdReload);
register("pushstate", cmdPushstate);
