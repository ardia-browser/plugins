import type { Args } from "./cli-command.ts";
import * as files from "./config-files.ts";
import type { JsonObject, Value } from "./json.ts";
import { NeedsPython } from "./paths.ts";
import { truthy } from "./py.ts";
import { loads } from "./pyjson.ts";
import { codePoints } from "./pystr.ts";
import { isDict, isList, isNumber, isStr, less, pyEqual, pyStr } from "./pyvalue.ts";
import { formatPath, validate } from "./schema-check.ts";
import { v2Defaults, v2Problems } from "./plugin-v2.ts";
import shippedSchema from "../assets/plugin.schema.json" with { type: "text" };

export const MANIFEST = "plugin.json";
export const SCHEMA = "plugin.schema.json";
const NAME = /^[a-z0-9][a-z0-9-]{0,39}\n?$/u;
const SIDES = ["left", "right", "top", "bottom"];
const SAFE_TEXT = /must match \^\(\?=[^\n]*\]\{1,(\d+)\}\$$/u;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

export function isPluginName(name: string): boolean {
  return NAME.test(name);
}

function dictOr(value: Value | undefined): JsonObject {
  if (value === undefined || !truthy(value)) return new Map();
  if (!isDict(value)) throw new NeedsPython("a schema part that isn't an object");
  return value;
}

function wellFormed(value: string): boolean {
  return !LONE_SURROGATE.test(value);
}

function contains(values: Value[], wanted: Value | undefined): boolean {
  return values.some((value) => pyEqual(value, wanted));
}

