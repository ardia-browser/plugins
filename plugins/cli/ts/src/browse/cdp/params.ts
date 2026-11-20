import { dumps, Float, type JsonObject, quote, type Value } from "../../json.ts";
import { isSpace, strip } from "../../py.ts";
import { codePoints } from "../../pystr.ts";
import { MAX_INT_DIGITS, PyException } from "../../pylib/str.ts";

export const MAX_STDIN_PARAMS = 1024 * 1024;
export const MAX_PARAMS_DEPTH = 64;
export const MAX_CDP_PARAMS = 1024 * 1024;
const RECURSION_DEPTH = 990;
const WHITESPACE = " \t\n\r";
const HEX = /^[0-9a-fA-F]{4}$/u;

export class ParamsError extends Error {}

class DecodeError extends Error {
  constructor(
    readonly what: string,
    readonly points: readonly string[],
    readonly at: number,
  ) {
    super(what);
  }

  describe(): string {
    let line = 1;
    let lastBreak = -1;
    for (let index = 0; index < this.at && index < this.points.length; index += 1) {
      if (this.points[index] === "\n") {
        line += 1;
        lastBreak = index;
      }
    }
    return `${this.what}: line ${line} column ${this.at - lastBreak} (char ${this.at})`;
  }
}

class TooDeep extends Error {}

function isDigit(point: string | undefined): boolean {
  return point !== undefined && point >= "0" && point <= "9";
}

class Scanner {
  private depth = 0;

  constructor(
    readonly points: readonly string[],
    readonly what: string,
    readonly strict = true,
  ) {}

  fail(message: string, at: number): never {
    throw new DecodeError(message, this.points, at);
  }

  space(at: number): number {
    let index = at;
    while (index < this.points.length && WHITESPACE.includes(this.points[index] as string)) index += 1;
    return index;
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
    if (this.depth > RECURSION_DEPTH) throw new TooDeep();
    try {
      return run();
    } finally {
      this.depth -= 1;
    }
  }

  word(at: number, word: string): boolean {
    for (let index = 0; index < word.length; index += 1) if (this.points[at + index] !== word[index]) return false;
    return true;
  }

  constant(name: string, at: number): [Value, number] {
    if (this.strict) throw new ParamsError(`${this.what} has ${name}, which isn't JSON`);
    const value = name === "NaN" ? Number.NaN : name.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    return [new Float(value), at + name.length];
  }

