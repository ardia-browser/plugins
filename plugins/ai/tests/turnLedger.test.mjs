import { test } from "node:test";
import assert from "node:assert/strict";
import { Asks } from "../runtime/src/asks.ts";
import { handleApi } from "../runtime/src/ardiaApi.ts";
import * as Tools from "../runtime/src/browserTools.ts";
import { TurnLedger, providerTurnKey } from "../runtime/src/turnLedger.ts";

const CHAT = "0b9e6c1e-2f4a-4c55-9d7e-1a2b3c4d5e6f";
const OTHER = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const SHORT_WAIT = 30;

function world({ split = false } = {}) {
  const chat = { type: "tab", id: "chat", url: `ardia://ai/${CHAT}`, title: "chat", group: split ? null : "g1", split: split ? "s1" : null, active: true };
  const doc = { type: "tab", id: "doc", url: "https://docs.example/x", title: "doc", group: split ? null : "g1", split: split ? "s1" : null };
  const bank = { type: "tab", id: "bank", url: "https://bank.example/home", title: "bank", group: null, split: null };
  const calls = [];
  let hold = null;
  const held = (value) => (hold ? new Promise((resolve) => hold(() => resolve(value))) : Promise.resolve(value));
  const host = {
    calls,
    holdNext: () => new Promise((ready) => (hold = (release) => ((hold = null), ready(release)))),
    workspace: () => held({ windows: [{ id: "w1", spaces: [{ profile: "p", tabs: split ? [chat, doc, bank] : [{ type: "group", id: "g1", items: [chat, doc] }, bank] }] }] }),
    browse: (tabId, argv) => (calls.push(["browse", tabId, ...argv]), held({ ok: true, text: `content of ${tabId}` })),
    openTab: async (url) => (calls.push(["open", url]), { tabId: "new1" }),
    closeTab: async (id) => void calls.push(["close", id]),
    activateTab: async (id) => void calls.push(["activate", id]),
    groupWithChat: async (chatTabId, ids) => (calls.push(["group", chatTabId, ...ids]), { group: "g1" }),
    splitToGroup: async (id) => (calls.push(["splitToGroup", id]), { group: "g2" }),
    banner: async (id, text) => void calls.push(["banner", id, text]),
  };
  return host;
}

function runtime({ turnStop = async () => {}, split = false, readPages = true } = {}) {
  const ledger = new TurnLedger();
  const host = world({ split });
  const stopped = new Set();
  const memory = {
    opened: () => new Map(),
    tagged: () => new Set(),
    noteOpened: () => {},
    hasReadPages: () => readPages,
    noteReadPages: () => {},
    tag: () => {},
    startOnce: () => false,
    stopped: (c) => stopped.has(c),
    noteStopped: (c) => void stopped.add(c),
    noteSent: (c) => void stopped.delete(c),
  };
  const asks = new Asks(1000);
  asks.onChange((chatId) => {
    for (const a of asks.pending(chatId)) setTimeout(() => asks.answer(chatId, a.id, "allow"), 0);
  });
  const deps = { host, state: { memory, asks }, ledger, turns: { stop: turnStop }, values: () => ({}), appVersion: "", workspaceRoot: "", count: () => {} };
  let nextTool = 1;
  const launch = (runId, ordinal, { thread = CHAT, session = "s1", messageId, sent = messageId === undefined } = {}) => {
    const id = messageId ?? `m-${runId}`;
    if (sent) ledger.allow(thread, id);
    ledger.launched({ threadId: thread, runId, providerTurn: providerTurnKey(`pt-${thread}`, ordinal), session, messageId: id });
  };
  const announce = (runId, tool, input = {}) => {
    const id = `toolu_${nextTool++}`;
    ledger.noteToolItem({ runId, nativeId: id, name: `mcp__t3-code__${tool}`, input });
    return id;
  };
  const toolCall = async (call, body, thread = CHAT, waitMs = SHORT_WAIT) => {
    const found = await ledger.attribute(thread, call, waitMs);
    if (!found.ok) throw Object.assign(new Error(found.refusal), { code: found.refusal });
    return body({ host, asks, memory, grants: { list: () => [], save: () => {} }, turn: found.turn });
  };
  const api = (path, body = {}) => handleApi("POST", path, new URLSearchParams(), { chat: CHAT, ...body }, deps);
  return { ledger, host, launch, announce, toolCall, api };
}

