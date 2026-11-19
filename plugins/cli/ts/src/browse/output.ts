import { fstatSync } from "node:fs";
import { writeWhole } from "../libc.ts";
import { osCrash } from "../crash.ts";
import { codeOf, errnoOf, strerror } from "../paths.ts";
import { inert, jsonSafe, pythonOsError } from "../printable.ts";
import { codePoints, isHigh, isLow, utf8 } from "../pystr.ts";
import { PythonCrash } from "./errors.ts";
import type { Errors } from "./stdio.ts";

const PYTHON_DEFAULT_BUFFER = 8192;
const CLOSED = new Set(["EPIPE", "ESHUTDOWN"]);
const SURROGATES = /[\ud800-\udfff]/;

function surrogate(point: string): boolean {
  if (point.length !== 1) return false;
  const unit = point.charCodeAt(0);
  return isHigh(unit) || isLow(unit);
}

function hex(point: string): string {
  return `\\u${point.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

export function encodeError(points: string[], escapable = false): PythonCrash | undefined {
  const refused = (point: string) => surrogate(point) && !(escapable && point.charCodeAt(0) >= 0xdc80 && point.charCodeAt(0) <= 0xdcff);
  const start = points.findIndex(refused);
  if (start < 0) return undefined;
  let end = start;
  while (end < points.length && refused(points[end] as string)) end += 1;
  const what = end - start === 1 ? `character '${hex(points[start] as string)}' in position ${start}` : `characters in position ${start}-${end - 1}`;
  return new PythonCrash({ kind: "UnicodeEncodeError", value: "UnicodeEncodeError" }, `UnicodeEncodeError: 'utf-8' codec can't encode ${what}: surrogates not allowed`);
}

function escaped(points: string[]): Buffer {
  const parts: Buffer[] = [];
  let run = "";
  for (const point of points) {
    if (!surrogate(point)) {
      run += point;
      continue;
    }
    parts.push(utf8(run), Buffer.from([point.charCodeAt(0) - 0xdc00]));
    run = "";
  }
  parts.push(utf8(run));
  return Buffer.concat(parts);
}

function backslashed(text: string): Buffer {
  return utf8(codePoints(text).map((point) => (surrogate(point) ? hex(point) : point)).join(""));
}

function stdoutBuffer(): number {
  try {
    const size = fstatSync(1).blksize;
    return size > 1 ? size : PYTHON_DEFAULT_BUFFER;
  } catch {
    return PYTHON_DEFAULT_BUFFER;
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  writeWhole(fd, bytes);
}

export class Printer {
  constructor(readonly errors: Errors = "strict") {}

  closed = false;
  crash: PythonCrash | undefined;
  exitOverride: number | undefined;

  get stopped(): boolean {
    return this.closed || this.crash !== undefined;
  }

  out(text: string): void {
    if (this.stopped || text === "") return;
    const cleaned = jsonSafe(text);
    if (!SURROGATES.test(cleaned)) {
      this.write(utf8(cleaned));
      return;
    }
    const points = codePoints(cleaned);
    const escapable = this.errors === "surrogateescape";
    const refused = encodeError(points, escapable);
    if (refused !== undefined) {
      this.crash = refused;
      return;
    }
    this.write(escapable ? escaped(points) : utf8(cleaned));
  }

  private write(bytes: Uint8Array): void {
    try {
      writeAll(1, bytes);
    } catch (error) {
      this.failed(error, bytes.length);
    }
  }

  err(text: string): void {
    if (this.stopped || text === "") return;
    try {
      writeAll(2, backslashed(inert(text)));
    } catch (error) {
      if (CLOSED.has(codeOf(error) ?? "")) this.closed = true;
    }
  }

  private failed(error: unknown, size: number): void {
    if (CLOSED.has(codeOf(error) ?? "")) {
      this.closed = true;
      return;
    }
    const errno = errnoOf(error);
    const line = `${pythonOsError(errno)}: [Errno ${errno}] ${strerror(errno)}`;
    this.crash = new PythonCrash(osCrash(errno), line);
    if (size <= stdoutBuffer()) this.exitOverride = 120;
  }

  sayCrash(crash: PythonCrash): number {
    try {
      writeAll(2, backslashed(`${crash.line}\n`));
      if (this.exitOverride !== undefined) writeAll(2, backslashed(`Exception ignored on flushing sys.stdout:\n${crash.line}\n`));
    } catch {}
    return this.exitOverride ?? 1;
  }
}
