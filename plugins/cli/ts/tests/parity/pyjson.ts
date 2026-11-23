export class PyFloat {
  constructor(readonly value: number) {}
}

export type Py = null | boolean | bigint | PyFloat | string | Py[] | PyObject;
export type PyObject = Map<string, Py>;

export class PyJsonError extends Error {}

const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/y;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const HEX4 = /^[0-9a-fA-F]{4}$/;

class Scanner {
  index = 0;
  constructor(readonly text: string) {}

  fail(what: string): never {
    throw new PyJsonError(`${what} at ${this.index}`);
  }

  space(): void {
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") return;
      this.index += 1;
    }
  }

  value(): Py {
    const char = this.text[this.index];
    if (char === '"') return this.string();
    if (char === "{") return this.object();
    if (char === "[") return this.array();
    for (const [word, found] of [["null", null], ["true", true], ["false", false], ["NaN", new PyFloat(NaN)], ["Infinity", new PyFloat(Infinity)], ["-Infinity", new PyFloat(-Infinity)]] as const) {
      if (this.text.startsWith(word, this.index)) {
        this.index += word.length;
        return found;
      }
    }
    NUMBER.lastIndex = this.index;
    const match = NUMBER.exec(this.text);
    if (match === null) this.fail("Expecting value");
    this.index += match[0].length;
    if (match[1] !== undefined || match[2] !== undefined) return new PyFloat(Number(match[0]));
    return BigInt(match[0]);
  }

  string(): string {
    this.index += 1;
    let out = "";
    for (;;) {
      if (this.index >= this.text.length) this.fail("Unterminated string");
      const char = this.text[this.index]!;
      const code = char.charCodeAt(0);
      if (char === '"') {
        this.index += 1;
        return out;
      }
      if (code < 0x20) this.fail("Invalid control character");
      if (char !== "\\") {
        out += char;
        this.index += 1;
        continue;
      }
      const escape = this.text[this.index + 1];
      if (escape === undefined) this.fail("Unterminated string");
      if (escape !== "u") {
        const plain = ESCAPES[escape];
        if (plain === undefined) this.fail("Invalid \\escape");
        out += plain;
        this.index += 2;
        continue;
      }
      const first = this.hex(this.index + 2);
      this.index += 6;
      if (first >= 0xd800 && first <= 0xdbff && this.text.startsWith("\\u", this.index)) {
        const second = this.hex(this.index + 2);
        if (second >= 0xdc00 && second <= 0xdfff) {
          out += String.fromCharCode(first, second);
          this.index += 6;
          continue;
        }
      }
      out += String.fromCharCode(first);
    }
  }

  hex(at: number): number {
    const digits = this.text.slice(at, at + 4);
    if (!HEX4.test(digits)) {
      this.index = at;
      this.fail("Invalid \\uXXXX escape");
    }
    return parseInt(digits, 16);
  }

  object(): PyObject {
    this.index += 1;
    const out: PyObject = new Map();
    this.space();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return out;
    }
    for (;;) {
      if (this.text[this.index] !== '"') this.fail("Expecting property name enclosed in double quotes");
      const key = this.string();
      this.space();
      if (this.text[this.index] !== ":") this.fail("Expecting ':' delimiter");
      this.index += 1;
      this.space();
      out.set(key, this.value());
      this.space();
      const next = this.text[this.index];
      this.index += 1;
      if (next === "}") return out;
      if (next !== ",") this.fail("Expecting ',' delimiter");
      this.space();
    }
  }

  array(): Py[] {
    this.index += 1;
    const out: Py[] = [];
    this.space();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return out;
    }
    for (;;) {
      out.push(this.value());
      this.space();
      const next = this.text[this.index];
      this.index += 1;
      if (next === "]") return out;
      if (next !== ",") this.fail("Expecting ',' delimiter");
      this.space();
    }
  }
}

export function loads(text: string): Py {
  if (text.startsWith("﻿")) throw new PyJsonError("Unexpected UTF-8 BOM");
  const scanner = new Scanner(text);
  scanner.space();
  const value = scanner.value();
  scanner.space();
  if (scanner.index !== text.length) scanner.fail("Extra data");
  return value;
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function loadsBytes(bytes: Uint8Array): Py {
  let text: string;
  try {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) text = STRICT_UTF8.decode(bytes.subarray(3));
    else if (bytes.length >= 2 && (bytes[0] === 0 || bytes[1] === 0)) {
      if (bytes.length >= 4 && ((bytes[0] === 0 && bytes[1] === 0) || (bytes[2] === 0 && bytes[3] === 0))) throw new PyJsonError("utf-32 is not supported here");
      const little = bytes[0] === 0 ? Buffer.from(bytes).swap16() : bytes;
      if (little.length % 2) throw new PyJsonError("truncated utf-16");
      text = Buffer.from(little).toString("utf16le");
    } else text = STRICT_UTF8.decode(bytes);
  } catch (error) {
    if (error instanceof PyJsonError) throw error;
    throw new PyJsonError("not UTF-8");
  }
  return loads(text);
}

export function floatRepr(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const sign = value < 0 ? "-" : "";
  const [mantissa, exponentText] = Math.abs(value).toExponential().split("e") as [string, string];
  const digits = mantissa.replace(".", "");
  const point = Number(exponentText) + 1;
  if (point > -4 && point <= 16) {
    if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
    if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}.0`;
    return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  const exponent = point - 1;
  const fraction = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  return `${sign}${fraction}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
}

function quote(text: string, ensureAscii: boolean): string {
  let out = '"';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const code = char.charCodeAt(0);
    if (char === '"') out += '\\"';
    else if (char === "\\") out += "\\\\";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (char === "\b") out += "\\b";
    else if (char === "\f") out += "\\f";
    else if (code < 0x20 || (ensureAscii && code > 0x7e)) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return `${out}"`;
}

export function codePointOrder(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

export type DumpOptions = { sortKeys?: boolean; ensureAscii?: boolean };

export function dumps(value: Py, options: DumpOptions = {}): string {
  const ensureAscii = options.ensureAscii ?? true;
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof PyFloat) return floatRepr(value.value);
  if (typeof value === "string") return quote(value, ensureAscii);
  if (Array.isArray(value)) return `[${value.map((item) => dumps(item, options)).join(", ")}]`;
  const keys = [...value.keys()];
  if (options.sortKeys) keys.sort(codePointOrder);
  return `{${keys.map((key) => `${quote(key, ensureAscii)}: ${dumps(value.get(key)!, options)}`).join(", ")}}`;
}

export function canonical(value: Py): string {
  return dumps(value, { sortKeys: true });
}

export function isObject(value: Py | undefined): value is PyObject {
  return value instanceof Map;
}

export function fromJs(value: unknown): Py {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "string" || typeof value === "bigint") return value;
  if (value instanceof PyFloat) return value;
  if (typeof value === "number") return Number.isInteger(value) ? BigInt(value) : new PyFloat(value);
  if (Array.isArray(value)) return value.map(fromJs);
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [String(key), fromJs(item)]));
  return new Map(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, fromJs(item)]));
}

export function mapStrings(value: Py, change: (text: string) => string, keys = true): Py {
  if (typeof value === "string") return change(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, change, keys));
  if (isObject(value)) return new Map([...value].map(([key, item]) => [keys ? change(key) : key, mapStrings(item, change, keys)]));
  return value;
}

export function clone(value: Py): Py {
  return mapStrings(value, (text) => text);
}
