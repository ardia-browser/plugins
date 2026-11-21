import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { installedDataDir } from "./control.ts";
import { dumps, type JsonObject, type Value } from "./json.ts";
import { envSet, expandUser, home, join, LINUX, NeedsPython, purePath, realpath } from "./paths.ts";
import { isLoneSurrogate, JsonDecodeError, JsonValueError, loads } from "./pyjson.ts";
import { EEXIST, effects, ENOTDIR, fromErrno, isFile, isSymlink, lexists, mkdirs, nameOf, os, osError, parentOf, PyOSError, umaskDefault } from "./pyos.ts";
import { get, isDict, isList, reprText } from "./pyvalue.ts";
import { codePoints } from "./pystr.ts";

export const CONFIG_FILE = "config.json";
export const CONFIG_SCHEMA = "config.schema.json";
export const THEME_SCHEMA = "theme.schema.json";
export const SCHEMA_FOLDER = "config-schema";
const THEME_NAME = /^[a-z0-9][a-z0-9_-]*$/u;
export const RESERVED_SETTINGS = [
  "cliControl",
  "allowJavaScriptFromAppleEvents",
  "extensionSearchEngines",
  "defaultProfileId",
  "customSearchUrl",
  "customSearchEngines",
  "pageEngine",
  "websiteEngines",
  "protectedVideoInWebKit",
];
export const MODES = ["dark", "light"];
const MAX_FILE = 1024 * 1024;

export class ConfigError extends Error {}

export class Places {
  constructor(
    readonly folder: string,
    readonly data: string,
  ) {}

  get config(): string {
    return join(this.folder, CONFIG_FILE);
  }

  get themes(): string {
    return join(this.folder, "themes");
  }

  theme(name: Value): string {
    checkThemeName(name);
    return join(this.themes, `${name as string}.json`);
  }

  schemaCandidates(name: string): string[] {
    return [join(this.folder, name), join(this.data, SCHEMA_FOLDER, name)];
  }

  show(path: string): string {
    if (path === this.folder) return ".";
    const prefix = this.folder.endsWith("/") ? this.folder : `${this.folder}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  }
}

export function explicitDataRoot(dataDir: string | undefined): string | undefined {
  const root = dataDir || envSet("ARDIA_DATA_DIR");
  return root ? purePath(expandUser(root)) : undefined;
}

export function places(dataDir: string | undefined): Places {
  const explicit = explicitDataRoot(dataDir);
  if (explicit !== undefined) return new Places(join(explicit, "config"), explicit);
  return new Places(defaultFolder(), installedDataDir());
}

export function defaultFolder(): string {
  return LINUX ? join(installedDataDir(), "config") : join(purePath(home()), ".config", "ardia");
}

export function isThemeName(name: Value | undefined): name is string {
  return typeof name === "string" && THEME_NAME.test(name) && !name.includes("\n");
}

export function checkThemeName(name: Value | undefined): void {
  if (!isThemeName(name)) {
    const shown = typeof name === "string" ? reprText(name) : name === null ? "None" : String(name);
    throw new ConfigError(`${shown} isn't a theme name: use lowercase letters, digits, - and _, starting with a letter or digit`);
  }
}

function noConstants(token: string): never {
  throw new JsonValueError(`${token} isn't valid JSON`);
}

export function parseJson(text: string): Value {
  return loads(text, { constants: noConstants, finite: true });
}

export function readText(path: string): string {
  const fd = os(() => fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK), path);
  let raw: Buffer;
  try {
    if (!os(() => fs.fstatSync(fd)).isFile()) throw new ConfigError(`${nameOf(path)} isn't a regular file`);
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= MAX_FILE) {
      const chunk = Buffer.alloc(MAX_FILE + 1 - size);
      const count = os(() => fs.readSync(fd, chunk, 0, chunk.length, null));
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      size += count;
    }
    raw = Buffer.concat(chunks);
  } finally {
    fs.closeSync(fd);
  }
  if (raw.length > MAX_FILE) throw new ConfigError(`${nameOf(path)} is larger than 1 MB`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new ConfigError(`${nameOf(path)} isn't UTF-8 text`);
  }
  return text.startsWith("﻿") ? text.slice(1) : text;
}

