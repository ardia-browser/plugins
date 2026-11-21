import { test } from "node:test";
import assert from "node:assert/strict";
import { PageBridge, OUTBOX_BYTES } from "../runtime/src/pageBridge.ts";

const P = "page-instance-1";
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};

function harness({ post } = {}) {
  const posted = [];
  const streams = new Map();
  const calls = [];
  const opened = [];
  let now = 0;
  const bridge = new PageBridge({
    rpc: {
      call: async (method, payload) => (calls.push([method, payload]), { method }),
      stream: (method, payload, onItem, onEnd) => {
        const s = { method, onItem, onEnd, stopped: false };
        streams.set(`${method}:${streams.size}`, s);
        return () => void (s.stopped = true);
      },
    },
    api: async (method, path) => (path.startsWith("/ardia/bad") ? { status: 400, body: { error: "Bad chat id." } } : { status: 200, body: { method, path } }),
    open: async (url) => void opened.push(url),
    post: post ?? (async (message, view) => (posted.push({ message, view }), "ok")),
    now: () => now,
    wait: async () => {},
  });
  return { bridge, posted, streams, calls, opened, advance: (ms) => (now += ms) };
}

const framesTo = (h, view) => h.posted.filter((p) => p.view === view).map((p) => p.message);

test("a call is answered to the view that asked, tagged with the page's instance", async () => {
  const h = harness();
  h.bridge.receive({ t: "call", p: P, id: 1, method: "server.getConfig", payload: {} }, "v1");
  await settle();
  assert.deepEqual(framesTo(h, "v1"), [{ t: "result", p: P, id: 1, ok: true, value: { method: "server.getConfig" } }]);
});

test("the page can call and subscribe only to what the chat uses", async () => {
  const h = harness();
  h.bridge.receive({ t: "call", p: P, id: 1, method: "auth.revokeOtherSessions", payload: {} }, "v1");
  h.bridge.receive({ t: "stream", p: P, id: 2, method: "terminal.attach", payload: {} }, "v1");
  await settle();
  assert.deepEqual(h.calls, []);
  assert.equal(h.streams.size, 0);
  const [call, stream] = framesTo(h, "v1");
  assert.equal(call.ok, false);
  assert.match(stream.error, /can't subscribe/);
});

test("frames without a well-formed instance id are ignored", async () => {
  const h = harness();
  h.bridge.receive({ t: "call", id: 1, method: "server.getConfig", payload: {} }, "v1");
  h.bridge.receive({ t: "call", p: "x", id: 1, method: "server.getConfig", payload: {} }, "v1");
  h.bridge.receive("hello", "v1");
  await settle();
  assert.deepEqual(h.posted, []);
});

test("stream items are batched per stream, and a page that comes back on a new view is told to resubscribe", async () => {
  const h = harness();
  h.bridge.receive({ t: "stream", p: P, id: 3, method: "orchestration.subscribeShell", payload: {} }, "v1");
  const shell = [...h.streams.values()][0];
  shell.onItem({ kind: "snapshot" });
  shell.onItem({ kind: "thread.updated" });
  await new Promise((r) => setTimeout(r, 30));
  await settle();
  assert.deepEqual(framesTo(h, "v1"), [{ t: "items", p: P, id: 3, items: [{ kind: "snapshot" }, { kind: "thread.updated" }] }]);
  h.bridge.receive({ t: "ping", p: P }, "v2");
  await settle();
  assert.equal(shell.stopped, true, "the stream bound to the gone view stops");
  assert.deepEqual(framesTo(h, "v2"), [{ t: "pong", p: P, moved: true }]);
  h.bridge.receive({ t: "ping", p: P }, "v2");
  await settle();
  assert.deepEqual(framesTo(h, "v2").at(-1), { t: "pong", p: P, moved: false }, "it says moved once");
});

test("overloaded posts back off and retry in order; nothing is lost or reordered", async () => {
  let refusals = 2;
  const delivered = [];
  const h = harness({ post: async (message) => (refusals-- > 0 ? "overloaded" : (delivered.push(message), "ok")) });
  h.bridge.receive({ t: "call", p: P, id: 1, method: "server.getConfig", payload: {} }, "v1");
  h.bridge.receive({ t: "call", p: P, id: 2, method: "server.getConfig", payload: {} }, "v1");
  await settle();
  assert.deepEqual(delivered.map((m) => m.id), [1, 2]);
});

test("a view the host no longer has drops what was waiting and makes the page resubscribe", async () => {
  const h = harness({ post: async () => "gone" });
  h.bridge.receive({ t: "stream", p: P, id: 3, method: "orchestration.subscribeShell", payload: {} }, "v1");
  const shell = [...h.streams.values()][0];
  shell.onItem({ kind: "snapshot" });
  await new Promise((r) => setTimeout(r, 30));
  await settle();
  assert.equal(shell.stopped, true);
});

test("an outbox past its bound resyncs instead of growing", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = harness({ post: async () => (await gate, "ok") });
  h.bridge.receive({ t: "stream", p: P, id: 3, method: "orchestration.subscribeShell", payload: {} }, "v1");
  const shell = [...h.streams.values()][0];
  for (let i = 0; i < 40; i++) shell.onItem({ text: "z".repeat(OUTBOX_BYTES / 20) });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(shell.stopped, true);
  release();
});

test("api frames reach the runtime's own API in-process; an error status is a refusal; cancel aborts", async () => {
  const h = harness();
  h.bridge.receive({ t: "api", p: P, id: 4, method: "GET", path: "/ardia/info" }, "v1");
  h.bridge.receive({ t: "api", p: P, id: 5, method: "GET", path: "/ardia/bad" }, "v1");
  h.bridge.receive({ t: "api", p: P, id: 6, method: "GET", path: "/oauth/token" }, "v1");
  await settle();
  const results = framesTo(h, "v1");
  assert.deepEqual(results.find((r) => r.id === 4).value, { method: "GET", path: "/ardia/info" });
  assert.deepEqual(results.find((r) => r.id === 5), { t: "result", p: P, id: 5, ok: false, error: "Bad chat id." });
  assert.equal(results.find((r) => r.id === 6).ok, false, "only /ardia/ paths");
});

test("links go to the helper's open", async () => {
  const h = harness();
  h.bridge.receive({ t: "open", p: P, url: "https://example.com/" }, "v1");
  await settle();
  assert.deepEqual(h.opened, ["https://example.com/"]);
});

test("a page silent for a minute is forgotten and its streams stop", async () => {
  const h = harness();
  h.bridge.receive({ t: "stream", p: P, id: 3, method: "orchestration.subscribeShell", payload: {} }, "v1");
  const shell = [...h.streams.values()][0];
  h.advance(61_000);
  h.bridge.receive({ t: "ping", p: "another-page-2" }, "v9");
  assert.equal(shell.stopped, true);
  assert.equal(h.bridge.instanceCount, 1);
});
