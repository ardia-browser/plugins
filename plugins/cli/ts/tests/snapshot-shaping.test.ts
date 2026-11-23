import { expect, test } from "bun:test";
import { pyLen } from "../src/pylib/str.ts";
import { CdpError } from "../src/browse/daemon-errors.ts";
import { type BudgetRow, droppedRefs, fit, fitHeaders, fitWithNotice, isBare, parentsOf, roomAfter, tierOf } from "../src/browse/snapshot/budget.ts";
import { collect, collectedIdentity, sameIdentity, verifyIdentity } from "../src/browse/snapshot/collect.ts";
import { fitReport, openedDialogs, reportText } from "../src/browse/commands/snapshot.ts";
import { renderReport, renderReportLines } from "../src/browse/changes/text.ts";
import type { Report, Row } from "../src/browse/changes/report.ts";
import { foundWithin } from "../src/browse/snapshot/search.ts";
import { pairedChoice, pairedLine } from "../src/browse/media/paired.ts";
import type { State } from "../src/browse/state/state.ts";
import type { Page } from "../src/browse/state/page.ts";
import { ambiguousControls, compactTree, noteOf } from "../src/browse/snapshot/compact.ts";
import { keysOf, nextEpoch } from "../src/browse/snapshot/epoch.ts";
import { newIndexes, type Seen } from "../src/browse/snapshot/fresh.ts";
import { pruneHidden } from "../src/browse/snapshot/probe.ts";
import { render, renderListed, renderRows } from "../src/browse/snapshot/render.ts";
import { ancestorPath, fitFound, foundText, matcher, search, searchable, shownLines } from "../src/browse/snapshot/search.ts";
import { closedRoots, documentTree, missingBranches, overflowed } from "../src/browse/snapshot/shadow.ts";
import type { Line } from "../src/browse/snapshot/take.ts";
import { type AxNode, buildTree, Node, walk } from "../src/browse/snapshot/tree.ts";
import { boxOfQuad, clipToImage, pngSize } from "../src/browse/media/paired.ts";
import { isBareRef, isRefId, parseRef, refNumber } from "../src/browse/state/refs.ts";

function node(role: string, name = "", children: Node[] = [], ref: string | null = null, hints: string[] | null = null): Node {
  return new Node(role, name, "", new Map(), ref ? Number(ref.replace(/\D/gu, "")) : null, children, ref, hints, null, "F");
}

function linesOf(nodes: Node[]): Line[] {
  return renderRows(nodes).map((row) => ({ text: row.text, level: row.level, ref: row.node.ref, node: row.node, tier: tierOf(row.node, row.node.ref) }));
}

function rowsOf(lines: Line[]): BudgetRow[] {
  return lines.map((line) => ({ text: line.text, level: line.level, tier: line.tier, ref: line.ref, bare: isBare(line.node, line.ref) }));
}

function page(): Node[] {
  const items = Array.from({ length: 40 }, (_, index) =>
    node("listitem", "", [node("StaticText", `A long paragraph of filler text number ${index} that is only context`), node("button", `Buy ${index}`, [], `e${index + 10}`)]),
  );
  return [node("banner", "", [node("link", "Home", [], "e1")]), node("main", "", [node("heading", "Products", [], "e2"), node("list", "", items)])];
}

test("rendering by rows gives exactly the text render gives", () => {
  const nodes = page();
  expect(renderRows(nodes).map((row) => row.text).join("\n")).toBe(render(nodes));
  expect(renderRows(nodes, { compact: true, depth: 2 }).map((row) => row.text).join("\n")).toBe(render(nodes, { compact: true, depth: 2 }));
});

