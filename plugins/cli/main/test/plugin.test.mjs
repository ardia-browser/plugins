import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockHost } from "@ardia/plugin-sdk/testing";
import { loadPlugin } from "@ardia-plugins/testing";

const { createPlugin } = await loadPlugin(new URL("..", import.meta.url).pathname);

const linked = { state: "linked", linked: ["ardia"], failed: [], binDir: "/Users/someone/.local/bin" };
const failed = { state: "failed", linked: [], failed: [{ name: "ardia", reason: "~/.local/bin/ardia is someone else's" }], binDir: "/Users/someone/.local/bin" };

async function mounted(replies) {
  const host = createMockHost({ plugin: "@ardia/cli" });
  for (const [method, reply] of Object.entries(replies)) host.respond(method, typeof reply === "function" ? reply : () => reply);
  await host.load(createPlugin(host.ardia));
  const view = await host.mountView("status", { kind: "command" });
  await host.settle();
  return { host, view };
}

test("the status view says where ardia is linked on a protocol 3 host", async () => {
  const { host, view } = await mounted({ "programs.status": linked });
  try {
    assert.match(view.text(), /is on your PATH/);
    assert.match(view.text(), /\/Users\/someone\/\.local\/bin\/ardia/);
    assert.equal(host.requests("programs.relink").length, 0);
  } finally {
    await host.dispose();
  }
});

test("Try Again relinks a failed link and shows the new status", async () => {
  let state = failed;
  const { host, view } = await mounted({
    "programs.status": () => state,
    "programs.relink": () => {
      state = linked;
      return { ok: true };
    },
  });
  try {
    assert.match(view.text(), /isn't on your PATH/);
    const tryAgain = view.find((node) => node.type === "Action" && node.props?.title === "Try Again");
    assert.ok(tryAgain, "Try Again");
    await view.trigger(tryAgain, "onAction");
    await host.settle();
    assert.match(view.text(), /is on your PATH/);
    assert.equal(host.requests("programs.relink").length, 1);
  } finally {
    await host.dispose();
  }
});
