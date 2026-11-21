import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dumps, type JsonObject, object, parseText, type Value } from "./json.ts";
import { errnoOf, home, join, strerror } from "./paths.ts";
import { reprStr } from "./py.ts";
import { codePoints, utf8 } from "./pystr.ts";
import { CUA_VERSION, Refused, skillPack } from "./cua-skill.ts";
import { SKILL_FILES, SKILL_HASHES } from "./skill-files.ts";
import { cliHome } from "./usage.ts";
import { cliVersion } from "./version.ts";

const SKILL_NAME = "ardia";
const CUA_SKILL = "cua-driver";
const COMPANIONS = [CUA_SKILL];
const MARKER = ".ardia-skill";
export const TARGETS: Readonly<Record<string, [string, string]>> = {
  general: [".agents/skills", ".agents/skills"],
  codex: [".agents/skills", ".agents/skills"],
  "claude-code": [".claude/skills", ".claude/skills"],
  cursor: [".cursor/skills", ".cursor/skills"],
  opencode: [".config/opencode/skills", ".opencode/skills"],
};
const AGENT_HOMES: [string, string][] = [
  ["claude-code", ".claude"],
  ["codex", ".codex"],
  ["cursor", ".cursor"],
  ["opencode", ".config/opencode"],
];

export type Lines = { status: number; out: string[]; outputChars?: number; counts?: [string, number][] };

class SkillError extends Error {}

function osError(error: unknown): string {
  if (error instanceof SkillError || error instanceof Refused) return error.message;
  const errno = errnoOf(error);
  if (!errno) return (error as Error)?.message ?? String(error);
  const path = (error as NodeJS.ErrnoException).path;
  return `[Errno ${errno}] ${strerror(errno)}${typeof path === "string" ? `: ${reprStr(path)}` : ""}`;
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function present(path: string): boolean {
  return isLink(path) || exists(path);
}

function parent(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

export function destination(target: string, project: boolean): string {
  const [userDir, projectDir] = TARGETS[target] as [string, string];
  const base = project ? join(process.cwd(), projectDir) : join(home(), userDir);
  return join(base, SKILL_NAME);
}

function shipped(): Map<string, Buffer> {
  return new Map(SKILL_FILES.map(([name, text]) => [name, utf8(text)]));
}

function shippedText(name: string): string {
  return (SKILL_FILES.find(([file]) => file === name) as [string, string])[1];
}

function frontMatter(text: string): Map<string, string> {
  const lines = text.split("\n");
  if (lines.length === 0 || (lines[0] ?? "").trim() !== "---") return new Map();
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") return fields;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon);
    if (key !== "" && !key.startsWith(" ")) fields.set(key.trim(), line.slice(colon + 1).trim());
  }
  return new Map();
}

export function skillText(full: boolean): string {
  const text = shippedText("SKILL.md");
  if (!full) return text;
  const parts = [text];
  for (const [name, body] of SKILL_FILES) {
    if (name !== "SKILL.md" && name.endsWith(".md")) parts.push(`\n--- ${name} ---\n\n${body}`);
  }
  return parts.join("");
}

export function printSkill(full: boolean): Lines & { raw: string } {
  const text = skillText(full);
  return { status: 0, out: [], raw: text, outputChars: codePoints(text).length };
}

export function listSkills(): Lines {
  const fields = frontMatter(shippedText("SKILL.md"));
  return { status: 0, out: [`${fields.get("name") ?? SKILL_NAME}\t${fields.get("description") ?? ""}`] };
}

function legacyVersions(): JsonObject[] {
  try {
    const parsed = parseText(SKILL_HASHES);
    const versions = parsed instanceof Map ? parsed.get("versions") : undefined;
    if (!Array.isArray(versions)) return [];
    return versions.filter((version): version is JsonObject => version instanceof Map);
  } catch {
    return [];
  }
}

function safeRelative(name: Value): name is string {
  if (typeof name !== "string" || name === "" || name.startsWith("/") || name.includes("\\")) return false;
  const parts = name.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..") && parts[0] !== MARKER;
}

function readMarker(folder: string, skill = SKILL_NAME): JsonObject | undefined {
  const marker = join(folder, MARKER);
  if (isLink(marker) || !isFile(marker)) return undefined;
  let data: Value | undefined;
  try {
    const raw = readFileSync(marker);
    data = parseText(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw).replace(/\r\n?/g, "\n"));
  } catch {
    return undefined;
  }
  if (!(data instanceof Map) || data.get("vendor") !== "ardia" || !Array.isArray(data.get("files"))) return undefined;
  const named = data.has("skill") ? data.get("skill") : SKILL_NAME;
  return named === skill ? data : undefined;
}

