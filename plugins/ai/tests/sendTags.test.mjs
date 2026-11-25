import { test } from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../runtime/src/ardiaApi.ts";

const CHAT = "0b9e6c1e-2f4a-4c55-9d7e-1a2b3c4d5e6f";

function tab(id, url, over = {}) {
  return { type: "tab", id, url, title: id, group: null, split: null, ...over };
}

function deps({ split = false, grouped = false } = {}) {
  const chat = tab("chat", `ardia://ai/${CHAT}`, { active: true, split: split ? "s1" : null, group: grouped ? "g1" : null });
  const beside = tab("news", "https://news.example/a", { split: split ? "s1" : null });
  const other = tab("bank", "https://bank.example/home");
  const items = grouped ? [{ type: "group", id: "g1", items: [chat] }, beside, other] : [chat, beside, other];
  const calls = [];
  const counts = [];
  return {
    calls,
    counts,
    deps: {
      host: {
        workspace: async () => ({ windows: [{ id: "w1", spaces: [{ profile: "p", tabs: items }] }] }),
        groupWithChat: async (chatTabId, ids) => (calls.push(["group", chatTabId, ...ids]), { group: "g1" }),
        splitToGroup: async (chatTabId) => (calls.push(["splitToGroup", chatTabId]), { group: "g2" }),
      },
      state: { memory: { tag: () => {}, startOnce: () => false, noteSent: () => {}, noteStopped: () => {} }, asks: { cancelChat: () => {} } },
      ledger: { stop: () => 0, allow: () => {} },
      values: () => ({}),
      appVersion: "",
      workspaceRoot: "",
      count: (c) => counts.push(c),
    },
  };
}

const send = (d, tabs) => handleApi("POST", "/ardia/send", new URLSearchParams(), { chat: CHAT, tabs, messageId: "m-1" }, d);

test("sending with only the split's own tab keeps the Split View", async () => {
  const w = deps({ split: true });
  const r = await send(w.deps, ["news"]);
  assert.deepEqual(r.body, { group: null });
  assert.deepEqual(w.calls, []);
});

test("tagging a tab outside the split turns the split into a group headed by the chat, then adds the tab", async () => {
  const w = deps({ split: true });
  const r = await send(w.deps, ["news", "bank"]);
  assert.deepEqual(r.body, { group: "g2" });
  assert.deepEqual(w.calls, [["splitToGroup", "chat"], ["group", "chat", "bank"]]);
  assert.deepEqual(w.counts, ["tag_groups_created"]);
});

test("tagging a tab with no split or group makes a group headed by the chat", async () => {
  const w = deps();
  await send(w.deps, ["bank"]);
  assert.deepEqual(w.calls, [["group", "chat", "bank"]]);
  assert.deepEqual(w.counts, ["tag_groups_created"]);
});

test("a later tag joins the chat's group", async () => {
  const w = deps({ grouped: true });
  await send(w.deps, ["bank"]);
  assert.deepEqual(w.calls, [["group", "chat", "bank"]]);
  assert.deepEqual(w.counts, ["tag_groups_joined"]);
});

test("a New Tab prompt with a long query opens its chat instead of a blank tab", async () => {
  const w = deps();
  const opened = [];
  w.deps.openPage = async (path) => (opened.push(path), { tabId: "t" });
  const query = `q=${"a".repeat(600)}`;
  const r = await handleApi("POST", "/ardia/open", new URLSearchParams(), { path: `0b9e6c1e-2f4a-4c55-9d7e-1a2b3c4d5e6f?${query}` }, w.deps);
  assert.equal(r.status, 200, "a 600-character prompt fits with its q=");
  assert.equal(opened[0].length, 36 + 1 + query.length);
  const over = await handleApi("POST", "/ardia/open", new URLSearchParams(), { path: `0b9e6c1e-2f4a-4c55-9d7e-1a2b3c4d5e6f?q=${"a".repeat(601)}` }, w.deps);
  assert.equal(over.status, 400);
});

test("the open route bounds the prompt by its decoded length, whatever it encodes to", async () => {
  const w = deps();
  const opened = [];
  w.deps.openPage = async (path) => (opened.push(path), { tabId: "t" });
  const open = (q) => handleApi("POST", "/ardia/open", new URLSearchParams(), { path: `0b9e6c1e-2f4a-4c55-9d7e-1a2b3c4d5e6f?q=${encodeURIComponent(q)}` }, w.deps);
  assert.equal((await open(`${"a".repeat(599)}?`)).status, 200, "a ? encodes to %3F but is one character");
  assert.equal((await open("日".repeat(600))).status, 200, "600 three-byte characters");
  assert.equal((await open("😀".repeat(600))).status, 200, "600 astral characters");
  const long = await open("a".repeat(601));
  assert.equal(long.status, 400);
  assert.match(long.body.error, /600 characters/);
  assert.equal((await handleApi("POST", "/ardia/open", new URLSearchParams(), { path: "x y" }, w.deps)).status, 400);
  assert.equal(opened.length, 3);
});

test("sign-in starts only for Claude; a Codex login is refused, since its tool calls carry no id Ardia can tie to a turn", async () => {
  const w = deps();
  const started = [];
  w.deps.startLogin = async (provider) => void started.push(provider);
  assert.equal((await handleApi("POST", "/ardia/login", new URLSearchParams(), { provider: "codex" }, w.deps)).status, 400);
  assert.equal((await handleApi("POST", "/ardia/login", new URLSearchParams(), { provider: "claude" }, w.deps)).status, 200);
  assert.deepEqual(started, ["claude"]);
});
