import fs from "node:fs";
import { type Args, type Io } from "./cli-command.ts";
import { cell, guarded, type Handler, json, parseValue, pretty, writeRaw } from "./config-cli.ts";
import * as files from "./config-files.ts";
import { ConfigError, Exists, type Places } from "./config-files.ts";
import type { JsonObject, Value } from "./json.ts";
import { expandUser, purePath } from "./paths.ts";
import { JsonDecodeError, JsonValueError } from "./pyjson.ts";
import { exists, isFile, lexists, mkdirs, PyOSError } from "./pyos.ts";
import { copy, isDict, pyEqual, reprText } from "./pyvalue.ts";
import { didYouMean, formatPath, type Path, type PathPart, type Problem } from "./schema-check.ts";
import { checkThemeFile, LOOK_NOUNS, lookSpecs, report, themeProblems, unknownKey } from "./theme-check.ts";

const CUSTOM_THEME = "custom";

function themeSchema(where: Places, io: Io): files.Schema {
  const found = files.findSchema(where, files.THEME_SCHEMA);
  if (found.warning) io.complain(`ardia theme: ${found.warning}`);
  return found;
}

function themeDefaults(schema: JsonObject | undefined, mode: string): JsonObject {
  const found: JsonObject = new Map();
  for (const [role, spec] of files.roleSpecs(schema, mode)) if (isDict(spec) && spec.has("default") && role !== "dark") found.set(role, spec.get("default") as Value);
  return found;
}

export function lookDefault(spec: JsonObject): Value | undefined {
  if (spec.has("default")) return copy(spec.get("default") as Value);
  const properties = spec.get("properties");
  if (!isDict(properties)) return undefined;
  const defaults: JsonObject = new Map();
  for (const [key, child] of properties) {
    const value = isDict(child) ? lookDefault(child) : undefined;
    if (value !== undefined) defaults.set(key, value);
  }
  return defaults;
}

function lookDefaults(schema: JsonObject | undefined): JsonObject {
  const defaults: JsonObject = new Map();
  for (const [key, spec] of lookSpecs(schema)) {
    const value = lookDefault(spec as JsonObject);
    if (value !== undefined) defaults.set(key, value);
  }
  return defaults;
}

function merged(fallback: Value, given: Value): Value {
  if (!isDict(fallback)) return copy(given);
  if (!isDict(given)) return fallback;
  const result: JsonObject = new Map(fallback);
  for (const [key, value] of given) result.set(key, fallback.has(key) ? merged(fallback.get(key) as Value, value) : copy(value));
  return result;
}

function themeNew(args: Args, where: Places, io: Io): number {
  const name = args["name"] as string;
  files.checkThemeName(name);
  const target = where.theme(name);
  if (lexists(target)) throw new ConfigError(`${target} already exists`);
  const schema = files.findSchema(where, files.THEME_SCHEMA);
  if (schema.warning) io.complain(`ardia theme: ${schema.warning}`);
  const sourceName = args["source"] as string | undefined;
  if (sourceName === undefined && schema.document === undefined) {
    throw new ConfigError(`no ${files.THEME_SCHEMA} found, so Ardia's colours aren't known yet; open Ardia once (it writes the schema), or use --from THEME`);
  }
  let source: JsonObject = new Map();
  if (sourceName !== undefined) {
    files.checkThemeName(sourceName);
    const path = where.theme(sourceName);
    try {
      source = files.readObject(path, where.show(path));
    } catch (error) {
      if (error instanceof PyOSError && error.notFound) throw new ConfigError(`no theme named ${sourceName}${didYouMean(sourceName, files.themeNames(where))}`);
      throw error;
    }
  }
  const document: JsonObject = new Map<string, Value>([["$schema", `../${files.THEME_SCHEMA}`]]);
  for (const mode of files.MODES) {
    const givenValue = source.get(mode);
    const given: JsonObject = isDict(givenValue) ? givenValue : new Map();
    const roles: JsonObject = new Map();
    for (const [role, fallback] of themeDefaults(schema.document, mode)) roles.set(role, given.has(role) ? (given.get(role) as Value) : fallback);
    for (const [role, value] of given) if (!roles.has(role)) roles.set(role, value);
    document.set(mode, roles);
  }
  for (const [key, fallback] of lookDefaults(schema.document)) document.set(key, source.has(key) ? merged(fallback, source.get(key) as Value) : fallback);
  for (const [key, value] of source) if (!document.has(key)) document.set(key, value);
  mkdirs(where.themes, true, true);
  try {
    files.writeJson(target, document, false);
  } catch (error) {
    if (error instanceof Exists) throw new ConfigError(`${target} already exists`);
    throw error;
  }
  io.say(target);
  return 0;
}