test("a budget keeps every control before any context or text, and never cuts a line", () => {
  const lines = linesOf(page());
  const rows = rowsOf(lines);
  const all = lines.map((line) => line.text).join("\n");
  const limit = Math.floor(pyLen(all) / 2);
  const fitted = fit(rows, limit);
  expect(fitted.trimmed).toBe(true);
  expect(pyLen(fitted.text) <= limit).toBe(true);
  expect(fitted.shown[0]).toBe(fitted.total[0]);
  expect(fitted.shown[2] < fitted.total[2]).toBe(true);
  for (const kept of fitted.text.split("\n")) expect(lines.some((line) => line.text === kept)).toBe(true);
  const parents = parentsOf(rows);
  rows.forEach((_, index) => {
    if (fitted.kept[index] && parents[index] !== -1) expect(fitted.kept[parents[index] as number]).toBe(true);
  });
});

test("a tight budget drops controls cleanly, keeps no bare wrapper alone, and the dropped refs are named", () => {
  const rows = rowsOf(linesOf(page()));
  const fitted = fit(rows, 200);
  expect(pyLen(fitted.text) <= 200).toBe(true);
  const kept = rows.filter((_, index) => fitted.kept[index]);
  const parents = parentsOf(rows);
  rows.forEach((row, index) => {
    if (!fitted.kept[index] || !row.bare) return;
    expect(rows.some((_, child) => parents[child] === index && fitted.kept[child])).toBe(true);
  });
  const dropped = droppedRefs(rows, fitted.kept);
  for (const row of kept) if (row.ref) expect(dropped.has(row.ref)).toBe(false);
  expect(dropped.size + kept.filter((row) => row.ref).length).toBe(rows.filter((row) => row.ref).length);
});

test("the notice and the reserved header fit inside the cap together", () => {
  const rows = rowsOf(linesOf(page()));
  for (const limit of [400, 1000, 2500]) {
    const fitted = fitWithNotice(rows, limit, 120);
    const body = fitted.notice === null ? fitted.text : `${fitted.text}\n${fitted.notice}`;
    expect(pyLen(body) + 120 <= limit).toBe(true);
    expect(fitted.notice?.startsWith(`[fit to ${limit} chars, controls first: `)).toBe(true);
  }
  const tight = fitWithNotice(rows, 180, 120);
  expect(tight.notice).toBe("[fit to 180 chars; --full for all]");
  expect(pyLen(`${tight.text}\n${tight.notice}`) + 120 <= 180).toBe(true);
  const roomy = fitWithNotice(rows, 1_000_000);
  expect(roomy.notice).toBe(null);
  expect(fitWithNotice(rows, 0).trimmed).toBe(false);
});

test("tiers: controls, then headings, labels and landmarks, then the rest", () => {
  expect(tierOf(node("button", "Go", [], "e1"), "e1")).toBe(1);
  expect(tierOf(node("generic", "Card", [], "e2", ["cursor:pointer"]), "e2")).toBe(1);
  expect(tierOf(node("heading", "Title", [], "e3"), "e3")).toBe(2);
  expect(tierOf(node("navigation"), null)).toBe(2);
  expect(tierOf(node("StaticText", "words"), null)).toBe(3);
  expect(tierOf(null, null)).toBe(2);
});

test("compaction folds single-child wrappers, shows a repeated name once, and keeps clickable only on the outermost ref", () => {
  const inner = node("generic", "Details", [node("StaticText", "Details")], "e5", ["cursor:pointer"]);
  const card = node("generic", "Card", [node("group", "", [node("group", "", [node("StaticText", "Card title")])]), inner], "e4", ["cursor:pointer"]);
  const row = node("row", "Ana 3", [node("cell", "Ana", [node("StaticText", "Ana")]), node("cell", "3", [node("StaticText", "3")])]);
  const link = node("link", "Read more", [node("StaticText", "Read"), node("StaticText", "more")], "e6");
  const empty = node("paragraph", "", []);
  const before = [card, row, link, empty];
  const shaped = compactTree(before);
  const text = render(shaped);
  expect(text).toContain('- generic "Card" [ref=e4] clickable [cursor:pointer]');
  expect(text).not.toContain("e5");
  expect(text).not.toContain("- group");
  expect(text).toContain('StaticText "Card title"');
  expect(text).toContain("- row\n");
  expect(text).toContain('- link "Read more" [ref=e6]');
  expect(text).not.toContain('StaticText "Read"');
  expect(card.hints).toEqual(["cursor:pointer"]);
  expect(inner.ref).toBe("e5");
  expect(render(before)).toContain("e5");
  expect(text).not.toContain("paragraph");
});

