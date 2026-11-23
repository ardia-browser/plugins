import { isSpaceCode, PyException, pyStrip, reprText, splitlines } from "../pylib/str.ts";
import { isWordCode } from "../pylib/unicode.ts";
import { globMatches, globPoints, matches, parse, PatternError, type Spec, split } from "../urlmatch/urlmatch.ts";

export const RUN_AT = ["document-start", "document-end", "document-idle"] as const;
export const INJECT_INTO: Readonly<Record<string, "MAIN" | "ISOLATED">> = { page: "MAIN", auto: "MAIN", content: "ISOLATED" };
const INCLUDE_MATCHES = ["*://*/*"];
const SLUG_LIMIT = 64;
const HEADER = "==UserScript==";
const FOOTER = "==/UserScript==";

export class ScriptError extends Error {
  override readonly name = "ScriptError";
}

export type Meta = {
  name: string;
  namespace: string;
  version: string;
  description: string;
  matches: string[];
  exclude_matches: string[];
  includes: string[];
  excludes: string[];
  run_at: string;
  inject_into: string;
  noframes: boolean;
  warnings: string[];
};

export const META_FIELDS: readonly (keyof Meta)[] = [
  "name", "namespace", "version", "description", "matches", "exclude_matches", "includes", "excludes", "run_at", "inject_into", "noframes", "warnings",
];

export function newMeta(name: string): Meta {
  return { name, namespace: "", version: "", description: "", matches: [], exclude_matches: [], includes: [], excludes: [], run_at: "document-end", inject_into: "page", noframes: false, warnings: [] };
}

export function slug(name: string): string {
  const text = trimDashes(trimDashes(name.toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, SLUG_LIMIT));
  return text || "script";
}

function trimDashes(text: string): string {
  return text.replace(/^-+|-+$/g, "");
}

export function metaId(meta: Meta): string {
  return slug(meta.name);
}

export function metaWorld(meta: Meta): "MAIN" | "ISOLATED" {
  const world = INJECT_INTO[meta.inject_into];
  if (world === undefined || !Object.hasOwn(INJECT_INTO, meta.inject_into)) throw new PyException("KeyError", reprText(meta.inject_into));
  return world;
}

export function metaDict(meta: Meta): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of META_FIELDS) data[key] = Array.isArray(meta[key]) ? [...(meta[key] as string[])] : meta[key];
  data.id = metaId(meta);
  data.world = metaWorld(meta);
  return data;
}

function skipSpace(line: string, at: number): number {
  while (at < line.length && isSpaceCode(line.charCodeAt(at))) at += 1;
  return at;
}

function marker(line: string, wanted: string): boolean {
  const stripped = pyStrip(line);
  return stripped.startsWith("//") && pyStrip(stripped.slice(2)) === wanted;
}

function wordRun(line: string, at: number): number {
  while (at < line.length) {
    const point = line.codePointAt(at) as number;
    if (point !== 0x2d && !isWordCode(point)) break;
    at += point > 0xffff ? 2 : 1;
  }
  return at;
}

export function entryOf(line: string): [string, string] | undefined {
  let at = skipSpace(line, 0);
  if (!line.startsWith("//", at)) return undefined;
  at = skipSpace(line, at + 2);
  if (line[at] !== "@") return undefined;
  const keyStart = at + 1;
  let keyEnd = wordRun(line, keyStart);
  if (keyEnd === keyStart) return undefined;
  if (line[keyEnd] === ":") {
    const after = wordRun(line, keyEnd + 1);
    if (after > keyEnd + 1) keyEnd = after;
  }
  const key = line.slice(keyStart, keyEnd);
  const rest = line.slice(keyEnd);
  if (rest === "" || pyStrip(rest) === "") return [key, ""];
  if (!isSpaceCode(rest.charCodeAt(0)) || rest.includes("\n")) return undefined;
  return [key, pyStrip(rest)];
}

export function parseMatch(pattern: string, key = "match"): Spec {
  try {
    return parse(pattern);
  } catch (error) {
    if (error instanceof PatternError) throw new ScriptError(`@${key} ${reprText(pattern)}: ${error.message}`);
    throw error;
  }
}

export function checkMatch(pattern: string, key: string): string {
  parseMatch(pattern, key);
  return pattern;
}

export function checkGlob(glob: string, key: string): void {
  if (glob.length > 2 && glob.startsWith("/") && glob.endsWith("/")) {
    throw new ScriptError(`@${key} ${reprText(glob)}: regular expressions aren't supported; use @match patterns or * globs`);
  }
  if (!glob) throw new ScriptError(`@${key} needs a value`);
  for (let at = 0; at < glob.length; at += 1) {
    const code = glob.charCodeAt(at);
    if (code < 0x20 || code === 0x7f) throw new ScriptError(`@${key} ${reprText(glob)}: has control characters`);
  }
}

export function fileName(filename: string): string {
  const parts = filename.split("/").filter((part) => part !== "" && part !== ".");
  return parts[parts.length - 1] ?? "";
}

