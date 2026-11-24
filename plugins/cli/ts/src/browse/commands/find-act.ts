import { BrowseError } from "../daemon-errors.ts";
import { flag } from "../metrics.ts";
import { sendIn } from "../state/frames.ts";
import type { Element, Page } from "../state/page.ts";
import * as pierce from "../state/pierce.ts";
import { parseRef } from "../state/refs.ts";
import type { Ctx } from "./ctx.ts";

export const WITHIN_FLAG = { "--within": "value" } as const;
export const MAX_LISTED = 8;

export type Scope = { page: Page; container: Element; label: string; backends: Set<number> };
export type Match = { element: Element; text: string };

const WALKER = `const fold = (s) => String(s == null ? "" : s).replace(/\\s+/g, " ").trim();
  const lower = (s) => fold(s).toLowerCase();
  const visible = (el) => {
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  };
  const descendants = (root) => {
    const out = [];
    const walk = (node) => {
      for (const el of node.querySelectorAll("*")) {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    if (root.shadowRoot) walk(root.shadowRoot);
    walk(root);
    return out;
  };
  const shown = (el) => fold(el.innerText != null && el.innerText !== "" ? el.innerText : el.textContent);
  const INTERACTIVE = "a[href],area[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=spinbutton],[contenteditable=''],[contenteditable=true],[tabindex]:not([tabindex='-1'])";`;

export const CONTAINERS_BY_TEXT = `(wanted) => {
  ${WALKER}
  const target = lower(wanted);
  if (!target) return [];
  const SEMANTIC = "tr,li,article,section,dialog,form,fieldset,details,[role=row],[role=listitem],[role=article],[role=dialog],[role=alertdialog],[role=group],[role=region],[role=gridcell],[role=treeitem],[role=option],[class*=card i],[class*=item i],[class*=row i],[class*=entry i],[class*=tile i]";
  const all = descendants(document.documentElement);
  const holds = (el) => lower(shown(el)).includes(target) || lower(el.getAttribute("aria-label")).includes(target) || lower(el.getAttribute("title")).includes(target);
  const innermost = (list) => list.filter((el) => !list.some((other) => other !== el && el.contains(other)));
  const semantic = all.filter((el) => el.matches(SEMANTIC) && visible(el) && holds(el));
  const acting = innermost(semantic.filter((el) => el.querySelector(INTERACTIVE)));
  if (acting.length) return acting.slice(0, 20);
  const plain = innermost(semantic);
  if (plain.length) return plain.slice(0, 20);
  const leaves = innermost(all.filter((el) => visible(el) && holds(el)));
  const lifted = [];
  for (const leaf of leaves) {
    let node = leaf;
    while (node && node !== document.body && node !== document.documentElement && !node.querySelector(INTERACTIVE)) node = node.parentElement || (node.parentNode && node.parentNode.host) || null;
    if (node && node !== document.body && node !== document.documentElement && !lifted.includes(node)) lifted.push(node);
  }
  return innermost(lifted).slice(0, 20);
}`;

