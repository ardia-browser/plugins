import assert from "node:assert/strict";
import { test } from "bun:test";
import { ACTIVE_FOR, HOLD_SECONDS, MAX_HELD, RENEW_EVERY, TabHolds } from "../src/browse/daemon/holds.ts";
import { ControlRefused } from "../src/browse/state/apptabs.ts";

function recorder(fail: (method: string) => Error | null = () => null) {
  const calls: [string, Record<string, unknown>][] = [];
  const holds = new TabHolds(async (method, params) => {
    calls.push([method, params]);
    const error = fail(method);
    if (error) throw error;
    return {};
  });
  return { calls, holds };
}

test("holds the session's tabs, renews before the app's hold runs out, and releases what it stops using", async () => {
  assert.ok(RENEW_EVERY < HOLD_SECONDS && ACTIVE_FOR > RENEW_EVERY);
  const { calls, holds } = recorder();
  await holds.tick(["tab-a"], 0, true);
  await holds.tick(["tab-a"], 2, true);
  assert.deepEqual(calls, [["tabs.hold", { tabs: ["tab-a"], seconds: HOLD_SECONDS }]], "no call while nothing changed");
  await holds.tick(["tab-a"], RENEW_EVERY, true);
  assert.equal(calls.length, 2, "renewed");
  await holds.tick(["tab-b"], RENEW_EVERY + 2, true);
  assert.deepEqual(calls.slice(2), [["tabs.release", { tabs: ["tab-a"] }], ["tabs.hold", { tabs: ["tab-b"], seconds: HOLD_SECONDS }]]);
  await holds.tick(["tab-b"], RENEW_EVERY + 4, false);
  assert.deepEqual(calls.at(-1), ["tabs.release", { tabs: ["tab-b"] }], "an idle session lets go");
  assert.equal(holds.holding.size, 0);
});

test("a failed hold is tried again on the next tick, and an Ardia without tabs.hold is never asked again", async () => {
  let refuse: Error | null = new ControlRefused("timeout", "slow");
  const { calls, holds } = recorder(() => refuse);
  await holds.tick(["tab-a"], 0, true);
  refuse = null;
  await holds.tick(["tab-a"], 2, true);
  assert.equal(calls.length, 2);
  assert.deepEqual([...holds.holding], ["tab-a"]);

  const old = recorder(() => new ControlRefused("unknown_method", "There's no method tabs.hold."));
  await old.holds.tick(["tab-a"], 0, true);
  await old.holds.tick(["tab-b"], 2, true);
  await old.holds.releaseAll();
  assert.equal(old.calls.length, 1);
});

test("holds at most what the app takes in one call, and releaseAll lets every held tab go", async () => {
  const { calls, holds } = recorder();
  await holds.tick(Array.from({ length: MAX_HELD + 5 }, (_, i) => `tab-${i}`), 0, true);
  assert.equal((calls[0]![1]["tabs"] as string[]).length, MAX_HELD);
  await holds.releaseAll();
  assert.equal(calls[1]![0], "tabs.release");
  assert.equal(holds.holding.size, 0);
  await holds.releaseAll();
  assert.equal(calls.length, 2, "nothing left to release");
});
