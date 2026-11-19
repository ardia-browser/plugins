import { BrowseError, Usage } from "../daemon-errors.ts";
import { flag } from "../metrics.ts";
import { Result, type Options } from "../daemon/render.ts";
import { need, parse } from "../daemon/stub/commands.ts";
import { render as renderSnapshot } from "../snapshot/render.ts";
import { diff as diffViews } from "../changes/report.ts";
import { asData, renderReport } from "../changes/text.ts";
import { type Node, walk } from "../snapshot/tree.ts";
import { type PluginPage } from "./page.ts";
import { attach, collect, keepRefs, noteShown, observe, onlyTheFieldChanged, previous, remember } from "./ax.ts";
import { center, describe, editable, focus, locate, notEditable } from "./dom.ts";
import { buttonOf, clearField, clickAt, comboEvents, pressCombo, typeText } from "./input.ts";
import { type PluginSession, PluginRefused } from "./session.ts";

export const NO_REACTION_HINT =
  "\n→ Nothing else on the page changed yet. Some fields only apply when you press Enter or leave them: `press Enter` or `press Tab`, then check again";
export const DOCUMENT_CHANGED = "The page loaded a new document, so this step didn't count. Ardia checks it again for the next step";
export const DOCUMENT_CHANGED_AFTER =
  "The page loaded a new document during or after this step, so the step ran but what it did may not hold; check the page before going on. Ardia checks it again for the next step";
const PLAIN_INPUTS = new Set(["text", "number", "search", "tel"]);

export class PluginCtx {
  constructor(
    readonly session: PluginSession,
    readonly options: Options,
    readonly command: string,
  ) {}

  get humanize(): boolean {
    return Boolean(this.options["humanize"]);
  }
}

export type PluginHandler = (ctx: PluginCtx, argv: string[]) => Promise<Result>;

function tabLine(tab: Record<string, unknown>): string {
  return `${tab["active"] ? "→" : " "} [${String(tab["tabId"])}] ${String(tab["title"] || tab["url"])} - ${String(tab["url"])}`;
}

async function cmdTab(ctx: PluginCtx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--label": "value", "--show": "bool" });
  if (options["label"] !== undefined || options["show"]) throw new PluginRefused("`tab --label` and `tab --show` aren't available to plugins");
  const session = ctx.session;
  const action = args[0] ?? "list";
  if (action === "list") {
    const pages = await session.refreshTargets();
    const tabs = pages.map((info) => {
      const targetId = String(info["targetId"]);
      return { tabId: session.tabId(targetId), appTabId: null, label: null, targetId, title: String(info["title"] ?? ""), url: String(info["url"] ?? ""), type: "page", active: targetId === session.current, openedBySession: false, openedBy: null, usedBy: [] };
    });
    return new Result({ tabs }, tabs.map(tabLine).join("\n") || "No tabs");
  }
  if (["new", "close", "active"].includes(action)) throw new PluginRefused(`\`tab ${action}\` isn't available to plugins: Ardia picks the activity's tabs`);
  const targetId = await session.findTab(action);
  session.current = targetId;
  const page = await session.page(targetId);
  const title = await session.title(page);
  const data = { tabId: session.tabId(targetId), appTabId: null, targetId, title, url: page.url, loader: page.loader };
  return new Result(data, `✓ ${title}\n  ${page.url}`);
}

function depthOf(given: unknown): number | null {
  if (given === undefined || given === null) return null;
  const text = String(given).trim();
  if (!/^[-+]?[0-9]+$/u.test(text)) throw new Usage(`invalid literal for int() with base 10: '${String(given)}'`);
  return Number(text);
}

async function linkUrls(page: PluginPage, nodes: readonly Node[]): Promise<void> {
  for (const node of nodes) {
    if (node.role !== "link" || node.backend === null) continue;
    const found = await describe({ page, backend: node.backend, frame: node.frame ?? "", label: "", role: node.role, name: node.name });
    const href = found.attributes.get("href");
    if (href === undefined) continue;
    try {
      node.url = new URL(href, page.url).href;
    } catch {
      node.url = href;
    }
  }
}

