import { formatG } from "../../pylib/format.ts";
import { sleep } from "../cdp/cancel.ts";
import { BrowseError, Usage } from "../daemon-errors.ts";
import { unavailable } from "./link.ts";
import { Result } from "../daemon/render.ts";
import { need, parse, waitUntil } from "../daemon/stub/commands.ts";
import { type AxNode, buildTree, isAxList, type Node, ROLE_NAMES } from "../snapshot/tree.ts";
import { attach, axNodes, observe } from "./ax.ts";
import { clickElement, fillElement, type PluginCtx, PLUGIN_COMMANDS, type PluginHandler, pressIn } from "./commands.ts";
import { boxOf, center, describe, type Element, focus, locate } from "./dom.ts";
import { comboEvents, typeText, wheelAt } from "./input.ts";
import { type PluginPage } from "./page.ts";
import { ForeignRef, PluginRefused, type PluginSession } from "./session.ts";

export const SCROLL_DEFAULT = 300;
export const FIND_WAIT = 1.5;
export const MAX_CANDIDATES = 8;
const BLOCK_ROLES = new Set(["paragraph", "heading", "listitem", "list", "row", "table", "article", "region", "main", "navigation", "banner", "contentinfo", "form", "dialog", "alertdialog", "blockquote", "figure", "section", "Section", "LineBreak"]);
const FIND_ACTIONS = ["click", "fill", "type", "press", "check", "uncheck", "select", "hover", "focus", "dblclick", "text"];
const PLUGIN_FIND_ACTIONS = new Set(["click", "fill", "type", "press", "focus", "text"]);
const FIND_LOCATORS = ["role", "text", "label", "placeholder", "alt", "title", "testid", "first", "last", "nth"];
const LABELLED = new Set(["textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton", "listbox"]);
const HIDDEN_REASONS = new Set(["notRendered", "notVisible"]);

function plainText(text: string): string {
  return text.split(/\s+/u).filter((word) => word).join(" ").toLowerCase();
}

export function nodesText(nodes: readonly Node[]): string {
  const lines: string[] = [""];
  const visit = (node: Node) => {
    const block = BLOCK_ROLES.has(node.role);
    if (block && lines[lines.length - 1] !== "") lines.push("");
    if (node.role === "StaticText") lines[lines.length - 1] += node.name;
    for (const child of node.children) visit(child);
    if (block && lines[lines.length - 1] !== "") lines.push("");
  };
  for (const node of nodes) visit(node);
  return lines.map((line) => line.replace(/[ \t ]+/gu, " ").trim()).filter((line) => line).join("\n");
}

export function globMatch(pattern: string, url: string): boolean {
  if (pattern === url || (url.includes(pattern) && !pattern.includes("*"))) return true;
  let regex = "";
  for (let index = 0; index < pattern.length; ) {
    if (pattern.startsWith("**", index)) {
      regex += ".*";
      index += 2;
      continue;
    }
    const char = pattern[index] as string;
    regex += char === "*" ? "[^/]*" : char === "?" ? "." : char.replace(/[.*+?^${}()|[\]\\/-]/gu, "\\$&");
    index += 1;
  }
  return new RegExp(`^(?:${regex})$`, "su").test(url);
}

async function partialAx(element: Element): Promise<AxNode | null> {
  try {
    const nodes = (await element.page.send("Accessibility.getPartialAXTree", { backendNodeId: element.backend, fetchRelatives: false }))["nodes"];
    if (!isAxList(nodes)) return null;
    return nodes.find((node) => node["backendDOMNodeId"] === element.backend) ?? null;
  } catch (error) {
    if (unavailable(error)) return null;
    throw error;
  }
}

function axProp(node: AxNode | null, name: string): unknown {
  const list = node?.["properties"];
  if (!Array.isArray(list)) return undefined;
  const found = (list as Record<string, unknown>[]).find((prop) => prop["name"] === name);
  return (found?.["value"] as Record<string, unknown> | undefined)?.["value"];
}

async function elementText(element: Element): Promise<string> {
  return nodesText(buildTree(await axNodes(element.page), element.backend));
}

