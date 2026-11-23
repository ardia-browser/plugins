import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ACCOUNT, manifest, sdk } from "./support.mjs";

const bundle = readFileSync(fileURLToPath(new URL("../dist/main.js", import.meta.url)), "utf8");
const WAIT_MS = 4000;

function host() {
  const sent = [];
  const waiters = new Set();
  let deliver = () => {};
  const bridge = {
    send: (line) => {
      sent.push(JSON.parse(line));
      for (const wake of waiters) wake();
    },
    onLine: (listener) => (deliver = listener),
  };
  const context = vm.createContext({ __ardiaBridge: bridge, setTimeout, clearTimeout, console });
  vm.runInContext(bundle, context, { filename: "main.js" });
  const until = (find, what) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const found = sent.find(find);
        if (!found) return;
        waiters.delete(check);
        clearTimeout(timer);
        resolve(found);
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`the plugin never sent ${what}; it sent ${JSON.stringify(sent).slice(0, 600)}`));
      }, WAIT_MS);
      waiters.add(check);
      check();
    });
  const send = (message) => deliver(JSON.stringify(message));
  const request = (method, where = () => true) => until((m) => m.method === method && where(m), method);
  const answer = (message, result) => send({ id: message.id, result });
  return { sent, send, request, answer, until };
}

const verbReply = (verb, overrides = {}) => ({
  verb,
  status: 0,
  launched: true,
  timedOut: false,
  cancelled: false,
  overflowed: false,
  succeeded: true,
  stderr: "",
  hints: [],
  json: null,
  parts: 0,
  lines: [],
  items: 0,
  unlocked: false,
  droppedLines: 0,
  signInRun: { state: "none", hints: [] },
  ...overrides,
});

const context = (overrides = {}) => ({
  epoch: "e3",
  provider: "1password",
  touchID: false,
  offline: false,
  session: { key: null },
  hasStored: false,
  signInRun: { state: "none", hints: [] },
  scratch: {},
  preferences: { account: ACCOUNT.account_uuid },
  cli: { name: "op", version: "2.31.0" },
  ...overrides,
});

async function started() {
  const plugin = host();
  const hello = await plugin.request("hello");
  plugin.answer(hello, { app: "Ardia", version: "1.41.0", protocol: 2, plugin: "1password", values: {}, credentials: { protocol: 1, supported: [1], provider: "1password" } });
  const ready = await plugin.request("ready");
  plugin.answer(ready, { ok: true });
  return { plugin, hello, ready };
}

const resultFor = (plugin, call) => plugin.request("result", (m) => m.params.call === call);

