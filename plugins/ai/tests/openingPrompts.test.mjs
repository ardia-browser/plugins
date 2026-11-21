import { test } from "node:test";
import assert from "node:assert/strict";
import { OpeningPrompts, resolveOpening } from "../page/src/openingPrompts.ts";
import { pageLocation } from "../page/src/pagePath.ts";

const PAGE = "ardia-plugin://ai/page/index.html";
const at = (path) => `${PAGE}?ardiaPath=${encodeURIComponent(path)}`;

test("a reconnect after the opening prompt was sent: the same chat, and the prompt is sent once", () => {
  const prompts = new OpeningPrompts();
  let ids = 0;
  const newId = () => `chat-${String(++ids).padStart(8, "0")}`;
  const replaced = resolveOpening(at("/new?q=Say \"hi\" 日本"), true, newId, prompts);
  const after = `ardia-plugin://ai${replaced}`;
  const route = pageLocation(after, true);
  assert.deepEqual(route, { path: "/chat-00000001", search: "" }, "the address names the new chat and no longer carries the prompt");
  assert.equal(prompts.take("chat-00000001"), 'Say "hi" 日本', "the first ChatView sends it");
  assert.equal(resolveOpening(after, true, newId, prompts), null, "reading the route again after recovery changes nothing");
  assert.equal(pageLocation(after, true).path, "/chat-00000001", "the remounted chat is the same chat");
  assert.equal(prompts.take("chat-00000001"), null, "a remounted ChatView finds nothing to send");
  prompts.offer("chat-00000001", "again");
  assert.equal(prompts.peek("chat-00000001"), null, "a consumed chat is never offered its prompt again");
  assert.equal(ids, 1, "only one chat id was made");
});

test("a page opened at the root or a chat address with q hands its prompt over once and drops it from the address", () => {
  const prompts = new OpeningPrompts();
  assert.match(resolveOpening(at("/"), true, () => "chat-root-1", prompts), /ardiaPath=%2Fchat-root-1$/);
  const chat = resolveOpening(at("/0b9e6c1e-2f4a-4c55-9d7e-1a2b3c4d5e6f?q=hello"), true, () => "unused", prompts);
  assert.match(chat, /ardiaPath=%2F0b9e6c1e-2f4a-4c55-9d7e-1a2b3c4d5e6f$/);
  assert.equal(prompts.take("0b9e6c1e-2f4a-4c55-9d7e-1a2b3c4d5e6f"), "hello");
  assert.equal(resolveOpening(at("/history"), true, () => "unused", prompts), null);
});
