import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPlugin } from "@ardia-plugins/testing";
import { KEY, answer, start } from "./support.mjs";

const { streamMessage } = await loadPlugin(new URL("..", import.meta.url).pathname, "src/anthropic.ts");

const cutOff = (parts) => answer(parts).filter((chunk) => !chunk.startsWith("event: message_stop") && !chunk.startsWith("event: message_delta"));

test("streamMessage rejects text deltas that end without message_stop", async () => {
  const host = await start({ stream: { chunks: cutOff(["The answer ", "is"]) } });
  try {
    const seen = [];
    await assert.rejects(
      streamMessage(host.ardia.net, { apiKey: KEY, model: "claude-sonnet-5-5", prompt: "hi", maxTokens: 100, onText: (_delta, text) => seen.push(text) }),
      (error) => error.code === "incomplete" && /cut off/.test(error.message),
    );
    assert.deepEqual(seen, ["The answer ", "The answer is"]);
  } finally {
    await host.dispose();
  }
});

test("streamMessage rejects a stream that ends after its stop reason but before message_stop", async () => {
  const host = await start({ stream: { chunks: answer(["done"]).slice(0, -1) } });
  try {
    await assert.rejects(streamMessage(host.ardia.net, { apiKey: KEY, model: "claude-sonnet-5-5", prompt: "hi", maxTokens: 100 }), (error) => error.code === "incomplete");
  } finally {
    await host.dispose();
  }
});

test("ai.provider complete fails on a truncated stream instead of answering with stopReason null", async () => {
  const host = await start({ stream: { chunks: cutOff(["partial"]) } });
  try {
    await assert.rejects(host.callService("ai.provider", "complete", { prompt: "hi" }), /cut off/);
  } finally {
    await host.dispose();
  }
});

test("the ask view shows a truncated answer as a failure with Ask Again", async () => {
  const host = await start({ page: null, stream: { chunks: cutOff(["partial"]) } });
  try {
    const view = await host.mountView("ask", { kind: "command", context: { query: "Why?" } });
    await host.settle(20);
    const detail = view.byType("Detail")[0];
    assert.match(detail.props.markdown, /Couldn't answer\.\*\* The answer was cut off/);
    assert.ok(view.find((node) => node.type === "Action" && node.props?.title === "Ask Again"));
    await view.unmount();
  } finally {
    await host.dispose();
  }
});
