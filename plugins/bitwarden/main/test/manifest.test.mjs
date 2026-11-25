import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { GUID, PASSWORD, SESSION_KEY, manifest, sdk } from "./support.mjs";

const contribution = manifest.contributes.credentialProvider;
const secrets = new Map();
const handle = (value) => {
  const id = `h${secrets.size + 1}`;
  secrets.set(id, value);
  return { $secret: id };
};
const resolve = (h) => secrets.get(h.$secret) ?? null;
const launch = (verb, params, testFolder = null) => sdk.buildVerbLaunch(manifest, verb, params, resolve, testFolder);

describe("plugin.json", () => {
  test("passes every contract rule for a credential provider", () => {
    assert.deepEqual(sdk.checkCredentialManifest(manifest), []);
  });

  test("is an official, closed, main-only plugin with no other contribution or permission", () => {
    assert.equal(manifest.manifest, 2);
    assert.equal(manifest.name, "bitwarden");
    assert.equal(manifest.official, true);
    assert.equal(manifest.main, "dist/main.js");
    assert.deepEqual(Object.keys(manifest.contributes), ["credentialProvider"]);
    assert.equal(manifest.permissions, undefined);
    assert.equal(manifest.sidecar, undefined);
  });

  test("offers what the provider handles, so Ardia never marks it unavailable at ready", () => {
    const handlers = sdk.credentialHandlersOf(sdk.bitwarden);
    assert.deepEqual(handlers, ["state", "signIn", "unlock", "signOut", "configure", "list", "reveal", "save", "edit", "addTotp", "passkeys.list", "passkeys.get", "passkeys.save"]);
    assert.deepEqual(contribution.capabilities, ["totp", "save", "edit", "addTotp", "passkeys", "selfHosted", "masterPassword", "touchID"]);
  });

  test("declares the US, EU and self-hosted servers and both sign-in methods", () => {
    assert.deepEqual(
      contribution.signIn.servers.map((server) => server.id),
      ["us", "eu", "selfHosted"],
    );
    assert.deepEqual(
      contribution.signIn.methods.map((method) => [method.id, method.fields.map((field) => `${field.id}:${field.type}`)]),
      [
        ["password", ["email:email", "masterPassword:secret"]],
        ["apiKey", ["clientId:secret", "clientSecret:secret", "masterPassword:secret"]],
      ],
    );
    assert.equal(contribution.signIn.methods[0].twoStep, true);
    assert.deepEqual(contribution.signIn.unlock, { field: "masterPassword" });
  });

  test("locks bw natively after a lock, except while Touch ID keeps the session", () => {
    assert.deepEqual(contribution.cli.onLock, { verb: "lock", params: { session: { from: "session" } }, skipWithTouchID: true });
  });

  test("the checker refuses a catalog that would leak or run something, so its pass above means something", () => {
    const broken = structuredClone(manifest);
    broken.contributes.credentialProvider.cli.verbs.serve = { argv: ["serve"], output: { mode: "lines" } };
    broken.contributes.credentialProvider.cli.verbs["get.item"].argv.push({ slot: "session" });
    broken.contributes.credentialProvider.cli.env.push({ name: "NODE_OPTIONS", literal: "--require=x" });
    const problems = sdk.checkCredentialManifest(broken);
    assert.ok(problems.some((line) => line.includes("bw serve is never allowed")));
    assert.ok(problems.some((line) => line.includes("a secret slot can't go in argv")));
    assert.ok(problems.some((line) => line.includes("NODE_OPTIONS matches NODE_*")));
  });
});

describe("verb launches built from the catalog", () => {
  test("the master password goes in the environment, never in argv", () => {
    const built = launch("login.password", { email: "me@example.com", password: handle(PASSWORD), method: "0", code: "123456" });
    assert.deepEqual(built.argv, ["login", "me@example.com", "--passwordenv", "ARDIA_BW_PASSWORD", "--raw", "--nointeraction", "--method=0", "--code=123456"]);
    assert.equal(built.env.ARDIA_BW_PASSWORD, PASSWORD);
    assert.equal(built.env.BW_NOINTERACTION, "true");
    assert.ok(!built.argv.some((token) => token.includes(PASSWORD)));
    assert.equal(built.signIn, true);
  });

  test("API key credentials go only in BW_CLIENTID and BW_CLIENTSECRET", () => {
    const built = launch("login.apiKey", { clientId: handle("user.abc"), clientSecret: handle("fixture-client-1") });
    assert.deepEqual(built.argv, ["login", "--apikey", "--nointeraction"]);
    assert.equal(built.env.BW_CLIENTID, "user.abc");
    assert.equal(built.env.BW_CLIENTSECRET, "fixture-client-1");
  });

  test("the session key reaches bw as BW_SESSION, and an absent optional session leaves it out", () => {
    assert.equal(launch("status", { session: handle(SESSION_KEY) }).env.BW_SESSION, SESSION_KEY);
    assert.equal(launch("status", {}).env.BW_SESSION, undefined);
    assert.deepEqual(launch("list.items", {}), { refused: "session is required for list.items." });
  });

  test("items go to bw create and edit as base64 JSON on stdin, never in argv", () => {
    const item = { name: "Example", login: { password: PASSWORD } };
    const built = launch("edit.item", { session: handle(SESSION_KEY), id: GUID, item });
    assert.deepEqual(built.argv, ["edit", "item", GUID, "--nointeraction"]);
    assert.deepEqual(JSON.parse(Buffer.from(built.stdin, "base64").toString("utf8")), item);
  });

  test("a self-hosted server must be https, or http on a loopback host only", () => {
    assert.deepEqual(launch("config.server.url", { url: "https://vault.example.com" }).argv, ["config", "server", "https://vault.example.com", "--nointeraction"]);
    for (const url of ["http://localhost:8080", "http://127.0.0.1", "http://[::1]:8443"]) assert.ok(launch("config.server.url", { url }).argv, url);
    for (const url of ["http://vault.example.com", "ftp://vault.example.com", "https://user:pw@vault.example.com", "https://vault example.com", "vault.example.com"]) {
      assert.match(launch("config.server.url", { url }).refused, /must be an https address/, url);
    }
  });

  test("slot values that could inject options or reach another item are refused", () => {
    assert.ok(launch("get.item", { session: handle(SESSION_KEY), id: "--help" }).refused);
    assert.ok(launch("get.item", { session: handle(SESSION_KEY), id: "../../etc" }).refused);
    assert.ok(launch("get.field", { session: handle(SESSION_KEY), field: "notes", id: GUID }).refused);
    assert.ok(launch("login.password", { email: "-x@example.com", password: handle(PASSWORD) }).refused);
    assert.ok(launch("login.password", { email: "me@example.com", password: handle(PASSWORD), code: "12 34" }).refused);
    assert.ok(launch("login.password", { email: "me@example.com", password: handle(PASSWORD), method: "2" }).refused);
    assert.deepEqual(launch("login.password", { email: "me@example.com", password: "typed in the clear" }), { refused: "password for login.password must be a secret handle." });
    assert.deepEqual(launch("status", { session: handle(SESSION_KEY), pin: "1" }), { refused: "status has no slot named pin." });
    assert.deepEqual(launch("list.all", {}), { refused: "bw has no verb list.all." });
  });

  test("the isolated app data folder applies only in a hidden test instance", () => {
    assert.equal(launch("status", {}).env.BITWARDENCLI_APPDATA_DIR, undefined);
    assert.equal(launch("status", {}, "/scratch/Password Managers/bitwarden").env.BITWARDENCLI_APPDATA_DIR, "/scratch/Password Managers/bitwarden");
  });
});
