import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionCore } from "../page/src/sessionCore.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    timers: {
      setTimeout: (run, ms) => (pending.set(next, { run, ms }), next++),
      clearTimeout: (id) => pending.delete(id),
      setInterval: () => 0,
      clearInterval: () => {},
    },
    delays: () => [...pending.values()].map((t) => t.ms).filter((ms) => ms < 15_000),
    fireAttemptTimeout: () => {
      const [id, t] = [...pending.entries()].find(([, t]) => t.ms === 15_000) ?? [];
      if (id === undefined) return false;
      pending.delete(id);
      t.run();
      return true;
    },
    fireRetry: () => {
      const [id, t] = [...pending.entries()].find(([, t]) => t.ms < 15_000) ?? [];
      if (id === undefined) return false;
      pending.delete(id);
      t.run();
      return true;
    },
  };
}

function fakeChannel({ infos = [], roots = ["/workspace"], projects = [], late = false, shells = [] } = {}) {
  const calls = [];
  let health = null;
  let shellEnd = null;
  let infoCount = 0;
  let closed = 0;
  let cancelled = 0;
  let subscribes = 0;
  const recorder = new Proxy({}, { get: (_, method) => (payload) => ({ method: String(method), payload }) });
  const transport = {
    kind: "channel",
    connection: {
      call: async (make) => {
        const { method, payload } = make(recorder);
        calls.push([method, payload]);
        if (method === "server.getConfig") return { providers: [{ driver: "claudeAgent", installed: true }] };
        return { ok: true };
      },
      subscribe: (make, onItem, onEnd) => {
        calls.push([make(recorder).method]);
        const plan = shells[subscribes++] ?? "snapshot";
        shellEnd = onEnd;
        const snapshot = () => onItem({ kind: "snapshot", snapshot: { projects, threads: [] } });
        if (plan === "end-before-return") onEnd(new Error("The shell ended at once."));
        else if (plan === "silent") {}
        else if (late) setTimeout(snapshot, 5);
        else snapshot();
        return () => void cancelled++;
      },
      close: () => void closed++,
    },
    api: {
      info: async () => {
        const plan = infos[infoCount++];
        if (plan === "fail" || (plan === undefined && infos.at(-1) === "fail")) throw new Error("The runtime isn't answering yet.");
        return { appVersion: "", values: {}, workspaceRoot: roots[Math.min(infoCount - 1, roots.length - 1)] };
      },
    },
    healthy: async () => true,
    onHealth: (listener) => ((health = listener), () => (health = null)),
    openUrl: () => {},
  };
  return { transport, calls, health: (h) => health?.(h), endShell: (e) => shellEnd?.(e), closed: () => closed, infoCount: () => infoCount, cancelled: () => cancelled, subscribes: () => subscribes };
}

const screenOf = (core) => core.getSnapshot().screen;

test("info keeps failing on a healthy link: the page shows the last error and keeps retrying with backoff; Try again retries at once; it recovers", async () => {
  const t = fakeTimers();
  const ch = fakeChannel({ infos: ["fail", "fail", "fail", "ok"] });
  const core = new SessionCore({ openTransport: async () => ch.transport, timers: t.timers });
  core.start();
  await settle();
  assert.deepEqual(screenOf(core), { kind: "reconnecting", error: "The runtime isn't answering yet.", canRetry: true });
  assert.deepEqual(t.delays(), [1000]);
  assert.ok(t.fireRetry());
  await settle();
  assert.deepEqual(screenOf(core), { kind: "reconnecting", error: "The runtime isn't answering yet.", canRetry: true });
  assert.deepEqual(t.delays(), [2000], "the next retry waits longer");
  core.retry();
  assert.deepEqual(screenOf(core), { kind: "reconnecting", error: "The runtime isn't answering yet.", canRetry: false }, "while a retry is pending the last error stays on screen");
  assert.deepEqual(t.delays(), [], "Try again replaces the timer");
  await settle();
  assert.equal(ch.infoCount(), 3);
  assert.ok(t.fireRetry());
  await settle();
  assert.deepEqual(screenOf(core), { kind: "ready" });
  assert.equal(core.getSnapshot().workspaceRoot, "/workspace");
  core.stop();
});

test("ensureProject after every first attempt failed sets up again and uses the root that setup just read", async () => {
  const t = fakeTimers();
  const ch = fakeChannel({ infos: ["fail", "ok"], roots: ["/never", "/fresh"] });
  const core = new SessionCore({ openTransport: async () => ch.transport, timers: t.timers });
  core.start();
  await settle();
  assert.equal(screenOf(core).kind, "reconnecting");
  const project = await core.ensureProject();
  assert.equal(project, "ardia-workspace");
  const created = ch.calls.find(([method]) => method === "projects.mutate");
  assert.equal(created[1].workspaceRoot, "/fresh");
  core.stop();
});