export function parseMeta(source: string, filename: string): Meta {
  const lines = splitlines(source);
  const start = lines.findIndex((line) => marker(line, HEADER));
  const entries: [string, string][] = [];
  if (start >= 0) {
    let end = -1;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (marker(lines[index] as string, FOOTER)) {
        end = index;
        break;
      }
    }
    if (end < 0) throw new ScriptError(`${filename}: the // ==UserScript== block has no // ==/UserScript== line`);
    for (const line of lines.slice(start + 1, end)) {
      const found = entryOf(line);
      if (found !== undefined) entries.push(found);
    }
  }
  const meta = newMeta(fileName(filename).split(".")[0] || "script");
  const grants: string[] = [];
  for (const [key, value] of entries) {
    if (key === "name" && value) meta.name = value;
    else if (key === "namespace" || key === "version" || key === "description") meta[key] = value;
    else if (key === "match") meta.matches.push(checkMatch(value, key));
    else if (key === "exclude-match") meta.exclude_matches.push(checkMatch(value, key));
    else if (key === "include" || key === "exclude") {
      checkGlob(value, key);
      (key === "include" ? meta.includes : meta.excludes).push(value);
    } else if (key === "run-at") {
      if (!(RUN_AT as readonly string[]).includes(value)) throw new ScriptError(`@run-at ${reprText(value)}: use document-start, document-end or document-idle`);
      meta.run_at = value;
    } else if (key === "inject-into") {
      if (!Object.hasOwn(INJECT_INTO, value)) throw new ScriptError(`@inject-into ${reprText(value)}: use page, content or auto`);
      meta.inject_into = value;
    } else if (key === "noframes") meta.noframes = true;
    else if (key === "grant") grants.push(value);
    else if (key === "require" || key === "resource") meta.warnings.push(`@${key} ${value} is ignored: import the code instead (esbuild bundles relative imports)`);
  }
  for (const grant of grants) {
    if (grant !== "none") meta.warnings.push(`@grant ${grant} is ignored: Ardia runs userscripts without GM_* APIs`);
  }
  if (meta.matches.length === 0 && meta.includes.length === 0) meta.warnings.push("no @match or @include: the script runs nowhere");
  return meta;
}

export type Rules = { match: Spec[]; excludeMatch: Spec[]; include: number[][]; exclude: number[][]; runAt: string; noframes: boolean };

export function rules(meta: Meta): Rules {
  return {
    match: meta.matches.map((pattern) => parseMatch(pattern)),
    excludeMatch: meta.exclude_matches.map((pattern) => parseMatch(pattern, "exclude-match")),
    include: meta.includes.map(globPoints),
    exclude: meta.excludes.map(globPoints),
    runAt: meta.run_at,
    noframes: meta.noframes,
  };
}

export function urlRuns(meta: Meta, url: string): boolean {
  const spec = rules(meta);
  const parts = split(url);
  const web = parts !== null && (parts.scheme === "http" || parts.scheme === "https");
  const included = spec.match.some((pattern) => matches(pattern, parts)) || (web && spec.include.some((glob) => globMatches(glob, url)));
  const excluded = spec.excludeMatch.some((pattern) => matches(pattern, parts)) || spec.exclude.some((glob) => globMatches(glob, url));
  return included && !excluded;
}

function partition(text: string, separator: string): [string, string] {
  const at = text.indexOf(separator);
  return at < 0 ? [text, ""] : [text.slice(0, at), text.slice(at + separator.length)];
}

export function defaultUrl(meta: Meta): string | null {
  for (const pattern of meta.matches) {
    if (pattern === "<all_urls>") continue;
    let [scheme, rest] = partition(pattern, "://");
    const [host, path] = partition(rest, "/");
    if (host.includes("*") || scheme === "file") continue;
    scheme = scheme === "*" ? "https" : scheme;
    if (scheme !== "http" && scheme !== "https") continue;
    return `${scheme}://${host}/${path.split("*")[0]}`;
  }
  for (const glob of meta.includes) {
    if (!glob.includes("*") && !glob.includes("?") && /^https?:\/\//.test(glob)) return glob;
  }
  return null;
}

export type ManifestEntry = {
  matches: string[];
  exclude_matches: string[];
  include_globs: string[];
  exclude_globs: string[];
  js: string[];
  run_at: string;
  all_frames: boolean;
  world: string;
};

export function manifestEntries(meta: Meta, js: string): ManifestEntry[] {
  const base = { js: [js], run_at: meta.run_at.replaceAll("-", "_"), all_frames: !meta.noframes, world: metaWorld(meta) };
  const entries: ManifestEntry[] = [];
  if (meta.matches.length > 0) entries.push({ matches: [...meta.matches], exclude_matches: [...meta.exclude_matches], include_globs: [], exclude_globs: [...meta.excludes], ...base });
  if (meta.includes.length > 0) {
    const excluded = [...new Set([...meta.exclude_matches, ...meta.matches])];
    entries.push({ matches: [...INCLUDE_MATCHES], exclude_matches: excluded, include_globs: [...meta.includes], exclude_globs: [...meta.excludes], ...base });
  }
  return entries;
}
