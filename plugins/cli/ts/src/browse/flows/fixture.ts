import fs from "node:fs";
import path from "node:path";
import { dumps, Float, type Value } from "../../json.ts";
import { redact } from "../../redact.ts";
import { BrowseError } from "../daemon-errors.ts";
import { pyValue } from "../daemon/render.ts";
import * as shaping from "../shape.ts";
import { embeddedJson, type Spec } from "./flowlog.ts";

type Json = Record<string, any>;

export const DRIFT_LIMIT = 20;
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu;
const STYLE = /<style\b[^>]*>[\s\S]*?<\/style\s*>/giu;
const REDACTED = "<redacted>";

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function kindOf(value: Value | undefined): string {
  if (value instanceof Map) return "object";
  if (Array.isArray(value)) return "array";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "bigint" || value instanceof Float) return "number";
  if (value === null || value === undefined) return "null";
  return "string";
}

function joined(at: string, key: string): string {
  return at ? `${at}.${key}` : key;
}

export function driftReport(recorded: unknown, value: Value | undefined, at = "", out: string[] = []): string[] {
  if (out.length >= DRIFT_LIMIT) return out;
  const where = at || "the answer";
  if (isObject(recorded)) {
    if (!(value instanceof Map)) {
      out.push(`${where} is no longer an object`);
      return out;
    }
    for (const [key, inner] of Object.entries(recorded)) {
      if (key === "*") continue;
      if (!value.has(key)) out.push(`${joined(at, key)} is missing`);
      else driftReport(inner, value.get(key), joined(at, key), out);
      if (out.length >= DRIFT_LIMIT) break;
    }
    return out;
  }
  if (Array.isArray(recorded)) {
    if (!Array.isArray(value)) out.push(`${where} is no longer a list`);
    else if (recorded.length > 0 && value.length > 0) driftReport(recorded[0], value[0], `${at}[0]`, out);
    return out;
  }
  if (recorded === "object" || recorded === "array") {
    if (kindOf(value) !== recorded) out.push(`${where} is no longer ${recorded === "object" ? "an object" : "a list"}`);
    return out;
  }
  if (recorded === "null" || recorded === "any" || value === null || value === undefined) return out;
  const now = kindOf(value);
  const shown = now === "object" ? "an object" : now === "array" ? "a list" : `a ${now}`;
  if (now !== recorded) out.push(`${where} was a ${String(recorded)}, now ${shown}`);
  return out;
}

export function lostFields(itemFields: readonly string[], value: Value, list: string | null): string[] {
  if (!list || itemFields.length === 0) return [];
  const items = shaping.lookup(value, list);
  if (!Array.isArray(items) || items.length === 0) return [];
  const present = new Set(shaping.itemFields(items));
  return itemFields.filter((field) => !present.has(field));
}

export function shapeDrift(expect: Json, value: Value): string[] {
  const found = driftReport(expect["signature"], value);
  const list = typeof expect["list"] === "string" ? expect["list"] : null;
  if (list && !Array.isArray(shaping.lookup(value, list))) found.push(`the list ${list} is gone`);
  else for (const field of lostFields(expect["itemFields"] ?? [], value, list)) found.push(`items in ${list} lost ${field}`);
  return found.slice(0, DRIFT_LIMIT);
}

function scrub(text: string, secrets: readonly string[]): string {
  let out = redact(text);
  for (const secret of secrets) if (secret) out = out.replaceAll(secret, REDACTED);
  return out;
}

export function fixturePage(html: string, secrets: readonly string[] = []): string {
  const trimmed = html.replace(STYLE, "").replace(SCRIPT, (whole: string, attrs: string, body: string) => {
    if (embeddedJson(whole).length > 0) return whole;
    return body.trim() ? `<script${attrs}></script>` : whole;
  });
  return scrub(trimmed, secrets);
}

