import { getCloseMatches } from "./difflib.ts";
import { Float, type JsonObject, type Value } from "./json.ts";
import { NeedsPython } from "./paths.ts";
import { search } from "./pyregex.ts";
import { codePoints } from "./pystr.ts";
import { get, isDict, isFinite, isList, isNumber, isStr, iterate, less, lessOrEqual, lower, numEqual, pyStr, show } from "./pyvalue.ts";

export type PathPart = string | number;
export type Path = readonly PathPart[];

const TYPE_NAMES: Record<string, string> = {
  boolean: "true or false",
  integer: "a whole number",
  number: "a number",
  string: "a string",
  array: "a list",
  object: "an object",
  null: "null",
};

export class Problem {
  constructor(
    readonly path: Path,
    readonly message: string,
  ) {}

  toDict(): JsonObject {
    return new Map<string, Value>([
      ["key", formatPath(this.path)],
      ["message", this.message],
    ]);
  }
}

export function pathKey(path: Path): string {
  return JSON.stringify(path);
}

export function formatPath(path: Path): string {
  let text = "";
  for (const part of path) {
    if (typeof part === "number") text += `[${part}]`;
    else text += text ? `.${part}` : part;
  }
  return text;
}

export function jsonType(value: Value): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "bigint") return "integer";
  if (value instanceof Float) return "number";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "array";
  return "object";
}

export function hasType(value: Value, name: Value): boolean {
  const actual = jsonType(value);
  if (name === "number") return actual === "integer" || actual === "number";
  if (name === "integer") return actual === "integer" || (value instanceof Float && Number.isFinite(value.value) && Number.isInteger(value.value));
  return actual === name;
}

export function jsonEqual(left: Value, right: Value): boolean {
  if (typeof left === "boolean" || typeof right === "boolean") return left === right;
  if (isNumber(left) && isNumber(right)) return numEqual(left, right);
  if (isList(left) && isList(right)) return left.length === right.length && left.every((item, index) => jsonEqual(item, right[index] as Value));
  if (isDict(left) && isDict(right)) {
    if (left.size !== right.size) return false;
    for (const key of left.keys()) if (!right.has(key)) return false;
    for (const [key, item] of left) if (!jsonEqual(item, right.get(key) as Value)) return false;
    return true;
  }
  if (jsonType(left) !== jsonType(right)) return false;
  return left === right;
}

export function choices(values: Value): string {
  const shown = iterate(values).map(show);
  if (shown.length === 0) throw new NeedsPython("an empty list of choices");
  if (shown.length === 1) return shown[0] as string;
  return `${shown.slice(0, -1).join(", ")} or ${shown.at(-1)}`;
}

export function closest(name: string, candidates: Value): string[] {
  const strings = iterate(candidates).filter(isStr);
  const folded = strings.filter((candidate) => lower(candidate) === lower(name));
  return folded.length > 0 ? folded : getCloseMatches(name, strings, 3, 0.6);
}

export function didYouMean(name: string, candidates: Value): string {
  const found = closest(name, candidates);
  return found.length > 0 ? ` (did you mean ${choices(found)}?)` : "";
}

function typeNames(kinds: Value): Value[] {
  return typeof kinds === "string" ? [kinds] : iterate(kinds);
}

export function describe(schema: Value | undefined): string {
  if (schema === true || !isDict(schema)) return "anything";
  if (schema.has("const")) return show(schema.get("const") as Value);
  if (schema.has("enum")) return choices(schema.get("enum") as Value);
  if (schema.has("anyOf")) return iterate(schema.get("anyOf")).map(describe).join(" or ");
  const kinds = schema.get("type");
  const falsy = kinds === undefined || kinds === null || kinds === false || kinds === 0n || (kinds instanceof Float && kinds.value === 0) || (isList(kinds) && kinds.length === 0) || (isDict(kinds) && kinds.size === 0);
  const names = falsy ? [] : typeNames(kinds as Value);
  if (names.length === 0) return "anything";
  const parts: string[] = [];
  for (const name of names) {
    if (typeof name !== "string") throw new NeedsPython("a schema type that isn't a string");
    if (name === "array") {
      const items = schema.get("items");
      const prefix = schema.get("prefixItems");
      const maxItems = schema.get("maxItems");
      if (prefix !== undefined && prefix !== null && !isList(prefix)) throw new NeedsPython("prefixItems that isn't a list");
      const prefixLength = BigInt(isList(prefix) ? prefix.length : 0);
      const fixed = items === false || ((isNumber(maxItems) || typeof maxItems === "boolean") && numEqual(maxItems, prefixLength));
      if (isList(prefix) && prefix.length > 0 && fixed) parts.push(`a list of ${prefix.length} (${prefix.map(describe).join(", ")})`);
      else if (isDict(items)) parts.push(`a list of ${plural(describe(items))}`);
      else parts.push("a list");
    } else if (name === "number" || name === "integer") parts.push((TYPE_NAMES[name] as string) + bounds(schema));
    else parts.push(TYPE_NAMES[name] ?? name);
  }
  return parts.join(" or ");
}

