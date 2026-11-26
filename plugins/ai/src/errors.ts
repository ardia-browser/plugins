export type AiErrorCode = "no-key" | "bad-key" | "rate-limited" | "overloaded" | "unavailable" | "bad-request" | "refused" | "cancelled" | "network" | "incomplete" | "invalid-input";

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly status: number | undefined;

  constructor(code: AiErrorCode, message: string, status?: number) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.status = status;
  }
}

export const NO_KEY_MESSAGE = "Add your Anthropic API key first: run AI: Set Anthropic API Key from the command bar.";

function apiMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    return typeof parsed.error?.message === "string" ? parsed.error.message : null;
  } catch {
    return null;
  }
}

export function httpError(status: number, body: string): AiError {
  const detail = apiMessage(body);
  if (status === 401 || status === 403) return new AiError("bad-key", "Anthropic didn't accept your API key. Run AI: Set Anthropic API Key to enter it again.", status);
  if (status === 429) return new AiError("rate-limited", "Anthropic is rate limiting your API key. Wait a moment and ask again.", status);
  if (status === 529) return new AiError("overloaded", "Anthropic is overloaded right now. Ask again in a moment.", status);
  if (status >= 500) return new AiError("unavailable", `Anthropic had a problem answering (HTTP ${status}). Ask again in a moment.`, status);
  return new AiError("bad-request", detail ? `Anthropic refused the request: ${detail}` : `Anthropic refused the request (HTTP ${status}).`, status);
}

export function streamError(type: unknown, message: unknown): AiError {
  const text = typeof message === "string" && message ? message : "the answer stopped early";
  if (type === "overloaded_error") return new AiError("overloaded", "Anthropic is overloaded right now. Ask again in a moment.");
  if (type === "rate_limit_error") return new AiError("rate-limited", "Anthropic is rate limiting your API key. Wait a moment and ask again.");
  if (type === "authentication_error" || type === "permission_error") return new AiError("bad-key", "Anthropic didn't accept your API key. Run AI: Set Anthropic API Key to enter it again.");
  return new AiError("unavailable", `Anthropic stopped the answer: ${text}`);
}

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