function existingTheme(where: Places, name: string): string {
  files.checkThemeName(name);
  const path = where.theme(name);
  if (!exists(path)) throw new ConfigError(`no theme named ${name} in ${where.themes}${didYouMean(name, files.themeNames(where))} (ardia theme new ${name} makes one)`);
  return path;
}

function activate(where: Places, name: string | null, io: Io): void {
  const [loaded, created] = files.loadConfig(where, true);
  const document = files.withKey(loaded, "theme", name, "$schema");
  files.saveConfig(where, document, created);
  if (created) io.complain(`ardia theme: created ${where.config}`);
}

function activeTheme(where: Places): string | undefined {
  let document: JsonObject;
  try {
    document = files.readObject(where.config, files.CONFIG_FILE);
  } catch (error) {
    if (error instanceof PyOSError && error.notFound) return undefined;
    throw error;
  }
  const theme = document.get("theme");
  return files.isThemeName(theme) ? theme : undefined;
}

function themeUse(args: Args, where: Places, io: Io): number {
  const name = args["name"] === "none" ? null : (args["name"] as string);
  const path = name !== null ? existingTheme(where, name) : undefined;
  activate(where, name, io);
  if (name === null) {
    io.say("theme: none (Ardia's own palette)");
    return 0;
  }
  const schema = files.findSchema(where, files.THEME_SCHEMA);
  for (const problem of checkThemeFile(where, path as string, schema.document)) io.complain(`warning: ${where.show(path as string)}: ${problem.message}`);
  io.say(`theme: ${name}`);
  return 0;
}

function themeList(args: Args, where: Places, io: Io): number {
  let active: string | undefined;
  try {
    active = activeTheme(where);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.complain(`ardia theme: ${error.message}`);
    active = undefined;
  }
  const names = files.themeNames(where);
  const missing = active !== undefined && !names.includes(active);
  if (args["json"]) {
    const rows = names.map(
      (name) =>
        new Map<string, Value>([
          ["name", name],
          ["path", where.theme(name)],
          ["active", name === active],
        ]),
    );
    io.say(
      pretty(
        new Map<string, Value>([
          ["active", active ?? null],
          ["missing", missing],
          ["themes", rows],
        ]),
      ),
    );
    return 0;
  }
  for (const name of names) io.say(`${name === active ? "*" : " "} ${name}`);
  if (missing) io.say(`* ${active} (missing: no ${where.show(where.theme(active as string))})`);
  if (names.length === 0 && !missing) io.complain(`ardia theme: no themes in ${where.themes} yet (ardia theme new NAME makes one)`);
  return 0;
}

function themeCheck(args: Args, where: Places, io: Io): number {
  let target = args["target"] as string | undefined;
  if (target === undefined) {
    target = activeTheme(where);
    if (target === undefined) throw new ConfigError("config.json names no theme; give a NAME or FILE");
  }
  let path: string;
  if (files.isThemeName(target)) {
    path = where.theme(target);
    if (!exists(path) && !isFile(purePath(target))) throw new ConfigError(`no theme named ${target}${didYouMean(target, files.themeNames(where))}`);
    if (!exists(path)) path = purePath(target);
  } else {
    path = purePath(expandUser(target));
    if (!exists(path)) throw new ConfigError(`${path} doesn't exist`);
  }
  const schema = files.findSchema(where, files.THEME_SCHEMA);
  const warnings = schema.warning ? [schema.warning] : [];
  if (schema.document === undefined) warnings.push(`no ${files.THEME_SCHEMA} found, so unknown colour roles weren't checked`);
  return report([[path, where.show(path), checkThemeFile(where, path, schema.document)]], warnings, Boolean(args["json"]), io);
}

function themeKey(key: string): string[] {
  const dot = key.indexOf(".");
  const head = dot < 0 ? key : key.slice(0, dot);
  const path = head === "icons" && dot >= 0 ? [head, key.slice(dot + 1)] : key.split(".");
  if (path.some((part) => part === "") || head === "$schema") {
    throw new ConfigError(`${reprText(key)} isn't a theme key; write a dotted path like dark.accent, metrics.rowHeight or icons.plus`);
  }
  return path;
}

function modeSpec(schema: JsonObject | undefined, mode: string): JsonObject {
  if (schema === undefined) return new Map<string, Value>([["type", "object"]]);
  const properties: JsonObject = new Map([...files.roleSpecs(schema, mode)].filter(([role]) => role !== "dark"));
  return new Map<string, Value>([
    ["type", "object"],
    ["properties", properties],
  ]);
}

