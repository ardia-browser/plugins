import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { dumps, Float, type JsonObject, type Value } from "../json.ts";
import { expandUser } from "../paths.ts";
import { repr } from "../py.ts";
import { codePoints } from "../pystr.ts";
import { groupThousands } from "../pylib/format.ts";
import { joinedWords, splitlines } from "../pylib/str.ts";
import { redact } from "../redact.ts";
import { Usage } from "./daemon-errors.ts";
import { wellFormed, writeAllFd } from "./paths.ts";

export const TAKES_OUT = ["script", "eval", "read", "snapshot", "get"];
export const AS_TEXT = ["snapshot", "get"];
const PREVIEW = 300;
const EXCERPT = 500;
const SHOWN = 3000;
const EXCERPT_PAGES = 12;
export const LOG_LINES = 20;

function size(text: string): number {
  return codePoints(text).length;
}

function head(text: string, count: number): string {
  return codePoints(text).slice(0, count).join("");
}

function line(value: Value): string {
  return dumps(value, "spaced");
}

function indented(value: Value): string {
  return dumps(value, "indented");
}

function pyStr(value: Value | undefined): string {
  if (value === undefined || value === null) return "None";
  return typeof value === "string" ? value : repr(value);
}

function isRows(value: Value | undefined): value is JsonObject[] {
  return Array.isArray(value) && value.length > 0 && value.every((row) => row instanceof Map);
}

export function takeOut(argv: readonly string[], command: string | undefined): [string[], string | null] {
  if (command === undefined || !TAKES_OUT.includes(command) || !argv.includes(command)) return [[...argv], null];
  const start = argv.indexOf(command) + 1;
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === "--") break;
    if (token.startsWith("--out=")) return [[...argv.slice(0, index), ...argv.slice(index + 1)], checked(token.slice("--out=".length))];
    if (token === "--out") {
      if (index + 1 >= argv.length) throw new Usage(`--out takes a file path: ${command} … --out data.json`);
      return [[...argv.slice(0, index), ...argv.slice(index + 2)], checked(argv[index + 1] as string)];
    }
  }
  return [[...argv], null];
}

function checked(path: string): string {
  if (!path || path.startsWith("-")) throw new Usage("--out takes a file path, like --out data.json");
  return path;
}

export function tabular(value: Value | undefined): JsonObject[] | null {
  if (isRows(value)) return value;
  if (value instanceof Map) {
    const lists = [...value.values()].filter(isRows);
    if (lists.length === 1) return lists[0] as JsonObject[];
  }
  return null;
}

function cell(value: Value | undefined): string {
  if (value === undefined || value === null) return "";
  if (value instanceof Map || Array.isArray(value)) return line(value);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "bigint") return String(value);
  return repr(value);
}

