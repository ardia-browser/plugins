import { AsyncLocalStorage } from "node:async_hooks";
import { pyLen } from "../pylib/str.ts";
import { roundHalfEven } from "../pylib/format.ts";
import { ALIASES, KNOWN_COMMANDS } from "./tables.ts";
import { safeCode } from "./codes.ts";

export const MAX_MS = 3_600_000;
export const MAX_COUNT = 100_000_000;
export const DURATIONS = new Set([
  "total_ms", "startup_ms", "daemon_start_ms", "connect_ms", "attach_ms", "snapshot_build_ms", "action_ms", "eval_ms", "settle_ms", "cdp_ms_total",
]);
export const COUNTS = new Set([
  "cdp_calls", "read_data_blocks", "snapshot_nodes", "snapshot_chars", "output_chars", "network_writes_count", "batch_steps", "read_rows", "read_pages",
  "batch_lines_compacted", "read_tabs_reopened", "skills_installed", "skills_skipped", "failed_step_index",
  "script_calls", "script_concurrent_peak", "script_receipts_skipped",
]);
export const READ_FLAGS = new Set([
  "read_data", "read_data_shaped", "read_scrolled", "read_matched", "read_virtualized_grid", "read_pdf", "read_waited_for_content", "read_beside_busy",
  "read_bot_check", "read_scroll_guessed", "read_scope_shown", "read_scope_empty", "read_waited_for_requests", "read_partial_page", "read_frame_text",
  "read_scroll_waited_at_end", "read_oopif_frames", "snapshot_oopif_frames", "selector_in_shadow_root", "oopif_attach_refused", "snapshot_document_changed",
]);
export const ACT_FLAGS = new Set([
  "waited_for_enabled", "fill_picked_option", "fill_inserted_text", "drag_side_given", "drag_list_position", "select_opened_list", "press_targeted",
  "consent_dismissed", "popup_dismissed", "click_recentered", "dom_click_fallback", "dom_click_behind_modal", "dom_click_waited_for_modal",
  "input_in_inner_frame", "menu_closed_for_click", "modal_dismissed",
  "input_mouse_events_cancelled", "input_confirmed_by_text", "input_lost_pointer", "input_lost_keys", "input_lost_text", "input_lost_wheel", "input_lost_drag",
]);
export const ACT_COUNTS = new Set(["cell_edits"]);
export const CHANGE_FLAGS = new Set([
  "change_text", "change_run_choices", "open_report", "open_moved_tab", "snapshot_disabled_folded", "snapshot_repeat_labels", "names_clipped",
  "waited_for_reaction",
]);
export const CHANGE_COUNTS = new Set(["change_text_chars"]);
export const FLOW_FLAGS = new Set(["flow_saved", "flow_hint_shown", "flow_run_page", "flow_drifted", "flow_shaped"]);
export const FLOW_COUNTS = new Set(["flow_requests_kept", "flow_params", "flow_items"]);
export const FLAGS = new Set([
  "daemon_spawned", "reconnected_after_idle", "output_truncated", "humanize", "unsettled", "daemon_answer_timed_out", "followed_redrawn_ref",
  "script_eval_alias", "script_command_line_split", "script_page_world_hint", "attach_refused", "open_read", "covered_close_ref",
  "script_timeout_state_shown", "download_fetched_again", "page_busy_fast_fail", "session_busy_on_stuck_tab", "navigation_site_silent", "tab_kept_awake",
  "viewport_set", "crashed_reloaded", "network_disable_unconfirmed", "reattached_after_detach", "earlier_requests_ignored", "renderer_exit_kept_session",
  "setup_restored", "setup_restore_failed", "offscreen_handoff_rolled_back", "setup_session_dropped", "tab_close_interrupted", "dialog_dismissed_after_failure", "selector_nth", "output_saved", "waited_for_element", "saved_to_file", "batch_line_saved",
  "script_state_kept", "saved_as_csv", "script_timeout_read_hint", "click_scroll_locked", "open_still_loading", "focused_inner_field",
  "stale_ref_after_navigation", "clicked_label_of_hidden_input", "waited_for_box_to_settle", "frame_cross_process_box", "screenshot_unchanged", "route_enable_undone",
  "script_queued_behind_busy", "navigation_dropped_hint", "navigation_https_only_hint", "eval_timed_out", "read_queued_beside",
  "script_state_kept_on_interrupt", "find_closest_names", "batch_saved", "read_empty_page", "network_reloaded", "fill_no_reaction_hint",
  "eval_selectors_quoted", "queued_behind_script", "followed_ref_after_reload", "clicked_visible_content", "element_rehomed",
  "eval_main_world", "eval_isolated_reference_error", "permission_granted", "guessed_syntax", "find_closest_ref", "select_retyped", "select_word_match", "open_here", "stale_ref_after_open", "snapshot_diff", "snapshot_diff_full",
  "script_eval_args", "script_selector_eval", "script_frames_listed", "script_frame_eval", "script_missing_api", "script_runner_warm", "script_runner_unconfined",
  "script_runner_crashed", "script_memory_limit", "script_sandbox_hint",
]);
export const MAIN_PHASE: Readonly<Record<string, string>> = { snapshot: "snapshot_build_ms", eval: "eval_ms" };
export const FAILED_WITHOUT_CODE = "command_failed";
export const OUTPUT_MARKERS = ["\n[output capped at ", "\n[truncated ", "\n[pages cut to fit ", " not shown. Narrow it: "];

