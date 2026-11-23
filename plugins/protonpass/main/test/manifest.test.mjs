import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { manifest, subject } from "./helpers.mjs";

const provider = manifest.contributes.credentialProvider;
const build = (verb, params, { secrets = () => null, testFolder = null } = {}) => subject.buildVerbLaunch(manifest, verb, params, secrets, testFolder);
const handle = (id) => ({ $secret: id });
const leadingWords = (argv) => {
  const words = [];
  for (const element of argv) {
    if (typeof element !== "string" || element.startsWith("-")) break;
    words.push(element);
  }
  return words.join(" ");
};
const consentVerbs = () => [...new Set(Object.values(provider.cli.verbs).map((verb) => leadingWords(verb.argv)))];

describe("manifest", () => {
  test("meets every credentialProvider rule in the contract", () => {
    assert.deepEqual(subject.checkCredentialManifest(manifest), []);
  });

  test("is a closed, official main plugin that never reads offline", () => {
    assert.equal(manifest.manifest, 2);
    assert.equal(manifest.name, "protonpass");
    assert.equal(manifest.official, true);
    assert.equal(manifest.main, "dist/main.js");
    assert.equal(manifest.permissions, undefined);
    assert.deepEqual(Object.keys(manifest.contributes), ["credentialProvider"]);
    assert.equal(provider.readsOffline, false);
  });

  test("offers totp, save and Touch ID, and leaves passkeys to the Proton Pass extension", () => {
    assert.deepEqual(provider.capabilities, ["totp", "save", "touchID"]);
    assert.deepEqual(provider.passkeys, [{ via: "extension", extensions: ["ghmbeldphafepmbegfdlkpapadhbakde"] }]);
    assert.equal(provider.signIn.unlock, undefined);
  });

  test("the plugin handles every capability it offers and every required call", () => {
    assert.deepEqual(subject.credentialHandlersOf(subject.provider), ["state", "signIn", "unlock", "signOut", "list", "reveal", "save"]);
  });

  test("dist/main.js registers the provider with every handler it has", async () => {
    const sent = [];
    let deliver = () => {};
    const bridge = { send: (line) => sent.push(JSON.parse(line)), onLine: (listener) => (deliver = listener) };
    const next = async (method) => {
      for (let tries = 0; tries < 200; tries++) {
        const found = sent.find((line) => line.method === method);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`no ${method} line; sent ${JSON.stringify(sent)}`);
    };
    const code = readFileSync(fileURLToPath(new URL("../dist/main.js", import.meta.url)), "utf8");
    vm.runInContext(code, vm.createContext({ __ardiaBridge: bridge, setTimeout, clearTimeout }), { filename: "main.js" });
    const hello = await next("hello");
    deliver(JSON.stringify({ id: hello.id, result: { app: "Ardia", protocol: 2, plugin: "protonpass", credentials: { protocol: 1, supported: [1], provider: "protonpass" } } }));
    const ready = await next("ready");
    assert.deepEqual(ready.params.credentialProvider.handlers, subject.credentialHandlersOf(subject.provider));
  });

  test("speaks the credentials protocol the contract supports", () => {
    assert.equal(subject.CREDENTIALS_PROTOCOL, 1);
    assert.ok(subject.CREDENTIALS_PROTOCOLS_SUPPORTED.includes(subject.CREDENTIALS_PROTOCOL));
  });

  test("signs in with the browser or an access token, each with an optional extra password", () => {
    assert.deepEqual(
      provider.signIn.methods.map((method) => [method.id, method.kind, method.fields.map((field) => `${field.id}:${field.type}${field.optional ? "?" : ""}`)]),
      [
        ["browser", "browserApproval", ["extraPassword:secret?"]],
        ["token", "fields", ["token:secret", "extraPassword:secret?"]],
      ],
    );
    assert.deepEqual(provider.signIn.approvalHosts, ["proton.me"]);
  });

  test("consent names exactly the pass-cli commands it runs", () => {
    assert.deepEqual(consentVerbs(), ["info", "login", "logout", "vault list", "item list", "item totp", "item view", "item create login"]);
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
    const values = { h1: "token-value-123", h2: "extra-value-456" };
    const launch = build("login.token", { token: handle("h1"), extraPassword: handle("h2") }, { secrets: (h) => values[h.$secret] ?? null });
    assert.deepEqual(launch.argv, ["login"]);
    assert.equal(launch.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN, "token-value-123");
    assert.equal(launch.env.PROTON_PASS_EXTRA_PASSWORD, "extra-value-456");
    assert.ok(!launch.argv.join(" ").includes("value"));
    assert.equal(launch.signIn, true);
  });

  test("without an extra password the browser login leaves the variable out and waits 660 s", () => {
    const launch = build("login.browser", {});
    assert.equal("PROTON_PASS_EXTRA_PASSWORD" in launch.env, false);
    assert.equal(launch.timeoutMs, 660_000);
    assert.equal(launch.signIn, true);
  });

  test("telemetry and update checks are off for every verb, and test isolation only applies in a test instance", () => {
    const normal = build("info", {});
    assert.deepEqual(normal.env, { PROTON_PASS_NO_UPDATE_CHECK: "1", PROTON_PASS_DISABLE_TELEMETRY: "1" });
    const isolated = build("info", {}, { testFolder: "/scratch/pm" });
    assert.equal(isolated.env.PROTON_PASS_SESSION_DIR, "/scratch/pm");
    assert.equal(isolated.env.PROTON_PASS_KEY_PROVIDER, "fs");
  });

  const refusals = [
    ["a share with a slash", "item.view", { share: "a/b", item: "i1" }],
    ["a share over 200 characters", "item.view", { share: "a".repeat(201), item: "i1" }],
    ["a missing item id", "item.view", { share: "s1" }],
    ["an unknown slot", "item.view", { share: "s1", item: "i1", field: "password" }],
    ["a plain string where a secret goes", "login.token", { token: "pasted-token" }],
    ["a handle where an id goes", "item.view", { share: handle("h1"), item: "i1" }],
    ["a used or unknown handle", "login.token", { token: handle("h9") }],
    ["a verb the catalog doesn't have", "run", {}],
  ];
  for (const [name, verb, params] of refusals) {
    test(`refuses ${name}`, () => {
      assert.ok("refused" in build(verb, params));
    });
  }
});
