import { fstatSync, write } from "node:fs";
import { interrupted as interruptRequested } from "./control.ts";
import { writeSome, writeWhole, writtenBefore } from "./libc.ts";
import { codeOf, errnoOf, strerror } from "./paths.ts";
import { utf8 } from "./pystr.ts";
import { constants } from "node:os";
import { isatty } from "node:tty";

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
  Bun.sleepSync(ms);
}

export function writeAll(fd: number, text: string | Uint8Array): void {
  writeWhole(fd, typeof text === "string" ? utf8(text) : text);
}

let stderrLeft: Buffer = Buffer.alloc(0);

export function toStderr(text: string | Uint8Array): number | undefined {
  stderrLeft = Buffer.concat([stderrLeft, typeof text === "string" ? utf8(text) : text]);
  try {
    writeWhole(2, stderrLeft);
    stderrLeft = Buffer.alloc(0);
    return undefined;
  } catch (error) {
    stderrLeft = stderrLeft.subarray(writtenBefore(error));
    return errnoOf(error) || constants.errno.EIO;
  }
}

export function settleStderr(status: number): number {
  return stderrLeft.length > 0 && toStderr("") !== undefined ? 120 : status;
}

export function exceptionLine(errno: number): string {
  return `${pythonOsError(errno)}: [Errno ${errno}] ${strerror(errno)}\n`;
}

const INTERRUPT_POLL_MS = 50;
let abandoned = false;

export function abandonedOutput(): boolean {
  return abandoned;
}

type Outcome = { written: number } | { error: unknown };

function writeSomeAsync(fd: number, bytes: Uint8Array, offset: number): Promise<number> {
  return new Promise((resolve, reject) => {
    write(fd, bytes, offset, bytes.length - offset, null, (error, written) => (error ? reject(error) : resolve(written)));
  });
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

export function pythonStdoutBuffer(): number {
  try {
    const size = fstatSync(1).blksize;
    return size > 1 ? size : PYTHON_DEFAULT_BUFFER;
  } catch {
    return PYTHON_DEFAULT_BUFFER;
  }
}

export type Stop = { kind: "closed" } | { kind: "failed"; errno: number; unwritten: Uint8Array };

export class PythonBufferedLine {
  private offset = 0;
  private direct: boolean;
  constructor(
    readonly bytes: Uint8Array,
    readonly buffer: number,
  ) {
    this.direct = bytes.length >= buffer;
  }

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  get at(): number {
    this.direct = this.direct && this.bytes.length - this.offset >= this.buffer;
    return this.offset;
  }

  wrote(count: number): void {
    this.offset += count;
  }

  failed(error: unknown): Stop | undefined {
    const code = codeOf(error);
    if (code === "EINTR") return undefined;
    if (code === "EPIPE" || code === "ESHUTDOWN") return { kind: "closed" };
    const errno = errnoOf(error) || constants.errno.EIO;
    const rest = this.bytes.subarray(this.offset);
    if (!this.direct) return { kind: "failed", errno, unwritten: rest };
    return { kind: "failed", errno, unwritten: errno === constants.errno.EAGAIN ? rest.subarray(0, this.buffer) : rest.subarray(0, 0) };
  }
}

export function writeAsPythonBuffers(bytes: Uint8Array, buffer = pythonStdoutBuffer()): Stop | undefined {
  const line = new PythonBufferedLine(bytes, buffer);
  while (!line.done) {
    try {
      line.wrote(writeSome(1, bytes, line.at));
    } catch (error) {
      const stop = line.failed(error);
      if (stop !== undefined) return stop;
    }
  }
  return undefined;
}

export class Output {
  closed = false;
  interrupted = false;
  failed: { errno: number; unwritten: Uint8Array } | undefined;
  private pending: string[] = [];
  constructor(readonly json: boolean) {}

  say(text: string): void {
    if (!this.closed) this.pending.push(`${this.json ? text : inert(text)}\n`);
  }

  reportCrash(): number {
    return this.failed === undefined ? 1 : reportCrash(this.failed.errno, this.failed.unwritten);
  }

  async flush(stopped: () => boolean = interruptRequested): Promise<void> {
    const lines = this.pending;
    this.pending = [];
    const buffer = pythonStdoutBuffer();
    for (const text of lines) {
      const bytes = utf8(text);
      const line = new PythonBufferedLine(bytes, buffer);
      while (!line.done) {
        if (stopped()) {
          this.interrupted = true;
          return;
        }
        const settled = writeSomeAsync(1, bytes, line.at).then(
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
        if ("written" in outcome) {
          line.wrote(outcome.written);
          continue;
        }
        const stop = line.failed(outcome.error);
        if (stop?.kind === "closed") {
          this.closed = true;
          return;
        }
        if (stop !== undefined) {
          this.failed = stop;
          return;
        }
      }
    }
  }

  complain(text: string): number | undefined {
    return toStderr(`${inert(text)}\n`);
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

export function reportCrash(errno: number, unwritten: Uint8Array): number {
  toStderr(exceptionLine(errno));
  try {
    writeWhole(1, unwritten);
  } catch (error) {
    toStderr(`Exception ignored on flushing sys.stdout:\n${exceptionLine(errnoOf(error) || constants.errno.EIO)}`);
    return 120;
  }
  return 1;
}

export function versionWriteFailed(error: unknown): number {
  if (codeOf(error) === "EBADF" || !isatty(1)) return stdoutFlushFailed(error);
  toStderr(exceptionLine(errnoOf(error)));
  return stdoutFlushFailed(error);
}

export function stdoutFlushFailed(error: unknown): number {
  const code = codeOf(error) ?? "";
  if (code === "EBADF") return 0;
  const errno = errnoOf(error);
  toStderr(`Exception ignored on flushing sys.stdout:\n${exceptionLine(errno)}`);
  return 120;
}
