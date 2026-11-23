import { dumps, object, parseText, type Value } from "../json.ts";
import { exitOf } from "./answer.ts";
import { ALIASES } from "./tables.ts";
import { PythonCrash } from "./errors.ts";
import { ANSWER_JSON_DEPTH } from "./serve.ts";

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
  if (typeof given === "string" && given !== "") return undefined;
  else if (parsed.has("code")) parsed.set("code", INTERNAL_ERROR);
  else parsed.set("code", typeof error === "string" && error.startsWith("Unknown command:") ? "unknown_command" : "command_failed");
  return `${dumps(parsed, "compact")}\n`;
}

function pagesPayload(data: Value | undefined): boolean {
  return data instanceof Map && Array.isArray(data.get("pages"));
}

function codedRows(rows: Value[]): boolean {
  let changed = false;
  for (const row of rows) {
    if (!(row instanceof Map) || row.get("success") !== false) continue;
    const code = row.get("code");
    if (typeof code === "string" && code !== "") continue;
    row.set("code", INTERNAL_ERROR);
    changed = true;
  }
  return changed;
}

export function codeJsonAnswer(answer: Map<string, Value>, command: string): void {
  const status = exitOf(answer.get("exit"));
  if (status instanceof PythonCrash || status === 0n) return;
  const given = answer.get("out");
  const out = typeof given === "string" ? given : "";
  const parsed = parsedLine(out);
  if (Array.isArray(parsed) && (ALIASES[command] ?? command) === "batch") {
    if (codedRows(parsed)) answer.set("out", `${dumps(parsed, "compact")}\n`);
    return;
  }
  if (parsed instanceof Map && parsed.get("success") === false) {
    const coded = codedObject(parsed);
    if (coded !== undefined) answer.set("out", coded);
    return;
  }
  if ((ALIASES[command] ?? command) === "read" && parsed instanceof Map && parsed.get("success") === true && pagesPayload(parsed.get("data"))) return;
  if (parsed !== undefined) {
    answer.set("out", errorLine(out.trim()));
    return;
  }
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
