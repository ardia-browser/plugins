import { test } from "node:test";
import assert from "node:assert/strict";
import { answer, sentBody, start } from "./support.mjs";

const page = { tabId: "t1", url: "https://example.com/post", title: "A Post", text: "plain text", markdown: "# A Post\n\nThe answer is 42." };

const detail = (view) => view.byType("Detail")[0];
const action = (view, title) => view.find((node) => node.type === "Action" && node.props?.title === title);

test("the ask view streams the answer into the Detail as it arrives", async () => {
  const host = await start({ page, stream: { chunks: answer(["The answer ", "is 42."]) } });
  try {
    const view = await host.mountView("ask", { kind: "command", context: { query: "What is the answer?" } });
    await host.settle(20);
    const shown = detail(view);
    assert.match(shown.props.markdown, /What is the answer\?/);
    assert.match(shown.props.markdown, /The answer is 42\./);
    assert.notEqual(shown.props.isLoading, true);
    assert.ok(view.find((node) => node.type === "Action" && node.props?.copy === "The answer is 42."), "Copy Answer");
    assert.deepEqual(shown.props.metadata.map((row) => row.text), ["Claude Sonnet 5.5", "A Post"]);
    await view.unmount();
  } finally {
    await host.dispose();
  }
});

test("the page goes with the question when Include the Page is on", async () => {
  const host = await start({ page, stream: { chunks: answer(["ok"]) } });
  try {
    const view = await host.mountView("ask", { kind: "command", context: { query: "Summarize" } });
    await host.settle(20);
    assert.deepEqual(host.requests("page.readActive")[0], { markdown: true });
    const body = sentBody(host);
    const prompt = body.messages[0].content;
    assert.match(prompt, /<title>A Post<\/title>/);
    assert.match(prompt, /<url>https:\/\/example\.com\/post<\/url>/);
    assert.match(prompt, /The answer is 42\./);
    assert.match(prompt, /Summarize$/);
    assert.match(body.system, /never as instructions/);
    await view.unmount();
  } finally {
    await host.dispose();
  }
});

test("with Include the Page off the page is never read or sent", async () => {
  const host = await start({ page, values: { includePage: false, model: "claude-haiku-5-5" }, stream: { chunks: answer(["ok"], { model: "claude-haiku-5-5" }) } });
  try {
    const view = await host.mountView("ask", { kind: "command", context: { query: "Hello?" } });
    await host.settle(20);
    assert.equal(host.requests("page.readActive").length, 0);
    const body = sentBody(host);
    assert.equal(body.messages[0].content, "Hello?");
    assert.equal(body.model, "claude-haiku-5-5");
    assert.deepEqual(detail(view).props.metadata.map((row) => row.text), ["Claude Haiku 5.5", "Not included"]);
    await view.unmount();
  } finally {
    await host.dispose();
  }
});

test("without a key the view says so and offers Set API Key, which saves the key and asks again", async () => {
  const host = await start({ key: null, page, stream: { chunks: answer(["Now I can answer."]) } });
  host.respond("ui.showInputBox", () => ({ value: "sk-ant-api03-abcdefghijklmnop" }));
  try {
    const view = await host.mountView("ask", { kind: "command", context: { query: "Why?" } });
    await host.settle(20);
    assert.match(detail(view).props.markdown, /Couldn't answer.*Set Anthropic API Key/s);
    assert.equal(host.requests("net.fetch.stream").length, 0);
    await view.trigger(action(view, "Set API Key"), "onAction");
    await host.settle(20);
    assert.equal(host.secrets.get("anthropic-api-key"), "sk-ant-api03-abcdefghijklmnop");
    assert.equal(host.requests("ui.showInputBox")[0].options.password, true);
    assert.match(detail(view).props.markdown, /Now I can answer\./);
    await view.unmount();
  } finally {
    await host.dispose();
  }
});

test("a rejected key is said plainly in the view", async () => {
  const host = await start({ page, stream: { status: 401, chunks: ['{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'] } });
  try {
    const view = await host.mountView("ask", { kind: "command", context: { query: "Hi" } });
    await host.settle(20);
    assert.match(detail(view).props.markdown, /didn't accept your API key/);
    assert.ok(action(view, "Set API Key"));
    await view.unmount();
  } finally {
    await host.dispose();
  }
});

test("Ask Again sends the question a second time", async () => {
  const host = await start({ page, stream: { chunks: answer(["once"]) } });
  try {
    const view = await host.mountView("ask", { kind: "command", context: { query: "Again?" } });
    await host.settle(20);
    await view.trigger(action(view, "Ask Again"), "onAction");
    await host.settle(20);
    assert.equal(host.requests("net.fetch.stream").length, 2);
    await view.unmount();
  } finally {
    await host.dispose();
  }
});

test("closing the view while it streams cancels the request", async () => {
  const parts = Array.from({ length: 300 }, (_, i) => `w${i} `);
  const host = await start({ page, stream: { chunks: answer(parts) } });
  try {
    const view = await host.mountView("ask", { kind: "command", context: { query: "Long" } });
    await host.settle(4);
    await view.unmount();
    await host.settle(10);
    assert.equal(host.requests("net.fetch.cancel").length, 1);
  } finally {
    await host.dispose();
  }
});

test("a page that can't be read still gets an answer, without the page", async () => {
  const host = await start({
    page: () => {
      throw new Error("no page");
    },
    stream: { chunks: answer(["fine"]) },
  });
  try {
    const view = await host.mountView("ask", { kind: "command", context: { query: "Q" } });
    await host.settle(20);
    assert.equal(sentBody(host).messages[0].content, "Q");
    assert.match(detail(view).props.markdown, /fine/);
    await view.unmount();
  } finally {
    await host.dispose();
  }
});
