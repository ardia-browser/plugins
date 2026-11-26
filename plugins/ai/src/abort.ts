import type { AbortSignalLike, CancelSignal } from "@ardia/plugin-sdk";

export type Aborter = { signal: AbortSignalLike; abort(reason?: unknown): void };

export function createAborter(): Aborter {
  const listeners = new Set<() => void>();
  let aborted = false;
  let reason: unknown;
  const signal: AbortSignalLike = {
    get aborted() {
      return aborted;
    },
    get reason() {
      return reason;
    },
    addEventListener(_type, listener) {
      if (aborted) listener();
      else listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
  };
  return {
    signal,
    abort(why) {
      if (aborted) return;
      aborted = true;
      reason = why;
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
  };
}

export function abortOnCancel(cancel: CancelSignal | undefined): Aborter {
  const aborter = createAborter();
  if (cancel) cancel.onCancel(() => aborter.abort("cancelled"));
  return aborter;
}
