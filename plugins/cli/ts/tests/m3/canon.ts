import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export type Entry = {
  k: string;
  c?: number;
  t?: number;
  m?: string;
  code?: number;
  by?: string;
  body?: string;
  step?: number | string;
  scratch?: string;
  [key: string]: unknown;
};

export type Message = { id?: number; method?: string; sessionId?: string; params?: unknown; result?: unknown; error?: unknown };

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const REDACTED = "<REDACTED>";
const SECRET_HEADERS = new Set(["authorization", "proxy-authorization", "cookie"]);

function redactHeaders(headers: unknown): unknown {
  if (Array.isArray(headers)) {
    return headers.map((entry: unknown) => {
      const header = entry as Record<string, unknown> | null;
      return header && typeof header["name"] === "string" && SECRET_HEADERS.has(header["name"].toLowerCase()) ? { ...header, value: REDACTED } : entry;
    });
  }
  if (headers !== null && typeof headers === "object") {
    return Object.fromEntries(Object.entries(headers as Record<string, unknown>).map(([name, value]) => [name, SECRET_HEADERS.has(name.toLowerCase()) ? REDACTED : value]));
  }
  return headers;
}

function redactCookies(cookies: unknown): unknown {
  return Array.isArray(cookies) ? cookies.map((cookie: unknown) => (cookie !== null && typeof cookie === "object" ? { ...(cookie as Record<string, unknown>), value: REDACTED } : cookie)) : cookies;
}

export function redactSecrets(message: Message): Message {
  const params = message.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) return message;
  const kept: Record<string, unknown> = { ...(params as Record<string, unknown>) };
  let changed = false;
  const auth = kept["authChallengeResponse"];
  if ((message.method === "Fetch.continueWithAuth" || message.method === "Network.continueInterceptedRequest") && auth !== null && typeof auth === "object") {
    const response: Record<string, unknown> = { ...(auth as Record<string, unknown>) };
    for (const field of ["username", "password"]) if (field in response) response[field] = REDACTED;
    kept["authChallengeResponse"] = response;
    changed = true;
  }
  if ((message.method === "Network.setExtraHTTPHeaders" || message.method === "Fetch.continueRequest" || message.method === "Network.continueInterceptedRequest") && "headers" in kept) {
    kept["headers"] = redactHeaders(kept["headers"]);
    changed = true;
  }
  if (message.method === "Network.setCookie" && "value" in kept) {
    kept["value"] = REDACTED;
    changed = true;
  }
  if ((message.method === "Network.setCookies" || message.method === "Storage.setCookies") && "cookies" in kept) {
    kept["cookies"] = redactCookies(kept["cookies"]);
    changed = true;
  }
  return changed ? { ...message, params: kept } : message;
}

export function redactedText(text: string): string {
  const message = parse(text);
  if (!message || !message.method) return text;
  const redacted = redactSecrets(message);
  return redacted === message ? text : JSON.stringify(redacted);
}

export function requestForm(message: Message): string {
  const { id: _id, ...rest } = redactSecrets(message);
  return canonical(rest);
}

export function readTranscript(path: string): Entry[] {
  const raw = readFileSync(path);
  const text = path.endsWith(".gz") ? new TextDecoder().decode(gunzipSync(raw)) : raw.toString("utf8");
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Entry);
}

export function parse(text: string): Message | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Message) : null;
  } catch {
    return null;
  }
}

export function replaceAll(text: string, from: string | undefined, to: string | undefined): string {
  if (!from || to === undefined || from === to) return text;
  return text.split(from).join(to);
}
