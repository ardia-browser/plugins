import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./load.mjs";
import { raw } from "./fixtures.mjs";

const { buildVerb, defineCliSpec } = await load("index");
const spec = defineCliSpec(raw);
const none = () => null;
const built = (verb, params, secrets = none) => buildVerb(spec, verb, params, secrets);

test("argv takes slots, flags and when-flags in order, with the CLI's env", () => {
  const got = built("open", { url: "http://localhost:8080/x", verbose: true });
  assert.deepEqual(got.launch.argv, ["open", "--url=http://localhost:8080/x", "--verbose"]);
  assert.equal(got.launch.env.FAKECLI_CLIENT, "Ardia");
  assert.equal(got.launch.program, "fakecli");
  assert.deepEqual(built("open", { url: "https://example.com" }).launch.argv, ["open", "--url=https://example.com"]);
  assert.deepEqual(built("item.get", { id: "abc123", field: "password" }).launch.argv, ["get", "abc123", "--field=password"]);
});

test("values that don't fit their slot are refused", () => {
  assert.equal(built("item.get", { id: "-rf" }).code, "bad_request");
  assert.match(built("item.get", { id: "has space" }).message, /must match the pattern item/);
  assert.match(built("item.get", { id: "a1", field: "totp" }).message, /must be one of username, password/);
  assert.match(built("item.get", {}).message, /id is required/);
  assert.match(built("item.get", { id: "a1", extra: "x" }).message, /has no slot named extra/);
  assert.match(built("open", { url: "http://example.com" }).message, /https address, or http to this Mac/);
  assert.match(built("open", { url: "https://user@example.com" }).message, /https address/);
  assert.equal(built("nope", {}).code, "refused");
});

test("a secret goes in env, stdin or a prefixed argv token, never as a bare slot", () => {
  const unlock = built("unlock", { password: "hunter22" });
  assert.equal(unlock.launch.env.FAKECLI_PASSWORD, "hunter22");
  assert.deepEqual(unlock.launch.argv, ["unlock", "--raw"]);
  assert.deepEqual(unlock.consumed, ["hunter22"]);
  assert.deepEqual(built("edit", { id: "a1", password: "pw" }).launch.argv, ["edit", "a1", "password=pw"]);
  assert.match(built("edit", { id: "a1", password: "p\nw" }).message, /line break/);
});

test("a session handle resolves only when the sidecar holds a session", () => {
  assert.equal(built("status", { session: { $secret: "session" } }).code, "expired");
  const held = built("status", { session: { $secret: "session" } }, (handle) => (handle.$secret === "session" ? "key123" : null));
  assert.equal(held.launch.env.FAKECLI_SESSION, "key123");
  assert.equal(built("item.get", { id: { $secret: "session" } }).code, "bad_request");
});

test("json goes to stdin, sorted and encoded as the verb says", () => {
  const create = built("create", { item: { b: 1, a: [true, null] } });
  assert.equal(Buffer.from(create.launch.stdin, "base64").toString("utf8"), '{"a":[true,null],"b":1}');
  assert.equal(built("create", { item: { password: { $secret: "session" } } }).code, "bad_request");
});
