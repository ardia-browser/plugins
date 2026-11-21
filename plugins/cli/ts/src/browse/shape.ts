import { dumps, type JsonObject, type Value } from "../json.ts";
import { isSpace, strip } from "../py.ts";
import { codePoints } from "../pystr.ts";
import { PyException, pyInt, pyLen, reprText } from "../pylib/str.ts";
import { casefold, decimalValue, isDigitCode } from "../pylib/unicode.ts";
import { BrowseError, Usage } from "./daemon-errors.ts";

export const FIELD_SAMPLE = 50;
export const MAX_LISTED_FIELDS = 60;

export class Shape {
  fields: string[] = [];
  where: [string, string][] = [];
  limit: bigint | null = null;

  get empty(): boolean {
    return this.fields.length === 0 && this.where.length === 0 && this.limit === null;
  }
}

function partition(text: string, separator: string): [string, string, string] {
  const at = text.indexOf(separator);
  return at < 0 ? [text, "", ""] : [text.slice(0, at), separator, text.slice(at + separator.length)];
}

export function parseShape(fields?: string | null, where?: readonly string[] | null, limit?: string | bigint | number | null): Shape {
  const shape = new Shape();
  if (fields) shape.fields = fields.split(",").map((name) => strip(name, isSpace)).filter((name) => name);
  for (const clause of where ?? []) {
    const [name, sep, value] = partition(clause, "=");
    if (!sep || !strip(name, isSpace)) throw new Usage(`--where takes field=value (case-insensitive contains), not ${reprText(clause)}`);
    shape.where.push([strip(name, isSpace), casefold(strip(value, isSpace))]);
  }
  if (limit !== null && limit !== undefined) {
    let parsed: bigint;
    if (typeof limit === "string") {
      try {
        parsed = pyInt(limit);
      } catch {
        throw new Usage(`--limit takes a number of items, not ${reprText(limit)}`);
      }
    } else parsed = typeof limit === "bigint" ? limit : BigInt(Math.trunc(limit));
    if (parsed < 0n) throw new Usage("--limit takes 0 or more");
    shape.limit = parsed;
  }
  return shape;
}

export const MISSING: unique symbol = Symbol("MISSING");
export type Found = Value | typeof MISSING;

function listIndex(key: string): number | undefined {
  if (key === "") return undefined;
  for (const point of codePoints(key)) if (!isDigitCode(point.codePointAt(0) as number)) return undefined;
  for (const point of codePoints(key)) {
    if (decimalValue(point.codePointAt(0) as number) < 0) throw new PyException("ValueError", `invalid literal for int() with base 10: ${reprText(key)}`);
  }
  const value = pyInt(key);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

export function lookup(value: Value, path: string): Found {
  let current: Value = value;
  for (const key of path.split(".")) {
    if (current instanceof Map && current.has(key)) current = current.get(key) as Value;
    else if (Array.isArray(current)) {
      const index = listIndex(key);
      if (index === undefined || index >= current.length) return MISSING;
      current = current[index] as Value;
    } else return MISSING;
  }
  return current;
}

export function asText(value: Value): string {
  return typeof value === "string" ? value : dumps(value, "spaced");
}

function weight(items: Value[]): number {
  return pyLen(dumps(items, "spaced"));
}

export function mainList(body: Value): [string | null, Value[]] | null {
  if (Array.isArray(body)) return [null, body];
  let best: [number, string, Value[]] | undefined;
  const walk = (value: Value, path: string): void => {
    if (!(value instanceof Map)) return;
    for (const [key, child] of value) {
      const here = path ? `${path}.${key}` : key;
      if (Array.isArray(child) && child.length > 0 && child[0] instanceof Map) {
        const size = weight(child);
        if (best === undefined || size > best[0]) best = [size, here, child];
      } else if (child instanceof Map) walk(child, here);
    }
  };
  walk(body, "");
  return best === undefined ? null : [best[1], best[2]];
}

export function itemFields(items: Value[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of items.slice(0, FIELD_SAMPLE)) {
    if (!(item instanceof Map)) continue;
    for (const [key, value] of item) {
      const found = value instanceof Map && value.size > 0 ? [...value.keys()].map((inner) => `${key}.${inner}`) : [key];
      for (const name of found) {
        if (!seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
      }
    }
  }
  return names;
}

export function unknownFields(items: Value[], shape: Shape): string[] {
  const wanted = [...new Set([...shape.where.map(([name]) => name), ...shape.fields])];
  return wanted.filter((name) => !items.some((item) => lookup(item, name) !== MISSING));
}

export function matches(item: Value, where: readonly [string, string][]): boolean {
  for (const [name, needle] of where) {
    const value = lookup(item, name);
    if (value === MISSING || !casefold(asText(value)).includes(needle)) return false;
  }
  return true;
}

export function pick(item: Value, names: readonly string[]): JsonObject {
  const out: JsonObject = new Map();
  for (const name of names) {
    const value = lookup(item, name);
    if (value !== MISSING) out.set(name, value);
  }
  return out;
}

export function apply(body: Value, shape: Shape, always = false, path: string | null = null): Value {
  const at = path ? lookup(body, path) : MISSING;
  const found: [string | null, Value[]] | null = Array.isArray(at) ? [path, at] : mainList(body);
  if (found === null) {
    if (shape.empty && !always) return body;
    if (shape.empty) return new Map<string, Value>([["list", null], ["total", null], ["matched", null], ["items", null], ["value", body]]);
    throw new BrowseError("The answer has no list of items to shape (--fields, --where and --limit work on a list of objects)", null, "no_list");
  }
  const [listPath, items] = found;
  const missing = items.length > 0 ? unknownFields(items, shape) : [];
  if (missing.length > 0) {
    const valid = itemFields(items);
    const listed = valid.slice(0, MAX_LISTED_FIELDS).join(", ") + (valid.length > MAX_LISTED_FIELDS ? " …" : "");
    throw new BrowseError(`No item has ${missing.join(", ")}; the items' fields are: ${listed}`, { unknown: missing, fields: valid, list: listPath }, "unknown_field");
  }
  if (shape.empty && !always) return body;
  let kept = items.filter((item) => matches(item, shape.where));
  const matched = kept.length;
  if (shape.limit !== null) kept = kept.slice(0, shape.limit > BigInt(kept.length) ? kept.length : Number(shape.limit));
  if (shape.fields.length > 0) kept = kept.map((item) => pick(item, shape.fields));
  return new Map<string, Value>([["list", listPath], ["total", BigInt(items.length)], ["matched", BigInt(matched)], ["items", kept]]);
}
