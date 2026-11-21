import { AsyncLocalStorage } from "node:async_hooks";

export class Cancelled extends Error {
  override readonly name = "CancelledError";

  constructor() {
    super("");
  }
}

const scope = new AsyncLocalStorage<AbortSignal | null>();
const LONGEST_TIMER_MS = 2 ** 31 - 1;

export function later(ms: number, run: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const until = performance.now() + ms;
  const arm = () => {
    const left = until - performance.now();
    timer = setTimeout(left > LONGEST_TIMER_MS ? arm : run, Math.min(Math.max(0, left), LONGEST_TIMER_MS));
  };
  arm();
  return () => clearTimeout(timer);
}

export function withSignal<T>(signal: AbortSignal | null, run: () => T): T {
  return scope.run(signal, run);
}

export function currentSignal(): AbortSignal | null {
  return scope.getStore() ?? null;
}

export function checkCancelled(signal: AbortSignal | null = currentSignal()): void {
  if (signal?.aborted) throw new Cancelled();
}

export function shield<T>(run: () => Promise<T>): Promise<T> {
  return scope.run(null, run);
}

export function untilCancelled<T>(work: Promise<T>, signal: AbortSignal | null = currentSignal()): Promise<T> {
  if (signal === null) return work;
  if (signal.aborted) return Promise.reject(new Cancelled());
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Cancelled());
    signal.addEventListener("abort", stop, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

export async function sleep(seconds: number, signal: AbortSignal | null = currentSignal()): Promise<void> {
  checkCancelled(signal);
  let stopTimer = () => {};
  const slept = new Promise<void>((resolve) => {
    stopTimer = later(Math.max(0, seconds * 1000), resolve);
  });
  try {
    await untilCancelled(slept, signal);
  } finally {
    stopTimer();
  }
}
