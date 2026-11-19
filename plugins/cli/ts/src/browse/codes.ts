import { dumps, object, parseText, type Value } from "../json.ts";
import { exitOf } from "./answer.ts";
import { PythonCrash } from "./errors.ts";
import { ANSWER_JSON_DEPTH } from "./serve.ts";

export const DOCUMENT_CHANGED = "document_changed";
const DAEMON_DOCUMENT_CHANGED = "The page loaded a new document, so this step didn't count. Ardia checks it again for the next step";
export const HONEST_DOCUMENT_CHANGED = "The page loaded a new document before, during or after this step, so it may or may not have run; check the page before repeating it. Ardia checks it again for the next step";

const DAEMON_LINE = `✗ ${DAEMON_DOCUMENT_CHANGED}`;

export function honestText(err: Value | undefined): Value | undefined {
  if (typeof err !== "string" || !err.includes(DAEMON_LINE)) return err;
  return err
    .split("\n")
    .map((line) => (line === DAEMON_LINE ? `✗ ${HONEST_DOCUMENT_CHANGED}` : line))
    .join("\n");
}

const INTERNAL_ERROR = "internal_error";
const TEXT_ERROR = "✗ ";

function errorLine(error: string): string {
  return `${dumps(object([["success", false], ["data", null], ["error", error], ["code", INTERNAL_ERROR]]), "compact")}\n`;
}

function parsedLine(out: string): Value | undefined {
  if (!out.endsWith("\n") || out.indexOf("\n") !== out.length - 1) return undefined;
  try {
    return parseText(out.slice(0, -1), ANSWER_JSON_DEPTH);
  } catch {
    return undefined;
  }
}

function codedObject(parsed: Map<string, Value>): string | undefined {
  if (parsed.get("success") !== false) return undefined;
  const error = parsed.get("error");
  const given = parsed.get("code");
  if (given === DOCUMENT_CHANGED && error === DAEMON_DOCUMENT_CHANGED) parsed.set("error", HONEST_DOCUMENT_CHANGED);
  else if (typeof given === "string" && given !== "") return undefined;
  else if (parsed.has("code")) parsed.set("code", INTERNAL_ERROR);
  else parsed.set("code", typeof error === "string" && error.startsWith("Unknown command:") ? "unknown_command" : "command_failed");
  return `${dumps(parsed, "compact")}\n`;
}

export function codeJsonAnswer(answer: Map<string, Value>): void {
  const status = exitOf(answer.get("exit"));
  if (status instanceof PythonCrash || status === 0n) return;
  const given = answer.get("out");
  const out = typeof given === "string" ? given : "";
  const parsed = parsedLine(out);
  if (parsed instanceof Map) {
    const coded = codedObject(parsed);
    if (coded !== undefined) answer.set("out", coded);
    return;
  }
  if (parsed !== undefined) return;
  if (out.trim() !== "") {
    answer.set("out", errorLine(out.trim()));
    return;
  }
  const errGiven = answer.get("err");
  const err = typeof errGiven === "string" ? errGiven : "";
  const lines = err.split("\n");
  const failures = lines.filter((line) => line.startsWith(TEXT_ERROR));
  if (failures.length > 0) {
    answer.set("err", lines.filter((line) => !line.startsWith(TEXT_ERROR)).join("\n"));
    answer.set("out", errorLine(failures.map((line) => line.slice(TEXT_ERROR.length)).join("\n")));
    return;
  }
  answer.set("out", errorLine(`the ardia browse daemon answered with exit status ${status} and no output`));
}