export function readJson(path: string, label?: string): Value {
  const shown = label ?? nameOf(path);
  let text: string;
  try {
    text = readText(path);
  } catch (error) {
    if (error instanceof PyOSError && !error.notFound) throw new ConfigError(`${shown}: ${error.strerror ?? error.text()}`);
    throw error;
  }
  try {
    return parseJson(text);
  } catch (error) {
    if (error instanceof JsonDecodeError) throw new ConfigError(`${shown} doesn't parse: line ${error.lineno} column ${error.colno}: ${error.msg}`);
    if (error instanceof JsonValueError) throw new ConfigError(`${shown} doesn't parse: ${error.message}`);
    throw error;
  }
}

export function readObject(path: string, label?: string): JsonObject {
  const document = readJson(path, label);
  if (!isDict(document)) throw new ConfigError(`${label ?? nameOf(path)} must hold a JSON object`);
  return document;
}

export function dump(document: Value): string {
  return `${dumps(document, "indented")}\n`;
}

const TEMP_LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789_";

function makeTemp(dir: string, prefix: string, suffix: string): [number, string] {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const bytes = randomBytes(8);
    const name = [...bytes].map((byte) => TEMP_LETTERS[byte % TEMP_LETTERS.length]).join("");
    const path = join(dir, `${prefix}${name}${suffix}`);
    try {
      return [fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600), path];
    } catch (error) {
      const wrapped = osError(error, path);
      if (wrapped instanceof PyOSError && wrapped.errno === EEXIST) continue;
      throw wrapped;
    }
  }
  throw fromErrno(EEXIST);
}

export class Exists extends Error {}

export function writeText(path: string, text: string, overwrite = true): void {
  if (!overwrite && lexists(path)) throw new Exists(path);
  const target = overwrite && isSymlink(path) ? realpath(path) : path;
  if (overwrite && lexists(target) && !isFile(target)) throw new ConfigError(`${path} isn't a regular file`);
  let mode = umaskDefault();
  if (overwrite) {
    try {
      mode = fs.statSync(target).mode & 0o7777;
    } catch (error) {
      const wrapped = osError(error, target);
      if (!(wrapped instanceof PyOSError && wrapped.notFound)) throw wrapped;
    }
  }
  if (isLoneSurrogate(text)) throw new NeedsPython("writing text Python can't encode");
  effects.done = true;
  const [fd, temp] = makeTemp(parentOf(target), `.${nameOf(target)}.`, ".tmp");
  try {
    try {
      os(() => fs.writeFileSync(fd, Buffer.from(text, "utf8")));
      os(() => fs.fsyncSync(fd));
    } finally {
      fs.closeSync(fd);
    }
    os(() => fs.chmodSync(temp, mode), temp);
    if (overwrite) os(() => fs.renameSync(temp, target), temp, target);
    else {
      try {
        fs.linkSync(temp, target);
      } catch (error) {
        const wrapped = osError(error, temp, target);
        if (wrapped instanceof PyOSError && wrapped.exists) throw new Exists(target);
        throw wrapped;
      }
    }
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {}
  }
}

export function writeJson(path: string, document: Value, overwrite = true): void {
  writeText(path, dump(document), overwrite);
}

export type Schema = { path: string | undefined; document: JsonObject | undefined; warning: string | undefined };

export function findSchema(where: Places, name: string): Schema {
  const warnings: string[] = [];
  for (const candidate of where.schemaCandidates(name)) {
    let document: JsonObject;
    try {
      document = readObject(candidate, candidate);
    } catch (error) {
      if (error instanceof PyOSError && error.notFound) continue;
      if (error instanceof ConfigError) {
        warnings.push(`skipped ${error.message}`);
        continue;
      }
      throw error;
    }
    return { path: candidate, document, warning: warnings.join("; ") || undefined };
  }
  return { path: undefined, document: undefined, warning: warnings.join("; ") || undefined };
}

