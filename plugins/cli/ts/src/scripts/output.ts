import { inert, jsonSafe, toStderr, writeAll } from "../printable.ts";
import { errnoOf } from "../paths.ts";

const EPIPE = 32;
const ESHUTDOWN = process.platform === "linux" ? 108 : 58;

export class BrokenPipe extends Error {
  override readonly name = "BrokenPipeError";
}

export class Interrupted extends Error {
  override readonly name = "KeyboardInterrupt";
}

export function wellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�");
}

export class Say {
  constructor(readonly json: boolean) {}

  say(text: string): void {
    const line = `${wellFormed(text)}\n`;
    try {
      writeAll(1, this.json ? jsonSafe(line) : inert(line));
    } catch (error) {
      const errno = errnoOf(error);
      if (errno === EPIPE || errno === ESHUTDOWN) throw new BrokenPipe();
      throw error;
    }
  }

  complain(text: string): void {
    toStderr(inert(`${wellFormed(text)}\n`));
  }
}