test("ambiguous controls are the nameless ones and the repeated ones, and their notes stay short", () => {
  const nodes = [node("button", "Delete", [], "e1"), node("button", "Delete", [], "e2"), node("button", "", [], "e3"), node("button", "Save", [], "e4")];
  const found = ambiguousControls(nodes);
  expect(found.map((entry) => entry.node.ref)).toEqual(["e1", "e2", "e3"]);
  expect(found.map((entry) => entry.nameless)).toEqual([false, false, true]);
  expect(noteOf({ icon: "trash", testid: "del" }, true, "Row 1")).toBe('icon "trash"');
  expect(noteOf({ icon: "trash", testid: "del" }, false, "Row 1")).toBe('near "Row 1"');
  expect(noteOf({ testid: "row-delete" }, false, null)).toBe('testid "row-delete"');
  expect(noteOf({ alt: 'The "logo"' }, true, null)).toBe('img "The \\"logo\\""');
  expect(noteOf({}, true, null)).toBe(null);
  expect(noteOf({ testid: "x".repeat(80) }, false, null)?.length).toBe(49);
});

test("hidden text is pruned from the accessibility tree while controls inside it stay", () => {
  const ax: AxNode[] = [
    { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "5"], backendDOMNodeId: 1 },
    { nodeId: "2", role: { value: "generic" }, childIds: ["3", "4"], backendDOMNodeId: 2 },
    { nodeId: "3", role: { value: "StaticText" }, name: { value: "Saved! (invisible toast)" }, childIds: [], backendDOMNodeId: 3 },
    { nodeId: "4", role: { value: "button" }, name: { value: "Dismiss" }, childIds: [], backendDOMNodeId: 4 },
    { nodeId: "5", role: { value: "StaticText" }, name: { value: "Visible words" }, childIds: [], backendDOMNodeId: 5 },
  ];
  const { nodes, dropped } = pruneHidden(ax, new Set([2]));
  expect(dropped).toBe(1);
  const text = render(buildTree(nodes));
  expect(text).not.toContain("invisible toast");
  expect(text).toContain('- button "Dismiss"');
  expect(text).toContain("Visible words");
  expect(pruneHidden(ax, new Set()).dropped).toBe(0);
  expect(ax[2]?.["ignored"]).toBe(undefined);
});

test("find matches names, roles and values, with 3 lines around each match and its container path", () => {
  const lines = linesOf(page());
  const found = search(lines, "buy 7");
  expect(found.matches.length).toBe(1);
  const match = found.matches[0] as { index: number; path: string };
  expect(match.path).toBe("main > list > listitem");
  const block = found.blocks[0] as { start: number; end: number };
  expect(match.index - block.start).toBe(3);
  expect(block.end - match.index).toBe(3);
  const text = foundText(lines, "buy 7", found);
  expect(text.split("\n")[0]).toBe(`snapshot find "buy 7": 1 match in ${lines.length} lines`);
  expect(text).toContain('>       - button "Buy 7" [ref=e17]');
  expect(text).toContain("in: main > list > listitem");
  expect(shownLines(found).size).toBe(7);
  expect(search(lines, "/^button \"Buy 1[0-9]\"/").matches.length).toBe(10);
  expect(search(lines, "Buy").blocks.length).toBe(1);
  expect(foundText(lines, "nothing like it", search(lines, "nothing like it"))).toContain("no matches");
  expect(() => matcher("/(/")).toThrow();
  expect(searchable({ text: '  - button "Go" [ref=f2e9]', level: 1, ref: "f2e9", node: null, tier: 1 })).toBe('button "Go"');
  expect(matcher("ref=e1")("button \"x\"")).toBe(false);
});

