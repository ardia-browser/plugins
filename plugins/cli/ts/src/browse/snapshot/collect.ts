import { checkCancelled } from "../cdp/cancel.ts";
import { BrowseError, ConnectionLost } from "../daemon-errors.ts";
import { SNAPSHOT_BOXLESS, SNAPSHOT_FIELD_VALUE } from "../js/index.ts";
import { count, flag } from "../metrics.ts";
import type { Element, Page } from "../state/page.ts";
import { quiet } from "../state/page.ts";
import * as pierce from "../state/pierce.ts";
import { record } from "../state/records.ts";
import { parseRef, type Ref, Refs, type Snapshots } from "../state/refs.ts";
import { isSecret, masked } from "../state/secrets.ts";
import type { State } from "../state/state.ts";
import { SNAPSHOT_FROM, snapshotBackends, snapshotRefused } from "./domsnapshot.ts";
import { Prober, pruneHidden } from "./probe.ts";
import { axReader, maskSensitive } from "./mask.ts";
import { buildTree, clipped, INTERACTIVE, isAxList, MAX_SCOPES, type Node, REF_ROLES, walk, walkInContext } from "./tree.ts";

export const CLICKABLES = `() => {
  if (!globalThis.ardiaBrowseBackends) Object.defineProperty(globalThis, "ardiaBrowseBackends", { value: new WeakMap() });
  const backends = globalThis.ardiaBrowseBackends;
  const found = ardiaBrowse.clickables();
  const known = [];
  const fresh = [];
  const hints = [];
  found.elements.forEach((el, index) => {
    const backend = backends.get(el);
    if (backend) known.push([backend, found.hints[index]]);
    else {
      fresh.push(el);
      hints.push(found.hints[index]);
    }
  });
  globalThis.ardiaBrowseFresh = fresh;
  return { known, hints, fresh: fresh.length, title: document.title };
}`;
const FRESH_ELEMENTS = "() => globalThis.ardiaBrowseFresh || []";
const KEEP_BACKENDS = "(ids, ...els) => { els.forEach((el, index) => globalThis.ardiaBrowseBackends.set(el, ids[index])); globalThis.ardiaBrowseFresh = null; return els.length; }";
const BACKENDS_OF = `(name, limit) => {
  if (!globalThis.ardiaBrowseBackends) Object.defineProperty(globalThis, "ardiaBrowseBackends", { value: new WeakMap() });
  const backends = globalThis.ardiaBrowseBackends;
  const fresh = [];
  const ids = Array.from(globalThis[name] || []).slice(0, limit).map((el) => {
    const backend = (el && backends.get(el)) || 0;
    if (!backend) fresh.push(el);
    return backend;
  });
  globalThis.ardiaBrowseFresh = fresh;
  return ids;
}`;

async function freshBackends(page: Page, frame: string, limit: number, count: number): Promise<number[]> {
  if (count >= SNAPSHOT_FROM && !snapshotRefused(page)) {
    const ids = await snapshotBackends(page, frame, limit);
    if (ids !== null) return ids;
  }
  const remote = await page.call(FRESH_ELEMENTS, [], { frame, byValue: false, read: true });
  const elements = await page.elementsFrom(remote, frame, "element", limit);
  if (elements.length > 0) await page.call(KEEP_BACKENDS, [elements.map((element) => element.backendId), ...elements], { frame, read: true });
  return elements.map((element) => element.backendId);
}

export async function backendsOf(page: Page, frame: string, name: string, limit: number): Promise<number[]> {
  const found = await page.call(BACKENDS_OF, [name, limit], { frame, read: true });
  const ids = (Array.isArray(found) ? found : []).map((id) => (typeof id === "number" && id > 0 ? id : 0));
  const missing = ids.filter((id) => id === 0).length;
  if (missing === 0) return ids;
  const fresh = await freshBackends(page, frame, limit, missing);
  let at = 0;
  return ids.map((id) => (id > 0 ? id : (fresh[at++] ?? 0)));
}
export const INNER_TEXT = "(el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()";

export async function settledAll(work: Promise<unknown>[]): Promise<void> {
  await Promise.allSettled(work);
  checkCancelled();
}

export const collectedTitles = new WeakMap<Node[], string>();
const frameTitles = new WeakMap<Map<number, string[]>, string>();

export async function clickableMap(page: Page, frame: string): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  try {
    const found = record(await page.call(CLICKABLES, [], { frame, read: true }));
    if (typeof found["title"] === "string") frameTitles.set(out, found["title"]);
    for (const pair of Array.isArray(found["known"]) ? found["known"] : []) {
      if (Array.isArray(pair) && typeof pair[0] === "number" && Array.isArray(pair[1])) out.set(pair[0], pair[1] as string[]);
    }
    const hints = Array.isArray(found["hints"]) ? found["hints"] : [];
    if (Number(found["fresh"]) > 0) {
      const ids = await freshBackends(page, frame, 300, Number(found["fresh"]));
      ids.forEach((id, index) => {
        if (id > 0 && index < hints.length) out.set(id, hints[index] as string[]);
      });
    }
  } catch (error) {
    if (quiet(error)) return out;
    throw error;
  }
  return out;
}

