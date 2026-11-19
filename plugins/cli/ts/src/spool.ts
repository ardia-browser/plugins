import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { now, utcDay } from "./clock.ts";
import { dumps, Float, type JsonObject, object, parse, TELEMETRY_JSON_DEPTH, type Value } from "./json.ts";
import { join } from "./paths.ts";
import {
  appendWhole,
  close,
  closeDir,
  type Dir,
  listDir,
  O_APPEND,
  O_CREAT,
  O_RDONLY,
  O_RDWR,
  O_WRONLY,
  openChildDir,
  openPrivate,
  openPrivateFile,
  notFound,
  readFd,
  readPrivate,
  sizeAt,
  takeLock,
  takeLockRetrying,
  unlinkQuietly,
  writeOnce,
  writePrivate,
} from "./privatefs.ts";
import type { Target } from "./telemetry.ts";
import { isDecimal, utf8 } from "./pystr.ts";

const FOLDER = "Telemetry";
const SPOOL = "cli-queue.jsonl";
const SPOOL_LOCK = "cli-queue.lock";
const FLUSH_CLAIM_LOCK = "cli-flush-claim.lock";
const FLUSH_STATE = "cli-flush.json";
const LOCAL_FOLDER = "local";
const LOCAL_PREFIX = "cli-";
const LOCAL_LOCK = "cli-local.lock";
const LOCAL_DAYS = 7;
const MAX_LOCAL_BYTES = 4 * 1024 * 1024;
const MAX_SPOOL_BYTES = 256 * 1024;
const COUNT_CHECK_BYTES = 64 * 1024;
const MAX_EVENTS = 500;
const MAX_LINE_BYTES = 32 * 1024;
const FLUSH_INTERVAL_S = 60;
const NEWLINE = 0x0a;

function openFolder(root: string, create: boolean): Dir {
  return openPrivate(root, [FOLDER], create);
}

function lineOf(record: Value): Buffer {
  return utf8(`${dumps(record, "compact")}\n`);
}

export function keepLocalCopy(root: string, records: JsonObject[], sent: boolean): boolean {
  const data = Buffer.concat(records.map((record) => lineOf(new Map([...record, ["sent", sent]]))));
  if (data.length === 0 || data.length > MAX_LOCAL_BYTES) return false;
  let local: Dir | undefined;
  let lock: number | undefined;
  try {
    const telemetry = openFolder(root, true);
    try {
      local = openChildDir(telemetry, LOCAL_FOLDER, true);
    } finally {
      closeDir(telemetry);
    }
    lock = takeLockRetrying(LOCAL_LOCK, local);
    if (lock === undefined) return false;
    const at = now();
    const fd = openPrivateFile(localName(at), local, O_WRONLY | O_CREAT | O_APPEND);
    try {
      writeOnce(fd, data);
    } finally {
      close(fd);
    }
    pruneLocal(local, at);
    return true;
  } catch {
    return false;
  } finally {
    close(lock);
    closeDir(local);
  }
}

function localName(at: number): string {
  return `${LOCAL_PREFIX}${utcDay(at)}.jsonl`;
}

export function isLocalFile(name: string): boolean {
  if (!name.startsWith(LOCAL_PREFIX) || !name.endsWith(".jsonl")) return false;
  const day = [...name.slice(LOCAL_PREFIX.length, -".jsonl".length)];
  return day.length === 10 && day.every((ch, index) => (index === 4 || index === 7 ? ch === "-" : isDecimal(ch)));
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

function textOf(raw: Buffer): string | undefined {
  try {
    return STRICT_UTF8.decode(raw);
  } catch {
    return undefined;
  }
}

function pruneLocal(dir: Dir, at: number): void {
  const oldestKept = utf8(localName(at - (LOCAL_DAYS - 1) * 86_400));
  const files: [string, number][] = [];
  const named: [Buffer, string][] = [];
  for (const raw of listDir(dir)) {
    const name = textOf(raw);
    if (name !== undefined && isLocalFile(name)) named.push([raw, name]);
  }
  for (const [raw, name] of named.sort(([a], [b]) => Buffer.compare(a, b))) {
    let size: number;
    try {
      size = sizeAt(dir, raw);
    } catch {
      continue;
    }
    if (Buffer.compare(raw, oldestKept) < 0) unlinkQuietly(raw, dir);
    else files.push([name, size]);
  }
  let excess = files.reduce((total, [, size]) => total + size, 0) - MAX_LOCAL_BYTES;
  for (const [name, size] of files) {
    if (excess <= 0) break;
    excess -= dropOldestLines(dir, name, size, excess);
  }
}

function dropOldestLines(dir: Dir, name: string, size: number, excess: number): number {
  const fd = openPrivateFile(name, dir, O_RDONLY);
  let raw: Buffer;
  try {
    raw = readFd(fd, size);
  } finally {
    close(fd);
  }
  const from = Math.min(Math.max(excess - 1, 0), raw.length);
  const cut = raw.indexOf(NEWLINE, from);
  const rest = cut < 0 ? Buffer.alloc(0) : raw.subarray(cut + 1);
  if (rest.length === 0) {
    unlinkQuietly(name, dir);
    return size;
  }
  writePrivate(name, dir, rest);
  return size - rest.length;
}

function isAsciiSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d;
}