function isPluginPath(value: Value | undefined): boolean {
  if (typeof value !== "string" || !value || !wellFormed(value) || Buffer.byteLength(value, "utf8") > 1024 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function named(items: Value | undefined): JsonObject[] {
  return isList(items) ? items.filter(isDict) : [];
}

function duplicates(values: (Value | undefined)[]): string[] {
  const seen: Value[] = [];
  const twice: string[] = [];
  for (const value of values) {
    if (isList(value) || isDict(value)) throw new NeedsPython("an unhashable name");
    if (typeof value === "string" && contains(seen, value) && !twice.includes(value)) twice.push(value);
    seen.push(value ?? null);
  }
  return twice;
}

function list(value: Value | undefined): Value[] {
  return isList(value) ? value : [];
}

function stringsOf(value: Value | undefined): Value[] {
  if (value === undefined) return [];
  if (isList(value)) return value;
  throw new NeedsPython("a rules list that isn't a list");
}

function rowProblems(rows: JsonObject[]): string[] {
  const problems: string[] = [];
  rows.forEach((row, index) => {
    const at = `settings.rows[${index}]`;
    const kind = row.get("type");
    const fallback = row.get("default");
    if (kind !== "choice" && row.has("choices")) problems.push(`${at}.choices only goes with type choice`);
    if (kind === "toggle" && typeof fallback !== "boolean") problems.push(`${at}.default must be true or false`);
    if (kind === "text" && (typeof fallback !== "string" || codePoints(fallback).length > 200)) problems.push(`${at}.default must be text of at most 200 characters`);
    if (kind === "choice") {
      const choices = named(row.get("choices")).map((choice) => choice.get("value") ?? null);
      if (!row.has("choices")) problems.push(`${at}.choices must be a list of 2 to 12 choices`);
      if (!contains(choices, fallback ?? null)) problems.push(`${at}.default must be one of its choices' values`);
      for (const value of duplicates(choices)) problems.push(`${at}.choices has two choices named ${value}`);
    }
  });
  return problems;
}

function commandProblems(commands: JsonObject[], rows: JsonObject[], tools: JsonObject[], page: JsonObject | undefined, permissions: Value[]): string[] {
  const problems: string[] = [];
  const toolNames = tools.map((tool) => tool.get("name") ?? null);
  commands.forEach((command, index) => {
    const at = `commands[${index}]`;
    const hasTool = command.has("tool");
    const hasOpen = command.has("open");
    if (hasTool === hasOpen) {
      problems.push(`${at} needs either tool (one of the plugin's tools) or open ("tab" or "split")`);
      return;
    }
    if (hasTool) {
      for (const key of ["context", "side", "sideSetting", "path"]) if (command.has(key)) problems.push(`${at}.${key} only goes with open`);
      if (!contains(toolNames, command.get("tool"))) problems.push(`${at}.tool: ${pyStr(command.get("tool") as Value)} isn't one of this plugin's tools`);
      return;
    }
    if (command.has("input")) problems.push(`${at}.input only goes with tool`);
    if (command.get("open") !== "split" && (command.has("side") || command.has("sideSetting"))) problems.push(`${at}: side and sideSetting only go with open: split`);
    if (page === undefined) problems.push(`${at}.open needs a page`);
    if (command.get("context") === true && !contains(permissions, "tabs")) problems.push(`${at}.context needs the tabs permission`);
    if (command.has("sideSetting")) {
      const row = rows.find((candidate) => pyEqual(candidate.get("key") ?? null, command.get("sideSetting")));
      const sided = row !== undefined && row.get("type") === "choice" && named(row.get("choices")).every((choice) => contains(SIDES, choice.get("value") ?? null));
      if (!sided) problems.push(`${at}.sideSetting must name a choice row whose values are left, right, top or bottom`);
    }
  });
  return problems;
}

function ruleProblems(doc: JsonObject, rules: JsonObject): string[] {
  const permissions = list(doc.get("permissions"));
  const settingsValue = doc.get("settings");
  const settings: JsonObject = isDict(settingsValue) ? settingsValue : new Map();
  const defaultsValue = settings.get("defaults");
  const defaults: JsonObject = isDict(defaultsValue) ? defaultsValue : new Map();
  const rows = named(settings.get("rows"));
  const tools = named(doc.get("tools"));
  const commands = named(doc.get("commands"));
  const pageValue = doc.get("page");
  const page = isDict(pageValue) ? pageValue : undefined;
  const processValue = doc.get("process");
  const process = isDict(processValue) ? processValue : undefined;
  const hooks = list(doc.get("hooks"));
  const problems: string[] = [];
  if (contains(permissions, "fullUrls") && !contains(permissions, "tabs")) problems.push("permissions: fullUrls needs tabs");
  for (const key of stringsOf(rules.get("approvedSettings"))) {
    if (typeof key === "string" && defaults.has(key)) problems.push(`settings.defaults: ${key} needs its own approval in Settings, so a plugin can't set it`);
  }
  problems.push(...rowProblems(rows));
  const groups: [string, string, (Value | undefined)[]][] = [
    ["settings.rows", "rows", rows.map((row) => row.get("key"))],
    ["tools", "tools", tools.map((tool) => tool.get("name"))],
    ["commands", "commands", commands.map((command) => command.get("name"))],
  ];
  for (const [where, what, values] of groups) for (const value of duplicates(values)) problems.push(`${where} has two ${what} named ${value}`);
  problems.push(...commandProblems(commands, rows, tools, page, permissions));
  if (page !== undefined) {
    if (page.has("served")) problems.push("page.served is gone: a page is static files from the plugin's folder (page.file), and it talks to its helper with window.ardia.send");
    else if (!isPluginPath(page.get("file"))) problems.push("page.file must be a path inside the plugin's folder, like page/index.html");
    if (contains(stringsOf(rules.get("reservedPageNames")), doc.get("name") ?? null)) {
      problems.push(`name: ${pyStr(doc.get("name") ?? null)} is one of Ardia's own pages (ardia://${pyStr(doc.get("name") ?? null)}), so a plugin with a page can't use it`);
    }
  }
  if (process !== undefined) {
    const run = process.get("run");
    if (isList(run) && run.some((arg) => typeof arg === "string" && !wellFormed(arg))) problems.push("process.run has an argument that isn't well-formed Unicode");
    const program = isList(run) && run.length > 0 && typeof run[0] === "string" ? run[0] : undefined;
    if (program && !program.startsWith("/") && program.includes("/") && !isPluginPath(program)) {
      problems.push("process.run[0] must be a file in the plugin's folder, an absolute path or a program name");
    }
  } else {
    const needs: [string, boolean][] = [
      ["tool commands", commands.some((command) => command.has("tool"))],
      ["tools", tools.length > 0],
      ["hooks", hooks.length > 0],
    ];
    for (const [what, used] of needs) if (used) problems.push(`${what} needs a process`);
  }
  const untabbed = stringsOf(rules.get("untabbedEvents"));
  hooks.forEach((hook, index) => {
    if (typeof hook === "string" && !contains(untabbed, hook) && !contains(permissions, "tabs")) problems.push(`hooks[${index}]: ${hook} needs the tabs permission`);
  });
  return problems;
}

function shownRule(message: string): string {
  const safe = SAFE_TEXT.exec(message);
  return safe ? `${message.slice(0, safe.index)}must be text of 1 to ${safe[1]} characters, without control or direction characters` : message;
}

function schemaProblems(where: files.Places, doc: JsonObject, schema: JsonObject): string[] {
  const problems = validate(doc, schema).map((problem) => `${formatPath(problem.path) || "plugin.json"}: ${shownRule(problem.message)}`);
  const config = files.findSchema(where, "config.schema.json").document;
  const settingsSchema = dictOr(dictOr(config).get("properties")).get("settings");
  const declared = doc.get("manifest");
  const current = typeof declared === "bigint" && declared > LEGACY_MANIFEST;
  const settings = doc.get("settings");
  const defaults = current ? v2Defaults(doc) : isDict(settings) ? settings.get("defaults") : undefined;
  const label = current ? "contributes.settings.defaults" : "settings.defaults";
  if (isDict(defaults) && defaults.size > 0 && !isDict(settingsSchema)) {
    problems.push(`${label} can't be checked: Ardia hasn't written config.schema.json for this data folder yet (open Ardia once)`);
  } else if (isDict(settingsSchema) && isDict(defaults)) {
    for (const problem of validate(defaults, settingsSchema)) problems.push(`${label}: ${problem.message}`);
  }
  return problems;
}

export function pluginSchema(where: files.Places): JsonObject {
  const written = files.findSchema(where, SCHEMA).document;
  if (written !== undefined) return written;
  const shipped = loads(shippedSchema as unknown as string);
  if (!isDict(shipped)) throw new NeedsPython("a shipped plugin schema that isn't an object");
  return shipped;
}

function numberText(value: Value): string {
  return pyStr(value);
}

const LEGACY_MANIFEST = 1n;

function manifestCeiling(schema: JsonObject): bigint {
  const found: bigint[] = [];
  for (const branch of [schema, schema.get("then"), schema.get("else")]) {
    const properties = isDict(branch) ? branch.get("properties") : undefined;
    const spec = isDict(properties) ? properties.get("manifest") : undefined;
    for (const key of ["maximum", "const"]) {
      const value = isDict(spec) ? spec.get(key) : undefined;
      if (typeof value === "bigint") found.push(value);
    }
  }
  return found.length === 0 ? 1n : found.reduce((high, value) => (value > high ? value : high));
}

function currentManifest(manifest: JsonObject, known: bigint): [JsonObject | undefined, string[]] {
  const given = manifest.get("manifest");
  if (manifest.has("manifest") && (typeof given === "boolean" || typeof given !== "bigint" || given < 0n)) return [undefined, ["manifest must be a whole number, the manifest's version"]];
  if (given !== undefined && given !== null) {
    if (!isNumber(known) && typeof known !== "boolean") throw new NeedsPython("a manifest maximum that isn't a number");
    if (less(known, given as bigint)) return [undefined, [`manifest ${String(given)} needs a newer Ardia (this one reads up to ${numberText(known)})`]];
  }
  if (typeof given === "bigint" && given !== 0n) return [manifest, []];
  const doc: JsonObject = new Map([...manifest].filter(([key]) => key !== "settings" && key !== "reset"));
  if (manifest.has("settings")) doc.set("settings", new Map<string, Value>([["defaults", manifest.get("settings") as Value]]));
  doc.set("manifest", known < LEGACY_MANIFEST ? known : LEGACY_MANIFEST);
  return [doc, []];
}

export function manifestProblems(args: Args, manifest: JsonObject): string[] {
  const where = files.places(args["data_dir"] as string | undefined);
  const schema = pluginSchema(where);
  const [doc, early] = currentManifest(manifest, manifestCeiling(schema));
  if (doc === undefined) return early;
  const problems = [...early, ...schemaProblems(where, doc, schema)];
  if (problems.length === 0) {
    const declared = doc.get("manifest");
    const legacy = declared === undefined || (typeof declared === "bigint" && declared <= LEGACY_MANIFEST);
    problems.push(...(legacy ? ruleProblems(doc, dictOr(schema.get("x-ardia-rules"))) : v2Problems(doc, dictOr(schema.get("x-ardia-rules")))));
  }
  const name = doc.get("name");
  if (typeof name !== "string" || !NAME.test(name)) problems.push("name must be 1 to 40 lowercase letters, digits and dashes, starting with a letter or digit");
  return [...new Set(problems)];
}

export { isStr };