const ALL_FLAGS = [FLAGS, READ_FLAGS, ACT_FLAGS, CHANGE_FLAGS, FLOW_FLAGS];
const ALL_NUMBERS = [DURATIONS, COUNTS, ACT_COUNTS, CHANGE_COUNTS, FLOW_COUNTS];

export type MetricValue = boolean | number;

export function clock(): number {
  return performance.now() / 1000;
}

export class Metrics {
  readonly started = clock();
  readonly values: Map<string, MetricValue>;
  errorCode: string | null = null;
  failedStepCommand: string | null = null;
  failedStepCodeKept = false;

  constructor(
    readonly name: string,
    humanize: boolean,
    readonly shareable: boolean,
  ) {
    this.values = new Map<string, MetricValue>([["humanize", humanize], ["cdp_calls", 0], ["cdp_ms_total", 0]]);
  }

  addMs(key: string, started: number): void {
    this.values.set(key, Number(this.values.get(key) ?? 0) + (clock() - started) * 1000);
  }
}

const current = new AsyncLocalStorage<Metrics>();
let lastRequestShareable = false;

export type MetricsRequest = { argv?: readonly unknown[] | null; humanize?: unknown; telemetry?: unknown };

export function begin<T>(request: MetricsRequest, run: (metrics: Metrics) => T): T {
  const argv = request.argv && request.argv.length > 0 ? request.argv : [""];
  lastRequestShareable = request.telemetry === true;
  const metrics = new Metrics(String(argv[0]), Boolean(request.humanize), lastRequestShareable);
  return current.run(metrics, () => run(metrics));
}

export function active(): Metrics | undefined {
  return current.getStore();
}

export function reportingAllowed(): boolean {
  const metrics = current.getStore();
  return metrics !== undefined ? metrics.shareable : lastRequestShareable;
}

export function spent(key: string, started: number): void {
  current.getStore()?.addMs(key, started);
}

export function flag(key: string, value: unknown): void {
  current.getStore()?.values.set(key, Boolean(value));
}

export function count(key: string, value: number): void {
  current.getStore()?.values.set(key, Math.trunc(value));
}

export function add(key: string, value = 1): void {
  const metrics = current.getStore();
  if (metrics) metrics.values.set(key, Math.trunc(Number(metrics.values.get(key) ?? 0)) + Math.trunc(value));
}

export function cdpCall(started: number): void {
  const metrics = current.getStore();
  if (!metrics) return;
  metrics.values.set("cdp_calls", Number(metrics.values.get("cdp_calls")) + 1);
  metrics.addMs("cdp_ms_total", started);
}

export type RenderedResult = { data?: unknown; batch?: unknown; failed?: unknown; text?: unknown } | null | undefined;

function entry(data: unknown, key: string): unknown {
  if (data instanceof Map) return data.get(key);
  if (data !== null && typeof data === "object" && !Array.isArray(data) && Object.hasOwn(data, key)) return (data as Record<string, unknown>)[key];
  return undefined;
}

function isDict(data: unknown): boolean {
  return data instanceof Map || (data !== null && typeof data === "object" && !Array.isArray(data));
}