describe("the built plugin on Ardia's channel", () => {
  test("says hello with credentials protocol 1 and offers exactly 1Password's handlers", async () => {
    const { hello, ready } = await started();
    assert.deepEqual(hello.params, { protocol: 2, sdk: "2.1.0", credentials: 1 });
    assert.deepEqual(ready.params.credentialProvider, { handlers: ["state", "signIn", "unlock", "signOut", "list", "reveal", "save", "edit", "addTotp"] });
    assert.deepEqual([ready.params.commands, ready.params.tools, ready.params.views, ready.params.decide, ready.params.events], [[], [], [], [], []]);
  });

  test("answers a state call by running account.list inside the call", async () => {
    const { plugin } = await started();
    plugin.send({ call: "v7", kind: "credentials", name: "state", input: { explicit: true }, deadline: 45000, context: context() });
    const verb = await plugin.request("credentials.verb");
    assert.deepEqual(verb.params, { call: "v7", verb: "account.list", params: {} });
    plugin.answer(verb, verbReply("account.list", { json: [ACCOUNT] }));
    const result = await resultFor(plugin, "v7");
    assert.deepEqual(result.params.result, { state: "unlocked", account: "me@example.com", server: { url: "https://my.1password.com" } });
  });

  test("streams a listing's items one notice at a time and pages them back", async () => {
    const { plugin } = await started();
    plugin.send({ call: "v8", kind: "credentials", name: "list", input: { snapshot: null, cursor: null }, deadline: 240000, context: context() });
    const verb = await plugin.request("credentials.verb");
    assert.deepEqual(verb.params.params, { account: ACCOUNT.account_uuid });
    plugin.send({ verbOf: verb.id, item: { id: "abc123", title: "One", urls: [{ href: "https://one.example" }] }, index: 0 });
    plugin.send({ verbOf: verb.id, item: { id: "def456", title: "Two" }, index: 1 });
    plugin.answer(verb, verbReply("item.list", { json: [], items: 2 }));
    const result = await resultFor(plugin, "v8");
    assert.match(result.params.result.snapshot, /^[A-Za-z0-9_-]{1,64}$/);
    assert.deepEqual(result.params.result.items.map((item) => item.id), ["abc123", "def456"]);
    assert.equal(result.params.result.cursor, undefined);
  });

  test("joins a JSON answer sent in parts", async () => {
    const { plugin } = await started();
    plugin.send({ call: "v9", kind: "credentials", name: "reveal", input: { id: "abc123", fields: ["password"] }, deadline: 90000, context: context() });
    const verb = await plugin.request("credentials.verb");
    const text = JSON.stringify({ id: "abc123", fields: [{ purpose: "PASSWORD", value: "joined-secret" }] });
    plugin.send({ verbOf: verb.id, part: text.slice(0, 20) });
    plugin.send({ verbOf: verb.id, part: text.slice(20) });
    plugin.answer(verb, verbReply("item.reveal", { parts: 2 }));
    assert.deepEqual((await resultFor(plugin, "v9")).params.result, { password: "joined-secret" });
  });

  test("a stale verb, from a lock, fails the call as locked", async () => {
    const { plugin } = await started();
    plugin.send({ call: "v10", kind: "credentials", name: "list", input: { snapshot: null, cursor: null }, deadline: 240000, context: context() });
    const verb = await plugin.request("credentials.verb");
    plugin.send({ id: verb.id, error: { code: "stale", message: "1Password locked, so this call ended." } });
    assert.deepEqual((await resultFor(plugin, "v10")).params.error, { code: "locked" });
  });

  test("a cancelled call sends no result", async () => {
    const { plugin } = await started();
    plugin.send({ call: "v11", kind: "credentials", name: "list", input: { snapshot: null, cursor: null }, deadline: 240000, context: context() });
    const verb = await plugin.request("credentials.verb");
    plugin.send({ call: "v11", cancel: true });
    plugin.answer(verb, verbReply("item.list", { cancelled: true, succeeded: false, status: -1 }));
    plugin.send({ call: "v12", kind: "credentials", name: "state", input: { explicit: false }, deadline: 45000, context: context() });
    const next = await plugin.request("credentials.verb", (m) => m.params.call === "v12");
    plugin.answer(next, verbReply("account.list", { json: [] }));
    await resultFor(plugin, "v12");
    assert.equal(plugin.sent.some((m) => m.method === "result" && m.params.call === "v11"), false);
  });

  test("a handler it doesn't have, or another kind of call, is unsupported", async () => {
    const { plugin } = await started();
    plugin.send({ call: "v13", kind: "credentials", name: "passkeys.get", input: {}, deadline: 1000, context: context() });
    plugin.send({ call: "c1", kind: "tool", name: "state", input: {} });
    assert.deepEqual((await resultFor(plugin, "v13")).params.error, { code: "unsupported" });
    assert.deepEqual((await resultFor(plugin, "c1")).params.error, { code: "unsupported" });
  });
});

