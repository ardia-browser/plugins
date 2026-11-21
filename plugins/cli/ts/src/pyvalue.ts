import { dumps, Float, floatRepr, type JsonObject, type Value } from "./json.ts";
import { NeedsPython } from "./paths.ts";
import { codePoints } from "./pystr.ts";

export type Num = bigint | Float;

export function isDict(value: Value | undefined): value is JsonObject {
  return value instanceof Map;
}

export function isList(value: Value | undefined): value is Value[] {
  return Array.isArray(value);
}

export function isStr(value: Value | undefined): value is string {
  return typeof value === "string";
}

export function isNumber(value: Value | undefined): value is Num {
  return typeof value === "bigint" || value instanceof Float;
}

export function isInt(value: Value | undefined): boolean {
  return typeof value === "bigint" || typeof value === "boolean";
}

export function numeric(value: Num | boolean): number | bigint {
  if (typeof value === "boolean") return value ? 1n : 0n;
  return value instanceof Float ? value.value : value;
}

export function isFinite(value: Num): boolean {
  return typeof value === "bigint" || Number.isFinite(value.value);
}

export function less(a: Num | boolean, b: Num | boolean): boolean {
  return (numeric(a) as number) < (numeric(b) as number);
}

export function lessOrEqual(a: Num | boolean, b: Num | boolean): boolean {
  return (numeric(a) as number) <= (numeric(b) as number);
}

export function numEqual(a: Num | boolean, b: Num | boolean): boolean {
  return (numeric(a) as number) == (numeric(b) as number);
}

export function get(value: Value | undefined, key: string): Value | undefined {
  return value instanceof Map ? value.get(key) : undefined;
}

export function iterate(value: Value | undefined): Value[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return codePoints(value);
  if (value instanceof Map) return [...value.keys()];
  throw new NeedsPython("iterating a value Python can't iterate");
}

export function show(value: Value): string {
  return typeof value === "string" ? value : dumps(value, "spaced");
}

export function pyStr(value: Value): string {
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "bigint" || typeof value === "string") return String(value);
  if (value instanceof Float) return floatRepr(value.value);
  throw new NeedsPython("formatting a value as Python would");
}

export function copy(value: Value): Value {
  if (Array.isArray(value)) return value.map(copy);
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [key, copy(item)]));
  return value;
}

export function pyEqual(left: Value | undefined, right: Value | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if ((typeof left === "boolean" || isNumber(left)) && (typeof right === "boolean" || isNumber(right))) return numEqual(left, right);
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, index) => pyEqual(item, right[index]));
  if (left instanceof Map) {
    if (!(right instanceof Map) || left.size !== right.size) return false;
    for (const [key, item] of left) if (!right.has(key) || !pyEqual(item, right.get(key))) return false;
    return true;
  }
  return left === right;
}

function printable(point: string): boolean {
  if (point === " ") return true;
  return !/^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u.test(point);
}

export function reprText(text: string): string {
  const points = codePoints(text);
  const quote = points.includes("'") && !points.includes('"') ? '"' : "'";
  const out: string[] = [quote];
  for (const point of points) {
    const code = point.codePointAt(0) as number;
    if (point === "\\") out.push("\\\\");
    else if (point === quote) out.push(`\\${quote}`);
    else if (point === "\t") out.push("\\t");
    else if (point === "\n") out.push("\\n");
    else if (point === "\r") out.push("\\r");
    else if (code < 0x20 || code === 0x7f) out.push(`\\x${code.toString(16).padStart(2, "0")}`);
    else if (code < 0x7f || printable(point)) out.push(point);
    else if (code < 0x100) out.push(`\\x${code.toString(16).padStart(2, "0")}`);
    else if (code < 0x10000) out.push(`\\u${code.toString(16).padStart(4, "0")}`);
    else out.push(`\\U${code.toString(16).padStart(8, "0")}`);
  }
  out.push(quote);
  return out.join("");
}

export function lower(text: string): string {
  return text.toLowerCase();
}
