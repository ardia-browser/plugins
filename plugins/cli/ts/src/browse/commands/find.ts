import { SequenceMatcher } from "../../pylib/difflib.ts";
import { casefold } from "../../pylib/unicode.ts";
import { joinedWords } from "../../pylib/str.ts";
import { sleep } from "../cdp/cancel.ts";
import { BrowseError, Usage } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import { flag } from "../metrics.ts";
import { pyIntArg } from "../pyerror.ts";
import { shownName } from "../snapshot/render.ts";
import { ROLE_NAMES } from "../snapshot/tree.ts";
import type { Element, Page } from "../state/page.ts";
import { record } from "../state/records.ts";
import { monotonic } from "../state/wait.ts";
import type { Ctx } from "./ctx.ts";
import { register } from "./index.ts";
import { findAct } from "../act/find-act.ts";
import { need, parse } from "./parse.ts";
import { frameOrMain } from "./shared.ts";

export const FIND_ACTIONS = ["click", "fill", "type", "press", "check", "uncheck", "select", "hover", "focus", "dblclick", "text"];
export const FIND_LOCATORS = ["role", "text", "label", "placeholder", "alt", "title", "testid", "first", "last", "nth"];
export const MAX_CANDIDATES = 8;
export const CLOSE_ENOUGH = 0.6;
export const FIND_WAIT = 1.5;
const TEXT_OF = "(el) => (el.innerText != null ? el.innerText : el.textContent || '').trim()";
const WORDS = /[\p{L}\p{N}\p{Mn}\p{Mc}\p{Pc}]+/gu;

export type FindAct = (ctx: Ctx, page: Page, element: Element, ref: string, action: string, rest: string[], humanize: boolean) => Promise<Result>;
export const findActions: { act: FindAct } = { act: (ctx, page, element, ref, action, rest, humanize) => findAct(ctx, page, element, ref, action, rest, humanize) };

export function findArguments(given: readonly string[], name: string | null): [string, string[], string | null] {
  let locator = given[0] as string;
  const args = given.slice(1);
  let wanted = name;
  const at = locator.indexOf("=");
  if (at >= 0 && FIND_LOCATORS.includes(locator.slice(0, at))) {
    args.unshift(locator.slice(at + 1));
    locator = locator.slice(0, at);
  }
  if (locator === "role" && args.length > 1 && FIND_ACTIONS.includes(args[0] as string) && !FIND_ACTIONS.includes(args[1] as string)) {
    [args[0], args[1]] = [args[1] as string, args[0] as string];
  }
  if (locator === "role" && wanted === null && args.length >= 2 && !FIND_ACTIONS.includes(args[1] as string)) wanted = args.splice(1, 1)[0] as string;
  return [locator, args, wanted];
}

export function plain(text: unknown): string {
  return casefold(joinedWords(String(text ?? "")));
}

type Candidate = [Record<string, unknown>, string];

function axText(item: unknown): string {
  const value = record(item)["value"];
  return value === null || value === undefined || value === "" || value === false || value === 0 ? "" : String(value);
}

export function roleCandidates(nodes: readonly unknown[], role: string, name: string | null, exact: boolean): [Candidate[], string] {
  const wanted = (ROLE_NAMES[role] ?? role).toLowerCase();
  const ofRole: Candidate[] = [];
  for (const raw of nodes) {
    const node = record(raw);
    if (node["ignored"] || node["backendDOMNodeId"] === null || node["backendDOMNodeId"] === undefined) continue;
    const nodeRole = axText(node["role"]);
    if ((ROLE_NAMES[nodeRole] ?? nodeRole).toLowerCase() === wanted) ofRole.push([node, joinedWords(axText(node["name"]))]);
  }
  if (name === null) return [ofRole, "role"];
  const target = plain(name.endsWith("…") ? name.slice(0, -1) : name);
  if (name.endsWith("…")) {
    const starting = ofRole.filter(([, text]) => plain(text).startsWith(target));
    if (starting.length) return [starting, "partial"];
  }
  const same = ofRole.filter(([, text]) => (exact ? text === joinedWords(name) : plain(text) === target));
  if (same.length || exact) return [same, "exact"];
  return [ofRole.filter(([, text]) => plain(text).includes(target)), "partial"];
}

