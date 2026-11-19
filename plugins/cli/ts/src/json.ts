import { decodeJsonBytes } from "./json-bytes.ts";

export class Float {
  constructor(readonly value: number) {}
}

export type JsonObject = Map<string, Value>;
export type Value = null | boolean | bigint | Float | string | Value[] | JsonObject;

export const I128_MAX = (1n << 127n) - 1n;
export const I128_MIN = -(1n << 127n);
const MAX_INT_DIGITS = 4300;

export function isWideInt(value: bigint): boolean {
  return value > I128_MAX || value < I128_MIN;
}

export function isObject(value: Value | undefined): value is JsonObject {
  return value instanceof Map;
}

export function field(value: Value | undefined, key: string): Value | undefined {
  return value instanceof Map ? value.get(key) : undefined;
}

export function object(entries: [string, Value][]): JsonObject {
  return new Map(entries);
}

function sameScalar(a: Value, b: Value): boolean {
  if (a instanceof Float) return b instanceof Float && (a.value === b.value || (Number.isNaN(a.value) && Number.isNaN(b.value)));
  return a === b;
}

export function same(a: Value | undefined, b: Value | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const pending: [Value, Value][] = [[a, b]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [left, right] = next;
    if (Array.isArray(left)) {
      if (!Array.isArray(right) || left.length !== right.length) return false;
      left.forEach((item, index) => pending.push([item, right[index] as Value]));
    } else if (left instanceof Map) {
      if (!(right instanceof Map) || left.size !== right.size) return false;
      const rightEntries = [...right];
      for (const [index, [key, item]] of [...left].entries()) {
        const other = rightEntries[index];
        if (other === undefined || other[0] !== key) return false;
        pending.push([item, other[1]]);
      }
    } else if (!sameScalar(left, right)) return false;
  }
  return true;
}

export class TooDeep extends Error {}

export const TELEMETRY_JSON_DEPTH = 9995;

export function parse(bytes: Uint8Array, depthLimit: number): Value | undefined {
  const text = decodeJsonBytes(bytes);
  return text === undefined ? undefined : parseText(text, depthLimit);
}

export function parseText(text: string, depthLimit = Number.POSITIVE_INFINITY): Value | undefined {
  const parser = new Parser(text, depthLimit);
  parser.space();
  const value = parser.value();
  if (value === undefined) return undefined;
  parser.space();
  return parser.at === text.length ? value : undefined;
}

const HEX = /^[0-9a-fA-F]{4}$/;

class Parser {
  at = 0;
  depth = 0;
  constructor(
    readonly text: string,
    readonly depthLimit: number,
  ) {}

  enter(): void {
    this.depth += 1;
    if (this.depth > this.depthLimit) throw new TooDeep();
  }

  peek(): string | undefined {
    return this.text[this.at];
  }

  space(): void {
    while (" \t\n\r".includes(this.text[this.at] ?? "x")) this.at += 1;
  }

  word(word: string): boolean {
    if (!this.text.startsWith(word, this.at)) return false;
    this.at += word.length;
    return true;
  }

  value(): Value | undefined {
    const next = this.peek();
    if (next === "{" || next === "[") {
      this.enter();
      const nested = next === "{" ? this.object() : this.array();
      this.depth -= 1;
      return nested;
    }
    if (next === '"') return this.string();
    if (next === "n" && this.word("null")) return null;
    if (next === "t" && this.word("true")) return true;
    if (next === "f" && this.word("false")) return false;
    if (next === "N" && this.word("NaN")) return new Float(Number.NaN);
    if (next === "I" && this.word("Infinity")) return new Float(Number.POSITIVE_INFINITY);
    if (next === "-" && this.word("-Infinity")) return new Float(Number.NEGATIVE_INFINITY);
    if (next !== undefined && (next === "-" || (next >= "0" && next <= "9"))) return this.number();
    return undefined;
  }

  object(): Value | undefined {
    this.at += 1;
    const map: JsonObject = new Map();
    this.space();
    if (this.peek() === "}") {
      this.at += 1;
      return map;
    }
    for (;;) {
      this.space();
      if (this.peek() !== '"') return undefined;
      const key = this.string();
      if (key === undefined) return undefined;
      this.space();
      if (this.peek() !== ":") return undefined;
      this.at += 1;
      this.space();
      const item = this.value();
      if (item === undefined) return undefined;
      map.set(key, item);
      this.space();
      const next = this.peek();
      if (next === ",") this.at += 1;
      else if (next === "}") {
        this.at += 1;
        return map;
      } else return undefined;
    }
  }

  array(): Value | undefined {
    this.at += 1;
    const items: Value[] = [];
    this.space();
    if (this.peek() === "]") {
      this.at += 1;
      return items;
    }
    for (;;) {
      this.space();
      const item = this.value();
      if (item === undefined) return undefined;
      items.push(item);
      this.space();
      const next = this.peek();
      if (next === ",") this.at += 1;
      else if (next === "]") {
        this.at += 1;
        return items;
      } else return undefined;
    }
  }

  hex4(): number | undefined {
    const digits = this.text.slice(this.at, this.at + 4);
    if (!HEX.test(digits)) return undefined;
    this.at += 4;
    return Number.parseInt(digits, 16);
  }

