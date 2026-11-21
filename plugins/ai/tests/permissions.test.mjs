import { test } from "node:test";
import assert from "node:assert/strict";
import { addGrant, decide, decideOpen, grantFor, originOf, parseGrants } from "../runtime/src/permissions.ts";

const tab = (over = {}) => ({
  tabId: "t1",
  origin: "https://example.com",
  private: false,
  internal: false,
  isChat: false,
  inChatGroup: false,
  inChatSplit: false,
  openedByAgent: false,
  tagged: false,
  ...over,
});

test("reading a tab in the chat's group, split or tags is allowed and shown as a step", () => {
  for (const over of [{ inChatGroup: true }, { inChatSplit: true }, { tagged: true }, { openedByAgent: true }]) {
    const d = decide("read", tab(over), []);
    assert.equal(d.outcome, "allow");
    assert.equal(d.step, "Read");
  }
});

test("reading any other tab asks, scoped to its site", () => {
  const d = decide("read", tab(), []);
  assert.deepEqual(d, { outcome: "ask", grantKind: "read", origin: "https://example.com", reason: "read" });
});

test("private windows are never readable or usable, whatever was granted", () => {
  const grants = [{ origin: "https://example.com", kind: "act" }];
  for (const kind of ["read", "act", "close", "group", "activate"]) {
    const d = decide(kind, tab({ private: true, inChatGroup: true, openedByAgent: true }), grants);
    assert.equal(d.outcome, "refuse", kind);
  }
});

test("a missing tab is refused, never treated as allowed", () => {
  assert.equal(decide("read", null, []).outcome, "refuse");
  assert.equal(decide("act", null, []).outcome, "refuse");
});

test("acting on a page always asks, even in the chat's own group, until Always for that site", () => {
  assert.equal(decide("act", tab({ inChatGroup: true, openedByAgent: true }), []).outcome, "ask");
  const grants = [{ origin: "https://example.com", kind: "act" }];
  assert.equal(decide("act", tab(), grants).outcome, "allow");
  assert.equal(decide("act", tab({ origin: "https://other.example" }), grants).outcome, "ask");
});

test("an act grant covers reading that site, a read grant doesn't cover acting", () => {
  assert.equal(decide("read", tab(), [{ origin: "https://example.com", kind: "act" }]).outcome, "allow");
  assert.equal(decide("act", tab(), [{ origin: "https://example.com", kind: "read" }]).outcome, "ask");
});

test("grants match the exact origin: scheme, host and port", () => {
  const grants = [{ origin: "https://example.com", kind: "read" }];
  assert.equal(decide("read", tab({ origin: "http://example.com" }), grants).outcome, "ask");
  assert.equal(decide("read", tab({ origin: "https://sub.example.com" }), grants).outcome, "ask");
  assert.equal(decide("read", tab({ origin: "https://example.com:8443" }), grants).outcome, "ask");
});

test("chats and Ardia's own pages are never read", () => {
  assert.equal(decide("read", tab({ isChat: true, inChatGroup: true }), []).outcome, "refuse");
  assert.equal(decide("read", tab({ internal: true, origin: null, inChatGroup: true }), []).outcome, "refuse");
  assert.equal(decide("act", tab({ internal: true, origin: null }), []).outcome, "refuse");
});

test("closing or grouping the person's own tabs asks; the agent's own or the chat's are fine", () => {
  assert.equal(decide("close", tab(), []).outcome, "ask");
  assert.equal(decide("group", tab(), []).outcome, "ask");
  assert.equal(decide("close", tab({ openedByAgent: true }), []).outcome, "allow");
  assert.equal(decide("group", tab({ tagged: true }), []).outcome, "allow");
});

test("Always grants only an asked decision with a site; Allow and Deny grant nothing", () => {
  const ask = decide("read", tab(), []);
  assert.deepEqual(grantFor("always", ask), { origin: "https://example.com", kind: "read" });
  assert.equal(grantFor("allow", ask), null);
  assert.equal(grantFor("deny", ask), null);
  assert.equal(grantFor("always", decide("read", tab({ inChatGroup: true }), [])), null);
  assert.equal(grantFor("always", decide("close", tab({ origin: null }), [])), null);
  assert.equal(grantFor("always", decide("close", tab(), [])), null);
});

test("opening only takes http and https, and asks once the chat has read a page", () => {
  assert.equal(decideOpen("https://example.com/a", false).outcome, "allow");
  assert.deepEqual(decideOpen("https://example.com/a", true), { outcome: "ask", grantKind: null, origin: "https://example.com", reason: "open" });
  assert.equal(grantFor("always", decideOpen("https://example.com/a", true)), null);
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ardia://settings", "chrome://flags", "data:text/html,x", "not a url"]) {
    assert.equal(decideOpen(url, false).outcome, "refuse", url);
  }
});

test("origins drop path, query and credentials", () => {
  assert.equal(originOf("https://u:p@example.com:443/a?b#c"), "https://example.com");
  assert.equal(originOf("ardia://ai/x"), null);
});

test("saved grants are checked on the way in and deduplicated on the way out", () => {
  const parsed = parseGrants([
    { origin: "https://ok.example", kind: "read" },
    { origin: "https://ok.example/path", kind: "read" },
    { origin: "javascript:x", kind: "act" },
    { origin: "https://ok.example", kind: "admin" },
    null,
  ]);
  assert.deepEqual(parsed, [{ origin: "https://ok.example", kind: "read" }]);
  assert.equal(addGrant(parsed, { origin: "https://ok.example", kind: "read" }).length, 1);
  assert.equal(addGrant(parsed, { origin: "https://ok.example", kind: "act" }).length, 2);
});
