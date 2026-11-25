import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./load.mjs";

const { CredentialError, SignIn, verbs, wireErrorOf, cleanDetail } = await load("index");

const result = (overrides) => ({ verb: "x", status: 1, launched: true, timedOut: false, cancelled: false, overflowed: false, succeeded: false, stderr: "", hints: [], json: null, lines: [], items: 0, droppedLines: 0, unlocked: false, ...overrides });
const hints = { locked: ["vault is locked"], signedOut: ["not logged in"], notFound: ["not found"] };
const thrown = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

test("check turns hinted failures into locked, signedOut and notFound", () => {
  assert.equal(thrown(() => verbs.check(result({ stderr: "Error: Vault is locked." }), hints, false)).code, "locked");
  assert.equal(thrown(() => verbs.check(result({ stderr: "You are not logged in." }), hints, false)).code, "signedOut");
  assert.equal(thrown(() => verbs.check(result({ stderr: "Item not found." }), hints, false)).code, "notFound");
  assert.equal(thrown(() => verbs.check(result({ succeeded: true, status: 0 }), hints, false)), null);
});

test("problems say why a command didn't work", () => {
  assert.equal(verbs.problem(result({ launched: false }), false), "notLaunched");
  assert.equal(verbs.problem(result({ timedOut: true }), false), "timedOut");
  assert.equal(verbs.problem(result({ cancelled: true }), false), "cancelled");
  assert.equal(verbs.problem(result({ stderr: "getaddrinfo ENOTFOUND api.example.com" }), false), "unreachable");
  assert.equal(verbs.problem(result({ stderr: "getaddrinfo ENOTFOUND api.example.com" }), true), "offline");
  assert.equal(verbs.problem(result({ stderr: "error: unknown option --x" }), false), "outdated");
  const failed = thrown(() => verbs.check(result({ stderr: "[ERROR] 2026/01/02 03:04:05 Error: something broke\nmore" }), hints, false));
  assert.equal(failed.problem, "failed");
  assert.equal(failed.detail, "something broke");
});

test("errors go over the wire with their problem, and anything else is failed", () => {
  assert.deepEqual(CredentialError.failed("wrongPassword", { field: "masterPassword" }).toWire(), { code: "failed", problem: "wrongPassword", field: "masterPassword" });
  assert.deepEqual(wireErrorOf(new Error("boom\nsecond line")), { code: "failed", problem: "failed", detail: "boom" });
  assert.equal(cleanDetail("\u001b[31mred\u001b[0m"), "red");
  assert.ok(CredentialError.is(CredentialError.locked(), "locked"));
});

test("SignIn outcomes are plain and drop what isn't set", () => {
  assert.deepEqual(SignIn.done(), { ok: true });
  assert.deepEqual(SignIn.needs({ kind: "field", field: "email" }, { state: "signedOut" }), { ok: false, need: { kind: "field", field: "email" }, state: "signedOut" });
  assert.deepEqual(SignIn.failed("wrongCode"), { ok: false, problem: "wrongCode" });
  assert.deepEqual(SignIn.cancelled("locked"), { ok: false, problem: "cancelled", state: "locked" });
});
