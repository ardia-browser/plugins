import { BrowseError, ConnectionLost, OutcomeUnknown } from "../daemon-errors.ts";
import { add, flag } from "../metrics.ts";

export const READ_ONLY_RETRY: ReadonlySet<string> = new Set(["snapshot", "get", "is", "read", "screenshot", "title", "url", "text", "html", "count", "box", "styles", "diff"]);

export const SIDE_EFFECTS: ReadonlySet<string> = new Set([
  "click", "dblclick", "tap", "fill", "type", "press", "keyboard", "keydown", "keyup", "submit", "select", "check", "uncheck", "drag", "upload",
  "download", "eval", "script", "mouse", "hover", "focus", "scroll", "scrollintoview", "find", "dialog", "open", "back", "forward", "reload",
]);

export const LOST_MIDWAY = new Set(["tab_detached"]);

export function sideEffectful(command: string): boolean {
  return SIDE_EFFECTS.has(command) || !READ_ONLY_RETRY.has(command);
}

export function mayRetry(command: string, error: BrowseError): boolean {
  if (!READ_ONLY_RETRY.has(command) || error instanceof ConnectionLost) return false;
  return LOST_MIDWAY.has(error.code ?? "") || error.code === "document_changed";
}

export function noteReadRetry(): void {
  flag("read_retry_after_detach", true);
}

export function refusedRetry(command: string, error: BrowseError): BrowseError {
  if (!sideEffectful(command) || !LOST_MIDWAY.has(error.code ?? "")) return error;
  flag("side_effect_retry_refused", true);
  add("retry_refusals");
  return new OutcomeUnknown(`\`${command}\``, "Ardia detached the tab after it had started (snapshot to see where the page is)");
}
