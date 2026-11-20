import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { pluginViolations } from "./plugin-rules.ts";
import { CHROME, entries, pageTarget, resetPage, startWorld, step, stopWorld, type World } from "./plugin-world.ts";

setDefaultTimeout(120_000);
const BASE = Number(process.env["ARDIA_F1_PORTS"] ?? "9460") + 9;

describe.skipIf(!CHROME)("F1.1: same-site child frames in the AX snapshot", () => {
  let world: World;
  let loader = "";

  beforeAll(async () => {
    world = await startWorld(BASE);
    const target = await pageTarget(world);
    await resetPage(world, target, `http://127.0.0.1:${world.sitePort}/frames`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const picked = await step(world, ["tab", target], { json: true });
    loader = String((JSON.parse(picked.out) as { data: { loader: string } }).data.loader);
  });

  afterAll(async () => {
    if (world) await stopWorld(world);
  });

  test("the same-site frame is read with refs, and the cross-site one is counted as not read", async () => {
    const shot = await step(world, ["snapshot", "-i"], { expect_loader: loader });
    expect(shot.exit).toBe(0);
    expect(shot.out).toMatch(/button "Inner" \[ref=e\d+\]/u);
    expect(shot.out.match(/button "Inner"/gu)).toHaveLength(1);
    expect(shot.out.trimEnd().endsWith("1 embedded frame not read")).toBe(true);
    const json = await step(world, ["snapshot", "-i"], { expect_loader: loader, json: true });
    expect((JSON.parse(json.out) as { data: { framesNotRead: number } }).data.framesNotRead).toBe(1);
  });

  test("a ref inside the same-site frame clicks there [tap emulates Ardia.dispatchClick]", async () => {
    const shot = await step(world, ["snapshot", "-i"], { expect_loader: loader });
    const ref = /button "Inner" \[ref=(e\d+)\]/u.exec(shot.out)?.[1] as string;
    const clicked = await step(world, ["click", "--", `@${ref}`], { expect_loader: loader });
    expect(clicked.exit).toBe(0);
    expect((await step(world, ["get", "title"], { expect_loader: loader })).out).toBe("Child pressed\n");
  });

  test("the tap: (a) and (b) hold, and no lease-gated method went out during a read", () => {
    expect(pluginViolations(entries(world))).toEqual([]);
  });
});
