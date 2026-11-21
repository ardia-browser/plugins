import { test } from "node:test";
import assert from "node:assert/strict";
import { INITIAL_SESSION, nextSession, retryDelay, screenFor } from "../page/src/sessionState.ts";

const S = (phase, error = null, failures = 0, epoch = 0) => ({ phase, error, failures, epoch });

test("every startup transition, as a table", () => {
  const rows = [
    ["idle starts", S("idle"), { type: "start" }, S("starting")],
    ["idle ignores an attempt", S("idle"), { type: "attempt" }, S("idle")],
    ["starting succeeds", S("starting", "old", 2, 3), { type: "succeeded", epoch: 3 }, S("ready", null, 0, 3)],
    ["a success from before a loss retries", S("starting", "lost", 0, 4), { type: "succeeded", epoch: 3 }, S("retrying", "lost", 1, 4)],
    ["starting fails", S("starting"), { type: "failed", epoch: 0, error: "no info" }, S("retrying", "no info", 1, 0)],
    ["a stale failure keeps the newer error", S("starting", "lost", 0, 1), { type: "failed", epoch: 0, error: "old" }, S("retrying", "lost", 1, 1)],
    ["a loss during an attempt marks it stale", S("starting"), { type: "lost", error: "dropped" }, S("starting", "dropped", 0, 1)],
    ["joining a running attempt", S("starting"), { type: "attempt" }, S("starting")],
    ["retrying attempts again on the timer, Try again or a call", S("retrying", "e", 3), { type: "attempt" }, S("starting", "e", 3)],
    ["retrying ignores a late success", S("retrying", "e", 1), { type: "succeeded", epoch: 0 }, S("retrying", "e", 1)],
    ["ready loses its subscription or link", S("ready", null, 0, 2), { type: "lost", error: "dropped" }, S("retrying", "dropped", 1, 3)],
    ["ready ignores an attempt", S("ready"), { type: "attempt" }, S("ready")],
    ["anything stops", S("retrying", "e", 2), { type: "stop" }, S("stopped", "e", 2)],
    ["stopped stays stopped", S("stopped"), { type: "start" }, S("stopped")],
  ];
  for (const [name, from, event, to] of rows) assert.deepEqual(nextSession(from, event), to, name);
  assert.deepEqual(INITIAL_SESSION, S("idle"));
});

test("the screen is a function of the state and the link's health", () => {
  const rows = [
    [S("idle"), true, { kind: "connecting" }],
    [S("starting"), true, { kind: "connecting" }],
    [S("starting", "no info"), true, { kind: "reconnecting", error: "no info", canRetry: false }],
    [S("retrying", "no info", 1), true, { kind: "reconnecting", error: "no info", canRetry: true }],
    [S("ready"), true, { kind: "ready" }],
    [S("ready"), false, { kind: "reconnecting", error: "The assistant's runtime isn't answering.", canRetry: false }],
    [S("stopped"), true, { kind: "closed" }],
  ];
  for (const [state, healthy, screen] of rows) assert.deepEqual(screenFor(state, healthy), screen, `${state.phase}/${state.error}/${healthy}`);
});

test("retries back off and settle at 30 s", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 50].map(retryDelay), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});
