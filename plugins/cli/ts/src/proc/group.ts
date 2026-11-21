import { type ChildProcess, spawn } from "node:child_process";
import os from "node:os";

export type Ran = { code: number; stdout: Buffer; stderr: Buffer };
export type Stdio = "pipe" | "ignore" | "inherit";
export type SpawnOptions = { env?: Record<string, string | undefined>; cwd?: string; stdin?: Stdio; stdout?: Stdio; stderr?: Stdio };
export type RunOptions = { input?: Uint8Array; timeout: number; env?: Record<string, string | undefined>; cwd?: string; limit?: number; grace?: number; signal?: AbortSignal };

export const KILL_GRACE = 0.5;

export class SpawnFailed extends Error {
  constructor(
    readonly code: string,
    readonly errno: number,
  ) {
    super(code);
  }
}

export class RunTimedOut extends Error {}
export class RunCancelled extends Error {}

function describe(error: unknown): SpawnFailed {
  const code = (error as { code?: unknown }).code;
  const name = typeof code === "string" ? code : "EIO";
  const errno = (os.constants.errno as Record<string, number | undefined>)[name] ?? 5;
  return new SpawnFailed(name, errno);
}

export function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function signalLeader(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function exitStatus(child: ChildProcess): number {
  if (child.exitCode !== null) return child.exitCode;
  const signalled = child.signalCode === null ? undefined : (os.constants.signals as Record<string, number | undefined>)[child.signalCode];
  return -(signalled ?? 1);
}

const GROUPS = new Set<number>();

export function liveGroups(): number[] {
  return [...GROUPS];
}

export function killLiveGroups(): void {
  for (const pid of GROUPS) signalGroup(pid, "SIGKILL");
  GROUPS.clear();
}

process.on("exit", killLiveGroups);

export class GroupChild {
  readonly closed: Promise<number>;
  private reaped = false;
  private live = true;

  constructor(
    readonly child: ChildProcess,
    readonly pid: number,
  ) {
    GROUPS.add(pid);
    child.on("exit", () => {
      this.reaped = true;
    });
    this.closed = new Promise((resolve) => child.on("close", () => resolve(exitStatus(child))));
  }

  get exited(): boolean {
    return this.reaped;
  }

  signal(signal: NodeJS.Signals): void {
    if (!this.live) return;
    if (!signalGroup(this.pid, signal) && !this.reaped) signalLeader(this.pid, signal);
  }

  groupAlive(): boolean {
    return this.live && signalGroup(this.pid, 0);
  }

  forget(): void {
    if (!this.live) return;
    this.live = false;
    GROUPS.delete(this.pid);
  }
}

export function spawnGroup(argv: readonly string[], options: SpawnOptions = {}): Promise<GroupChild> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(argv[0] as string, argv.slice(1), {
        stdio: [options.stdin ?? "ignore", options.stdout ?? "ignore", options.stderr ?? "ignore"],
        env: options.env ?? process.env,
        shell: false,
        detached: true,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      });
    } catch (error) {
      reject(describe(error));
      return;
    }
    if (child.pid === undefined) {
      child.once("error", (error) => reject(describe(error)));
      return;
    }
    child.on("error", () => {});
    resolve(new GroupChild(child, child.pid));
  });
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

export function run(argv: readonly string[], options: RunOptions): Promise<Ran> {
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(new RunCancelled());
  const limit = options.limit ?? 64 * 1024 * 1024;
  const grace = (options.grace ?? KILL_GRACE) * 1000;
  const started = spawnGroup(argv, {
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  return started.then((group) => collect(group, options, limit, grace, signal));
}

function collect(group: GroupChild, options: RunOptions, limit: number, grace: number, signal: AbortSignal | undefined): Promise<Ran> {
  return new Promise<Ran>((resolve, reject) => {
    const child = group.child;
    const out = sink(limit);
    const err = sink(limit);
    let settled = false;
    let stopping = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", cancel);
      finish();
    };
    const release = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
    };
    const stop = (why: "timeout" | "cancelled") => {
      if (settled || stopping) return;
      stopping = true;
      settle(() => reject(why === "cancelled" ? new RunCancelled() : new RunTimedOut()));
      group.signal("SIGTERM");
      setTimeout(() => {
        if (group.groupAlive()) group.signal("SIGKILL");
        group.forget();
        release();
      }, grace);
    };
    const deadline = setTimeout(() => stop("timeout"), options.timeout * 1000);
    const cancel = () => stop("cancelled");
    signal?.addEventListener("abort", cancel, { once: true });
    void group.closed.then((code) => {
      if (!stopping) group.forget();
      settle(() => resolve({ code, stdout: out.take(), stderr: err.take() }));
    });
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(Buffer.from(options.input));
    }
  });
}
