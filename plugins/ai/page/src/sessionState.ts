export type Phase = "idle" | "starting" | "ready" | "retrying" | "stopped";

export type SessionState = { readonly phase: Phase; readonly error: string | null; readonly failures: number; readonly epoch: number };

export type SessionEvent =
  | { readonly type: "start" }
  | { readonly type: "attempt" }
  | { readonly type: "succeeded"; readonly epoch: number }
  | { readonly type: "failed"; readonly epoch: number; readonly error: string }
  | { readonly type: "lost"; readonly error: string }
  | { readonly type: "stop" };

export type Screen =
  | { readonly kind: "connecting" }
  | { readonly kind: "reconnecting"; readonly error: string; readonly canRetry: boolean }
  | { readonly kind: "ready" }
  | { readonly kind: "closed" };

export const INITIAL_SESSION: SessionState = { phase: "idle", error: null, failures: 0, epoch: 0 };
export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
export const NOT_ANSWERING = "The assistant's runtime isn't answering.";

export function retryDelay(failures: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(failures, 1), RETRY_DELAYS_MS.length) - 1]!;
}

export function nextSession(state: SessionState, event: SessionEvent): SessionState {
  if (state.phase === "stopped") return state;
  switch (event.type) {
    case "stop":
      return { ...state, phase: "stopped" };
    case "start":
      return state.phase === "idle" ? { ...state, phase: "starting" } : state;
    case "attempt":
      return state.phase === "retrying" ? { ...state, phase: "starting" } : state;
    case "succeeded":
      if (state.phase !== "starting") return state;
      return event.epoch === state.epoch
        ? { phase: "ready", error: null, failures: 0, epoch: state.epoch }
        : { ...state, phase: "retrying", failures: state.failures + 1 };
    case "failed":
      if (state.phase !== "starting") return state;
      return { ...state, phase: "retrying", error: event.epoch === state.epoch ? event.error : state.error, failures: state.failures + 1 };
    case "lost":
      if (state.phase === "ready") return { phase: "retrying", error: event.error, failures: state.failures + 1, epoch: state.epoch + 1 };
      if (state.phase === "starting") return { ...state, error: event.error, epoch: state.epoch + 1 };
      return state;
  }
}

export function screenFor(state: SessionState, healthy: boolean): Screen {
  switch (state.phase) {
    case "idle":
      return { kind: "connecting" };
    case "starting":
      return state.error ? { kind: "reconnecting", error: state.error, canRetry: false } : { kind: "connecting" };
    case "retrying":
      return { kind: "reconnecting", error: state.error ?? NOT_ANSWERING, canRetry: true };
    case "ready":
      return healthy ? { kind: "ready" } : { kind: "reconnecting", error: NOT_ANSWERING, canRetry: false };
    case "stopped":
      return { kind: "closed" };
  }
}