  string(): string | undefined {
    this.at += 1;
    let out = "";
    for (;;) {
      const start = this.at;
      while (this.at < this.text.length) {
        const code = this.text.charCodeAt(this.at);
        if (code === 0x22 || code === 0x5c || code < 0x20) break;
        this.at += 1;
      }
      out += this.text.slice(start, this.at);
      const next = this.peek();
      if (next === undefined) return undefined;
      if (next === '"') {
        this.at += 1;
        return out;
      }
      if (next !== "\\") return undefined;
      this.at += 1;
      const escape = this.peek();
      this.at += 1;
      const simple = escape === undefined ? undefined : ESCAPES[escape];
      if (simple !== undefined) {
        out += simple;
        continue;
      }
      if (escape !== "u") return undefined;
      const unit = this.hex4();
      if (unit === undefined) return undefined;
      if (unit >= 0xd800 && unit < 0xdc00 && this.text.startsWith("\\u", this.at)) {
        const saved = this.at;
        this.at += 2;
        const low = this.hex4();
        if (low !== undefined && low >= 0xdc00 && low < 0xe000) {
          out += String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00));
          continue;
        }
        this.at = saved;
      }
      out += String.fromCharCode(unit);
    }
  }

  digitAt(at: number): boolean {
    const next = this.text[at];
    return next !== undefined && next >= "0" && next <= "9";
  }

  number(): Value | undefined {
    const start = this.at;
    if (this.peek() === "-") this.at += 1;
    const first = this.peek();
    if (first === "0") this.at += 1;
    else if (first !== undefined && first >= "1" && first <= "9") {
      while (this.digitAt(this.at)) this.at += 1;
    } else return undefined;
    let float = false;
    if (this.peek() === "." && this.digitAt(this.at + 1)) {
      float = true;
      this.at += 1;
      while (this.digitAt(this.at)) this.at += 1;
    }
    if (this.peek() === "e" || this.peek() === "E") {
      let probe = this.at + 1;
      if (this.text[probe] === "+" || this.text[probe] === "-") probe += 1;
      if (this.digitAt(probe)) {
        float = true;
        this.at = probe;
        while (this.digitAt(this.at)) this.at += 1;
      }
    }
    const text = this.text.slice(start, this.at);
    if (float) return new Float(Number(text));
    if (text.replace(/^-/, "").length > MAX_INT_DIGITS) return undefined;
    return BigInt(text);
  }
}

const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

export function floatRepr(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  const sign = value < 0 || Object.is(value, -0) ? "-" : "";
  const scientific = Math.abs(value).toExponential();
  const [mantissa = "0", exponentText = "0"] = scientific.split("e");
  const exponent = Number.parseInt(exponentText, 10);
  const digits = mantissa.replace(".", "");
  const point = exponent + 1;
  if (!(point > -4 && point <= 16)) {
    const rest = digits.slice(1);
    const head = rest === "" ? digits.slice(0, 1) : `${digits.slice(0, 1)}.${rest}`;
    return `${sign}${head}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}.0`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function jsonFloat(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  return floatRepr(value);
}

const SHORT_ESCAPES: Record<number, string> = { 0x22: '\\"', 0x5c: "\\\\", 0x0a: "\\n", 0x0d: "\\r", 0x09: "\\t", 0x08: "\\b", 0x0c: "\\f" };

function hex4(unit: number): string {
  return `\\u${unit.toString(16).padStart(4, "0")}`;
}

export function quote(text: string, ensureAscii: boolean): string {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const short = SHORT_ESCAPES[code];
    if (short !== undefined) out += short;
    else if (code < 0x20) out += hex4(code);
    else if (ensureAscii && code > 0x7e) {
      for (let index = 0; index < ch.length; index += 1) out += hex4(ch.charCodeAt(index));
    } else out += ch;
  }
  return `${out}"`;
}

export type Style = "compact" | "spaced" | "indented";

type Frame = { entries: [string | undefined, Value][]; next: number; depth: number; close: string };

export function dumps(value: Value, style: Style, ensureAscii = false): string {
  const out: string[] = [];
  const item = style === "spaced" ? ", " : ",";
  const pair = style === "compact" ? ":" : ": ";
  const newline = (level: number) => {
    if (style === "indented") out.push(`\n${"  ".repeat(level)}`);
  };
  const stack: Frame[] = [];
  const emit = (child: Value, depth: number) => {
    const scalar = scalarJson(child, ensureAscii);
    if (scalar !== undefined) {
      out.push(scalar);
      return;
    }
    const container = child as Value[] | JsonObject;
    const entries: [string | undefined, Value][] = Array.isArray(container)
      ? container.map((inner): [undefined, Value] => [undefined, inner])
      : [...container];
    const [open, close] = Array.isArray(container) ? ["[", "]"] : ["{", "}"];
    if (entries.length === 0) out.push(open + close);
    else {
      out.push(open);
      stack.push({ entries, next: 0, depth, close });
    }
  };
  emit(value, 0);
  for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
    if (frame.next === frame.entries.length) {
      stack.pop();
      newline(frame.depth);
      out.push(frame.close);
      continue;
    }
    const [key, child] = frame.entries[frame.next] as [string | undefined, Value];
    if (frame.next > 0) out.push(item);
    frame.next += 1;
    newline(frame.depth + 1);
    if (key !== undefined) out.push(quote(key, ensureAscii), pair);
    emit(child, frame.depth + 1);
  }
  return out.join("");
}

function scalarJson(value: Value, ensureAscii: boolean): string | undefined {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Float) return jsonFloat(value.value);
  if (typeof value === "string") return quote(value, ensureAscii);
  return undefined;
}
