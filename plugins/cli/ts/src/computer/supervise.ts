import { spawn } from "node:child_process";
import { write } from "node:fs";
import { constants } from "node:os";
import { abandonWork } from "../printable.ts";

const TAIL_BYTES = 64 * 1024;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const STOPPED_DRAIN_MS = 200;

export type Supervised = { status: number; signal?: NodeJS.Signals; stderr: string; stdoutClosed: boolean; spawnErrno?: number };

function writeAll(fd: 1 | 2, bytes: Uint8Array, done: (error?: unknown) => void, at = 0): void {
  if (at >= bytes.length) {
    done();
    return;
  }
  write(fd, bytes, at, bytes.length - at, null, (error, written) => {
    if (error) done(error);
    else writeAll(fd, bytes, done, at + written);
  });
}

export const driverOutput = {
  write(fd: 1 | 2, bytes: Uint8Array, done: (error?: unknown) => void): void {
    writeAll(fd, bytes, done);
  },
};

export function forward(fd: 1 | 2, text: string, signal?: AbortSignal): Promise<"written" | "failed" | "stopped"> {
  if (signal?.aborted) return Promise.resolve("stopped");
  if (text === "") return Promise.resolve("written");
  return new Promise((resolve) => {
    let done = false;
    const stop = () => {
      if (done) return;
      done = true;
      abandonWork();
      resolve("stopped");
    };
    signal?.addEventListener("abort", stop, { once: true });
    driverOutput.write(fd, Buffer.from(text, "utf8"), (error) => {
      signal?.removeEventListener("abort", stop);
      if (done) return;
      done = true;
      resolve(error === undefined ? "written" : "failed");
    });
  });
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

function signalNumber(signal: NodeJS.Signals): number {
  return (constants.signals as Record<string, number | undefined>)[signal] ?? 1;
}

export function supervise(binary: string, argv: readonly string[], env: Record<string, string>): Promise<Supervised> {
  return new Promise((resolve) => {
    const stderrTail = new Tail();
    let stdoutClosed = false;
    let stopped = false;
    let pending = 0;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let closed = false;
    let settled = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(binary, argv.slice(1), { argv0: argv[0], env, stdio: ["inherit", "pipe", "pipe"] });
    const relay = (signal: NodeJS.Signals) => {
      stopped = true;
      try {
        child.kill(signal);
      } catch {}
      if (exited !== undefined) scheduleDrain();
    };
    const handlers = FORWARDED_SIGNALS.map((signal) => [signal, () => relay(signal)] as const);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const finish = (result: Supervised) => {
      if (settled) return;
      settled = true;
      clearTimeout(drainTimer);
      for (const [signal, handler] of handlers) process.off(signal, handler);
      if (pending > 0) abandonWork();
      resolve(result);
    };
    const settleIfDone = () => {
      if (closed && (pending === 0 || stopped)) finish(outcome());
    };
    const outcome = (): Supervised => {
      const signal = exited?.signal ?? undefined;
      const status = exited?.code ?? (signal === undefined ? 1 : 128 + signalNumber(signal));
      return { status, ...(signal === undefined ? {} : { signal }), stderr: stderrTail.text(), stdoutClosed };
    };
    const scheduleDrain = () => {
      if (!stopped || drainTimer !== undefined) return;
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(outcome());
      }, STOPPED_DRAIN_MS);
    };
    const pipe = (stream: NodeJS.ReadableStream | null, fd: 1 | 2) => {
      if (stream === null) return;
      let forwarding = true;
      let writing = false;
      const queue: Buffer[] = [];
      const next = () => {
        const chunk = queue.shift();
        if (chunk === undefined || !forwarding) {
          queue.length = 0;
          writing = false;
          if (forwarding || fd === 2) stream.resume();
          settleIfDone();
          return;
        }
        writing = true;
        driverOutput.write(fd, chunk, (error) => {
          pending -= 1;
          if (error !== undefined) {
            forwarding = false;
            pending -= queue.length;
            if (fd === 1) {
              stdoutClosed = true;
              child.stdout?.destroy();
            }
          }
          next();
        });
      };
      stream.on("data", (chunk: Buffer) => {
        if (fd === 2) stderrTail.add(chunk);
        if (!forwarding) return;
        pending += 1;
        queue.push(chunk);
        stream.pause();
        if (!writing) next();
      });
    };
    pipe(child.stdout, 1);
    pipe(child.stderr, 2);
    child.on("error", (error) => {
      const errno = Math.abs((error as NodeJS.ErrnoException).errno ?? 0) || constants.errno.ENOENT;
      finish({ status: 1, stderr: "", stdoutClosed: false, spawnErrno: errno });
    });
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      scheduleDrain();
    });
    child.on("close", (code, signal) => {
      exited ??= { code, signal };
      closed = true;
      settleIfDone();
    });
  });
}
