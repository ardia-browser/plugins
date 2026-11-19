import { checkCancelled } from "../cdp/cancel.ts";
import { BrowseError, ConnectionLost } from "../daemon-errors.ts";
import { SNAPSHOT_FIELD_VALUE } from "../js/index.ts";
import { flag } from "../metrics.ts";
import type { Element, Page } from "../state/page.ts";
import * as pierce from "../state/pierce.ts";
import { record } from "../state/records.ts";
import { parseRef, type Ref, Refs, type Snapshots } from "../state/refs.ts";
import type { State } from "../state/state.ts";
import { buildTree, clipped, INTERACTIVE, isAxList, MAX_SCOPES, type Node, REF_ROLES, walk, walkInContext } from "./tree.ts";

const CLICKABLES = "() => { const r = ardiaBrowse.clickables(); globalThis.ardiaBrowseHints = r.hints; return r.elements; }";
const CLICKABLE_HINTS = "() => globalThis.ardiaBrowseHints";
const INNER_TEXT = "(el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()";

export async function settledAll(work: Promise<unknown>[]): Promise<void> {
  await Promise.allSettled(work);
  checkCancelled();
}

export async function clickableMap(page: Page, frame: string): Promise<Map<number, string[]>> {
  let elements: Element[];
  let hints: unknown;
  try {
    const remote = await page.call(CLICKABLES, [], { frame, byValue: false, read: true });
    hints = await page.call(CLICKABLE_HINTS, [], { frame, read: true });
    elements = await page.elementsFrom(remote, frame, "clickable");
  } catch (error) {
    if (error instanceof BrowseError) return new Map();
    throw error;
  }
  const list = Array.isArray(hints) ? hints : [];
  const out = new Map<number, string[]>();
  elements.forEach((element, index) => {
    if (index < list.length) out.set(element.backendId, list[index] as string[]);
  });
  return out;
}

export async function linkUrls(page: Page, nodes: readonly Node[], frame: string): Promise<void> {
  const links = [...walk(nodes)].filter((node) => node.role === "link" && node.backend !== null);
  await settledAll(
    links.map(async (node) => {
      const element = await page.resolveBackend(node.backend as number, frame, "link");
      if (element !== null) node.url = (await page.call("(el) => el.href || null", [element], { frame })) as string | null;
    }),
  );
}

export async function frameNodes(page: Page, frame: string, scopes: number[] | null = null): Promise<Node[]> {
  const result = await page.send("Accessibility.getFullAXTree", { frameId: frame }, { timeout: 60, session: page.sessionFor(frame) });
  const raw = isAxList(result["nodes"]) ? result["nodes"] : [];
  let nodes: Node[];
  if (scopes === null) nodes = buildTree(raw);
  else {
    nodes = [];
    const seen = new Set<number | null>();
    for (const backend of scopes) {
      if (seen.has(backend)) continue;
      const found = buildTree(raw, backend);
      for (const node of walk(found)) seen.add(node.backend);
      nodes.push(...found);
    }
  }
  for (const node of walk(nodes)) node.frame = frame;
  return nodes;
}

export async function scopeElements(state: State, page: Page, selector: string): Promise<[string, Element[]]> {
  if (parseRef(selector)) {
    const [, element] = await state.locate(selector, page);
    return [element.frame, [element]];
  }
  const frame = (state.frameFor(page) || page.mainFrame) as string;
  let remote: unknown;
  try {
    remote = await page.call("(s) => ardiaBrowse.queryAll(s)", [selector], { frame, byValue: false, read: true });
  } catch (error) {
    if (error instanceof BrowseError && !(error instanceof ConnectionLost)) throw new BrowseError(`Invalid selector ${selector}: ${error.text}`);
    throw error;
  }
  let elements = await page.elementsFrom(remote, frame, selector, MAX_SCOPES);
  if (elements.length === 0) elements = await pierce.queryAll(page, frame, selector, MAX_SCOPES);
  if (elements.length === 0) {
    throw new BrowseError(`Element not found: ${selector}. Verify the selector, role, or name is correct and the element exists in the DOM.`, null, "not_found");
  }
  return [frame, elements];
}

export async function fieldValues(page: Page, nodes: readonly Node[]): Promise<void> {
  const fields = [...walk(nodes)].filter((node) => node.props.get("inputType") && node.backend !== null);
  await settledAll(
    fields.map(async (node) => {
      const element = await page.resolveBackend(node.backend as number, node.frame as string, "field");
      if (element === null) return;
      const found = record(await page.call(SNAPSHOT_FIELD_VALUE, [element], { frame: node.frame, read: true }));
      if (found["type"]) node.props.set("inputType", found["type"]);
      if (found["value"] !== null && found["value"] !== undefined) node.value = clipped(String(found["value"]));
      if (found["required"]) node.props.set("required", true);
    }),
  );
}

