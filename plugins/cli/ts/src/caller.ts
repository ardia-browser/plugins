import { closeSync, openSync, readFileSync, readlinkSync, readSync } from "node:fs";
import { object, type JsonObject } from "./json.ts";
import { processInfo } from "./libc.ts";
import { topLevelString } from "./plist.ts";

export const FALLBACK = "ardia";
const MAX_NAME = 40;
const MAX_APP_PATH = 1024;
const MAX_DEPTH = 64;
const MAX_INFO_PLIST = 1024 * 1024;
const AGENTS: readonly (readonly [string, string])[] = [
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["cursor-agent", "Cursor Agent"],
  ["gemini", "Gemini CLI"],
  ["opencode", "OpenCode"],
  ["aider", "Aider"],
  ["amp", "Amp"],
  ["goose", "Goose"],
  ["crush", "Crush"],
  ["droid", "Droid"],
  ["qwen", "Qwen Code"],
  ["copilot", "Copilot CLI"],
  ["kiro-cli", "Kiro"],
  ["cline", "Cline"],
];
const INTERPRETERS = ["node", "bun", "deno", "python", "ruby"];
const SCRIPT_SUFFIXES = [".js", ".mjs", ".cjs", ".ts", ".py", ".rb"];
const LOSSY = new TextDecoder("utf-8");

export type Process = { pid: number; ppid: number; path: string; argv: string[] };
export type Caller = { name: string; app?: string };

function isWhiteSpace(code: number): boolean {
  return (code >= 0x09 && code <= 0x0d) || code === 0x20 || code === 0x85 || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000;
}

function isSeparator(code: number): boolean {
  return isWhiteSpace(code) || (code >= 0x1c && code <= 0x1f);
}

function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xad || (code >= 0x600 && code <= 0x605) || code === 0x61c || code === 0x6dd
    || code === 0x70f || code === 0x180e || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x2064)
    || (code >= 0x2066 && code <= 0x206f) || code === 0xfeff || (code >= 0xfff9 && code <= 0xfffb) || (code >= 0xd800 && code <= 0xf8ff)
    || (code >= 0xe0000 && code <= 0xe007f) || code >= 0xf0000;
}

function trimWhiteSpace(chars: string[]): string[] {
  let start = 0;
  let end = chars.length;
  while (start < end && isWhiteSpace(chars[start]!.codePointAt(0)!)) start += 1;
  while (end > start && isWhiteSpace(chars[end - 1]!.codePointAt(0)!)) end -= 1;
  return chars.slice(start, end);
}

export function cleanName(text: string): string | undefined {
  let kept = "";
  for (const char of text.toWellFormed()) {
    const code = char.codePointAt(0)!;
    if (isSeparator(code)) kept += " ";
    else if (!isControl(code)) kept += char;
  }
  const joined = kept.split(" ").filter((word) => word !== "").join(" ");
  const name = trimWhiteSpace(Array.from(joined).slice(0, MAX_NAME)).join("");
  return name === "" ? undefined : name;
}

function baseName(word: string): string {
  return word.replace(/\/+$/, "").split("/").at(-1) ?? "";
}

export function commandName(word: string): string {
  const base = baseName(word).toLowerCase();
  const suffix = SCRIPT_SUFFIXES.find((ending) => base.endsWith(ending));
  return suffix === undefined ? base : base.slice(0, base.length - suffix.length);
}

function isInterpreter(word: string): boolean {
  const base = commandName(word);
  return INTERPRETERS.some((name) => {
    if (base === name) return true;
    if (!base.startsWith(name)) return false;
    const digits = base.slice(name.length).replaceAll(".", "");
    return digits !== "" && /^[0-9]+$/.test(digits);
  });
}

export function agentOf(process: Process): string | undefined {
  const words = process.argv.length > 0 ? [process.argv[0]!] : [];
  words.push(process.path);
  if (words.some(isInterpreter)) {
    const script = process.argv[1];
    if (script !== undefined && !script.startsWith("-")) words.push(script);
  }
  for (const word of words) {
    const name = commandName(word);
    const agent = AGENTS.find(([key]) => key === name);
    if (agent !== undefined) return agent[1];
  }
  return undefined;
}

export function outerBundle(path: string): string | undefined {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  for (let index = 0; index + 1 < parts.length; index += 1) {
    const part = parts[index]!;
    if (part.endsWith(".app") && Buffer.byteLength(part) > 4 && parts[index + 1] === "Contents") {
      const joined = parts.slice(0, index + 1).join("/");
      return path.startsWith("/") ? `/${joined}` : joined;
    }
  }
  return undefined;
}

