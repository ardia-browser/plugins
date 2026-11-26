import { createMockHost } from "@ardia/plugin-sdk/testing";
import { loadPlugin } from "@ardia-plugins/testing";

const { createPlugin } = await loadPlugin(new URL("..", import.meta.url).pathname, "src/plugin.tsx");

export const KEY = "sk-ant-test-0123456789abcdef";
export const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

export const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

export function answer(parts, { model = "claude-sonnet-5-5", stopReason = "end_turn" } = {}) {
  return [
    sse("message_start", { message: { id: "msg_1", model, role: "assistant", content: [] } }),
    sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    ...parts.map((text) => sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } })),
    sse("content_block_stop", { index: 0 }),
    sse("message_delta", { delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } }),
    sse("message_stop", {}),
  ];
}

export async function start({ key = KEY, values = {}, page, stream } = {}) {
  const host = createMockHost({ plugin: "@ardia/ai", values });
  if (key) host.secrets.set("anthropic-api-key", key);
  if (page !== undefined) host.respond("page.readActive", typeof page === "function" ? page : () => page);
  if (stream) host.mockFetchStream(MESSAGES_URL, stream);
  await host.load(createPlugin(host.ardia));
  return host;
}

export const sentBody = (host, index = 0) => JSON.parse(host.requests("net.fetch.stream")[index].body);
