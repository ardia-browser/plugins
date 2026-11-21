import { Float, type JsonObject, type Value } from "../json.ts";
import { pyInt, pyStrip } from "../pylib/str.ts";
import { isDigitCode } from "../pylib/unicode.ts";
import { checkGlob, checkMatch, type ManifestEntry, manifestEntries, META_FIELDS, type Meta, metaId, metaWorld, newMeta, ScriptError } from "./userscript.ts";
import { StoreError } from "./store-fs.ts";

export const EXTENSION_NAME = "Ardia Scripts";
export const EXTENSION_DESCRIPTION = "Userscripts installed with the ardia command.";
export const MAX_MANIFEST = 256 * 1024;
const MAX_ENTRIES = 256;
const MAX_FILES_PER_ENTRY = 256;
const MAX_FILES = 512;
const RUN_AT = new Set(["document_start", "document_end", "document_idle"]);
const WORLDS = new Set(["MAIN", "ISOLATED"]);
const STRING_FIELDS = new Set(["name", "namespace", "version", "description", "run_at", "inject_into"]);

export function now(): Float {
  return new Float((performance.timeOrigin + performance.now()) / 1000);
}

function listValue(items: string[]): Value[] {
  return [...items];
}

export function metaValue(meta: Meta): JsonObject {
  const record: JsonObject = new Map();
  for (const key of META_FIELDS) {
    const value = meta[key];
    record.set(key, Array.isArray(value) ? listValue(value) : value);
  }
  record.set("id", metaId(meta));
  record.set("world", metaWorld(meta));
  return record;
}

function invalid(record: JsonObject): StoreError {
  const id = record.get("id");
  return new StoreError(`${typeof id === "string" ? id : "a script"}'s meta.json has a field of the wrong type; reinstall it`);
}

export function metaFromRecord(record: JsonObject): Meta {
  const name = record.get("name");
  if (typeof name !== "string") throw invalid(record);
  const meta = newMeta(name);
  for (const key of META_FIELDS) {
    if (!record.has(key) || key === "name") continue;
    const value = record.get(key);
    if (STRING_FIELDS.has(key)) {
      if (typeof value !== "string") throw invalid(record);
      (meta as Record<string, unknown>)[key] = value;
    } else if (key === "noframes") {
      if (typeof value !== "boolean") throw invalid(record);
      meta.noframes = value;
    } else {
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw invalid(record);
      (meta as Record<string, unknown>)[key] = [...(value as string[])];
    }
  }
  return meta;
}

export function recordId(record: JsonObject): string {
  return record.get("id") as string;
}

export function entriesFor(record: JsonObject): ManifestEntry[] {
  try {
    return manifestEntries(metaFromRecord(record), `js/${recordId(record)}.js`);
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw invalid(record);
  }
}

export function entryValue(entry: ManifestEntry): JsonObject {
  return new Map<string, Value>([
    ["matches", listValue(entry.matches)],
    ["exclude_matches", listValue(entry.exclude_matches)],
    ["include_globs", listValue(entry.include_globs)],
    ["exclude_globs", listValue(entry.exclude_globs)],
    ["js", listValue(entry.js)],
    ["run_at", entry.run_at],
    ["all_frames", entry.all_frames],
    ["world", entry.world],
  ]);
}

export function manifestVersion(generation: bigint): string {
  return `1.${(generation / 65536n) % 65536n}.${generation % 65536n}`;
}

export function manifestValue(entries: ManifestEntry[], generation: bigint): JsonObject {
  return new Map<string, Value>([
    ["manifest_version", 3n],
    ["name", EXTENSION_NAME],
    ["version", manifestVersion(generation)],
    ["description", EXTENSION_DESCRIPTION],
    ["content_scripts", entries.map(entryValue)],
  ]);
}

export function validateManifest(entries: ManifestEntry[], jsFiles: Set<string>): void {
  const fail = (message: string): never => {
    throw new StoreError(`the generated manifest is invalid (${message}); nothing was changed`);
  };
  if (entries.length === 0) fail("no content scripts");
  if (entries.length > MAX_ENTRIES) fail(`${entries.length} content script entries, over Ardia's limit of ${MAX_ENTRIES}; uninstall some scripts`);
  const files = new Set(entries.flatMap((entry) => entry.js));
  if (files.size > MAX_FILES) fail(`${files.size} script files, over Ardia's limit of ${MAX_FILES}; uninstall some scripts`);
  for (const entry of entries) {
    try {
      if (entry.matches.length === 0) fail("a content script has no matches");
      for (const key of ["matches", "exclude_matches"] as const) for (const pattern of entry[key]) checkMatch(pattern, key);
      for (const key of ["include_globs", "exclude_globs"] as const) for (const glob of entry[key]) checkGlob(glob, key);
    } catch (error) {
      if (error instanceof ScriptError) fail(error.message);
      throw error;
    }
    if (entry.js.length === 0 || entry.js.length > MAX_FILES_PER_ENTRY || entry.js.some((js) => !jsFiles.has(js))) fail("a content script names a file that isn't there");
    if (!RUN_AT.has(entry.run_at) || !WORLDS.has(entry.world)) fail("bad run_at, world or all_frames");
  }
}

export function readIntText(data: Buffer | null): bigint {
  const text = pyStrip(new TextDecoder("utf-8", { ignoreBOM: true }).decode(data ?? Buffer.alloc(0)));
  if (text === "" || ![...text].every((char) => isDigitCode(char.codePointAt(0) as number))) return 0n;
  return pyInt(text);
}

export function isGeneration(value: Value | undefined): value is bigint {
  return typeof value === "bigint";
}