async function cmdSnapshot(ctx: PluginCtx, argv: string[]): Promise<Result> {
  const [options, args] = parse(
    argv,
    { "--interactive": "bool", "--compact": "bool", "--depth": "value", "--selector": "value", "--urls": "bool", "--cursor": "bool", "--diff": "bool" },
    { "-i": "--interactive", "-c": "--compact", "-d": "--depth", "-s": "--selector", "-u": "--urls", "-C": "--cursor" },
  );
  if (options["cursor"]) throw new PluginRefused("`snapshot --cursor` reads computed styles, which plugin mode never does");
  const selector = (options["selector"] as string | undefined) || args[0] || null;
  const depth = depthOf(options["depth"]);
  if (options["diff"] && (selector || depth !== null)) throw new Usage("snapshot --diff compares the whole page, so it takes no -s or -d");
  const session = ctx.session;
  const page = await session.page();
  await page.refreshFrames();
  const before = options["diff"] ? previous(session, page) : null;
  const scope = selector ? (await locate(session, selector)).backend : null;
  const nodes = await collect(session, page, scope);
  if (selector && nodes.length === 0) throw new BrowseError(`Nothing in the accessibility tree under ${selector}: the element matching it is hidden or empty`);
  const urls = Boolean(options["urls"]);
  if (urls) await linkUrls(page, [...walk(nodes)]);
  const text = renderSnapshot(nodes, { interactive: Boolean(options["interactive"]), compact: Boolean(options["compact"]), depth, urls });
  keepRefs(session, page, nodes, true);
  if (!selector && depth === null) noteShown(session, await remember(session, page, nodes));
  const origin = page.origin && page.origin !== "null" ? page.origin : page.url;
  const data: Record<string, unknown> = { origin: origin.endsWith("/") ? origin : `${origin}/`, refs: session.refsJson(), snapshot: text };
  let body = text || "(empty page)";
  if (options["diff"]) {
    if (before === null) {
      data["changes"] = null;
      body = `(no earlier snapshot of this document in this session, so here is all of it)\n${body}`;
    } else {
      const report = diffViews(before, session.views.get(page.targetId) ?? before);
      data["changes"] = asData(report);
      body = renderReport(report);
    }
  }
  return new Result(data, body, true);
}

async function cmdClick(ctx: PluginCtx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--new-tab": "bool", "--button": "value", "--no-humanize": "bool" });
  if (options["new_tab"]) throw new PluginRefused("`click --new-tab` isn't available to plugins");
  need(args, 1, "click <selector> [--new-tab]");
  const button = buttonOf(options["button"]);
  const element = await locate(ctx.session, args[0] as string);
  const [, report] = await observe(ctx.session, element.page, ctx.options, async () => {
    const [x, y] = await center(element);
    await clickAt(element.page, x, y, button);
  });
  return attach(new Result({ clicked: args[0] }), report);
}

async function cmdFill(ctx: PluginCtx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--no-humanize": "bool" });
  need(args, 2, "fill <selector> <text>");
  const element = await locate(ctx.session, args[0] as string);
  const text = args.slice(1).join(" ");
  const humanize = ctx.humanize && !options["no_humanize"];
  const described = await describe(element);
  if (!editable(described)) throw new BrowseError(notEditable(element, described), null, "not_editable");
  const [, report] = await observe(ctx.session, element.page, ctx.options, async () => {
    await focus(element);
    await clearField(element.page);
    if (!text) return;
    if (humanize) await typeText(element.page, text, 0, true);
    else {
      flag("fill_inserted_text", true);
      await element.page.send("Input.insertText", { text });
    }
  });
  let result = attach(new Result({ filled: args[0] }), report);
  const type = (described.attributes.get("type") || "text").toLowerCase();
  if (text && described.tag === "input" && PLAIN_INPUTS.has(type) && onlyTheFieldChanged(report)) {
    flag("fill_no_reaction_hint", true);
    result = new Result(result.data, `${result.text}${NO_REACTION_HINT}`, result.pageContent);
  }
  return result;
}

async function cmdPress(ctx: PluginCtx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv, { "--no-humanize": "bool" });
  need(args, 1, "press [selector] <key>");
  if (args.length >= 2) {
    const key = args[1] as string;
    comboEvents(key);
    const element = await locate(ctx.session, args[0] as string);
    flag("press_targeted", true);
    const [, report] = await observe(ctx.session, element.page, ctx.options, async () => {
      await focus(element);
      await pressCombo(element.page, key);
    });
    return attach(new Result({ pressed: key, in: args[0] }), report);
  }
  const key = args[0] as string;
  comboEvents(key);
  const page = await ctx.session.page();
  const [, report] = await observe(ctx.session, page, ctx.options, () => pressCombo(page, key));
  return attach(new Result({ pressed: key }), report);
}

export const PLUGIN_COMMANDS: Record<string, PluginHandler> = {
  tab: cmdTab,
  snapshot: cmdSnapshot,
  click: cmdClick,
  fill: cmdFill,
  press: cmdPress,
};

async function loaderNow(session: PluginSession): Promise<string | null> {
  const page = session.current === null ? undefined : session.pages.get(session.current);
  if (page === undefined || page.sessionId === null) return null;
  await page.refreshFrames();
  return page.loader;
}

export async function runPluginCommand(session: PluginSession, options: Options, name: string, argv: string[], commands: Record<string, PluginHandler> = PLUGIN_COMMANDS): Promise<Result> {
  const handler = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (handler === undefined) throw new PluginRefused(`\`${name}\` isn't available to plugins`);
  const ctx = new PluginCtx(session, options, name);
  const expected = typeof options["expect_loader"] === "string" && options["expect_loader"] ? options["expect_loader"] : null;
  if (expected !== null && name !== "tab") {
    await session.page();
    if ((await loaderNow(session)) !== expected) {
      flag("plugin_loader_before", true);
      throw new BrowseError(DOCUMENT_CHANGED, null, "document_changed");
    }
  }
  const result = await handler(ctx, argv);
  if (expected !== null && name !== "tab" && (await loaderNow(session)) !== expected) {
    flag("plugin_loader_after", true);
    throw new BrowseError(DOCUMENT_CHANGED_AFTER, { ran: true }, "document_changed_after");
  }
  return result;
}