function innerHtml(outer: string): string {
  let quote: string | null = null;
  let end = -1;
  for (let index = 0; index < outer.length; index += 1) {
    const char = outer[index];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ">") {
      end = index;
      break;
    }
  }
  const close = outer.lastIndexOf("</");
  return end < 0 || close <= end ? "" : outer.slice(end + 1, close);
}

async function queryAll(page: PluginPage, selector: string): Promise<number[]> {
  const root = (await page.send("DOM.getDocument", { depth: 0 }))["root"] as Record<string, unknown> | undefined;
  let found: Record<string, unknown>;
  try {
    found = await page.send("DOM.querySelectorAll", { nodeId: root?.["nodeId"], selector });
  } catch (error) {
    if (unavailable(error)) throw new BrowseError(`Invalid selector ${selector}: ${error.cdpMessage}`);
    throw error;
  }
  const ids = Array.isArray(found["nodeIds"]) ? (found["nodeIds"] as number[]) : [];
  const backends: number[] = [];
  for (const nodeId of ids) {
    const node = (await page.send("DOM.describeNode", { nodeId }))["node"] as Record<string, unknown> | undefined;
    if (typeof node?.["backendNodeId"] === "number") backends.push(node["backendNodeId"]);
  }
  return backends;
}

function originOf(page: PluginPage): string {
  const origin = page.origin && page.origin !== "null" ? page.origin : "";
  return origin && !origin.endsWith("/") ? `${origin}/` : origin;
}

async function visible(element: Element): Promise<boolean> {
  const box = await boxOf(element);
  if (box === null || box.width <= 0 || box.height <= 0) return false;
  const node = await partialAx(element);
  const reasons = node?.["ignoredReasons"];
  return !(node?.["ignored"] && Array.isArray(reasons) && (reasons as Record<string, unknown>[]).some((reason) => HIDDEN_REASONS.has(String(reason["name"]))));
}

async function cmdGet(ctx: PluginCtx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  need(args, 1, "get text|html|value|attr|title|url|count|box|styles|cdp-url [selector]");
  const what = args[0] as string;
  if (what === "cdp-url" || what === "styles") throw new PluginRefused(`\`get ${what}\` isn't available to plugins`);
  const session = ctx.session;
  const page = await session.page();
  if (what === "title") {
    const title = await session.title(page);
    return new Result({ title }, title, true);
  }
  if (what === "url") {
    await page.refreshFrames();
    return new Result({ url: page.url }, page.url);
  }
  if (what === "count") {
    need(args, 2, "get count <selector>");
    const count = (await queryAll(page, args[1] as string)).length;
    return new Result({ count, selector: args[1] }, String(count));
  }
  if (!["text", "html", "value", "attr", "box"].includes(what)) throw new Usage(`Unknown get subcommand: ${what}`);
  need(args, 2, `get ${what} <selector>`);
  const element = await locate(session, args[1] as string);
  const origin = originOf(element.page);
  if (what === "text") {
    const value = await elementText(element);
    return new Result({ origin, text: value }, value, true);
  }
  if (what === "html") {
    const outer = String((await element.page.send("DOM.getOuterHTML", { backendNodeId: element.backend }))["outerHTML"] ?? "");
    const value = innerHtml(outer);
    return new Result({ origin, html: value }, value, true);
  }
  if (what === "value") {
    const node = await partialAx(element);
    const held = (node?.["value"] as Record<string, unknown> | undefined)?.["value"];
    const value = held === undefined || held === null ? null : String(held);
    return new Result({ value }, value ?? "", true);
  }
  if (what === "attr") {
    need(args, 3, "get attr <selector> <name>");
    const value = (await describe(element)).attributes.get((args[2] as string).toLowerCase()) ?? null;
    return new Result({ attribute: args[2], value }, value ?? "", true);
  }
  const box = await boxOf(element);
  if (box === null) throw new BrowseError(`${element.label} has no box on the page (it's hidden, collapsed or not rendered)`, null, "not_visible");
  const shown = Object.fromEntries(Object.entries(box).map(([key, value]) => [key, Number.isInteger(value) ? value : value]));
  const text = (["x", "y", "width", "height"] as const).map((key) => `${`${key}:`.padEnd(8)}${formatG(box[key])}`).join("\n");
  return new Result(shown, text);
}

