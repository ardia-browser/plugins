export type Frame =
  | { t: "call"; p: string; id: number; method: string; payload: unknown }
  | { t: "stream"; p: string; id: number; method: string; payload: unknown }
  | { t: "cancel"; p: string; id: number }
  | { t: "api"; p: string; id: number; method: "GET" | "POST"; path: string; body?: unknown }
  | { t: "open"; p: string; url: string }
  | { t: "ping"; p: string }
  | { t: "pong"; p: string; moved: boolean }
  | { t: "result"; p: string; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: "items"; p: string; id: number; items: unknown[] }
  | { t: "end"; p: string; id: number; error?: string }
  | { t: "part"; p: string; id: string; i: number; n: number; s: string };

export const PAGE_TO_HELPER_LIMIT = 60_000;
export const HELPER_TO_PAGE_LIMIT = 240_000;
export const SENDS_PER_SECOND = 80;
export const PING_MS = 3_000;
export const LOST_MS = 10_000;
export const CALL_TIMEOUT_MS = 60_000;
export const INSTANCE = /^[A-Za-z0-9_-]{8,64}$/;

const encoder = new TextEncoder();

export function sentSize(frame: unknown): number {
  const text = JSON.stringify(frame);
  let slashes = 0;
  for (let i = text.indexOf("/"); i >= 0; i = text.indexOf("/", i + 1)) slashes++;
  return encoder.encode(text).length + slashes;
}

export function split(frame: Frame, limit: number, partId: () => string): Frame[] {
  if (sentSize(frame) <= limit) return [frame];
  const text = JSON.stringify(frame);
  const id = partId();
  const pieces: string[] = [];
  for (let at = 0; at < text.length; ) {
    let size = Math.min(text.length - at, limit);
    for (;;) {
      const measured = sentSize({ t: "part", p: frame.p, id, i: 99_999, n: 99_999, s: text.slice(at, at + size) });
      if (measured <= limit || size === 1) break;
      size = Math.max(1, Math.min(size - 1, Math.floor((size * limit * 0.98) / measured)));
    }
    pieces.push(text.slice(at, at + size));
    at += size;
  }
  return pieces.map((s, i) => ({ t: "part" as const, p: frame.p, id, i, n: pieces.length, s }));
}

export class Assembler {
  private readonly open = new Map<string, string[]>();

  take(frame: Frame): Frame | null {
    if (frame.t !== "part") return frame;
    if (!Number.isInteger(frame.n) || frame.n < 1 || frame.n > 4096 || !Number.isInteger(frame.i) || frame.i < 0 || frame.i >= frame.n) return null;
    const key = `${frame.p}:${frame.id}`;
    const parts = this.open.get(key) ?? new Array<string>(frame.n);
    parts[frame.i] = frame.s;
    this.open.set(key, parts);
    if (parts.filter((p) => p !== undefined).length < frame.n) return null;
    this.open.delete(key);
    try {
      return JSON.parse(parts.join("")) as Frame;
    } catch {
      return null;
    }
  }

  drop(instance: string) {
    for (const key of this.open.keys()) if (key.startsWith(`${instance}:`)) this.open.delete(key);
  }
}
