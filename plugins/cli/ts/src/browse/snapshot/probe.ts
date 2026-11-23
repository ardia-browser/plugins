import { SNAPSHOT_PROBE } from "../js/index.ts";
import { flag } from "../metrics.ts";
import { type Page, quiet } from "../state/page.ts";
import { record } from "../state/records.ts";
import { type ClosedRoot, findClosedRoots } from "./shadow.ts";
import { type AxNode, axValue, INTERACTIVE, VALUE_FIELDS } from "./tree.ts";

export const PROBE_LIMIT = 260;
export const SHADOW_CLICKS = "(root) => { const found = ardiaBrowse.clickables(root); globalThis.ardiaBrowseShadowClicks = found.elements; return found.hints; }";
const SHADOW_CLICK_ELEMENTS = "() => globalThis.ardiaBrowseShadowClicks || []";

export type FrameExtras = { hidden: Set<number>; clicks: Map<number, string[]> };
export type Probed = { modal: number | null; hits: number; extras: Map<string, FrameExtras>; closedRoots: number };

export type BackendsOf = (page: Page, frame: string, name: string, limit: number) => Promise<number[]>;

export class Prober {
  readonly closedBySession = new Map<string, Promise<ClosedRoot[]>>();
  readonly probed = new Map<string, Promise<Probed>>();
  closedRootsSeen = 0;
  hiddenDropped = 0;

  constructor(
    readonly page: Page,
    readonly backendsOf: BackendsOf,
  ) {}

  frame(frame: string, wantModal = false): Promise<Probed> {
    const key = JSON.stringify([frame, wantModal]);
    let known = this.probed.get(key);
    if (known === undefined) {
      known = this.run(frame, wantModal);
      this.probed.set(key, known);
    }
    return known;
  }

  private async scoped(frame: string, root: unknown, wantModal: boolean): Promise<{ modal: number | null; hits: number; hidden: number[]; closedHosts: number }> {
    const found = record(await this.page.call(SNAPSHOT_PROBE, [root, wantModal], { frame, read: true }));
    const modal = Boolean(found["modal"]);
    const count = (modal ? 1 : 0) + Number(found["hidden"] ?? 0);
    const ids = count > 0 ? await this.backendsOf(this.page, frame, "ardiaBrowseScopeElements", PROBE_LIMIT) : [];
    return {
      modal: modal && (ids[0] ?? 0) > 0 ? (ids[0] as number) : null,
      hits: Number(found["hits"] ?? 0),
      hidden: ids.slice(modal ? 1 : 0).filter((id) => id > 0),
      closedHosts: Number(found["closedHosts"] ?? 0),
    };
  }

  private closedRootsOf(frame: string): Promise<ClosedRoot[]> {
    const session = this.page.sessionFor(frame) ?? "";
    let known = this.closedBySession.get(session);
    if (known === undefined) {
      known = findClosedRoots(this.page, frame);
      this.closedBySession.set(session, known);
    }
    return known;
  }

  private async run(frame: string, wantModal: boolean): Promise<Probed> {
    const extras = new Map<string, FrameExtras>();
    const own: FrameExtras = { hidden: new Set(), clicks: new Map() };
    extras.set(frame, own);
    let top: Awaited<ReturnType<Prober["scoped"]>>;
    try {
      top = await this.scoped(frame, null, wantModal);
    } catch (error) {
      if (quiet(error)) return { modal: null, hits: 0, extras, closedRoots: 0 };
      throw error;
    }
    for (const id of top.hidden) own.hidden.add(id);
    let closedCount = 0;
    if (top.closedHosts > 0) {
      const roots = (await this.closedRootsOf(frame)).filter((root) => root.frame === frame);
      closedCount = roots.length;
      for (const root of roots) await this.closedRoot(root, own);
    }
    if (closedCount > 0) {
      this.closedRootsSeen += closedCount;
      flag("snapshot_closed_shadow", true);
    }
    return { modal: top.modal, hits: top.hits, extras, closedRoots: closedCount };
  }

  private async closedRoot(root: ClosedRoot, into: FrameExtras): Promise<void> {
    try {
      const element = await this.page.resolveBackend(root.backend, root.frame, "shadow root");
      if (element === null) return;
      const inner = await this.scoped(root.frame, element, false);
      for (const id of inner.hidden) into.hidden.add(id);
      const hints = await this.page.call(SHADOW_CLICKS, [element], { frame: root.frame, read: true });
      const list = Array.isArray(hints) ? hints : [];
      if (list.length === 0) return;
      const remote = await this.page.call(SHADOW_CLICK_ELEMENTS, [], { frame: root.frame, byValue: false, read: true });
      const elements = await this.page.elementsFrom(remote, root.frame, "clickable", 300);
      elements.forEach((found, index) => {
        const hint = list[index];
        if (Array.isArray(hint) && hint.length > 0) into.clicks.set(found.backendId, hint.map(String));
      });
    } catch (error) {
      if (!quiet(error)) throw error;
    }
  }
}

export function pruneHidden(raw: readonly AxNode[], hidden: ReadonlySet<number>): { nodes: AxNode[]; dropped: number } {
  if (hidden.size === 0) return { nodes: [...raw], dropped: 0 };
  const byId = new Map<unknown, AxNode>();
  for (const node of raw) byId.set(node["nodeId"], node);
  const marked = new Set<unknown>();
  const stack = raw.filter((node) => typeof node["backendDOMNodeId"] === "number" && hidden.has(node["backendDOMNodeId"] as number));
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (marked.has(node["nodeId"])) continue;
    marked.add(node["nodeId"]);
    const childIds = node["childIds"];
    if (Array.isArray(childIds)) for (const id of childIds) {
      const child = byId.get(id);
      if (child !== undefined) stack.push(child);
    }
  }
  let dropped = 0;
  const nodes = raw.map((node) => {
    if (!marked.has(node["nodeId"])) return node;
    const role = axValue(node["role"]);
    if (INTERACTIVE.has(role) || Object.hasOwn(VALUE_FIELDS, role)) return node;
    if (role === "StaticText" && !node["ignored"]) dropped += 1;
    return { ...node, ignored: true };
  });
  return { nodes, dropped };
}