function plural(text: string): string {
  for (const article of ["a ", "an "]) {
    if (text.startsWith(article)) {
      const rest = text.slice(article.length);
      if (rest.startsWith("list")) return `lists${rest.slice(4)}`;
      if (rest.startsWith("whole number")) return `whole numbers${rest.slice(12)}`;
      const space = rest.indexOf(" ");
      const word = space < 0 ? rest : rest.slice(0, space);
      const tail = space < 0 ? "" : rest.slice(space + 1);
      return `${word}s${tail ? ` ${tail}` : ""}`;
    }
  }
  return text;
}

function bounds(schema: JsonObject): string {
  const parts: string[] = [];
  const minimum = schema.get("minimum");
  const exclusive = schema.get("exclusiveMinimum");
  const maximum = schema.get("maximum");
  if (isNumber(minimum)) parts.push(`at least ${show(minimum)}`);
  if (isNumber(exclusive)) parts.push(`more than ${show(exclusive)}`);
  if (isNumber(maximum)) parts.push(`at most ${show(maximum)}`);
  return parts.length > 0 ? ` ${parts.join(" and ")}` : "";
}

function itemCount(value: Value | undefined): bigint | undefined {
  if (typeof value === "boolean") throw new NeedsPython("an item count that's true or false");
  return typeof value === "bigint" ? value : undefined;
}

function items(count: bigint): string {
  return `item${count !== 1n ? "s" : ""}`;
}

export function validate(value: Value, schema: Value | undefined, path: Path = [], root = true, noun?: string): Problem[] {
  if (schema === true || schema === null || schema === undefined) return [];
  if (schema === false) return [new Problem(path, `${formatPath(path) || "the file"} isn't allowed`)];
  if (!isDict(schema)) return [];
  const name = formatPath(path) || "the file";
  const kinds = schema.get("type");
  if (kinds !== undefined && kinds !== null) {
    if (!typeNames(kinds).some((kind) => hasType(value, kind))) return [new Problem(path, `${name} must be ${describe(schema)}`)];
  }
  if (schema.has("const") && !jsonEqual(value, schema.get("const") as Value)) return [new Problem(path, `${name} must be ${show(schema.get("const") as Value)}`)];
  if (schema.has("enum") && !iterate(schema.get("enum")).some((option) => jsonEqual(value, option))) {
    return [new Problem(path, `${name} must be ${choices(schema.get("enum") as Value)}`)];
  }
  if (schema.has("anyOf")) {
    const problem = checkAnyOf(value, schema.get("anyOf") as Value, path, name);
    if (problem.length > 0) return problem;
  }
  const problems: Problem[] = [];
  if (isNumber(value)) problems.push(...checkBounds(value, schema, path, name));
  const pattern = schema.get("pattern");
  if (typeof value === "string" && typeof pattern === "string" && !search(pattern, true, value)) problems.push(new Problem(path, `${name} must match ${pattern}`));
  if (isList(value)) problems.push(...checkArray(value, schema, path, name));
  if (isDict(value)) problems.push(...checkObject(value, schema, path, name, root, noun));
  return problems;
}

function checkBounds(value: Value, schema: JsonObject, path: Path, name: string): Problem[] {
  const number = value as bigint | Float;
  const minimum = schema.get("minimum");
  const exclusive = schema.get("exclusiveMinimum");
  const maximum = schema.get("maximum");
  if (isNumber(minimum) && less(number, minimum)) return [new Problem(path, `${name} must be at least ${show(minimum)}`)];
  if (isNumber(exclusive) && lessOrEqual(number, exclusive)) {
    return [new Problem(path, `${name} must be more than ${show(exclusive)}`)];
  }
  if (isNumber(maximum) && less(maximum, number)) return [new Problem(path, `${name} must be at most ${show(maximum)}`)];
  return [];
}