export function sub(document: Value | undefined, ...keys: string[]): Value | undefined {
  let current = document;
  for (const key of keys) {
    if (!isDict(current)) return undefined;
    current = current.get(key);
  }
  return current;
}

export function settingSpecs(schema: Value | undefined): JsonObject {
  const properties = get(sub(schema, "properties", "settings"), "properties");
  return isDict(properties) ? properties : new Map();
}

export function settingsSchema(schema: Value | undefined): JsonObject {
  const settings = sub(schema, "properties", "settings");
  return isDict(settings) ? settings : new Map();
}

export function outerSchema(schema: JsonObject): JsonObject {
  const propertiesValue = schema.get("properties");
  const requiredValue = schema.get("required");
  const properties = isDict(propertiesValue) ? propertiesValue : new Map<string, Value>();
  const required = isList(requiredValue) ? requiredValue : [];
  const outer = new Map(schema);
  outer.set("properties", new Map([...properties].filter(([key]) => key !== "settings")));
  outer.set(
    "required",
    required.filter((key) => key !== "settings"),
  );
  return outer;
}

export function roleSpecs(schema: Value | undefined, mode: string): JsonObject {
  const properties = sub(schema, "properties", mode, "properties");
  return isDict(properties) ? properties : new Map();
}

export function newConfig(): JsonObject {
  return new Map<string, Value>([
    ["$schema", `./${CONFIG_SCHEMA}`],
    ["theme", null],
    ["settings", new Map()],
  ]);
}

export function loadConfig(where: Places, create = false): [JsonObject, boolean] {
  let document: JsonObject;
  try {
    document = readObject(where.config, CONFIG_FILE);
  } catch (error) {
    if (!(error instanceof PyOSError && error.notFound)) throw error;
    if (lexists(where.config)) throw new ConfigError(`${where.config} is a link to ${os(() => fs.readlinkSync(where.config), where.config)}, which doesn't exist`);
    if (!create) throw new ConfigError(`there's no ${where.config} yet (ardia config init creates it)`);
    return [newConfig(), true];
  }
  if (document.has("settings") && !isDict(document.get("settings"))) throw new ConfigError(`${CONFIG_FILE}: settings must be an object`);
  return [document, false];
}

export function saveConfig(where: Places, document: JsonObject, created: boolean): void {
  if (created) {
    mkdirs(where.folder, true, true);
    try {
      writeJson(where.config, document, false);
      return;
    } catch (error) {
      if (error instanceof Exists) throw new ConfigError(`${where.config} appeared while this ran; run the command again`);
      throw error;
    }
  }
  writeJson(where.config, document);
}

export function withKey(document: JsonObject, key: string, value: Value, after?: string): JsonObject {
  if (document.has(key) || after === undefined || !document.has(after)) {
    document.set(key, value);
    return document;
  }
  const rebuilt: JsonObject = new Map();
  for (const [existing, item] of document) {
    rebuilt.set(existing, item);
    if (existing === after) rebuilt.set(key, value);
  }
  return rebuilt;
}

export function themeNames(where: Places): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(where.themes);
  } catch (error) {
    const wrapped = osError(error, where.themes);
    if (wrapped instanceof PyOSError && (wrapped.notFound || wrapped.errno === ENOTDIR)) return [];
    throw wrapped;
  }
  const names = entries.filter((entry) => entry.endsWith(".json") && isThemeName(entry.slice(0, -5))).map((entry) => entry.slice(0, -5));
  return sortPy(names.filter((name) => isFile(join(where.themes, `${name}.json`))));
}

export function sortPy(values: string[]): string[] {
  return [...values].sort((left, right) => comparePy(left, right));
}

export function comparePy(left: string, right: string): number {
  const a = codePoints(left);
  const b = codePoints(right);
  const shorter = Math.min(a.length, b.length);
  for (let index = 0; index < shorter; index += 1) {
    const x = (a[index] as string).codePointAt(0) as number;
    const y = (b[index] as string).codePointAt(0) as number;
    if (x !== y) return x - y;
  }
  return a.length - b.length;
}