function markedFiles(folder: string, skill = SKILL_NAME): string[] | undefined {
  const data = readMarker(folder, skill);
  if (data === undefined) return undefined;
  return (data.get("files") as Value[]).filter(safeRelative);
}

function plainFiles(folder: string): Set<string> | undefined {
  const files = new Set<string>();
  const pending = [""];
  while (pending.length > 0) {
    const relative = pending.shift() as string;
    const here = relative === "" ? folder : join(folder, relative);
    let names: string[];
    try {
      names = readdirSync(here);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(here, name);
      if (isLink(path) || !(isDir(path) || isFile(path))) return undefined;
      const inner = relative === "" ? name : `${relative}/${name}`;
      if (isDir(path)) pending.push(inner);
      else files.add(inner);
    }
  }
  return files;
}

function sameHashes(found: Map<string, string>, version: JsonObject): boolean {
  if (found.size !== version.size) return false;
  for (const [name, hash] of found) if (version.get(name) !== hash) return false;
  return true;
}

function ownedFiles(folder: string, adopt = false): string[] | undefined {
  if (isLink(folder) || !isDir(folder)) return undefined;
  const marked = markedFiles(folder);
  if (marked !== undefined || !adopt) return marked;
  const files = plainFiles(folder);
  if (files === undefined) return undefined;
  const hashes = new Map<string, string>();
  try {
    for (const name of files) hashes.set(name, createHash("sha256").update(readFileSync(join(folder, name))).digest("hex"));
  } catch {
    return undefined;
  }
  return legacyVersions().some((version) => sameHashes(hashes, version)) ? [...files].sort() : undefined;
}

function realParent(folder: string, name: string): string {
  let at = folder;
  for (const part of name.split("/").slice(0, -1)) {
    at = join(at, part);
    if (isLink(at) || (exists(at) && !isDir(at))) throw new SkillError(`${at} isn't a plain folder; move it away first`);
    if (!exists(at)) mkdirSync(at);
  }
  return at;
}

function writeFile(folder: string, name: string, data: Buffer): void {
  const at = realParent(folder, name);
  const staging = join(at, `.ardia-skill-${randomBytes(6).toString("base64url")}`);
  const fd = openSync(staging, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, data);
    } finally {
      closeSync(fd);
    }
    chmodSync(staging, 0o644);
    renameSync(staging, join(at, name.split("/").at(-1) as string));
  } catch (error) {
    try {
      unlinkSync(staging);
    } catch {}
    throw error;
  }
}

function removeFile(folder: string, name: string): void {
  let at = folder;
  for (const part of name.split("/").slice(0, -1)) {
    at = join(at, part);
    if (isLink(at) || !isDir(at)) return;
  }
  const path = join(at, name.split("/").at(-1) as string);
  if (!isLink(path) && isFile(path)) unlinkSync(path);
}

function markerText(data: JsonObject): Buffer {
  return utf8(`${dumps(data, "indented", true)}\n`);
}

function writePack(folder: string, previous: string[], pack: Map<string, Buffer>, marker: JsonObject): void {
  const files = [...pack.keys()].sort();
  for (const name of files) writeFile(folder, name, pack.get(name) as Buffer);
  for (const name of [...new Set(previous)].filter((name) => !files.includes(name)).sort()) removeFile(folder, name);
  const written: JsonObject = new Map(marker);
  written.set("files", files);
  writeFile(folder, MARKER, markerText(written));
}

