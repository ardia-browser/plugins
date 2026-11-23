import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { type Case, EXPECTED_BLOBS } from "./cases.ts";
import { backslashReplace } from "./fakes.ts";
import type { Change, Observed } from "./observe.ts";
import { canonical, codePointOrder, dumps, isObject, loads, mapStrings, type Py, type PyObject } from "./pyjson.ts";

export const BOX_MARK = "<parity:box>";
export const CLI_MARK = "<parity:cli>";
export const SCRATCH_MARK = "<parity:scratch>";
export const TODAY_MARK = "<parity:today>";
export const INLINE_LIMIT = 16 * 1024;
export const FIELDS = ["status", "stdout", "stderr", "requests", "daemon_requests", "telemetry", "queued", "usage", "flush", "files", "helpers", "timed_out"] as const;
export type Field = (typeof FIELDS)[number];
const READ_ONLY_METHODS = new Set(["hello", "workspace", "windows", "commands"]);
const NATIVE_ATTEMPTS = 1;
const LOCAL_COPY = /^data\/Telemetry\/local\/cli-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DIFF_LINES = 80;

export type Body = { bytes: Buffer } | { sha256: string; size: number };
export type Expected = {
  status: number;
  stdout: Body;
  stderr: Body;
  requests: Py;
  daemon_requests: Py;
  telemetry: Py;
  queued: Py;
  usage: Py;
  flush: Py;
  files: Map<string, (string | number | Body)[]>;
  helpers: string[];
  timed_out: boolean;
};

export type Comparable = Omit<Expected, "files"> & { files: Map<string, (string | number | Body)[]> };

let expectedBlobs: PyObject | undefined;

function storedBody(digest: string): Buffer | undefined {
  if (expectedBlobs === undefined) {
    const loaded = existsSync(EXPECTED_BLOBS) ? loads(readFileSync(EXPECTED_BLOBS, "utf8")) : new Map();
    expectedBlobs = isObject(loaded) ? loaded : new Map();
  }
  const found = expectedBlobs.get(digest);
  return found === undefined ? undefined : blobBytes(found);
}

function blobBytes(value: Py): Buffer {
  if (isObject(value) && typeof value.get("text") === "string") return Buffer.from(value.get("text") as string, "utf8");
  if (isObject(value) && typeof value.get("base64") === "string") return Buffer.from(value.get("base64") as string, "base64");
  throw new Error(`not an expected body: ${dumps(value)}`);
}

function body(value: Py | undefined): Body {
  if (isObject(value) && typeof value.get("sha256") === "string") return { sha256: value.get("sha256") as string, size: Number(value.get("size")) };
  return { bytes: blobBytes(value ?? null) };
}

function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function expectedFor(kase: Case, platform: string = process.platform): PyObject | undefined {
  return platform === "linux" && kase.expectedLinux !== undefined ? kase.expectedLinux : kase.expected;
}

export function decodeExpected(row: PyObject): Expected {
  const files = new Map<string, (string | number | Body)[]>();
  const listed = row.get("files");
  if (isObject(listed)) {
    for (const [rel, change] of listed) {
      if (!Array.isArray(change)) throw new Error(`expected file ${rel} is a list`);
      files.set(rel, change.map((part, index) => (index === 3 && change[0] === "written" && change[1] === "file" ? body(part) : typeof part === "bigint" ? Number(part) : String(part))));
    }
  }
  const helpers = row.get("helpers");
  return {
    status: Number(row.get("status")),
    stdout: body(row.get("stdout")),
    stderr: body(row.get("stderr")),
    requests: row.get("requests") ?? [],
    daemon_requests: row.get("daemon_requests") ?? [],
    telemetry: row.get("telemetry") ?? [],
    queued: row.get("queued") ?? [],
    usage: row.has("usage") ? row.get("usage")! : null,
    flush: row.has("flush") ? row.get("flush")! : null,
    files,
    helpers: Array.isArray(helpers) ? helpers.map(String) : [],
    timed_out: row.get("timed_out") === true,
  };
}

export class Marks {
  private pairs: [string, string][];
  constructor(box: string, scratch: string) {
    this.pairs = [[box, BOX_MARK], [`${scratch}/src`, CLI_MARK], [scratch, SCRATCH_MARK]];
  }
  text(value: string): string {
    for (const [path, mark] of this.pairs) value = value.split(path).join(mark);
    return value;
  }
  bytes(value: Buffer): Buffer {
    const latin = value.toString("latin1");
    let changed = latin;
    for (const [path, mark] of this.pairs) changed = changed.split(path).join(mark);
    return changed === latin ? value : Buffer.from(changed, "latin1");
  }
  json(value: Py): Py {
    return mapStrings(value, (text) => this.text(text));
  }
  helper(line: string): string {
    const [name, ...args] = line.split(" =");
    return [this.text(name ?? ""), ...args.map((arg) => this.bytes(Buffer.from(arg, "base64")).toString("base64"))].join(" =");
  }
}

function runDates(window: [number, number]): Set<string> {
  return new Set(window.map((moment) => new Date(moment * 1000).toISOString().slice(0, 10)));
}

export function datedFiles<T>(files: Map<string, T>, window: [number, number]): Map<string, T> {
  const dates = runDates(window);
  const inside = [...files.keys()].filter((rel) => {
    const match = LOCAL_COPY.exec(rel);
    return match !== null && dates.has(match[1]!);
  });
  if (inside.length !== 1) return files;
  return new Map([...files].map(([rel, change]) => [rel === inside[0] ? `data/Telemetry/local/cli-${TODAY_MARK}.jsonl` : rel, change]));
}

function asBody(bytes: Buffer): Body {
  return { bytes };
}

