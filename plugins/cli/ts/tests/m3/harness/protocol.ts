import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { RunResult } from "./normalize.ts";
import { PROTOCOL_SCHEMA } from "./paths.ts";
import { isPyInt, isRecord, type Json, numeric, pyEqual, pyLoads, PyFloat } from "./pyvalues.ts";

type Node = { [key: string]: unknown };

const TYPES: Record<string, (value: unknown) => boolean> = {
  object: isRecord,
  array: Array.isArray,
  string: (value) => typeof value === "string",
  integer: isPyInt,
  number: (value) => typeof value === "number" || value instanceof PyFloat,
  boolean: (value) => typeof value === "boolean",
  null: (value) => value === null,
};

let loaded: { $defs: Record<string, Node> } | undefined;
const patterns = new Map<string, RegExp>();

function schema(): { $defs: Record<string, Node> } {
  loaded ??= JSON.parse(readFileSync(PROTOCOL_SCHEMA, "utf8")) as { $defs: Record<string, Node> };
  return loaded;
}

function pythonPattern(source: string): RegExp {
  let found = patterns.get(source);
  if (found === undefined) {
    const endAnchored = source.endsWith("$") && !source.endsWith("\\$");
    found = new RegExp(endAnchored ? `${source.slice(0, -1)}(?=\\n?$)` : source, "u");
    patterns.set(source, found);
  }
  return found;
}

function resolve(node: Node): Node {
  while (typeof node["$ref"] === "string") node = schema().$defs[(node["$ref"] as string).replace(/^#\/\$defs\//, "")] as Node;
  return node;
}

function dumped(value: unknown): string {
  return (JSON.stringify(value) ?? "null").slice(0, 80);
}

function errors(value: unknown, given: Node, where = ""): string[] {
  const node = resolve(given);
  const at = where || "/";
  const found: string[] = [];
  if ("type" in node) {
    const kinds = Array.isArray(node["type"]) ? (node["type"] as string[]) : [node["type"] as string];
    if (!kinds.some((kind) => (TYPES[kind] as (value: unknown) => boolean)(value))) return [`${at}: ${dumped(value)} isn't ${kinds.join(" or ")}`];
  }
  if ("const" in node && !pyEqual(value, node["const"])) found.push(`${at}: must be ${JSON.stringify(node["const"])}`);
  if (typeof value === "string") {
    if (typeof node["pattern"] === "string" && !pythonPattern(node["pattern"]).test(value)) found.push(`${at}: ${JSON.stringify(value.slice(0, 80))} doesn't match ${node["pattern"]}`);
    if ([...value].length < Number(node["minLength"] ?? 0)) found.push(`${at}: too short`);
  }
  const number = typeof value === "boolean" ? undefined : numeric(value);
  if (number !== undefined) {
    if (typeof node["minimum"] === "number" && number < node["minimum"]) found.push(`${at}: below ${node["minimum"]}`);
    if (typeof node["maximum"] === "number" && number > node["maximum"]) found.push(`${at}: above ${node["maximum"]}`);
  }
  if (isRecord(value)) {
    for (const key of (node["required"] as string[] | undefined) ?? []) if (!Object.hasOwn(value, key)) found.push(`${where}/${key}: missing`);
    const properties = (node["properties"] as Record<string, Node> | undefined) ?? {};
    const extra = node["additionalProperties"] ?? true;
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) found.push(...errors(item, properties[key] as Node, `${where}/${key}`));
      else if (extra !== null && typeof extra === "object") found.push(...errors(item, extra as Node, `${where}/${key}`));
      else if (extra === false) found.push(`${where}/${key}: not allowed`);
    }
  }
  if (Array.isArray(value) && node["items"] !== undefined) value.forEach((item, index) => found.push(...errors(item, node["items"] as Node, `${where}[${index}]`)));
  if (Array.isArray(node["anyOf"]) && !(node["anyOf"] as Node[]).some((option) => errors(value, option, where).length === 0)) found.push(`${at}: matches none of its forms`);
  return found;
}

export function check(kind: string, value: unknown): string[] {
  return errors(value, schema().$defs[kind] as Node).map((line) => `${kind} ${line}`);
}

export function violations(result: RunResult): string[] {
  const found: string[] = [];
  result.steps.forEach((step, index) => {
    for (const item of Array.isArray(step.answers) ? step.answers : []) {
      if (!isRecord(item)) continue;
      if ("wire" in item) found.push(...check("request", item["wire"]).map((line) => `step ${index}: ${line}`));
      if (isRecord(item["answer"])) found.push(...check("answer", item["answer"]).map((line) => `step ${index}: ${line}`));
    }
  });
  const config = path.join(result.root, "home", "spawn-config.jsonl");
  if (existsSync(config)) {
    for (const line of readFileSync(config, "utf8").split(/\r\n|\r|\n/)) if (line) found.push(...check("config", pyLoads(line) as Json));
  }
  return found;
}