async function cmdIs(ctx: PluginCtx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  need(args, 2, "is visible|enabled|checked <selector>");
  const what = args[0] as string;
  if (!["visible", "enabled", "checked"].includes(what)) throw new Usage(`Unknown is subcommand: ${what} (visible, enabled, checked)`);
  const element = await locate(ctx.session, args[1] as string);
  let value: boolean;
  if (what === "visible") value = await visible(element);
  else {
    const node = await partialAx(element);
    if (what === "enabled") {
      const disabled = axProp(node, "disabled");
      value = disabled === undefined ? !(await describe(element)).attributes.has("disabled") : !disabled;
    } else {
      const checked = axProp(node, "checked");
      value = checked === true || checked === "true" || checked === "mixed";
    }
  }
  return new Result({ origin: originOf(element.page), [what]: value }, value ? "true" : "false");
}

async function cmdType(ctx: PluginCtx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--no-humanize": "bool", "--delay": "value" });
  need(args, 2, "type <selector> <text>");
  const delay = options["delay"] === undefined ? 0 : Number(options["delay"]);
  if (!Number.isFinite(delay) || delay < 0) throw new Usage(`--delay takes milliseconds, not ${String(options["delay"])}`);
  const element = await locate(ctx.session, args[0] as string);
  return typeInto(ctx, element, args.slice(1).join(" "), delay, ctx.humanize && !options["no_humanize"], args[0] as string);
}

async function typeInto(ctx: PluginCtx, element: Element, text: string, delay: number, humanize: boolean, shown = element.label): Promise<Result> {
  const [, report] = await observe(ctx.session, element.page, ctx.options, async () => {
    await focus(element);
    await typeText(element.page, text, delay, humanize);
  });
  return attach(new Result({ typed: shown }), report);
}

async function viewportCenter(page: PluginPage): Promise<[number, number]> {
  try {
    const metrics = await page.send("Page.getLayoutMetrics");
    const viewport = (metrics["cssLayoutViewport"] ?? metrics["layoutViewport"]) as Record<string, unknown> | undefined;
    const width = Number(viewport?.["clientWidth"]);
    const height = Number(viewport?.["clientHeight"]);
    if (width > 0 && height > 0) return [width / 2, height / 2];
  } catch (error) {
    if (!unavailable(error)) throw error;
  }
  return [400, 300];
}

async function cmdScroll(ctx: PluginCtx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--selector": "value", "--no-humanize": "bool" }, { "-s": "--selector" });
  const direction = args[0] ?? "down";
  const amount = args.length > 1 ? Number(args[1]) : SCROLL_DEFAULT;
  if (!Number.isFinite(amount)) throw new Usage(`could not convert string to float: '${String(args[1])}'`);
  const deltas: Record<string, [number, number]> = { down: [0, amount], up: [0, -amount], right: [amount, 0], left: [-amount, 0] };
  const delta = deltas[direction];
  if (delta === undefined) throw new Usage(`Unknown direction: ${direction} (up, down, left, right)`);
  let page = await ctx.session.page();
  let point: [number, number];
  if (options["selector"]) {
    const element = await locate(ctx.session, options["selector"] as string);
    page = element.page;
    point = await center(element);
  } else point = await viewportCenter(page);
  const [, report] = await observe(ctx.session, page, ctx.options, () => wheelAt(page, point[0], point[1], delta[0], delta[1]));
  return attach(new Result({ scrolled: true }), report);
}

async function stateOf(session: PluginSession, selector: string, wanted: string): Promise<boolean> {
  let element: Element;
  try {
    element = await locate(session, selector);
  } catch (error) {
    if (error instanceof BrowseError && !(error instanceof ForeignRef) && (error.code === "not_found" || error.code === "stale_ref")) return wanted === "hidden" || wanted === "detached";
    throw error;
  }
  if (wanted === "attached") return true;
  if (wanted === "detached") return false;
  const shown = await visible(element);
  return wanted === "visible" ? shown : !shown;
}

