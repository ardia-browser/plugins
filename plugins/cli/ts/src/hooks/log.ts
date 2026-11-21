import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { inert, toStderr } from "../printable.ts";
import { rstrip } from "../py.ts";
import { strerrorOr } from "../pyerr.ts";

export const LOG_LIMIT = 5 * 1024 * 1024;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function stamp(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function replaceLoneSurrogates(text: string, by: (unit: number) => string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, (found) => by(found.charCodeAt(0)));
}

export function fileBytes(text: string): Buffer {
  return Buffer.from(replaceLoneSurrogates(text, () => "?"), "utf8");
}

export function stderrText(text: string): string {
  return replaceLoneSurrogates(text, (unit) => `\\u${unit.toString(16)}`);
}

export interface LogSink {
  write(text: string): void;
  close(): void;
}

export class Log implements LogSink {
  private fd: number | undefined;

  constructor(
    readonly path: string | null = null,
    readonly limit: number = LOG_LIMIT,
    private readonly stream: ((text: string) => void) | null = null,
  ) {}

  private open(): void {
    const path = this.path as string;
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    fchmodSync(this.fd, 0o600);
  }

  write(text: string): void {
    const line = `${stamp()} ${rstrip(text)}\n`;
    if (this.path === null) {
      if (this.stream !== null) this.stream(line);
      else toStderr(inert(stderrText(line)));
      return;
    }
    const data = fileBytes(line);
    try {
      if (this.fd === undefined) this.open();
      const size = fstatSync(this.fd as number).size;
      if (size && size + data.length > this.limit) {
        closeSync(this.fd as number);
        this.fd = undefined;
        renameSync(this.path, `${this.path}.1`);
        this.open();
      }
      let at = 0;
      while (at < data.length) at += writeSync(this.fd as number, data, at);
    } catch (error) {
      toStderr(inert(stderrText(`ardia hooks: can't write ${this.path}: ${strerrorOr(error)}\n${line}`)));
    }
  }

  close(): void {
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
  }
}