function installInto(folder: string, companions: Value | undefined, adopt = false, replace = false): void {
  let previous: string[] = [];
  let chosen = companions;
  const owned = present(folder) ? ownedFiles(folder, adopt) : undefined;
  if (owned !== undefined) {
    previous = owned;
    if (chosen === undefined) chosen = readMarker(folder)?.get("companions");
  } else if (present(folder)) {
    if (!replace) throw new SkillError(`${folder} exists and isn't a copy ardia installed; move it away, or replace that folder with --replace`);
    if (isLink(folder) || !isDir(folder)) unlinkSync(folder);
    else rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder);
  } else mkdirSync(folder, { recursive: true });
  const marker: JsonObject = object([
    ["vendor", "ardia"],
    ["version", cliVersion()],
  ]);
  if (Array.isArray(chosen)) marker.set("companions", chosen.filter((name) => typeof name === "string" && COMPANIONS.includes(name)));
  writePack(folder, previous, shipped(), marker);
}

function noteCompanions(folder: string, names: string[]): void {
  const data = readMarker(folder);
  if (data === undefined) return;
  data.set("companions", names);
  writeFile(folder, MARKER, markerText(data));
}

function companionFolder(folder: string): string {
  return join(parent(folder), CUA_SKILL);
}

async function installCompanion(folder: string): Promise<string> {
  let previous: string[] = [];
  if (present(folder)) {
    const owned = isLink(folder) || !isDir(folder) ? undefined : markedFiles(folder, CUA_SKILL);
    if (owned === undefined) return `kept ${folder}: a ${CUA_SKILL} skill is already there and ardia didn't install it (cua-driver's own installer?)`;
    previous = owned;
  }
  const pack = await skillPack();
  if (!exists(folder)) mkdirSync(folder, { recursive: true });
  const marker = object([
    ["vendor", "ardia"],
    ["skill", CUA_SKILL],
    ["upstream", `trycua/cua cua-driver-rs-v${CUA_VERSION}`],
    ["version", CUA_VERSION],
  ]);
  writePack(folder, previous, pack, marker);
  return `${CUA_SKILL} ${CUA_VERSION}: ${folder}`;
}

async function companionLine(folder: string): Promise<[string, boolean]> {
  try {
    return [await installCompanion(folder), false];
  } catch (error) {
    if (error instanceof Refused || errnoOf(error) || error instanceof SkillError) return [`error ${folder}: ${osError(error)}`, true];
    throw error;
  }
}

function recordPath(): string {
  return join(cliHome(), "skills.json");
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/");
}

function recordedFolders(): string[] {
  let folders: Value | undefined;
  try {
    const parsed = parseText(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(recordPath())));
    if (!(parsed instanceof Map)) return [];
    folders = parsed.has("folders") ? parsed.get("folders") : [];
  } catch {
    return [];
  }
  let entries: Value[];
  if (Array.isArray(folders)) entries = folders;
  else if (typeof folders === "string") entries = codePoints(folders);
  else if (folders instanceof Map) entries = [...folders.keys()];
  else return [];
  return entries.filter((folder): folder is string => typeof folder === "string" && isAbsolute(folder)).map(normalized);
}

function normalized(path: string): string {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  return `/${parts.join("/")}`;
}

function saveRecord(folders: string[]): void {
  const path = recordPath();
  try {
    mkdirSync(parent(path), { recursive: true });
    const staging = join(parent(path), `.skills.${process.pid}.json`);
    writeFileSync(staging, markerText(object([["folders", [...new Set(folders)]]])));
    renameSync(staging, path);
  } catch {}
}

function absolute(path: string): string {
  return normalized(isAbsolute(path) ? path : join(process.cwd(), path));
}