describe("the manifest", () => {
  const contribution = manifest.contributes.credentialProvider;

  test("is a closed, official credential provider with app approval that stays authorized for 10 minutes", () => {
    assert.equal(manifest.official, true);
    assert.equal(manifest.main, "dist/main.js");
    assert.deepEqual(Object.keys(manifest.contributes), ["credentialProvider"]);
    assert.equal(manifest.permissions, undefined);
    assert.equal(contribution.approvalLastsSeconds, 600);
    assert.deepEqual(contribution.signIn, { methods: [{ id: "app", title: "1Password App", kind: "desktopApproval", appURL: "onepassword://", appTitle: "1Password" }] });
    assert.equal(contribution.capabilities.includes("passkeys"), false);
    assert.deepEqual(contribution.cli.onLock, { verb: "signout", params: { account: { from: "preference", key: "account" } } });
  });

  test("every verb builds into a command Ardia allows, with no secret or JSON in argv", () => {
    const sample = { id: "abcdefghijklmnopqrstuvwxyz", account: "ACCOUNTUUID1", vault: "vvvvvvvvvvvvvvvvvvvvvvvvvv", template: { title: "x" } };
    for (const [verb, definition] of Object.entries(contribution.cli.verbs)) {
      const params = Object.fromEntries(Object.keys(definition.slots ?? {}).map((slot) => [slot, sample[slot]]));
      const launch = sdk.buildVerbLaunch(manifest, verb, params, () => null, null);
      assert.equal(launch.refused, undefined, `${verb}: ${launch.refused}`);
      assert.equal(launch.argv.join(" ").includes('"title"'), false, verb);
    }
  });

  test("a slot value can't smuggle an option or another command", () => {
    const refusals = [
      ["item.reveal", { id: "--out-file=/tmp/x" }],
      ["item.reveal", { id: "abc def" }],
      ["connect", { account: "-x" }],
      ["item.list", { account: "me@example.com", extra: "1" }],
      ["item.create", { vault: "vvvv", template: { title: "x" }, account: { $secret: "h1" } }],
    ];
    for (const [verb, params] of refusals) assert.ok(sdk.buildVerbLaunch(manifest, verb, params, () => "value", null).refused, `${verb} ${JSON.stringify(params)}`);
  });

  test("only hidden test instances point op at their own config folder", () => {
    const normal = sdk.buildVerbLaunch(manifest, "account.list", {}, () => null, null);
    const isolated = sdk.buildVerbLaunch(manifest, "account.list", {}, () => null, "/scratch/1password");
    assert.equal(normal.env.OP_CONFIG_DIR, undefined);
    assert.equal(isolated.env.OP_CONFIG_DIR, "/scratch/1password");
  });

  test("every op command uses the 1Password app without reading its settings, which macOS keeps from apps other than Terminal", () => {
    const cli = manifest.contributes.credentialProvider.cli;
    for (const verb of Object.keys(cli.verbs)) {
      const values = { id: "abcdefghijklmnopqrstuvwxyz", vault: "vvvvvvvvvvvvvvvvvvvvvvvvvv", account: ACCOUNT.account_uuid, template: { title: "x" } };
      const params = Object.fromEntries(Object.keys(cli.verbs[verb].slots ?? {}).map((slot) => [slot, values[slot]]));
      const launch = sdk.buildVerbLaunch(manifest, verb, params, () => null, null);
      assert.equal(launch.refused, undefined, verb);
      assert.equal(launch.env.OP_BIOMETRIC_UNLOCK_ENABLED, "true", verb);
    }
  });

  test("op is told it runs for Ardia without a build number, which 1Password's server rejects", () => {
    const names = manifest.contributes.credentialProvider.cli.env.map((entry) => entry.name);
    assert.ok(names.includes("OP_INTEGRATION_NAME"));
    assert.ok(names.includes("OP_INTEGRATION_ID"));
    assert.ok(!names.includes("OP_INTEGRATION_BUILDNUMBER"));
    const launch = sdk.buildVerbLaunch(manifest, "connect", { account: ACCOUNT.account_uuid }, () => null, null);
    assert.equal(launch.env.OP_INTEGRATION_BUILDNUMBER, undefined);
    assert.equal(launch.env.OP_INTEGRATION_NAME, "Ardia");
  });
});