test("a subscription that ends during setup never lets that setup show ready; the next one resubscribes", async () => {
  const t = fakeTimers();
  const ch = fakeChannel();
  let release;
  const gate = new Promise((r) => (release = r));
  const info = ch.transport.api.info;
  ch.transport.api.info = async () => (await gate, info());
  const core = new SessionCore({ openTransport: async () => ch.transport, timers: t.timers });
  core.start();
  await settle();
  core.retry();
  ch.health(false);
  release();
  await settle();
  assert.notEqual(screenOf(core).kind, "ready");
  ch.health(true);
  await settle();
  assert.deepEqual(screenOf(core), { kind: "ready" });
  ch.endShell(new Error("stream ended"));
  assert.deepEqual(screenOf(core), { kind: "reconnecting", error: "stream ended", canRetry: true });
  assert.ok(t.fireRetry());
  await settle();
  assert.deepEqual(screenOf(core), { kind: "ready" });
  assert.equal(ch.calls.filter(([m]) => m === "orchestration.subscribeShell").length, 2);
  core.stop();
});

test("a transport that finishes opening after the page closed is closed, not used", async () => {
  const ch = fakeChannel();
  let resolveOpen;
  const core = new SessionCore({ openTransport: () => new Promise((r) => (resolveOpen = r)), timers: fakeTimers().timers });
  core.start();
  core.stop();
  resolveOpen(ch.transport);
  await settle();
  assert.equal(ch.closed(), 1);
  assert.equal(ch.infoCount(), 0);
  assert.deepEqual(screenOf(core), { kind: "closed" });
});

test("an attempt that hangs is bounded and counts as a failure", async () => {
  const ch = fakeChannel();
  ch.transport.api.info = () => new Promise(() => {});
  const core = new SessionCore({ openTransport: async () => ch.transport, timers: { ...fakeTimers().timers, setTimeout: (run, ms) => setTimeout(run, ms === 15_000 ? 5 : 3_600_000), clearTimeout: (id) => clearTimeout(id) }, attemptMs: 15_000 });
  core.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(screenOf(core), { kind: "reconnecting", error: "The assistant didn't answer in time.", canRetry: true });
  core.stop();
});

test("a chat sent at once after startup uses the project the first shell snapshot reports, never creating it twice", async () => {
  const ch = fakeChannel({ projects: [{ id: "ardia-workspace" }], late: true });
  const core = new SessionCore({ openTransport: async () => ch.transport, timers: fakeTimers().timers });
  core.start();
  const project = await core.ensureProject();
  assert.equal(project, "ardia-workspace");
  assert.equal(ch.calls.filter(([m]) => m === "projects.mutate").length, 0);
  core.stop();
});

test("a shell that stays open with no snapshot past the timeout: not ready, no project created, and the next attempt subscribes afresh", async () => {
  const t = fakeTimers();
  const ch = fakeChannel({ shells: ["silent", "snapshot"], projects: [{ id: "ardia-workspace" }] });
  const core = new SessionCore({ openTransport: async () => ch.transport, timers: t.timers });
  core.start();
  await settle();
  assert.deepEqual(screenOf(core), { kind: "connecting" });
  assert.ok(t.fireAttemptTimeout());
  await settle();
  assert.deepEqual(screenOf(core), { kind: "reconnecting", error: "The assistant didn't answer in time.", canRetry: true });
  assert.equal(ch.cancelled(), 1, "the timed-out attempt's subscription is cancelled");
  assert.ok(t.fireRetry());
  await settle();
  assert.equal(ch.subscribes(), 2, "the retry subscribes again instead of trusting the old one");
  assert.deepEqual(screenOf(core), { kind: "ready" });
  assert.equal(await core.ensureProject(), "ardia-workspace");
  assert.equal(ch.calls.filter(([m]) => m === "projects.mutate").length, 0, "the existing project isn't created again");
  ch.endShell(new Error("late end from the old subscription"));
  core.stop();
});

test("a subscription that ends before subscribe returns fails that attempt, and the retry makes a new subscription", async () => {
  const t = fakeTimers();
  const ch = fakeChannel({ shells: ["end-before-return", "snapshot"] });
  const core = new SessionCore({ openTransport: async () => ch.transport, timers: t.timers });
  core.start();
  await settle();
  assert.deepEqual(screenOf(core), { kind: "reconnecting", error: "The shell ended at once.", canRetry: true });
  assert.ok(t.fireRetry());
  await settle();
  assert.equal(ch.subscribes(), 2);
  assert.deepEqual(screenOf(core), { kind: "ready" });
  core.stop();
});
