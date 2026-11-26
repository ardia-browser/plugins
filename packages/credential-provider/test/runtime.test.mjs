import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockHost } from "@ardia/plugin-sdk/testing";
import { load } from "./load.mjs";
import { raw } from "./fixtures.mjs";

const { createCredentialProvider, defineCliSpec, CredentialError, SignIn, pageItems, verbs } = await load("index");
const { fakeSidecar, cliReply } = await load("testing");

const spec = defineCliSpec(raw);
const info = { title: "Fake", symbol: "key", readsOffline: false, capabilities: ["totp"], signIn: { methods: [{ id: "password", title: "Password", kind: "fields" }] } };
const HINTS = { locked: ["vault is locked"], notFound: ["not found"] };

const provider = {
  async state(_input, ctx) {
    return { state: ctx.session.current ? "unlocked" : "locked", account: ctx.preferences.get("account") };
  },
  async signIn(request, ctx) {
    const result = await ctx.cli.verb("unlock", { password: request.fields.password });
    if (result.unlocked) {
      await ctx.preferences.set("account", "me@example.com");
      return SignIn.done();
    }
    return result.hints.includes("wrongPassword") ? SignIn.needs({ kind: "field", field: "password" }, { problem: "wrongPassword" }) : SignIn.failed(verbs.problem(result, ctx.offline));
  },
  async unlock(_request, ctx) {
    const stored = await ctx.session.takeStored("unlock Fake");
    return stored ? SignIn.done({ session: stored }) : SignIn.needs({ kind: "field", field: "password" });
  },
  async signOut(_input, ctx) {
    await ctx.session.dropStored();
  },
  async list(_input, ctx) {
    if (!ctx.session.current) throw CredentialError.locked();
    const items = [];
    const result = await ctx.cli.verb("item.list", {}, { onItem: (item) => items.push({ id: item.id, title: item.title, username: "", urls: [] }) });
    verbs.check(result, HINTS, ctx.offline);
    return items;
  },
  async reveal(request, ctx) {
    const result = await ctx.cli.verb("item.get", { id: request.id, field: "password" });
    verbs.check(result, HINTS, ctx.offline);
    return { password: result.lines.join("\n") };
  },
};

let context = { touchID: false, offline: false };

async function host(cli, options = {}) {
  context = { touchID: false, offline: false };
  const fake = fakeSidecar(spec, cli, options);
  const mock = createMockHost({ plugin: "@test/fake" });
  mock.respond("sidecar.request", (params) => fake.respond(params));
  mock.respond("ui.showConfirm", () => ({ confirmed: true }));
  await mock.load(createCredentialProvider(mock.ardia, { id: "@test/fake", spec, info, provider, persistSessions: true, callContext: () => context }));
  return { mock, fake, call: (method, input) => mock.callService("credentials.provider", method, input) };
}

const fakeCli = (launch) => {
  if (launch.verb === "unlock") return launch.env.FAKECLI_PASSWORD === "right password" ? cliReply.lines("unlocked", "sessionkey0123456789abcdef") : cliReply.failed("Invalid master password");
  if (launch.verb === "item.list") return cliReply.json([{ id: "a1", title: "One" }, { id: "b2", title: "Two" }]);
  if (launch.verb === "item.get") return launch.argv[1] === "a1" ? cliReply.lines("s3cret") : cliReply.failed("Item not found.");
  return cliReply.failed("unexpected");
};

test("the service describes the provider and the handlers it has", async () => {
  const { call } = await host(fakeCli);
  const description = await call("describe");
  assert.equal(description.provider, "@test/fake");
  assert.equal(description.cli.name, "fakecli");
  assert.deepEqual(description.handlers, ["state", "signIn", "unlock", "signOut", "list", "reveal"]);
});

test("a CLI that isn't installed says how to install it", async () => {
  const { call } = await host(fakeCli, { installed: false });
  assert.deepEqual(await call("state", { explicit: true }), { ok: true, result: { state: "notInstalled", install: spec.install } });
});

