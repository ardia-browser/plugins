import { Float, type JsonObject, type Value } from "../json.ts";
import { compareText } from "../pylib/str.ts";

export class Uncomparable extends Error {}

function numeric(value: Value | undefined): number | bigint | undefined {
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value === "bigint") return value;
  if (value instanceof Float) return value.value;
  return undefined;
}

function compareNumbers(left: number | bigint, right: number | bigint): number {
  if (typeof left === "bigint" && typeof right === "bigint") return left < right ? -1 : left > right ? 1 : 0;
  const a = Number(left);
  const b = Number(right);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function pyEqual(left: Value | undefined, right: Value | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  const a = numeric(left);
  const b = numeric(right);
  if (a !== undefined || b !== undefined) return a !== undefined && b !== undefined && compareNumbers(a, b) === 0;
  if (left === null || typeof left === "string") return left === right;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, index) => pyEqual(item, right[index]));
  if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false;
  for (const [key, item] of left) {
    if (!right.has(key) || !pyEqual(item, right.get(key))) return false;
  }
  return true;
}

export function pyCompare(left: Value, right: Value): number {
  const a = numeric(left);
  const b = numeric(right);
  if (a !== undefined && b !== undefined) {
    const found = compareNumbers(a, b);
    return Number.isNaN(found) ? 0 : found;
  }
  if (typeof left === "string" && typeof right === "string") return compareText(left, right);
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      if (!pyEqual(left[index], right[index])) return pyCompare(left[index] as Value, right[index] as Value);
    }
    return left.length - right.length;
  }
  throw new Uncomparable();
}

export function getOr(record: JsonObject, key: string, fallback: Value): Value {
  return record.has(key) ? (record.get(key) as Value) : fallback;
}
