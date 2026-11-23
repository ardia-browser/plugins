import { CdpError, Gated } from "../daemon-errors.ts";
import { flag } from "../metrics.ts";
import type { Page } from "../state/page.ts";
import { record } from "../state/records.ts";

export const DEPTHS = [-1, 64, 24, 8] as const;
export const FILL_DEPTH = 24;
export const MAX_FILLS = 400;
export const MAX_CLOSED_ROOTS = 32;
export const OVERFLOW = /too (large|deep|long)|overflow|exceed|maximum|message size|nesting|depth/iu;

export type DomNode = Record<string, unknown>;
export type ClosedRoot = { backend: number; frame: string };

export type Sender = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

export function overflowed(error: unknown): boolean {
  if (error instanceof CdpError) return OVERFLOW.test(error.cdpMessage);
  return error instanceof RangeError || (error instanceof Error && OVERFLOW.test(error.message) && !(error instanceof Gated));
}

function childrenOf(node: DomNode): DomNode[] {
  const out: DomNode[] = [];
  for (const key of ["children", "shadowRoots", "pseudoElements"]) {
    const list = node[key];
    if (Array.isArray(list)) for (const item of list) out.push(record(item));
  }
  if (node["contentDocument"]) out.push(record(node["contentDocument"]));
  if (node["templateContent"]) out.push(record(node["templateContent"]));
  return out;
}

export function missingBranches(root: DomNode): DomNode[] {
  const out: DomNode[] = [];
  const stack = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    const known = Array.isArray(node["children"]) ? (node["children"] as unknown[]).length : 0;
    const count = typeof node["childNodeCount"] === "number" ? (node["childNodeCount"] as number) : 0;
    if (count > known && !Array.isArray(node["children"])) out.push(node);
    stack.push(...childrenOf(node));
  }
  return out;
}

export async function documentTree(send: Sender): Promise<{ root: DomNode; depth: number; fills: number }> {
  let last: unknown = null;
  for (const depth of DEPTHS) {
    let root: DomNode;
    try {
      root = record((await send("DOM.getDocument", { depth, pierce: true }))["root"]);
    } catch (error) {
      if (!overflowed(error)) throw error;
      last = error;
      continue;
    }
    if (depth !== -1) flag("snapshot_dom_depth_retry", true);
    let fills = 0;
    let pending = depth === -1 ? [] : missingBranches(root);
    while (pending.length > 0 && fills < MAX_FILLS) {
      const next: DomNode[] = [];
      for (const node of pending) {
        if (fills >= MAX_FILLS) break;
        fills += 1;
        let described: DomNode;
        try {
          const target = typeof node["nodeId"] === "number" && node["nodeId"] > 0 ? { nodeId: node["nodeId"] } : { backendNodeId: node["backendNodeId"] };
          described = record((await send("DOM.describeNode", { ...target, depth: FILL_DEPTH, pierce: true }))["node"]);
        } catch (error) {
          if (error instanceof CdpError) continue;
          throw error;
        }
        for (const key of ["children", "shadowRoots", "contentDocument", "templateContent", "pseudoElements"]) {
          if (described[key] !== undefined) node[key] = described[key];
        }
        next.push(...missingBranches(node).filter((found) => found !== node));
      }
      pending = next;
    }
    return { root, depth, fills };
  }
  throw last;
}

export function closedRoots(root: DomNode, mainFrame: string): ClosedRoot[] {
  const out: ClosedRoot[] = [];
  const stack: [DomNode, string][] = [[root, mainFrame]];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [node, frame] = item;
    if (node["shadowRootType"] === "closed" && typeof node["backendNodeId"] === "number" && out.length < MAX_CLOSED_ROOTS) out.push({ backend: node["backendNodeId"] as number, frame });
    const inner = typeof node["frameId"] === "string" && node["contentDocument"] ? (node["frameId"] as string) : frame;
    for (const key of ["children", "shadowRoots", "pseudoElements"]) {
      const list = node[key];
      if (Array.isArray(list)) for (const child of list) stack.push([record(child), frame]);
    }
    if (node["contentDocument"]) stack.push([record(node["contentDocument"]), inner]);
    if (node["templateContent"]) stack.push([record(node["templateContent"]), frame]);
  }
  return out;
}

export async function findClosedRoots(page: Page, frame: string): Promise<ClosedRoot[]> {
  const session = page.sessionFor(frame);
  try {
    const { root } = await documentTree((method, params) => page.send(method, params, { session, timeout: 30 }));
    return closedRoots(root, frame).filter((found) => page.frames.has(found.frame));
  } catch (error) {
    if (error instanceof CdpError || error instanceof Gated || overflowed(error)) return [];
    throw error;
  }
}
