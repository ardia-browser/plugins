import { Float, type JsonObject, type Value } from "../json.ts";

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const INT_MAX_STR_DIGITS = 4300;
const DEPTH_LIMIT = 900;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

export class JsonDecodeError extends Error {
  constructor(
    readonly msg: string,
    readonly pos: number,
    readonly lineno: number,
    readonly colno: number,
  ) {
    super(`${msg}: line ${lineno} column ${colno} (char ${pos})`);
  }
}

export class JsonValueError extends Error {}

export class JsonTooDeep extends Error {}

export type LoadOptions = { parseConstant?: (token: string) => Value; parseFloat?: (token: string) => Value };

class Stop {
  constructor(readonly at: number) {}
}

function located(points: readonly string[], msg: string, pos: number): JsonDecodeError {
  let line = 1;
  let lastNewline = -1;
  for (let at = 0; at < pos && at < points.length; at += 1) {
    if (points[at] === "\n") {
      line += 1;
      lastNewline = at;
    }
  }
  return new JsonDecodeError(msg, pos, line, pos - lastNewline);
}

function codePointsOf(text: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);
    if (unit >= 0xd800 && unit < 0xdc00 && at + 1 < text.length) {
      const next = text.charCodeAt(at + 1);
      if (next >= 0xdc00 && next < 0xe000) {
        out.push(text.slice(at, at + 2));
        at += 1;
        continue;
      }
    }
    out.push(text[at] as string);
  }
  return out;
}

function hexValue(points: readonly string[], from: number): number | undefined {
  let value = 0;
  for (let at = from; at < from + 4; at += 1) {
    const ch = points[at] ?? "";
    if (!/^[0-9a-fA-F]$/.test(ch)) return undefined;
    value = value * 16 + Number.parseInt(ch, 16);
  }
  return value;
}

class Scanner {
  depth = 0;
  constructor(
    readonly cp: readonly string[],
    readonly options: LoadOptions,
  ) {}

  fail(msg: string, at: number): never {
    throw located(this.cp, msg, at);
  }

  skip(at: number): number {
    while (at < this.cp.length && WHITESPACE.has((this.cp[at] as string).charCodeAt(0))) at += 1;
    return at;
  }

  matches(at: number, word: string): boolean {
    for (let index = 0; index < word.length; index += 1) if (this.cp[at + index] !== word[index]) return false;
    return true;
  }

  value(at: number): [Value, number] {
    const ch = this.cp[at];
    if (ch === undefined) throw new Stop(at);
    if (ch === '"') return this.string(at + 1);
    if (ch === "{") return this.nested(() => this.object(at + 1));
    if (ch === "[") return this.nested(() => this.array(at + 1));
    if (ch === "n" && this.matches(at, "null")) return [null, at + 4];
    if (ch === "t" && this.matches(at, "true")) return [true, at + 4];
    if (ch === "f" && this.matches(at, "false")) return [false, at + 5];
    if (ch === "N" && this.matches(at, "NaN")) return [this.constant("NaN"), at + 3];
    if (ch === "I" && this.matches(at, "Infinity")) return [this.constant("Infinity"), at + 8];
    if (ch === "-" && this.matches(at, "-Infinity")) return [this.constant("-Infinity"), at + 9];
    return this.number(at);
  }

  nested(run: () => [Value, number]): [Value, number] {
    this.depth += 1;
    if (this.depth > DEPTH_LIMIT) throw new JsonTooDeep();
    try {
      return run();
    } finally {
      this.depth -= 1;
    }
  }

