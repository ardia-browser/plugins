import { quote } from "../../json.ts";
import { type Browser } from "../cdp/browser.ts";
import { Cancelled, shield } from "../cdp/cancel.ts";
import { BrowseError, CdpError, ConnectionLost, Usage } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import { flag } from "../metrics.ts";
import { appTabMap } from "../state/apptabs.ts";
import { type Element, type Page } from "../state/page.ts";
import { type TabRow } from "../state/state.ts";
import * as temptabs from "../state/temptabs.ts";
import { newTab, offscreenNote, pageTitle, showTab, wantsShow } from "./core.ts";
import { type Ctx } from "./ctx.ts";
import { register } from "./index.ts";
import { need, parse } from "./parse.ts";

export const APPEAR_WAIT = 3.0;
export const DIALOG_FALLBACK_TIMEOUT = 5.0;

function abandonedTab(ctx: Ctx): (targetId: string) => void {
  return (late) => temptabs.mustClose(ctx.state, late, true);
}

export function tabLine(tab: TabRow, _session: string): string {
  const notes: string[] = [];
  if (tab.openedBy) notes.push(tab.openedBySession ? "opened by this session" : `opened by session ${tab.openedBy}`);
  const users = (Array.isArray(tab["usedBy"]) ? (tab["usedBy"] as unknown[]) : []).filter((user) => user !== tab["openedBy"]);
  if (users.length > 0) notes.push(`in use by session ${users.join(", ")}`);
  const app = tab.appTabId ? ` ${tab.appTabId} ` : "";
  const extra = notes.length > 0 ? ` (${notes.join("; ")})` : "";
  return `${tab.active ? "→" : " "} [${tab.tabId}]${app} ${String(tab.title || tab.url)} - ${String(tab.url)}${extra}`;
}

async function closeTab(ctx: Ctx, which: string | undefined): Promise<Result> {
  const state = ctx.state;
  await state.refreshTargets();
  const targetId = which !== undefined ? await state.findTab(which) : state.current;
  if (targetId === null) throw new BrowseError("This session has no current tab to close");
  if (state.mustClose.has(targetId)) {
    throw new BrowseError(`Tab [${state.tabId(targetId)}] is already being closed (an earlier \`tab close\` was interrupted)`, null, "tab_closing");
  }
  if (!state.opened.has(targetId)) {
    throw new BrowseError(`Tab [${state.tabId(targetId)}] is one of the user's tabs; ardia browse only closes tabs this session opened`);
  }
  if (!state.registry.reserveClose(state.instance, targetId)) {
    const users = state.registry.others(state.instance)[1].get(targetId) ?? [];
    const named = users.length > 0 ? users : ["another session"];
    throw new BrowseError(`Tab [${state.tabId(targetId)}] is in use by session ${named.join(", ")}, so it stays open`, null, "tab_in_use");
  }
  const tab = state.tabId(targetId);
  try {
    await (state.browser as Browser).send("Target.closeTarget", { targetId });
  } catch (error) {
    state.registry.releaseClose(state.instance, targetId);
    if (error instanceof Cancelled) {
      flag("tab_close_interrupted", true);
      temptabs.mustClose(state, targetId, true);
      if (state.current === targetId) state.current = null;
    }
    throw error;
  }
  state.registry.finishClose(state.instance, targetId);
  state.forgetTarget(targetId);
  return new Result({ closed: tab, targetId }, `✓ Tab [${tab}] closed`);
}

export async function cmdTab(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--label": "value", "--show": "bool" });
  const state = ctx.state;
  await state.connect();
  const action = args[0] ?? "list";
  if (action === "list") {
    await state.refreshTargets();
    const tabs = state.describeTabs(await appTabMap(state));
    return new Result({ tabs }, tabs.map((tab) => tabLine(tab, state.session)).join("\n") || "No tabs");
  }
  if (action === "new") {
    const label = (options["label"] as string | undefined) ?? null;
    const page = await newTab(ctx, args[1] ?? null, label, false, wantsShow(ctx, options), abandonedTab(ctx));
    return new Result({ tabId: state.tabId(page.targetId), targetId: page.targetId, url: page.url }, page.url || "about:blank");
  }
  if (action === "close") return closeTab(ctx, args[1]);
  let targetId: string;
  if (action === "active") {
    targetId = await state.takeActive();
  } else {
    await state.refreshTargets();
    targetId = await state.findTab(action);
    state.current = targetId;
    state.attached = null;
    if (state.pinTab) state.pinnedTarget = targetId;
  }
  let page = await state.page(targetId);
  if (wantsShow(ctx, options)) {
    page = await showTab(ctx, page);
    targetId = page.targetId;
  }
  const title = await pageTitle(page);
  await appTabMap(state);
  const data = { tabId: state.tabId(targetId), appTabId: state.appTabs.get(targetId) ?? null, targetId, title, url: page.url };
  return new Result(data, `✓ ${title}\n  ${page.url}${offscreenNote(state)}`);
}

