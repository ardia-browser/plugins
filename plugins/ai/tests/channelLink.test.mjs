import { test } from "node:test";
import assert from "node:assert/strict";
import { Assembler, ChannelLink, PAGE_TO_HELPER_LIMIT, SENDS_PER_SECOND, split } from "../page/src/channelLink.ts";
import { LOST_MS, PING_MS } from "../runtime/src/frames.ts";

const P = "page-instance-1";

function fakeBridge() {
  const sent = [];
  let listener = null;
  return {
    sent,
    deliver: (data) => listener?.({ data }),
    bridge: { send: (v) => sent.push(v), addEventListener: (_t, l) => (listener = l), removeEventListener: () => (listener = null) },
  };
}

function fakeTimers() {
  let now = 1_000;
  const timeouts = new Map();
  const intervals = new Map();
  let next = 1;
  return {
    timers: {
      now: () => now,
      setTimeout: (run, ms) => (timeouts.set(next, { run, at: now + ms }), next++),
      clearTimeout: (id) => timeouts.delete(id),
      setInterval: (run, ms) => (intervals.set(next, { run, every: ms, at: now + ms }), next++),
      clearInterval: (id) => intervals.delete(id),
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timeouts.entries(), ...intervals.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        if (timeouts.has(id)) timeouts.delete(id);
        else t.at += t.every;
        t.run();
      }
      now = end;
    },
  };
}

const sentOf = (f, t) => f.sent.filter((x) => x.t === t);

test("every frame carries the page's own instance id, and frames for another instance are ignored", async () => {
  const f = fakeBridge();
  const link = new ChannelLink(f.bridge, fakeTimers().timers, P);
  const a = link.call("server.getConfig", {});
  const call = sentOf(f, "call")[0];
  assert.equal(call.p, P);
  f.deliver({ t: "result", p: "someone-else-99", id: call.id, ok: true, value: "wrong" });
  f.deliver({ t: "result", p: P, id: call.id, ok: true, value: { providers: [] } });
  assert.deepEqual(await a, { providers: [] });
  link.close();
});

test("a call settles by id with its own result or error", async () => {
  const f = fakeBridge();
  const link = new ChannelLink(f.bridge, fakeTimers().timers, P);
  const a = link.call("server.getConfig", {});
  const b = link.call("orchestration.getThreadProjection", { threadId: "t1" });
  const [ca, cb] = sentOf(f, "call");
  f.deliver({ t: "result", p: P, id: cb.id, ok: false, error: "no such thread" });
  f.deliver({ t: "result", p: P, id: ca.id, ok: true, value: 1 });
  assert.equal(await a, 1);
  await assert.rejects(b, /no such thread/);
  link.close();
});

test("a stream delivers batched items in order, ends once, and a cancel stops it", () => {
  const f = fakeBridge();
  const link = new ChannelLink(f.bridge, fakeTimers().timers, P);
  const items = [];
  let ended = 0;
  const stop = link.stream("orchestration.subscribeThread", { threadId: "t1" }, (i) => items.push(i), () => ended++);
  const id = sentOf(f, "stream")[0].id;
  f.deliver({ t: "items", p: P, id, items: [1, 2] });
  f.deliver({ t: "items", p: P, id, items: [3] });
  stop();
  assert.deepEqual(f.sent.at(-1), { t: "cancel", p: P, id });
  f.deliver({ t: "items", p: P, id, items: [4] });
  f.deliver({ t: "end", p: P, id });
  assert.deepEqual(items, [1, 2, 3]);
  assert.equal(ended, 0, "a cancelled stream doesn't report an end");
  link.close();
});

test("when the helper says the page moved to a new view, every live stream is asked for again", () => {
  const f = fakeBridge();
  const link = new ChannelLink(f.bridge, fakeTimers().timers, P);
  link.stream("orchestration.subscribeShell", {}, () => {}, () => {});
  const stopped = link.stream("orchestration.subscribeThread", { threadId: "t1" }, () => {}, () => {});
  stopped();
  const before = sentOf(f, "stream").length;
  f.deliver({ t: "pong", p: P, moved: false });
  assert.equal(sentOf(f, "stream").length, before, "an ordinary pong asks for nothing");
  f.deliver({ t: "pong", p: P, moved: true });
  const again = sentOf(f, "stream").slice(before);
  assert.deepEqual(again.map((s) => s.method), ["orchestration.subscribeShell"], "only the stream still wanted, under its old id");
  link.close();
});