function readInfoPlist(bundle: string): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(`${bundle}/Contents/Info.plist`, "r");
  } catch {
    return undefined;
  }
  try {
    const raw = Buffer.alloc(MAX_INFO_PLIST);
    let filled = 0;
    while (filled < raw.length) {
      const got = readSync(fd, raw, filled, raw.length - filled, null);
      if (got === 0) break;
      filled += got;
    }
    return raw.subarray(0, filled);
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

export function bundleName(bundle: string): string | undefined {
  const raw = readInfoPlist(bundle);
  if (raw !== undefined) {
    for (const key of ["CFBundleDisplayName", "CFBundleName"]) {
      const value = topLevelString(raw, key);
      const name = value === undefined ? undefined : cleanName(value);
      if (name !== undefined) return name;
    }
  }
  const folder = baseName(bundle);
  return cleanName(folder.endsWith(".app") ? folder.slice(0, -4) : folder);
}

export function fromChain(chain: Process[], readBundleName: (bundle: string) => string | undefined = bundleName): Caller {
  for (const process of chain) {
    const agent = agentOf(process);
    if (agent !== undefined) return { name: agent };
  }
  for (const process of chain) {
    const bundle = outerBundle(process.path);
    if (bundle === undefined) continue;
    const name = readBundleName(bundle);
    if (name !== undefined) return Array.from(bundle).length <= MAX_APP_PATH ? { name, app: bundle } : { name };
  }
  return { name: FALLBACK };
}

export function procArgs(raw: Buffer): string[] {
  if (raw.length < 4) return [];
  const argc = raw.readInt32LE(0);
  const rest = raw.subarray(4);
  const end = rest.indexOf(0);
  if (end < 0) return [];
  let start = end;
  while (start < rest.length && rest[start] === 0) start += 1;
  const wanted = Math.min(Math.max(argc, 0), 2);
  const words: string[] = [];
  let at = start;
  while (words.length < wanted) {
    const stop = rest.indexOf(0, at);
    words.push(LOSSY.decode(rest.subarray(at, stop < 0 ? rest.length : stop)));
    if (stop < 0) break;
    at = stop + 1;
  }
  return words;
}

function macProcess(pid: number): Process | undefined {
  const facts = processInfo(pid);
  if (facts === null) return undefined;
  return { pid, ppid: facts.ppid, path: LOSSY.decode(facts.path), argv: procArgs(facts.args) };
}

function linuxProcess(pid: number, root = "/proc"): Process | undefined {
  let ppid: number;
  try {
    const stat = readFileSync(`${root}/${pid}/stat`);
    const close = stat.lastIndexOf(")".charCodeAt(0));
    if (close < 0) return undefined;
    const fields = stat.subarray(close + 1).toString("latin1").split(/[\t\n\f\r ]+/).filter((field) => field !== "");
    const text = fields[1];
    if (text === undefined || !/^\+?[0-9]+$/.test(text) || Number(text) > 0xffffffff) return undefined;
    ppid = Number(text);
  } catch {
    return undefined;
  }
  let path = "";
  try {
    path = LOSSY.decode(readlinkSync(`${root}/${pid}/exe`, { encoding: "buffer" }));
    while (path.endsWith(" (deleted)")) path = path.slice(0, -" (deleted)".length);
  } catch {}
  let argv: string[] = [];
  try {
    const raw = readFileSync(`${root}/${pid}/cmdline`);
    const words: Buffer[] = [];
    let at = 0;
    while (words.length < 2 && at <= raw.length) {
      const stop = raw.indexOf(0, at);
      words.push(raw.subarray(at, stop < 0 ? raw.length : stop));
      if (stop < 0) break;
      at = stop + 1;
    }
    argv = words.filter((word) => word.length > 0).map((word) => LOSSY.decode(word));
  } catch {}
  return { pid, ppid, path, argv };
}

export function ancestry(start: number, read: (pid: number) => Process | undefined = process.platform === "darwin" ? macProcess : linuxProcess): Process[] {
  const chain: Process[] = [];
  const seen = new Set<number>();
  for (let pid = start; pid > 1 && !seen.has(pid) && chain.length < MAX_DEPTH; ) {
    seen.add(pid);
    const found = read(pid);
    if (found === undefined) break;
    chain.push(found);
    pid = found.ppid;
  }
  return chain;
}

export function currentCaller(): Caller {
  return fromChain(ancestry(process.ppid));
}

export function callerWire(caller: Caller): JsonObject {
  return object(caller.app === undefined ? [["name", caller.name]] : [["name", caller.name], ["app", caller.app]]);
}
