import { test } from "node:test";
import assert from "node:assert/strict";
import { readManifest } from "@ardia-plugins/testing";
import { start } from "./support.mjs";

const manifest = readManifest(new URL("..", import.meta.url).pathname);

test("Set Anthropic API Key keeps a well-formed key in secrets", async () => {
  const host = await start({ key: null });
  host.respond("ui.showInputBox", () => ({ value: "  sk-ant-api03-ZYXWVUTSRQPONM  " }));
  try {
    const result = await host.runCommand("set-api-key");
    assert.deepEqual(result, { saved: true });
    assert.equal(host.secrets.get("anthropic-api-key"), "sk-ant-api03-ZYXWVUTSRQPONM");
  } finally {
    await host.dispose();
  }
});

test("a value that isn't an Anthropic key is not saved", async () => {
  const host = await start({ key: null });
  host.respond("ui.showInputBox", () => ({ value: "hunter2" }));
  try {
    const result = await host.runCommand("set-api-key");
    assert.equal(result.saved, false);
    assert.match(result.problem, /sk-ant-/);
    assert.equal(host.secrets.has("anthropic-api-key"), false);
  } finally {
    await host.dispose();
  }
});

test("dismissing the key box changes nothing", async () => {
  const host = await start();
  host.respond("ui.showInputBox", () => ({ value: null }));
  try {
    assert.deepEqual(await host.runCommand("set-api-key"), { saved: false });
    assert.ok(host.secrets.has("anthropic-api-key"));
  } finally {
    await host.dispose();
  }
});

test("Forget Anthropic API Key deletes it", async () => {
  const host = await start();
  try {
    assert.deepEqual(await host.runCommand("forget-api-key"), { forgotten: true });
    assert.equal(host.secrets.has("anthropic-api-key"), false);
  } finally {
    await host.dispose();
  }
});

test("every handler command and input mode in plugin.json has code behind it", async () => {
  const host = await start();
  try {
    const [ready] = host.requests("ready");
    for (const command of manifest.contributes.commands.filter((c) => c.handler)) assert.ok(ready.commands.includes(command.name), command.name);
    for (const mode of manifest.contributes.inputModes) assert.ok(ready.views.includes(mode.id), mode.id);
    assert.deepEqual(manifest.provides, ["ai.provider"]);
    assert.deepEqual(ready.services, { "ai.provider": ["complete", "models"] });
  } finally {
    await host.dispose();
  }
});