  constant(token: string): Value {
    if (this.options.parseConstant) return this.options.parseConstant(token);
    return new Float(token === "NaN" ? Number.NaN : token === "Infinity" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
  }

  digit(at: number): boolean {
    const ch = this.cp[at];
    return ch !== undefined && ch >= "0" && ch <= "9";
  }

  number(start: number): [Value, number] {
    let at = start;
    if (this.cp[at] === "-") at += 1;
    if (this.cp[at] === "0") at += 1;
    else if (this.digit(at) && this.cp[at] !== "0") {
      while (this.digit(at)) at += 1;
    } else throw new Stop(start);
    let float = false;
    if (this.cp[at] === "." && this.digit(at + 1)) {
      float = true;
      at += 1;
      while (this.digit(at)) at += 1;
    }
    if (this.cp[at] === "e" || this.cp[at] === "E") {
      let probe = at + 1;
      if (this.cp[probe] === "+" || this.cp[probe] === "-") probe += 1;
      if (this.digit(probe)) {
        float = true;
        at = probe;
        while (this.digit(at)) at += 1;
      }
    }
    const text = this.cp.slice(start, at).join("");
    if (float) return [this.options.parseFloat ? this.options.parseFloat(text) : new Float(Number(text)), at];
    const digits = text.replace(/^-/, "").length;
    if (digits > INT_MAX_STR_DIGITS) {
      throw new JsonValueError(`Exceeds the limit (${INT_MAX_STR_DIGITS} digits) for integer string conversion: value has ${digits} digits; use sys.set_int_max_str_digits() to increase the limit`);
    }
    return [BigInt(text), at];
  }

  string(end: number): [string, number] {
    const begin = end - 1;
    const parts: string[] = [];
    for (;;) {
      let next = end;
      let ch = "";
      for (; next < this.cp.length; next += 1) {
        ch = this.cp[next] as string;
        if (ch === '"' || ch === "\\") break;
        if (ch.charCodeAt(0) <= 0x1f) this.fail("Invalid control character at", next);
      }
      if (!(ch === '"' || ch === "\\") || next >= this.cp.length) this.fail("Unterminated string starting at", begin);
      if (next !== end) parts.push(this.cp.slice(end, next).join(""));
      next += 1;
      if (ch === '"') return [parts.join(""), next];
      if (next === this.cp.length) this.fail("Unterminated string starting at", begin);
      const escape = this.cp[next] as string;
      if (escape !== "u") {
        end = next + 1;
        const simple = ESCAPES[escape];
        if (simple === undefined) this.fail("Invalid \\escape", end - 2);
        parts.push(simple);
        continue;
      }
      const u = next;
      if (u + 5 > this.cp.length) this.fail("Invalid \\uXXXX escape", u);
      const unit = hexValue(this.cp, u + 1);
      if (unit === undefined) this.fail("Invalid \\uXXXX escape", u);
      end = u + 5;
      if (unit >= 0xd800 && unit < 0xdc00 && end + 6 < this.cp.length &&this.cp[end] === "\\" && this.cp[end + 1] === "u") {
        const second = hexValue(this.cp, end + 2);
        if (second === undefined) this.fail("Invalid \\uXXXX escape", end + 1);
        if (second >= 0xdc00 && second < 0xe000) {
          parts.push(String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + (second - 0xdc00)));
          end += 6;
          continue;
        }
      }
      parts.push(String.fromCharCode(unit));
    }
  }

  object(start: number): [JsonObject, number] {
    const map: JsonObject = new Map();
    let at = this.skip(start);
    if (this.cp[at] === "}") return [map, at + 1];
    for (;;) {
      if (this.cp[at] !== '"') this.fail("Expecting property name enclosed in double quotes", at);
      const [key, afterKey] = this.string(at + 1);
      at = this.skip(afterKey);
      if (this.cp[at] !== ":") this.fail("Expecting ':' delimiter", at);
      at = this.skip(at + 1);
      let item: Value;
      try {
        [item, at] = this.value(at);
      } catch (error) {
        if (error instanceof Stop) this.fail("Expecting value", error.at);
        throw error;
      }
      map.set(key, item);
      at = this.skip(at);
      if (this.cp[at] === "}") return [map, at + 1];
      if (this.cp[at] !== ",") this.fail("Expecting ',' delimiter", at);
      const comma = at;
      at = this.skip(at + 1);
      if (this.cp[at] === "}") this.fail("Illegal trailing comma before end of object", comma);
    }
  }

  array(start: number): [Value[], number] {
    const items: Value[] = [];
    let at = this.skip(start);
    if (this.cp[at] === "]") return [items, at + 1];
    for (;;) {
      let item: Value;
      try {
        [item, at] = this.value(at);
      } catch (error) {
        if (error instanceof Stop) this.fail("Expecting value", error.at);
        throw error;
      }
      items.push(item);
      at = this.skip(at);
      if (this.cp[at] === "]") return [items, at + 1];
      if (this.cp[at] !== ",") this.fail("Expecting ',' delimiter", at);
      const comma = at;
      at = this.skip(at + 1);
      if (this.cp[at] === "]") this.fail("Illegal trailing comma before end of array", comma);
    }
  }
}

export function loads(text: string, options: LoadOptions = {}): Value {
  const cp = codePointsOf(text);
  if (cp[0] === "﻿") throw located(cp, "Unexpected UTF-8 BOM (decode using utf-8-sig)", 0);
  const scanner = new Scanner(cp, options);
  const start = scanner.skip(0);
  let value: Value;
  let end: number;
  try {
    [value, end] = scanner.value(start);
  } catch (error) {
    if (error instanceof Stop) throw located(cp, "Expecting value", error.at);
    throw error;
  }
  end = scanner.skip(end);
  if (end !== cp.length) throw located(cp, "Extra data", end);
  return value;
}

export function noConstants(token: string): Value {
  throw new JsonValueError(`${token} isn't valid JSON`);
}

export function finiteFloat(token: string): Value {
  const value = Number(token);
  if (value === Number.POSITIVE_INFINITY || value === Number.NEGATIVE_INFINITY) throw new JsonValueError(`${token} is too large a number`);
  return new Float(value);
}

export function parseConfigJson(text: string): Value {
  return loads(text, { parseConstant: noConstants, parseFloat: finiteFloat });
}