export function closestNames(wanted: string, names: readonly string[]): string[] {
  const target = plain(wanted);
  const words = new Set(target.match(WORDS) ?? []);
  const likeness = (text: string) => {
    const own = plain(text);
    const mine = new Set(own.match(WORDS) ?? []);
    const shared = [...words].filter((word) => mine.has(word)).length / Math.max(words.size, 1);
    return shared + new SequenceMatcher(target, own).ratio();
  };
  const scores = names.map(likeness);
  const ranked = [...names.keys()].sort((a, b) => (scores[b] as number) - (scores[a] as number) || a - b);
  if (ranked.length && (scores[ranked[0] as number] as number) >= CLOSE_ENOUGH) {
    flag("find_closest_names", true);
    return ranked.slice(0, MAX_CANDIDATES).map((index) => names[index] as string);
  }
  return names.slice(0, MAX_CANDIDATES);
}

async function nthOfRole(page: Page, frame: string, role: string, found: Candidate[], nth: number, shown: string): Promise<[Element, string, string]> {
  const resolved: [Element, string][] = [];
  for (const [node, nodeName] of found) {
    const element = await page.resolveBackend(Number(node["backendDOMNodeId"]), frame, `role=${role}`);
    if (element !== null) resolved.push([element, nodeName]);
    if (resolved.length > nth) break;
  }
  const picked = resolved[nth];
  if (picked === undefined) {
    const count = resolved.length;
    throw new BrowseError(`--nth ${nth} asks for match ${nth + 1}, and only ${count} ${shown} element${count === 1 ? "" : "s"} match (--nth counts from 0)`, { matches: count }, "not_found");
  }
  return [picked[0], shown, picked[1]];
}

export async function findRole(
  ctx: Ctx,
  page: Page,
  frame: string,
  role: string,
  name: string | null,
  exact: boolean,
  nth: number | null = null,
): Promise<[Element, string, string]> {
  const tree = await page.send("Accessibility.getFullAXTree", { frameId: frame }, { timeout: 60, session: page.sessionFor(frame) });
  const nodes = Array.isArray(tree["nodes"]) ? tree["nodes"] : [];
  const [found, how] = roleCandidates(nodes, role, name, exact);
  const shown = ROLE_NAMES[role] ?? role;
  if (nth !== null) return nthOfRole(page, frame, role, found, nth, shown);
  const resolved: [Element, string][] = [];
  for (const [node, nodeName] of found.slice(0, MAX_CANDIDATES + 1)) {
    const element = await page.resolveBackend(Number(node["backendDOMNodeId"]), frame, `role=${role}`);
    if (element !== null) resolved.push([element, nodeName]);
  }
  if (resolved.length === 1 || (resolved.length && name === null)) {
    const [element, nodeName] = resolved[0] as [Element, string];
    return [element, shown, nodeName];
  }
  if (resolved.length === 0) {
    const names = [...new Set(roleCandidates(nodes, role, null, false)[0].map(([, text]) => text).filter((text) => text))];
    const close = name !== null ? closestNames(name, names) : names.slice(0, MAX_CANDIDATES);
    const named = name !== null ? ` named "${name}"` : "";
    const hint = close.length && name !== null ? `; the ${shown}s here are: ${close.map((text) => `"${shownName(text)}"`).join(", ")}` : "";
    throw new BrowseError(`No ${shown}${named} on this page${hint}`, { candidates: close }, "not_found");
  }
  const listed = resolved.slice(0, MAX_CANDIDATES).map(([element, nodeName]) => ({ ref: `@${ctx.state.addRef(page, element, shown, nodeName)}`, name: nodeName }));
  const more = found.length > MAX_CANDIDATES ? ` (and ${found.length - MAX_CANDIDATES} more)` : "";
  const kind = how === "exact" ? "are named exactly" : "have names containing";
  const fix = how === "exact" ? "Use one of their refs (or --nth <n>, from 0)" : "Use a ref, or the full name (or --nth <n>, from 0)";
  const lines = listed.map((item) => `  ${shown} "${shownName(item.name)}" [ref=${item.ref.slice(1)}]`).join("\n");
  throw new BrowseError(`${found.length} ${shown}s ${kind} "${name}"${more}, so nothing was clicked. ${fix}:\n${lines}`, { candidates: listed }, "ambiguous");
}

