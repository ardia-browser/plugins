import { floatRepr } from "../json.ts";
import { reprText } from "./str.ts";

export type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };

export function isDict(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) {
    for (const key in value) if (Object.hasOwn(value, key)) return true;
    return false;
  }
  return true;
}

export function numberText(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return Object.is(value, -0) ? "0" : String(value);
  return floatRepr(value);
}

export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  return pyRepr(value);
}

export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return numberText(value);
  if (typeof value === "string") return reprText(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (isDict(value)) return `{${Object.entries(value).map(([key, item]) => `${reprText(key)}: ${pyRepr(item)}`).join(", ")}}`;
  return String(value);
}

export function equalsTrue(value: unknown): boolean {
  return value === true || value === 1;
}

export function equalsFalse(value: unknown): boolean {
  return value === false || value === 0;
}

export function get(value: unknown, key: string): unknown {
  return isDict(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}