export const SCOPED_MATCH = `(root, kind, value, exact, role) => {
  ${WALKER}
  const scope = root || document.documentElement;
  const all = descendants(scope);
  const ROLE_SELECTORS = {
    button: "button,[role=button],input[type=button],input[type=submit],input[type=reset],input[type=image],summary",
    link: "a[href],area[href],[role=link]",
    checkbox: "input[type=checkbox],[role=checkbox]",
    radio: "input[type=radio],[role=radio]",
    switch: "[role=switch]",
    textbox: "input:not([type]),input[type=text],input[type=email],input[type=search],input[type=tel],input[type=url],input[type=password],input[type=number],textarea,[role=textbox],[contenteditable=''],[contenteditable=true]",
    searchbox: "input[type=search],[role=searchbox]",
    combobox: "select,[role=combobox]",
    listbox: "select[multiple],[role=listbox]",
    menuitem: "[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio]",
    tab: "[role=tab]",
    option: "option,[role=option]",
    heading: "h1,h2,h3,h4,h5,h6,[role=heading]",
    listitem: "li,[role=listitem]",
    row: "tr,[role=row]",
    cell: "td,[role=cell],[role=gridcell]",
    gridcell: "td,[role=gridcell]",
    img: "img,[role=img]",
    image: "img,[role=img]",
    dialog: "dialog,[role=dialog],[role=alertdialog]",
  };
  const fields = (el) => [shown(el), el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("data-testid"), el.getAttribute("placeholder"), el.getAttribute("alt"), el.tagName === "INPUT" ? el.value : ""].map(fold).filter(Boolean);
  const pick = (list, read) => {
    const target = exact ? fold(value) : lower(value);
    const same = list.filter((el) => read(el).some((text) => (exact ? text === target : text.toLowerCase() === target)));
    if (same.length || exact) return same;
    return list.filter((el) => read(el).some((text) => text.toLowerCase().includes(target)));
  };
  const innermost = (list) => list.filter((el) => !list.some((other) => other !== el && el.contains(other)));
  if (kind === "css") {
    try {
      document.createDocumentFragment().querySelector(value);
    } catch (error) {
      return null;
    }
    return all.filter((el) => el.matches(value)).slice(0, 50);
  }
  if (kind === "role") {
    let selector = ROLE_SELECTORS[role];
    if (!selector) selector = "[role=" + JSON.stringify(String(role)) + "]";
    return pick(all.filter((el) => el.matches(selector) && visible(el)), fields).slice(0, 50);
  }
  if (kind === "text") {
    const shownOnly = all.filter((el) => visible(el));
    const interactive = pick(shownOnly.filter((el) => el.matches(INTERACTIVE)), fields);
    if (interactive.length) return innermost(interactive).slice(0, 50);
    return innermost(pick(shownOnly, (el) => [shown(el)])).slice(0, 50);
  }
  if (kind === "label") {
    const allSet = new Set(all);
    const controls = [];
    for (const label of pick(all.filter((el) => el.tagName === "LABEL"), (el) => [shown(el)])) if (label.control && allSet.has(label.control) && !controls.includes(label.control)) controls.push(label.control);
    for (const el of pick(all.filter((el) => el.matches("input,select,textarea,[role=textbox],[role=combobox],[role=checkbox],[role=radio],[role=switch]")), (el) => [fold(el.getAttribute("aria-label"))])) if (!controls.includes(el)) controls.push(el);
    return controls.slice(0, 50);
  }
  const attribute = kind === "testid" ? "data-testid" : kind;
  return pick(all.filter((el) => el.hasAttribute(attribute)), (el) => [fold(el.getAttribute(attribute))]).slice(0, 50);
}`;

export const TEXT_OF_MATCH = "(el) => String((el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-testid') || el.value || '')).replace(/\\s+/g, ' ').trim().slice(0, 80)";

