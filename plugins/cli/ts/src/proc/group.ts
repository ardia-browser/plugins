import { type ChildProcess, spawn } from "node:child_process";
import os from "node:os";
import { registerGroup, strerror, unregisterGroup } from "../libc.ts";

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

  get strerror(): string {
    try {
      return strerror(this.errno);
    } catch {
      return this.code;
    }
  }
}

export const UNTRACKED_HELPER = "too many helper processes are running for ardia to track another, so it stopped it";

export class HelperUntracked extends SpawnFailed {
  constructor() {
    super("EAGAIN", (os.constants.errno as Record<string, number | undefined>)["EAGAIN"] ?? 35);
    this.message = UNTRACKED_HELPER;
  }

  override get strerror(): string {
    return UNTRACKED_HELPER;
  }
}

export const groupStats = { untracked: 0 };

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
  for (const pid of GROUPS) {
    signalGroup(pid, "SIGKILL");
    unregisterGroup(pid);
  }
  GROUPS.clear();
}

process.on("exit", killLiveGroups);

function tracked(pid: number): boolean {
  try {
    const registered = registerGroup(pid);
    return registered === null || registered === 0;
  } catch {
    return false;
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STOP_POLL_MS = 20;

export class GroupChild {
  readonly closed: Promise<number>;
  private reaped = false;
  private live = true;
  private stopping: Promise<void> | undefined;

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

  get terminating(): boolean {
    return this.stopping !== undefined;
  }

  signal(signal: NodeJS.Signals): void {
    if (!this.live) return;
    if (!signalGroup(this.pid, signal) && !this.reaped) signalLeader(this.pid, signal);
  }

  groupAlive(): boolean {
    return this.live && signalGroup(this.pid, 0);
  }

  forget(): void {
    if (this.stopping === undefined) this.unregister();
  }

  private unregister(): void {
    if (!this.live) return;
    this.live = false;
    GROUPS.delete(this.pid);
    unregisterGroup(this.pid);
  }

  release(): void {
    this.child.stdin?.destroy();
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
  }

  terminate(grace: number = KILL_GRACE, drain = 0): Promise<void> {
    this.stopping ??= this.stop(grace, drain);
    return this.stopping;
  }

  private async stop(grace: number, drain: number): Promise<void> {
    if (this.live) {
      this.signal("SIGTERM");
      const ends = performance.now() + grace * 1000;
      for (let left = ends - performance.now(); left > 0 && this.groupAlive(); left = ends - performance.now()) await sleepMs(Math.min(STOP_POLL_MS, left));
      if (this.groupAlive()) this.signal("SIGKILL");
      this.unregister();
    }
    if (drain > 0) await Promise.race([this.closed, sleepMs(drain * 1000)]);
    this.release();
  }

  untracked(): void {
    groupStats.untracked += 1;
    this.stopping = Promise.resolve();
    this.signal("SIGKILL");
    this.live = false;
    GROUPS.delete(this.pid);
    this.release();
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
    const group = new GroupChild(child, child.pid);
    if (!tracked(child.pid)) {
      group.untracked();
      reject(new HelperUntracked());
      return;
    }
    resolve(group);
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
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", cancel);
      finish();
    };
    const stop = (why: "timeout" | "cancelled") => {
      if (settled || group.terminating) return;
      settle(() => reject(why === "cancelled" ? new RunCancelled() : new RunTimedOut()));
      void group.terminate(grace / 1000);
    };
    const deadline = setTimeout(() => stop("timeout"), options.timeout * 1000);
    const cancel = () => stop("cancelled");
    signal?.addEventListener("abort", cancel, { once: true });
    void group.closed.then((code) => {
      group.forget();
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
