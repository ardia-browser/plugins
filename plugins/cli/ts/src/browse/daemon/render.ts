import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { dumps, Float, parseText, type Value } from "../../json.ts";
import { openAt } from "../../libc.ts";
import { uid } from "../../paths.ts";
import { isHigh, isLow, SPLIT } from "../../pystr.ts";
import { formatG, groupThousands } from "../../pylib/format.ts";
import { inert, jsonSafe } from "../../printable.ts";
import { redact } from "../../redact.ts";
import { BrowseError, ConnectionLost } from "../daemon-errors.ts";
import { FAILED_WITHOUT_CODE, flag, rendered } from "../metrics.ts";
import { closeFd, entryInfo, listNames, unlinkQuietly, wellFormed, writeAllFd } from "../paths.ts";
import { MUTATING } from "./names.ts";
import { cleanValue, neutralize, safeCutIndex, stripLoneSurrogates, wrapUntrusted } from "../untrusted.ts";
import { safeCode } from "../codes.ts";

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
  read: "read -s <css> (one region per page), read --scroll -s <list> --match <text> (just the rows with that text), or fewer pages",
  eval: "return less from the script, or get text <css> / read -s <css> for one region",
  script: "return fewer fields or rows from the script",
  flow: "flow run <name> --fields a,b --limit n --where field=value",
};

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_WRONLY, O_CREAT, O_EXCL } = fs.constants;
const NAME_LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789_";
const TEMP_ATTEMPTS = 100;

export type Options = Record<string, unknown>;
export type Answer = [number, string, string, Uint8Array?];

export class Result {
  failed = false;
  body: Uint8Array | null = null;
  notice: string | null = null;
  batch: unknown = undefined;
  outputCap: number | null = null;
  whole = false;
  lost: BrowseError | null = null;

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
  if (typeof value === "string") return redact(stripLoneSurrogates(value));
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [redact(stripLoneSurrogates(key)), sanitize(item)]));
  if (Array.isArray(value)) return value.map(sanitize);
  return value;
}

export function compactJson(value: unknown, untrusted = false): string {
  const clean = sanitize(pyValue(value));
  return jsonSafe(dumps(untrusted ? cleanValue(clean, neutralize) : clean, "compact"));
}

export function render(options: Options, result: Result | null = null, error: BrowseError | null = null, name = ""): Answer {
  const [code, out, err] = renderPlain(options, result, error, name);
  rendered(name, result as never, error === null ? null : { code: safeCode(error.code), exit: error.exitCode }, out + err);
  const shownOut = redact(stripLoneSurrogates(out));
  const shownErr = redact(stripLoneSurrogates(err));
  return result?.body ? [code, shownOut, shownErr, result.body] : [code, shownOut, shownErr];
}

export function renderPlain(options: Options, result: Result | null, error: BrowseError | null, name = ""): Answer {
  const asJson = options["json"];
  if (error !== null) {
    let message = neutralize(stripLoneSurrogates(error.text));
    if (error instanceof ConnectionLost && MUTATING.has(name)) message += `; the outcome of \`${name}\` is unknown, so it wasn't retried`;
    if (asJson) {
      const payload: Record<string, unknown> = { success: false, data: error.data ?? null, error: message };
      const code = safeCode(error.code);
      if (code) payload["code"] = code;
      return [error.exitCode, `${compactJson(payload, true)}\n`, ""];
    }
    return [error.exitCode, "", `✗ ${inert(message)}\n`];
  }
  const done = result as Result;
  const code = done.lost !== null ? done.lost.exitCode : done.failed ? 1 : 0;
  if (asJson) {
    if (done.batch !== undefined && done.batch !== null) return [code, `${compactJson(done.batch, done.pageContent)}\n`, ""];
    return [code, `${compactJson({ success: true, data: done.data, error: null }, done.pageContent)}\n`, ""];
  }
  if (done.text === null) return [code, "", ""];
  const scrubbed = redact(stripLoneSurrogates(done.text));
  const plainText = done.pageContent ? neutralize(scrubbed) : scrubbed;
  if (plainText !== scrubbed) flag("boundary_marker_removed", true);
  let text = done.whole ? plainText : cap(plainText, options, name, done.outputCap);
  const capped = text !== plainText ? capNotice(text) : "";
  if (capped) text = text.slice(0, text.length - capped.length).replace(/\n$/u, "");
  const notice = [done.notice, capped].filter((part) => part).join("\n");
  if (done.pageContent && options["content_boundaries"] && !options["out_only"]) text = boundary(text);
  return [code, `${inert(text)}\n`, notice ? `${inert(notice)}\n` : ""];
}

export function boundary(text: string): string {
  return wrapUntrusted(text);
}

function limitOf(options: Options, name: string, fallback: number | null): number {
  const given = options["max_output"];
  if (given === null || given === undefined) return fallback || (name === "script" ? SCRIPT_OUTPUT_CAP : OUTPUT_CAP);
  return Math.trunc(Number(given));
}

function nextPoint(text: string, at: number): number {
  const unit = text.charCodeAt(at);
  if (isHigh(unit)) {
    const next = text.charCodeAt(at + 1);
    if (next === SPLIT || isLow(next)) return at + 2;
  }
  return at + 1;
}

function pointCount(text: string): number {
  let count = 0;
  for (let at = 0; at < text.length; at = nextPoint(text, at)) count += 1;
  return count;
}

function unitOfPoint(text: string, point: number): number {
  let at = 0;
  for (let index = 0; index < point && at < text.length; index += 1) at = nextPoint(text, at);
  return at;
}