export const CSS_SHAPED = /^[#.[*:>]|[[\]>#.:=~+]|^[a-z][a-z0-9-]*$/u;

function collect(node: Record<string, unknown>, into: Set<number>): void {
  if (typeof node["backendNodeId"] === "number") into.add(node["backendNodeId"]);
  for (const key of ["children", "shadowRoots"]) {
    const list = node[key];
    if (Array.isArray(list)) for (const child of list) if (child !== null && typeof child === "object") collect(child as Record<string, unknown>, into);
  }
}

export async function descendantsOf(page: Page, container: Element): Promise<Set<number>> {
  const described = await sendIn(page, container.frame, "DOM.describeNode", { backendNodeId: container.backendId, depth: -1, pierce: true });
  const into = new Set<number>();
  const node = described["node"];
  if (node !== null && typeof node === "object") collect(node as Record<string, unknown>, into);
  into.add(container.backendId);
  return into;
}

export async function matchText(page: Page, element: Element): Promise<string> {
  try {
    return String((await page.call(TEXT_OF_MATCH, [element], { frame: element.frame, read: true })) ?? "");
  } catch (error) {
    if (error instanceof BrowseError) return "";
    throw error;
  }
}

async function containersByText(page: Page, frame: string, text: string): Promise<Element[]> {
  const remote = await page.call(CONTAINERS_BY_TEXT, [text], { frame, byValue: false, read: true });
  return page.elementsFrom(remote, frame, `--within ${text}`, 20);
}

async function ambiguousContainers(ctx: Ctx, page: Page, value: string, containers: Element[]): Promise<never> {
  const listed: { ref: string; text: string }[] = [];
  for (const container of containers.slice(0, MAX_LISTED)) listed.push({ ref: `@${ctx.state.addRef(page, container)}`, text: await matchText(page, container) });
  const lines = listed.map((item) => `  ${item.ref} "${item.text}"`).join("\n");
  throw new BrowseError(
    `--within "${value}" matches ${containers.length} separate containers, so nothing was done. Use one of their refs as --within:\n${lines}`,
    { containers: listed },
    "ambiguous",
  );
}

function mergeElements(first: readonly Element[], extra: readonly Element[]): Element[] {
  if (extra.length === 0) return [...first];
  const out = [...first];
  const seen = new Set(first.map((element) => `${element.frame}:${element.backendId}`));
  for (const element of extra) {
    const key = `${element.frame}:${element.backendId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(element);
  }
  return out;
}

const CSS_IN_ROOTS = "(s, ...roots) => { const seen = new Set(); const out = []; for (const root of roots) for (const el of root.querySelectorAll(s)) if (!seen.has(el)) { seen.add(el); out.push(el); } return out; }";

async function cssInShadowRoots(page: Page, frame: string, selector: string): Promise<Element[]> {
  const roots = await pierce.shadowRoots(page, frame);
  if (roots.length === 0) return [];
  try {
    const remote = await page.call(CSS_IN_ROOTS, [selector, ...roots], { frame, byValue: false, read: true });
    return page.elementsFrom(remote, frame, `--within ${selector}`, 20);
  } catch (error) {
    if (error instanceof BrowseError && error.code === "page_script_error") return [];
    throw error;
  }
}

async function containerBySelector(ctx: Ctx, page: Page, frame: string, value: string): Promise<[Page, Element] | null> {
  const cssSelector = value.startsWith("css=") ? value.slice(4) : value;
  const css = await scopedMatches(page, frame, null, "css", cssSelector, false);
  if (css !== null) {
    if (css.length > 1) return ambiguousContainers(ctx, page, value, css);
    const merged = mergeElements(css, await cssInShadowRoots(page, frame, cssSelector));
    if (merged.length > 1) return ambiguousContainers(ctx, page, value, merged);
    if (merged.length === 1) return [page, merged[0] as Element];
    return null;
  }
  try {
    const remote = await page.call("(s) => ardiaBrowse.queryAll(s)", [value], { frame, byValue: false, read: true });
    const matches = await page.elementsFrom(remote, frame, `--within ${value}`, 20);
    if (matches.length > 1) return ambiguousContainers(ctx, page, value, matches);
    const merged = mergeElements(matches, await pierce.queryAll(page, frame, value, 20));
    if (merged.length > 1) return ambiguousContainers(ctx, page, value, merged);
    if (merged.length === 1) return [page, merged[0] as Element];
    return null;
  } catch (error) {
    if (!(error instanceof BrowseError) || error.code !== "page_script_error") throw error;
    return null;
  }
}

export async function scopeOf(ctx: Ctx, value: string): Promise<Scope> {
  flag("find_within", true);
  let found: [Page, Element] | null = null;
  if (parseRef(value) !== null) found = await ctx.state.locate(value, null, 0);
  else {
    const page = await ctx.state.page();
    const frame = (ctx.state.frameFor(page) || page.mainFrame) as string;
    const cssFirst = CSS_SHAPED.test(value);
    if (cssFirst) found = await containerBySelector(ctx, page, frame, value);
    if (found === null) {
      const containers = await containersByText(page, frame, value);
      if (containers.length > 1) return ambiguousContainers(ctx, page, value, containers);
      if (containers.length === 1) found = [page, containers[0] as Element];
    }
    if (found === null && !cssFirst) found = await containerBySelector(ctx, page, frame, value);
  }
  if (found === null) {
    throw new BrowseError(
      `--within "${value}" matched no container: no row, list item, card, section or dialog on this page shows that text, and it isn't a CSS selector that matches. Check the text with \`read\`, or pass an @ref from \`snapshot -i\``,
      { within: value },
      "not_found",
    );
  }
  const [page, container] = found;
  container.label = `--within ${value}`;
  return { page, container, label: value, backends: await descendantsOf(page, container) };
}