export async function install(targets: string[], project: boolean, computerUse = true, replace = false): Promise<Lines> {
  const written = new Map<string, string[]>();
  for (const target of new Set(targets)) {
    const folder = destination(target, project);
    written.set(folder, [...(written.get(folder) ?? []), target]);
  }
  let status = 0;
  const installed: string[] = [];
  const out: string[] = [];
  for (const [folder, names] of written) {
    const label = names.join(", ");
    try {
      installInto(folder, computerUse ? undefined : [], true, replace);
    } catch (error) {
      if (!(error instanceof SkillError) && !errnoOf(error)) throw error;
      out.push(`${label}: error ${osError(error)}`);
      status = 1;
      continue;
    }
    installed.push(absolute(folder));
    out.push(`${label}: ${folder}`);
    if (computerUse) {
      const [line, failed] = await companionLine(companionFolder(folder));
      out.push(`${label}: ${line}`);
      if (failed) status = 1;
      else noteCompanions(folder, [...COMPANIONS]);
    }
  }
  if (installed.length > 0) saveRecord([...recordedFolders(), ...installed]);
  return { status, out };
}

function detectedTargets(): string[] {
  const found = AGENT_HOMES.filter(([, agentHome]) => isDir(join(home(), agentHome))).map(([target]) => target);
  return found.length > 0 ? found : ["general"];
}

export async function installDetected(computerUse = true): Promise<Lines> {
  const recorded = new Set(recordedFolders());
  const targets: string[] = [];
  const out: string[] = [];
  for (const target of detectedTargets()) {
    const folder = absolute(destination(target, false));
    const there = present(folder);
    if (!there && recorded.has(folder)) {
      out.push(`${target}: skipped ${folder}: removed after an earlier install`);
      continue;
    }
    if (there && ownedFiles(folder) === undefined) {
      out.push(`${target}: skipped ${folder}: not installed by ardia`);
      continue;
    }
    targets.push(target);
  }
  const counts: [string, number][] = [
    ["skills_installed", targets.length],
    ["skills_skipped", detectedTargets().length - targets.length],
  ];
  if (targets.length === 0) return { status: 0, out, counts };
  const done = await install(targets, false, computerUse);
  return { status: done.status, out: [...out, ...done.out], counts };
}

function mentions(companions: Value, name: string): boolean {
  if (typeof companions === "string") return companions.includes(name);
  if (Array.isArray(companions)) return companions.includes(name);
  if (companions instanceof Map) return companions.has(name);
  throw new TypeError("argument of this type is not iterable");
}

export async function refresh(): Promise<Lines> {
  const userFolders = Object.keys(TARGETS).map((target) => destination(target, false));
  let status = 0;
  const kept: string[] = [];
  const out: string[] = [];
  for (const folder of new Set([...recordedFolders(), ...userFolders])) {
    if (!present(folder)) continue;
    if (ownedFiles(folder) === undefined) {
      out.push(`skipped ${folder}: not installed by ardia skills install (no ${MARKER} marker)`);
      continue;
    }
    kept.push(folder);
    try {
      installInto(folder, undefined);
    } catch (error) {
      if (!(error instanceof SkillError) && !errnoOf(error)) throw error;
      out.push(`error ${folder}: ${osError(error)}`);
      status = 1;
      continue;
    }
    out.push(`refreshed ${folder}`);
    const companions = readMarker(folder)?.get("companions") ?? undefined;
    const cua = companionFolder(folder);
    const ours = markedFiles(cua, CUA_SKILL) !== undefined && !isLink(cua);
    if ((companions === undefined && !present(cua)) || (ours && (companions === undefined || mentions(companions, CUA_SKILL)))) {
      const [line, failed] = await companionLine(cua);
      out.push(line.startsWith("error") ? line : `refreshed ${cua}`);
      if (failed) {
        status = 1;
        continue;
      }
    }
    if (companions === undefined) noteCompanions(folder, [...COMPANIONS]);
  }
  saveRecord(kept);
  return { status, out };
}
