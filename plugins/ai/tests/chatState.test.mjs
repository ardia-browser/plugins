import { test } from "node:test";
import assert from "node:assert/strict";
import { activeRun, applyStream, emptyChat, entriesOf, screenOf, stepOf } from "../page/src/chatState.ts";

const T = "0b9e6c1e-2f4a-4c55-9d7e-1a2b3c4d5e6f";
const user = (ordinal, text) => ({ id: `u${ordinal}`, type: "user_message", ordinal, text });
const assistant = (ordinal, text, streaming = false) => ({ id: `a${ordinal}`, type: "assistant_message", ordinal, text, streaming });
const tool = (ordinal, name, status, input = {}, output) => ({ id: `t${ordinal}`, type: "dynamic_tool", ordinal, status, toolName: `mcp__t3-code__${name}`, input, output });
const ev = (type, payload) => ({ kind: "event", event: { type, payload } });

function chatWith(items, runs = []) {
  return applyStream(emptyChat(T), { kind: "snapshot", projection: { thread: { title: "Chat" }, turnItems: items, runs } });
}

test("a snapshot then events build the chat in ordinal order", () => {
  let chat = chatWith([user(1, "hi")], [{ id: "r1", status: "running", ordinal: 1 }]);
  chat = applyStream(chat, ev("turn-item.updated", assistant(3, "Hel", true)));
  chat = applyStream(chat, ev("turn-item.updated", tool(2, "ardia_read_tab", "inProgress", { tab: "t9" })));
  chat = applyStream(chat, ev("turn-item.updated", assistant(3, "Hello")));
  assert.deepEqual(entriesOf(chat).map((e) => e.kind), ["user", "steps", "assistant"]);
  assert.equal(entriesOf(chat)[2].text, "Hello");
});

test("consecutive tool calls share one steps block, and labels follow status", () => {
  const chat = chatWith([
    user(1, "q"),
    tool(2, "ardia_chat_context", "completed"),
    tool(3, "ardia_read_tab", "completed", { tab: "t1" }, { content: [{ type: "text", text: JSON.stringify({ title: "Docs page" }) }] }),
    tool(4, "ardia_open_tab", "inProgress", { url: "https://news.example/x" }),
  ]);
  const steps = entriesOf(chat)[1].steps;
  assert.deepEqual(steps.map((s) => s.label), ["Looked at this chat's tabs", "Read Docs page", "Opening news.example"]);
  assert.deepEqual(steps.map((s) => s.status), ["done", "done", "running"]);
});

test("a refused or denied tool shows as refused, not as done", () => {
  const step = stepOf(tool(2, "ardia_read_tab", "failed", { tab: "t1" }, "capability_denied: The person said no."));
  assert.equal(step.status, "refused");
});

test("empty assistant placeholders and reasoning stay hidden", () => {
  const chat = chatWith([user(1, "q"), { id: "r", type: "reasoning", ordinal: 2, text: "thinking" }, assistant(3, "  ")]);
  assert.deepEqual(entriesOf(chat).map((e) => e.kind), ["user"]);
});

test("screens: empty, working, asking, answered", () => {
  const base = { connected: true, providerAuth: "authenticated", asks: 0 };
  assert.equal(screenOf({ ...base, chat: null }), "empty");
  const running = chatWith([user(1, "q")], [{ id: "r1", status: "running", ordinal: 1 }]);
  assert.equal(screenOf({ ...base, chat: running }), "working");
  assert.equal(activeRun(running).id, "r1");
  assert.equal(screenOf({ ...base, chat: running, asks: 1 }), "asking");
  const done = chatWith([user(1, "q"), assistant(2, "a")], [{ id: "r1", status: "completed", ordinal: 1 }]);
  assert.equal(screenOf({ ...base, chat: done }), "answered");
  assert.equal(activeRun(done), null);
});

test("screens: not signed in, plan limit, runtime stopped, connecting", () => {
  assert.equal(screenOf({ connected: true, providerAuth: "unauthenticated", chat: null, asks: 0 }), "not-signed-in");
  const limited = chatWith([user(1, "q"), { id: "e", type: "error", ordinal: 2, failure: { class: "usage_limit", message: "Limit reached" } }], [{ id: "r1", status: "failed", ordinal: 1 }]);
  assert.equal(screenOf({ connected: true, providerAuth: "authenticated", chat: limited, asks: 0 }), "limit-reached");
  assert.equal(screenOf({ connected: false, providerAuth: "authenticated", chat: limited, asks: 0 }), "runtime-stopped");
  assert.equal(screenOf({ connected: null, providerAuth: null, chat: null, asks: 0 }), "connecting");
});

test("a later answer clears the plan-limit screen", () => {
  const chat = chatWith([user(1, "q"), { id: "e", type: "error", ordinal: 2, failure: { class: "usage_limit" } }, user(3, "again"), assistant(4, "ok")]);
  assert.equal(screenOf({ connected: true, providerAuth: "authenticated", chat, asks: 0 }), "answered");
});

test("unknown events and stream kinds leave the chat as it was", () => {
  const chat = chatWith([user(1, "q")]);
  assert.equal(applyStream(chat, ev("checkpoint.captured", {})), chat);
  assert.equal(applyStream(chat, { kind: "something-new" }), chat);
  assert.equal(applyStream(chat, { kind: "synchronized" }).synced, true);
});
