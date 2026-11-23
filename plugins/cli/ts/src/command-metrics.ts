import { Float, type Value } from "./json.ts";
import { PRECISION_COUNTS, PRECISION_FLAGS } from "./browse/act/precision-metrics.ts";
import { METRIC_COUNTS, METRIC_DURATIONS, METRIC_FLAGS, METRIC_MAX_COUNT, METRIC_MAX_MS } from "./telemetry-tables.ts";
import { SAFETY_FLAGS } from "./browse/metrics.ts";

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
  "select_retyped",
  "select_word_match",
  "selector_in_shadow_root",
  "setup_session_dropped",
  "snapshot_budget_trimmed",
  "snapshot_closed_shadow",
  "snapshot_diff",
  "snapshot_diff_full",
  "snapshot_document_changed",
  "snapshot_dom_depth_retry",
  "snapshot_find",
  "snapshot_hidden_text_dropped",
  "snapshot_modal_scoped",
  "snapshot_oopif_frames",
  "snapshot_paired",
  "snapshot_paired_unstable",
  "stale_ref_after_open",
  "tab_close_interrupted",
  "tab_readopted_after_restart",
];

export const TS_ONLY_COUNTS: readonly string[] = ["failed_step_index", "script_calls", "script_concurrent_peak", "script_receipts_skipped", "snapshot_find_matches", "snapshot_lines_dropped", "snapshot_new_lines", "snapshot_oopif_count"];

const FLAGS = new Set([...METRIC_FLAGS, ...TS_ONLY_FLAGS, ...PRECISION_FLAGS, ...SAFETY_FLAGS]);
const DURATIONS = new Set(METRIC_DURATIONS);
const COUNTS = new Set([...METRIC_COUNTS, ...TS_ONLY_COUNTS, ...PRECISION_COUNTS]);

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
