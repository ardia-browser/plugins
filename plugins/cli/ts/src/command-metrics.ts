import { Float, type Value } from "./json.ts";
import { METRIC_COUNTS, METRIC_DURATIONS, METRIC_FLAGS, METRIC_MAX_COUNT, METRIC_MAX_MS } from "./telemetry-tables.ts";

export const TS_ONLY_FLAGS: readonly string[] = [
  "dialog_dismissed_after_failure",
  "eval_isolated_reference_error",
  "eval_main_world",
  "find_closest_ref",
  "guessed_syntax",
  "offscreen_handoff_rolled_back",
  "oopif_attach_refused",
  "open_here",
  "permission_granted",
  "read_oopif_frames",
  "route_enable_undone",
  "select_retyped",
  "script_eval_args",
  "script_frame_eval",
  "script_frames_listed",
  "script_memory_limit",
  "script_missing_api",
  "script_runner_crashed",
  "script_runner_unconfined",
  "script_runner_warm",
  "script_sandbox_hint",
  "script_selector_eval",
  "select_word_match",
  "selector_in_shadow_root",
  "setup_session_dropped",
  "snapshot_diff",
  "snapshot_diff_full",
  "snapshot_document_changed",
  "snapshot_oopif_frames",
  "stale_ref_after_open",
  "tab_close_interrupted",
];

export const TS_ONLY_COUNTS: readonly string[] = ["failed_step_index", "script_calls", "script_concurrent_peak", "script_receipts_skipped"];

const FLAGS = new Set([...METRIC_FLAGS, ...TS_ONLY_FLAGS]);
const DURATIONS = new Set(METRIC_DURATIONS);
const COUNTS = new Set([...METRIC_COUNTS, ...TS_ONLY_COUNTS]);

function roundHalfEven(value: number): bigint {
  const floor = Math.floor(value);
  const diff = value - floor;
  const rounded = diff > 0.5 || (diff === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
  return BigInt(rounded);
}

export function isMetricFlag(key: string): boolean {
  return FLAGS.has(key);
}

export function isMetricCount(key: string): boolean {
  return COUNTS.has(key);
}

export function cleanMetrics(values: Value | undefined): Map<string, Value> {
  const out = new Map<string, Value>();
  if (!(values instanceof Map)) return out;
  for (const [key, value] of values) {
    if (FLAGS.has(key)) {
      if (typeof value === "boolean") out.set(key, value);
      continue;
    }
    if (!DURATIONS.has(key) && !COUNTS.has(key)) continue;
    let whole: bigint;
    if (typeof value === "bigint") whole = value;
    else if (value instanceof Float && Number.isFinite(value.value)) whole = roundHalfEven(value.value);
    else continue;
    const ceiling = BigInt(DURATIONS.has(key) ? METRIC_MAX_MS : METRIC_MAX_COUNT);
    out.set(key, whole < 0n ? 0n : whole > ceiling ? ceiling : whole);
  }
  return out;
}

export function cleanNumber(key: string, value: number | bigint): Map<string, Value> {
  return cleanMetrics(new Map<string, Value>([[key, typeof value === "bigint" ? value : Number.isInteger(value) ? BigInt(value) : new Float(value)]]));
}
