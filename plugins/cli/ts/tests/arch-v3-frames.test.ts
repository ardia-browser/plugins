import { describe, expect, test } from "bun:test";
import { frameWithin, inScope, refInScope, type Scope } from "../src/browse/commands/find-act.ts";
import { MAX_FRAME_DEPTH, stitchFrames } from "../src/browse/snapshot/collect.ts";
import { buildTree, type Node, walk } from "../src/browse/snapshot/tree.ts";
import { Element, type Page } from "../src/browse/state/page.ts";
import { parseRef, refNumber, Refs } from "../src/browse/state/refs.ts";

type FrameSpec = { parent: string | null; oopif?: boolean; iframes?: Record<number, string> };

class FramedPage {
  readonly targetId = "T1";
  readonly mainFrame = "MAIN";
  readonly frames = new Map<string, { id: string; parent: string | null; loader: string }>();
  readonly frameSessions = new Map<string, string>();
  readonly owners = new Map<number, string>();
  readonly axCalls: string[] = [];
  readonly trees = new Map<string, Record<string, unknown>[]>();

  constructor(specs: Record<string, FrameSpec>) {
    let backend = 1000;
    for (const [id, spec] of Object.entries(specs)) {
      this.frames.set(id, { id, parent: spec.parent, loader: `L-${id}` });
      if (spec.oopif) this.frameSessions.set(id, `S-${id}`);
      const nodes: Record<string, unknown>[] = [{ nodeId: `${id}-root`, role: { value: "RootWebArea" }, name: { value: id }, childIds: [], backendDOMNodeId: (backend += 1) }];
      const root = nodes[0] as Record<string, unknown>;
      const button = { nodeId: `${id}-button`, parentId: `${id}-root`, role: { value: "button" }, name: { value: `Go ${id}` }, childIds: [], backendDOMNodeId: (backend += 1) };
      nodes.push(button);
      (root["childIds"] as string[]).push(button.nodeId);
      for (const [owner, child] of Object.entries(spec.iframes ?? {})) {
        const node = { nodeId: `${id}-iframe-${owner}`, parentId: `${id}-root`, role: { value: "Iframe" }, name: { value: "" }, childIds: [], backendDOMNodeId: Number(owner) };
        nodes.push(node);
        (root["childIds"] as string[]).push(node.nodeId);
        this.owners.set(Number(owner), child);
      }
      this.trees.set(id, nodes);
    }
  }

  sessionFor(frame: string | null): string | null {
    return frame === null ? null : (this.frameSessions.get(frame) ?? null);
  }

  loader(frame: string | null): string | null {
    return frame === null ? null : (this.frames.get(frame)?.loader ?? null);
  }

  async send(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === "Accessibility.getFullAXTree") {
      const frame = String(params["frameId"]);
      this.axCalls.push(frame);
      return { nodes: this.trees.get(frame) ?? [] };
    }
    if (method === "DOM.describeNode") return { node: { frameId: this.owners.get(Number(params["backendNodeId"])) ?? null } };
    if (method === "DOM.getFrameOwner") {
      for (const [owner, child] of this.owners) if (child === params["frameId"]) return { backendNodeId: owner };
      return {};
    }
    return {};
  }
}

async function stitched(specs: Record<string, FrameSpec>): Promise<{ page: FramedPage; nodes: Node[]; result: Awaited<ReturnType<typeof stitchFrames>> }> {
  const page = new FramedPage(specs);
  const nodes = buildTree(page.trees.get("MAIN") as never);
  for (const node of walk(nodes)) node.frame = "MAIN";
  const result = await stitchFrames(page as unknown as Page, nodes, "MAIN");
  return { page, nodes, result };
}