test("an ancestor path keeps the last steps and says when it skipped some", () => {
  const deep = [node("main", "", [node("region", "A", [node("region", "B", [node("region", "C", [node("region", "D", [node("region", "E", [node("button", "Go", [], "e1")])])])])])])];
  const lines = linesOf(deep);
  const index = lines.findIndex((line) => line.ref === "e1");
  expect(ancestorPath(lines, parentsOf(lines), index)).toBe('… > region "A" > region "B" > region "C" > region "D" > region "E"');
});

test("--diff-new counts repeats, so only what appeared since the last snapshot is new", () => {
  const before = linesOf([node("button", "Delete", [], "e1"), node("StaticText", "Row"), node("StaticText", "Row")]);
  const seen: Seen = { loader: "L", refs: new Set(["e1"]), keys: new Map(), command: 1 };
  for (const line of before) {
    const key = JSON.stringify([line.node?.role, line.node?.name, line.node?.value ?? ""]);
    seen.keys.set(key, (seen.keys.get(key) ?? 0) + 1);
  }
  const after = linesOf([node("button", "Delete", [], "e1"), node("StaticText", "Row"), node("StaticText", "Row"), node("StaticText", "Row"), node("button", "Delete", [], "e9"), node("navigation", "")]);
  expect(newIndexes(seen, after)).toEqual([3, 4]);
});

test("the epoch moves on with a new vocabulary, not with every navigation", () => {
  const keys = keysOf([{ role: "button", name: "Save" }, { role: "link", name: "" }]);
  expect([...keys]).toEqual(['["button","Save"]']);
  const before = { epoch: 3, loader: "A", keys: new Set(['["button","Save"]']) };
  expect(nextEpoch(undefined, "A", keys, true)).toBe(1);
  expect(nextEpoch(before, "A", keys, true)).toBe(3);
  expect(nextEpoch(before, "B", keys, true)).toBe(3);
  expect(nextEpoch(before, "B", new Set(['["button","Other"]']), true)).toBe(4);
  expect(nextEpoch(before, "A", new Set(['["button","Other"]']), true)).toBe(4);
  expect(nextEpoch(before, "A", new Set(['["button","Other"]']), false)).toBe(3);
  expect(nextEpoch(before, "A", new Set(), true)).toBe(3);
});

test("refs read as eN or, inside a cross-process frame, fNeM, in every written form", () => {
  for (const id of ["e1", "e42", "f1e7", "f12e3"]) {
    expect(isRefId(id)).toBe(true);
    expect(parseRef(`@${id}`)).toBe(id);
    expect(parseRef(`ref=${id}`)).toBe(id);
    expect(parseRef(`[ref=${id}]`)).toBe(id);
    expect(isBareRef(id)).toBe(true);
  }
  for (const text of ["f1", "fe1", "e", "@f1e", "f1e2x", "#e1", "E1", "ff1e2"]) expect(parseRef(text)).toBe(null);
  expect(refNumber("f3e17")).toBe(17);
  expect(refNumber("e5")).toBe(5);
  expect(refNumber("x")).toBe(null);
});

test("DOM.getDocument retries shallower when the tree overflows and fills the branches it cut", async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const full = { nodeId: 3, backendNodeId: 30, childNodeCount: 1, children: [{ nodeId: 4, backendNodeId: 40, shadowRoots: [{ nodeId: 5, backendNodeId: 50, shadowRootType: "closed", childNodeCount: 0 }] }] };
  const send = async (method: string, params: Record<string, unknown>) => {
    calls.push([method, params]);
    if (method === "DOM.getDocument" && params["depth"] === -1) throw new CdpError(method, "Object reference chain is too long");
    if (method === "DOM.getDocument") return { root: { nodeId: 1, backendNodeId: 10, childNodeCount: 1, children: [{ nodeId: 2, backendNodeId: 20, childNodeCount: 1 }] } };
    if (method === "DOM.describeNode") return { node: { nodeId: 2, backendNodeId: 20, children: [full] } };
    throw new Error(`unexpected ${method}`);
  };
  const { root, depth, fills } = await documentTree(send);
  expect(depth).toBe(64);
  expect(fills).toBe(1);
  expect(calls.map(([method, params]) => `${method}:${String(params["depth"])}`)).toEqual(["DOM.getDocument:-1", "DOM.getDocument:64", "DOM.describeNode:24"]);
  expect(calls[2]?.[1]["nodeId"]).toBe(2);
  expect(missingBranches(root).length).toBe(0);
  expect(closedRoots(root, "main")).toEqual([{ backend: 50, frame: "main" }]);
  await expect(documentTree(async () => {
    throw new CdpError("DOM.getDocument", "No target with given id");
  })).rejects.toThrow("No target");
  expect(overflowed(new RangeError("Maximum call stack size exceeded"))).toBe(true);
  expect(overflowed(new CdpError("DOM.getDocument", "Message is too large"))).toBe(true);
  expect(overflowed(new CdpError("DOM.getDocument", "Node not found"))).toBe(false);
});

