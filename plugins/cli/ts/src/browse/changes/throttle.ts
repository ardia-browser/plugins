import { flag } from "../metrics.ts";
import type { Page } from "../state/page.ts";

export const CPU_METHOD = "Emulation.setCPUThrottlingRate";
export const NETWORK_METHOD = "Network.emulateNetworkConditions";
export const THROTTLE_METHODS = new Set([CPU_METHOD, NETWORK_METHOD]);
export const MAX_SCALE = 8;
export const BASE_LATENCY_MS = 100;
export const BASE_THROUGHPUT = 1_000_000;

export type Throttle = { cpu: number | null; latencyMs: number | null; throughput: number | null; offline: boolean; scale: number };

type Overrides = ReadonlyMap<string, Readonly<Record<string, unknown>> | null>;

const raw = new WeakMap<object, Map<string, Map<string, Record<string, unknown>>>>();

export function noteRawThrottle(state: object, targetId: string, method: string, given: unknown): void {
  if (!THROTTLE_METHODS.has(method)) return;
  const params = given !== null && typeof given === "object" && !Array.isArray(given) ? (given as Record<string, unknown>) : {};
  let targets = raw.get(state);
  if (targets === undefined) raw.set(state, (targets = new Map()));
  let methods = targets.get(targetId);
  if (methods === undefined) targets.set(targetId, (methods = new Map()));
  methods.set(method, { ...params });
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function throttleFrom(overrides: Overrides): Throttle | null {
  const cpuParams = overrides.get(CPU_METHOD) ?? null;
  const netParams = overrides.get(NETWORK_METHOD) ?? null;
  const rate = number(cpuParams?.["rate"]);
  const cpu = rate !== null && rate > 1 ? rate : null;
  const offline = Boolean(netParams?.["offline"]);
  const latency = number(netParams?.["latency"]);
  const latencyMs = latency !== null && latency > 0 ? latency : null;
  const down = number(netParams?.["downloadThroughput"]);
  const throughput = down !== null && down > 0 ? down : null;
  if (cpu === null && latencyMs === null && throughput === null) return offline ? { cpu: null, latencyMs: null, throughput: null, offline, scale: 1 } : null;
  const network = Math.max(1, latencyMs !== null ? 1 + latencyMs / BASE_LATENCY_MS : 1, throughput !== null ? BASE_THROUGHPUT / throughput : 1);
  const scale = Math.min(MAX_SCALE, Math.max(cpu ?? 1, offline ? 1 : network));
  return { cpu, latencyMs, throughput, offline, scale: Math.round(scale * 100) / 100 };
}

export function throttleOf(page: Page): Throttle | null {
  const merged = new Map<string, Readonly<Record<string, unknown>> | null>();
  const state = page.state as object | undefined;
  for (const [method, params] of (state ? raw.get(state)?.get(page.targetId) : undefined) ?? []) merged.set(method, params);
  for (const [method, params] of page.overrides ?? []) if (THROTTLE_METHODS.has(method)) merged.set(method, params as Record<string, unknown> | null);
  return throttleFrom(merged);
}

export function budget(page: Page | null, seconds: number): number {
  if (page === null) return seconds;
  const throttle = throttleOf(page);
  if (throttle === null || throttle.scale <= 1) return seconds;
  flag("settle_throttle_scaled", true);
  return seconds * throttle.scale;
}

export function throttleLine(throttle: Throttle): string {
  const parts: string[] = [];
  if (throttle.cpu !== null) parts.push(`CPU ${throttle.cpu}× slower`);
  if (throttle.latencyMs !== null) parts.push(`${throttle.latencyMs} ms latency`);
  if (throttle.throughput !== null) parts.push(`${Math.round(throttle.throughput / 1024)} KB/s down`);
  if (throttle.offline) parts.push("offline");
  const scaled = throttle.scale > 1 ? `; waits were ${throttle.scale}× longer` : "";
  return `(throttled: ${parts.join(", ")}${scaled})`;
}