export function cap(text: string, options: Options, name = "", fallback: number | null = null): string {
  if (options["full"]) return text;
  const limit = limitOf(options, name, fallback);
  if (limit <= 0 || text.length <= limit) return text;
  const total = pointCount(text);
  if (total <= limit) return text;
  const pointAt = unitOfPoint(text, limit);
  const limitAt = safeCutIndex(text, pointAt);
  const newlineAt = text.lastIndexOf("\n", limitAt);
  let cut = limitAt === pointAt ? limit : pointCount(text.slice(0, limitAt));
  let cutAt = limitAt;
  if (newlineAt >= 0) {
    let between = 0;
    for (let at = newlineAt; at < limitAt; at = nextPoint(text, at)) between += 1;
    const found = cut - between;
    if (found >= limit * 0.8) {
      cut = found;
      cutAt = newlineAt;
    }
  }
  const narrower = (name === "snapshot" ? regionNarrower(text) : null) ?? (Object.hasOwn(NARROWER, name) ? NARROWER[name] : NARROW_ANY);
  const saved = spill(text);
  const where = saved ? ` (full output: ${saved})` : "";
  return (
    text.slice(0, cutAt) +
    `\n${CAP_NOTICE}${groupThousands(String(cut))} of ${groupThousands(String(total))} characters. Narrow it: ${narrower}; ` +
    `or --max-output ${total} for every line${where}]`
  );
}

const REGION_ROLES = new Set([
  "main", "navigation", "complementary", "form", "region", "search", "dialog", "table", "grid", "list", "listbox", "tree", "menu",
  "tablist", "article", "feed",
]);
export const REGION_MOST = 0.7;
const SNAPSHOT_LINE = /^( *)- ([A-Za-z]+)/u;

export function regionNarrower(text: string): string | null {
  const lines = text.split("\n");
  const seen = new Map<string, number>();
  const sizes: [string, number][] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const found = SNAPSHOT_LINE.exec(lines[index] as string);
    if (found === null || !REGION_ROLES.has(found[2] as string)) continue;
    const role = found[2] as string;
    const depth = (found[1] as string).length;
    let end = index + 1;
    while (end < lines.length) {
      const below = /^( *)- /u.exec(lines[end] as string);
      if (below !== null && (below[1] as string).length <= depth) break;
      end += 1;
    }
    seen.set(role, (seen.get(role) ?? 0) + 1);
    sizes.push([role, end - index]);
  }
  const unique = sizes.filter(([role, count]) => seen.get(role) === 1 && count <= REGION_MOST * lines.length).sort((a, b) => b[1] - a[1]);
  const biggest = unique[0];
  if (biggest === undefined || biggest[1] < 2) return null;
  const [role, count] = biggest;
  return (
    `snapshot -i -s "[role=${role}]" (the ${role}, ${groupThousands(String(count))} of ${groupThousands(String(lines.length))} lines), ` +
    "find role <role> <action> --name <text> (act without a snapshot)"
  );
}

export function capNotice(text: string): string {
  const cut = text.lastIndexOf("\n");
  const last = cut < 0 ? text : text.slice(cut + 1);
  const cutShort = last.startsWith("[") && last.includes("Narrow it: ") && last.includes("--max-output ");
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

export function encodeAnswer(
  code: number,
  out: string,
  err: string,
  fields: [string, Value][] = [],
  limit = MAX_RESPONSE,
  name = "",
  asJson = false,
): Buffer {
  const answer = new Map<string, Value>([["exit", BigInt(code)], ["out", out], ["err", err], ...fields]);
  const data = Buffer.from(`${wellFormed(dumps(answer, "spaced"))}\n`, "utf8");
  if (data.length <= limit) return data;
  const error =
    name === "cdp"
      ? new BrowseError(
          `The result of \`cdp\` is ${groupThousands(String(data.length))} bytes once encoded for the answer, over the ${groupThousands(String(limit))} bytes the ` +
            "daemon sends back, so it wasn't printed; it did run, so check before running it again. Ask for less: " +
            "narrower params (DOM.getDocument --param depth:=1, a smaller Network.getResponseBody), or IO.read in chunks",
          null,
          "result_too_large",
        )
      : new BrowseError(`The answer was too large (${data.length} bytes, the limit is ${limit}); narrow it (snapshot -s, -d, --max-output)`);
  const [exit, shownOut, shownErr] = renderPlain({ json: asJson }, null, error);
  const given = fields.find(([key]) => key === "code")?.[1];
  const kept = fields.filter(([key]) => key === "daemon" || key === "failed_step_command" || key === "metrics");
  const shownCode = error.code ?? (typeof given === "string" && given ? given : FAILED_WITHOUT_CODE);
  const fallback = (extra: [string, Value][]) =>
    Buffer.from(`${dumps(new Map<string, Value>([["exit", BigInt(exit)], ["out", shownOut], ["err", shownErr], ["code", shownCode], ...extra]), "spaced", true)}\n`, "utf8");
  const whole = fallback(kept);
  if (whole.length <= limit) return whole;
  const metrics = kept.find(([key]) => key === "metrics")?.[1];
  const index = metrics instanceof Map ? metrics.get("failed_step_index") : undefined;
  const lean = kept.filter(([key]) => key !== "metrics");
  const indexed = index === undefined ? null : fallback([...lean, ["metrics", new Map<string, Value>([["failed_step_index", index]])]]);
  return indexed !== null && indexed.length <= limit ? indexed : fallback(lean);
}
