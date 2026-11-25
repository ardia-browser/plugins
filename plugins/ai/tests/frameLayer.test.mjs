import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelLink } from "../page/src/channelLink.ts";
import { Assembler, HELPER_TO_PAGE_LIMIT, PAGE_TO_HELPER_LIMIT, PING_MS, sentSize, split } from "../runtime/src/frames.ts";
import { OUTBOX_BYTES, PageBridge } from "../runtime/src/pageBridge.ts";

const HOST_FROM_PAGE = 64 << 10;
const HOST_TO_PAGE = 256 << 10;
const P = "page-instance-1";

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const ALPHABET = ['"', "\\", "/", "a", "é", "日", "😀", "\n", "\u0001", " ", " ", "{", "}"];
function text(random, length) {
  let out = "";
  while (out.length < length) out += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return out;
}

test("every part fits the host's byte limits whatever the payload escapes to, and reassembles exactly", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const random = rng(seed);
    for (const [limit, cap] of [
      [PAGE_TO_HELPER_LIMIT, HOST_FROM_PAGE],
      [HELPER_TO_PAGE_LIMIT, HOST_TO_PAGE],
    ]) {
      const size = Math.floor(random() * limit * 3);
      const frame = { t: "call", p: P, id: seed, method: "orchestration.dispatchCommand", payload: { text: text(random, size) } };
      let n = 0;
      const parts = split(frame, limit, () => `x${++n}`);
      for (const part of parts) assert.ok(sentSize(part) <= cap, `seed ${seed}: a part of ${sentSize(part)} bytes passes a ${cap} cap`);
      const a = new Assembler();
      const whole = parts.map((part) => a.take(JSON.parse(JSON.stringify(part)))).filter(Boolean);
      assert.deepEqual(whole, [frame], `seed ${seed}`);
    }
  }
  const worst = { t: "result", p: P, id: 1, ok: true, value: '"'.repeat(HELPER_TO_PAGE_LIMIT) };
  for (const part of split(worst, HELPER_TO_PAGE_LIMIT, () => "w")) assert.ok(sentSize(part) <= HOST_TO_PAGE, "all quotes, right at the boundary");
  const slashes = { t: "result", p: P, id: 2, ok: true, value: "/".repeat(PAGE_TO_HELPER_LIMIT) };
  for (const part of split(slashes, PAGE_TO_HELPER_LIMIT, () => "s")) assert.ok(sentSize(part) <= HOST_FROM_PAGE, "slashes Ardia escapes as \\/");
});

function world(seed, { overloadedRate = 0.3, items = 12 } = {}) {
  const random = rng(seed);
  const stream = Array.from({ length: items }, (_, i) => ({ i, text: text(random, Math.floor(random() * (random() < 0.2 ? 400_000 : 3_000))) }));
  let view = "v1";
  let pageListener = null;
  let now = 0;
  const timers = new Map();
  let nextTimer = 1;
  const linkTimers = {
    now: () => now,
    setTimeout: (run, ms) => (timers.set(nextTimer, { run, at: now + ms }), nextTimer++),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (run, ms) => (timers.set(nextTimer, { run, at: now + ms, every: ms }), nextTimer++),
    clearInterval: (id) => timers.delete(id),
  };
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, t] = due;
      now = t.at;
      if (t.every) t.at += t.every;
      else timers.delete(id);
      t.run();
    }
    now = end;
  };
  const starts = [];
  const bridge = new PageBridge({
    rpc: {
      call: async (_method, payload) => payload,
      stream: (_method, _payload, onItem) => {
        let stopped = false;
        starts.push(starts.length);
        void (async () => {
          for (const item of stream) {
            await new Promise((r) => setImmediate(r));
            if (stopped) return;
            onItem(item);
          }
        })();
        return () => void (stopped = true);
      },
    },
    api: async () => ({ status: 200, body: {} }),
    open: async () => {},
    post: async (message, to) => {
      assert.ok(sentSize(message) <= HOST_TO_PAGE, "Ardia would refuse a message this big");
      if (to !== view) return "gone";
      if (random() < overloadedRate) return "overloaded";
      const deliverTo = view;
      setImmediate(() => {
        if (deliverTo === view) pageListener?.({ data: JSON.parse(JSON.stringify(message)) });
      });
      return "ok";
    },
    wait: async () => {},
  });
  const pageBridge = {
    send: (value) => {
      assert.ok(sentSize(value) <= HOST_FROM_PAGE, "Ardia would drop a page message this big");
      const from = view;
      setImmediate(() => bridge.receive(JSON.parse(JSON.stringify(value)), from));
    },
    addEventListener: (_type, listener) => (pageListener = listener),
    removeEventListener: () => (pageListener = null),
  };
  const link = new ChannelLink(pageBridge, linkTimers, P);
  return { stream, link, bridge, starts, advance, moveView: (next) => (view = next) };
}

