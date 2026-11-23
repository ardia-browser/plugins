import { floatRepr, parseText } from "../../json.ts";
import { strOf } from "../../py.ts";

export function pyTruthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

export function pyText(value: unknown): string {
  if (value === undefined || value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isInteger(value) ? BigInt(value).toString() : floatRepr(value);
  const parsed = parseText(JSON.stringify(value));
  return parsed === undefined ? String(value) : strOf(parsed);
}
