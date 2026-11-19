import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { dumps, Float, parseText, type Value } from "../../json.ts";
import { openAt } from "../../libc.ts";
import { uid } from "../../paths.ts";
import { codePoints } from "../../pystr.ts";
import { formatG, groupThousands } from "../../pylib/format.ts";
import { inert, jsonSafe } from "../../printable.ts";
import { redact } from "../../redact.ts";
import { BrowseError, ConnectionLost } from "../daemon-errors.ts";
import { flag, rendered } from "../metrics.ts";
import { closeFd, entryInfo, listNames, unlinkQuietly, wellFormed, writeAllFd } from "../paths.ts";
import { tokenHex } from "../tokens.ts";
import { MUTATING } from "./names.ts";

export const MAX_REQUEST = 16 * 1024 * 1024;
export const MAX_RESPONSE = 256 * 1024 * 1024;
export const OUTPUT_CAP = 12000;
export const SCRIPT_OUTPUT_CAP = 20000;
export const SPILL_KEEP = 40;
export const CAP_NOTICE = "[output capped at ";
export const NARROW_ANY = "snapshot -i, snapshot -s <css>, get text <css>, read -s <css>, find role <role> <action> --name <text>";
export const NARROWER: Readonly<Record<string, string>> = {
  snapshot: "snapshot -i (interactive only), snapshot -s <css> (one region), find role <role> <action> --name <text> (act without a snapshot)",
  get: "get text <css> or read -s <css> (one region)",
  read: "read -s <css> (one region per page), or fewer pages",
  eval: "return less from the script, or get text <css> / read -s <css> for one region",
  script: "return fewer fields or rows from the script",
  flow: "flow run <name> --fields a,b --limit n --where field=value",
};

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_WRONLY, O_CREAT, O_EXCL } = fs.constants;
const NAME_LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789_";
const TEMP_ATTEMPTS = 100;

export type Options = Record<string, unknown>;
export type Answer = [number, string, string];

export class Result {
  failed = false;
  batch: unknown = undefined;
  outputCap: number | null = null;

  constructor(
    readonly data: unknown = {},
    readonly text: string | null = "✓ Done",
    readonly pageContent = false,
  ) {}
}

export function pyValue(value: unknown): Value {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "string" || typeof value === "bigint") return value;
  if (value instanceof Float) return value;
  if (typeof value === "number") return Number.isInteger(value) ? BigInt(value) : new Float(value);
  if (Array.isArray(value)) return value.map(pyValue);
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [String(key), pyValue(item)]));
  if (value instanceof Set) return [...value].map(pyValue);
  if (typeof value === "object") return new Map(Object.entries(value).map(([key, item]) => [key, pyValue(item)]));
  return String(value);
}

export function sanitize(value: Value): Value {
  if (typeof value === "string") return redact(value);
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [redact(key), sanitize(item)]));
  if (Array.isArray(value)) return value.map(sanitize);
  return value;
}

export function compactJson(value: unknown): string {
  return jsonSafe(dumps(sanitize(pyValue(value)), "compact"));
}

export function render(options: Options, result: Result | null = null, error: BrowseError | null = null, name = ""): Answer {
  const [code, out, err] = renderInner(options, result, error, name);
  rendered(name, result as never, error === null ? null : { code: error.code ?? null }, out);
  return [code, redact(out), redact(err)];
}

function renderInner(options: Options, result: Result | null, error: BrowseError | null, name: string): Answer {
  const asJson = options["json"];
  if (error !== null) {
    let message = error.text;
    if (error instanceof ConnectionLost && MUTATING.has(name)) message += `; the outcome of \`${name}\` is unknown, so it wasn't retried`;
    if (asJson) {
      const payload: Record<string, unknown> = { success: false, data: error.data ?? null, error: message };
      if (error.code) payload["code"] = error.code;
      return [error.exitCode, `${compactJson(payload)}\n`, ""];
    }
    return [error.exitCode, "", `✗ ${inert(message)}\n`];
  }
  const done = result as Result;
  const code = done.failed ? 1 : 0;
  if (asJson) {
    if (done.batch !== undefined && done.batch !== null) return [code, `${compactJson(done.batch)}\n`, ""];
    return [code, `${compactJson({ success: true, data: done.data, error: null })}\n`, ""];
  }
  if (done.text === null) return [code, "", ""];
  let text = cap(redact(done.text), options, name, done.outputCap);
  const notice = capNotice(text);
  if (done.pageContent && options["content_boundaries"]) text = boundary(text);
  return [code, `${inert(text)}\n`, notice ? `${inert(notice)}\n` : ""];
}

export function boundary(text: string): string {
  const nonce = tokenHex(4);
  return `<<<PAGE_CONTENT ${nonce}>>>\n${text}\n<<<END_PAGE_CONTENT ${nonce}>>>`;
}

function limitOf(options: Options, name: string, fallback: number | null): number {
  const given = options["max_output"];
  if (given === null || given === undefined) return fallback || (name === "script" ? SCRIPT_OUTPUT_CAP : OUTPUT_CAP);
  return Math.trunc(Number(given));
}

