import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { constants } from "node:os";
import { type Args, type Io } from "./cli-command.ts";
import * as files from "./config-files.ts";
import { ConfigError, Exists, type Places } from "./config-files.ts";
import { dumps, type JsonObject, type Value } from "./json.ts";
import { env, join, LINUX } from "./paths.ts";
import { left, truthy } from "./py.ts";
import { JsonDecodeError, JsonValueError } from "./pyjson.ts";
import { exists, isFile, lexists, mkdirs, nameOf, osError, parentOf, PyOSError } from "./pyos.ts";
import { charCount } from "./py.ts";
import { isDict, isStr } from "./pyvalue.ts";
import { describe, didYouMean, pathKey, Problem, validate } from "./schema-check.ts";
import { shortcutProblem } from "./shortcuts.ts";
import { checkThemeFile, report } from "./theme-check.ts";
import { shlexSplit } from "./pylib/shlex.ts";
import { PyException, pyStrip } from "./pylib/str.ts";
import { PythonError } from "./py.ts";

export type Handler = (args: Args, where: Places, io: Io) => number;

function errorText(error: PyOSError): string {
  const name = error.filename !== undefined ? `${error.filename}: ` : "";
  return `${name}${error.strerror ?? error.text()}`;
}

export function guarded(prefix: string, handler: Handler, args: Args, io: Io): number {
  try {
    return handler(args, files.places(args["data_dir"] as string | undefined), io);
  } catch (error) {
    if (error instanceof ConfigError) {
      io.noteError(error.message.startsWith("unknown setting") ? "unknown_setting" : "config_error");
      io.complain(`${prefix}: ${error.message}`);
      return 1;
    }
    if (error instanceof Exists) {
      io.complain(`${prefix}: ${error.message}`);
      return 1;
    }
    const wrapped = osError(error);
    if (wrapped instanceof PyOSError) {
      io.complain(`${prefix}: ${errorText(wrapped)}`);
      return 1;
    }
    throw error;
  }
}

export function json(value: Value): string {
  return dumps(value, "spaced");
}

export function pretty(value: Value): string {
  return dumps(value, "indented");
}

export function cell(value: Value | undefined): string {
  if (typeof value === "string" && value) return value;
  return json(value ?? null);
}

export function parseValue(text: string): Value[] {
  let parsed: Value;
  try {
    parsed = files.parseJson(text);
  } catch (error) {
    if (error instanceof JsonDecodeError || error instanceof JsonValueError) return [text];
    throw error;
  }
  return typeof parsed === "string" ? [parsed] : [parsed, text];
}

export function writeRaw(io: Io, text: string): void {
  io.write(text.endsWith("\n") || !text ? text : `${text}\n`);
}

function configPath(_args: Args, where: Places, io: Io): number {
  io.say(where.folder);
  return 0;
}

export function create(path: string, text: string, io: Io): void {
  try {
    files.writeText(path, text, false);
    io.say(`created ${path}`);
  } catch (error) {
    if (!(error instanceof Exists)) throw error;
    io.say(`kept ${path}`);
  }
}

function configInit(_args: Args, where: Places, io: Io): number {
  for (const folder of [where.folder, where.themes]) {
    if (fs.existsSync(folder) && fs.statSync(folder).isDirectory()) continue;
    mkdirs(folder, true, true);
    io.say(`created ${folder}/`);
  }
  create(where.config, files.dump(files.newConfig()), io);
  for (const name of [files.CONFIG_SCHEMA, files.THEME_SCHEMA]) {
    const target = join(where.folder, name);
    const source = join(where.data, files.SCHEMA_FOLDER, name);
    if (lexists(target)) {
      io.say(`kept ${target}`);
      continue;
    }
    let text: string;
    try {
      files.readObject(source, source);
      text = files.readText(source);
    } catch (error) {
      if (!(error instanceof PyOSError && error.notFound)) throw error;
      io.complain(`ardia config: no ${name} in ${parentOf(source)} yet; Ardia writes it at launch and copies it here`);
      continue;
    }
    create(target, text, io);
  }
  return 0;
}