  number(at: number): [Value, number] {
    let index = at;
    if (this.points[index] === "-") index += 1;
    if (this.points[index] === "0") index += 1;
    else if (isDigit(this.points[index]) && this.points[index] !== "0") {
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
      if (!this.strict) return [new Float(parsed), index];
      if (!Number.isFinite(parsed)) throw new ParamsError(`${this.what} has the number ${literal.slice(0, 24)}, which is too large for JSON`);
      return [new Float(parsed), index];
    }
    const digits = literal.startsWith("-") ? literal.length - 1 : literal.length;
    if (digits > MAX_INT_DIGITS && !this.strict) {
      throw new PyException(
        "ValueError",
        `Exceeds the limit (${MAX_INT_DIGITS} digits) for integer string conversion: value has ${digits} digits; use sys.set_int_max_str_digits() to increase the limit`,
      );
    }
    if (digits > MAX_INT_DIGITS) {
      throw new ParamsError(
        `${this.what} isn't valid JSON (Exceeds the limit (${MAX_INT_DIGITS} digits) for integer string conversion: value has ${digits} digits; ` +
          "use sys.set_int_max_str_digits() to increase the limit)",
      );
    }
    const integer = BigInt(literal);
    if (!this.strict) return [integer, index];
    if (!Number.isFinite(Number(integer))) throw new ParamsError(`${this.what} has the number ${literal.slice(0, 24)}…, which is too large for JSON`);
    return [integer, index];
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
      const simple = ({ '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[escape];
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
    const pairs: [string, Value][] = [];
    let index = this.space(at);
    if (this.points[index] !== "}") {
      for (;;) {
        if (this.points[index] !== '"') this.fail("Expecting property name enclosed in double quotes", index);
        const [key, afterKey] = this.string(index + 1);
        index = this.space(afterKey);
        if (this.points[index] !== ":") this.fail("Expecting ':' delimiter", index);
        index = this.space(index + 1);
        const [value, afterValue] = this.value(index);
        pairs.push([key, value]);
        index = this.space(afterValue);
        if (this.points[index] === "}") break;
        if (this.points[index] !== ",") this.fail("Expecting ',' delimiter", index);
        const comma = index;
        index = this.space(index + 1);
        if (this.points[index] === "}") this.fail("Illegal trailing comma before end of object", comma);
      }
    }
    const found: JsonObject = new Map();
    for (const [key, value] of pairs) {
      if (found.has(key) && this.strict) throw new ParamsError(`${this.what} has the key ${quote(key, true)} twice`);
      found.set(key, value);
    }
    return [found, index + 1];
  }

  array(at: number): [Value, number] {
    const items: Value[] = [];
    let index = this.space(at);
    if (this.points[index] !== "]") {
      for (;;) {
        const [value, after] = this.value(index);
        items.push(value);
        index = this.space(after);
        if (this.points[index] === "]") break;
        if (this.points[index] !== ",") this.fail("Expecting ',' delimiter", index);
        const comma = index;
        index = this.space(index + 1);
        if (this.points[index] === "]") this.fail("Illegal trailing comma before end of array", comma);
      }
    }
    return [items, index + 1];
  }
}

function loneSurrogate(text: string): number | null {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return unit;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return unit;
  }
  return null;
}

export function plainText(text: string, what: string): void {
  const unit = loneSurrogate(text);
  if (unit !== null) throw new ParamsError(`${what} has a lone surrogate (\\u${unit.toString(16).padStart(4, "0")}), which isn't valid Unicode`);
}

function checked(value: Value, what: string, depth: number): void {
  const stack: [Value, number][] = [[value, depth]];
  while (stack.length > 0) {
    const [item, level] = stack.pop() as [Value, number];
    if (item instanceof Map || Array.isArray(item)) {
      if (level >= MAX_PARAMS_DEPTH) throw new ParamsError(`${what} is nested deeper than ${MAX_PARAMS_DEPTH} levels`);
      if (item instanceof Map) {
        for (const key of item.keys()) plainText(key, what);
        for (const child of item.values()) stack.push([child, level + 1]);
      } else for (const child of item) stack.push([child, level + 1]);
    } else if (typeof item === "string") plainText(item, what);
  }
}

export function strictJson(text: string, what: string, depth = 0): Value {
  if (strip(text, isSpace) === "") {
    throw new ParamsError(`${what} is empty; give a JSON object, like {}`);
  }
  const points = codePoints(text);
  const scanner = new Scanner(points, what);
  let value: Value;
  try {
    if (points[0] === "﻿") scanner.fail("Unexpected UTF-8 BOM (decode using utf-8-sig)", 0);
    const [parsed, end] = scanner.value(scanner.space(0));
    const rest = scanner.space(end);
    if (rest !== points.length) scanner.fail("Extra data", rest);
    value = parsed;
  } catch (error) {
    if (error instanceof TooDeep) throw new ParamsError(`${what} is nested deeper than ${MAX_PARAMS_DEPTH} levels`);
    if (error instanceof DecodeError) throw new ParamsError(`${what} isn't valid JSON (${error.describe()})`);
    throw error;
  }
  checked(value, what, depth);
  return value;
}

export function pyLoads(text: string): Value {
  const points = codePoints(text);
  const scanner = new Scanner(points, "", false);
  try {
    if (points[0] === "\ufeff") scanner.fail("Unexpected UTF-8 BOM (decode using utf-8-sig)", 0);
    const [parsed, end] = scanner.value(scanner.space(0));
    const rest = scanner.space(end);
    if (rest !== points.length) scanner.fail("Extra data", rest);
    return parsed;
  } catch (error) {
    if (error instanceof TooDeep) throw new PyException("RecursionError", "maximum recursion depth exceeded while decoding a JSON document");
    if (error instanceof DecodeError) throw new PyException("JSONDecodeError", error.describe());
    throw error;
  }
}

export function readParamsStdin(stdin: string): string {
  const bytes = surrogatePass(codePoints(stdin).slice(0, MAX_STDIN_PARAMS + 1).join(""));
  if (bytes.length > MAX_STDIN_PARAMS) throw new ParamsError("--params from stdin is over 1 MB");
  const bad = firstInvalidUtf8(bytes);
  if (bad !== null) throw new ParamsError(`--params from stdin isn't UTF-8 (byte 0x${(bytes[bad] as number).toString(16).padStart(2, "0")} at offset ${bad})`);
  return bytes.toString("utf8");
}

function surrogatePass(text: string): Buffer {
  const parts: number[] = [];
  for (const point of text) {
    const code = point.codePointAt(0) as number;
    if (point.length === 1 && code >= 0xd800 && code <= 0xdfff) parts.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else parts.push(...Buffer.from(point, "utf8"));
  }
  return Buffer.from(parts);
}

function firstInvalidUtf8(bytes: Buffer): number | null {
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index] as number;
    let need = 0;
    let low = 0x80;
    let high = 0xbf;
    if (lead < 0x80) {
      index += 1;
      continue;
    } else if (lead >= 0xc2 && lead <= 0xdf) need = 1;
    else if (lead >= 0xe0 && lead <= 0xef) {
      need = 2;
      if (lead === 0xe0) low = 0xa0;
      if (lead === 0xed) high = 0x9f;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      need = 3;
      if (lead === 0xf0) low = 0x90;
      if (lead === 0xf4) high = 0x8f;
    } else return index;
    for (let step = 1; step <= need; step += 1) {
      const next = bytes[index + step];
      if (next === undefined) return index;
      if (step === 1 ? next < low || next > high : next < 0x80 || next > 0xbf) return index;
    }
    index += need + 1;
  }
  return null;
}

export function buildParams(raw: string | null | undefined, pairs: readonly string[], stdin: string): JsonObject | null {
  let params: JsonObject | null = null;
  if (raw !== null && raw !== undefined) {
    const text = raw === "-" ? readParamsStdin(stdin) : raw;
    const parsed = strictJson(text, "--params");
    if (!(parsed instanceof Map)) throw new ParamsError('--params must be a JSON object, like \'{"limit": 10}\'');
    params = parsed;
  }
  for (const pair of pairs) {
    const cut = pair.indexOf("=");
    let key = cut < 0 ? pair : pair.slice(0, cut);
    const value = cut < 0 ? "" : pair.slice(cut + 1);
    if (cut < 0 || !key || key === ":") throw new ParamsError(`-p ${pair}: give key=value, or key:=json`);
    params ??= new Map();
    if (key.endsWith(":")) {
      key = key.slice(0, -1);
      plainText(key, `-p ${key}`);
      params.set(key, strictJson(value, `-p ${key}: the value after :=`, 1));
    } else {
      plainText(key, `-p ${key}`);
      plainText(value, `-p ${key}`);
      params.set(key, value);
    }
  }
  return params;
}

export function encodedSize(params: Value): number {
  return Buffer.byteLength(dumps(params, "compact"), "utf8");
}

export function plainParams(value: Value): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Float) return value.value;
  if (Array.isArray(value)) return value.map(plainParams);
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, item] of value) out[key] = plainParams(item);
  return out;
}
