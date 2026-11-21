import { Float, type JsonObject, type Value } from "./json.ts";
import { NeedsPython } from "./paths.ts";
import { codePoints } from "./pystr.ts";

const MAX_INT_DIGITS = 4300;
const MAX_DEPTH = 900;
const WHITESPACE = " \t\n\r";
const HEX = /^[0-9a-fA-F]{4}$/u;
const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

export class JsonDecodeError extends Error {
  constructor(
    readonly msg: string,
    readonly lineno: number,
    readonly colno: number,
    readonly pos: number,
  ) {
    super(`${msg}: line ${lineno} column ${colno} (char ${pos})`);
  }
}

export class JsonValueError extends Error {}

export type LoadOptions = { constants?: (token: string) => never; finite?: boolean };

function isDigit(point: string | undefined): boolean {
  return point !== undefined && point >= "0" && point <= "9";
}

export function isLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

class Scanner {
  private depth = 0;

  constructor(
    readonly points: readonly string[],
    readonly options: LoadOptions,
  ) {}

  fail(message: string, at: number): never {
    let line = 1;
    let lastBreak = -1;
    for (let index = 0; index < at && index < this.points.length; index += 1) {
      if (this.points[index] === "\n") {
        line += 1;
        lastBreak = index;
      }
    }
    throw new JsonDecodeError(message, line, at - lastBreak, at);
  }

  space(at: number): number {
    let index = at;
    while (index < this.points.length && WHITESPACE.includes(this.points[index] as string)) index += 1;
    return index;
  }

  word(at: number, word: string): boolean {
    for (let index = 0; index < word.length; index += 1) if (this.points[at + index] !== word[index]) return false;
    return true;
  }

  value(at: number): [Value, number] {
    const point = this.points[at];
    if (point === undefined) this.fail("Expecting value", at);
    if (point === '"') return this.string(at + 1);
    if (point === "{") return this.nested(() => this.object(at + 1));
    if (point === "[") return this.nested(() => this.array(at + 1));
    if (point === "n" && this.word(at, "null")) return [null, at + 4];
    if (point === "t" && this.word(at, "true")) return [true, at + 4];
    if (point === "f" && this.word(at, "false")) return [false, at + 5];
    if (point === "N" && this.word(at, "NaN")) return this.constant("NaN", at);
    if (point === "I" && this.word(at, "Infinity")) return this.constant("Infinity", at);
    if (point === "-" && this.word(at + 1, "Infinity")) return this.constant("-Infinity", at);
    return this.number(at);
  }

  nested<T>(run: () => T): T {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new NeedsPython("JSON nested deeper than the port handles");
    try {
      return run();
    } finally {
      this.depth -= 1;
    }
  }

  constant(name: string, at: number): [Value, number] {
    if (this.options.constants !== undefined) this.options.constants(name);
    const value = name === "NaN" ? Number.NaN : name.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    return [new Float(value), at + name.length];
  }

  number(at: number): [Value, number] {
    let index = at;
    if (this.points[index] === "-") index += 1;
    if (this.points[index] === "0") index += 1;
    else if (isDigit(this.points[index])) {
      while (isDigit(this.points[index])) index += 1;
    } else this.fail("Expecting value", at);
    let float = false;
    if (this.points[index] === "." && isDigit(this.points[index + 1])) {
      float = true;
      index += 2;
      while (isDigit(this.points[index])) index += 1;
    }
    if (this.points[index] === "e" || this.points[index] === "E") {
      let exponent = index + 1;
      if (this.points[exponent] === "+" || this.points[exponent] === "-") exponent += 1;
      if (isDigit(this.points[exponent])) {
        while (isDigit(this.points[exponent])) exponent += 1;
        float = true;
        index = exponent;
      }
    }
    const literal = this.points.slice(at, index).join("");
    if (float) {
      const parsed = Number(literal);
      if (this.options.finite && !Number.isFinite(parsed)) throw new JsonValueError(`${literal} is too large a number`);
      return [new Float(parsed), index];
    }
    const digits = literal.startsWith("-") ? literal.length - 1 : literal.length;
    if (digits > MAX_INT_DIGITS) {
      throw new JsonValueError(
        `Exceeds the limit (${MAX_INT_DIGITS} digits) for integer string conversion: value has ${digits} digits; use sys.set_int_max_str_digits() to increase the limit`,
      );
    }
    return [BigInt(literal), index];
  }