test("closed shadow roots inside a same-process frame belong to that frame", () => {
  const root = {
    nodeId: 1,
    children: [
      { nodeId: 2, frameId: "child", contentDocument: { nodeId: 3, children: [{ nodeId: 4, shadowRoots: [{ nodeId: 5, backendNodeId: 55, shadowRootType: "closed" }] }] } },
      { nodeId: 6, shadowRoots: [{ nodeId: 7, backendNodeId: 77, shadowRootType: "open" }] },
    ],
  };
  expect(closedRoots(root, "main")).toEqual([{ backend: 55, frame: "child" }]);
});

test("paired boxes are in image pixels and clipped to the image", () => {
  const png = new Uint8Array(24);
  new DataView(png.buffer).setUint32(16, 1600);
  new DataView(png.buffer).setUint32(20, 1200);
  expect(pngSize(png)).toEqual([1600, 1200]);
  expect(pngSize(new Uint8Array(4))).toEqual([0, 0]);
  const box = boxOfQuad([10, 20, 110, 20, 110, 70, 10, 70], [5, 5], 2);
  expect(box).toEqual({ x: 30, y: 50, width: 200, height: 100 });
  expect(clipToImage({ x: -10, y: 1190, width: 50, height: 40 }, 1600, 1200)).toEqual({ x: 0, y: 1190, width: 40, height: 10 });
  expect(clipToImage({ x: 1700, y: 0, width: 10, height: 10 }, 1600, 1200)).toBe(null);
});

test("walk still visits a compacted tree in document order", () => {
  const shaped = compactTree([node("group", "", [node("group", "", [node("button", "A", [], "e1")])]), node("button", "B", [], "e2")]);
  expect([...walk(shaped)].map((found) => found.name)).toEqual(["A", "B"]);
});

test("refs are labeled only while every collected frame keeps its document and its renderer", () => {
  const loaders = new Map([["MAIN", "L1"], ["OOPIF", "L2"]]);
  const frameSessions = new Map([["OOPIF", "S1"]]);
  const fake = { loader: (frame: string) => loaders.get(frame) ?? null, frameSessions } as unknown as Page;
  const nodes = [node("button", "Go", [], "e1")];
  collectedIdentity.set(nodes, new Map([["MAIN", { loader: "L1", session: null }], ["OOPIF", { loader: "L2", session: "S1" }]]));
  sameIdentity(fake, nodes);
  frameSessions.set("OOPIF", "S2");
  expect(() => sameIdentity(fake, nodes)).toThrow("changed document while the snapshot was being taken");
  frameSessions.set("OOPIF", "S1");
  loaders.set("OOPIF", "L3");
  expect(() => sameIdentity(fake, nodes)).toThrow("changed document");
  loaders.set("OOPIF", "L2");
  loaders.set("MAIN", "L9");
  expect(() => sameIdentity(fake, nodes)).toThrow("changed document");
  expect(() => sameIdentity(fake, [node("button")])).not.toThrow();
});

