import { dumps, Float, type JsonObject, type Value } from "./json.ts";
import { codePoints } from "./pystr.ts";

const PY_INT_MAX_STR_DIGITS = 4300;
const JSON_SPACE = new Set([" ", "\t", "\n", "\r"]);
const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
export const PY_JSON_RECURSION_LIMIT = 9994;

export class DecodeError extends Error {}

export class Refused extends Error {}

export class TooDeepToJudge extends Error {}

export type Strictness = { what: string } | undefined;

class Stop {
  constructor(readonly at: number) {}
}

const isDigit = (ch: string | undefined) => ch !== undefined && ch >= "0" && ch <= "9";

function hexValue(ch: string | undefined): number | undefined {
  if (ch === undefined || !/^[0-9a-fA-F]$/.test(ch)) return undefined;
  return Number.parseInt(ch, 16);
}

function digitLimitMessage(count: number): string {
  return `Exceeds the limit (${PY_INT_MAX_STR_DIGITS} digits) for integer string conversion: value has ${count} digits; use sys.set_int_max_str_digits() to increase the limit`;
}

class Decoder {
  private depth = 0;

  constructor(
    private readonly cp: string[],
    private readonly strict: Strictness,
    private readonly recursionLimit: number,
  ) {}

  private fail(message: string, at: number): never {
    const before = this.cp.slice(0, at);
    const line = before.filter((ch) => ch === "\n").length + 1;
    const column = at - before.lastIndexOf("\n");
    throw new DecodeError(`${message}: line ${line} column ${column} (char ${at})`);
  }

  space(at: number): number {
    while (at < this.cp.length && JSON_SPACE.has(this.cp[at] as string)) at += 1;
    return at;
  }

  private word(at: number, word: string): boolean {
    return this.cp.slice(at, at + word.length).join("") === word;
  }

  private refuse(message: string): never {
    throw new Refused(`${this.strict?.what} ${message}`);
  }