export function splitKey(key: string): string[] {
  const dot = key.indexOf(".");
  if (dot >= 0 && key.slice(0, dot) === "shortcuts" && key.slice(dot + 1)) return ["shortcuts", key.slice(dot + 1)];
  return [key];
}

function configSchema(where: Places, io: Io): files.Schema {
  const found = files.findSchema(where, files.CONFIG_SCHEMA);
  if (found.warning) io.complain(`ardia config: ${found.warning}`);
  return found;
}

function checkKey(parts: string[], specs: JsonObject): void {
  const top = parts[0] as string;
  if (files.RESERVED_SETTINGS.includes(top)) throw new ConfigError(`${top} can't be set from config.json; change it in Ardia's Settings`);
  if (top.includes(".") && !truthy(specs.get(top))) throw new ConfigError(`${top} isn't a setting; only shortcuts.<command id> takes a dot`);
  if (specs.size > 0 && !specs.has(top)) throw new ConfigError(`unknown setting ${top}${didYouMean(top, specs)}`);
}

export function shortcutProblems(shortcuts: JsonObject, skip: Set<string> = new Set()): Problem[] {
  const problems: Problem[] = [];
  for (const [command, value] of shortcuts) {
    const path = ["shortcuts", command];
    if (skip.has(pathKey(path))) continue;
    const problem = shortcutProblem(value);
    if (problem) problems.push(new Problem(path, `shortcuts.${command}: ${problem}`));
  }
  return problems;
}

function valueProblems(parts: string[], value: Value, specs: JsonObject): Problem[] {
  const top = parts[0] as string;
  const spec = specs.get(top);
  if (parts.length === 2) {
    const single: JsonObject = new Map([[parts[1] as string, value]]);
    let problems = truthy(spec) ? validate(single, spec, ["shortcuts"], false) : [];
    if (problems.length === 0) problems = shortcutProblems(single);
    return problems;
  }
  let problems = truthy(spec) ? validate(value, spec, [top], false) : [];
  if (problems.length === 0 && top === "shortcuts" && isDict(value)) problems = shortcutProblems(value);
  return problems;
}

function configSet(args: Args, where: Places, io: Io): number {
  const key = args["key"] as string;
  const parts = splitKey(key);
  const schema = configSchema(where, io);
  const specs = files.settingSpecs(schema.document);
  checkKey(parts, specs);
  const candidates = parseValue(args["value"] as string);
  let found = false;
  let chosen: Value = null;
  let firstProblems: Problem[] | undefined;
  for (const candidate of candidates) {
    const problems = valueProblems(parts, candidate, specs);
    if (problems.length === 0) {
      chosen = candidate;
      found = true;
      break;
    }
    firstProblems = firstProblems ?? problems;
  }
  if (!found && firstProblems !== undefined) {
    for (const problem of firstProblems) io.complain(`ardia config: ${problem.message}`);
    return 1;
  }
  if (!found) chosen = candidates[0] as Value;
  const [loaded, created] = files.loadConfig(where, true);
  const current = loaded.get("settings");
  const settings: JsonObject = isDict(current) ? new Map(current) : new Map();
  if (parts.length === 2) {
    const shortcutsValue = settings.get("shortcuts");
    if (shortcutsValue !== undefined && shortcutsValue !== null && !isDict(shortcutsValue)) {
      throw new ConfigError("settings.shortcuts in config.json isn't an object; fix it or unset shortcuts first");
    }
    const shortcuts: JsonObject = isDict(shortcutsValue) ? new Map(shortcutsValue) : new Map();
    shortcuts.set(parts[1] as string, chosen);
    settings.set("shortcuts", shortcuts);
  } else settings.set(parts[0] as string, chosen);
  const document = files.withKey(loaded, "settings", settings);
  files.saveConfig(where, document, created);
  if (created) io.complain(`ardia config: created ${where.config}`);
  if (schema.document === undefined) io.complain(`ardia config: no ${files.CONFIG_SCHEMA} found (Ardia writes one at launch), so ${key} was written without checking it`);
  io.say(`${key} = ${json(chosen)}`);
  return 0;
}

