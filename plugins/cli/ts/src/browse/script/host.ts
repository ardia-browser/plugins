import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import { SCRIPT_RUNNER_ARGUMENT } from "../../flush-argument.ts";
import { footprint, libcBeside, libcFile } from "../../libc.ts";
import { BrowseError } from "../daemon-errors.ts";
import type { RunnerInbound, RunnerOutbound } from "./runner.ts";

export const READY_TIMEOUT_MS = 10_000;
export const SPARE_IDLE_MS = 5 * 60 * 1000;
export const READ_CONCURRENCY = 8;
export const MEMORY_LIMIT = 1024 * 1024 * 1024;
export const MEMORY_POLL_MS = 200;
export const QUEUED_BYTES = 128 * 1024 * 1024;
export const QUEUED_EVENTS = 10_000;
export const EVENT_OVERHEAD = 64;
const KEPT_ENV = ["TZ", "LANG", "LC_ALL", "LC_CTYPE", "LC_TIME", "LC_NUMERIC"];

export type Exit = { type: "exit"; code: number | null; signal: string | null };
export type Fatal = { type: "fatal"; error: Error };
export type RunnerEvent = RunnerOutbound | Exit | Fatal;

function compiled(): boolean {
  return import.meta.url.includes("$bunfs") || import.meta.url.startsWith("file:///$bunfs");
}

export function runnerCommand(): string[] {
  const libc = libcFile() ?? libcBeside();
  if (compiled()) return [process.execPath, SCRIPT_RUNNER_ARGUMENT, libc];
  const main = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "main.ts");
  return [process.execPath, main, SCRIPT_RUNNER_ARGUMENT, libc];
}

export function processFootprint(pid: number): number | null {
  if (process.platform === "linux") {
    try {
      const match = /VmRSS:\s+(\d+) kB/u.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
      return match ? Number(match[1]) * 1024 : null;
    } catch {
      return null;
    }
  }
  try {
    return footprint(pid);
  } catch {
    return null;
  }
}

function runnerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of KEPT_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function payloadSize(event: RunnerEvent): number {
  const fields = event as Record<string, unknown>;
  let size = EVENT_OVERHEAD;
  for (const key of ["request", "line", "value", "result", "name"]) {
    const value = fields[key];
    if (typeof value === "string") size += Buffer.byteLength(value, "utf8");
  }
  return size;
}

export class Runner {
  readonly child: Subprocess;
  readonly ready: Promise<number>;
  private readonly events: RunnerEvent[] = [];
  private wake: (() => void) | null = null;
  private exit: Exit | null = null;
  private confined: ((value: number) => void) | null = null;
  private failedToStart: ((error: Error) => void) | null = null;
  private memoryWatch: ReturnType<typeof setInterval> | null = null;
  overMemory = false;
  overBudget = false;
  private queuedBytes = 0;

  constructor(command: string[] = runnerCommand()) {
    this.ready = new Promise<number>((resolve, reject) => {
      this.confined = resolve;
      this.failedToStart = reject;
    });
    this.ready.catch(() => {});
    this.child = Bun.spawn(command, {
      cwd: "/",
      env: runnerEnv(),
      stdio: ["pipe", "ignore", "ignore"],
      serialization: "json",
      ipc: (message: unknown) => this.receive(message),
      onExit: (_child, code, signal) => this.exited(code, signal === null || signal === undefined ? null : String(signal)),
    });
    this.child.unref();
  }

  get alive(): boolean {
    return this.exit === null && !this.child.killed;
  }

  private receive(message: unknown): void {
    if (message === null || typeof message !== "object") return;
    const given = message as RunnerOutbound;
    if (given.type === "ready") {
      const confined = typeof given.confined === "number" ? given.confined : -1;
      this.confined?.(confined);
      this.confined = null;
      return;
    }
    const size = payloadSize(given);
    if (this.queuedBytes + size > QUEUED_BYTES || this.events.length >= QUEUED_EVENTS) {
      this.overBudget = true;
      this.events.splice(0, this.events.length);
      this.queuedBytes = 0;
      this.kill();
      return;
    }
    this.queuedBytes += size;
    this.push(given);
  }

