import { type JsonObject, type Value } from "../json.ts";
import { loads } from "../pyjson.ts";
import { pyStrip } from "../pylib/str.ts";
import type { Secrets } from "../redact.ts";
import type { Call } from "../telemetry.ts";
import { cleanMetrics, exitOf, outputChars, textOf } from "./answer.ts";
import { PythonCrash } from "./errors.ts";
import { AS_TEXT, BodyDamaged, content, isJsonText, save, savedBody, savedBodyLine, savedLine, savedSummary, savesAsCsv, writeFailure } from "./outfile.ts";
import type { Printer } from "./output.ts";

type Outcome = { status: number | bigint; crash?: PythonCrash | undefined };

function stream(answer: JsonObject, key: string, secrets: Secrets): string | PythonCrash {
  const text = textOf(answer.get(key), secrets.known());
  if (text instanceof PythonCrash) return text;
  return text === "" ? "" : secrets.redact(text);
}

export function textForFile(path: string, out: string): string {
  if (!path.toLowerCase().endsWith(".json")) return out;
  const body = out.endsWith("\n") ? out.slice(0, -1) : out;
  return isJsonText(body) ? out : `${JSON.stringify(body)}\n`;
}

function saveTo(path: string, text: string, printer: Printer): string | null {
  try {
    return save(path, text);
  } catch (error) {
    printer.err(`✗ Couldn't write ${path}: ${writeFailure(error)}. The command ran; its output follows.\n`);
    printer.out(text);
    return null;
  }
}

function saveBody(path: string, body: Uint8Array, out: string, printer: Printer, call: Call, exit: number | bigint): Outcome {
  let target: string;
  try {
    target = save(path, body);
  } catch (error) {
    printer.err(`✗ Couldn't write ${path}: ${writeFailure(error)}\n`);
    return { status: 1 };
  }
  call.metrics.set("saved_to_file", true);
  call.metrics.set("read_binary_saved", true);
  let data: JsonObject = new Map();
  try {
    const payload = loads(out);
    const given = payload instanceof Map ? payload.get("data") : undefined;
    if (given instanceof Map) data = given;
  } catch {}
  printer.out(savedBodyLine(target, body, data));
  return { status: exit };
}

export function saveAnswer(answer: JsonObject, secrets: Secrets, printer: Printer, call: Call, command: string, path: string): Outcome {
  const code = answer.get("code");
  if (typeof code === "string") call.noteErrorCode(code);
  for (const [key, value] of cleanMetrics(answer.get("metrics"))) call.metrics.set(key, value);
  call.metrics.set("output_chars", outputChars(answer));
  const out = stream(answer, "out", secrets);
  if (out instanceof PythonCrash) return { status: 1, crash: out };
  const err = stream(answer, "err", secrets);
  if (err instanceof PythonCrash) return { status: 1, crash: err };
  const exit = exitOf(answer.get("exit"));
  if (exit instanceof PythonCrash) return { status: 1, crash: exit };
  printer.err(err);
  if (AS_TEXT.includes(command)) {
    if (exit) {
      printer.out(out);
      return { status: exit };
    }
    const target = saveTo(path, textForFile(path, out), printer);
    if (target === null) return { status: 1 };
    call.metrics.set("saved_to_file", true);
    printer.out(savedLine(target, out));
    return { status: exit };
  }
  let body: Uint8Array | null;
  try {
    body = savedBody(command, answer);
  } catch (error) {
    if (!(error instanceof BodyDamaged)) throw error;
    printer.err(`✗ The response body didn't arrive whole, so ${path} wasn't written; run the command again\n`);
    return { status: 1 };
  }
  if (body !== null) return saveBody(path, body, out, printer, call, exit);
  let payload: Value;
  try {
    payload = loads(out);
  } catch {
    printer.out(out);
    return { status: exit };
  }
  if (!(payload instanceof Map) || payload.get("success") !== true) {
    const message = payload instanceof Map ? payload.get("error") : null;
    printer.err(`✗ ${typeof message === "string" && message ? message : "the command failed"}\n`);
    return { status: exit || 1 };
  }
  const given = payload.get("data");
  const data: JsonObject = given instanceof Map ? given : new Map();
  const [text, summary] = content(command, data, path);
  if (savesAsCsv(command, data, path)) call.metrics.set("saved_as_csv", true);
  if (!pyStrip(text)) {
    printer.err(`✗ ${command} returned nothing to save, so ${path} wasn't written\n`);
    return { status: 1 };
  }
  const target = saveTo(path, text, printer);
  if (target === null) return { status: 1 };
  call.metrics.set("saved_to_file", true);
  printer.out(savedSummary(target, text, summary, data.get("logs")));
  return { status: exit };
}