function configUnset(args: Args, where: Places, io: Io): number {
  const key = args["key"] as string;
  const parts = splitKey(key);
  const schema = configSchema(where, io);
  const specs = files.settingSpecs(schema.document);
  const top = parts[0] as string;
  if (!lexists(where.config)) {
    if (specs.size > 0 && !specs.has(top) && !files.RESERVED_SETTINGS.includes(top)) throw new ConfigError(`unknown setting ${top}${didYouMean(top, specs)}`);
    io.say(`${key} isn't in config.json`);
    return 0;
  }
  const [document] = files.loadConfig(where);
  const current = document.get("settings");
  const settings: JsonObject = isDict(current) ? new Map(current) : new Map();
  let holder = settings;
  if (parts.length === 2) {
    const shortcuts = settings.get("shortcuts");
    holder = isDict(shortcuts) ? new Map(shortcuts) : new Map();
  }
  const leaf = parts.at(-1) as string;
  if (!holder.has(leaf)) {
    if (specs.size > 0 && !specs.has(top) && !files.RESERVED_SETTINGS.includes(top) && !settings.has(top)) throw new ConfigError(`unknown setting ${top}${didYouMean(top, specs)}`);
    io.say(`${key} isn't in config.json`);
    return 0;
  }
  holder.delete(leaf);
  if (parts.length === 2) settings.set("shortcuts", holder);
  document.set("settings", settings);
  files.saveConfig(where, document, false);
  io.say(`removed ${key}; Ardia keeps its current value`);
  return 0;
}

function noConfigYet(where: Places): ConfigError {
  return new ConfigError(`there's no ${where.config} yet (ardia config init creates it)`);
}

function configGet(args: Args, where: Places, io: Io): number {
  const key = args["key"] as string | undefined;
  if (key === undefined) {
    let text: string;
    try {
      text = files.readText(where.config);
    } catch (error) {
      if (error instanceof PyOSError && error.notFound) throw noConfigYet(where);
      throw error;
    }
    if (args["json"]) {
      let document: Value;
      try {
        document = files.parseJson(text);
      } catch (error) {
        if (error instanceof JsonDecodeError || error instanceof JsonValueError) throw new ConfigError(`${files.CONFIG_FILE} doesn't parse: ${error.message}`);
        throw error;
      }
      io.say(pretty(document));
    } else writeRaw(io, text);
    return 0;
  }
  const parts = splitKey(key);
  const [document] = files.loadConfig(where);
  const settings = document.get("settings");
  let value: Value = truthy(settings) ? (settings as Value) : new Map();
  for (const part of parts) {
    if (!isDict(value) || !value.has(part)) {
      const specs = files.settingSpecs(files.findSchema(where, files.CONFIG_SCHEMA).document);
      const top = parts[0] as string;
      if (specs.size > 0 && !specs.has(top) && !files.RESERVED_SETTINGS.includes(top)) throw new ConfigError(`unknown setting ${top}${didYouMean(top, specs)}`);
      const spec = specs.get(top);
      const hint = parts.length === 1 && isDict(spec) && spec.has("default") ? ` (Ardia's default: ${cell(spec.get("default"))})` : "";
      io.noteError("not_set");
      io.complain(`ardia config: config.json doesn't set ${key}${hint}`);
      return 1;
    }
    value = value.get(part) as Value;
  }
  io.say(args["json"] || !isStr(value) ? json(value) : value);
  return 0;
}