const clicks = (host) => host.calls.filter((c) => c[0] === "browse" && c[2] === "click").map((c) => c[3]);
const mutations = (host) => host.calls.filter((c) => c[0] !== "banner" && c[0] !== "browse");
const refusedAs = (code) => (e) => e.code === code;
const byId = (toolUseId, tool = "ardia_click") => ({ toolUseId, tool, input: {} });

test("each call belongs to the tool use that issued it: a stopped turn's late call is refused while the next turn's calls work", async () => {
  const r = runtime();
  r.launch("run-1", 1);
  const late = r.announce("run-1", "ardia_click");
  await r.api("/ardia/stop");
  await r.api("/ardia/send", { tabs: [], messageId: "m-2" });
  r.launch("run-2", 2, { messageId: "m-2" });
  const fresh = r.announce("run-2", "ardia_click");
  await assert.rejects(r.toolCall(byId(late), (ctx) => Tools.click(ctx, CHAT, "doc", "@e1")), refusedAs("stopped"), "the old turn's call never gets the new turn's token");
  await r.toolCall(byId(fresh), (ctx) => Tools.click(ctx, CHAT, "doc", "@e2"));
  assert.deepEqual(clicks(r.host), ["@e2"]);
});

test("a call from a turn that already ended is refused even while another turn runs", async () => {
  const r = runtime();
  r.launch("run-1", 1);
  const old = r.announce("run-1", "ardia_click");
  r.ledger.ended(providerTurnKey(`pt-${CHAT}`, 1));
  r.launch("run-2", 2);
  r.announce("run-2", "ardia_click");
  await assert.rejects(r.toolCall(byId(old), (ctx) => Tools.click(ctx, CHAT, "doc", "@e1")), refusedAs("unknown"));
  assert.deepEqual(clicks(r.host), []);
});

test("Stop, then a run that was already on its way launches: it starts stopped; only the next sent message's turn is live", async () => {
  const r = runtime({ turnStop: async () => Promise.reject(new Error("projection read failed")) });
  await r.api("/ardia/send", { tabs: [], messageId: "m-before-stop" });
  await r.api("/ardia/stop");
  r.launch("pending-run", 1, { messageId: "m-before-stop" });
  const pending = r.announce("pending-run", "ardia_click");
  await assert.rejects(r.toolCall(byId(pending), (ctx) => Tools.click(ctx, CHAT, "doc", "@e1")), refusedAs("stopped"));
  await r.api("/ardia/send", { tabs: [], messageId: "m-after" });
  r.launch("pending-run-2", 2, { messageId: "m-before-stop" });
  const stillHeld = r.announce("pending-run-2", "ardia_click");
  await assert.rejects(r.toolCall(byId(stillHeld), (ctx) => Tools.click(ctx, CHAT, "doc", "@e1")), refusedAs("stopped"), "a launch for another message is still held");
  r.launch("run-after", 3, { messageId: "m-after" });
  const live = r.announce("run-after", "ardia_click");
  await r.toolCall(byId(live), (ctx) => Tools.click(ctx, CHAT, "doc", "@e9"));
  assert.deepEqual(clicks(r.host), ["@e9"]);
});

test("a second Stop during a send holds the thread again; the message sent before it doesn't revive tools", async () => {
  const r = runtime();
  r.launch("run-1", 1);
  await r.api("/ardia/stop");
  await r.api("/ardia/send", { tabs: [], messageId: "m-2" });
  await r.api("/ardia/stop");
  r.launch("run-2", 2, { messageId: "m-2" });
  const id = r.announce("run-2", "ardia_click");
  await assert.rejects(r.toolCall(byId(id), (ctx) => Tools.click(ctx, CHAT, "doc", "@e1")), refusedAs("stopped"));
  assert.equal((await r.api("/ardia/send", { tabs: [] })).status, 400, "a send must name its message");
});

