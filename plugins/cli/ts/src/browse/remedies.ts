import { CODES } from "./codes.ts";
import { ALIASES, KNOWN_COMMANDS } from "./tables.ts";

export type CodeHelp = { means: string; remedy?: string };

export const COMMAND_SLOT = "{command}";

export const ERROR_CODES: Readonly<Record<string, CodeHelp>> = {
  ambiguous: { means: "several elements match; the message lists them with refs", remedy: "ardia browse snapshot -i" },
  ardia_too_old: { means: "this Ardia's engine lacks a DevTools method the command needs; update Ardia", remedy: "ardia methods" },
  borrowed_tab: { means: "the session works in your tab (`tab active`) and won't do this there without naming it", remedy: "ardia browse tab list" },
  covered: { means: "another element sits on top of the target", remedy: "ardia browse screenshot --annotate" },
  daemon_timeout: { means: "the session's daemon didn't answer in time", remedy: "ardia browse session list" },
  daemon_unreachable: { means: "Ardia or the session's daemon can't be reached (exit 2)", remedy: "ardia browse session list" },
  dialog_blocked: { means: "a JavaScript dialog froze the page; answer it first", remedy: "ardia browse dialog status" },
  disabled: { means: "the target stayed disabled", remedy: "ardia browse snapshot -i" },
  document_changed: { means: "the page changed document while the command ran", remedy: "ardia browse snapshot -i" },
  element_replaced: { means: "the page redrew the element", remedy: "ardia browse snapshot -i" },
  focus_moved: { means: "focus left the field mid-typing, so the rest wasn't sent", remedy: "ardia browse snapshot -i" },
  frame_gone: { means: "the frame the session acts in went away", remedy: "ardia browse frame main" },
  keychain_refused: { means: "the macOS Keychain refused the change; the profile was kept" },
  navigation_failed: { means: "the page didn't load; the message says why" },
  no_match: { means: "nothing matches the selector or name", remedy: "ardia browse snapshot -i" },
  no_session_tab: { means: "the session has no tab yet: open one or pick the user's", remedy: "ardia browse tab active" },
  no_tab: { means: "that tab isn't there", remedy: "ardia browse tab list" },
  not_found: { means: "the element, flow or item isn't there", remedy: "ardia browse snapshot -i" },
  not_own_tab: { means: "the command works only on tabs this session opened", remedy: "ardia browse tab list" },
  not_visible: { means: "the element has no box on screen", remedy: "ardia browse screenshot --annotate" },
  outcome_unknown: { means: "the connection dropped mid-action; check the page before retrying", remedy: "ardia browse snapshot -i" },
  outside_viewport: { means: "the element is outside the visible page", remedy: "ardia browse screenshot --annotate" },
  page_busy: { means: "the page's script kept the tab busy", remedy: "ardia browse screenshot" },
  policy_refused: { means: "this Ardia keeps the ardia command away from a DevTools method; Ardia 0.2.49 or later allows it" },
  profile_busy: { means: "another command is saving or deleting that profile; try again when it's done" },
  ref_drifted: { means: "the ref now points at an element with another role or name, so nothing was done", remedy: "ardia browse snapshot -i" },
  session_busy: { means: "another command holds the session", remedy: "ardia browse session list" },
  session_limit: { means: "every automatic session is open and busy; close one or name a session", remedy: "ardia browse session list" },
  stale_ref: { means: "the ref belongs to an older snapshot or page", remedy: "ardia browse snapshot -i" },
  tab_crashed: { means: "the tab's page crashed", remedy: "ardia browse reload" },
  tab_detached: { means: "Ardia detached the tab", remedy: "ardia browse tab list" },
  tab_gone: { means: "the session's tab closed", remedy: "ardia browse tab list" },
  tab_in_use: { means: "another session uses that tab", remedy: "ardia browse tab list" },
  tab_not_found: { means: "no tab has that id or label", remedy: "ardia browse tab list" },
  timeout: { means: "the page or site didn't answer in time" },
  unknown_command: { means: "ardia browse has no such command; the message names the closest", remedy: "ardia browse --help" },
  unknown_ref: { means: "no element has that ref", remedy: "ardia browse snapshot -i" },
  unsupported: { means: "ardia browse doesn't do this; the message says what to use instead" },
  usage: { means: "the command's words or flags are wrong; the message names the closest flag", remedy: `ardia browse ${COMMAND_SLOT} --help` },
  usage_error: { means: "an option before the command is wrong", remedy: "ardia browse --help" },
  vocab_superseded: { means: "the ref comes from a snapshot a newer one replaced", remedy: "ardia browse snapshot -i" },
};

export const UNTAGGED_CODES: ReadonlySet<string> = new Set(["browse_error", "command_failed"]);

export const CLIENT_CODES: readonly string[] = [
  "answer_too_large", "daemon_timeout", "daemon_unreachable", "internal_error", "interrupted", "invalid_name", "nested_commands_refused",
  "plugin_daemon_unavailable", "plugin_refused", "socket_refused", "tab_out_of_scope", "unknown_command", "unsafe_path", "usage_error",
];

export const TAGGED_CODES: ReadonlySet<string> = new Set([...CODES, ...Object.keys(ERROR_CODES), ...CLIENT_CODES].filter((code) => !UNTAGGED_CODES.has(code)));

export function canonicalCommand(command: string | undefined): string | undefined {
  if (command === undefined || command === "") return undefined;
  const name = Object.hasOwn(ALIASES, command) ? (ALIASES[command] as string) : command;
  return KNOWN_COMMANDS.includes(name) ? name : undefined;
}

export function remedyFor(code: string | undefined, command?: string): string | undefined {
  if (code === undefined || !Object.hasOwn(ERROR_CODES, code)) return undefined;
  const template = (ERROR_CODES[code] as CodeHelp).remedy;
  if (template === undefined) return undefined;
  if (!template.includes(COMMAND_SLOT)) return template;
  const known = canonicalCommand(command);
  return known === undefined ? "ardia browse --help" : template.replaceAll(COMMAND_SLOT, known);
}

export function inferredCode(code: string | undefined, text: string): string | undefined {
  if (code !== undefined && code !== "" && !UNTAGGED_CODES.has(code)) return code;
  const message = text.replace(/^✗ /u, "");
  if (message.startsWith("Unknown command:")) return "unknown_command";
  if (message.startsWith("Unknown flag:") || message.startsWith("Usage:")) return "usage";
  return code === "" ? undefined : code;
}

export function tagged(message: string, code: string | undefined): string {
  if (code === undefined || !TAGGED_CODES.has(code)) return message;
  const tag = `(${code})`;
  const body = message.replace(/\s+$/u, "");
  if (body.endsWith(tag)) return message;
  return `${body} ${tag}${message.slice(body.length)}`;
}

export function remedyLine(remedy: string): string {
  return `  remedy: ${remedy}`;
}
