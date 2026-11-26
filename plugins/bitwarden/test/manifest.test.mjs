import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { validateManifestV3 } from "@ardia/plugin-sdk/manifest";
import { GUID, PASSWORD, SESSION_KEY, manifest, sdk } from "./support.mjs";

const session = { $secret: "session" };
const built = (verb, params) => {
  const result = sdk.buildVerb(sdk.CLI, verb, params, (handle) => (handle.$secret === "session" ? SESSION_KEY : null));
  return "launch" in result ? result.launch : { refused: result.message };
};

describe("plugin.json", () => {
  test("is a valid manifest 3 that provides credentials from a sidecar", () => {
    const checked = validateManifestV3(manifest);
    assert.equal(checked.ok, true, JSON.stringify(checked.problems));
    assert.equal(manifest.id, "@ardia/bitwarden");
    assert.equal(manifest.scope, "profile");
    assert.deepEqual(manifest.provides, ["credentials.provider"]);
    assert.deepEqual(manifest.release, { github: "ardia-browser/plugins", tagPrefix: "bitwarden-v", asset: "bitwarden-{version}.tar.gz" });
    assert.deepEqual(manifest.sidecar.run, ["sidecar/server.mjs"]);
    assert.deepEqual(manifest.permissions, { storage: true, secrets: true });
  });

  test("names the version package.json has", async () => {
    const pkg = (await import("../package.json", { with: { type: "json" } })).default;
    assert.equal(pkg.version, manifest.version);
  });
});

describe("the provider", () => {
  test("offers what the provider handles", () => {
    assert.deepEqual(sdk.credentialHandlersOf(sdk.bitwarden), ["state", "signIn", "unlock", "signOut", "configure", "list", "reveal", "save", "edit", "addTotp", "passkeys.list", "passkeys.get", "passkeys.save"]);
    assert.deepEqual(sdk.INFO.capabilities, ["totp", "save", "edit", "addTotp", "passkeys", "selfHosted", "masterPassword", "touchID"]);
  });

  test("declares the US, EU and self-hosted servers and both sign-in methods", () => {
    assert.deepEqual(sdk.INFO.signIn.servers.map((server) => server.id), ["us", "eu", "selfHosted"]);
    assert.deepEqual(
      sdk.INFO.signIn.methods.map((method) => [method.id, method.fields.map((field) => `${field.id}:${field.type}`)]),
      [
        ["password", ["email:email", "masterPassword:secret"]],
        ["apiKey", ["clientId:secret", "clientSecret:secret", "masterPassword:secret"]],
      ],
    );
    assert.equal(sdk.INFO.signIn.methods[0].twoStep, true);
    assert.deepEqual(sdk.INFO.signIn.unlock, { field: "masterPassword" });
  });
});

describe("verb launches built from the bw spec", () => {
  test("the master password goes in the environment, never in argv", () => {
    const launch = built("login.password", { email: "me@example.com", password: PASSWORD, method: "0", code: "123456" });
    assert.deepEqual(launch.argv, ["login", "me@example.com", "--passwordenv", "ARDIA_BW_PASSWORD", "--raw", "--nointeraction", "--method=0", "--code=123456"]);
    assert.equal(launch.env.ARDIA_BW_PASSWORD, PASSWORD);
    assert.equal(launch.env.BW_NOINTERACTION, "true");
    assert.ok(!launch.argv.some((token) => token.includes(PASSWORD)));
    assert.equal(launch.signIn, true);
  });

  test("API key credentials go only in BW_CLIENTID and BW_CLIENTSECRET", () => {
    const launch = built("login.apiKey", { clientId: "user.abc", clientSecret: "fixture-client-1" });
    assert.deepEqual(launch.argv, ["login", "--apikey", "--nointeraction"]);
    assert.equal(launch.env.BW_CLIENTID, "user.abc");
    assert.equal(launch.env.BW_CLIENTSECRET, "fixture-client-1");
  });

  test("the session key reaches bw as BW_SESSION, and an absent optional session leaves it out", () => {
    assert.equal(built("status", { session }).env.BW_SESSION, SESSION_KEY);
    assert.equal(built("status", {}).env.BW_SESSION, undefined);
    assert.deepEqual(built("list.items", {}), { refused: "session is required for list.items." });
  });

  test("items go to bw create and edit as base64 JSON on stdin, never in argv", () => {
    const item = { name: "Example", login: { password: PASSWORD } };
    const launch = built("edit.item", { session, id: GUID, item });
    assert.deepEqual(launch.argv, ["edit", "item", GUID, "--nointeraction"]);
    assert.deepEqual(JSON.parse(Buffer.from(launch.stdin, "base64").toString("utf8")), item);
  });

  test("a self-hosted server must be https, or http on a loopback host only", () => {
    assert.deepEqual(built("config.server.url", { url: "https://vault.example.com" }).argv, ["config", "server", "https://vault.example.com", "--nointeraction"]);
    for (const url of ["http://localhost:8080", "http://127.0.0.1", "http://[::1]:8443"]) assert.ok(built("config.server.url", { url }).argv, url);
    for (const url of ["http://vault.example.com", "ftp://vault.example.com", "https://user:pw@vault.example.com", "https://vault example.com", "vault.example.com"]) {
      assert.match(built("config.server.url", { url }).refused, /must be an https address/, url);
    }
  });

  test("slot values that could inject options or reach another item are refused", () => {
    assert.ok(built("get.item", { session, id: "--help" }).refused);
    assert.ok(built("get.item", { session, id: "../../etc" }).refused);
    assert.ok(built("get.field", { session, field: "notes", id: GUID }).refused);
    assert.ok(built("login.password", { email: "-x@example.com", password: PASSWORD }).refused);
    assert.ok(built("login.password", { email: "me@example.com", password: PASSWORD, code: "12 34" }).refused);
    assert.ok(built("login.password", { email: "me@example.com", password: PASSWORD, method: "2" }).refused);
    assert.deepEqual(built("status", { session, pin: "1" }), { refused: "status has no slot named pin." });
    assert.deepEqual(built("list.all", {}), { refused: "bw has no verb list.all." });
  });
});
