export const CODES: ReadonlySet<string> = new Set([
  "ambiguous", "answer_too_large", "attaches_unanswered", "auth_expired", "bad_init_script", "bad_site", "bad_value", "blocked", "borrowed_tab",
  "browser_restarted", "command_timeout", "connection_lost", "covered", "credential_not_sendable", "credential_provider_failed", "cross_process_frame",
  "disabled", "document_changed", "download_remote", "drifted", "element_replaced", "failed", "fetch_failed", "fetch_interrupted", "flow_invalid",
  "flow_not_get", "flow_too_large", "frame_gone", "http_error", "input_not_delivered", "input_unconfirmable", "lock_busy", "navigation_failed", "no_data",
  "no_flow", "no_fresh_suggestions", "no_links", "no_list", "no_match", "no_session_tab", "no_steps", "no_tab", "no_viewport", "not_a_web_page",
  "not_editable", "not_focusable", "not_found", "not_run", "not_selectable", "not_visible", "notes_too_large", "nothing_to_save", "off_site",
  "outcome_unknown", "outside_viewport", "page_busy", "page_navigated", "page_script_error", "pdf_unreadable", "policy_refused", "rate_limited",
  "redirected", "registry_full", "rejected", "result_too_large", "script_failed", "script_syntax", "session_busy", "session_closing", "setup_lost",
  "stale_ref", "tab_asleep", "tab_closing", "tab_crashed", "tab_detached", "tab_gone", "tab_hidden", "tab_in_use", "tab_not_found", "tab_owned",
  "target_replaced", "temporary_limit", "timeout", "unhandled_exception", "unknown_field", "unknown_ref", "unsupported", "usage",
  "viewport_needs_hidden_tab", "viewport_unsupported",
]);

export function safeCode(code: string | null | undefined, fallback = "failed"): string | null {
  if (code === null || code === undefined || code === "") return null;
  return CODES.has(code) ? code : fallback;
}
