import { guardWrites, interruptsIgnored } from "./libc.ts";
import { killLiveGroups } from "./proc/group.ts";

export class Stopped extends Error {}

const STOP_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
const PARENT_POLL_MS = 50;

type StopSignal = (typeof STOP_SIGNALS)[number];

let startedBy: number | undefined;
let stopping: StopSignal | undefined;
const rollbacks = new Set<() => void>();

function parentGone(): boolean {
  return startedBy !== undefined && (startedBy === 1 || process.ppid !== startedBy);
}

function die(signal: StopSignal): never {
  killLiveGroups();
  for (const rollback of [...rollbacks]) {
    try {
      rollback();
    } catch {}
  }
  rollbacks.clear();
  for (const name of STOP_SIGNALS) process.removeAllListeners(name);
  process.kill(process.pid, signal);
  process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const)[signal]);
}

function stopOn(signal: StopSignal): void {
  stopping ??= signal;
  die(stopping);
}

export function armAfterUpdateGuard(): void {
  if (startedBy !== undefined) return;
  startedBy = process.ppid;
  guardWrites();
  for (const name of STOP_SIGNALS) if (name !== "SIGINT" || !interruptsIgnored()) process.on(name, () => stopOn(name));
  setInterval(() => {
    if (parentGone()) stopOn("SIGTERM");
  }, PARENT_POLL_MS).unref();
}

export function stopRequested(): boolean {
  if (stopping === undefined && parentGone()) stopping = "SIGTERM";
  return stopping !== undefined;
}

export function stopPoint(): void {
  if (stopRequested()) throw new Stopped();
}

export async function stepBoundary(): Promise<void> {
  if (startedBy === undefined) return;
  await new Promise((resolve) => setImmediate(resolve));
  stopPoint();
}

export function rollbackOnStop(rollback: () => void): () => void {
  rollbacks.add(rollback);
  return () => {
    rollbacks.delete(rollback);
  };
}

export async function guardedAfterUpdate<T>(work: () => Promise<T>): Promise<T> {
  armAfterUpdateGuard();
  try {
    return await work();
  } catch (error) {
    if (error instanceof Stopped) die(stopping ?? "SIGTERM");
    throw error;
  }
}