test("signing in runs the CLI through the sidecar and unlocks the session", async () => {
  const { call, fake, mock } = await host(fakeCli);
  assert.deepEqual((await call("state", { explicit: true })).result.state, "locked");
  const wrong = await call("signIn", { method: "password", step: "start", fields: { password: "nope" } });
  assert.deepEqual(wrong, { ok: true, result: { ok: false, need: { kind: "field", field: "password" }, problem: "wrongPassword" } });
  assert.deepEqual(await call("signIn", { method: "password", step: "start", fields: { password: "right password" } }), { ok: true, result: { ok: true } });
  assert.equal(fake.launches.at(-1).env.FAKECLI_PASSWORD, "right password");
  assert.deepEqual((await call("state", { explicit: false })).result, { state: "unlocked", account: "me@example.com" });
  assert.deepEqual(mock.storage.get("credentials.preferences"), { account: "me@example.com" });
});

test("listing streams items to the provider and pages the answer", async () => {
  const { call } = await host(fakeCli);
  assert.deepEqual(await call("list", {}), { ok: false, error: { code: "locked" } });
  await call("signIn", { method: "password", step: "start", fields: { password: "right password" } });
  const page = await call("list", { snapshot: null, cursor: null });
  assert.equal(page.ok, true);
  assert.deepEqual(page.result.items.map((item) => item.id), ["a1", "b2"]);
  assert.equal(page.result.cursor, undefined);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, title: "x".repeat(100), username: "", urls: [] }));
  assert.ok(pageItems(many, 1500).length > 1);
});

test("CLI failures reach the caller as wire errors", async () => {
  const { call } = await host(fakeCli);
  await call("signIn", { method: "password", step: "start", fields: { password: "right password" } });
  assert.deepEqual(await call("reveal", { id: "a1", fields: ["password"] }), { ok: true, result: { password: "s3cret" } });
  assert.deepEqual(await call("reveal", { id: "zz9", fields: ["password"] }), { ok: false, error: { code: "notFound" } });
  const refused = await call("reveal", { id: "--x", fields: ["password"] });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "failed");
});

test("with Touch ID a persistent session is kept in the Keychain and restored", async () => {
  const { call, mock, fake } = await host(fakeCli);
  context = { touchID: true, offline: false };
  await call("signIn", { method: "password", step: "start", fields: { password: "right password" } });
  assert.equal(mock.secrets.get("credentials.session"), "sessionkey0123456789abcdef");
  await fake.core.handle("session.drop", {});
  assert.deepEqual(await call("unlock", { password: null }), { ok: true, result: { ok: true } });
  assert.equal(fake.core.unlocked, true);
  await call("signOut", {});
  assert.equal(mock.secrets.has("credentials.session"), false);
  assert.equal(fake.core.unlocked, false);
});

test("handlers the provider lacks answer unsupported, and dotted names become service methods", async () => {
  const { call, fake } = await host(fakeCli);
  assert.deepEqual(await call("edit", { id: "a1", change: {} }), { ok: false, error: { code: "unsupported" } });
  assert.deepEqual(await call("passkeysList", { rpId: null }), { ok: false, error: { code: "unsupported" } });
  assert.equal(fake.launches.length, 0);
});

test("an approved sign-in without a verb unlock still opens the session, keeping a key a verb set", async () => {
  const { call, fake } = await host(fakeCli);
  await call("signIn", { method: "password", step: "start", fields: { password: "right password" } });
  assert.deepEqual(fake.core.session, { key: "sessionkey0123456789abcdef" });
  await fake.core.handle("session.drop", {});
  context = { touchID: false, offline: false };
  assert.deepEqual(await call("unlock", { password: null }), { ok: true, result: { ok: false, need: { kind: "field", field: "password" } } });
  assert.equal(fake.core.session, null);
});
