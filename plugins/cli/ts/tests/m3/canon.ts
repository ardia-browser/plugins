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

export function requestForm(message: Message): string {
  const { id: _id, ...rest } = message;
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