export async function cmdFind(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, given] = parse(argv, { "--name": "value", "--exact": "bool", "--partial": "bool", "--no-humanize": "bool", "--nth": "value" });
  need(given, 1, "find <locator> <value> [action] [text]");
  if (options["exact"] && options["partial"]) throw new Usage("find takes --exact or --partial, not both");
  const [locator, args, wantedName] = findArguments(given, (options["name"] as string | undefined) ?? null);
  need(args, 1, "find <locator> <value> [action] [text]");
  const nth = options["nth"] === undefined ? null : pyIntArg(String(options["nth"]));
  if (nth !== null && locator !== "role") throw new Usage(`--nth works with find role; for a CSS selector use \`find nth <n> <selector>\``);
  if (nth !== null && nth < 0) throw new Usage("--nth counts from 0, so it takes 0 or more");
  if (nth !== null) flag("guessed_syntax", true);
  const page = await ctx.state.page();
  const frame = frameOrMain(ctx, page);
  const exact = Boolean(options["exact"]);
  let index = 0;
  let value: string;
  let rest: string[];
  if (locator === "nth") {
    need(args, 2, "find nth <index> <selector> [action] [text]");
    index = pyIntArg(args[0] as string);
    value = args[1] as string;
    rest = args.slice(2);
  } else {
    value = args[0] as string;
    rest = args.slice(1);
  }
  const fromRemote = async (fn: string, values: unknown[], label: string) =>
    page.elementFrom(await page.call(fn, values, { frame, byValue: false, read: true }), frame, label);
  const locate = async (): Promise<[Element, string, string]> => {
    let element: Element | null = null;
    let role = "";
    let name = "";
    if (locator === "role") [element, role, name] = await findRole(ctx, page, frame, value, wantedName, exact, nth);
    else if (locator === "text") element = await fromRemote("(t, e) => ardiaBrowse.findText(t, e)", [value, exact], `text=${value}`);
    else if (locator === "label") element = await fromRemote("(t, e) => ardiaBrowse.findLabel(t, e)", [value, exact], `label=${value}`);
    else if (locator === "placeholder" || locator === "alt" || locator === "title") {
      element = await fromRemote("(a, t, e) => ardiaBrowse.findAttr(a, t, e)", [locator, value, exact], `${locator}=${value}`);
    } else if (locator === "testid") element = await fromRemote("(t) => ardiaBrowse.findAttr('data-testid', t, true)", [value], `testid=${value}`);
    else if (locator === "first" || locator === "last" || locator === "nth") {
      const position = locator === "first" ? 0 : locator === "last" ? -1 : index;
      element = await fromRemote("(s, i) => { const all = ardiaBrowse.queryAll(s); return all.at(i) || null; }", [value, position], `${locator} ${value}`);
    } else throw new Usage(`Unknown locator: ${locator} (role, text, label, placeholder, alt, title, testid, first, last, nth)`);
    if (element === null) throw new BrowseError(`Element not found: ${locator} ${value}`, null, "not_found");
    return [element, role, name];
  };
  const deadline = monotonic() + FIND_WAIT;
  let found: [Element, string, string];
  for (;;) {
    try {
      found = await locate();
      break;
    } catch (error) {
      if (!(error instanceof BrowseError) || error.code !== "not_found" || monotonic() >= deadline) throw error;
    }
    await sleep(0.15);
  }
  const [element, role, name] = found;
  const action = rest[0] ?? "click";
  if (!FIND_ACTIONS.includes(action)) throw new Usage(`Unknown action '${action}' for find. Valid actions: ${FIND_ACTIONS.join(", ")}.`);
  const ref = ctx.state.addRef(page, element, role, name);
  element.label = `@${ref}`;
  if (action !== "text") {
    return findActions.act(ctx, page, element, ref, action, rest, ctx.humanize && !options["no_humanize"]);
  }
  const text = await page.call(TEXT_OF, [element], { frame: element.frame });
  return new Result({ ref: `@${ref}`, text }, String(text ?? ""), true);
}

register("find", cmdFind);
