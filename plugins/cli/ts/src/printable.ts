import { writeSync } from "node:fs";

function escaped(text: string, escape: (code: number) => boolean): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += escape(code) ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
  }
  return out;
}

const c1 = (code: number) => code >= 0x7f && code <= 0x9f;

export function shown(text: string): string {
  return escaped(text, (code) => code <= 0x1f || c1(code));
}

export function inert(text: string): string {
  return escaped(text, (code) => code <= 0x08 || (code >= 0x0b && code <= 0x1f) || c1(code));
}

export function jsonSafe(text: string): string {
  return escaped(text, c1);
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

export class Output {
  closed = false;
  constructor(readonly json: boolean) {}

  say(text: string): void {
    if (this.closed) return;
    try {
      writeAll(1, `${this.json ? jsonSafe(text) : inert(text)}\n`);
    } catch {
      this.closed = true;
    }
  }

  complain(text: string): void {
    try {
      writeAll(2, `${inert(text)}\n`);
    } catch {}
  }
}