function isOopif(page: Page, frame: string): boolean {
  return page.frameSessions.has(frame);
}

async function stitchFrames(page: Page, nodes: Node[], frame: string): Promise<void> {
  const queue = [...walk(nodes)];
  let crossed = false;
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index] as Node;
    if ((node.role !== "Iframe" && node.role !== "iframe") || node.backend === null) continue;
    try {
      const described = await page.send("DOM.describeNode", { backendNodeId: node.backend }, { session: page.sessionFor(node.frame) });
      const child = record(described["node"])["frameId"];
      if (typeof child === "string" && child && page.frames.has(child) && child !== frame) {
        node.children = await frameNodes(page, child);
        if (isOopif(page, child)) {
          crossed = true;
          queue.push(...walk(node.children));
        }
      }
    } catch (error) {
      if (!(error instanceof BrowseError)) throw error;
    }
  }
  if (crossed) flag("snapshot_oopif_frames", true);
}

export async function collect(state: State, page: Page, selector: string | null = null, cursor = true): Promise<Node[]> {
  await page.refreshFrames();
  let frame = (state.frameFor(page) || page.mainFrame) as string;
  let scopes: number[] | null = null;
  if (selector) {
    const [found, elements] = await scopeElements(state, page, selector);
    frame = found;
    scopes = elements.map((element) => element.backendId);
  }
  const nodes = scopes ? await frameNodes(page, frame, scopes) : await frameNodes(page, frame);
  if (scopes && nodes.length === 0) {
    const many = scopes.length > 1 ? `all ${scopes.length} elements matching it are` : "the element matching it is";
    throw new BrowseError(`Nothing in the accessibility tree under ${selector}: ${many} hidden or empty`);
  }
  await stitchFrames(page, nodes, frame);
  const framesUsed = [...new Set([...walk(nodes)].map((node) => node.frame as string))];
  const clickable = new Map<string, Map<number, string[]>>();
  if (cursor) for (const used of framesUsed) clickable.set(used, await clickableMap(page, used));
  for (const node of walk(nodes)) {
    const hints = node.backend === null ? undefined : clickable.get(node.frame as string)?.get(node.backend);
    if (hints && hints.length && !INTERACTIVE.has(node.role)) {
      node.hints = hints;
      if (!node.name) {
        const element = await page.resolveBackend(node.backend as number, node.frame as string, "clickable");
        if (element !== null) {
          const text = await page.call(INNER_TEXT, [element], { frame: node.frame });
          node.name = clipped(typeof text === "string" ? text : text ? String(text) : "");
        }
      }
    }
  }
  await fieldValues(page, nodes);
  for (const node of walk(nodes)) {
    if (REF_ROLES.has(node.role) || (node.hints && node.hints.length)) {
      if ((node.role === "heading" && !node.name) || node.backend === null) continue;
      node.ref = state.refForNode(page, node.frame as string, node.backend);
    }
  }
  return nodes;
}

export function refsOf(state: Refs, page: Page, nodes: readonly Node[], wholePage = true): Ref[] {
  const placed = walkInContext(nodes).filter(([node]) => node.ref && node.backend !== null);
  const counts = new Map<string, number>();
  const keyOf = (node: Node) => JSON.stringify([node.role, node.name]);
  for (const [node] of placed) counts.set(keyOf(node), (counts.get(keyOf(node)) ?? 0) + 1);
  return placed.map(([node, here]) => {
    let unique: boolean;
    let context: readonly unknown[];
    if (wholePage) {
      unique = counts.get(keyOf(node)) === 1;
      context = here;
    } else {
      const known = state.refs.get(node.ref as string);
      unique = known ? known.unique : false;
      context = known ? known.context : [];
    }
    return {
      id: node.ref as string,
      instance: state.instance,
      target: page.targetId,
      frame: node.frame as string,
      loader: page.loader(node.frame as string) || "",
      generation: 0,
      backend: node.backend as number,
      role: node.role,
      name: node.name,
      unique,
      context,
    };
  });
}

export const snapshots: Snapshots = {
  collect: (state, page) => collect(state as State, page),
  refsOf: (state, page, nodes) => refsOf(state, page, nodes as Node[]),
  walk: (nodes) => walk(nodes as Node[]),
};

Refs.snapshots = snapshots;
