import { Float, type Value } from "../../../src/json.ts";
import { loads } from "../../../src/pyjson.ts";

export class PyFloat {
  constructor(readonly value: number) {}

  toJSON(): number | null {
    return Number.isFinite(this.value) ? this.value : null;
  }
}

export type Json = null | boolean | number | string | PyFloat | Json[] | { [key: string]: Json };
export type JsonRecord = { [key: string]: Json };

function plain(value: Value): Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Float) return Number.isInteger(value.value) || !Number.isFinite(value.value) ? new PyFloat(value.value) : value.value;
  if (Array.isArray(value)) return value.map(plain);
  const out: JsonRecord = {};
  for (const [key, item] of value) Object.defineProperty(out, key, { value: plain(item), enumerable: true, writable: true, configurable: true });
  return out;
}

export function pyLoads(text: string): Json {
  return plain(loads(text));
}

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof PyFloat);
}

export function isPyInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export function numeric(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof PyFloat) return value.value;
  return undefined;
}

export function pyEqual(a: unknown, b: unknown): boolean {
  const x = numeric(a);
  const y = numeric(b);
  if (x !== undefined || y !== undefined) return x !== undefined && y !== undefined && x === y;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => pyEqual(item, b[index]));
  }
  const left = Object.keys(a);
  const right = Object.keys(b);
  if (left.length !== right.length) return false;
  return left.every((key) => Object.hasOwn(b, key) && pyEqual((a as JsonRecord)[key], (b as JsonRecord)[key]));
}

export function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item,
  );
}
