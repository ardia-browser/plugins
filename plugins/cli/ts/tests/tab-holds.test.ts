import assert from "node:assert/strict";
import { test } from "bun:test";
import { ACTIVE_FOR, HOLD_SECONDS, heldAppTabs, MAX_HELD, RENEW_EVERY, recentlyUsed, TabHolds } from "../src/browse/daemon/holds.ts";
import { ControlRefused } from "../src/browse/state/apptabs.ts";

type Call = [string, Record<string, unknown>];

function recorder(answer: (method: string, params: Record<string, unknown>) => unknown = (method, params) => (method === "tabs.hold" ? { held: params["tabs"] } : { released: [] })) {
  const calls: Call[] = [];
  const holds = new TabHolds("s1", async (method, params) => {
    calls.push([method, params]);
    const reply = answer(method, params);
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { calls, holds };
}

test("holds the session's tabs under its own name, renews before the app's hold runs out, and replaces the list when it changes", async () => {
  assert.ok(RENEW_EVERY < HOLD_SECONDS && ACTIVE_FOR > RENEW_EVERY);
  const { calls, holds } = recorder();
  await holds.tick(["tab-a"], 0);
  await holds.tick(["tab-a"], 2);
  assert.deepEqual(calls, [["tabs.hold", { session: "s1", tabs: ["tab-a"], seconds: HOLD_SECONDS }]], "no call while nothing changed");
  await holds.tick(["tab-a"], RENEW_EVERY);
  assert.equal(calls.length, 2, "renewed");
  await holds.tick(["tab-b"], RENEW_EVERY + 2);
  assert.deepEqual(calls.at(-1), ["tabs.hold", { session: "s1", tabs: ["tab-b"], seconds: HOLD_SECONDS }], "one call replaces the list");
  await holds.tick([], RENEW_EVERY + 4);
  assert.deepEqual(calls.at(-1), ["tabs.release", { session: "s1" }], "nothing recent lets go");
  assert.deepEqual(holds.holding, []);
});

test("what the app accepted is what the daemon thinks it holds", async () => {
  const { holds } = recorder((method) => (method === "tabs.hold" ? { held: ["tab-a"], gone: ["tab-gone"] } : {}));
  await holds.tick(["tab-a", "tab-gone"], 0);
  assert.deepEqual(holds.holding, ["tab-a"]);
});

test("a failed hold or release is tried again on the next tick, and an Ardia without tabs.hold is never asked again", async () => {
  let refuse = true;
  const { calls, holds } = recorder((method, params) => (refuse ? new ControlRefused("timeout", "slow") : method === "tabs.hold" ? { held: params["tabs"] } : {}));
  await holds.tick(["tab-a"], 0);
  refuse = false;
  await holds.tick(["tab-a"], 2);
  assert.deepEqual(holds.holding, ["tab-a"]);
  refuse = true;
  await holds.tick([], 4);
  assert.deepEqual(holds.holding, ["tab-a"], "the release failed, so it still counts as held");
  refuse = false;
  await holds.tick([], 6);
  assert.deepEqual(holds.holding, []);
  assert.equal(calls.length, 4);

  const old = recorder(() => new ControlRefused("unknown_method", "There's no method tabs.hold."));
  await old.holds.tick(["tab-a"], 0);
  await old.holds.tick(["tab-b"], 2);
  await old.holds.close();
  assert.equal(old.calls.length, 1);
});

test("close waits for a hold already on its way, then releases, and nothing is held after it", async () => {
  let finish: () => void = () => {};
  const calls: string[] = [];
  const holds = new TabHolds("s1", async (method, params) => {
    calls.push(method);
    if (method === "tabs.hold") await new Promise<void>((resolve) => (finish = resolve));
    return method === "tabs.hold" ? { held: params["tabs"] } : {};
  });
  const ticking = holds.tick(["tab-a"], 0);
  while (calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  const closing = holds.close();
  const late = holds.tick(["tab-b"], 1);
  finish();
  await Promise.all([ticking, closing, late]);
  assert.deepEqual(calls, ["tabs.hold", "tabs.release"]);
  assert.deepEqual(holds.holding, []);
});

test("only tabs used in the last few minutes are held, newest first, and closed or unmapped ones never crowd out a live tab", () => {
  const used = new Map<string, number>([["old", 0], ["recent", ACTIVE_FOR], ["newest", ACTIVE_FOR + 5]]);
  assert.deepEqual(recentlyUsed(used, ACTIVE_FOR + 10), ["newest", "recent"]);
  const closed = Array.from({ length: MAX_HELD }, (_, i) => `closed-${i}`);
  const recent = [...closed, "live-a", "unmapped", "live-b"];
  const appTab = (target: string) => (target.startsWith("live") ? `tab-${target}` : target === "unmapped" ? undefined : `tab-${target}`);
  assert.deepEqual(heldAppTabs(recent, (target) => !target.startsWith("closed"), appTab), ["tab-live-a", "tab-live-b"]);
  const many = Array.from({ length: MAX_HELD + 5 }, (_, i) => `live-${i}`);
  assert.equal(heldAppTabs(many, () => true, appTab).length, MAX_HELD);
});

test("a hold whose answer was lost is still released at close, since it may have reached Ardia", async () => {
  let lose = true;
  const { calls, holds } = recorder((method, params) => (method === "tabs.hold" && lose ? new ControlRefused("timeout", "lost") : method === "tabs.hold" ? { held: params["tabs"] } : {}));
  await holds.tick(["tab-a"], 0);
  lose = false;
  await holds.close();
  assert.deepEqual(calls.map(([method]) => method), ["tabs.hold", "tabs.release"]);
});

test("when Ardia has no room for another session, the daemon says so and asks again a minute later, not every tick", async () => {
  const refusals: string[] = [];
  const calls: string[] = [];
  const holds = new TabHolds(
    "s5",
    async (method) => {
      calls.push(method);
      throw new ControlRefused("refused", "At most 4 sessions can hold tabs at once.");
    },
    (why) => refusals.push(why),
  );
  await holds.tick(["tab-a"], 0);
  await holds.tick(["tab-b", "tab-a"], 2);
  await holds.tick(["tab-c"], RENEW_EVERY - 1);
  assert.equal(calls.length, 1, "a different list doesn't skip the wait");
  assert.deepEqual(refusals, ["At most 4 sessions can hold tabs at once."]);
  await holds.tick(["tab-c"], RENEW_EVERY);
  assert.equal(calls.length, 2);
  assert.deepEqual(holds.holding, []);
});