export async function boxless(page: Page, frame: string): Promise<Set<number>> {
  try {
    const remote = await page.call(SNAPSHOT_BOXLESS, [], { frame, byValue: false, read: true });
    return new Set((await page.elementsFrom(remote, frame, "control")).map((element) => element.backendId));
  } catch (error) {
    if (quiet(error)) return new Set();
    throw error;
  }
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

export type CollectOptions = { modal?: boolean; visible?: boolean };
export type Collected = { modal: Node | null; hiddenDropped: number; closedRoots: number; oopifFrames: number };
export const collectedInfo = new WeakMap<Node[], Collected>();
const pruned = new WeakMap<Page, { dropped: number }>();
const readIdentities = new WeakMap<Page, Identity>();

export async function frameNodes(page: Page, frame: string, scopes: number[] | null = null, hidden: ReadonlySet<number> | null = null): Promise<Node[]> {
  const session = page.sessionFor(frame);
  const read = { loader: page.loader(frame), session: page.frameSessions.get(frame) ?? null };
  const result = await page.send("Accessibility.getFullAXTree", { frameId: frame }, { timeout: 60, session });
  let raw = isAxList(result["nodes"]) ? result["nodes"] : [];
  if (hidden !== null && hidden.size > 0) {
    const cut = pruneHidden(raw, hidden);
    raw = cut.nodes;
    const tally = pruned.get(page);
    if (tally !== undefined) tally.dropped += cut.dropped;
  }
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
  readLoaders.get(page)?.set(frame, read.loader);
  readIdentities.get(page)?.set(frame, read);
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

async function stitchFrames(page: Page, nodes: Node[], frame: string, prober: Prober | null = null): Promise<number> {
  const queue = [...walk(nodes)];
  let crossed = false;
  let crossings = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index] as Node;
    if ((node.role !== "Iframe" && node.role !== "iframe") || node.backend === null) continue;
    try {
      const described = await page.send("DOM.describeNode", { backendNodeId: node.backend }, { session: page.sessionFor(node.frame) });
      const child = record(described["node"])["frameId"];
      if (typeof child === "string" && child && page.frames.has(child) && child !== frame) {
        const hidden = prober === null ? null : ((await prober.frame(child)).extras.get(child)?.hidden ?? null);
        node.children = await frameNodes(page, child, null, hidden);
        if (isOopif(page, child)) {
          crossed = true;
          crossings += 1;
          queue.push(...walk(node.children));
        }
      }
    } catch (error) {
      if (!quiet(error)) throw error;
    }
  }
  if (crossed) flag("snapshot_oopif_frames", true);
  return crossings;
}

const readLoaders = new WeakMap<Page, Map<string, string | null>>();
export const SNAPSHOT_MOVED = "The page changed document while the snapshot was being taken, so its refs would point into two documents; snapshot again";

export type Identity = Map<string, { loader: string | null; session: string | null }>;
export const collectedIdentity = new WeakMap<Node[], Identity>();

export async function verifyIdentity(page: Page, nodes: Node[]): Promise<void> {
  await page.refreshFrames(true);
  if (!page.frameTreeSettled) {
    flag("snapshot_document_changed", true);
    throw new BrowseError(SNAPSHOT_MOVED, null, "document_changed");
  }
  sameIdentity(page, nodes);
}

export function sameIdentity(page: Page, nodes: Node[]): void {
  const identity = collectedIdentity.get(nodes);
  if (identity === undefined) return;
  for (const [frame, known] of identity) {
    if (page.loader(frame) !== known.loader || (page.frameSessions.get(frame) ?? null) !== known.session) {
      flag("snapshot_document_changed", true);
      throw new BrowseError(SNAPSHOT_MOVED, null, "document_changed");
    }
  }
}

function sameDocuments(page: Page, loaders: ReadonlyMap<string, string | null>): void {
  for (const [frame, loader] of loaders) {
    if (page.loader(frame) !== loader) {
      flag("snapshot_document_changed", true);
      throw new BrowseError(SNAPSHOT_MOVED, null, "document_changed");
    }
  }
}

export function maskSecretValues(state: object, page: Pick<Page, "targetId" | "loader" | "frames">, nodes: readonly Node[]): void {
  for (const node of walk(nodes)) {
    if (node.backend !== null && node.value && isSecret(state, page, node.frame, page.loader(node.frame), node.backend)) node.value = masked(node.value);
  }
}

