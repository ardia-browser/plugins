import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { validateManifestV3 } from "@ardia/plugin-sdk/manifest";
import { ACCOUNT, manifest, sdk } from "./support.mjs";

const sample = { id: "abcdefghijklmnopqrstuvwxyz", account: ACCOUNT.account_uuid, vault: "vvvvvvvvvvvvvvvvvvvvvvvvvv", template: { title: "x" } };
const launchOf = (verb, params, secrets = () => null) => sdk.buildVerb(sdk.CLI, verb, params, secrets);
const sampleParams = (verb) => Object.fromEntries(Object.entries(sdk.CLI.verbs[verb].slots).filter(([, slot]) => !slot.optional || slot.type !== "secret").map(([slot]) => [slot, sample[slot]]).filter(([, value]) => value !== undefined));

describe("plugin.json", () => {
  test("is a valid manifest 3 that provides credentials from a sidecar", () => {
    const checked = validateManifestV3(manifest);
    assert.equal(checked.ok, true, JSON.stringify(checked.problems));
    assert.equal(manifest.id, "@ardia/1password");
    assert.equal(manifest.scope, "profile");
    assert.deepEqual(manifest.provides, ["credentials.provider"]);
    assert.deepEqual(manifest.engines, { ardia: ">=0.3.0", sdk: "^3.0.0" });
    assert.deepEqual(manifest.release, { github: "ardia-browser/plugins", tagPrefix: "1password-v", asset: "1password-{version}.tar.gz" });
    assert.equal(manifest.main, "dist/index.js");
    assert.deepEqual(manifest.sidecar.run, ["sidecar/server.mjs"]);
    assert.deepEqual(manifest.contributes.passwordManager.fields, ["login", "oneTimeCode"]);
  });

  test("names the version package.json has", async () => {
    const pkg = (await import("../package.json", { with: { type: "json" } })).default;
    assert.equal(pkg.version, manifest.version);
  });
});

describe("the op spec", () => {
  test("keeps an approval for ten minutes, and signs in through the 1Password app", () => {
    assert.equal(sdk.CLI.sessionLastsSeconds, 600);
    assert.deepEqual(sdk.INFO.signIn, { methods: [{ id: "app", title: "1Password App", kind: "desktopApproval", appURL: "onepassword://", appTitle: "1Password" }] });
  });

  test("every verb builds into a command Ardia allows, with no JSON in argv", () => {
    for (const verb of Object.keys(sdk.CLI.verbs)) {
      const built = launchOf(verb, sampleParams(verb));
      assert.equal(built.code, undefined, `${verb}: ${built.message}`);
      assert.equal(built.launch.argv.join(" ").includes('"title"'), false, verb);
      assert.equal(built.launch.env.OP_BIOMETRIC_UNLOCK_ENABLED, "true", verb);
    }
  });

  test("a slot value can't smuggle an option or another command", () => {
    const refusals = [
      ["item.reveal", { id: "--out-file=/tmp/x" }],
      ["item.reveal", { id: "abc def" }],
      ["connect", { account: "-x" }],
      ["item.list", { account: "me@example.com", extra: "1" }],
      ["item.create", { vault: "vvvv", template: { title: "x" }, account: { $secret: "session" } }],
    ];
    for (const [verb, params] of refusals) assert.ok(launchOf(verb, params, () => "value").code, `${verb} ${JSON.stringify(params)}`);
  });

  test("op is told it runs for Ardia without a build number, which 1Password's server rejects", () => {
    const names = sdk.CLI.env.map((entry) => entry.name);
    assert.ok(names.includes("OP_INTEGRATION_NAME"));
    assert.ok(names.includes("OP_INTEGRATION_ID"));
    assert.ok(!names.includes("OP_INTEGRATION_BUILDNUMBER"));
    assert.equal(launchOf("connect", { account: ACCOUNT.account_uuid }).launch.env.OP_INTEGRATION_NAME, "Ardia");
  });
});
