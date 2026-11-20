import { type ChildProcess, spawn } from "node:child_process";
import os from "node:os";
import { strerror } from "../../libc.ts";
import { Cancelled, currentSignal } from "../cdp/cancel.ts";

export type Ran = { code: number; stdout: Buffer; stderr: Buffer };
export type RunOptions = { input?: Uint8Array; timeout: number; env?: Record<string, string>; cwd?: string; limit?: number; grace?: number };

export const KILL_GRACE = 0.5;

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

export function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function exitCode(child: ChildProcess): number {
  if (child.exitCode !== null) return child.exitCode;
  const signalled = child.signalCode === null ? undefined : (os.constants.signals as Record<string, number | undefined>)[child.signalCode];
  return -(signalled ?? 1);
}

export function run(argv: readonly string[], options: RunOptions): Promise<Ran> {
  const signal = currentSignal();
  if (signal?.aborted) return Promise.reject(new Cancelled());
  const limit = options.limit ?? 64 * 1024 * 1024;
  const grace = (options.grace ?? KILL_GRACE) * 1000;
  return new Promise<Ran>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(argv[0] as string, argv.slice(1), {
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        env: options.env ?? process.env,
        shell: false,
        detached: true,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      });
    } catch (error) {
      reject(describe(error));
      return;
    }
    const out = sink(limit);
    const err = sink(limit);
    let settled = false;
    let stopping: "timeout" | "cancelled" | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", cancel);
      finish();
    };
    const giveUp = () => {
      const pid = child.pid;
      if (pid !== undefined) signalGroup(pid, "SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      settle(() => reject(stopping === "cancelled" ? new Cancelled() : new RunTimedOut()));
    };
    const groupGone = () => child.pid === undefined || !signalGroup(child.pid, 0);
    const stop = (why: "timeout" | "cancelled") => {
      if (settled || stopping !== null) return;
      stopping = why;
      const pid = child.pid;
      if (pid === undefined) {
        giveUp();
        return;
      }
      signalGroup(pid, "SIGTERM");
      if (exited() && groupGone()) {
        giveUp();
        return;
      }
      killTimer = setTimeout(giveUp, grace);
    };
    const deadline = setTimeout(() => stop("timeout"), options.timeout * 1000);
    const cancel = () => stop("cancelled");
    signal?.addEventListener("abort", cancel, { once: true });
    child.on("error", (error) => {
      if (child.pid === undefined) settle(() => reject(describe(error)));
    });
    child.on("exit", () => {
      if (stopping !== null && groupGone()) giveUp();
    });
    child.on("close", () => {
      if (stopping !== null) {
        giveUp();
        return;
      }
      settle(() => resolve({ code: exitCode(child), stdout: out.take(), stderr: err.take() }));
    });
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(Buffer.from(options.input));
    }
  });
}