export function cap(text: string, options: Options, name = "", fallback: number | null = null): string {
  if (options["full"]) return text;
  const limit = limitOf(options, name, fallback);
  if (limit <= 0 || text.length <= limit) return text;
  const points = codePoints(text);
  if (points.length <= limit) return text;
  let found = -1;
  for (let at = Math.min(limit, points.length - 1); at >= 0; at -= 1) {
    if (points[at] === "\n") {
      found = at;
      break;
    }
  }
  const cut = found >= limit * 0.8 ? found : limit;
  const saved = options["no_spill"] ? null : spill(text);
  const where = saved ? `; all of it is in ${saved}` : "";
  const total = points.length;
  return (
    points.slice(0, cut).join("") +
    `\n${CAP_NOTICE}${groupThousands(String(cut))} of ${groupThousands(String(total))} characters${where}. Narrow it instead: ` +
    `${Object.hasOwn(NARROWER, name) ? NARROWER[name] : NARROW_ANY}. Only if you need every line: --max-output ${total}]`
  );
}

export function capNotice(text: string): string {
  const cut = text.lastIndexOf("\n");
  const last = cut < 0 ? text : text.slice(cut + 1);
  const cutShort = last.startsWith("[") && last.includes("Narrow it instead: ") && last.includes("--max-output ");
  return last.startsWith(CAP_NOTICE) || cutShort ? last : "";
}

export function tempRoot(): string {
  for (const name of ["TMPDIR", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (value) return path.resolve(value);
  }
  return "/tmp";
}

export function spillFolder(): string {
  return path.join(tempRoot(), `ardia-browse-output-${uid()}`);
}

function randomName(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (const byte of bytes) out += NAME_LETTERS[byte % NAME_LETTERS.length];
  return `output-${out}.txt`;
}

export function spill(text: string): string | null {
  const folder = spillFolder();
  let dir: number | undefined;
  let fd: number | undefined;
  let name = "";
  try {
    try {
      fs.mkdirSync(folder, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    dir = fs.openSync(folder, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    const info = fs.fstatSync(dir);
    if (!info.isDirectory() || info.uid !== uid() || (info.mode & 0o077) !== 0) return null;
    for (let attempt = 0; attempt < TEMP_ATTEMPTS && fd === undefined; attempt += 1) {
      name = randomName();
      try {
        fd = openAt(dir, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (fd === undefined) return null;
    writeAllFd(fd, Buffer.from(wellFormed(text), "utf8"));
    closeFd(fd);
    fd = undefined;
    const outputs: [number, string][] = [];
    for (const entry of listNames(dir)) {
      if (!entry.startsWith("output-") || !entry.endsWith(".txt")) continue;
      try {
        outputs.push([entryInfo(dir, entry).mtime, entry]);
      } catch {}
    }
    outputs.sort((a, b) => a[0] - b[0]);
    for (const [, entry] of outputs.slice(0, Math.max(0, outputs.length - SPILL_KEEP))) unlinkQuietly(entry, dir);
  } catch {
    return null;
  } finally {
    closeFd(fd);
    closeFd(dir);
  }
  flag("output_saved", true);
  return path.join(folder, name);
}

export function timedOut(name: string, limit: number): BrowseError {
  const unknown = MUTATING.has(name) ? ", so its outcome is unknown and it wasn't retried" : "";
  return new BrowseError(
    `\`${name}\` didn't finish within ${formatG(limit)} s and was stopped${unknown}. Snapshot to see where the page is`,
    null,
    "command_timeout",
  );
}

export function joinedBatch(out: string, closed: string, options: Options): string {
  if (!options["json"]) return (out.trim() ? `${out.replace(/\n+$/u, "")}\n\n` : "") + closed;
  let outcomes: Value | undefined;
  let answer: Value | undefined;
  try {
    outcomes = parseText(out);
    answer = parseText(closed);
  } catch {
    return out + closed;
  }
  if (outcomes === undefined || answer === undefined) return out + closed;
  if (!Array.isArray(outcomes) || !(answer instanceof Map)) return out + closed;
  outcomes.push(
    new Map<string, Value>([
      ["command", ["close"]],
      ["success", answer.get("success") ?? false],
      ["result", answer.get("data") ?? null],
      ["error", answer.get("error") ?? null],
    ]),
  );
  return `${dumps(outcomes, "compact")}\n`;
}

export function encodeAnswer(code: number, out: string, err: string, fields: [string, Value][] = [], limit = MAX_RESPONSE): Buffer {
  const answer = new Map<string, Value>([["exit", BigInt(code)], ["out", out], ["err", err], ...fields]);
  const data = Buffer.from(`${wellFormed(dumps(answer, "spaced"))}\n`, "utf8");
  if (data.length <= limit) return data;
  const message = `✗ The answer was too large (${data.length} bytes, the limit is ${limit}); narrow it (snapshot -s, -d, --max-output)\n`;
  const daemon = fields.filter(([key]) => key === "daemon");
  const fallback = new Map<string, Value>([["exit", 1n], ["out", ""], ["err", message], ...daemon]);
  return Buffer.from(`${dumps(fallback, "spaced", true)}\n`, "utf8");
}