  private constant(name: string): Value {
    if (this.strict !== undefined) this.refuse(`has ${name}, which isn't JSON`);
    if (name === "NaN") return new Float(Number.NaN);
    return new Float(name === "Infinity" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
  }

  value(at: number): [Value, number] {
    const ch = this.cp[at];
    if (ch === undefined) throw new Stop(at);
    if (ch === '"') return this.string(at + 1);
    if (ch === "{" || ch === "[") {
      this.depth += 1;
      if (this.depth > this.recursionLimit) {
        if (this.strict !== undefined) this.refuse(`is nested deeper than 64 levels`);
        throw new DecodeError("maximum recursion depth exceeded while decoding a JSON array from a unicode string");
      }
      const found = ch === "{" ? this.object(at + 1) : this.array(at + 1);
      this.depth -= 1;
      return found;
    }
    if (ch === "n" && this.word(at, "null")) return [null, at + 4];
    if (ch === "t" && this.word(at, "true")) return [true, at + 4];
    if (ch === "f" && this.word(at, "false")) return [false, at + 5];
    if (ch === "N" && this.word(at, "NaN")) return [this.constant("NaN"), at + 3];
    if (ch === "I" && this.word(at, "Infinity")) return [this.constant("Infinity"), at + 8];
    if (ch === "-" && this.word(at, "-Infinity")) return [this.constant("-Infinity"), at + 9];
    return this.number(at);
  }

  private number(start: number): [Value, number] {
    const cp = this.cp;
    let at = start;
    if (cp[at] === "-") at += 1;
    if (isDigit(cp[at]) && cp[at] !== "0") while (isDigit(cp[at])) at += 1;
    else if (cp[at] === "0") at += 1;
    else throw new Stop(start);
    let float = false;
    if (cp[at] === "." && isDigit(cp[at + 1])) {
      float = true;
      at += 2;
      while (isDigit(cp[at])) at += 1;
    }
    if (cp[at] === "e" || cp[at] === "E") {
      const mark = at;
      at += 1;
      if (cp[at] === "-" || cp[at] === "+") at += 1;
      const digits = at;
      while (isDigit(cp[at])) at += 1;
      if (at > digits) float = true;
      else at = mark;
    }
    const literal = cp.slice(start, at).join("");
    return [float ? this.floatOf(literal) : this.intOf(literal), at];
  }

  private floatOf(literal: string): Value {
    const value = Number(literal);
    if (this.strict !== undefined && !Number.isFinite(value)) this.refuse(`has the number ${literal.slice(0, 24)}, which is too large for JSON`);
    return new Float(value);
  }

  private intOf(literal: string): Value {
    const count = literal.length - (literal.startsWith("-") ? 1 : 0);
    if (count > PY_INT_MAX_STR_DIGITS) throw new DecodeError(digitLimitMessage(count));
    const value = BigInt(literal);
    if (this.strict !== undefined && !Number.isFinite(Number(value))) this.refuse(`has the number ${literal.slice(0, 24)}…, which is too large for JSON`);
    return value;
  }

  private quad(at: number): number | undefined {
    let unit = 0;
    for (let index = at; index < at + 4; index += 1) {
      const digit = hexValue(this.cp[index]);
      if (digit === undefined) return undefined;
      unit = unit * 16 + digit;
    }
    return unit;
  }

  private string(start: number): [string, number] {
    const cp = this.cp;
    const begin = start - 1;
    const parts: string[] = [];
    let end = start;
    for (;;) {
      let next = end;
      let ch: string | undefined;
      for (; next < cp.length; next += 1) {
        ch = cp[next] as string;
        if (ch === '"' || ch === "\\") break;
        if (ch.length === 1 && ch.charCodeAt(0) <= 0x1f) this.fail("Invalid control character at", next);
      }
      if (next >= cp.length) this.fail("Unterminated string starting at", begin);
      parts.push(cp.slice(end, next).join(""));
      next += 1;
      if (ch === '"') return [parts.join(""), next];
      if (next === cp.length) this.fail("Unterminated string starting at", begin);
      const escape = cp[next] as string;
      if (escape !== "u") {
        end = next + 1;
        const simple = SIMPLE_ESCAPES[escape];
        if (simple === undefined) this.fail("Invalid \\escape", end - 2);
        parts.push(simple);
        continue;
      }
      next += 1;
      end = next + 4;
      if (end > cp.length) this.fail("Invalid \\uXXXX escape", next - 1);
      const unit = this.quad(next);
      if (unit === undefined) this.fail("Invalid \\uXXXX escape", end - 5);
      let point = unit;
      if (unit >= 0xd800 && unit < 0xdc00 && end + 6 < cp.length && cp[end] === "\\" && cp[end + 1] === "u") {
        const low = this.quad(end + 2);
        if (low === undefined) this.fail("Invalid \\uXXXX escape", end + 1);
        if (low >= 0xdc00 && low < 0xe000) {
          point = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
          end += 6;
        }
      }
      parts.push(String.fromCodePoint(point));
    }
  }

  private object(start: number): [Value, number] {
    const pairs: [string, Value][] = [];
    let at = this.space(start);
    if (this.cp[at] !== "}") {
      for (;;) {
        if (this.cp[at] !== '"') this.fail("Expecting property name enclosed in double quotes", at);
        const [key, afterKey] = this.string(at + 1);
        at = this.space(afterKey);
        if (this.cp[at] !== ":") this.fail("Expecting ':' delimiter", at);
        const [item, afterValue] = this.value(this.space(at + 1));
        pairs.push([key, item]);
        at = this.space(afterValue);
        if (this.cp[at] === "}") break;
        if (this.cp[at] !== ",") this.fail("Expecting ',' delimiter", at);
        const comma = at;
        at = this.space(at + 1);
        if (this.cp[at] === "}") this.fail("Illegal trailing comma before end of object", comma);
      }
    }
    const found: JsonObject = new Map();
    for (const [key, item] of pairs) {
      if (this.strict !== undefined && found.has(key)) this.refuse(`has the key ${dumps(key, "compact", true)} twice`);
      found.set(key, item);
    }
    return [found, at + 1];
  }

  private array(start: number): [Value, number] {
    const items: Value[] = [];
    let at = this.space(start);
    if (this.cp[at] === "]") return [items, at + 1];
    for (;;) {
      const [item, after] = this.value(at);
      items.push(item);
      at = this.space(after);
      if (this.cp[at] === "]") return [items, at + 1];
      if (this.cp[at] !== ",") this.fail("Expecting ',' delimiter", at);
      const comma = at;
      at = this.space(at + 1);
      if (this.cp[at] === "]") this.fail("Illegal trailing comma before end of array", comma);
    }
  }

  decode(): Value {
    if (this.cp[0] === "﻿") this.fail("Unexpected UTF-8 BOM (decode using utf-8-sig)", 0);
    const start = this.space(0);
    let found: [Value, number];
    try {
      found = this.value(start);
    } catch (error) {
      if (error instanceof Stop) this.fail("Expecting value", error.at);
      throw error;
    }
    const end = this.space(found[1]);
    if (end !== this.cp.length) this.fail("Extra data", end);
    return found[0];
  }
}

export function loads(text: string, strict: Strictness = undefined, recursionLimit = PY_JSON_RECURSION_LIMIT): Value {
  const decoder = new Decoder(codePoints(text), strict, recursionLimit);
  try {
    return decoder.decode();
  } catch (error) {
    if (error instanceof Stop) throw new DecodeError(`Expecting value: line 1 column ${error.at + 1} (char ${error.at})`);
    if (error instanceof RangeError) throw new TooDeepToJudge();
    throw error;
  }
}

function utf8Need(lead: number): [number, number, number] {
  if (lead >= 0xc2 && lead <= 0xdf) return [1, 0x80, 0xbf];
  if (lead === 0xe0) return [2, 0xa0, 0xbf];
  if (lead === 0xed) return [2, 0x80, 0x9f];
  if (lead >= 0xe1 && lead <= 0xef) return [2, 0x80, 0xbf];
  if (lead === 0xf0) return [3, 0x90, 0xbf];
  if (lead === 0xf4) return [3, 0x80, 0x8f];
  if (lead >= 0xf1 && lead <= 0xf3) return [3, 0x80, 0xbf];
  return [0, 0, 0];
}

export type Utf8Failure = { start: number; end: number; reason: string };

export function utf8Failure(bytes: Uint8Array): Utf8Failure | undefined {
  for (let at = 0; at < bytes.length; ) {
    const lead = bytes[at] as number;
    if (lead < 0x80) {
      at += 1;
      continue;
    }
    const [more, low, high] = utf8Need(lead);
    if (more === 0) return { start: at, end: at + 1, reason: "invalid start byte" };
    for (let index = 1; index <= more; index += 1) {
      const byte = bytes[at + index];
      const [min, max] = index === 1 ? [low, high] : [0x80, 0xbf];
      if (byte === undefined) return { start: at, end: bytes.length, reason: "unexpected end of data" };
      if (byte < min || byte > max) return { start: at, end: at + index, reason: "invalid continuation byte" };
    }
    at += more + 1;
  }
  return undefined;
}

export function utf8DecodeMessage(bytes: Uint8Array, failure: Utf8Failure): string {
  const lead = bytes[failure.start] as number;
  const where =
    failure.end - failure.start === 1
      ? `byte 0x${lead.toString(16).padStart(2, "0")} in position ${failure.start}`
      : `bytes in position ${failure.start}-${failure.end - 1}`;
  return `'utf-8' codec can't decode ${where}: ${failure.reason}`;
}