export async function cmdWindow(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  if (args.length === 0 || args[0] !== "new") throw new Usage("Usage: ardia browse window new [url]");
  const page = await newTab(ctx, args[1] ?? null, null, true, false, abandonedTab(ctx));
  return new Result({ tabId: ctx.state.tabId(page.targetId), url: page.url }, page.url || "about:blank");
}

export async function elementBox(page: Page, element: Element): Promise<[number, number, number, number] | null> {
  let quads: unknown;
  try {
    quads = (await page.send("DOM.getContentQuads", { backendNodeId: element.backendId }))["quads"];
  } catch (error) {
    if (!(error instanceof CdpError) || !error.cdpMessage.includes("content quads")) throw error;
    return null;
  }
  let best: [number, number, number, number, number] | null = null;
  for (const quad of Array.isArray(quads) ? (quads as number[][]) : []) {
    const xs = quad.filter((_, index) => index % 2 === 0);
    const ys = quad.filter((_, index) => index % 2 === 1);
    const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    if (area > 1 && (best === null || area > best[0])) best = [area, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  return best === null ? null : [best[1], best[2], best[3], best[4]];
}

function pyRound(value: number): number {
  const floor = Math.floor(value);
  const rest = value - floor;
  if (rest > 0.5) return floor + 1;
  if (rest < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

export async function cmdFrame(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  need(args, 1, "frame <selector|@ref|name|url|main>");
  const state = ctx.state;
  let page = await state.page();
  await page.refreshFrames();
  const target = args[0] as string;
  if (target === "main") {
    state.frames.delete(page.targetId);
    return new Result({ frame: "main" });
  }
  let frameId: string | null = null;
  for (const frame of page.frames.values()) {
    if (frame.parent && (frame.name === target || frame.url === target || (frame.url.includes(target) && [...target].length > 3))) {
      frameId = frame.id;
      break;
    }
  }
  if (frameId === null) {
    let element: Element;
    [page, element] = await state.locate(target, null, APPEAR_WAIT);
    const described = await page.send("DOM.describeNode", { backendNodeId: element.backendId });
    const node = described["node"];
    const found = node !== null && typeof node === "object" ? (node as Record<string, unknown>)["frameId"] : undefined;
    frameId = typeof found === "string" && found ? found : null;
    if (frameId === null || !page.frames.has(frameId)) {
      const box = frameId !== null ? await elementBox(page, element) : null;
      if (box === null) throw new BrowseError(`${target} isn't an iframe this tab can reach (ardia browse doesn't attach cross-process iframes)`);
      flag("frame_cross_process_box", true);
      const [left, top, right, bottom] = box.map(pyRound) as [number, number, number, number];
      throw new BrowseError(
        `${target} is a cross-process iframe, which ardia browse can't enter, but the mouse reaches it: it sits at ` +
          `${left},${top} to ${right},${bottom} in the viewport. Click a point inside it with \`mouse move <x> <y>\`, ` +
          "`mouse down` and `mouse up` (in one batch), then `screenshot` to see what changed",
        { box: [left, top, right, bottom] },
        "cross_process_frame",
      );
    }
  }
  state.frames.set(page.targetId, frameId);
  return new Result({ frame: frameId, url: page.frames.get(frameId)?.url });
}

async function dismissLeftOpen(page: Page): Promise<void> {
  if (page.dialog === null || page.session === null) return;
  try {
    await page.send("Page.handleJavaScriptDialog", { accept: false }, { timeout: DIALOG_FALLBACK_TIMEOUT });
  } catch (error) {
    if (error instanceof ConnectionLost || error instanceof Cancelled) throw error;
    return;
  }
  page.dialog = null;
  flag("dialog_dismissed_after_failure", true);
}

export async function cmdDialog(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  const action = args[0] ?? "status";
  const page = await ctx.state.page();
  const dialog = page.dialog;
  if (action === "status") {
    if (!dialog) return new Result({ hasDialog: false }, "✓ No dialog is currently open");
    const message = dialog["message"] ?? "";
    return new Result(
      { hasDialog: true, type: dialog["type"] ?? null, message: dialog["message"] ?? null, defaultPrompt: dialog["defaultPrompt"] ?? null },
      `Dialog open: ${String(dialog["type"] ?? "None")} ${quote(String(message), false)}`,
      true,
    );
  }
  if (action !== "accept" && action !== "dismiss") throw new Usage("Usage: ardia browse dialog accept [text] | dismiss | status");
  if (!dialog) throw new BrowseError("No dialog is currently open");
  const params: Record<string, unknown> = { accept: action === "accept" };
  if (action === "accept" && args.length > 1) params["promptText"] = args.slice(1).join(" ");
  await shield(async () => {
    try {
      await page.send("Page.handleJavaScriptDialog", params);
    } catch (error) {
      if (!(error instanceof ConnectionLost)) await dismissLeftOpen(page);
      throw error;
    }
  });
  page.dialog = null;
  return new Result({ handled: action });
}

register("tab", cmdTab);
register("window", cmdWindow);
register("frame", cmdFrame);
register("dialog", cmdDialog);