function unknownKeyAt(parent: string[], key: string, known: string[]): string {
  if (parent.length === 0) return unknownKey(key, "theme", key, known);
  const name = formatPath(parent);
  if (parent.length === 1 && files.MODES.includes(parent[0] as string)) return `${name}.${key} isn't a colour role${didYouMean(key, known)}`;
  return unknownKey(`${name}.${key}`, LOOK_NOUNS[name] ?? (parent.at(-1) as string), key, known);
}

function keySpec(schema: JsonObject | undefined, path: string[]): [JsonObject | undefined, string | undefined] {
  const top: JsonObject = new Map();
  for (const mode of files.MODES) top.set(mode, modeSpec(schema, mode));
  for (const [key, spec] of lookSpecs(schema)) top.set(key, spec);
  let level: JsonObject = new Map<string, Value>([["properties", top]]);
  for (const [depth, part] of path.entries()) {
    const properties = level.get("properties");
    let next: Value | undefined;
    if (isDict(properties)) {
      if (!properties.has(part)) return [undefined, unknownKeyAt(path.slice(0, depth), part, [...properties.keys()])];
      next = properties.get(part);
    } else if (isDict(level.get("additionalProperties"))) next = level.get("additionalProperties");
    else return [undefined, undefined];
    if (!isDict(next)) return [undefined, undefined];
    level = next;
  }
  return [level, undefined];
}

function themeValue(document: JsonObject, path: string[]): Value | undefined {
  let value: Value = document;
  for (const part of path) {
    if (!isDict(value) || !value.has(part)) return undefined;
    value = value.get(part) as Value;
  }
  return value;
}

function withThemeValue(document: JsonObject, path: string[], value: Value, label: string): JsonObject {
  const updated = copy(document) as JsonObject;
  let holder = updated;
  for (const [depth, part] of path.slice(0, -1).entries()) {
    if (!holder.has(part)) holder.set(part, new Map());
    const child = holder.get(part);
    if (!isDict(child)) throw new ConfigError(`${formatPath(path.slice(0, depth + 1))} in ${label} isn't an object; fix it or unset it first`);
    holder = child;
  }
  holder.set(path.at(-1) as string, value);
  return updated;
}

function overlaps(left: Path, right: Path): boolean {
  const shorter = Math.min(left.length, right.length);
  for (let index = 0; index < shorter; index += 1) if ((left[index] as PathPart) !== right[index]) return false;
  return true;
}

function chosenTheme(args: Args, where: Places): string | undefined {
  const theme = args["theme"] as string | undefined;
  if (theme !== undefined) {
    files.checkThemeName(theme);
    return theme;
  }
  return activeTheme(where);
}

function namedTheme(args: Args, where: Places): [string, string] {
  const name = chosenTheme(args, where);
  if (name === undefined) throw new ConfigError("config.json names no theme; pass --theme NAME (ardia theme list shows them)");
  return [name, existingTheme(where, name)];
}

function removeIfUnchanged(path: string, written: JsonObject): void {
  try {
    if (pyEqual(files.parseJson(files.readText(path)), written)) fs.unlinkSync(path);
  } catch (error) {
    if (error instanceof JsonDecodeError || error instanceof JsonValueError || error instanceof PyOSError) return;
    if (typeof (error as { code?: unknown }).code === "string") return;
    throw error;
  }
}

