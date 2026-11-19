import fs from "node:fs";
import { RedactingStream } from "../../redact.ts";
import { linkLog } from "../cdp/link.ts";

const LOGGER = "ardia_cli.browse";
const INTERRUPTED_TRIES = 3;

function sinkFor(fd: number) {
  return {
    write(text: string) {
      const data = Buffer.from(text.toWellFormed(), "utf8");
      let offset = 0;
      let interrupted = 0;
      while (offset < data.length) {
        try {
          const wrote = fs.writeSync(fd, data, offset, data.length - offset);
          if (wrote <= 0) return;
          offset += wrote;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EINTR" && interrupted < INTERRUPTED_TRIES) {
            interrupted += 1;
            continue;
          }
          return;
        }
      }
    },
    flush() {},
  };
}

const stream = new RedactingStream(sinkFor(2));
let verbose = false;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function asctime(at = new Date()): string {
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `,${pad(at.getMilliseconds(), 3)}`
  );
}

function described(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  return String(error);
}

function line(level: string, message: string, error?: unknown): void {
  stream.write(`${asctime()} ${LOGGER} ${level} ${message}\n${error === undefined ? "" : `${described(error)}\n`}`);
  stream.flush();
}

export const log = {
  configure(debug: boolean): void {
    verbose = debug;
    linkLog.problem = (what, error) => line("WARNING", what, error);
  },
  info(message: string): void {
    if (verbose) line("INFO", message);
  },
  warning(message: string): void {
    line("WARNING", message);
  },
  exception(message: string, error: unknown): void {
    line("ERROR", message, error);
  },
  raw(text: string): void {
    stream.write(text);
    stream.flush();
  },
};
