import { test } from "node:test";
import assert from "node:assert/strict";
import { Channel } from "../runtime/src/channel.ts";

function pair() {
  const lines = [];
  let deliver = () => {};
  let closeHandler = () => {};
  const transport = {
    write: (line) => lines.push(JSON.parse(line)),
    onLine: (handler) => (deliver = handler),
    onClose: (handler) => (closeHandler = handler),
    close: () => closeHandler(),
  };
  return { transport, lines, send: (message) => deliver(JSON.stringify(message)), close: () => closeHandler() };
}

test("a request resolves with its own reply, matched by id", async () => {
  const p = pair();
  const channel = new Channel(p.transport);
  const a = channel.request("hello");
  const b = channel.request("windows");
  p.send({ id: p.lines[1].id, result: ["w"] });
  p.send({ id: p.lines[0].id, result: { protocol: 1 } });
  assert.deepEqual(await a, { protocol: 1 });
  assert.deepEqual(await b, ["w"]);
});

test("an error reply rejects with its code", async () => {
  const p = pair();
  const channel = new Channel(p.transport);
  const r = channel.request("run");
  p.send({ id: p.lines[0].id, error: { code: "refused", message: "run needs the commands permission." } });
  await assert.rejects(r, (e) => e.code === "refused");
});

test("closing the channel fails every waiting request and refuses new ones", async () => {
  const p = pair();
  const channel = new Channel(p.transport);
  const r = channel.request("windows");
  p.close();
  await assert.rejects(r, (e) => e.code === "closed");
  await assert.rejects(channel.request("hello"), (e) => e.code === "closed");
  assert.equal(channel.isClosed, true);
});

test("a request with no answer times out", async () => {
  const p = pair();
  const channel = new Channel(p.transport, 20);
  await assert.rejects(channel.request("windows"), (e) => e.code === "timeout");
});

test("events reach subscribers", () => {
  const p = pair();
  const channel = new Channel(p.transport);
  const seen = [];
  channel.onEvent((e) => seen.push(e.event));
  p.send({ event: "tab.closed", time: 1, data: { tabId: "t1" } });
  assert.deepEqual(seen, ["tab.closed"]);
});

test("a tool call is answered with result, or with an error when the handler throws", async () => {
  const p = pair();
  const channel = new Channel(p.transport);
  channel.serveTools(async (call) => {
    if (call.tool === "boom") throw new Error("nope");
    return { ok: call.input.n + 1 };
  });
  p.send({ call: "c1", tool: "add", input: { n: 1 }, caller: { kind: "cli" }, deadline: 1000 });
  p.send({ call: "c2", tool: "boom", input: {}, caller: { kind: "cli" }, deadline: 1000 });
  await new Promise((r) => setTimeout(r, 5));
  const results = p.lines.filter((l) => l.method === "result").map((l) => l.params);
  assert.deepEqual(results.find((r) => r.call === "c1").result, { ok: 2 });
  assert.equal(results.find((r) => r.call === "c2").error.message, "nope");
  for (const line of p.lines.filter((l) => l.method === "result")) p.send({ id: line.id, result: { ok: true } });
});

test("an aborted request tells Ardia to cancel it, so queued work never runs", async () => {
  const p = pair();
  const channel = new Channel(p.transport);
  const controller = new AbortController();
  const browsing = channel.request("browse", { tab: "t1", argv: ["click", "@e1"] }, 1000, controller.signal);
  const id = p.lines[0].id;
  controller.abort();
  await assert.rejects(browsing, (e) => e.code === "aborted");
  assert.deepEqual(p.lines.slice(1).map((l) => [l.method, l.params]), [["cancel", { request: id }]]);
  p.send({ id: p.lines[1].id, result: { ok: true, cancelled: true } });
});
