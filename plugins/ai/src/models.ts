export type ModelInfo = { id: string; name: string };

export const MODELS: readonly ModelInfo[] = [
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
];

export const DEFAULT_MODEL = "claude-sonnet-5-5";

export const DEFAULT_MAX_TOKENS = 16000;

export const MAX_MAX_TOKENS = 64000;

export function resolveModel(requested: unknown, setting: unknown): string {
  for (const candidate of [requested, setting]) {
    if (typeof candidate === "string" && MODELS.some((model) => model.id === candidate)) return candidate;
  }
  return DEFAULT_MODEL;
}

export function resolveMaxTokens(requested: unknown): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return DEFAULT_MAX_TOKENS;
  return Math.min(MAX_MAX_TOKENS, Math.max(1, Math.floor(requested)));
}