function csvField(text: string, delimiter: string, alone: boolean): string {
  if (text.includes(delimiter) || text.includes('"') || text.includes("\n") || text.includes("\r") || (alone && text === "")) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function asCsv(rows: JsonObject[], delimiter: string): string {
  const fields: string[] = [];
  for (const row of rows) for (const key of row.keys()) if (!fields.includes(key)) fields.push(key);
  const write = (values: string[]) => `${values.map((value) => csvField(value, delimiter, values.length === 1)).join(delimiter)}\n`;
  let out = write(fields);
  for (const row of rows) out += write(fields.map((key) => cell(row.get(key))));
  return out;
}

function shownRows(items: Value[]): string {
  const lines: string[] = [];
  let used = 0;
  for (const item of items) {
    const text = line(item);
    if (used + size(text) > SHOWN && lines.length > 0) break;
    lines.push(head(text, SHOWN));
    used += size(text) + 1;
  }
  const rest = items.length - lines.length;
  return `\nrows:\n${lines.join("\n")}${rest ? `\n… ${rest} more rows in the file` : ""}`;
}

function listDigest(items: Value[]): string {
  const top = `a list of ${items.length} item${items.length !== 1 ? "s" : ""}`;
  if (items.length === 0) return top;
  const keys = [...new Set(items.slice(0, 50).flatMap((item) => (item instanceof Map ? [...item.keys()] : [])))].sort(compareCodePoints);
  const lines = [top + (keys.length > 0 ? ` with fields ${keys.slice(0, 20).join(", ")}` : "")];
  lines.push(`first: ${head(line(items[0] as Value), PREVIEW)}`);
  if (items.length > 1) lines.push(`last: ${head(line(items.at(-1) as Value), PREVIEW)}`);
  return lines.join("\n");
}

function compareCodePoints(a: string, b: string): number {
  const left = codePoints(a);
  const right = codePoints(b);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = (left[index] as string).codePointAt(0)! - (right[index] as string).codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function suffix(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function get(data: JsonObject, key: string): Value | undefined {
  return data.get(key);
}

export function content(command: string, data: JsonObject, path: string): [string, string] {
  const ext = suffix(path);
  if (command === "read" && (data.has("blocks") || data.has("block"))) {
    const value = (data.has("block") ? get(data, "data") : get(data, "blocks")) ?? null;
    const text = `${indented(value)}\n`;
    return [text, Array.isArray(value) ? listDigest(value) + shownRows(value) : `embedded data, ${groupThousands(String(size(text)))} characters of JSON`];
  }
  if (command === "read" && data.has("rows")) {
    const rows = (get(data, "rows") as Value[] | null) || [];
    const text = ext === ".json" ? indented(rows) : `${rows.map(pyStr).join("\n")}\n`;
    return [text, `${listDigest(rows)}\n(stopped: ${pyStr(get(data, "stopped"))}; ${pyStr(get(data, "total"))} rows in the list)`];
  }
  if (command === "read" && !data.has("pages") && data.has("content")) {
    const body = get(data, "content") ? pyStr(get(data, "content")) : "";
    return [body + (body && !body.endsWith("\n") ? "\n" : ""), `the page's text, starting ${line(head(joinedWords(body), EXCERPT))}`];
  }
  if (command === "read") {
    const pages = ((get(data, "pages") as Value[] | null) || []) as JsonObject[];
    const failed = pages.filter((page) => page.get("error")).length;
    const lines = [`${pages.length} page${pages.length !== 1 ? "s" : ""}${failed ? `, ${failed} failed` : ""}:`];
    for (const page of pages.slice(0, EXCERPT_PAGES)) {
      const facts = [page.get("status") ? `HTTP ${pyStr(page.get("status"))}` : null, page.get("readAt") ? pyStr(page.get("readAt")) : null].filter((fact) => fact).join(", ");
      const title = head(page.get("title") ? pyStr(page.get("title")) : "(no title)", 80);
      const where = page.get("finalUrl") ? pyStr(page.get("finalUrl")) : page.get("url") ? pyStr(page.get("url")) : "";
      const text = page.get("text") ? pyStr(page.get("text")) : "";
      const body = page.get("error") ? pyStr(page.get("error")) : head(joinedWords(text), EXCERPT);
      lines.push(`- ${title}${facts ? ` (${facts})` : ""} ${where}\n  ${body}${!page.get("error") && size(text) > EXCERPT ? " …" : ""}`);
      if (page.get("note")) lines.push(`  (${pyStr(page.get("note"))})`);
    }
    if (pages.length > EXCERPT_PAGES) lines.push(`- and ${pages.length - EXCERPT_PAGES} more pages in the file`);
    const summary = lines.join("\n");
    if (ext === ".json") return [indented(pages), summary];
    const blocks = pages.map((page) => {
      const title = page.get("title") ? pyStr(page.get("title")) : "(no title)";
      const where = page.get("finalUrl") ? pyStr(page.get("finalUrl")) : page.get("url") ? pyStr(page.get("url")) : "";
      const body = page.get("text") ? pyStr(page.get("text")) : page.get("error") ? pyStr(page.get("error")) : "";
      return `=== ${title}\n${where}\n\n${body}`;
    });
    return [`${blocks.join("\n")}\n`, summary];
  }
  const value = (command === "script" ? get(data, "value") : get(data, "result")) ?? null;
  if (typeof value === "string") return [value, `text starting ${line(head(value, PREVIEW))}`];
  const table = ext === ".csv" || ext === ".tsv" ? tabular(value) : null;
  if (table !== null) return [asCsv(table, ext === ".tsv" ? "\t" : ","), listDigest(table) + shownRows(table)];
  const text = `${indented(value)}\n`;
  if (Array.isArray(value)) return [text, listDigest(value) + shownRows(value)];
  if (value instanceof Map) {
    const keys = [...value.keys()];
    const parts = keys.slice(0, 20).map((key) => {
      const item = value.get(key);
      return Array.isArray(item) ? `${key} (${item.length} items)` : key;
    });
    let digest = `an object with ${keys.length} key${keys.length !== 1 ? "s" : ""}: ${parts.join(", ")}${keys.length > 20 ? ", …" : ""}`;
    const lists = keys.filter((key) => {
      const item = value.get(key);
      return Array.isArray(item) && item.length > 0;
    });
    if (lists.length > 0) {
      const first = value.get(lists[0] as string) as Value[];
      digest += `\n${lists[0]}: ${listDigest(first)}${shownRows(first)}`;
    }
    return [text, digest];
  }
  if (value === null) return [text, "nothing (the result was undefined or null)"];
  return [text, `the value ${head(text.trim(), PREVIEW)}`];
}

export function savesAsCsv(command: string, data: JsonObject, path: string): boolean {
  const ext = suffix(path);
  if (command === "read" || !(ext === ".csv" || ext === ".tsv")) return false;
  const value = command === "script" ? data.get("value") : data.get("result");
  return typeof value !== "string" && tabular(value) !== null;
}

function currentUmask(): number {
  const mask = process.umask(0);
  process.umask(mask);
  return mask;
}

export function savedBody(command: string, answer: JsonObject): Uint8Array | null {
  const encoded = command === "read" ? answer.get("body") : undefined;
  if (typeof encoded !== "string") return null;
  const body = Buffer.from(encoded, "base64");
  if (body.toString("base64") !== encoded || answer.get("body_bytes") !== BigInt(body.length)) throw new BodyDamaged();
  return body;
}

export class BodyDamaged extends Error {}

export function savedBodyLine(target: string, body: Uint8Array, data: JsonObject): string {
  const kind = data.get("contentType");
  return `✓ Saved to ${target} (${groupThousands(String(body.length))} bytes${typeof kind === "string" && kind ? `, ${kind}` : ""}), the response body byte for byte (after any HTTP content decoding)\n`;
}

export function save(path: string, text: string | Uint8Array): string {
  const target = expandUser(path);
  let folder = false;
  try {
    folder = statSync(target).isDirectory();
  } catch {}
  if (folder) throw new Usage(`--out ${path} is a folder; give a file path, like ${join(path, "data.json")}`);
  mkdirSync(dirname(target) || ".", { recursive: true });
  const scratch = mkdtempSync(join(dirname(target) || ".", `.${basename(target)}.`));
  const temporary = `${scratch}.part`;
  rmSync(scratch, { recursive: true, force: true });
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeAllFd(fd, typeof text === "string" ? Buffer.from(wellFormed(redact(text)), "utf8") : text);
    } finally {
      closeSync(fd);
    }
    chmodSync(temporary, existsSync(target) ? statSync(target).mode & 0o777 : 0o666 & ~currentUmask());
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return target;
}

export function savedLine(target: string, text: string): string {
  const lines = splitlines(text);
  return `✓ Saved to ${target} (${groupThousands(String(size(text)))} characters, ${groupThousands(String(lines.length))} lines). First lines:\n${lines.slice(0, 12).join("\n")}\n`;
}

export function savedSummary(target: string, text: string, summary: string, logs: Value | undefined): string {
  let out = `✓ Saved to ${target} (${groupThousands(String(size(text)))} characters): ${summary}\n`;
  const shown = Array.isArray(logs) ? logs.map(pyStr).slice(-LOG_LINES) : [];
  if (shown.length > 0) out += `logged:\n${shown.join("\n")}\n`;
  return out;
}

export function writeFailure(error: unknown): string {
  if (error instanceof Usage) return error.message;
  const code = (error as NodeJS.ErrnoException).code;
  const reasons: Record<string, string> = {
    EACCES: "Permission denied",
    EPERM: "Operation not permitted",
    ENOENT: "No such file or directory",
    ENOTDIR: "Not a directory",
    EROFS: "Read-only file system",
    ENOSPC: "No space left on device",
    EISDIR: "Is a directory",
  };
  return (code && reasons[code]) || (error instanceof Error ? error.message : String(error));
}

