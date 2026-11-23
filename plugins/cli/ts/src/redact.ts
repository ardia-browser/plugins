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
  return percentEncoded(text);
}

function percentEncoded(text: string): string {
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

function replaceSecrets(text: string, longestFirst: readonly string[]): string {
  let out = text;
  for (const secret of longestFirst) if (out.includes(secret)) out = out.replaceAll(secret, MASK);
  return out;
}

function parsesAsJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "" || !'{["'.includes(trimmed[0] as string)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

const SHORT_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
const KEYWORDS = /true|false|null/g;
const REENCODED = /[\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

function decodedLiteral(raw: string): { value: string; starts: number[] } {
  let value = "";
  const starts: number[] = [];
  let at = 1;
  while (at < raw.length - 1) {
    starts.push(at);
    if (raw[at] === "\\") {
      const kind = raw[at + 1] as string;
      if (kind === "u") {
        value += String.fromCharCode(Number.parseInt(raw.slice(at + 2, at + 6), 16));
        at += 6;
      } else {
        value += SHORT_ESCAPES[kind] ?? kind;
        at += 2;
      }
    } else {
      value += raw[at];
      at += 1;
    }
  }
  starts.push(raw.length - 1);
  return { value, starts };
}

function secretSpans(value: string, longestFirst: readonly string[]): [number, number][] {
  const covered = new Uint8Array(value.length);
  const spans: [number, number][] = [];
  for (const secret of longestFirst) {
    let at = value.indexOf(secret);
    while (at >= 0) {
      const end = at + secret.length;
      if (covered.subarray(at, end).includes(1)) {
        at = value.indexOf(secret, at + 1);
        continue;
      }
      covered.fill(1, at, end);
      spans.push([at, end]);
      at = value.indexOf(secret, end);
    }
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

function unicodeEscape(unit: string): string {
  return `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

function encodedLike(raw: string, value: string): string {
  const encoded = JSON.stringify(value);
  return /^[\x00-\x7f]*$/u.test(raw) ? encoded.replaceAll(/[^\x00-\x7e]/g, unicodeEscape) : encoded.replaceAll(REENCODED, unicodeEscape);
}

function spansMasked(raw: string, value: string, starts: number[], longestFirst: readonly string[]): string {
  const spans = secretSpans(value, longestFirst);
  if (spans.length === 0) return raw;
  let out = "";
  let copied = 0;
  for (const [start, end] of spans) {
    out += raw.slice(copied, starts[start]) + MASK;
    copied = starts[end] as number;
  }
  return out + raw.slice(copied);
}

function maskedLiteral(raw: string, longestFirst: readonly string[]): string {
  const { value, starts } = decodedLiteral(raw);
  if (parsesAsJson(value)) {
    const inner = maskedDocument(value, longestFirst);
    if (inner !== null) return inner === value ? raw : encodedLike(raw, inner);
  }
  return spansMasked(raw, value, starts, longestFirst);
}

function maskedNumbers(run: string, longestFirst: readonly string[]): string {
  return run.replaceAll(NUMBER, (number) => (longestFirst.some((secret) => number.includes(secret)) ? `"${MASK}"` : number));
}

function stringEnd(text: string, at: number): number {
  let end = at + 1;
  while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
  return end;
}

function maskedDocument(text: string, longestFirst: readonly string[]): string | null {
  let out = "";
  let skeleton = "";
  let copied = 0;
  for (let at = text.indexOf('"'); at >= 0; at = text.indexOf('"', at)) {
    const end = stringEnd(text, at);
    if (end >= text.length) return null;
    const run = maskedNumbers(text.slice(copied, at), longestFirst);
    out += run + maskedLiteral(text.slice(at, end + 1), longestFirst);
    skeleton += `${run}""`;
    copied = end + 1;
    at = end + 1;
  }
  const tail = maskedNumbers(text.slice(copied), longestFirst);
  out += tail;
  skeleton = (skeleton + tail).replaceAll(KEYWORDS, " ").replaceAll(`"${MASK}"`, " ");
  return longestFirst.some((secret) => skeleton.includes(secret)) ? null : out;
}

function maskedJson(text: string, longestFirst: readonly string[]): string {
  return maskedDocument(text, longestFirst) ?? replaceSecrets(text, longestFirst);
}

function maskSecrets(text: string, longestFirst: readonly string[]): string {
  if (longestFirst.length === 0) return text;
  if (!text.includes("\\") && !longestFirst.some((secret) => text.includes(secret))) return text;
  if (parsesAsJson(text)) return maskedJson(text, longestFirst);
  if (!text.includes("\n")) return replaceSecrets(text, longestFirst);
  let out = "";
  let plain = "";
  for (const line of text.split(/(?<=\n)/u)) {
    if (!parsesAsJson(line)) {
      plain += line;
      continue;
    }
    out += replaceSecrets(plain, longestFirst) + maskedJson(line, longestFirst);
    plain = "";
  }
  out += replaceSecrets(plain, longestFirst);
  return longestFirst.some((secret) => secret.includes("\n") && out.includes(secret)) ? replaceSecrets(text, longestFirst) : out;
}

export function redact(text: string): string {
  return maskTokenQueries(maskSecrets(text, ordered));
}

export class Secrets {
  private readonly held: string[] = [];

  known(): boolean {
    return this.held.length > 0;
  }

  add(secret: string): void {
    if (secret === "") return;
    for (const form of [secret, percentEncoded(secret)]) if (!this.held.includes(form)) this.held.push(form);
  }

  redact(text: string): string {
    const longestFirst = [...this.held].sort((a, b) => codePoints(b).length - codePoints(a).length);
    return maskTokenQueries(maskSecrets(text, longestFirst));
  }
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