function configList(args: Args, where: Places, io: Io): number {
  const schema = configSchema(where, io);
  const specs = files.settingSpecs(schema.document);
  let settings: JsonObject = new Map();
  try {
    const [document] = files.loadConfig(where);
    const found = document.get("settings");
    settings = truthy(found) ? (found as JsonObject) : new Map();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    if (exists(where.config) || lexists(where.config)) io.complain(`ardia config: ${error.message}`);
  }
  const rows: JsonObject[] = [];
  for (const [key, spec] of specs) {
    const row: JsonObject = new Map<string, Value>([
      ["key", key],
      ["allowed", describe(spec)],
    ]);
    if (isDict(spec) && spec.has("default")) row.set("default", spec.get("default") as Value);
    if (isDict(spec) && isStr(spec.get("description"))) row.set("description", spec.get("description") as Value);
    if (settings.has(key)) row.set("value", settings.get(key) as Value);
    rows.push(row);
  }
  for (const [key, value] of settings) {
    if (specs.has(key)) continue;
    const allowed = specs.size > 0 || files.RESERVED_SETTINGS.includes(key) ? "not a setting Ardia reads from the file" : "unknown (no schema)";
    rows.push(
      new Map<string, Value>([
        ["key", key],
        ["allowed", allowed],
        ["value", value],
      ]),
    );
  }
  if (schema.document === undefined) io.complain(`ardia config: no ${files.CONFIG_SCHEMA} found (Ardia writes one at launch); listing only what config.json sets`);
  if (args["json"]) {
    io.say(
      pretty(
        new Map<string, Value>([
          ["schema", schema.path ?? null],
          ["settings", rows],
        ]),
      ),
    );
    return 0;
  }
  const table: string[][] = [["KEY", "ALLOWED", "DEFAULT", "FILE"]];
  for (const row of rows) {
    table.push([row.get("key") as string, row.get("allowed") as string, row.has("default") ? cell(row.get("default")) : "", row.has("value") ? cell(row.get("value")) : ""]);
  }
  const widths = [0, 1, 2].map((index) => Math.min(Math.max(...table.map((row) => charCount(row[index] as string))), 40));
  for (const row of table) io.say(`${row.slice(0, 3).map((text, index) => left(text, widths[index] as number)).join("  ")}  ${row[3]}`);
  return 0;
}

function which(program: string): string | undefined {
  for (const folder of (env("PATH") ?? "").split(":")) {
    const candidate = join(folder || ".", program);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (isFile(candidate)) return candidate;
    } catch {}
  }
  return undefined;
}

function splitEditor(value: string): string[] {
  try {
    return shlexSplit(value);
  } catch (error) {
    if (error instanceof PyException) throw new PythonError(error.type, error.message);
    throw error;
  }
}

function editorCommand(): [string[], boolean] {
  for (const variable of ["VISUAL", "EDITOR"]) {
    const value = pyStrip(env(variable) ?? "");
    if (value) return [splitEditor(value), true];
  }
  if (LINUX && (env("DISPLAY") || env("WAYLAND_DISPLAY"))) {
    const opener = which("xdg-open");
    if (opener !== undefined) return [[opener], false];
  }
  return [["vi"], true];
}

function configEdit(args: Args, where: Places, io: Io): number {
  if (!lexists(where.config)) {
    mkdirs(where.folder, true, true);
    create(where.config, files.dump(files.newConfig()), io);
  }
  const [command, waits] = editorCommand();
  const program = command[0] as string;
  const ran = spawnSync(program, [...command.slice(1), where.config], { stdio: "inherit", shell: false });
  if (ran.error !== undefined) {
    const wrapped = osError(ran.error);
    throw new ConfigError(`couldn't start ${program}: ${wrapped instanceof PyOSError ? wrapped.strerror : String(ran.error)}`);
  }
  const signalled = ran.signal === null ? undefined : (constants.signals as Record<string, number>)[ran.signal];
  const status = signalled !== undefined ? -signalled : (ran.status ?? 0);
  if (status !== 0) {
    io.complain(`ardia config: ${program} exited with status ${status}`);
    return 1;
  }
  if (!waits) {
    io.say(`opened ${where.config} with ${nameOf(program)}; run ardia config check once you've saved it (set $VISUAL or $EDITOR to edit here)`);
    return 0;
  }
  return configCheck({ ...args, json: false }, where, io);
}