function checkAnyOf(value: Value, branches: Value, path: Path, name: string): Problem[] {
  if (!isList(branches) || branches.length === 0) return [];
  const results = branches.map((branch) => validate(value, branch, path, false));
  if (results.some((result) => result.length === 0)) return [];
  const typed = results.filter((_, index) => !typeMismatch(value, branches[index] as Value));
  if (typed.length === 1) return typed[0] as Problem[];
  return [new Problem(path, `${name} must be ${branches.map(describe).join(" or ")}`)];
}

function typeMismatch(value: Value, schema: Value): boolean {
  if (!isDict(schema)) return false;
  const kinds = schema.get("type");
  if (kinds !== undefined && kinds !== null && !typeNames(kinds).some((kind) => hasType(value, kind))) return true;
  if (schema.has("const")) {
    const constant = schema.get("const") as Value;
    if (jsonType(constant) !== jsonType(value) && !(isNumber(value) && isNumber(constant))) return true;
  }
  if (schema.has("enum") && !iterate(schema.get("enum")).some((option) => jsonType(option) === jsonType(value) || (isNumber(option) && isNumber(value)))) return true;
  return false;
}

function repeated(value: Value[]): Value[] {
  const twice: Value[] = [];
  value.forEach((item, index) => {
    if (twice.some((seen) => jsonEqual(seen, item))) return;
    if (value.slice(0, index).some((earlier) => jsonEqual(earlier, item))) twice.push(item);
  });
  return twice;
}

function checkArray(value: Value[], schema: JsonObject, path: Path, name: string): Problem[] {
  const problems: Problem[] = [];
  const length = BigInt(value.length);
  const minItems = itemCount(schema.get("minItems"));
  const maxItems = itemCount(schema.get("maxItems"));
  if (minItems !== undefined && length < minItems) problems.push(new Problem(path, `${name} must have at least ${minItems} ${items(minItems)}`));
  if (maxItems !== undefined && length > maxItems) problems.push(new Problem(path, `${name} must have at most ${maxItems} ${items(maxItems)}`));
  if (schema.get("uniqueItems") === true) for (const item of repeated(value)) problems.push(new Problem(path, `${name} has ${show(item)} twice`));
  const prefixValue = schema.get("prefixItems");
  const prefix = isList(prefixValue) ? prefixValue : [];
  for (const [index, item] of value.entries()) {
    if (index < prefix.length) problems.push(...validate(item, prefix[index] as Value, [...path, index], false));
    else if (schema.has("items")) {
      const itemSchema = schema.get("items") as Value;
      if (itemSchema === false) {
        const count = BigInt(prefix.length);
        const message = `${name} must have at most ${count} ${items(count)}`;
        if (!problems.some((problem) => problem.message === message)) problems.push(new Problem(path, message));
        break;
      }
      problems.push(...validate(item, itemSchema, [...path, index], false));
    }
  }
  return problems;
}

function checkObject(value: JsonObject, schema: JsonObject, path: Path, name: string, root: boolean, noun: string | undefined): Problem[] {
  const problems: Problem[] = [];
  const propertiesValue = schema.get("properties");
  const properties: JsonObject = isDict(propertiesValue) ? propertiesValue : new Map();
  const requiredValue = schema.get("required");
  const required = isList(requiredValue) ? requiredValue : [];
  for (const key of required) {
    if (typeof key !== "string" || !value.has(key)) problems.push(new Problem(path, `${name} needs ${pyStr(key)}`));
  }
  const names = schema.get("propertyNames");
  const extra = schema.has("additionalProperties") ? (schema.get("additionalProperties") as Value) : true;
  for (const [key, item] of value) {
    if (names !== undefined && names !== null && names !== true) {
      if (validate(key, names, [], false).length > 0) {
        const allowed = isDict(names) && names.has("enum") ? (names.get("enum") as Value) : [];
        problems.push(new Problem([...path, key], `${unknown(key, path, noun)}${didYouMean(key, allowed)}`));
        continue;
      }
    }
    if (properties.has(key)) problems.push(...validate(item, properties.get(key) as Value, [...path, key], false));
    else if (root && key === "$schema") continue;
    else if (extra === false) problems.push(new Problem([...path, key], `${unknown(key, path, noun)}${didYouMean(key, properties)}`));
    else if (isDict(extra)) problems.push(...validate(item, extra, [...path, key], false));
  }
  return problems;
}

export function unknown(key: string, path: Path, noun?: string): string {
  const where = formatPath(path);
  if (noun && !where) return `unknown ${noun} ${key}`;
  return where ? `unknown key ${key} in ${where}` : `unknown key ${key}`;
}

export function charLength(text: string): number {
  return codePoints(text).length;
}

export { get, isFinite };
