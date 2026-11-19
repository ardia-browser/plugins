import { closeSync, openSync, readSync } from "node:fs";
import { type JsonObject } from "./json.ts";
import { topLevelString } from "./plist.ts";
import { isWhitespace } from "./py.ts";

export const FALLBACK = "ardia";
const MAX_NAME = 40;
const MAX_APP_PATH = 1024;
const AGENTS: [string, string][] = [
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

export type Process = { pid: number; ppid: number; path: string; argv: string[] };
export type Caller = { name: string; app: string | undefined };

export function wire(caller: Caller): JsonObject {
  const fields: JsonObject = new Map([["name", caller.name]]);
  if (caller.app !== undefined) fields.set("app", caller.app);
  return fields;
}

function between(code: number, low: number, high: number): boolean {
  return code >= low && code <= high;
}

function isControl(code: number): boolean {
  return (
    code < 0x20 ||
    between(code, 0x7f, 0x9f) ||
    code === 0xad ||
    between(code, 0x600, 0x605) ||
    code === 0x61c ||
    code === 0x6dd ||
    code === 0x70f ||
    code === 0x180e ||
    between(code, 0x200b, 0x200f) ||
    between(code, 0x202a, 0x202e) ||
    between(code, 0x2060, 0x2064) ||
    between(code, 0x2066, 0x206f) ||
    code === 0xfeff ||
    between(code, 0xfff9, 0xfffb) ||
    between(code, 0xd800, 0xf8ff) ||
    between(code, 0xe0000, 0xe007f) ||
    code >= 0xf0000
  );
}

function isSeparator(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    isWhitespace(ch) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    between(code, 0x2000, 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    between(code, 0x1c, 0x1f)
  );
}

export function cleanName(text: string): string | undefined {
  let kept = "";
  for (const ch of text) {
    if (isSeparator(ch)) kept += " ";
    else if (!isControl(ch.codePointAt(0) ?? 0)) kept += ch;
  }
  const joined = kept.split(" ").filter((word) => word !== "").join(" ");
  const name = [...joined].slice(0, MAX_NAME).join("");
  const chars = [...name];
  let start = 0;
  let end = chars.length;
  while (start < end && isWhitespace(chars[start] ?? "")) start += 1;
  while (end > start && isWhitespace(chars[end - 1] ?? "")) end -= 1;
  const trimmed = chars.slice(start, end).join("");
  return trimmed === "" ? undefined : trimmed;
}

function baseName(word: string): string {
  const trimmed = word.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export function commandName(word: string): string {
  const base = baseName(word).toLowerCase();
  for (const suffix of SCRIPT_SUFFIXES) {
    if (base.endsWith(suffix)) return base.slice(0, base.length - suffix.length);
  }
  return base;
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
  const words: string[] = process.argv[0] !== undefined ? [process.argv[0]] : [];
  words.push(process.path);
  if (words.some(isInterpreter)) {
    const script = process.argv[1];
    if (script !== undefined && !script.startsWith("-")) words.push(script);
  }
  for (const word of words) {
    const name = commandName(word);
    const found = AGENTS.find(([key]) => key === name);
    if (found !== undefined) return found[1];
  }
  return undefined;
}

export function outerBundle(path: string): string | undefined {
  const rooted = path.startsWith("/");
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  for (let index = 0; index + 1 < parts.length; index += 1) {
    const part = parts[index] ?? "";
    if (part.endsWith(".app") && Buffer.byteLength(part) > 4 && parts[index + 1] === "Contents") {
      const joined = parts.slice(0, index + 1).join("/");
      return rooted ? `/${joined}` : joined;
    }
  }
  return undefined;
}

function readInfo(bundle: string): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(`${bundle}/Contents/Info.plist`, "r");
  } catch {
    return undefined;
  }
  try {
    const limit = 1024 * 1024;
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < limit) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, limit - total));
      const got = readSync(fd, chunk, 0, chunk.length, null);
      if (got === 0) break;
      chunks.push(chunk.subarray(0, got));
      total += got;
    }
    return Buffer.concat(chunks);
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

export function bundleName(bundle: string): string | undefined {
  const raw = readInfo(bundle);
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
    if (agent !== undefined) return { name: agent, app: undefined };
  }
  for (const process of chain) {
    const bundle = outerBundle(process.path);
    if (bundle === undefined) continue;
    const name = readBundleName(bundle);
    if (name !== undefined) return { name, app: [...bundle].length <= MAX_APP_PATH ? bundle : undefined };
  }
  return { name: FALLBACK, app: undefined };
}