  watchMemory(limit = MEMORY_LIMIT, every = MEMORY_POLL_MS): void {
    if (this.memoryWatch !== null || this.exit !== null) return;
    this.memoryWatch = setInterval(() => {
      const used = processFootprint(this.child.pid);
      if (used === null || used <= limit) return;
      this.overMemory = true;
      this.kill();
    }, every);
    this.memoryWatch.unref?.();
  }

  private exited(code: number | null, signal: string | null): void {
    if (this.memoryWatch !== null) clearInterval(this.memoryWatch);
    this.memoryWatch = null;
    this.exit = { type: "exit", code, signal };
    this.failedToStart?.(new BrowseError("the script's runner exited before it started", null, "script_failed"));
    this.failedToStart = null;
    this.push(this.exit);
  }

  inject(event: RunnerEvent): void {
    this.push(event);
  }

  private push(event: RunnerEvent): void {
    this.events.push(event);
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async next(): Promise<RunnerEvent> {
    for (;;) {
      const event = this.events.shift();
      if (event !== undefined) {
        this.queuedBytes = Math.max(this.queuedBytes - payloadSize(event), 0);
        return event;
      }
      if (this.exit !== null) return this.exit;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  send(message: RunnerInbound): boolean {
    if (!this.alive) return false;
    try {
      this.child.send(message);
      return true;
    } catch {
      return false;
    }
  }

  kill(): void {
    if (this.memoryWatch !== null) clearInterval(this.memoryWatch);
    this.memoryWatch = null;
    try {
      this.child.kill("SIGKILL");
    } catch {}
  }
}

let spare: Runner | null = null;
let spareTimer: ReturnType<typeof setTimeout> | null = null;

function keepSpare(): void {
  if (spareTimer !== null) clearTimeout(spareTimer);
  spare = new Runner();
  spareTimer = setTimeout(() => {
    spare?.kill();
    spare = null;
    spareTimer = null;
  }, SPARE_IDLE_MS);
  spareTimer.unref?.();
}

export function takeRunner(): { runner: Runner; warm: boolean } {
  const taken = spare !== null && spare.alive ? spare : null;
  if (spareTimer !== null) clearTimeout(spareTimer);
  spare = null;
  spareTimer = null;
  const runner = taken ?? new Runner();
  keepSpare();
  return { runner, warm: taken !== null };
}

export function dropSpare(): void {
  if (spareTimer !== null) clearTimeout(spareTimer);
  spareTimer = null;
  spare?.kill();
  spare = null;
}

export async function whenReady(runner: Runner, timeoutMs = READY_TIMEOUT_MS): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      runner.ready,
      new Promise<number>((_, reject) => {
        timer = setTimeout(() => reject(new BrowseError("the script's runner didn't start", null, "script_failed")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class Dropped extends Error {}

type Waiter = { exclusive: boolean; resolve: () => void; reject: (error: Error) => void };

export class Gate {
  private readers = 0;
  private writer = false;
  private readonly queue: Waiter[] = [];
  private closed = false;
  peak = 0;
  dropped = 0;

  constructor(private readonly limit = READ_CONCURRENCY) {}

  get queued(): number {
    return this.queue.length;
  }

  async run<T>(exclusive: boolean, work: () => Promise<T>): Promise<T> {
    if (this.closed) {
      this.dropped += 1;
      throw new Dropped();
    }
    await new Promise<void>((resolve, reject) => {
      this.queue.push({ exclusive, resolve, reject });
      this.pump();
    });
    try {
      if (this.closed) {
        this.dropped += 1;
        throw new Dropped();
      }
      return await work();
    } finally {
      if (exclusive) this.writer = false;
      else this.readers -= 1;
      this.pump();
    }
  }

  close(): number {
    this.closed = true;
    return this.dropQueued();
  }

  dropQueued(): number {
    const dropped = this.queue.splice(0, this.queue.length);
    this.dropped += dropped.length;
    for (const waiter of dropped) waiter.reject(new Dropped());
    return dropped.length;
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0] as Waiter;
      if (head.exclusive) {
        if (this.writer || this.readers > 0) return;
        this.queue.shift();
        this.writer = true;
        head.resolve();
        return;
      }
      if (this.writer || this.readers >= this.limit) return;
      this.queue.shift();
      this.readers += 1;
      this.peak = Math.max(this.peak, this.readers);
      head.resolve();
    }
  }
}

process.on("exit", dropSpare);
