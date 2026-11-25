import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { validateManifestV3 } from "@ardia/plugin-sdk/manifest";
import { manifest, subject } from "./helpers.mjs";

const build = (verb, params) => {
  const result = subject.buildVerb(subject.CLI, verb, params, () => null);
  return "launch" in result ? result.launch : { refused: result.message };
};

describe("plugin.json", () => {
  test("is a valid manifest 3 that provides credentials from a sidecar", () => {
    const checked = validateManifestV3(manifest);
    assert.equal(checked.ok, true, JSON.stringify(checked.problems));
    assert.equal(manifest.id, "@ardia/proton-pass");
    assert.equal(manifest.scope, "profile");
    assert.deepEqual(manifest.provides, ["credentials.provider"]);
    assert.deepEqual(manifest.release, { github: "ardia-browser/plugins", tagPrefix: "proton-pass-v", asset: "proton-pass-{version}.tar.gz" });
    assert.deepEqual(manifest.sidecar.run, ["sidecar/server.mjs"]);
    assert.deepEqual(manifest.contributes.passwordManager, { fill: "system", fields: ["login", "oneTimeCode"] });
  });

  test("names the version package.json has", async () => {
    const pkg = (await import("../package.json", { with: { type: "json" } })).default;
    assert.equal(pkg.version, manifest.version);
  });
});

describe("the provider", () => {
  test("offers state, sign-in, listing, revealing and saving", () => {
    assert.deepEqual(subject.credentialHandlersOf(subject.protonPass), ["state", "signIn", "unlock", "signOut", "list", "reveal", "save"]);
    assert.deepEqual(subject.INFO.capabilities, ["totp", "save", "touchID"]);
    assert.deepEqual(subject.INFO.passkeys, [{ via: "extension", extensions: ["ghmbeldphafepmbegfdlkpapadhbakde"] }]);
  });

  test("signs in with the browser or an access token, each with an optional extra password", () => {
    assert.deepEqual(
      subject.INFO.signIn.methods.map((method) => [method.id, method.kind, method.fields.map((field) => `${field.id}:${field.type}${field.optional ? "?" : ""}`)]),
      [
        ["browser", "browserApproval", ["extraPassword:secret?"]],
        ["token", "fields", ["token:secret", "extraPassword:secret?"]],
      ],
    );
    assert.deepEqual(subject.INFO.signIn.approvalHosts, ["proton.me"]);
  });
});

describe("verbs through the argv builder", () => {
  test("item.list takes the share as --share-id= and --show-secrets only when asked", () => {
    assert.deepEqual(build("item.list", { share: "shareWork1", showSecrets: true }).argv, ["item", "list", "--share-id=shareWork1", "--filter-type=login", "--filter-state=active", "--output=json", "--show-secrets"]);
    assert.deepEqual(build("item.list", { share: "shareWork1", showSecrets: false }).argv, ["item", "list", "--share-id=shareWork1", "--filter-type=login", "--filter-state=active", "--output=json"]);
  });

  test("item.totp, item.view and item.create address items by share and item id", () => {
    assert.deepEqual(build("item.totp", { share: "s1", item: "i1" }).argv, ["item", "totp", "--share-id=s1", "--item-id=i1", "--field=totp", "--output=json"]);
    assert.deepEqual(build("item.view", { share: "s1", item: "i1" }).argv, ["item", "view", "--share-id=s1", "--item-id=i1", "--output=json"]);
    const create = build("item.create", { share: "s1", template: { title: "T", password: "p" } });
    assert.deepEqual(create.argv, ["item", "create", "login", "--share-id=s1", "--from-template=-"]);
    assert.equal(create.stdin, '{"password":"p","title":"T"}');
  });

  test("a share that starts with a dash stays inside its --share-id= flag", () => {
    assert.deepEqual(build("item.view", { share: "-x", item: "i1" }).argv, ["item", "view", "--share-id=-x", "--item-id=i1", "--output=json"]);
  });

  test("secrets reach pass-cli only through its environment, never argv", () => {
    const launch = build("login.token", { token: "token-value-123", extraPassword: "extra-value-456" });
    assert.deepEqual(launch.argv, ["login"]);
    assert.equal(launch.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN, "token-value-123");
    assert.equal(launch.env.PROTON_PASS_EXTRA_PASSWORD, "extra-value-456");
    assert.equal(launch.signIn, true);
  });

  test("without an extra password the browser login leaves the variable out and waits 660 s", () => {
    const launch = build("login.browser", {});
    assert.equal("PROTON_PASS_EXTRA_PASSWORD" in launch.env, false);
    assert.equal(launch.timeoutMs, 660_000);
  });

  test("telemetry and update checks are off for every verb", () => {
    assert.deepEqual(build("info", {}).env, { PROTON_PASS_NO_UPDATE_CHECK: "1", PROTON_PASS_DISABLE_TELEMETRY: "1" });
  });

  const refusals = [
    ["a share with a slash", "item.view", { share: "a/b", item: "i1" }],
    ["a share over 200 characters", "item.view", { share: "a".repeat(201), item: "i1" }],
    ["a missing item id", "item.view", { share: "s1" }],
    ["an unknown slot", "item.view", { share: "s1", item: "i1", field: "password" }],
    ["a handle where an id goes", "item.view", { share: { $secret: "session" }, item: "i1" }],
    ["a session handle with no session", "login.token", { token: { $secret: "session" } }],
    ["a verb the spec doesn't have", "run", {}],
  ];
  for (const [name, verb, params] of refusals) {
    test(`refuses ${name}`, () => {
      assert.ok("refused" in build(verb, params));
    });
  }
});
