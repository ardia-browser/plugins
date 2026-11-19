import { write, writeSync } from "node:fs";
import { interrupted as interruptRequested } from "./control.ts";
import { codeOf, errnoOf, strerror } from "./paths.ts";

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
  const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text;
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

export class Output {
  closed = false;
  interrupted = false;
  private pending: string[] = [];
  constructor(readonly json: boolean) {}

  say(text: string): void {
    if (!this.closed) this.pending.push(`${this.json ? jsonSafe(text) : inert(text)}\n`);
  }

  async flush(stopped: () => boolean = interruptRequested): Promise<void> {
    const bytes = Buffer.from(this.pending.join(""), "utf8");
    this.pending = [];
    let offset = 0;
    while (offset < bytes.length && !this.closed) {
      if (stopped()) {
        this.interrupted = true;
        return;
      }
      const settled = writeSome(1, bytes, offset).then(
        (written): Outcome => ({ written }),
        (error: unknown): Outcome => ({ error }),
      );
      let outcome: Outcome | undefined;
      while ((outcome = await Promise.race([settled, pause(INTERRUPT_POLL_MS).then(() => undefined)])) === undefined) {
        if (stopped()) {
          this.interrupted = true;
          abandoned = true;
          return;
        }
      }
      if ("written" in outcome) offset += outcome.written;
      else {
        const code = (outcome.error as NodeJS.ErrnoException).code;
        if (code === "EAGAIN") await pause(1);
        else if (code !== "EINTR") this.closed = true;
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
  ECONNRESET: "ConnectionResetError",
  ECONNABORTED: "ConnectionAbortedError",
  ECONNREFUSED: "ConnectionRefusedError",
  EACCES: "PermissionError",
  EPERM: "PermissionError",
  ETIMEDOUT: "TimeoutError",
  ENOENT: "FileNotFoundError",
  EISDIR: "IsADirectoryError",
  ENOTDIR: "NotADirectoryError",
};

export function stdoutFlushFailed(error: unknown): number {
  const code = codeOf(error) ?? "";
  if (code === "EBADF") return 0;
  const errno = errnoOf(error);
  try {
    writeAll(2, `Exception ignored on flushing sys.stdout:\n${PYTHON_OS_ERRORS[code] ?? "OSError"}: [Errno ${errno}] ${strerror(errno)}\n`);
  } catch {}
  return 120;
}