export function configProblems(document: Value, schema: JsonObject | undefined): Problem[] {
  if (!isDict(document)) return [new Problem([], "config.json must hold a JSON object")];
  const problems: Problem[] = [];
  let settingsValue = document.has("settings") ? (document.get("settings") as Value) : new Map<string, Value>();
  if (!isDict(settingsValue)) {
    problems.push(new Problem(["settings"], "settings must be an object"));
    settingsValue = new Map();
  }
  const settings = settingsValue;
  for (const key of settings.keys()) {
    if (files.RESERVED_SETTINGS.includes(key)) problems.push(new Problem([key], `${key} can't be set from config.json; Ardia ignores it`));
  }
  const allowed: JsonObject = new Map([...settings].filter(([key]) => !files.RESERVED_SETTINGS.includes(key)));
  if (schema !== undefined) {
    problems.push(...validate(allowed, files.settingsSchema(schema), [], false, "setting"));
    const outer: JsonObject = new Map([...document].filter(([key]) => key !== "settings"));
    problems.push(...validate(outer, files.outerSchema(schema), [], true));
  }
  const shortcuts = allowed.get("shortcuts");
  if (isDict(shortcuts)) {
    const flagged = new Set(problems.map((problem) => pathKey(problem.path)));
    problems.push(...shortcutProblems(shortcuts, flagged));
  }
  const theme = document.get("theme");
  if (theme !== undefined && theme !== null && !files.isThemeName(theme) && !problems.some((problem) => pathKey(problem.path) === pathKey(["theme"]))) {
    problems.push(new Problem(["theme"], "theme must be null or a theme name (lowercase letters, digits, - and _)"));
  }
  return problems;
}

function configCheck(args: Args, where: Places, io: Io): number {
  const warnings: string[] = [];
  const config = files.findSchema(where, files.CONFIG_SCHEMA);
  const themes = files.findSchema(where, files.THEME_SCHEMA);
  for (const warning of [config.warning, themes.warning]) if (warning) warnings.push(warning);
  if (config.document === undefined) {
    warnings.push(`no ${files.CONFIG_SCHEMA} found (Ardia writes one at launch), so settings were checked only for syntax, shortcuts and the theme name`);
  }
  const results: [string, string, Problem[]][] = [];
  let document: Value;
  try {
    document = files.readJson(where.config, files.CONFIG_FILE);
  } catch (error) {
    if (error instanceof PyOSError && error.notFound) throw noConfigYet(where);
    if (!(error instanceof ConfigError)) throw error;
    results.push([where.config, files.CONFIG_FILE, [new Problem([], error.message)]]);
    return report(results, warnings, Boolean(args["json"]), io);
  }
  const problems = configProblems(document, config.document);
  results.push([where.config, files.CONFIG_FILE, problems]);
  const theme = isDict(document) ? document.get("theme") : undefined;
  if (files.isThemeName(theme)) {
    const path = where.theme(theme);
    if (!exists(path)) {
      problems.push(new Problem(["theme"], `theme ${theme} doesn't exist (no ${where.show(path)})${didYouMean(theme, files.themeNames(where))}`));
    } else {
      if (themes.document === undefined) warnings.push(`no ${files.THEME_SCHEMA} found, so unknown colour roles weren't checked`);
      results.push([path, where.show(path), checkThemeFile(where, path, themes.document)]);
    }
  }
  return report(results, warnings, Boolean(args["json"]), io);
}

const HANDLERS: Record<string, Handler> = {
  path: configPath,
  init: configInit,
  get: configGet,
  set: configSet,
  unset: configUnset,
  list: configList,
  edit: configEdit,
  check: configCheck,
};

export function runConfig(verb: string, args: Args, io: Io): number {
  return guarded("ardia config", HANDLERS[verb] as Handler, args, io);
}
