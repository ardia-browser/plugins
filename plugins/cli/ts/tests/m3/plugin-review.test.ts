import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { methodsBetweenMarks, pluginViolations } from "./plugin-rules.ts";
import { CHROME, CREDENTIAL, entries, openTab, pageTarget, resetPage, startWorld, step, stopWorld, tap, type World } from "./plugin-world.ts";

setDefaultTimeout(120_000);
const BASE = Number(process.env["ARDIA_F1_PORTS"] ?? "9460") + 6;
const LEASE = "ardia: document_changed: no act lease covers this document";

describe.skipIf(!CHROME)("plugins#21 review round 1, against headless Chrome for Testing through the tap", () => {
  let world: World;
  let first = "";

  async function pick(target: string): Promise<string> {
    const picked = await step(world, ["tab", target], { json: true });
    return String((JSON.parse(picked.out) as { data: { loader: string } }).data.loader);
  }

  async function marked(name: string, argv: string[], options: Record<string, unknown> = {}) {
    return step(world, argv, options, CREDENTIAL, world.key, name);
  }

  const sentIn = (name: string) => methodsBetweenMarks(entries(world)).get(name) ?? [];

  beforeAll(async () => {
    world = await startWorld(BASE);
    first = await pageTarget(world);
  });

  afterAll(async () => {
    if (world) await stopWorld(world);
  });

  test("1. a ref from another tab is stale (exit 1) and nothing acts on that tab [tap emulates Ardia.dispatchClick]", async () => {
    const loaderA = await pick(first);
    expect((await step(world, ["snapshot", "-i"], { expect_loader: loaderA })).exit).toBe(0);
    const second = await openTab(world);
    const loaderB = await pick(second);
    const crossed = await marked("cross-tab ref", ["click", "--", "@e3"], { expect_loader: loaderB, json: true });
    expect(crossed).toMatchObject({ exit: 1, code: "stale_ref" });
    const sent = sentIn("cross-tab ref");
    expect(sent.filter((method) => method.startsWith("Input.") || method === "Ardia.dispatchClick" || method.startsWith("DOM."))).toEqual([]);
    const attachedTo = entries(world).filter((entry) => entry.k === "out" && String(entry.m).includes('"Target.attachToTarget"')).map((entry) => (JSON.parse(String(entry.m)) as { params: { targetId: string } }).params.targetId);
    const stepAt = entries(world).findIndex((entry) => entry.k === "mark" && entry.step === "cross-tab ref");
    const inStep = entries(world).slice(stepAt).findIndex((entry, index) => index > 0 && entry.k === "done");
    const stepAttaches = entries(world).slice(stepAt, stepAt + inStep).filter((entry) => entry.k === "out" && String(entry.m).includes('"Target.attachToTarget"')).map((entry) => (JSON.parse(String(entry.m)) as { params: { targetId: string } }).params.targetId);
    expect(attachedTo.length).toBeGreaterThan(0);
    expect(stepAttaches).not.toContain(first);
    await pick(first);
  });

  test("3. a coded refusal is never swallowed: scroll stops before any input", async () => {
    const loader = await pick(first);
    await tap(world, "fault", { kind: "error", method: "Page.getLayoutMetrics", at: 1, message: LEASE });
    const scrolled = await marked("scroll refused", ["scroll", "down", "50"], { expect_loader: loader, json: true });
    await tap(world, "fault", {});
    expect(scrolled).toMatchObject({ exit: 1, code: "document_changed" });
    expect(sentIn("scroll refused").filter((method) => method.startsWith("Input."))).toEqual([]);
  });

  test("3. get title keeps an out-of-scope refusal instead of answering an empty title", async () => {
    await tap(world, "fault", { kind: "error", method: "Target.getTargetInfo", at: 1, message: "ardia: tab_out_of_scope: the tab moved to another window" });
    const title = await marked("title refused", ["get", "title"], { json: true });
    await tap(world, "fault", {});
    expect(title).toMatchObject({ exit: 1, code: "tab_out_of_scope" });
  });

  test("3. the before-view of a click keeps a lease refusal and clicks nothing", async () => {
    const loader = await pick(first);
    expect((await step(world, ["snapshot", "-i"], { expect_loader: loader })).exit).toBe(0);
    await tap(world, "fault", { kind: "error", method: "Accessibility.getFullAXTree", at: 1, message: LEASE });
    const clicked = await marked("before-view refused", ["click", "--", "@e3"], { json: true });
    await tap(world, "fault", {});
    expect(clicked).toMatchObject({ exit: 1, code: "document_changed" });
    expect(sentIn("before-view refused").filter((method) => method.startsWith("Input.") || method === "Ardia.dispatchClick")).toEqual([]);
  });

  test("5. a step that fails after the page loaded a new document answers document_changed_after", async () => {
    await resetPage(world, first);
    const loader = await pick(first);
    const waiting = step(world, ["wait", "--text=Never shown", "--timeout=3000"], { expect_loader: loader, json: true });
    await new Promise((resolve) => setTimeout(resolve, 700));
    await resetPage(world, first, `http://127.0.0.1:${world.sitePort}/done`, false);
    const waited = await waiting;
    expect(waited).toMatchObject({ exit: 1, code: "document_changed_after" });
    expect(JSON.parse(waited.out)).toMatchObject({ data: { ran: true } });
  });

  test("round 14: an element below the fold is wheeled into view, then clicked, with no scrollIntoViewIfNeeded [tap emulates Ardia.dispatchClick]", async () => {
    await resetPage(world, first, `http://127.0.0.1:${world.sitePort}/far`);
    const loader = await pick(first);
    const shot = await step(world, ["snapshot", "-i"], { expect_loader: loader });
    const far = /button "Far" \[ref=(e\d+)\]/u.exec(shot.out)?.[1] as string;
    const stuck = /button "Stuck" \[ref=(e\d+)\]/u.exec(shot.out)?.[1] as string;
    const clicked = await marked("wheel into view", ["click", "--", `@${far}`], { expect_loader: loader, no_changes: true });
    expect(clicked.exit).toBe(0);
    expect((await step(world, ["get", "title"])).out).toBe("Far pressed\n");
    const sent = sentIn("wheel into view");
    expect(sent).not.toContain("DOM.scrollIntoViewIfNeeded");
    expect(sent.indexOf("Input.dispatchMouseEvent")).toBeGreaterThan(-1);
    expect(sent.indexOf("Input.dispatchMouseEvent")).toBeLessThan(sent.indexOf("Ardia.dispatchClick"));
    const refused = await marked("never in view", ["click", "--", `@${stuck}`], { expect_loader: loader, no_changes: true, json: true });
    expect(refused).toMatchObject({ exit: 1, code: "outside_viewport" });
    const wheels = sentIn("never in view").filter((method) => method === "Input.dispatchMouseEvent").length;
    expect(wheels).toBe(4);
    expect(sentIn("never in view")).not.toContain("Ardia.dispatchClick");
  });

  test("the tap: (a), (b) and (c) still hold", () => {
    expect(pluginViolations(entries(world))).toEqual([]);
  });
});