async function cmdWait(ctx: PluginCtx, argv: string[]): Promise<Result> {
  const [options, args] = parse(
    argv,
    { "--text": "value", "--url": "value", "--load": "value", "--fn": "value", "--state": "value", "--timeout": "value", "--download": "bool" },
    { "-t": "--text", "-u": "--url", "-l": "--load", "-f": "--fn" },
  );
  if (options["fn"] !== undefined) throw new PluginRefused("`wait --fn` runs page script, which plugin mode never does");
  if (options["download"]) throw new PluginRefused("`wait --download` isn't available to plugins");
  const timeout = options["timeout"] ? Number(options["timeout"]) / 1000 : ctx.timeout;
  if (!Number.isFinite(timeout)) throw new Usage(`could not convert string to float: '${String(options["timeout"])}'`);
  if (Object.keys(options).length === 0 && args[0] !== undefined && /^\d+(\.\d+)?$/u.test(args[0])) {
    const ms = Number(args[0]);
    await sleep(ms / 1000);
    return new Result({ ms: Math.trunc(ms), waited: "timeout" });
  }
  const session = ctx.session;
  const page = await session.page();
  if (options["text"] !== undefined) {
    const wanted = String(options["text"]);
    await waitUntil(async () => nodesText(buildTree(await axNodes(page))).includes(wanted), timeout, 0.1, `text ${JSON.stringify(wanted)}`);
    return new Result({ text: wanted, waited: "text" }, wanted);
  }
  if (options["url"] !== undefined) {
    const pattern = String(options["url"]);
    await waitUntil(async () => {
      await page.refreshFrames();
      return globMatch(pattern, page.url);
    }, timeout, 0.1, `the URL to match ${pattern}`);
    return new Result({ url: page.url, waited: "url" }, page.url);
  }
  if (options["load"] !== undefined) {
    const until = String(options["load"]);
    const event = ({ load: "load", domcontentloaded: "DOMContentLoaded", networkidle: "networkIdle" } as Record<string, string>)[until];
    if (event === undefined) throw new Usage("--load takes load, domcontentloaded or networkidle");
    await page.refreshFrames();
    const loader = page.loader;
    await waitUntil(async () => page.reached(event, loader), timeout, 0.05, `the page to reach ${until}`);
    return new Result({ state: until });
  }
  need(args, 1, "wait <selector|ms> | --text | --url | --load | --fn");
  const selector = args[0] as string;
  const wanted = (options["state"] as string | undefined) || "visible";
  await waitUntil(() => stateOf(session, selector, wanted), timeout, 0.1, `${selector} to be ${wanted}`);
  return new Result({ selector, waited: "selector" });
}

function findArguments(given: string[], name: string | null): [string, string[], string | null] {
  let locator = given[0] as string;
  const args = given.slice(1);
  if (locator.includes("=") && FIND_LOCATORS.includes(locator.slice(0, locator.indexOf("=")))) {
    args.unshift(locator.slice(locator.indexOf("=") + 1));
    locator = locator.slice(0, locator.indexOf("="));
  }
  if (locator === "role" && args[0] !== undefined && FIND_ACTIONS.includes(args[0]) && args.length > 1 && !FIND_ACTIONS.includes(args[1] as string)) {
    [args[0], args[1]] = [args[1] as string, args[0]];
  }
  if (locator === "role" && name === null && args.length >= 2 && !FIND_ACTIONS.includes(args[1] as string)) name = args.splice(1, 1)[0] as string;
  return [locator, args, name];
}

type Candidate = { backend: number; role: string; name: string };

function axCandidates(raw: readonly AxNode[], keep: (role: string, name: string) => boolean): Candidate[] {
  const out: Candidate[] = [];
  for (const node of raw) {
    const backend = node["backendDOMNodeId"];
    if (node["ignored"] || typeof backend !== "number") continue;
    const role = String((node["role"] as Record<string, unknown> | undefined)?.["value"] ?? "");
    const shown = Object.hasOwn(ROLE_NAMES, role) ? (ROLE_NAMES[role] as string) : role;
    const name = String((node["name"] as Record<string, unknown> | undefined)?.["value"] ?? "").split(/\s+/u).filter((word) => word).join(" ");
    if (keep(shown, name)) out.push({ backend, role: shown, name });
  }
  return out;
}