export function comparable(observed: Observed, marks: Marks): Comparable {
  const files = new Map<string, (string | number | Body)[]>();
  for (const [rel, change] of datedFiles(observed.files, observed.window)) {
    const parts: (string | number | Body)[] = (change as Change).map((part) => (Buffer.isBuffer(part) ? asBody(marks.bytes(part)) : part));
    if (change[0] === "written" && change[1] === "link") parts[2] = marks.text(change[2]);
    files.set(marks.text(rel), parts);
  }
  return {
    status: observed.status,
    stdout: asBody(marks.bytes(observed.stdout)),
    stderr: asBody(marks.bytes(observed.stderr)),
    requests: marks.json(observed.requests),
    daemon_requests: marks.json(observed.daemon_requests),
    telemetry: marks.json(observed.telemetry),
    queued: marks.json(observed.queued),
    usage: marks.json(observed.usage),
    flush: marks.json(observed.flush),
    files,
    helpers: observed.helpers.map((line) => marks.helper(line)),
    timed_out: observed.timed_out,
  };
}

function bodyKey(value: Body): string {
  if ("sha256" in value) return `sha256:${value.sha256}:${value.size}`;
  return value.bytes.length > INLINE_LIMIT ? `sha256:${digestOf(value.bytes)}:${value.bytes.length}` : `bytes:${value.bytes.toString("latin1")}`;
}

function filesKey(files: Map<string, (string | number | Body)[]>): string {
  const rows = [...files].sort(([left], [right]) => codePointOrder(left, right));
  return JSON.stringify(rows.map(([rel, parts]) => [rel, parts.map((part) => (typeof part === "object" ? bodyKey(part) : part))]));
}

export function exactKey(field: Field, value: Comparable[Field]): string {
  if (field === "stdout" || field === "stderr") return bodyKey(value as Body);
  if (field === "files") return filesKey(value as Comparable["files"]);
  if (field === "status") return String(value);
  if (field === "timed_out") return String(value);
  if (field === "helpers") return JSON.stringify(value);
  return canonical(value as Py);
}

function readOnly(connection: Py): boolean {
  return Array.isArray(connection) && connection.length > 0 && connection.every((request) => isObject(request) && READ_ONLY_METHODS.has(String(request.get("method"))));
}

export function fallbackRequests(fresh: Py, expected: Py): Py {
  if (Array.isArray(fresh) && Array.isArray(expected) && fresh.length === expected.length + NATIVE_ATTEMPTS &&
      canonical(fresh.slice(NATIVE_ATTEMPTS)) === canonical(expected) && readOnly(fresh[0]!)) {
    return expected;
  }
  return fresh;
}

function bodyText(value: Body): string {
  if ("sha256" in value) {
    const stored = storedBody(value.sha256);
    return stored === undefined ? `<${value.size} bytes sha256 ${value.sha256}>` : backslashReplace(stored);
  }
  return value.bytes.length < 64 * 1024 ? backslashReplace(value.bytes) : `<${value.bytes.length} bytes sha256 ${digestOf(value.bytes)}>`;
}

function textOf(field: Field, value: Comparable[Field]): string {
  if (field === "stdout" || field === "stderr") return bodyText(value as Body);
  if (field === "files") {
    return [...(value as Comparable["files"])].map(([rel, parts]) =>
      parts[0] === "written" && parts[1] === "file" ? `${rel}: file mode 0o${Number(parts[2]).toString(8)}\n${bodyText(parts[3] as Body)}` : `${rel}: ${JSON.stringify(parts)}`).join("\n");
  }
  if (field === "status" || field === "timed_out") return String(value);
  if (field === "helpers") return (value as string[]).join("\n");
  return pretty(value as Py, "");
}

function pretty(value: Py, indent: string): string {
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((item) => `${indent} ${pretty(item, `${indent} `)}`).join(",\n")}\n${indent}]`;
  }
  if (isObject(value)) {
    if (!value.size) return "{}";
    const keys = [...value.keys()].sort(codePointOrder);
    return `{\n${keys.map((key) => `${indent} ${dumps(key, { ensureAscii: false })}: ${pretty(value.get(key)!, `${indent} `)}`).join(",\n")}\n${indent}}`;
  }
  return dumps(value, { ensureAscii: false });
}

export function lineDiff(expected: string, actual: string): string {
  const left = expected.split("\n");
  const right = actual.split("\n");
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let endLeft = left.length;
  let endRight = right.length;
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) {
    endLeft -= 1;
    endRight -= 1;
  }
  const context = 3;
  const lines = [`@@ expected line ${start + 1}, actual line ${start + 1} @@`];
  for (const line of left.slice(Math.max(0, start - context), start)) lines.push(`  ${line}`);
  for (const line of left.slice(start, endLeft).slice(0, DIFF_LINES)) lines.push(`- ${line}`);
  if (endLeft - start > DIFF_LINES) lines.push(`- … ${endLeft - start - DIFF_LINES} more lines`);
  for (const line of right.slice(start, endRight).slice(0, DIFF_LINES)) lines.push(`+ ${line}`);
  if (endRight - start > DIFF_LINES) lines.push(`+ … ${endRight - start - DIFF_LINES} more lines`);
  for (const line of left.slice(endLeft, endLeft + context)) lines.push(`  ${line}`);
  return lines.join("\n");
}

export function compare(fresh: Comparable, expected: Expected, fallback: boolean): [Field, string][] {
  const mismatches: [Field, string][] = [];
  for (const field of FIELDS) {
    const left = expected[field];
    let right = fresh[field];
    if (field === "requests" && fallback) right = fallbackRequests(right as Py, left as Py);
    if (exactKey(field, left) === exactKey(field, right)) continue;
    const diff = lineDiff(textOf(field, left), textOf(field, right));
    mismatches.push([field, diff]);
  }
  return mismatches;
}
