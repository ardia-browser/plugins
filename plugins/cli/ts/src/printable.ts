import { fstatSync, write, writeSync } from "node:fs";
import { interrupted as interruptRequested } from "./control.ts";
import { codeOf, errnoOf, strerror } from "./paths.ts";
import { utf8 } from "./pystr.ts";
import { constants } from "node:os";

function escaped(text: string, controls: RegExp): string {
  return text.replace(controls, (found) => `\\u${found.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const FIELD_CONTROLS = /[\x00-\x1f\x7f-\x9f]/g;
const TEXT_CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const JSON_CONTROLS = /[\x7f-\x9f]/g;

export function shown(text: string): string {
  return escaped(text, FIELD_CONTROLS);
}

export function inert(text: string): string {
  return escaped(text, TEXT_CONTROLS);
}

export function jsonSafe(text: string): string {
  return escaped(text, JSON_CONTROLS);
}

export function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeAll(fd: number, text: string | Uint8Array): void {
  const bytes = typeof text === "string" ? utf8(text) : text;
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") sleepMs(1);
      else if (code !== "EINTR") throw error;
    }
  }
}

const INTERRUPT_POLL_MS = 50;
let abandoned = false;

export function abandonedOutput(): boolean {
  return abandoned;
}

type Outcome = { written: number } | { error: unknown };

function writeSome(fd: number, bytes: Buffer, offset: number): Promise<number> {
  return new Promise((resolve, reject) => {
    write(fd, bytes, offset, bytes.length - offset, null, (error, written) => (error ? reject(error) : resolve(written)));
  });
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function raceWithTick<T>(settled: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([settled, tick]);
  } finally {
    clearTimeout(timer);
  }
}

const PYTHON_DEFAULT_BUFFER = 8192;

function lineAt(ends: number[], offset: number): number {
  let start = 0;
  for (const end of ends) {
    if (offset < end) return end - start;
    start = end;
  }
  return 0;
}

function pythonStdoutBuffer(): number {
  try {
    const size = fstatSync(1).blksize;
    return size > 1 ? size : PYTHON_DEFAULT_BUFFER;
  } catch {
    return PYTHON_DEFAULT_BUFFER;
  }
}

export class Output {
  closed = false;
  interrupted = false;
  failed: { errno: number; line: number } | undefined;
  private pending: string[] = [];
  constructor(readonly json: boolean) {}

  say(text: string): void {
    if (!this.closed) this.pending.push(`${this.json ? jsonSafe(text) : inert(text)}\n`);
  }

  pythonCrash(): number | undefined {
    if (this.failed === undefined) return undefined;
    const { errno, line } = this.failed;
    const exception = `${pythonOsError(errno)}: [Errno ${errno}] ${strerror(errno)}\n`;
    const crashed = line > pythonStdoutBuffer();
    try {
      writeAll(2, crashed ? exception : `${exception}Exception ignored on flushing sys.stdout:\n${exception}`);
    } catch {}
    return crashed ? 1 : 120;
  }

  async flush(stopped: () => boolean = interruptRequested): Promise<void> {
    const lines = this.pending.map((line) => utf8(line));
    const ends: number[] = [];
    let total = 0;
    for (const line of lines) ends.push((total += line.length));
    const bytes = Buffer.concat(lines);
    this.pending = [];
    let offset = 0;
    while (offset < bytes.length && !this.closed && this.failed === undefined) {
      if (stopped()) {
        this.interrupted = true;
        return;
      }
      const settled = writeSome(1, bytes, offset).then(
        (written): Outcome => ({ written }),
        (error: unknown): Outcome => ({ error }),
      );
      let outcome: Outcome | undefined;
      while ((outcome = await raceWithTick(settled, INTERRUPT_POLL_MS)) === undefined) {
        if (stopped()) {
          this.interrupted = true;
          abandoned = true;
          return;
        }
      }
      if ("written" in outcome) offset += outcome.written;
      else {
        const code = codeOf(outcome.error);
        if (code === "EAGAIN") await pause(1);
        else if (code === "EPIPE" || code === "ESHUTDOWN") this.closed = true;
        else if (code !== "EINTR") {
          this.failed = { errno: errnoOf(outcome.error), line: lineAt(ends, offset) };
          return;
        }
      }
    }
  }

  complain(text: string): void {
    try {
      writeAll(2, `${inert(text)}\n`);
    } catch {}
  }
}

const PYTHON_OS_ERRORS: Record<string, string> = {
  EPIPE: "BrokenPipeError",
  ESHUTDOWN: "BrokenPipeError",
  EAGAIN: "BlockingIOError",
  EALREADY: "BlockingIOError",
  EINPROGRESS: "BlockingIOError",
  ECHILD: "ChildProcessError",
  ECONNRESET: "ConnectionResetError",
  ECONNABORTED: "ConnectionAbortedError",
  ECONNREFUSED: "ConnectionRefusedError",
  EEXIST: "FileExistsError",
  ENOENT: "FileNotFoundError",
  EINTR: "InterruptedError",
  EISDIR: "IsADirectoryError",
  ENOTDIR: "NotADirectoryError",
  EACCES: "PermissionError",
  EPERM: "PermissionError",
  ESRCH: "ProcessLookupError",
  ETIMEDOUT: "TimeoutError",
};

const ERRNO_NAMES = new Map<number, string>(Object.entries(constants.errno).map(([name, value]) => [value, name]));

export function pythonOsError(errno: number): string {
  return PYTHON_OS_ERRORS[ERRNO_NAMES.get(errno) ?? ""] ?? "OSError";
}

export function stdoutFlushFailed(error: unknown): number {
  const code = codeOf(error) ?? "";
  if (code === "EBADF") return 0;
  const errno = errnoOf(error);
  try {
    writeAll(2, `Exception ignored on flushing sys.stdout:\n${pythonOsError(errno)}: [Errno ${errno}] ${strerror(errno)}\n`);
  } catch {}
  return 120;
}