test("headers are kept whole or not at all, and the body gets what they leave", () => {
  const headers = ["(a header of twenty)", "(another one that is long enough to not fit)", "(short)"];
  expect(fitHeaders(headers, 40)).toEqual(["(a header of twenty)", "(short)"]);
  expect(fitHeaders(headers, null)).toEqual(headers);
  expect(fitHeaders(headers, 0)).toEqual([]);
  expect(roomAfter(["(a header of twenty)"], 100)).toBe(79);
  expect(roomAfter(["(a header of twenty)"], 100, 30)).toBe(49);
  expect(roomAfter(["x".repeat(200)], 100)).toBe(0);
  expect(roomAfter(["x"], 0)).toBe(0);
});

test("find over the cap drops whole blocks from the end and says how many matches it left out", () => {
  const QUERY = '/Buy (5|25)"$/';
  const lines = linesOf(page());
  const found = search(lines, "Buy");
  const spread = search(lines, QUERY);
  expect(spread.blocks.length).toBe(2);
  const one = fitFound(lines, QUERY, spread, pyLen(foundText(lines, QUERY, { blocks: spread.blocks.slice(0, 1), matches: spread.blocks[0]?.matches ?? [], more: 1 })));
  expect(one.blocks.length).toBe(1);
  expect(one.more).toBe(1);
  const text = foundText(lines, QUERY, one);
  expect(text).toContain("the first 1 are shown");
  expect(shownLines(one).size).toBe(7);
  const some = fitFound(lines, "Buy", found, 600);
  expect(some.matches.length > 0 && some.matches.length < found.matches.length).toBe(true);
  expect(pyLen(foundText(lines, "Buy", some)) <= 600).toBe(true);
  expect(some.blocks.at(-1)?.matches.at(-1)).toBe(some.matches.at(-1));
  const none = fitFound(lines, "Buy", found, 10);
  expect(none.blocks.length).toBe(0);
  expect(foundText(lines, "Buy", none)).toContain("none fit under the output cap");
  expect(fitFound(lines, "Buy", found, 1_000_000).blocks.length).toBe(found.blocks.length);
});

test("a collect whose frame changed document during the accessibility read fails instead of labeling its nodes", async () => {
  const loaders = new Map([["MAIN", "L1"]]);
  const sent: string[] = [];
  const fake = {
    mainFrame: "MAIN",
    frames: new Map([["MAIN", {}]]),
    frameSessions: new Map<string, string>(),
    loader: (frame: string) => loaders.get(frame) ?? null,
    sessionFor: () => "PAGE",
    refreshFrames: async () => new Map(),
    send: async (method: string) => {
      sent.push(method);
      if (method === "Accessibility.getFullAXTree") {
        loaders.set("MAIN", "L2");
        return { nodes: [{ nodeId: "1", role: { value: "button" }, name: { value: "Go" }, backendDOMNodeId: 5, childIds: [] }] };
      }
      return {};
    },
    call: async () => [],
    elementsFrom: async () => [],
  } as unknown as Page;
  const state = { frameFor: () => null, refForNode: () => "e1", instance: "I" } as unknown as State;
  await expect(collect(state, fake, null, false)).rejects.toThrow("changed document while the snapshot was being taken");
  expect(sent[0]).toBe("Accessibility.getFullAXTree");
  loaders.set("MAIN", "L1");
  const steady = { ...fake, send: async () => ({ nodes: [{ nodeId: "1", role: { value: "button" }, name: { value: "Go" }, backendDOMNodeId: 5, childIds: [] }] }) } as unknown as Page;
  const nodes = await collect(state, steady, null, false);
  expect(collectedIdentity.get(nodes)?.get("MAIN")).toEqual({ loader: "L1", session: null });
});

