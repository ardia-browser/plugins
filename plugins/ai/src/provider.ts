import type { Ardia, CallContext, ServiceHandlers } from "@ardia/plugin-sdk";
import { abortOnCancel } from "./abort";
import { streamMessage, type MessageResult } from "./anthropic";
import { AiError } from "./errors";
import { readKey } from "./key";
import { DEFAULT_MODEL, MODELS, resolveMaxTokens, resolveModel, type ModelInfo } from "./models";

export const AI_PROVIDER = "ai.provider";

export type CompleteInput = { prompt: string; system?: string; model?: string; maxTokens?: number };

export type ModelsResult = { models: ModelInfo[]; default: string };

function completeInput(input: unknown): CompleteInput {
  const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (typeof value.prompt !== "string" || !value.prompt.trim()) throw new AiError("invalid-input", "complete needs a prompt: a string that isn't empty.");
  if (value.system !== undefined && typeof value.system !== "string") throw new AiError("invalid-input", "complete's system must be a string.");
  const out: CompleteInput = { prompt: value.prompt };
  if (typeof value.system === "string") out.system = value.system;
  if (typeof value.model === "string") out.model = value.model;
  if (typeof value.maxTokens === "number") out.maxTokens = value.maxTokens;
  return out;
}

export function currentModel(ardia: Ardia, requested?: unknown): string {
  return resolveModel(requested, ardia.settings.get<string>("model", DEFAULT_MODEL));
}

export async function complete(ardia: Ardia, input: unknown, call?: CallContext): Promise<MessageResult> {
  const request = completeInput(input);
  const apiKey = await readKey(ardia);
  const aborter = abortOnCancel(call?.signal);
  return streamMessage(ardia.net, {
    apiKey,
    model: currentModel(ardia, request.model),
    prompt: request.prompt,
    maxTokens: resolveMaxTokens(request.maxTokens),
    signal: aborter.signal,
    ...(request.system ? { system: request.system } : {}),
  });
}

export function aiProvider(ardia: Ardia): ServiceHandlers {
  return {
    complete: (input: unknown, call: CallContext) => complete(ardia, input, call),
    models: (): ModelsResult => ({ models: MODELS.map((model) => ({ ...model })), default: currentModel(ardia) }),
  };
}