export function inScope(scope: Scope | null, element: Element): boolean {
  return scope === null || (element.frame === scope.container.frame && scope.backends.has(element.backendId));
}

export async function scopedMatches(page: Page, frame: string, root: Element | null, kind: string, value: string, exact: boolean, role = ""): Promise<Element[] | null> {
  const remote = await page.call(SCOPED_MATCH, [root, kind, value, exact, role], { frame: root?.frame ?? frame, byValue: false, read: true });
  const found = remote !== null && typeof remote === "object" ? (remote as Record<string, unknown>) : {};
  if (found["subtype"] === "null") return null;
  return page.elementsFrom(remote, root?.frame ?? frame, `${kind}=${value}`, 50);
}

export async function listAmbiguous(ctx: Ctx, page: Page, matches: Element[], role: string, names: ReadonlyMap<number, string>): Promise<{ ref: string; name: string }[]> {
  const listed: { ref: string; name: string }[] = [];
  for (const element of matches.slice(0, MAX_LISTED)) {
    const name = names.get(element.backendId) ?? (await matchText(page, element));
    listed.push({ ref: `@${role ? ctx.state.addRef(page, element, role, name) : ctx.state.addRef(page, element)}`, name });
  }
  return listed;
}

export async function resolveWithin(ctx: Ctx, selector: string, within: string): Promise<[Page, Element]> {
  const scope = await scopeOf(ctx, within);
  const { page, container } = scope;
  if (parseRef(selector) !== null) {
    const [refPage, element] = await ctx.state.locate(selector, null, 0);
    if (refPage !== page || !inScope(scope, element)) {
      throw new BrowseError(`${selector} isn't inside --within "${within}", so nothing was done. Drop --within, or pick a ref inside that container`, { within }, "not_within");
    }
    return [refPage, element];
  }
  let matches = CSS_SHAPED.test(selector) ? await scopedMatches(page, container.frame, container, "css", selector, false) : null;
  if (matches === null || matches.length === 0) matches = await scopedMatches(page, container.frame, container, "text", selector, false);
  const found = matches ?? [];
  if (found.length === 0) {
    throw new BrowseError(`Element not found: ${selector} inside --within "${within}" (no CSS match, and no control there shows, is labelled or titled "${selector}")`, { within }, "not_found");
  }
  if (found.length > 1) {
    const listed = await listAmbiguous(ctx, page, found, "", new Map());
    const lines = listed.map((item) => `  ${item.ref} "${item.name}"`).join("\n");
    throw new BrowseError(
      `${found.length} elements inside --within "${within}" match "${selector}", so nothing was done. Use one of their refs:\n${lines}`,
      { candidates: listed, within },
      "ambiguous",
    );
  }
  flag("act_within", true);
  const element = found[0] as Element;
  element.label = selector;
  return [page, element];
}
