import { Float, type Value } from "../../src/json.ts";

export function toValue(input: unknown): Value {
  if (input === null || input === undefined) return null;
  if (typeof input === "boolean" || typeof input === "string" || typeof input === "bigint") return input;
  if (input instanceof Float) return input;
  if (typeof input === "number") return Number.isInteger(input) && !Object.is(input, -0) ? BigInt(input) : new Float(input);
  if (Array.isArray(input)) return input.map(toValue);
  if (input instanceof Set) return [...input].map(toValue);
  if (input instanceof Map) return new Map([...input].map(([key, value]) => [String(key), toValue(value)]));
  if (typeof input === "object") return new Map(Object.entries(input).map(([key, value]) => [key, toValue(value)]));
  throw new Error(`no JSON form for ${typeof input}`);
}

export function float(value: number): Float {
  return new Float(value);
}

export function optionalFloat(value: number | undefined | null): Value {
  return value === undefined || value === null ? null : new Float(value);
}

export function text(value: Value | undefined): string {
  if (typeof value !== "string") throw new Error(`expected a string, got ${String(value)}`);
  return value;
}

export function optionalText(value: Value | undefined): string | null {
  return value === null || value === undefined ? null : text(value);
}

export function texts(value: Value | undefined): string[] {
  if (!Array.isArray(value)) throw new Error("expected a list");
  return value.map(text);
}

export function num(value: Value | undefined): number {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Float) return value.value;
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new Error(`expected a number, got ${String(value)}`);
}

export function bool(value: Value | undefined): boolean {
  return value === true;
}