function nameMatches(name: string, wanted: string, exact: boolean, partial: boolean): boolean {
  if (exact) return name === wanted.split(/\s+/u).filter((word) => word).join(" ");
  if (partial) return plainText(name).includes(plainText(wanted));
  return plainText(name) === plainText(wanted);
}

function attributeSelector(attribute: string, value: string, exact: boolean): string {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `[${attribute}${exact ? "" : "*"}="${escaped}"]`;
}

async function findOnce(ctx: PluginCtx, page: PluginPage, locator: string, value: string, name: string | null, exact: boolean, partial: boolean, index: number): Promise<Candidate> {
  const frame = page.mainFrame ?? "";
  const named = (candidates: Candidate[], what: string): Candidate => {
    if (candidates.length === 0) throw new BrowseError(`Element not found: ${what}`, null, "not_found");
    return candidates[0] as Candidate;
  };
  if (locator === "role") {
    const wanted = (Object.hasOwn(ROLE_NAMES, value) ? (ROLE_NAMES[value] as string) : value).toLowerCase();
    const raw = await axNodes(page);
    const ofRole = axCandidates(raw, (role) => role.toLowerCase() === wanted);
    if (name === null) return named(ofRole, `role=${value}`);
    let found = ofRole.filter((item) => nameMatches(item.name, name, exact, partial));
    let how = exact ? "exact" : partial ? "partial" : "exact";
    if (found.length === 0 && !exact && !partial) {
      found = ofRole.filter((item) => plainText(item.name).includes(plainText(name)));
      how = "partial";
    }
    if (found.length === 1) return found[0] as Candidate;
    if (found.length === 0) {
      const names = [...new Set(ofRole.map((item) => item.name).filter((text) => text))].slice(0, MAX_CANDIDATES);
      const hint = names.length ? `; the ${value}s here are: ${names.map((text) => `"${text}"`).join(", ")}` : "";
      throw new BrowseError(`No ${value} named "${name}" on this page${hint}`, { candidates: names }, "not_found");
    }
    const listed = found.slice(0, MAX_CANDIDATES).map((item) => {
      const ref = ctx.session.refFor(page, frame, item.backend);
      ctx.session.keepRef({ id: ref, target: page.targetId, frame, loader: page.loader ?? "", backend: item.backend, role: item.role, name: item.name });
      return { ref: `@${ref}`, name: item.name };
    });
    const more = found.length > MAX_CANDIDATES ? ` (and ${found.length - MAX_CANDIDATES} more)` : "";
    const kind = how === "exact" ? "are named exactly" : "have names containing";
    const fix = how === "exact" ? "Use one of their refs" : "Use a ref, or the full name";
    const lines = listed.map((item) => `  ${value} "${item.name}" [ref=${item.ref.slice(1)}]`).join("\n");
    throw new BrowseError(`${found.length} ${value}s ${kind} "${name}"${more}, so nothing was clicked. ${fix}:\n${lines}`, { candidates: listed }, "ambiguous");
  }
  if (locator === "text") {
    const raw = await axNodes(page);
    return named(axCandidates(raw, (role, text) => role === "StaticText" && nameMatches(text, value, exact, !exact)), `text ${value}`);
  }
  if (locator === "label") {
    const raw = await axNodes(page);
    return named(axCandidates(raw, (role, text) => LABELLED.has(role) && nameMatches(text, value, exact, !exact)), `label ${value}`);
  }
  if (["placeholder", "alt", "title", "testid"].includes(locator)) {
    const attribute = locator === "testid" ? "data-testid" : locator;
    const backends = await queryAll(page, attributeSelector(attribute, value, exact || locator === "testid"));
    return named(backends.map((backend) => ({ backend, role: "", name: "" })), `${locator} ${value}`);
  }
  if (["first", "last", "nth"].includes(locator)) {
    const backends = await queryAll(page, value);
    const at = locator === "first" ? 0 : locator === "last" ? backends.length - 1 : index < 0 ? backends.length + index : index;
    return named(at >= 0 && at < backends.length ? [{ backend: backends[at] as number, role: "", name: "" }] : [], `${locator} ${value}`);
  }
  throw new Usage(`Unknown locator: ${locator} (role, text, label, placeholder, alt, title, testid, first, last, nth)`);
}

