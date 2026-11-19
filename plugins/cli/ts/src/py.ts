import { Float, floatRepr, isWideInt, type JsonObject, type Value } from "./json.ts";

export class Unsupported extends Error {
  constructor() {
    super("a shape only Python renders");
  }
}

export function truthy(value: Value | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value !== 0n;
  if (value instanceof Float) return value.value !== 0;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  return value.size > 0;
}

export function dict(value: Value | undefined): JsonObject {
  if (value instanceof Map) return value;
  throw new Unsupported();
}

export function getOrNull(value: Value | undefined, key: string): Value {
  return dict(value).get(key) ?? null;
}

export function iterateOrEmpty(value: Value | undefined): Value[] {
  if (!truthy(value) || value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [...value];
  if (value instanceof Map) return [...value.keys()];
  throw new Unsupported();
}

export function length(value: Value | undefined): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "string") return [...value].length;
  if (value instanceof Map) return value.size;
  throw new Unsupported();
}

export function isInt(value: Value | undefined): boolean {
  return typeof value === "bigint" || typeof value === "boolean";
}

export function isNumber(value: Value | undefined): boolean {
  return typeof value === "bigint" || value instanceof Float;
}

const EXACT = 9_007_199_254_740_992;

export function number(value: Value | undefined): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint" && !isWideInt(value) && Math.abs(Number(value)) <= EXACT) return Number(value);
  if (value instanceof Float && Number.isFinite(value.value)) return value.value;
  throw new Unsupported();
}

export function equalsInt(value: Value | undefined, wanted: bigint): boolean {
  if (typeof value === "boolean") return BigInt(value ? 1 : 0) === wanted;
  if (typeof value === "bigint") return !isWideInt(value) && value === wanted;
  if (value instanceof Float) {
    const wantedAsFloat = Number(wanted);
    return Number.isInteger(value.value) && value.value >= 0 && value.value === wantedAsFloat && BigInt(wantedAsFloat) === wanted;
  }
  return false;
}

export function reprStr(text: string): string {
  for (const ch of text) {
    if (!((ch >= " " && ch <= "~") || ch === "\t" || ch === "\n" || ch === "\r")) throw new Unsupported();
  }
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    if (ch === "\\") out += "\\\\";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === quote) out += `\\${ch}`;
    else out += ch;
  }
  return out + quote;
}

type ReprFrame = { entries: [string | undefined, Value][]; next: number; close: string };

function reprScalar(value: Value): string | undefined {
  if (typeof value === "string") return reprStr(value);
  if (Array.isArray(value) || value instanceof Map) return undefined;
  return strOf(value);
}

export function repr(value: Value): string {
  const out: string[] = [];
  const stack: ReprFrame[] = [];
  const emit = (child: Value) => {
    const scalar = reprScalar(child);
    if (scalar !== undefined) {
      out.push(scalar);
      return;
    }
    const container = child as Value[] | JsonObject;
    const entries: [string | undefined, Value][] = Array.isArray(container)
      ? container.map((inner): [undefined, Value] => [undefined, inner])
      : [...container];
    out.push(Array.isArray(container) ? "[" : "{");
    stack.push({ entries, next: 0, close: Array.isArray(container) ? "]" : "}" });
  };
  emit(value);
  for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
    if (frame.next === frame.entries.length) {
      stack.pop();
      out.push(frame.close);
      continue;
    }
    const [key, child] = frame.entries[frame.next] as [string | undefined, Value];
    if (frame.next > 0) out.push(", ");
    frame.next += 1;
    if (key !== undefined) out.push(`${reprStr(key)}: `);
    emit(child);
  }
  return out.join("");
}

export function strOf(value: Value | undefined): string {
  if (value === undefined || value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Float) return floatRepr(value.value);
  if (typeof value === "string") return value;
  return repr(value);
}

const SPACES = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

export function isWhitespace(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return SPACES.has(code) && !(code >= 0x1c && code <= 0x1f);
}

export function isSpace(ch: string): boolean {
  return SPACES.has(ch.codePointAt(0) ?? 0);
}

export function rstrip(text: string, strip: (ch: string) => boolean = isSpace): string {
  const chars = [...text];
  let end = chars.length;
  while (end > 0 && strip(chars[end - 1] ?? "")) end -= 1;
  return chars.slice(0, end).join("");
}

export function strip(text: string, drop: (ch: string) => boolean): string {
  const chars = [...text];
  let start = 0;
  while (start < chars.length && drop(chars[start] ?? "")) start += 1;
  let end = chars.length;
  while (end > start && drop(chars[end - 1] ?? "")) end -= 1;
  return chars.slice(start, end).join("");
}

function charCount(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

export function right(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - charCount(text))) + text;
}

export function left(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - charCount(text)));
}

export { charCount };

export function fixed(value: number, digits: number): string {
  const negative = value < 0 || Object.is(value, -0);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = exponentBits === 0 ? fraction : fraction | (1n << 52n);
  const exponent = exponentBits === 0 ? -1074 : exponentBits - 1075;
  let numerator = mantissa * 10n ** BigInt(digits);
  let denominator = 1n;
  if (exponent >= 0) numerator <<= BigInt(exponent);
  else denominator <<= BigInt(-exponent);
  let quotient = numerator / denominator;
  const twiceRemainder = 2n * (numerator % denominator);
  if (twiceRemainder > denominator || (twiceRemainder === denominator && (quotient & 1n) === 1n)) quotient += 1n;
  const text = quotient.toString().padStart(digits + 1, "0");
  const shown = digits > 0 ? `${text.slice(0, -digits)}.${text.slice(-digits)}` : text;
  return (negative ? "-" : "") + shown;
}