test("a call with no tool use, a foreign one or another chat's is refused", async () => {
  const r = runtime();
  r.launch("run-9", 1, { thread: OTHER });
  const foreign = r.announce("run-9", "ardia_click");
  r.launch("run-1", 1);
  await assert.rejects(r.toolCall(byId("toolu_nobody"), (ctx) => Tools.click(ctx, CHAT, "doc", "@e1")), refusedAs("unknown"));
  await assert.rejects(r.toolCall(byId(foreign), (ctx) => Tools.click(ctx, CHAT, "doc", "@e1")), refusedAs("unknown"), "another chat's tool use never counts here");
  await assert.rejects(r.toolCall({ toolUseId: null, tool: "ardia_click" }, (ctx) => Tools.click(ctx, CHAT, "doc", "@e1")), refusedAs("unknown"));
  assert.equal(r.ledger.stop(CHAT), 1);
  assert.equal((await r.ledger.attribute(OTHER, byId(foreign), SHORT_WAIT)).ok, true, "Stop in one chat leaves another chat's turn alone");
  assert.deepEqual(clicks(r.host), []);
});

test("a call without a tool-use id is refused, even when a live turn announced an identical one", async () => {
  const r = runtime();
  r.launch("run-1", 1);
  r.announce("run-1", "ardia_click", { ref: "@e1", tab: "doc" });
  await assert.rejects(r.toolCall({ toolUseId: null, tool: "ardia_click" }, (ctx) => Tools.click(ctx, CHAT, "doc", "@e1")), refusedAs("unknown"));
  const id = r.announce("run-1", "ardia_click");
  await assert.rejects(r.toolCall(byId(id, "ardia_close_tab"), (ctx) => Tools.click(ctx, CHAT, "doc", "@e1")), refusedAs("unknown"), "the id must belong to the same tool");
  assert.deepEqual(clicks(r.host), []);
});

test("after Stop, an older pending run that launches after the new message's turn still starts stopped", async () => {
  const r = runtime();
  await r.api("/ardia/send", { tabs: [], messageId: "m-old" });
  await r.api("/ardia/stop");
  await r.api("/ardia/send", { tabs: [], messageId: "m-new" });
  r.launch("run-new", 2, { messageId: "m-new", sent: false });
  r.launch("run-old", 1, { messageId: "m-old", sent: false });
  const old = r.announce("run-old", "ardia_click");
  const fresh = r.announce("run-new", "ardia_click");
  await assert.rejects(r.toolCall(byId(old), (ctx) => Tools.click(ctx, CHAT, "doc", "@e1")), refusedAs("stopped"));
  await r.toolCall(byId(fresh), (ctx) => Tools.click(ctx, CHAT, "doc", "@e2"));
  assert.deepEqual(clicks(r.host), ["@e2"]);
});

test("forgetting what was sent only ever refuses: a sent message pushed out of the bound starts its turn stopped", async () => {
  const r = runtime();
  await r.api("/ardia/send", { tabs: [], messageId: "m-early" });
  for (let i = 0; i < 10_000; i++) r.ledger.allow(`thread-${i}`, `m-${i}`);
  r.launch("run-early", 1, { messageId: "m-early", sent: false });
  const id = r.announce("run-early", "ardia_click");
  await assert.rejects(r.toolCall(byId(id), (ctx) => Tools.click(ctx, CHAT, "doc", "@e1")), refusedAs("stopped"));
  r.launch("run-unsent", 2, { messageId: "m-never-sent", sent: false });
  const unsent = r.announce("run-unsent", "ardia_click");
  await assert.rejects(r.toolCall(byId(unsent), (ctx) => Tools.click(ctx, CHAT, "doc", "@e1")), refusedAs("stopped"), "a turn for a message the page never sent has no tools");
});

test("a call that arrives before its tool item waits for it", async () => {
  const r = runtime();
  r.launch("run-1", 1);
  const waiting = r.toolCall(byId("toolu_soon"), (ctx) => Tools.click(ctx, CHAT, "doc", "@e1"), CHAT, 2000);
  setTimeout(() => r.ledger.noteToolItem({ runId: "run-1", nativeId: "toolu_soon", name: "mcp__t3-code__ardia_click", input: {} }), 20);
  await waiting;
  assert.deepEqual(clicks(r.host), ["@e1"]);
});

