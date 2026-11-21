import { constants } from "node:os";
import { writeWhole } from "./libc.ts";
import { errnoOf } from "./paths.ts";
import { exceptionLine, inert, jsonSafe, toStderr } from "./printable.ts";
import { utf8 } from "./pystr.ts";

export type Exec = { binary: string; argv: string[] };
export type Flushed = { kind: "ok" } | { kind: "closed" } | { kind: "failed"; errno: number };

const BROKEN_PIPE = new Set([constants.errno.EPIPE, (constants.errno as Record<string, number>).ESHUTDOWN].filter((code) => code !== undefined));

export function jsonRequested(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  return (end < 0 ? argv : argv.slice(0, end)).includes("--json");
}

export class CommandIo {
  private pending: string[] = [];
  exec: Exec | undefined;
  errorCode: string | undefined;

  constructor(readonly json = false) {}

  private clean(text: string): string {
    return this.json ? jsonSafe(text) : inert(text);
  }

  write(text: string): void {
    this.pending.push(this.clean(text));
  }

  out(line: string): void {
    this.write(`${line}\n`);
  }

  err(line: string): void {
    toStderr(`${inert(line)}\n`);
  }

  exitWith(parsed: { status: number; stdout: string; stderr: string }): number {
    if (parsed.stdout) this.write(parsed.stdout);
    if (parsed.stderr) toStderr(inert(parsed.stderr));
    return parsed.status;
  }

  flush(): Flushed {
    const text = this.pending.join("");
    this.pending = [];
    if (text === "") return { kind: "ok" };
    try {
      writeWhole(1, utf8(text));
      return { kind: "ok" };
    } catch (error) {
      const errno = errnoOf(error) || constants.errno.EIO;
      return BROKEN_PIPE.has(errno) ? { kind: "closed" } : { kind: "failed", errno };
    }
  }

  settle(status: number): number {
    const flushed = this.flush();
    if (flushed.kind === "closed") {
      this.errorCode = "stdout_closed";
      return 141;
    }
    if (flushed.kind === "failed") {
      toStderr(`Exception ignored on flushing sys.stdout:\n${exceptionLine(flushed.errno)}`);
      return 120;
    }
    return status;
  }
}