test("the link pings, reports lost after silence and healthy again on the next pong", () => {
  const f = fakeBridge();
  const t = fakeTimers();
  const link = new ChannelLink(f.bridge, t.timers, P);
  const health = [];
  link.onHealth((h) => health.push(h));
  assert.equal(sentOf(f, "ping").length, 1, "it pings at once");
  t.advance(PING_MS);
  assert.equal(sentOf(f, "ping").length, 2);
  t.advance(LOST_MS);
  assert.deepEqual(health, [false]);
  f.deliver({ t: "pong", p: P, moved: false });
  assert.deepEqual(health, [false, true]);
  link.close();
});

test("an api call cancelled by its caller tells the helper and rejects", async () => {
  const f = fakeBridge();
  const link = new ChannelLink(f.bridge, fakeTimers().timers, P);
  const controller = new AbortController();
  const waiting = link.api("GET", "/ardia/events?chat=c&since=1", undefined, controller.signal);
  const id = sentOf(f, "api")[0].id;
  controller.abort();
  await assert.rejects(waiting, /aborted/);
  assert.deepEqual(f.sent.at(-1), { t: "cancel", p: P, id });
  link.close();
});

test("a call nobody answers fails after its deadline instead of hanging", async () => {
  const f = fakeBridge();
  const t = fakeTimers();
  const link = new ChannelLink(f.bridge, t.timers, P);
  const waiting = link.call("server.getConfig", {});
  t.advance(60_001);
  await assert.rejects(waiting, /in time/);
  link.close();
});

test("frames past the size limit go in parts and come back whole", () => {
  const big = { t: "call", p: P, id: 7, method: "orchestration.dispatchCommand", payload: { text: "x".repeat(150_000) } };
  let n = 0;
  const parts = split(big, PAGE_TO_HELPER_LIMIT, () => `p${++n}`);
  assert.ok(parts.length > 2 && parts.every((p) => p.t === "part" && p.p === P && JSON.stringify(p).length < 64 * 1024));
  const a = new Assembler();
  const out = [parts[1], parts[0], ...parts.slice(2)].map((p) => a.take(p)).filter(Boolean);
  assert.deepEqual(out, [big]);
  assert.equal(new Assembler().take({ t: "part", p: P, id: "x", i: 5, n: 2, s: "" }), null, "an out-of-range part is dropped");
});

test("a large answer from the helper is reassembled before it reaches the caller", async () => {
  const f = fakeBridge();
  const link = new ChannelLink(f.bridge, fakeTimers().timers, P);
  const p = link.call("orchestration.getThreadProjection", {});
  const value = { text: "y".repeat(500_000) };
  for (const part of split({ t: "result", p: P, id: sentOf(f, "call")[0].id, ok: true, value }, 240_000, () => "h1")) f.deliver(part);
  assert.deepEqual(await p, value);
  link.close();
});

test("sends past the per-second budget wait instead of being dropped by the host", () => {
  const f = fakeBridge();
  const t = fakeTimers();
  const link = new ChannelLink(f.bridge, t.timers, P);
  for (let i = 0; i < SENDS_PER_SECOND + 20; i++) link.open(`https://example.com/${i}`);
  assert.equal(f.sent.length, SENDS_PER_SECOND, "the first burst stops at the budget");
  t.advance(1000);
  assert.ok(f.sent.length > SENDS_PER_SECOND, "the rest go out the next second");
  link.close();
});

test("a signal reused for every poll keeps no listener once each request settles", async () => {
  const f = fakeBridge();
  const link = new ChannelLink(f.bridge, fakeTimers().timers, P);
  let listeners = 0;
  const signal = { aborted: false, addEventListener: () => listeners++, removeEventListener: () => listeners-- };
  for (let i = 0; i < 5; i++) {
    const waiting = link.api("GET", "/ardia/events?chat=c", undefined, signal);
    f.deliver({ t: "result", p: P, id: sentOf(f, "api").at(-1).id, ok: true, value: i });
    assert.equal(await waiting, i);
  }
  const failing = link.api("GET", "/ardia/events?chat=c", undefined, signal);
  f.deliver({ t: "result", p: P, id: sentOf(f, "api").at(-1).id, ok: false, error: "no" });
  await assert.rejects(failing);
  link.api("GET", "/ardia/events?chat=c", undefined, signal).catch(() => {});
  link.close();
  assert.equal(listeners, 0);
});