describe("snapshots stitch every child frame", () => {
  test("same-process frames nested in same-process frames are all read, not only cross-process ones", async () => {
    const { page, nodes, result } = await stitched({
      MAIN: { parent: null, iframes: { 10: "A" } },
      A: { parent: "MAIN", iframes: { 20: "B" } },
      B: { parent: "A", iframes: { 30: "C" } },
      C: { parent: "B", oopif: true },
    });
    expect(page.axCalls).toEqual(["A", "B", "C"]);
    expect(result).toEqual({ oopifs: 1, frames: 3 });
    const names = [...walk(nodes)].filter((node) => node.role === "button").map((node) => [node.name, node.frame]);
    expect(names).toEqual([["Go MAIN", "MAIN"], ["Go A", "A"], ["Go B", "B"], ["Go C", "C"]]);
  });

  test("a frame that points back at one already read is skipped, so a cycle can't loop", async () => {
    const { page, result } = await stitched({
      MAIN: { parent: null, iframes: { 10: "A" } },
      A: { parent: "MAIN", iframes: { 20: "B" } },
      B: { parent: "A", iframes: { 30: "A", 31: "MAIN" } },
    });
    expect(page.axCalls).toEqual(["A", "B"]);
    expect(result.frames).toBe(2);
  });

  test("nesting stops at the depth limit", async () => {
    const specs: Record<string, FrameSpec> = { MAIN: { parent: null, iframes: { 100: "F0" } } };
    for (let depth = 0; depth < MAX_FRAME_DEPTH + 4; depth += 1) specs[`F${depth}`] = { parent: depth === 0 ? "MAIN" : `F${depth - 1}`, iframes: { [101 + depth]: `F${depth + 1}` } };
    const { page } = await stitched(specs);
    expect(page.axCalls.length).toBe(MAX_FRAME_DEPTH);
  });
});

class TestRefs extends Refs {
  instance: string | null = "I1";
  readonly pages = new Map<string, Page>();
  targetInfos = new Map<string, Record<string, unknown>>();
  async page(): Promise<Page> {
    throw new Error("unused");
  }
}

describe("@fNeM refs for every non-main frame", () => {
  const page = new FramedPage({ MAIN: { parent: null }, A: { parent: "MAIN" }, B: { parent: "A", oopif: true }, C: { parent: "MAIN" } }) as unknown as Page;

  test("main-frame refs keep the plain @eN form", () => {
    const refs = new TestRefs();
    expect(refs.refForNode(page, "MAIN", 1)).toBe("e1");
    expect(refs.framePrefix(page, "MAIN")).toBe("");
  });

  test("same-process and cross-process child frames both get stable per-tab prefixes", () => {
    const refs = new TestRefs();
    expect(refs.refForNode(page, "A", 5)).toBe("f1e1");
    expect(refs.refForNode(page, "B", 5)).toBe("f2e2");
    expect(refs.refForNode(page, "MAIN", 5)).toBe("e3");
    expect(refs.refForNode(page, "A", 6)).toBe("f1e4");
    expect(refs.refForNode(page, "A", 5)).toBe("f1e1");
    expect(refs.framePrefix(page, "C")).toBe("f3");
    expect(refs.framePrefix(page, "A")).toBe("f1");
  });

  test("frame refs parse everywhere a ref is taken", () => {
    for (const given of ["@f1e3", "f1e3", "ref=f12e7", "[ref=f2e9]"]) expect(parseRef(given)).not.toBeNull();
    expect(refNumber("f3e17")).toBe(17);
  });
});

describe("--within reaches into frames inside the container", () => {
  const page = new FramedPage({ MAIN: { parent: null, iframes: { 10: "A", 11: "D" } }, A: { parent: "MAIN", iframes: { 20: "B" } }, B: { parent: "A", oopif: true }, D: { parent: "MAIN" } }) as unknown as Page;
  const scope = (backends: number[]): Scope => ({ page, container: new Element("MAIN", "X", 9, "container"), label: "container", backends: new Set(backends) });

  test("frameWithin follows parents, with a depth bound", () => {
    expect(frameWithin(page, "B", "MAIN")).toBe(true);
    expect(frameWithin(page, "B", "A")).toBe(true);
    expect(frameWithin(page, "D", "A")).toBe(false);
  });

  test("a same-process frame's element counts when its backend is in the container's subtree", () => {
    expect(inScope(scope([9, 10, 55]), new Element("A", "O", 55, "@f1e2"))).toBe(true);
    expect(inScope(scope([9, 10]), new Element("A", "O", 56, "@f1e3"))).toBe(false);
  });

  test("a cross-process frame's element counts when the iframe owning its frame is inside the container", async () => {
    expect(await refInScope(scope([9, 10]), new Element("B", "O", 77, "@f2e4"))).toBe(true);
    expect(await refInScope(scope([9, 11]), new Element("B", "O", 77, "@f2e4"))).toBe(false);
    expect(await refInScope(scope([9]), new Element("MAIN", "O", 99, "@e5"))).toBe(false);
  });
});
