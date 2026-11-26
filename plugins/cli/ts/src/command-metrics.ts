import { Float, type Value } from "./json.ts";
import { PRECISION_COUNTS, PRECISION_FLAGS } from "./browse/act/precision-metrics.ts";
import { METRIC_COUNTS, METRIC_DURATIONS, METRIC_FLAGS, METRIC_MAX_COUNT, METRIC_MAX_MS } from "./telemetry-tables.ts";
import { SAFETY_FLAGS } from "./browse/metrics.ts";

export const TS_ONLY_FLAGS: readonly string[] = [
  "batch_ref_ambiguous",
  "batch_ref_healed",
  "batch_ref_missing",
  "batch_ref_not_followed",
  "dialog_dismissed_after_failure",
  "eval_isolated_reference_error",
  "eval_main_world",
  "field_label_fallback",
  "find_closest_ref",
  "find_is",
  "form",
  "guessed_syntax",
  "help_in_daemon",
  "here",
  "here_read",
  "offscreen_handoff_rolled_back",
  "oopif_attach_refused",
  "open_here",
  "permission_granted",
  "query",
  "query_fields",
  "read_oopif_frames",
  "read_urls_deadline",
  "read_urls",
  "route_enable_undone",
  "script_eval_args",
  "script_frame_eval",
  "script_frames_listed",
  "script_memory_limit",
  "script_missing_api",
  "script_repl",
  "script_repl_auto_tab",
  "script_repl_logs_spilled",
  "script_repl_lost",
  "script_repl_reset",
  "script_repl_value_spilled",
  "script_runner_crashed",
  "script_runner_unconfined",
  "script_runner_warm",
  "script_sandbox_hint",
  "script_selector_eval",
  "script_steps_shown",
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
  "snapshot_lean_trimmed",
  "snapshot_modal_scoped",
  "snapshot_oopif_frames",
  "snapshot_paired",
  "snapshot_paired_unstable",
  "stale_ref_after_open",
  "tab_close_interrupted",
  "tab_readopted_after_restart",
  "triage_agent_claude",
  "triage_agent_codex",
  "triage_agent_none",
  "triage_commented",
  "triage_declined",
  "triage_filed_feedback",
  "triage_filed_form",
  "triage_filed_gh",
  "triage_launched",
  "triage_prepared",
  "triage_printed",
  "triage_refused",
  "drag_interception_unavailable",
  "drag_synthetic",
  "edit_cell",
  "fill_otp",
  "hover_revealed",
  "mcp_session_registered",
  "script_display_capped",
  "script_display_refused",
  "fill_otp_profile",
  "snapshot_child_frames",
];

export const TS_ONLY_COUNTS: readonly string[] = ["batch_refs_healed", "failed_step_index", "form_fields", "query_rows", "read_urls_count", "read_urls_failed", "fill_otp_boxes", "hover_revealed_items", "script_calls", "script_concurrent_peak", "script_display_images", "snapshot_child_frame_count", "script_receipts_skipped", "script_repl_runs", "snapshot_find_matches", "snapshot_lean_lines", "snapshot_lines_dropped", "snapshot_new_lines", "snapshot_oopif_count"];

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