const pause = () => new Promise((r) => setTimeout(r, 2));

test("streams over the frame layer arrive whole and in order, through overloads and a view change, or restart cleanly", async () => {
  for (let seed = 1; seed <= 8; seed++) {
    const w = world(seed);
    const got = [];
    w.link.stream("orchestration.subscribeShell", {}, (item) => got.push(item), () => {});
    let moved = false;
    for (let round = 0; round < 3000; round++) {
      await pause();
      w.advance(PING_MS);
      if (!moved && got.length >= 3) {
        w.moveView("v2");
        moved = true;
      }
      const lastRun = got.slice(got.map((item) => item.i).lastIndexOf(0));
      if (moved && w.starts.length >= 2 && lastRun.length === w.stream.length) break;
    }
    const runs = [];
    for (const item of got) {
      if (item.i === 0) runs.push([]);
      runs.at(-1).push(item);
    }
    for (const run of runs) assert.deepEqual(run, w.stream.slice(0, run.length), `seed ${seed}: each run is an exact, ordered prefix`);
    assert.ok(w.starts.length >= 2, `seed ${seed}: the view change restarted the stream`);
    assert.deepEqual(runs.at(-1), w.stream, `seed ${seed}: the final run is complete`);
    w.link.close();
    w.bridge.close();
  }
});

test("calls with large escaping payloads come back exactly through overloads", async () => {
  const w = world(99, { overloadedRate: 0.4 });
  const random = rng(7);
  const payloads = Array.from({ length: 6 }, (_, i) => ({ i, text: text(random, Math.floor(random() * 150_000)) }));
  const answers = payloads.map((payload) => w.link.call("server.getConfig", payload));
  const results = await Promise.race([
    Promise.all(answers),
    (async () => {
      for (let round = 0; round < 3000; round++) {
        await pause();
        w.advance(PING_MS);
      }
      throw new Error("calls never settled");
    })(),
  ]);
  assert.deepEqual(results, payloads);
  w.link.close();
  w.bridge.close();
});

test("a frame Ardia accepted is removed from the outbox only if it is still at its head", async () => {
  let release;
  const posted = [];
  const bridge = new PageBridge({
    rpc: { call: async () => ({}), stream: (_m, _p, onItem) => (setTimeout(() => onItem({ big: "z".repeat(OUTBOX_BYTES / 4) }), 0), () => {}) },
    api: async () => ({ status: 200, body: {} }),
    open: async () => {},
    post: async (message) => (posted.push(message), posted.length === 1 ? await new Promise((r) => (release = r)) : "ok"),
    wait: async () => {},
  });
  bridge.receive({ t: "ping", p: P }, "v1");
  for (let i = 0; i < 6; i++) bridge.receive({ t: "stream", p: P, id: 10 + i, method: "orchestration.subscribeShell", payload: {} }, "v1");
  await new Promise((r) => setTimeout(r, 40));
  bridge.receive({ t: "ping", p: P }, "v1");
  release("ok");
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(posted.some((m) => m.t === "pong" && m.moved === true), "the pong that tells the page to resubscribe is still sent");
  const groups = new Map();
  for (const m of posted.filter((m) => m.t === "part")) groups.set(m.id, [...(groups.get(m.id) ?? []), m]);
  for (const [id, parts] of groups) assert.deepEqual(parts.map((p) => p.i), [...Array(parts[0].n).keys()], `every part of ${id} reached the page, in order`);
  bridge.close();
});

test("a page forgotten while idle is told to resubscribe when it comes back", async () => {
  let now = 0;
  const posted = [];
  const bridge = new PageBridge({
    rpc: { call: async () => ({}), stream: () => () => {} },
    api: async () => ({ status: 200, body: {} }),
    open: async () => {},
    post: async (message) => (posted.push(message), "ok"),
    now: () => now,
    wait: async () => {},
  });
  bridge.receive({ t: "stream", p: P, id: 1, method: "orchestration.subscribeShell", payload: {} }, "v1");
  now += 61_000;
  bridge.receive({ t: "ping", p: "another-page-22" }, "v9");
  bridge.receive({ t: "ping", p: P }, "v1");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(posted.filter((m) => m.p === P), [{ t: "pong", p: P, moved: true }]);
  bridge.close();
});