export function stepCommand(name: string): string {
  const canonical = ALIASES[name] ?? name;
  return KNOWN_COMMANDS.includes(canonical) ? canonical : "other";
}

export function failedStep(index: number, name: string, code: string | null | undefined, provisional = false): void {
  const metrics = current.getStore();
  if (!metrics) return;
  metrics.values.set("failed_step_index", index);
  metrics.failedStepCommand = stepCommand(name);
  metrics.errorCode = safeCode(code) ?? FAILED_WITHOUT_CODE;
  metrics.failedStepCodeKept = !provisional;
}

export type RenderedError = { code?: string | null; exit?: number | null };

export function recordFailure(metrics: Metrics, result: RenderedResult, error: RenderedError | null | undefined): void {
  if (error && !metrics.failedStepCodeKept) metrics.errorCode = error.code || (error.exit === 1 ? FAILED_WITHOUT_CODE : null);
  else if (metrics.errorCode === null && result?.failed) metrics.errorCode = FAILED_WITHOUT_CODE;
}

export function recordAnswer(metrics: Metrics, name: string, result: RenderedResult, error: RenderedError | null | undefined, out: string): void {
  const kept = metrics.failedStepCodeKept ? metrics.errorCode : null;
  recordRendered(metrics, name, result, error, out);
  recordFailure(metrics, result, error);
  if (kept !== null) metrics.errorCode = kept;
  const diffed = name === "snapshot" && isDict(result?.data) && entry(result?.data, "diff") !== undefined;
  if (diffed && typeof result?.text === "string") metrics.values.set("snapshot_chars", pyLen(result.text));
}

export function recordRendered(metrics: Metrics, name: string, result: RenderedResult, error: { code?: string | null } | null | undefined, out: string): void {
  if (error && error.code) metrics.errorCode = error.code;
  metrics.values.set("output_truncated", OUTPUT_MARKERS.some((marker) => out.includes(marker)));
  const data = result?.data;
  if (isDict(data)) {
    const tree = name === "snapshot" ? entry(data, "snapshot") : undefined;
    if (typeof tree === "string") {
      metrics.values.set("snapshot_nodes", tree ? tree.split("\n").length : 0);
      metrics.values.set("snapshot_chars", pyLen(tree));
    }
    const report = entry(data, "changes");
    const network = entry(report, "network");
    if (isDict(report) && Array.isArray(network)) {
      metrics.values.set("network_writes_count", network.length);
      metrics.values.set("unsettled", Boolean(entry(report, "unsettled")));
    }
  }
  if (Array.isArray(result?.batch)) metrics.values.set("batch_steps", (result.batch as unknown[]).length);
}

export function rendered(name: string, result: RenderedResult, error: RenderedError | null | undefined, out: string): void {
  const metrics = current.getStore();
  if (metrics) recordAnswer(metrics, name, result, error, out);
}

export type AnswerFields = { metrics?: Map<string, number | boolean>; code?: string; failed_step_command?: string };

export function answerFields(metrics: Metrics | undefined): AnswerFields {
  if (!metrics) return {};
  const total = (clock() - metrics.started) * 1000;
  let inner = 0;
  for (const key of ["connect_ms", "attach_ms", "settle_ms"]) inner += Number(metrics.values.get(key) ?? 0);
  metrics.values.set(MAIN_PHASE[metrics.name] ?? "action_ms", Math.max(0, total - inner));
  const fields: AnswerFields = { metrics: clean(metrics.values) };
  if (metrics.errorCode) fields.code = metrics.errorCode;
  if (metrics.failedStepCommand) fields.failed_step_command = metrics.failedStepCommand;
  return fields;
}

export function clean(values: ReadonlyMap<string, unknown>): Map<string, number | boolean> {
  const out = new Map<string, number | boolean>();
  for (const [key, value] of values) {
    if (ALL_FLAGS.some((set) => set.has(key)) && typeof value === "boolean") out.set(key, value);
    else if (ALL_NUMBERS.some((set) => set.has(key)) && typeof value === "number" && Number.isFinite(value)) {
      const ceiling = DURATIONS.has(key) ? MAX_MS : MAX_COUNT;
      out.set(key, Math.min(Math.max(roundHalfEven(value), 0), ceiling));
    }
  }
  return out;
}
