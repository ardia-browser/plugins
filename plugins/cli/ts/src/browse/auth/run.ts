import { spawn } from "node:child_process";
import os from "node:os";
import { strerror } from "../../libc.ts";
import { Cancelled, currentSignal } from "../cdp/cancel.ts";

export type Ran = { code: number; stdout: Buffer; stderr: Buffer };

export class SpawnFailed extends Error {
  constructor(
    readonly code: string,
    readonly strerror: string,
  ) {
    super(strerror);
  }
}

export class RunTimedOut extends Error {}

function describe(error: unknown): SpawnFailed {
  const code = (error as { code?: unknown }).code;
  const name = typeof code === "string" ? code : "EIO";
  const errno = (os.constants.errno as Record<string, number | undefined>)[name];
  let text = name;
  try {
    if (errno !== undefined) text = strerror(errno);
  } catch {
    text = name;
  }
  return new SpawnFailed(name, text);
}

function sink(limit: number): { push: (chunk: Buffer) => void; take: () => Buffer } {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    push(chunk: Buffer) {
      if (size < limit) chunks.push(chunk.subarray(0, Math.max(0, limit - size)));
      size += chunk.length;
    },
    take: () => Buffer.concat(chunks),
  };
}

export function run(
  argv: readonly string[],
  options: { input?: Uint8Array; timeout: number; env?: Record<string, string>; cwd?: string; limit?: number },
): Promise<Ran> {
  const signal = currentSignal();
  if (signal?.aborted) return Promise.reject(new Cancelled());
  const limit = options.limit ?? 64 * 1024 * 1024;
  return new Promise<Ran>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0] as string, argv.slice(1), {
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        env: options.env ?? process.env,
        shell: false,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      });
    } catch (error) {
      reject(describe(error));
      return;
    }
    const out = sink(limit);
    const err = sink(limit);
    let outcome: "timeout" | "cancelled" | null = null;
    let failure: unknown = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      run();
    };
    const stop = (why: "timeout" | "cancelled") => {
      outcome ??= why;
      child.kill("SIGKILL");
      child.once("exit", () => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(() => reject(why === "timeout" ? new RunTimedOut() : new Cancelled()));
      });
    };
    timer = setTimeout(() => stop("timeout"), options.timeout * 1000);
    cancel = () => stop("cancelled");
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      failure ??= error;
      if (child.pid === undefined) finish(() => reject(describe(error)));
    });
    child.on("close", (code, killedBy) => {
      if (outcome !== null) return;
      finish(() => {
        if (failure !== null && child.pid === undefined) reject(describe(failure));
        else {
          const signalled = killedBy === null ? null : (os.constants.signals as Record<string, number | undefined>)[killedBy];
          resolve({ code: code ?? -(signalled ?? 1), stdout: out.take(), stderr: err.take() });
        }
      });
    });
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(Buffer.from(options.input));
    }
  });
}
