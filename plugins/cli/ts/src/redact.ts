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

const QUOTED_MASK = `"${MASK}"`;
const MAX_WIDENINGS = 16;
const PLAIN_SECRET = /^[A-Za-z0-9 !#$%'()*+,\-.:;=?@[\]^_`{|}~]*$/u;
const REENCODED = /[\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

const Kind = { Container: 0, Text: 1, Number: 2, Keyword: 3 } as const;
type Kind = (typeof Kind)[keyof typeof Kind];

type JsonNode = { start: number; end: number; parent: number; kind: Kind };

function tokens(text: string): JsonNode[] | null {
  const nodes: JsonNode[] = [];
  const open: number[] = [];
  let at = 0;
  while (at < text.length) {
    const unit = text[at] as string;
    const parent = open.length ? (open[open.length - 1] as number) : -1;
    if (unit === " " || unit === "\t" || unit === "\n" || unit === "\r" || unit === "," || unit === ":") {
      at += 1;
    } else if (unit === "{" || unit === "[") {
      nodes.push({ start: at, end: -1, parent, kind: Kind.Container });
      open.push(nodes.length - 1);
      at += 1;
    } else if (unit === "}" || unit === "]") {
      const closed = open.pop();
      if (closed === undefined) return null;
      (nodes[closed] as JsonNode).end = at + 1;
      at += 1;
    } else if (unit === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      if (end >= text.length) return null;
      nodes.push({ start: at, end: end + 1, parent, kind: Kind.Text });
      at = end + 1;
    } else {
      let end = at;
      while (end < text.length && /[-+.0-9a-zA-Z]/u.test(text[end] as string)) end += 1;
      if (end === at) return null;
      nodes.push({ start: at, end, parent, kind: /[-0-9]/u.test(unit) ? Kind.Number : Kind.Keyword });
      at = end;
    }
  }
  return open.length ? null : nodes;
}

function unicodeEscape(unit: string): string {
  return `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

function encodedLike(raw: string, value: string): string {
  const encoded = JSON.stringify(value);
  return /^[\x00-\x7f]*$/u.test(raw) ? encoded.replaceAll(/[^\x00-\x7e]/g, unicodeEscape) : encoded.replaceAll(REENCODED, unicodeEscape);
}

function decoded(raw: string): string {
  return raw.includes("\\") ? (JSON.parse(raw) as string) : raw.slice(1, -1);
}

function maskedString(raw: string, longestFirst: readonly string[]): string {
  const value = decoded(raw);
  if (!longestFirst.some((secret) => value.includes(secret))) return raw;
  const masked = parsesAsJson(value) ? maskedDocument(value, longestFirst) : replaceSecrets(value, longestFirst);
  return encodedLike(raw, masked === QUOTED_MASK ? MASK : masked);
}

function maskedLeaves(text: string, nodes: readonly JsonNode[], longestFirst: readonly string[]): string {
  let out = "";
  let copied = 0;
  for (const node of nodes) {
    if (node.kind === Kind.Container || node.kind === Kind.Keyword) continue;
    const raw = text.slice(node.start, node.end);
    const masked = node.kind === Kind.Text ? maskedString(raw, longestFirst) : longestFirst.some((secret) => raw.includes(secret)) ? QUOTED_MASK : raw;
    if (masked === raw) continue;
    out += text.slice(copied, node.start) + masked;
    copied = node.end;
  }
  return out + text.slice(copied);
}

function lastStartingBy(nodes: readonly JsonNode[], at: number): number {
  let low = 0;
  let high = nodes.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((nodes[middle] as JsonNode).start <= at) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

function widened(text: string, nodes: readonly JsonNode[], longestFirst: readonly string[]): string | null {
  const targets = new Set<number>();
  for (const secret of longestFirst) {
    for (let at = text.indexOf(secret); at >= 0; at = text.indexOf(secret, at + 1)) {
      const end = at + secret.length;
      let index = lastStartingBy(nodes, at);
      const leaf = nodes[index];
      if (leaf && leaf.kind !== Kind.Container && leaf.start <= at && end <= leaf.end) continue;
      while (index >= 0 && !((nodes[index] as JsonNode).start <= at && end <= (nodes[index] as JsonNode).end)) index = (nodes[index] as JsonNode).parent;
      if (index < 0) return null;
      targets.add(index);
    }
  }
  if (targets.size === 0) return text;
  const outermost = [...targets].filter((index) => {
    for (let up = (nodes[index] as JsonNode).parent; up >= 0; up = (nodes[up] as JsonNode).parent) if (targets.has(up)) return false;
    return true;
  });
  outermost.sort((a, b) => (nodes[a] as JsonNode).start - (nodes[b] as JsonNode).start);
  let out = "";
  let copied = 0;
  for (const index of outermost) {
    const node = nodes[index] as JsonNode;
    out += text.slice(copied, node.start) + QUOTED_MASK;
    copied = node.end;
  }
  return out + text.slice(copied);
}

function maskedDocument(text: string, longestFirst: readonly string[]): string {
  const nodes = tokens(text);
  if (nodes === null) return replaceSecrets(text, longestFirst);
  let out = maskedLeaves(text, nodes, longestFirst);
  for (let round = 0; round < MAX_WIDENINGS; round += 1) {
    if (!longestFirst.some((secret) => out.includes(secret))) return out;
    const current = tokens(out);
    const next = current === null ? null : widened(out, current, longestFirst);
    if (next === null) return QUOTED_MASK;
    if (next === out) return out;
    out = next;
  }
  return QUOTED_MASK;
}

function untouched(text: string, longestFirst: readonly string[]): boolean {
  return longestFirst.every((secret) => PLAIN_SECRET.test(secret) && !text.includes(secret));
}

function maskedLine(line: string, longestFirst: readonly string[]): string {
  return parsesAsJson(line) ? maskedDocument(line, longestFirst) : replaceSecrets(line, longestFirst);
}

function maskedHitLines(text: string, longestFirst: readonly string[]): string {
  const starts = new Set<number>();
  for (const secret of longestFirst) {
    for (let at = text.indexOf(secret); at >= 0; at = text.indexOf(secret, at + secret.length)) starts.add(text.lastIndexOf("\n", at - 1) + 1);
  }
  let out = "";
  let copied = 0;
  for (const start of [...starts].sort((a, b) => a - b)) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline + 1;
    out += text.slice(copied, start) + maskedLine(text.slice(start, end), longestFirst);
    copied = end;
  }
  return out + text.slice(copied);
}

function maskSecrets(text: string, longestFirst: readonly string[]): string {
  if (longestFirst.length === 0 || untouched(text, longestFirst)) return text;
  if (parsesAsJson(text)) return maskedDocument(text, longestFirst);
  if (!text.includes("\n")) return replaceSecrets(text, longestFirst);
  if (longestFirst.every((secret) => PLAIN_SECRET.test(secret))) return maskedHitLines(text, longestFirst);
  let out = "";
  let plain = "";
  for (const line of text.split(/(?<=\n)/u)) {
    if (untouched(line, longestFirst) || !parsesAsJson(line)) {
      plain += line;
      continue;
    }
    out += replaceSecrets(plain, longestFirst) + maskedDocument(line, longestFirst);
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