function readLines(dir: Dir): Buffer[] {
  let fd: number;
  try {
    fd = openPrivateFile(SPOOL, dir, O_RDONLY);
  } catch (error) {
    if (notFound(error)) return [];
    throw error;
  }
  let raw: Buffer;
  try {
    raw = readFd(fd, MAX_SPOOL_BYTES * 2);
  } finally {
    close(fd);
  }
  const lines: Buffer[] = [];
  let start = 0;
  for (;;) {
    const end = raw.indexOf(NEWLINE, start);
    const line = raw.subarray(start, end < 0 ? raw.length : end);
    if (line.some((byte) => !isAsciiSpace(byte))) lines.push(Buffer.concat([line, Buffer.from([NEWLINE])]));
    if (end < 0) break;
    start = end + 1;
  }
  return lines;
}

function newest(lines: Buffer[]): Buffer[] {
  const kept: Buffer[] = [];
  let size = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? Buffer.alloc(0);
    if (kept.length >= MAX_EVENTS || size + line.length > MAX_SPOOL_BYTES) break;
    size += line.length;
    kept.push(line);
  }
  return kept.reverse();
}

function writeLines(dir: Dir, lines: Buffer[]): void {
  if (lines.length === 0) unlinkQuietly(SPOOL, dir);
  else writePrivate(SPOOL, dir, Buffer.concat(lines));
}

export function appendToSpool(root: string, records: JsonObject[]): Dir | undefined {
  const data = records.map(lineOf).filter((line) => line.length <= MAX_LINE_BYTES);
  const dataSize = data.reduce((total, line) => total + line.length, 0);
  let dir: Dir;
  try {
    dir = openFolder(root, true);
  } catch {
    return undefined;
  }
  let lock: number | undefined;
  try {
    lock = takeLockRetrying(SPOOL_LOCK, dir);
  } catch {
    lock = undefined;
  }
  if (lock === undefined) {
    closeDir(dir);
    return undefined;
  }
  let written = true;
  try {
    let size = 0;
    try {
      size = sizeAt(dir, SPOOL);
    } catch {
      size = 0;
    }
    if (size + dataSize <= COUNT_CHECK_BYTES) {
      const fd = openPrivateFile(SPOOL, dir, O_RDWR | O_CREAT | O_APPEND);
      try {
        appendWhole(fd, Buffer.concat(data));
      } finally {
        close(fd);
      }
    } else writeLines(dir, newest([...readLines(dir), ...data]));
  } catch {
    written = false;
  } finally {
    close(lock);
  }
  if (!written) {
    closeDir(dir);
    return undefined;
  }
  return dir;
}

export function discardSpool(root: string): void {
  try {
    lstatSync(join(root, FOLDER, SPOOL));
  } catch {
    return;
  }
  let dir: Dir;
  try {
    dir = openFolder(root, false);
  } catch {
    return;
  }
  try {
    const lock = takeLockRetrying(SPOOL_LOCK, dir);
    if (lock === undefined) return;
    try {
      unlinkQuietly(SPOOL, dir);
    } finally {
      close(lock);
    }
  } catch {
  } finally {
    closeDir(dir);
  }
}

type PyNumber = bigint | number;

function pyNumber(value: Value | undefined): PyNumber {
  if (typeof value === "bigint") return value;
  if (value instanceof Float) return value.value;
  return 0n;
}

function laterThan(value: PyNumber, at: number): boolean {
  return typeof value === "bigint" ? value > BigInt(Math.floor(at)) : value > at;
}

function pyInt(value: PyNumber): bigint | undefined {
  if (typeof value === "bigint") return value;
  return Number.isFinite(value) ? BigInt(Math.trunc(value)) : undefined;
}

export function startFlush(dir: Dir, target: Target, python: string | null): void {
  let claim: number | undefined;
  try {
    claim = takeLock(FLUSH_CLAIM_LOCK, dir);
  } catch {
    claim = undefined;
  }
  if (claim === undefined) {
    closeDir(dir);
    return;
  }
  try {
    let raw: Buffer | undefined;
    try {
      raw = readPrivate(FLUSH_STATE, dir, 64 * 1024);
    } catch {
      raw = undefined;
    }
    const parsed = raw === undefined ? undefined : parse(raw, TELEMETRY_JSON_DEPTH);
    const state: JsonObject = parsed instanceof Map ? parsed : new Map();
    const at = now();
    if (laterThan(pyNumber(state.get("next_at")), at)) return;
    const failures = pyInt(pyNumber(state.get("failures")));
    if (failures === undefined) return;
    const written = object([
      ["failures", failures],
      ["next_at", new Float(at + FLUSH_INTERVAL_S)],
    ]);
    try {
      writePrivate(FLUSH_STATE, dir, utf8(dumps(written, "spaced")));
    } catch {
      return;
    }
    close(claim);
    claim = undefined;
    if (python !== null) spawnFlusher(python, target);
  } finally {
    close(claim);
    closeDir(dir);
  }
}

function spawnFlusher(python: string, target: Target): void {
  const config = object([
    ["data_root", target.root],
    ["url", target.url],
    ["environment", target.environment],
  ]);
  try {
    const child = spawn(python, ["-I", "-c", "from ardia_cli import telemetry; telemetry.flush_main()"], {
      stdio: ["pipe", "ignore", "ignore"],
      cwd: "/",
      detached: true,
    });
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stdin?.end(utf8(dumps(config, "spaced", true)));
    child.unref();
  } catch {}
}
