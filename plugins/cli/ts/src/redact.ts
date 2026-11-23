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
  if (trimmed === "") return false;
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
  const held = longestFirst.some((secret) => value.includes(secret));
  if (!held && !value.includes("\\")) return raw;
  const embedded = /^\s*[{["]/u.test(value) && parsesAsJson(value);
  if (!held && !embedded) return raw;
  const masked = embedded ? maskedDocument(value, longestFirst) : replaceSecrets(value, longestFirst);
  if (masked === value) return raw;
  return encodedLike(raw, masked);
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

function widened(text: string, nodes: readonly JsonNode[], longestFirst: readonly string[]): string | null {
  const matches: [number, number][] = [];
  for (const secret of longestFirst) {
    for (let at = text.indexOf(secret); at >= 0; at = text.indexOf(secret, at + 1)) matches.push([at, at + secret.length]);
  }
  matches.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  const open: number[] = [];
  const targets: number[] = [];
  let next = 0;
  for (const [at, end] of matches) {
    while (next < nodes.length && (nodes[next] as JsonNode).start <= at) {
      while (open.length && (nodes[open[open.length - 1] as number] as JsonNode).end <= (nodes[next] as JsonNode).start) open.pop();
      open.push(next);
      next += 1;
    }
    while (open.length && (nodes[open[open.length - 1] as number] as JsonNode).end <= at) open.pop();
    const inner = open.length ? (nodes[open[open.length - 1] as number] as JsonNode) : undefined;
    if (inner && inner.kind === Kind.Keyword && end <= inner.end) continue;
    if (inner && inner.kind === Kind.Text && inner.start < at && end < inner.end) continue;
    let depth = open.length - 1;
    while (depth >= 0 && (nodes[open[depth] as number] as JsonNode).end < end) depth -= 1;
    if (depth < 0) return null;
    targets.push(open[depth] as number);
  }
  if (targets.length === 0) return text;
  const spans = [...new Set(targets)].map((index) => nodes[index] as JsonNode).sort((x, y) => x.start - y.start || y.end - x.end);
  let out = "";
  let copied = 0;
  for (const node of spans) {
    if (node.start < copied) continue;
    out += text.slice(copied, node.start) + QUOTED_MASK;
    copied = node.end;
  }
  return out + text.slice(copied);
}

function maskedDocument(whole: string, longestFirst: readonly string[]): string {
  const lead = whole.length - whole.trimStart().length;
  const core = whole.trim();
  const before = whole.slice(0, lead);
  const after = whole.slice(lead + core.length);
  const out = before + maskedCore(core, longestFirst) + after;
  const straddles = longestFirst.some((secret) => {
    for (let at = out.indexOf(secret); at >= 0; at = out.indexOf(secret, at + 1)) {
      const end = at + secret.length;
      const coreEnd = out.length - after.length;
      if ((at < before.length && end > before.length) || (at < coreEnd && end > coreEnd)) return true;
    }
    return false;
  });
  if (!straddles) return out;
  return /^[{["]/u.test(core) ? before + QUOTED_MASK + after : replaceSecrets(whole, longestFirst);
}

function maskedCore(text: string, longestFirst: readonly string[]): string {
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
  return !text.includes("\\u") && longestFirst.every((secret) => PLAIN_SECRET.test(secret) && !text.includes(secret));
}

function maskedLine(line: string, longestFirst: readonly string[]): string {
  return parsesAsJson(line) ? maskedDocument(line, longestFirst) : replaceSecrets(line, longestFirst);
}

function lineEnd(text: string, at: number): number {
  const newline = text.indexOf("\n", at);
  return newline < 0 ? text.length : newline + 1;
}

function maskedHitLines(text: string, longestFirst: readonly string[]): string {
  const escaped = text.includes("\\u");
  const ends = new Map<number, number>();
  let start = 0;
  while (start < text.length) {
    const end = lineEnd(text, start);
    const line = text.slice(start, end);
    if (longestFirst.some((secret) => line.includes(secret)) || (escaped && line.includes("\\u"))) ends.set(start, end);
    start = end;
  }
  let out = "";
  let copied = 0;
  for (const [first, end] of ends) {
    out += text.slice(copied, first) + maskedLine(text.slice(first, end), longestFirst);
    copied = end;
  }
  return out + text.slice(copied);
}

function maskedPlain(block: string, longestFirst: readonly string[]): string {
  const end = block.endsWith("\n") ? block.length - 1 : block.length;
  return replaceSecrets(block.slice(0, end), longestFirst) + block.slice(end);
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
    out += maskedPlain(plain, longestFirst) + maskedDocument(line, longestFirst);
    plain = "";
  }
  out += maskedPlain(plain, longestFirst);
  return maskedAcrossLines(out, longestFirst);
}

function maskedLineText(line: string): string {
  const body = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (body.trim() === "" || body === MASK || body === QUOTED_MASK) return line;
  return (parsesAsJson(body) ? QUOTED_MASK : MASK) + line.slice(body.length);
}

function lineIndex(starts: readonly number[], at: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] as number) <= at) low = middle;
    else high = middle - 1;
  }
  return low;
}

function maskedAcrossLines(text: string, longestFirst: readonly string[]): string {
  const spanning = longestFirst.filter((secret) => secret.includes("\n") && secret.trim() !== "");
  let out = text;
  for (let pass = 0; spanning.length > 0; pass += 1) {
    const lines = out.split("\n");
    if (pass > lines.length) return out;
    const starts: number[] = [];
    let offset = 0;
    for (const line of lines) {
      starts.push(offset);
      offset += line.length + 1;
    }
    const done = lines.map((line) => maskedLineText(line) === line);
    const marked = new Uint8Array(lines.length);
    let fresh = false;
    for (const secret of spanning) {
      for (let at = out.indexOf(secret); at >= 0; at = out.indexOf(secret, at + 1)) {
        const first = lineIndex(starts, at);
        const last = lineIndex(starts, at + secret.length - 1);
        for (let line = first; line <= last; line += 1) {
          if (done[line] || marked[line]) continue;
          marked[line] = 1;
          fresh = true;
        }
      }
    }
    if (!fresh) return out;
    out = lines.map((line, index) => (marked[index] ? maskedLineText(line) : line)).join("\n");
  }
  return out;
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