async function cmdFind(ctx: PluginCtx, argv: string[]): Promise<Result> {
  const [options, given] = parse(argv, { "--name": "value", "--exact": "bool", "--partial": "bool", "--no-humanize": "bool" });
  need(given, 1, "find <locator> <value> [action] [text]");
  const exact = Boolean(options["exact"]);
  const partial = Boolean(options["partial"]);
  if (exact && partial) throw new Usage("find takes --exact or --partial, not both");
  const [locator, args, name] = findArguments(given, (options["name"] as string | undefined) ?? null);
  need(args, 1, "find <locator> <value> [action] [text]");
  let index = 0;
  let value: string;
  let rest: string[];
  if (locator === "nth") {
    need(args, 2, "find nth <index> <selector> [action] [text]");
    if (!/^[-+]?\d+$/u.test((args[0] as string).trim())) throw new Usage(`invalid literal for int() with base 10: '${args[0] as string}'`);
    index = Number(args[0]);
    value = args[1] as string;
    rest = args.slice(2);
  } else {
    value = args[0] as string;
    rest = args.slice(1);
  }
  const action = rest[0] ?? "click";
  if (!FIND_ACTIONS.includes(action)) throw new Usage(`Unknown action '${action}' for find. Valid actions: ${FIND_ACTIONS.join(", ")}.`);
  if (!PLUGIN_FIND_ACTIONS.has(action)) throw new PluginRefused(`\`find … ${action}\` isn't available to plugins yet (click, fill, type, press, focus and text are)`);
  const page = await ctx.session.page();
  const deadline = performance.now() / 1000 + FIND_WAIT;
  let found: Candidate;
  for (;;) {
    try {
      found = await findOnce(ctx, page, locator, value, name, exact, partial, index);
      break;
    } catch (error) {
      if (!(error instanceof BrowseError) || error.code !== "not_found" || performance.now() / 1000 >= deadline) throw error;
    }
    await sleep(0.15);
  }
  const frame = page.mainFrame ?? "";
  const ref = ctx.session.refFor(page, frame, found.backend);
  ctx.session.keepRef({ id: ref, target: page.targetId, frame, loader: page.loader ?? "", backend: found.backend, role: found.role, name: found.name });
  const element: Element = { page, backend: found.backend, frame, label: `@${ref}`, role: found.role, name: found.name };
  const humanize = ctx.humanize && !options["no_humanize"];
  if (action === "click") return clickElement(ctx, element);
  if (action === "fill") return fillElement(ctx, element, rest.slice(1).join(" "), humanize);
  if (action === "type") return typeInto(ctx, element, rest.slice(1).join(" "), 0, humanize);
  if (action === "press") {
    const key = rest[1] ?? "Enter";
    comboEvents(key);
    return pressIn(ctx, element, key);
  }
  if (action === "focus") {
    const [, report] = await observe(ctx.session, page, ctx.options, async () => {
      await focus(element);
    });
    return attach(new Result({ focused: element.label }), report);
  }
  const text = await elementText(element);
  return new Result({ ref: element.label, text }, text, true);
}

export function findAction(argv: string[]): string {
  const [options, given] = parse(argv, { "--name": "value", "--exact": "bool", "--partial": "bool", "--no-humanize": "bool" });
  if (given.length === 0) return "click";
  const [locator, args] = findArguments(given, (options["name"] as string | undefined) ?? null);
  return (locator === "nth" ? args[2] : args[1]) ?? "click";
}

export const PHASE_TWO: Record<string, PluginHandler> = {
  get: cmdGet,
  is: cmdIs,
  type: cmdType,
  scroll: cmdScroll,
  wait: cmdWait,
  find: cmdFind,
};

export const ALL_PLUGIN_COMMANDS: Record<string, PluginHandler> = { ...PLUGIN_COMMANDS, ...PHASE_TWO };