test("the paired line is measured as it will print, shortened when the path doesn't fit, and left out when nothing does", () => {
  const shown = { width: 1280, height: 800, boxes: [], stable: true };
  expect(pairedLine("a.png", shown)).toBe("✓ Screenshot saved to a.png (1280×800 px, 0 ref boxes in image pixels)");
  expect(pairedLine("a.png", shown, "short")).toBe("✓ Screenshot saved (1280×800 px, 0 ref boxes in image pixels)");
  const line = pairedLine("a.png", shown);
  expect(pyLen(line) < 100).toBe(true);
  expect(pairedChoice("a.png", 100, shown)).toEqual({ form: "full", room: pyLen(line) + 1 });
  const long = `${"deep/".repeat(60)}shot.png`;
  expect(pairedChoice(long, 200, shown).form).toBe("short");
  expect(pairedChoice(long, 50, shown)).toEqual({ form: null, room: 0 });
  expect(pairedChoice(long, 0, shown).form).toBe("full");
  const shaky = { ...shown, stable: false };
  expect(pairedChoice("a.png", 100, shaky).form).toBe(null);
  expect(pairedChoice("a.png", 200, shaky).form).toBe("full");
});

test("verifying identity reads the frame tree again, past its short cache, so a child that navigated is caught", async () => {
  const loaders = new Map([["MAIN", "L1"], ["CHILD", "C1"]]);
  const forced: unknown[] = [];
  const fake = {
    loader: (frame: string) => loaders.get(frame) ?? null,
    frameSessions: new Map<string, string>(),
    frameTreeSettled: true,
    refreshFrames: async (force?: boolean) => {
      forced.push(force);
      if (force) loaders.set("CHILD", "C2");
      return new Map();
    },
  } as unknown as Page;
  const nodes = [node("button", "In child", [], "e1")];
  collectedIdentity.set(nodes, new Map([["MAIN", { loader: "L1", session: null }], ["CHILD", { loader: "C2", session: null }]]));
  await verifyIdentity(fake, nodes);
  loaders.set("CHILD", "C1");
  collectedIdentity.set(nodes, new Map([["MAIN", { loader: "L1", session: null }], ["CHILD", { loader: "C1", session: null }]]));
  await expect(verifyIdentity(fake, nodes)).rejects.toThrow("changed document");
  expect(forced).toEqual([true, true]);
});

function row(ref: string, role: string, name: string, attrs: string[] = []): Row {
  const shown = attrs.length ? `${attrs.join(", ")}, ref=${ref}` : `ref=${ref}`;
  return { ref, level: 0, role, name, value: "", attrs, line: `${role} "${name}" [${shown}]` };
}

function reportOf(parts: Partial<Report>): Report {
  return { rerendered: [], document: "same", url: null, title: null, added: [], removed: [], changed: [], network: [], context: [], ...parts } as Report;
}

test("every change report line carries exactly the refs it prints, runs and disabled runs included", () => {
  const disabled = Array.from({ length: 20 }, (_, index) => row(`e${index + 2}`, "button", `Seat ${index}`, ["disabled"]));
  const report = reportOf({
    added: [row("e1", "link", "Refer to e42 ref=e43"), ...disabled],
    changed: [[row("e30", "link", "Old"), row("e30", "link", "New")]],
    rerendered: [[row("e50", "button", "A"), row("e60", "button", "A")], [row("e51", "button", "B"), row("e61", "button", "B")], [row("e52", "button", "C"), row("e62", "button", "C")]],
  });
  const lines = renderReportLines(report);
  expect(reportText(lines)).toBe(renderReport(report));
  const byText = new Map(lines.map((line) => [line.text, line.refs]));
  expect(byText.get('+ link "Refer to e42 ref=e43" [ref=e1]')).toEqual(["e1"]);
  const run = lines.find((line) => line.text.includes("20 buttons"));
  expect(run?.text).toContain("e2…e21; 20 disabled");
  expect(run?.refs).toEqual(disabled.map((item) => item.ref as string));
  expect(lines.find((line) => line.text.startsWith("~ "))?.refs).toEqual(["e30"]);
  expect(lines.find((line) => line.text.includes("redrawn"))?.refs).toEqual(["e60", "e61", "e62"]);
  expect([...new Set(lines.flatMap((line) => line.refs))].includes("e42")).toBe(false);
  expect(reportText([])).toBe("changes: none");
});