  string(at: number): [string, number] {
    const begin = at - 1;
    const out: string[] = [];
    let index = at;
    for (;;) {
      const point = this.points[index];
      if (point === undefined) this.fail("Unterminated string starting at", begin);
      if (point === '"') return [out.join(""), index + 1];
      if (point !== "\\") {
        if (point.length === 1 && point.charCodeAt(0) < 0x20) this.fail("Invalid control character at", index);
        out.push(point);
        index += 1;
        continue;
      }
      const escape = this.points[index + 1];
      if (escape === undefined) this.fail("Unterminated string starting at", begin);
      const simple = SIMPLE_ESCAPES[escape];
      if (simple !== undefined) {
        out.push(simple);
        index += 2;
        continue;
      }
      if (escape !== "u") this.fail("Invalid \\escape", index);
      const unit = this.hex(index + 2, index + 1);
      index += 6;
      if (unit >= 0xd800 && unit <= 0xdbff && this.points[index] === "\\" && this.points[index + 1] === "u") {
        const low = this.hex(index + 2, index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          out.push(String.fromCharCode(unit, low));
          index += 6;
          continue;
        }
      }
      out.push(String.fromCharCode(unit));
    }
  }

  hex(at: number, reportAt: number): number {
    const digits = this.points.slice(at, at + 4).join("");
    if (!HEX.test(digits)) this.fail("Invalid \\uXXXX escape", reportAt);
    return Number.parseInt(digits, 16);
  }

  object(at: number): [Value, number] {
    const found: JsonObject = new Map();
    let index = this.space(at);
    if (this.points[index] === "}") return [found, index + 1];
    for (;;) {
      if (this.points[index] !== '"') this.fail("Expecting property name enclosed in double quotes", index);
      const [key, afterKey] = this.string(index + 1);
      index = this.space(afterKey);
      if (this.points[index] !== ":") this.fail("Expecting ':' delimiter", index);
      index = this.space(index + 1);
      const [value, afterValue] = this.value(index);
      found.set(key, value);
      index = this.space(afterValue);
      if (this.points[index] === "}") return [found, index + 1];
      if (this.points[index] !== ",") this.fail("Expecting ',' delimiter", index);
      const comma = index;
      index = this.space(index + 1);
      if (this.points[index] === "}") this.fail("Illegal trailing comma before end of object", comma);
    }
  }

  array(at: number): [Value, number] {
    const items: Value[] = [];
    let index = this.space(at);
    if (this.points[index] === "]") return [items, index + 1];
    for (;;) {
      const [value, after] = this.value(index);
      items.push(value);
      index = this.space(after);
      if (this.points[index] === "]") return [items, index + 1];
      if (this.points[index] !== ",") this.fail("Expecting ',' delimiter", index);
      const comma = index;
      index = this.space(index + 1);
      if (this.points[index] === "]") this.fail("Illegal trailing comma before end of array", comma);
    }
  }
}

export function loads(text: string, options: LoadOptions = {}): Value {
  if (isLoneSurrogate(text)) throw new NeedsPython("JSON text with a lone surrogate");
  const points = codePoints(text);
  const scanner = new Scanner(points, options);
  if (points[0] === "﻿") scanner.fail("Unexpected UTF-8 BOM (decode using utf-8-sig)", 0);
  const [parsed, end] = scanner.value(scanner.space(0));
  const rest = scanner.space(end);
  if (rest !== points.length) scanner.fail("Extra data", rest);
  return parsed;
}
