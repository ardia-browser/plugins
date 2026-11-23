export const OBSTRUCTION_KINDS = ["modal", "fixed_header", "iframe", "clipped_scroll", "overlay", "offscreen", "sibling"] as const;

export const PRECISION_FLAGS: ReadonlySet<string> = new Set([
  ...OBSTRUCTION_KINDS.map((kind) => `click_obstructed_${kind}`),
  "click_blocker_ref",
  "ref_drift_refused",
  "dialog_blocked_action",
  "dialog_in_receipt",
  "download_in_receipt",
  "batch_bailed_on_dialog",
  "side_effect_retry_refused",
  "read_retry_after_detach",
  "action_landed_settle_lost",
  "fill_final_key",
  "fill_followed_focus",
  "fill_readback_mismatch",
  "fill_readback_unverified",
  "check_already_set",
  "select_listed_options",
  "settle_swept_stale_requests",
  "settle_ignored_streams",
  "settle_throttle_scaled",
  "navigation_net_error",
]);

export const PRECISION_COUNTS: ReadonlySet<string> = new Set(["obstruction_refusals", "drift_refusals", "dialog_blocked_actions", "retry_refusals"]);
