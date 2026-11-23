import { spawn } from "node:child_process";
import { constants } from "node:os";
import { writeWhole } from "../libc.ts";
import { errnoOf } from "../paths.ts";

const TAIL_BYTES = 64 * 1024;
const FORWARDED_SIGNALS = ["SIGTERM", "SIGHUP"] as const;

export type Supervised = { status: number; tail: string; spawnErrno?: number };

export const driverOutput = {
  write(fd: 1 | 2, bytes: Uint8Array): void {
    writeWhole(fd, bytes);
  },
};

function signalNumber(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  return (constants.signals as Record<string, number | undefined>)[signal] ?? 1;
}

class Tail {
  private chunks: Buffer[] = [];
  private size = 0;

  add(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > TAIL_BYTES && this.chunks.length > 1) this.size -= (this.chunks.shift() as Buffer).length;
  }

  text(): string {
    const joined = Buffer.concat(this.chunks);
    return joined.subarray(Math.max(0, joined.length - TAIL_BYTES)).toString("utf8");
  }
}

export function supervise(binary: string, argv: readonly string[], env: Record<string, string>): Promise<Supervised> {
  return new Promise((resolve) => {
    const tail = new Tail();
    let stdoutOpen = true;
    const child = spawn(binary, argv.slice(1), { argv0: argv[0], env, stdio: ["inherit", "pipe", "pipe"] });
    const forward = (signal: NodeJS.Signals) => {
      try {
        child.kill(signal);
      } catch {}
    };
    const handlers = FORWARDED_SIGNALS.map((signal) => [signal, () => forward(signal)] as const);
    const ignoreInterrupt = () => {};
    for (const [signal, handler] of handlers) process.on(signal, handler);
    process.on("SIGINT", ignoreInterrupt);
    const release = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      process.off("SIGINT", ignoreInterrupt);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      tail.add(chunk);
      if (!stdoutOpen) return;
      try {
        driverOutput.write(1, chunk);
      } catch {
        stdoutOpen = false;
        child.stdout?.destroy();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      tail.add(chunk);
      try {
        driverOutput.write(2, chunk);
      } catch {}
    });
    let settled = false;
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      release();
      resolve({ status: 1, tail: "", spawnErrno: errnoOf(error) || constants.errno.ENOENT });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      release();
      resolve({ status: code ?? 128 + signalNumber(signal), tail: tail.text() });
    });
  });
}