export const EXTRACT_SOURCE = `const SCRIPT = /<script\\b([^>]*)>([\\s\\S]*?)<\\/script\\s*>/giu;
const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\\s*=\\s*("[^"]*"|'[^']*'|[^\\s"'>]+)/gu;
const ASSIGNED = /^\\s*(?:(?:window|self|globalThis)\\.|var\\s+|let\\s+|const\\s+)?([A-Za-z_$][\\p{L}\\p{N}_$.]*(?:\\[\\s*['"][^'"]+['"]\\s*\\])*)\\s*=\\s*([\\s\\S]+?)\\s*;?\\s*$/u;

function attributes(text) {
  const found = {};
  for (const match of text.matchAll(ATTRIBUTE)) found[match[1].toLowerCase()] = match[2].replace(/^["']+|["']+$/gu, "");
  return found;
}

export function blocks(html) {
  const out = [];
  let index = 0;
  for (const match of html.matchAll(SCRIPT)) {
    const attrs = attributes(match[1]);
    const kind = (attrs.type ?? "").toLowerCase();
    if (kind && !kind.includes("json") && !["text/javascript", "application/javascript", "module"].includes(kind)) continue;
    let content = match[2].trim();
    if (!kind.includes("json")) {
      const assigned = ASSIGNED.exec(content);
      if (!assigned) continue;
      content = assigned[2].trim();
    }
    if (!content.startsWith("{") && !content.startsWith("[")) continue;
    let value;
    try {
      value = JSON.parse(content);
    } catch {
      continue;
    }
    out.push({ spec: attrs.id ? { scriptId: attrs.id } : { scriptIndex: index }, value });
    index += 1;
  }
  return out;
}

export function extract(text) {
  if (expected.kind !== "document") return JSON.parse(text);
  for (const block of blocks(text)) {
    if (("scriptId" in spec && block.spec.scriptId === spec.scriptId) || ("scriptIndex" in spec && block.spec.scriptIndex === spec.scriptIndex)) return block.value;
  }
  return null;
}

function kindOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") return "object";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

function lookup(value, path) {
  let current = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

export function drift(recorded, value, at = "", out = []) {
  const where = at || "the answer";
  if (recorded !== null && typeof recorded === "object" && !Array.isArray(recorded)) {
    if (kindOf(value) !== "object") return [...out, where + " is no longer an object"];
    for (const [key, inner] of Object.entries(recorded)) {
      if (key === "*") continue;
      const next = at ? at + "." + key : key;
      if (!(key in value)) out.push(next + " is missing");
      else drift(inner, value[key], next, out);
    }
    return out;
  }
  if (Array.isArray(recorded)) {
    if (!Array.isArray(value)) out.push(where + " is no longer a list");
    else if (recorded.length > 0 && value.length > 0) drift(recorded[0], value[0], at + "[0]", out);
    return out;
  }
  if (recorded === "object" || recorded === "array") {
    if (kindOf(value) !== recorded) out.push(where + " is no longer " + (recorded === "object" ? "an object" : "a list"));
    return out;
  }
  if (recorded === "null" || recorded === "any" || value === null || value === undefined) return out;
  if (kindOf(value) !== recorded) out.push(where + " was a " + recorded + ", now a " + kindOf(value));
  return out;
}

export function check(text) {
  const value = extract(text);
  if (value === null) return ["the page no longer holds the recorded JSON block"];
  const found = drift(expected.signature, value);
  if (expected.list) {
    const items = lookup(value, expected.list);
    if (!Array.isArray(items)) found.push("the list " + expected.list + " is gone");
    else if (items.length > 0) {
      const present = new Set(items.flatMap((item) => (item && typeof item === "object" && !Array.isArray(item) ? Object.keys(item) : [])));
      for (const field of expected.itemFields) if (!field.includes(".") && !present.has(field)) found.push("items in " + expected.list + " lost " + field);
    }
  }
  return found;
}

export function items(text) {
  const value = extract(text);
  return expected.list ? lookup(value, expected.list) ?? [] : value;
}
`;

export function testSource(sample: string): string {
  return `import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { check, items } from "./extract.mjs";

const page = readFileSync(new URL("./${sample}", import.meta.url), "utf8");

test("the saved page still has the recorded shape", () => {
  assert.deepEqual(check(page), []);
});

test("the saved page yields the recorded items", () => {
  const found = items(page);
  assert.ok(Array.isArray(found) ? found.length > 0 : found !== null);
});
`;
}

export type FixtureFiles = Record<string, string>;

export function fixtureFiles(flow: Json, request: Json, text: string, secrets: readonly string[] = []): FixtureFiles {
  const expect = request["expect"] ?? {};
  const kind = request["kind"] === "document" ? "document" : "json";
  const spec: Spec = (expect["extract"] as Spec | undefined) ?? {};
  const expected = { kind, signature: expect["signature"] ?? null, list: expect["list"] ?? null, itemFields: expect["itemFields"] ?? [] };
  const sample = kind === "document" ? "page.html" : "answer.json";
  const header = `export const expected = ${JSON.stringify(expected, null, 1)};\nexport const spec = ${JSON.stringify(spec)};\n`;
  const body = kind === "document" ? fixturePage(text, secrets) : scrub(text, secrets);
  return {
    [sample]: body,
    "extract.mjs": `${header}\n${EXTRACT_SOURCE}`,
    "extract.test.mjs": testSource(sample),
    "flow.json": dumps(pyValue(flow), "indented", false, false, 1),
  };
}

export function writeFixture(dir: string, files: FixtureFiles): string[] {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const written: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(dir, name);
      try {
        if (fs.lstatSync(target).isSymbolicLink()) throw new BrowseError(`${target} is a link; pick an empty folder for --fixture`, null, "fixture_unsafe");
      } catch (error) {
        if (error instanceof BrowseError) throw error;
      }
      fs.writeFileSync(target, content, { mode: 0o600 });
      written.push(target);
    }
    return written;
  } catch (error) {
    if (error instanceof BrowseError) throw error;
    throw new BrowseError(`Couldn't write the fixture to ${dir}: ${error instanceof Error ? error.message : String(error)}`, null, "fixture_failed");
  }
}
