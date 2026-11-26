import { readServerSentEvents, type AbortSignalLike, type Ardia } from "@ardia/plugin-sdk";
import { AiError, httpError, messageOf, streamError } from "./errors";

export const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

export type MessageRequest = {
  apiKey: string;
  model: string;
  prompt: string;
  system?: string;
  maxTokens: number;
  signal?: AbortSignalLike;
  onText?: (delta: string, text: string) => void;
};

export type MessageResult = { text: string; model: string; stopReason: string | null };

type StreamEvent = {
  type?: string;
  message?: { model?: string };
  delta?: { type?: string; text?: string; stop_reason?: string | null };
  error?: { type?: string; message?: string };
};

function parse(data: string): StreamEvent | null {
  try {
    const value = JSON.parse(data) as unknown;
    return value && typeof value === "object" ? (value as StreamEvent) : null;
  } catch {
    return null;
  }
}

export async function streamMessage(net: Ardia["net"], request: MessageRequest): Promise<MessageResult> {
  if (request.signal?.aborted) throw new AiError("cancelled", "The question was cancelled.");
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens,
    stream: true,
    messages: [{ role: "user", content: request.prompt }],
  };
  if (request.system) body.system = request.system;
  let response;
  try {
    response = await net.fetchStream(MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "x-api-key": request.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (error) {
    if (request.signal?.aborted) throw new AiError("cancelled", "The question was cancelled.");
    throw new AiError("network", `Couldn't reach Anthropic: ${messageOf(error)}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw httpError(response.status, text);
  }
  let text = "";
  let model = request.model;
  let stopReason: string | null = null;
  let finished = false;
  try {
    for await (const event of readServerSentEvents(response.body)) {
      if (request.signal?.aborted) break;
      const data = parse(event.data);
      if (!data) continue;
      const type = data.type ?? event.event;
      if (type === "message_start" && typeof data.message?.model === "string") model = data.message.model;
      else if (type === "content_block_delta" && data.delta?.type === "text_delta" && typeof data.delta.text === "string") {
        text += data.delta.text;
        request.onText?.(data.delta.text, text);
      } else if (type === "message_delta" && data.delta && "stop_reason" in data.delta) stopReason = data.delta.stop_reason ?? null;
      else if (type === "message_stop") finished = true;
      else if (type === "error") throw streamError(data.error?.type, data.error?.message);
    }
  } catch (error) {
    if (error instanceof AiError) throw error;
    if (request.signal?.aborted) throw new AiError("cancelled", "The question was cancelled.");
    throw new AiError("network", `The answer stopped early: ${messageOf(error)}`);
  }
  if (request.signal?.aborted) {
    await response.cancel().catch(() => undefined);
    throw new AiError("cancelled", "The question was cancelled.");
  }
  if (!finished) throw new AiError("incomplete", "The answer was cut off before Anthropic finished it. Ask again.");
  if (stopReason === "refusal") throw new AiError("refused", text ? `Claude declined to finish: ${text}` : "Claude declined to answer that.");
  return { text, model, stopReason };
}
