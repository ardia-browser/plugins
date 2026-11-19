import { dumps, parseText, type Value } from "../json.ts";
import { exitOf } from "./answer.ts";
import { PythonCrash } from "./errors.ts";
import { ANSWER_JSON_DEPTH } from "./serve.ts";

const ENGINE_CODES = ["tab_out_of_scope", "document_changed"];
const OVERRIDABLE = ["policy_refused", "command_failed"];
export const DOCUMENT_CHANGED = "document_changed";
const DAEMON_DOCUMENT_CHANGED = "The page loaded a new document, so this step didn't count. Ardia checks it again for the next step";
export const HONEST_DOCUMENT_CHANGED = "The page loaded a new document before, during or after this step, so it may or may not have run; check the page before repeating it. Ardia checks it again for the next step";

export function engineCode(error: string): string | undefined {
  return ENGINE_CODES.find((code) => error.startsWith(`ardia: ${code}`) || error.includes(`: ardia: ${code}`) || error.includes(` ardia: ${code}`));
}

export function honestText(err: Value | undefined): Value | undefined {
  return err === `✗ ${DAEMON_DOCUMENT_CHANGED}\n` ? `✗ ${HONEST_DOCUMENT_CHANGED}\n` : err;
}

export function codedLine(out: Value | undefined, exit: Value | undefined): Value | undefined {
  const status = exitOf(exit);
  if (typeof out !== "string" || status instanceof PythonCrash || status === 0n || !out.endsWith("\n") || out.indexOf("\n") !== out.length - 1) return out;
  let parsed: Value | undefined;
  try {
    parsed = parseText(out.slice(0, -1), ANSWER_JSON_DEPTH);
  } catch {
    return out;
  }
  if (!(parsed instanceof Map) || parsed.get("success") !== false) return out;
  const error = parsed.get("error");
  const given = parsed.get("code");
  const engine = typeof error === "string" ? engineCode(error) : undefined;
  if (given === DOCUMENT_CHANGED && error === DAEMON_DOCUMENT_CHANGED) parsed.set("error", HONEST_DOCUMENT_CHANGED);
  else if (engine !== undefined && (given === undefined || OVERRIDABLE.includes(given as string))) parsed.set("code", engine);
  else if (parsed.has("code")) return out;
  else parsed.set("code", typeof error === "string" && error.startsWith("Unknown command:") ? "unknown_command" : "command_failed");
  return `${dumps(parsed, "compact")}\n`;
}