export async function collect(state: State, page: Page, selector: string | null = null, cursor = true, options: CollectOptions = {}): Promise<Node[]> {
  const loaders = new Map<string, string | null>();
  readLoaders.set(page, loaders);
  const identity: Identity = new Map();
  readIdentities.set(page, identity);
  const tally = { dropped: 0 };
  const shaping = Boolean(options.visible || options.modal);
  if (shaping) pruned.set(page, tally);
  try {
    const nodes = await collectInto(state, page, selector, cursor, loaders, shaping ? options : {});
    collectedIdentity.set(nodes, identity);
    return nodes;
  } finally {
    if (readLoaders.get(page) === loaders) readLoaders.delete(page);
    if (readIdentities.get(page) === identity) readIdentities.delete(page);
    if (pruned.get(page) === tally) pruned.delete(page);
  }
}

async function collectInto(state: State, page: Page, selector: string | null, cursor: boolean, loaders: Map<string, string | null>, options: CollectOptions): Promise<Node[]> {
  await page.refreshFrames();
  let frame = (state.frameFor(page) || page.mainFrame) as string;
  let scopes: number[] | null = null;
  if (selector) {
    const [found, elements] = await scopeElements(state, page, selector);
    frame = found;
    scopes = elements.map((element) => element.backendId);
  }
  const prober = options.visible || options.modal ? new Prober(page, backendsOf) : null;
  const top = prober === null ? null : await prober.frame(frame, Boolean(options.modal && !selector));
  const hidden = options.visible && top !== null ? (top.extras.get(frame)?.hidden ?? null) : null;
  let modalScoped = false;
  let nodes: Node[];
  if (top !== null && top.modal !== null && !scopes) {
    nodes = await frameNodes(page, frame, [top.modal], hidden);
    modalScoped = nodes.length > 0;
    if (!modalScoped) nodes = await frameNodes(page, frame, null, hidden);
  } else nodes = scopes ? await frameNodes(page, frame, scopes, hidden) : await frameNodes(page, frame, null, hidden);
  if (scopes && nodes.length === 0) {
    const many = scopes.length > 1 ? `all ${scopes.length} elements matching it are` : "the element matching it is";
    throw new BrowseError(`Nothing in the accessibility tree under ${selector}: ${many} hidden or empty`);
  }
  const oopifFrames = await stitchFrames(page, nodes, frame, options.visible ? prober : null);
  if (oopifFrames > 0) count("snapshot_oopif_count", oopifFrames);
  const framesUsed = [...new Set([...walk(nodes)].map((node) => node.frame as string))];
  const clickable = new Map<string, Map<number, string[]>>();
  if (cursor) for (const used of framesUsed) clickable.set(used, await clickableMap(page, used));
  if (cursor && prober !== null) {
    for (const probed of prober.probed.values()) {
      for (const [used, extras] of (await probed).extras) {
        const map = clickable.get(used);
        if (map === undefined) continue;
        for (const [backend, hints] of extras.clicks) if (!map.has(backend)) map.set(backend, hints);
      }
    }
  }
  const unclickable = new Map<string, Set<number>>();
  for (const used of framesUsed) unclickable.set(used, await boxless(page, used));
  sameDocuments(page, loaders);
  const mainHints = page.mainFrame === null ? undefined : clickable.get(page.mainFrame);
  const mainTitle = mainHints === undefined ? undefined : frameTitles.get(mainHints);
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
  sameDocuments(page, loaders);
  await fieldValues(page, nodes);
  await maskSensitive(nodes, axReader);
  sameDocuments(page, loaders);
  for (const node of walk(nodes)) {
    if (REF_ROLES.has(node.role) || (node.hints && node.hints.length)) {
      if ((node.role === "heading" && !node.name) || node.backend === null) continue;
      if (node.role !== "heading" && unclickable.get(node.frame as string)?.has(node.backend)) {
        flag("snapshot_boxless_skipped", true);
        node.boxless = true;
        continue;
      }
      node.ref = state.refForNode(page, node.frame as string, node.backend);
    }
  }
  maskSecretValues(state, page, nodes);
  if (mainTitle !== undefined) collectedTitles.set(nodes, mainTitle);
  if (prober !== null) {
    const dropped = pruned.get(page)?.dropped ?? 0;
    if (dropped > 0) flag("snapshot_hidden_text_dropped", true);
    collectedInfo.set(nodes, { modal: modalScoped ? (nodes[0] ?? null) : null, hiddenDropped: dropped, closedRoots: prober.closedRootsSeen, oopifFrames });
  }
  return nodes;
}

export function refsOf(state: Refs, page: Page, nodes: readonly Node[], wholePage = true): Ref[] {
  const placed = walkInContext(nodes).filter(([node]) => node.ref && node.backend !== null);
  const counts = new Map<string, number>();
  const keyOf = (node: Node) => JSON.stringify([node.role, node.name]);
  for (const node of walk(nodes)) if ((node.ref || node.boxless) && node.backend !== null) counts.set(keyOf(node), (counts.get(keyOf(node)) ?? 0) + 1);
  if (wholePage) {
    for (const node of walk(nodes)) {
      const known = node.boxless && node.backend !== null ? state.knownRef(page, node.frame as string, node.backend) : null;
      if (known !== null) known.unique = counts.get(keyOf(node)) === 1;
    }
  }
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