test("a --diff report fits by whole lines, gives only the surviving lines' refs, and keeps nothing at no room", () => {
  const lines = Array.from({ length: 30 }, (_, index) => ({ text: `+ button "Row ${index}" [ref=e${index + 1}]`, refs: [`e${index + 1}`] }));
  const fitted = fitReport(lines, 200);
  expect(fitted.trimmed).toBe(true);
  expect(pyLen(fitted.text) <= 200).toBe(true);
  expect(fitted.text.split("\n").at(-1)).toMatch(/^\[\d+ more change lines past the cap; --full lists them\]$/u);
  const kept = fitted.text.split("\n").length - 2;
  expect([...fitted.exposed]).toEqual(lines.slice(0, kept).map((line) => line.refs[0] as string));
  expect(fitReport(lines, null).exposed.size).toBe(30);
  expect(fitReport(lines, 0)).toEqual({ text: "", exposed: new Set(), trimmed: true });
  expect(fitReport([], 5).text).toBe("");
});

test("a dialog that opened shows in the --diff report even with nothing to click in it", () => {
  const dialog = new Node("alertdialog", "Session", "", new Map(), 77, [node("StaticText", "Your session expired")], null, null, null, "F");
  const before = { target: "t", loader: "L", url: "", title: "", entries: [], containers: new Set<string>() };
  const after = { ...before, containers: new Set([JSON.stringify(["F", 77])]) };
  const opened = openedDialogs(before, after, [dialog]);
  expect(opened).toEqual([{ text: '+ alertdialog "Session" opened: "Your session expired"', refs: [] }]);
  expect(openedDialogs(after, after, [dialog])).toEqual([]);
  expect(reportText(opened)).toBe('changes:\n+ alertdialog "Session" opened: "Your session expired"');
});

test("a find summary that can't fit whole is shortened, then left out", () => {
  const lines = linesOf(page());
  const none = search(lines, "nothing like this anywhere");
  const full = foundWithin(lines, "nothing like this anywhere", none, null);
  expect(full).toContain("(search is over names");
  expect(foundWithin(lines, "nothing like this anywhere", none, 60)).toBe('snapshot find "nothing like this anywhere": no matches');
  expect(foundWithin(lines, "nothing like this anywhere", none, 20)).toBe("");
});

test("an unsettled forced frame read is a changed document, not a pass on the old map", async () => {
  const fake = {
    loader: () => "L1",
    frameSessions: new Map<string, string>(),
    frameTreeSettled: true,
    async refreshFrames(this: { frameTreeSettled: boolean }) {
      this.frameTreeSettled = false;
      return new Map();
    },
  };
  const nodes = [node("button", "Go", [], "e1")];
  collectedIdentity.set(nodes, new Map([["MAIN", { loader: "L1", session: null }]]));
  await expect(verifyIdentity(fake as unknown as Page, nodes)).rejects.toThrow("changed document");
});

test("the paired line is sized for the plural, so one box becoming none never outgrows its room", () => {
  const base = { width: 800, height: 600, stable: true };
  const room = pairedChoice("p.png", 100, { ...base, boxes: new Array(Math.max(1, 2)) }).room;
  for (const count of [0, 1]) expect(pyLen(pairedLine("p.png", { ...base, boxes: new Array(count) })) + 1 <= room).toBe(true);
});

test("snapshot -i --diff registers no ref the fitted report left out, even one folded out of the -i lines", () => {
  const disabled = Array.from({ length: 12 }, (_, index) => node("button", `Seat ${index}`, [], `e${index + 10}`));
  for (const seat of disabled) seat.props.set("disabled", true);
  const nodes = [node("button", "Book", [], "e1"), ...disabled];
  const listed = renderListed(nodes, null, false);
  expect(listed.some((entry) => entry.ref === "e12")).toBe(false);
  const fitted = fitReport([{ text: '+ button "Book" [ref=e1]', refs: ["e1"] }], null);
  const excluded = new Set([...walk(nodes)].flatMap((found) => (found.ref && !fitted.exposed.has(found.ref) ? [found.ref] : [])));
  expect([...excluded].sort()).toEqual(disabled.map((seat) => seat.ref as string).sort());
});
