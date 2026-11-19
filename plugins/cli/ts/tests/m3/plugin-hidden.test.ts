import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { methodsBetweenMarks, pluginViolations } from "./plugin-rules.ts";
import { CREDENTIAL, entries, FULL_CHROME, pageTarget, startWorld, step, stopWorld, tap, type World } from "./plugin-world.ts";

setDefaultTimeout(120_000);
const BASE = Number(process.env["ARDIA_F1_PORTS"] ?? "9660") + 30;

async function owner(world: World) {
  const version = (await (await fetch(`http://127.0.0.1:${world.chromePort}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve) => (socket.onopen = resolve));
  let next = 0;
  const waiting = new Map<number, (value: Record<string, unknown>) => void>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown> };
    if (message.id !== undefined) waiting.get(message.id)?.(message.result ?? {});
  };
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    next += 1;
    socket.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<Record<string, unknown>>((resolve) => waiting.set(next, resolve));
  };
  return { send, close: () => socket.close() };
}

describe.skipIf(!FULL_CHROME)("acts on a hidden tab with the act visibility hold (full Chrome for Testing, --headless=new)", () => {
  let world: World;
  let loader = "";
  let harness: Awaited<ReturnType<typeof owner>>;
  let visibility: () => Promise<string>;
  const holds = (name: string) => {
    const all = entries(world);
    const at = all.findIndex((entry) => entry.k === "mark" && entry.step === name);
    const end = all.findIndex((entry, index) => index > at && entry.k === "mark");
    return all.slice(at, end < 0 ? undefined : end).filter((entry) => entry.k === "hold").map((entry) => entry["state"]);
  };

  beforeAll(async () => {
    world = await startWorld(BASE, CREDENTIAL, "plugin-ai", undefined, true);
    const front = await pageTarget(world);
    harness = await owner(world);
    const target = String((await harness.send("Target.createTarget", { url: `http://127.0.0.1:${world.sitePort}/far`, background: true }))["targetId"]);
    const session = String((await harness.send("Target.attachToTarget", { targetId: target, flatten: true }))["sessionId"]);
    visibility = async () => String(((await harness.send("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }, session))["result"] as { value: unknown }).value);
    await new Promise((resolve) => setTimeout(resolve, 800));
    await tap(world, "hold", { target, front });
    const picked = await step(world, ["tab", target], { json: true });
    loader = String((JSON.parse(picked.out) as { data: { loader: string } }).data.loader);
  });

  afterAll(async () => {
    harness?.close();
    if (world) await stopWorld(world);
  });

  test("reads leave the tab hidden: no hold, no wheel", async () => {
    expect(await visibility()).toBe("hidden");
    const shot = await step(world, ["snapshot", "-i"], { expect_loader: loader }, CREDENTIAL, world.key, "hidden read");
    expect(shot.exit).toBe(0);
    expect(holds("hidden read")).toEqual([]);
    expect(methodsBetweenMarks(entries(world)).get("hidden read")).not.toContain("Input.dispatchMouseEvent");
    expect(await visibility()).toBe("hidden");
  });

  test("an act brings an off-screen button into view with wheels and clicks it, then the tab is hidden again [tap emulates the act visibility hold] [tap emulates Ardia.dispatchClick]", async () => {
    const shot = await step(world, ["snapshot", "-i"], { expect_loader: loader });
    const far = /button "Far" \[ref=(e\d+)\]/u.exec(shot.out)?.[1] as string;
    const clicked = await step(world, ["click", "--", `@${far}`], { expect_loader: loader, no_changes: true }, CREDENTIAL, world.key, "hidden act");
    expect(clicked.exit).toBe(0);
    expect(holds("hidden act")).toEqual(["on", "off"]);
    const sent = methodsBetweenMarks(entries(world)).get("hidden act") ?? [];
    expect(sent).toContain("Input.dispatchMouseEvent");
    expect(sent.indexOf("Input.dispatchMouseEvent")).toBeLessThan(sent.indexOf("Ardia.dispatchClick"));
    expect(await visibility()).toBe("hidden");
    expect((await step(world, ["get", "title"], { expect_loader: loader })).out).toBe("Far pressed\n");
  });

  test("an explicit scroll is an act: the tab is held visible for it and hidden after [tap emulates the act visibility hold]", async () => {
    const scrolled = await step(world, ["scroll", "up", "500"], { expect_loader: loader, no_changes: true }, CREDENTIAL, world.key, "hidden scroll");
    expect(scrolled.exit).toBe(0);
    expect(holds("hidden scroll")).toEqual(["on", "off"]);
    expect(entries(world).filter((entry) => entry.k === "visibility").every((entry) => entry["state"] === "visible")).toBe(true);
    expect(await visibility()).toBe("hidden");
  });

  test("the tap: (a), (b), (c) and (e) hold", () => {
    expect(pluginViolations(entries(world))).toEqual([]);
  });
});
