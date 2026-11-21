import { codePoints, utf8 } from "./pystr.ts";
import { PyException } from "./pylib/str.ts";

export const MASK = "***";
const TOKEN = "token=";
const secrets: string[] = [];
let ordered: string[] = [];
let prefixes: string[][] = [];

const STOPS = new Set([0x26, 0x27, 0x22, 0x3c, 0x3e, 0x5c, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);

function stops(unit: number): boolean {
  return STOPS.has(unit) || (unit >= 0x2000 && unit <= 0x200a);
}

function urlQuote(text: string): string {
  if (/[\ud800-\udfff]/.test(text.replaceAll(/[\ud800-\udbff][\udc00-\udfff]/g, ""))) {
    throw new PyException("UnicodeEncodeError", "'utf-8' codec can't encode character: surrogates not allowed");
  }
  let out = "";
  for (const byte of utf8(text)) {
    const safe = (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x5f || byte === 0x2e || byte === 0x2d || byte === 0x7e;
    out += safe ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function remember(secret: string): void {
  if (secrets.includes(secret)) return;
  secrets.push(secret);
  const sized = secrets.map((held) => ({ held, size: codePoints(held).length }));
  sized.sort((a, b) => b.size - a.size);
  ordered = sized.map((entry) => entry.held);
  prefixes = secrets.map((held) => {
    const points = codePoints(held);
    const out: string[] = [];
    for (let size = 1; size < points.length; size += 1) out.push(points.slice(0, size).join(""));
    return out;
  });
}

export function addSecret(secret: string | null | undefined): void {
  if (!secret) return;
  const quoted = urlQuote(secret);
  remember(secret);
  remember(quoted);
}

export function clearSecrets(): void {
  secrets.length = 0;
  ordered = [];
  prefixes = [];
}

export function maskTokenQueries(text: string): string {
  let at = text.indexOf(TOKEN);
  if (at < 0) return text;
  let out = "";
  let copied = 0;
  while (at >= 0) {
    const start = at + TOKEN.length;
    let end = start;
    while (end < text.length && !stops(text.charCodeAt(end))) end += 1;
    if (end > start) {
      out += text.slice(copied, start) + MASK;
      copied = end;
      at = text.indexOf(TOKEN, end);
    } else at = text.indexOf(TOKEN, at + 1);
  }
  return out + text.slice(copied);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of ordered) if (out.includes(secret)) out = out.replaceAll(secret, MASK);
  return maskTokenQueries(out);
}

export function unsafeTail(text: string): number {
  let keep = 0;
  let keepUnits = 0;
  for (const held of prefixes) {
    for (let size = held.length; size > keep; size -= 1) {
      const prefix = held[size - 1] as string;
      if (text.endsWith(prefix)) {
        keep = size;
        keepUnits = prefix.length;
        break;
      }
    }
  }
  return keepUnits;
}

export type TextSink = { write(text: string): void; flush(): void };

export class RedactingStream {
  private pending = "";

  constructor(private readonly sink: TextSink) {}

  write(text: string): number {
    const cleaned = redact(this.pending + text);
    const keep = unsafeTail(cleaned);
    const ready = keep ? cleaned.slice(0, cleaned.length - keep) : cleaned;
    this.pending = keep ? cleaned.slice(cleaned.length - keep) : "";
    if (ready) this.sink.write(ready);
    return codePoints(text).length;
  }

  drain(): void {
    if (this.pending) {
      const pending = this.pending;
      this.pending = "";
      this.sink.write(redact(pending));
    }
    this.sink.flush();
  }

  flush(): void {
    this.drain();
  }
}
