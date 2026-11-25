import { test } from "node:test";
import assert from "node:assert/strict";
import { KEY, MESSAGES_URL, answer, sentBody, sse, start } from "./support.mjs";

test("complete streams the answer from the Messages API and returns the whole text", async () => {
  const host = await start({ stream: { chunks: answer(["Hello", ", ", "world."]) } });
  try {
    const reply = await host.callService("ai.provider", "complete", { prompt: "Say hello", system: "Be brief." });
    assert.deepEqual(reply, { text: "Hello, world.", model: "claude-sonnet-5-5", stopReason: "end_turn" });
    const [request] = host.requests("net.fetch.stream");
    assert.equal(request.url, MESSAGES_URL);
    assert.equal(request.method, "POST");
    assert.equal(request.headers["x-api-key"], KEY);
    assert.equal(request.headers["anthropic-version"], "2023-06-01");
    assert.equal(request.headers["content-type"], "application/json");
    const body = sentBody(host);
    assert.equal(body.stream, true);
    assert.equal(body.model, "claude-sonnet-5-5");
    assert.equal(body.system, "Be brief.");
    assert.equal(body.max_tokens, 16000);
    assert.deepEqual(body.messages, [{ role: "user", content: "Say hello" }]);
  } finally {
    await host.dispose();
  }
});

test("chunks split mid-event still assemble into the same text", async () => {
  const whole = answer(["One ", "two ", "three"]).join("");
  const chunks = [];
  for (let i = 0; i < whole.length; i += 7) chunks.push(whole.slice(i, i + 7));
  const host = await start({ stream: { chunks } });
  try {
    const reply = await host.callService("ai.provider", "complete", { prompt: "Count" });
    assert.equal(reply.text, "One two three");
  } finally {
    await host.dispose();
  }
});

test("the model setting picks the model, and a known requested model wins over it", async () => {
  const host = await start({ values: { model: "claude-opus-5-5" }, stream: { chunks: answer(["ok"]) } });
  try {
    await host.callService("ai.provider", "complete", { prompt: "a" });
    assert.equal(sentBody(host, 0).model, "claude-opus-5-5");
    await host.callService("ai.provider", "complete", { prompt: "b", model: "claude-haiku-5-5", maxTokens: 999999 });
    assert.equal(sentBody(host, 1).model, "claude-haiku-5-5");
    assert.equal(sentBody(host, 1).max_tokens, 64000);
    await host.callService("ai.provider", "complete", { prompt: "c", model: "gpt-none" });
    assert.equal(sentBody(host, 2).model, "claude-opus-5-5");
  } finally {
    await host.dispose();
  }
});

test("models lists the three Claude models and the current default", async () => {
  const host = await start({ values: { model: "claude-haiku-5-5" } });
  try {
    const reply = await host.callService("ai.provider", "models");
    assert.deepEqual(reply.models.map((m) => m.id), ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
    assert.equal(reply.default, "claude-haiku-5-5");
  } finally {
    await host.dispose();
  }
});

test("without a key complete says how to add one and never calls Anthropic", async () => {
  const host = await start({ key: null, stream: { chunks: answer(["x"]) } });
  try {
    await assert.rejects(host.callService("ai.provider", "complete", { prompt: "hi" }), /Set Anthropic API Key/);
    assert.equal(host.requests("net.fetch.stream").length, 0);
  } finally {
    await host.dispose();
  }
});

test("an empty prompt is refused before anything is sent", async () => {
  const host = await start({ stream: { chunks: answer(["x"]) } });
  try {
    await assert.rejects(host.callService("ai.provider", "complete", { prompt: "  " }), /needs a prompt/);
    assert.equal(host.requests("net.fetch.stream").length, 0);
  } finally {
    await host.dispose();
  }
});

const errors = [
  [401, /didn't accept your API key/],
  [429, /rate limiting/],
  [529, /overloaded/],
  [500, /HTTP 500/],
  [400, /refused the request: max_tokens is too large/],
];

for (const [status, pattern] of errors) {
  test(`HTTP ${status} becomes a readable message`, async () => {
    const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens is too large" } });
    const host = await start({ stream: { status, chunks: [body] } });
    try {
      await assert.rejects(host.callService("ai.provider", "complete", { prompt: "hi" }), pattern);
    } finally {
      await host.dispose();
    }
  });
}

test("an error event in the stream stops the answer with its reason", async () => {
  const host = await start({ stream: { chunks: [answer(["part"])[0], sse("error", { error: { type: "overloaded_error", message: "Overloaded" } })] } });
  try {
    await assert.rejects(host.callService("ai.provider", "complete", { prompt: "hi" }), /overloaded/);
  } finally {
    await host.dispose();
  }
});

test("a refusal stop reason is reported, not returned as an answer", async () => {
  const host = await start({ stream: { chunks: answer([], { stopReason: "refusal" }) } });
  try {
    await assert.rejects(host.callService("ai.provider", "complete", { prompt: "hi" }), /declined/);
  } finally {
    await host.dispose();
  }
});

test("cancelling the service call cancels the stream", async () => {
  const parts = Array.from({ length: 200 }, (_, i) => `w${i} `);
  const host = await start({ stream: { chunks: answer(parts) } });
  try {
    const pending = host.callService("ai.provider", "complete", { prompt: "long" });
    const outcome = pending.then(
      () => "answered",
      (error) => error.message,
    );
    await host.settle(3);
    host.cancel("c1");
    await host.settle(20);
    const result = await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve("pending"), 500))]);
    assert.notEqual(result, "answered");
    assert.equal(host.requests("net.fetch.cancel").length, 1);
  } finally {
    await host.dispose();
  }
});