function themeSet(args: Args, where: Places, io: Io): number {
  const key = args["key"] as string;
  const path = themeKey(key);
  const schema = themeSchema(where, io);
  let name = chosenTheme(args, where);
  const creating = name === undefined;
  let target: string;
  let document: JsonObject;
  if (creating) {
    name = CUSTOM_THEME;
    target = where.theme(name);
    if (lexists(target)) {
      throw new ConfigError(`config.json names no theme and ${where.show(target)} already exists; ardia theme use ${name} makes it active, or pass --theme NAME`);
    }
    files.loadConfig(where, true);
    document = new Map<string, Value>([["$schema", `../${files.THEME_SCHEMA}`]]);
  } else {
    target = existingTheme(where, name as string);
    document = files.readObject(target, where.show(target));
  }
  const label = where.show(target);
  let chosen: Value | undefined;
  let updated: JsonObject = document;
  let firstProblems: Problem[] | undefined;
  for (const candidate of parseValue(args["value"] as string)) {
    updated = withThemeValue(document, path, candidate, label);
    if (schema.document === undefined) {
      chosen = candidate;
      break;
    }
    const problems = themeProblems(updated, schema.document).filter((problem) => overlaps(problem.path, path));
    if (problems.length === 0) {
      chosen = candidate;
      break;
    }
    firstProblems = firstProblems ?? problems;
  }
  if (chosen === undefined) {
    io.noteError("invalid_value");
    for (const problem of firstProblems ?? []) io.complain(`ardia theme: ${problem.message}`);
    return 1;
  }
  if (creating) {
    mkdirs(where.themes, true, true);
    try {
      files.writeJson(target, updated, false);
    } catch (error) {
      if (error instanceof Exists) throw new ConfigError(`${target} appeared while this ran; run the command again`);
      throw error;
    }
    try {
      activate(where, name as string, io);
    } catch (error) {
      if (error instanceof ConfigError || error instanceof PyOSError || error instanceof Exists) removeIfUnchanged(target, updated);
      throw error;
    }
    io.complain(`ardia theme: no theme was active, so this created ${label} and made it the active theme`);
  } else {
    files.writeJson(target, updated);
    if (args["theme"] !== undefined) {
      let active: string | undefined;
      try {
        active = activeTheme(where);
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        active = name;
      }
      if (active !== name) io.complain(`ardia theme: ${name} isn't the active theme, so Ardia won't show this until ardia theme use ${name}`);
    }
  }
  if (schema.document === undefined) io.complain(`ardia theme: no ${files.THEME_SCHEMA} found (Ardia writes one at launch), so ${key} was written without checking it`);
  io.say(`${key} = ${json(chosen)}`);
  return 0;
}

function themeGet(args: Args, where: Places, io: Io): number {
  const key = args["key"] as string | undefined;
  const path = key !== undefined ? themeKey(key) : undefined;
  const [, target] = namedTheme(args, where);
  const label = where.show(target);
  if (path === undefined) {
    const text = files.readText(target);
    if (args["json"]) {
      let document: Value;
      try {
        document = files.parseJson(text);
      } catch (error) {
        if (error instanceof JsonDecodeError || error instanceof JsonValueError) throw new ConfigError(`${label} doesn't parse: ${error.message}`);
        throw error;
      }
      io.say(pretty(document));
    } else writeRaw(io, text);
    return 0;
  }
  const value = themeValue(files.readObject(target, label), path);
  if (value === undefined) {
    const [spec, unknown] = keySpec(files.findSchema(where, files.THEME_SCHEMA).document, path);
    if (unknown) throw new ConfigError(unknown);
    const fallback = spec !== undefined ? lookDefault(spec) : undefined;
    const hint = fallback !== undefined ? ` (Ardia's default: ${cell(fallback)})` : "";
    io.noteError("not_set");
    io.complain(`ardia theme: ${label} doesn't set ${key}${hint}`);
    return 1;
  }
  io.say(args["json"] || typeof value !== "string" ? json(value) : value);
  return 0;
}

function themeUnset(args: Args, where: Places, io: Io): number {
  const key = args["key"] as string;
  const path = themeKey(key);
  const [, target] = namedTheme(args, where);
  const label = where.show(target);
  const document = files.readObject(target, label);
  const holders: JsonObject[] = [document];
  for (const part of path.slice(0, -1)) {
    const child = (holders.at(-1) as JsonObject).get(part);
    if (!isDict(child)) break;
    holders.push(child);
  }
  if (holders.length < path.length || !(holders.at(-1) as JsonObject).has(path.at(-1) as string)) {
    const [, unknown] = keySpec(themeSchema(where, io).document, path);
    if (unknown) throw new ConfigError(unknown);
    io.say(`${key} isn't in ${label}`);
    return 0;
  }
  (holders.at(-1) as JsonObject).delete(path.at(-1) as string);
  for (let depth = path.length - 1; depth > 0; depth -= 1) {
    if ((holders[depth] as JsonObject).size > 0) break;
    (holders[depth - 1] as JsonObject).delete(path[depth - 1] as string);
  }
  files.writeJson(target, document);
  io.say(`removed ${key}; Ardia uses its own value for it`);
  return 0;
}

const HANDLERS: Record<string, Handler> = {
  new: themeNew,
  use: themeUse,
  list: themeList,
  check: themeCheck,
  get: themeGet,
  set: themeSet,
  unset: themeUnset,
};

export function runTheme(verb: string, args: Args, io: Io): number {
  return guarded("ardia theme", HANDLERS[verb] as Handler, args, io);
}