test("Stop while opening or regrouping waits on the workspace: no tab is opened, moved, closed or shown after it", async () => {
  for (const [tool, run, split, readPages = true] of [
    ["ardia_open_tab", (ctx) => Tools.openTab(ctx, CHAT, "https://news.example/", "chat", false), false, false],
    ["ardia_open_tab", (ctx) => Tools.openTab(ctx, CHAT, "https://news.example/", "chat", false)],
    ["ardia_split_to_group", (ctx) => Tools.splitToGroup(ctx, CHAT), true],
    ["ardia_close_tab", (ctx) => Tools.closeTab(ctx, CHAT, "doc")],
    ["ardia_activate_tab", (ctx) => Tools.activateTab(ctx, CHAT, "doc")],
    ["ardia_add_to_chat_group", (ctx) => Tools.addToChatGroup(ctx, CHAT, ["doc"])],
  ]) {
    const r = runtime({ split, readPages });
    r.launch("run-1", 1);
    const id = r.announce("run-1", tool);
    const held = r.host.holdNext();
    const doing = r.toolCall(byId(id, tool), run);
    const release = await held;
    await r.api("/ardia/stop");
    release();
    await assert.rejects(doing, refusedAs("stopped"), tool);
    assert.deepEqual(mutations(r.host), [], `${tool} changed nothing after Stop`);
  }
});

test("when the provider session goes away without a terminal, its turns end and a captured token stops working", async () => {
  const r = runtime();
  r.launch("run-1", 1, { session: "s1" });
  r.launch("run-x", 1, { thread: OTHER, session: "s2" });
  const id = r.announce("run-1", "ardia_type");
  const held = r.host.holdNext();
  const typing = r.toolCall(byId(id, "ardia_type"), (ctx) => Tools.type(ctx, CHAT, "doc", "@e2", "hello", true));
  const release = await held;
  r.ledger.endSession("s1");
  release();
  await assert.rejects(typing, refusedAs("ended"));
  assert.deepEqual(r.host.calls.filter((c) => c[0] === "browse").map((c) => c[2]), [], "nothing reached the page");
  assert.equal(r.ledger.turnCount, 1, "only the other session's turn is left");
});

test("finished turns are forgotten, so the ledger doesn't grow with every chat", () => {
  const ledger = new TurnLedger();
  for (let i = 0; i < 1000; i++) {
    ledger.launched({ threadId: `t${i}`, runId: `r${i}`, providerTurn: `p${i}#1`, session: "s" });
    ledger.noteToolItem({ runId: `r${i}`, nativeId: `toolu_${i}`, name: "ardia_click", input: {} });
    ledger.ended(`p${i}#1`);
  }
  assert.equal(ledger.size, 0);
});

test("a host reply that arrives after Stop is dropped and nothing follows it", async () => {
  const r = runtime();
  r.launch("run-1", 1);
  const id = r.announce("run-1", "ardia_type");
  const typing = r.toolCall(byId(id, "ardia_type"), async (ctx) => {
    const snap = await ctx.host.workspace();
    void snap;
    const held = r.host.holdNext();
    const work = Tools.type(ctx, CHAT, "doc", "@e2", "hello", true);
    const release = await held;
    await r.api("/ardia/stop");
    release();
    return work;
  });
  await assert.rejects(typing, refusedAs("stopped"));
  assert.ok(!r.host.calls.some((c) => c[0] === "browse" && c[2] === "press"), "the late reply never leads to Enter");
});

test("Stop while a tool waits on its ask: it reports stopped, and an Always given then grants nothing", async () => {
  const r = runtime();
  r.launch("run-1", 1);
  const id = r.announce("run-1", "ardia_read_tab");
  const saved = [];
  const lateAsks = { ask: async () => (await r.api("/ardia/stop"), "always"), pending: () => [], answer: () => false, cancelChat: () => {}, onChange: () => () => {} };
  const reading = r.toolCall(byId(id, "ardia_read_tab"), (ctx) => Tools.readTab({ ...ctx, asks: lateAsks, grants: { list: () => [], save: (g) => saved.push(g) } }, CHAT, "bank"));
  await assert.rejects(reading, refusedAs("stopped"));
  assert.deepEqual(saved, []);
});
