import { isWhitespace, strip } from "../py.ts";
import { codePoints } from "../pystr.ts";
import { decimalValue, isPrintableCode } from "./unicode.ts";

export class PyException extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

function hex(code: number, width: number): string {
  return code.toString(16).padStart(width, "0");
}

export function reprText(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const point of codePoints(text)) {
    const code = point.codePointAt(0) as number;
    if (point === quote || point === "\\") out += `\\${point}`;
    else if (point === "\t") out += "\\t";
    else if (point === "\n") out += "\\n";
    else if (point === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\x${hex(code, 2)}`;
    else if (code < 0x7f || isPrintableCode(code)) out += point;
    else if (code <= 0xff) out += `\\x${hex(code, 2)}`;
    else if (code <= 0xffff) out += `\\u${hex(code, 4)}`;
    else out += `\\U${hex(code, 8)}`;
  }
  return out + quote;
}

export const MAX_INT_DIGITS = 4300;

function asciiDigits(body: string): string | undefined {
  let digits = "";
  let previousUnderscore = true;
  for (const point of codePoints(body)) {
    if (point === "_") {
      if (previousUnderscore) return undefined;
      previousUnderscore = true;
      continue;
    }
    const value = decimalValue(point.codePointAt(0) as number);
    if (value < 0) return undefined;
    digits += String.fromCharCode(0x30 + value);
    previousUnderscore = false;
  }
  return digits === "" || previousUnderscore ? undefined : digits;
}

export function pyInt(text: string): bigint {
  const body = strip(text, isWhitespace);
  const sign = body.startsWith("-") ? -1n : 1n;
  const unsigned = body.startsWith("-") || body.startsWith("+") ? body.slice(1) : body;
  const digits = asciiDigits(unsigned);
  if (digits === undefined) throw new PyException("ValueError", `invalid literal for int() with base 10: ${reprText(text)}`);
  if (digits.length > MAX_INT_DIGITS) {
    throw new PyException("ValueError", `Exceeds the limit (${MAX_INT_DIGITS} digits) for integer string conversion: value has ${digits.length} digits; use sys.set_int_max_str_digits() to increase the limit`);
  }
  return sign * BigInt(digits);
}

export function decimalDigits(text: string): string | undefined {
  let digits = "";
  for (const point of codePoints(text)) {
    const value = decimalValue(point.codePointAt(0) as number);
    if (value < 0) return undefined;
    digits += String.fromCharCode(0x30 + value);
  }
  return digits;
}

const FLOAT_SHAPE = /^([0-9_]*)(?:\.([0-9_]*))?(?:[eE]([+-]?)([0-9_]+))?$/;

function underscoredDigits(part: string): string | undefined {
  if (part === "") return "";
  if (part.startsWith("_") || part.endsWith("_") || part.includes("__")) return undefined;
  return part.replaceAll("_", "");
}

export function pyFloatOrUndefined(text: string): number | undefined {
  const body = strip(text, isWhitespace);
  const negative = body.startsWith("-");
  const signless = negative || body.startsWith("+") ? body.slice(1) : body;
  let ascii = "";
  for (const point of codePoints(signless)) {
    const code = point.codePointAt(0) as number;
    if (code < 0x80) ascii += point;
    else {
      const value = decimalValue(code);
      if (value < 0) return undefined;
      ascii += String.fromCharCode(0x30 + value);
    }
  }
  const lowered = ascii.toLowerCase();
  if (lowered === "inf" || lowered === "infinity") return negative ? -Infinity : Infinity;
  if (lowered === "nan") return Number.NaN;
  const shape = FLOAT_SHAPE.exec(ascii);
  if (shape === null) return undefined;
  const [, whole = "", fraction, expSign = "", exponent] = shape;
  const wholeDigits = underscoredDigits(whole);
  const fractionDigits = fraction === undefined ? "" : underscoredDigits(fraction);
  if (wholeDigits === undefined || fractionDigits === undefined || (wholeDigits === "" && fractionDigits === "")) return undefined;
  let exponentText = "";
  if (exponent !== undefined) {
    const digits = underscoredDigits(exponent);
    if (digits === undefined) return undefined;
    exponentText = `e${expSign}${digits}`;
  }
  const value = Number(`${wholeDigits || "0"}.${fractionDigits || "0"}${exponentText}`);
  return negative ? -value : value;
}

export function pyFloat(text: string): number {
  const value = pyFloatOrUndefined(text);
  if (value === undefined) throw new PyException("ValueError", `could not convert string to float: ${reprText(text)}`);
  return value;
}

export function pyLen(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; count += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit < 0xdc00) {
      const next = text.charCodeAt(index + 1);
      index += next === 0xffff || (next >= 0xdc00 && next < 0xe000) ? 2 : 1;
    } else index += 1;
  }
  return count;
}

export function compareText(left: string, right: string): number {
  const a = codePoints(left);
  const b = codePoints(right);
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = ((a[index] as string).codePointAt(0) as number) - ((b[index] as string).codePointAt(0) as number);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

export function isSpaceCode(code: number): boolean {
  if (code <= 0x20) return code === 0x20 || (code >= 0x09 && code <= 0x0d) || (code >= 0x1c && code <= 0x1f);
  if (code < 0x85) return false;
  return code === 0x85 || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000;
}

export function pyStrip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isSpaceCode(text.charCodeAt(start))) start += 1;
  while (end > start && isSpaceCode(text.charCodeAt(end - 1))) end -= 1;
  return start === 0 && end === text.length ? text : text.slice(start, end);
}

export function pyRstrip(text: string): string {
  let end = text.length;
  while (end > 0 && isSpaceCode(text.charCodeAt(end - 1))) end -= 1;
  return end === text.length ? text : text.slice(0, end);
}

export function joinedWords(text: string): string {
  let out = "";
  let index = 0;
  const length = text.length;
  while (index < length) {
    while (index < length && isSpaceCode(text.charCodeAt(index))) index += 1;
    if (index >= length) break;
    const start = index;
    while (index < length && !isSpaceCode(text.charCodeAt(index))) index += 1;
    out = out ? `${out} ${text.slice(start, index)}` : text.slice(start, index);
  }
  return out;
}

export function headPoints(text: string, size: number): string {
  if (text.length <= size) return text;
  let units = 0;
  for (let count = 0; count < size && units < text.length; count += 1) {
    const unit = text.charCodeAt(units);
    const next = text.charCodeAt(units + 1);
    units += unit >= 0xd800 && unit < 0xdc00 && ((next >= 0xdc00 && next < 0xe000) || next === 0xffff) ? 2 : 1;
  }
  return text.slice(0, units);
}

const LINE_BREAKS = new Set([0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]);

export function splitlines(text: string, keepends = false): string[] {
  const out: string[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (!LINE_BREAKS.has(code)) {
      index += 1;
      continue;
    }
    const end = code === 0x0d && text.charCodeAt(index + 1) === 0x0a ? index + 2 : index + 1;
    out.push(text.slice(start, keepends ? end : index));
    start = end;
    index = end;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}
