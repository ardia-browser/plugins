import { dumps, parseText, type Value } from "../../json.ts";
import { isSpace, strip } from "../../py.ts";
import { redact } from "../../redact.ts";
import { PY_SPACE_CLASS } from "../../pylib/re.ts";
import { codePoints } from "../../pystr.ts";
import { formatG, groupThousands } from "../../pylib/format.ts";
import { shlexQuote, shlexSplit } from "../../pylib/shlex.ts";
import { PyException, pyLen } from "../../pylib/str.ts";
import type { CdpResult } from "../cdp/browser.ts";
import { Cancelled, currentSignal, later, shield, sleep, withSignal } from "../cdp/cancel.ts";
import { Ctx } from "../commands/ctx.ts";
import { canonical, dispatch, OWNERS, register, SKIPPED } from "../commands/index.ts";
import { parse } from "../commands/parse.ts";
import { BrowseError, ConnectionLost, OutcomeUnknown, Usage } from "../daemon-errors.ts";
import { MUTATING } from "../daemon/names.ts";
import { safeCode } from "../codes.ts";
import { Result } from "../daemon/render.ts";
import { SCRIPT_CONTROLLER, SCRIPT_WORKER } from "../js/index.ts";
import { flag } from "../metrics.ts";
import { Page } from "../state/page.ts";
import { record } from "../state/records.ts";
import type { State } from "../state/state.ts";
import * as temptabs from "../state/temptabs.ts";
import { renderJson } from "./render.ts";
import { MAX_TIMEOUT, parseTimeout } from "./timeout.ts";

export { DEFAULT_TIMEOUT, MAX_TIMEOUT, parseTimeout } from "./timeout.ts";

export const READ_HINT_OPENS = 3;
export const MAX_SOURCE = 1024 * 1024;
export const STATE_LIMIT = 16 * 1024 * 1024;
export const LOG_LIMIT = 1024 * 1024;
export const CONTROL_TIMEOUT = 20.0;
export const SOURCE_URL = "ardia-script.js";
export const REFUSED = ["close", "script", "batch"];
export const FATAL = ["outcome_unknown", "connection_lost"];
export const TITLE = "ardia browse script";
export const READ_BATCH = 100;
export const STATE_PREVIEW_CHARS = 1500;
const PY_WHITESPACE = new RegExp(`[${PY_SPACE_CLASS}]+`, "u");
const PAGE_GLOBAL = /\b(document|window|localStorage|sessionStorage|getComputedStyle) is not defined/u;
const PAGE_MISSING = /ReferenceError: ([\p{L}\p{N}_]+) is not defined/u;

type Message = Record<string, unknown>;
type Answer = { ok: boolean; text?: string | null; data?: unknown; error?: string; code?: string | null };

export function controllerSource(): string {
  return SCRIPT_CONTROLLER.replace("%(log_limit)d", String(LOG_LIMIT)).replace("%(title)s", dumps(TITLE, "spaced"));
}

function workerApi(offset: number, state: string): string {
  return SCRIPT_WORKER.replace("%(offset)d", String(offset))
    .replace("%(read_batch)d", String(READ_BATCH))
    .replace("%(state_limit)d", String(STATE_LIMIT))
    .replace("%(state)s", () => state);
}

export function workerSource(source: string, state = "{}"): [string, number] {
  const offset = (workerApi(0, state).match(/\n/gu)?.length ?? 0) + 2;
  return [`${workerApi(offset, state)}\n__ardiaRun(async () => {\n${source}\n});\n//# sourceURL=${SOURCE_URL}`, offset];
}

export function sourceLine(source: string, wrappedLine: unknown): number | null {
  if (typeof wrappedLine !== "number") return null;
  const lines = (source.match(/\n/gu)?.length ?? 0) + 1;
  return Math.min(Math.max(wrappedLine, 1), lines);
}

export function showArgv(argv: unknown): string {
  return (Array.isArray(argv) ? argv : []).map((word) => shlexQuote(String(word))).join(" ");
}

function renderValue(message: Message): string | null {
  if (message["undefined"]) return null;
  const value = message["value"];
  if (typeof value === "string") return value;
  return renderJson(value);
}

export function tail(lines: string[], limit = 3000): string {
  const text = lines.join("\n");
  const points = codePoints(text);
  if (points.length <= limit) return text;
  return `… [${groupThousands(String(points.length - limit))} earlier characters]\n${points.slice(-limit).join("")}`;
}

export function pageWorldHint(text: string, command: unknown): string | null {
  if (Array.isArray(command) && command.length > 0) {
    const missing = command[0] === "eval" ? PAGE_MISSING.exec(text) : null;
    if (missing && !PAGE_GLOBAL.test(text)) {
      const name = missing[1] as string;
      return `page.evaluate(fn) runs fn inside the page, where the script's own variables don't exist: pass ${name} as its argument, page.evaluate((${name}) => …, ${name})`;
    }
    return null;
  }
  if (PAGE_GLOBAL.test(text)) {
    return "the script runs outside the page, so it has no document or window: put page code in page.evaluate(() => …), or use `ardia browse eval`";
  }
  return null;
}

export function failure(message: string, logs: string[], data: Record<string, unknown>, code: string | null = null): BrowseError {
  const shown = logs.map((line) => redact(line));
  let body = redact(message);
  if (shown.length > 0) body += `\nlogged before that:\n${tail(shown)}`;
  return new BrowseError(body, { ...data, logs: shown }, code || "script_failed");
}

async function openController(state: State, owned: string[]): Promise<Page> {
  const targetId = await temptabs.create(state, owned);
  const page = new Page(state, targetId);
  state.pages.set(targetId, page);
  await page.attach(state.browser as NonNullable<State["browser"]>);
  return page;
}

async function control(page: Page, handle: string, fn: string, args: unknown[] = [], timeout = CONTROL_TIMEOUT): Promise<unknown> {
  const result: CdpResult = await page.send(
    "Runtime.callFunctionOn",
    { objectId: handle, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true },
    { timeout },
  );
  if (Object.hasOwn(result, "exceptionDetails")) {
    const details = record(result["exceptionDetails"]);
    throw new BrowseError(`the script's controller failed: ${String(record(details["exception"])["description"] ?? details["text"] ?? "None")}`);
  }
  return record(result["result"])["value"];
}

async function install(page: Page): Promise<string> {
  let remote: unknown;
  try {
    remote = await page.call(`function () { return (${controllerSource()}); }`, [], { frame: page.mainFrame, byValue: false, timeout: CONTROL_TIMEOUT });
  } catch (error) {
    if (error instanceof BrowseError && error.code === "page_script_error") throw new BrowseError("couldn't start the script's controller page");
    throw error;
  }
  const handle = record(remote)["objectId"];
  if (typeof handle !== "string" || !handle) throw new BrowseError("couldn't start the script's controller page");
  return handle;
}

async function start(page: Page, handle: string, source: string, state = "{}"): Promise<void> {
  const [code, offset] = workerSource(source, state);
  await control(page, handle, "function (source, offset) { return this.start(source, offset); }", [code, offset]);
}

function knownCommand(word: string): boolean {
  const name = canonical(word);
  return name !== "auth" && Object.hasOwn(OWNERS, name);
}

export function splitCommandLine(argv: string[]): string[] {
  const only = argv[0] ?? "";
  if (argv.length !== 1 || !strip(only, isSpace) || only.split(PY_WHITESPACE).filter((word) => word)[0] === only) return argv;
  let words: string[];
  try {
    words = shlexSplit(only);
  } catch (error) {
    if (error instanceof PyException) return argv;
    throw error;
  }
  if (words.length === 0 || !knownCommand(words[0] as string)) return argv;
  flag("script_command_line_split", true);
  return words;
}

export async function runOne(ctx: Ctx, argv: string[]): Promise<[Result | null, BrowseError | null]> {
  if (argv.length === 0) return [null, new BrowseError("No command given")];
  const name = canonical(argv[0] as string);
  const sub = new Ctx(ctx.state, { ...ctx.options }, ctx.cwd, ctx.env, ctx.stdin, name);
  try {
    return [await dispatch(sub, name, argv.slice(1)), null];
  } catch (error) {
    if (error instanceof BrowseError) return [null, error];
    throw error;
  }
}

function jsonCopy(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null, (_, item: unknown) => (typeof item === "bigint" ? item.toString() : item)));
}

const SETTINGS = new Set(["viewport", "device", "geo", "geolocation", "offline", "headers", "credentials", "auth", "media", "permission", "permissions"]);

export function commandName(argv: unknown): string {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((word) => typeof word === "string")) return "unknown command";
  const words = splitCommandLine(argv as string[]);
  const name = canonical(words[0] as string);
  if (!knownCommand(name)) return "unknown command";
  if (name === "set" && SETTINGS.has(words[1] ?? "")) return `set ${canonical(words[1] as string)}`;
  return name;
}

export function callLabel(index: number, argv: unknown): string {
  return `call ${index}, \`${commandName(argv)}\``;
}

export function scriptCode(code: unknown): string {
  return typeof code === "string" ? (safeCode(code, "script_failed") ?? "script_failed") : "script_failed";
}

function callIndex(calls: readonly unknown[][], command: unknown): number | null {
  const wanted = JSON.stringify(command);
  for (let index = calls.length - 1; index >= 0; index -= 1) if (JSON.stringify(calls[index]) === wanted) return index + 1;
  return null;
}

export function errorText(message: Message, source: string, calls: readonly unknown[][]): string {
  const line = sourceLine(source, message["line"]);
  let text = String(message["message"] || "error");
  const name = message["name"];
  if (name && name !== "Error" && !text.startsWith(String(name))) text = `${String(name)}: ${text}`;
  const where = line ? `line ${line}: ` : "";
  const failed = message["command"];
  let command = "";
  if (Array.isArray(failed) && failed.length > 0) {
    const index = callIndex(calls, failed);
    command = index === null ? ` (in \`${commandName(failed)}\`)` : ` (in ${callLabel(index, failed)})`;
  }
  return `${where}${text}${command}`;
}

export function failureData(message: Message, calls: readonly unknown[][]): Record<string, unknown> {
  const failed = message["command"];
  const named = Array.isArray(failed) && failed.length > 0;
  return { line: null, call: named ? callIndex(calls, failed) : null, command: named ? commandName(failed) : null };
}

export const UNPARSED_CALL = "that call couldn't be parsed";
export const UNKNOWN_CALL = "unknown command";

export function refusedCall(given: unknown): Answer | null {
  if (!Array.isArray(given) || given.length === 0 || !given.every((word) => typeof word === "string")) {
    return { ok: false, error: "browse() takes a command and its arguments as strings", code: "usage" };
  }
  const argv = splitCommandLine(given as string[]);
  if (argv.length === 1 && /\s/u.test(argv[0] as string)) return { ok: false, error: UNPARSED_CALL, code: "usage" };
  const name = canonical(argv[0] as string);
  if (name === "batch") return { ok: false, error: "batch can't run inside a script; loop in the script instead", code: "usage" };
  if (REFUSED.includes(name)) return { ok: false, error: `${name} can't run inside a script`, code: "usage" };
  if (!Object.hasOwn(OWNERS, name) && !Object.hasOwn(SKIPPED, name)) return { ok: false, error: UNKNOWN_CALL, code: "usage" };
  return null;
}

async function answerCall(ctx: Ctx, given: unknown, index: number): Promise<Answer> {
  const refused = refusedCall(given);
  if (refused !== null) return refused;
  const argv = splitCommandLine(given as string[]);
  const name = canonical(argv[0] as string);
  const sub = new Ctx(ctx.state, { ...ctx.options }, ctx.cwd, ctx.env, null, name);
  ctx.state.scriptsRunning += 1;
  let ran: Awaited<ReturnType<typeof runOne>>;
  try {
    ran = await runOne(sub, argv);
  } finally {
    ctx.state.scriptsRunning -= 1;
  }
  const [result, error] = ran;
  if (error instanceof OutcomeUnknown || error instanceof ConnectionLost) throw error;
  if (error !== null) return { ok: false, error: error.text, code: error.code ?? null };
  const done = result as Result;
  const outcomes = Array.isArray(done.batch) ? (done.batch as Record<string, unknown>[]) : [];
  const fatal = outcomes.find((outcome) => FATAL.includes(String(outcome?.["code"])));
  if (fatal !== undefined) throw new OutcomeUnknown(callLabel(index, argv), String(fatal["error"] || "a command inside it was cut off"));
  if (done.failed && name !== "read") return { ok: false, error: done.text || `${name} failed`, code: "failed" };
  return { ok: true, text: done.text, data: jsonCopy(done.data) };
}

async function drive(ctx: Ctx, page: Page, handle: string, source: string, current: Map<string, unknown>, done: string[], calls: unknown[][]): Promise<Message> {
  await start(page, handle, source, ctx.state.scriptState);
  for (;;) {
    const message = record(await control(page, handle, "function () { return this.next(); }", [], MAX_TIMEOUT + 30));
    if (message["kind"] !== "request") return message;
    const argv = message["argv"];
    if (Array.isArray(argv) && argv.every((word) => typeof word === "string")) message["argv"] = splitCommandLine(argv as string[]);
    current.clear();
    for (const [key, value] of Object.entries(message)) current.set(key, value);
    let answer: Answer;
    if (message["type"] === "sleep") {
      await sleep(Math.max(Number(message["ms"]) || 0, 0) / 1000);
      answer = { ok: true, text: "", data: {} };
    } else {
      if (message["via"] === "page.eval") flag("script_eval_alias", true);
      calls.push(Array.isArray(argv) ? [...(argv as unknown[])] : []);
      current.set("call", calls.length);
      answer = await answerCall(ctx, message["argv"], calls.length);
      done.push(commandName(argv));
    }
    current.clear();
    await control(page, handle, "function (id, answer) { return this.reply(id, answer); }", [message["id"], answer]);
  }
}

export function keptPreview(stateText: unknown): string {
  if (typeof stateText !== "string" || !stateText.trim() || stateText.trim() === "{}") return "";
  const points = codePoints(stateText);
  if (points.length <= STATE_PREVIEW_CHARS) return stateText;
  return `${points.slice(0, STATE_PREVIEW_CHARS).join("")}… (${groupThousands(String(points.length))} characters in all; \`ardia browse script 'return state' --out <file>\` saves it)`;
}

function timedOut(seconds: number, current: Map<string, unknown>, source: string, logs: string[], kept: string, done: string[], stateText: unknown): BrowseError {
  let where = "";
  const argv = current.get("argv");
  const call = typeof current.get("call") === "number" ? (current.get("call") as number) : null;
  if (Array.isArray(argv) && argv.length > 0) where = call === null ? `, in \`${commandName(argv)}\`` : `, in ${callLabel(call, argv)}`;
  else if (current.get("type") === "sleep") where = ", in sleep()";
  const line = sourceLine(source, current.get("line"));
  if (line) where += ` at line ${line}`;
  const first = Array.isArray(argv) && argv.length > 0 ? String(argv[0]) : "";
  const name = canonical(first);
  const unknown = MUTATING.has(name) ? "; that command was cut off, so its outcome is unknown" : "";
  let message = `The script timed out after ${formatG(seconds)}s${where}${unknown}. Give it longer with --timeout 3m (at most 10m), or do less per run`;
  if (kept) {
    message += `. What it kept in state survives for the next script: ${kept}`;
    const preview = keptPreview(stateText);
    if (preview) {
      flag("script_timeout_state_shown", true);
      message += `. So far: ${preview}`;
    }
  } else {
    message +=
      ". Nothing it gathered was kept: push results into `state` as you go (state.rows = [...state.rows || [], row]) so the next run picks up where this one stopped";
  }
  const opened = done.filter((word) => canonical(word) === "open").length + (name === "open" ? 1 : 0);
  if (opened >= READ_HINT_OPENS) {
    flag("script_timeout_read_hint", true);
    message +=
      `. It opened ${opened} pages one after another; to take text from many pages, ` +
      "`ardia browse read <url> <url> …` (or `await read(urls)` here) loads them side by side, each with its own time limit";
  }
  return failure(message, logs, { line, call, command: Array.isArray(argv) && argv.length > 0 ? commandName(argv) : null }, "timeout");
}

async function stopWorker(page: Page, handle: string): Promise<Message> {
  try {
    return record(await control(page, handle, "function () { return this.stop(); }", [], CONTROL_TIMEOUT));
  } catch (error) {
    if (error instanceof BrowseError) return {};
    throw error;
  }
}

function truthyValue(value: Value): boolean {
  if (value === null || value === false || value === "" || value === 0n) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map) return value.size > 0;
  if (typeof value === "object" && "value" in value) return value.value !== 0;
  return true;
}

export function stateSummary(value: Value): string {
  if (!(value instanceof Map)) return "state holds a value";
  const parts = [...value].slice(0, 8).map(([key, item]) => (Array.isArray(item) ? `state.${key} (${item.length} items)` : item instanceof Map ? `state.${key} (${item.size} items)` : `state.${key}`));
  return parts.join(", ") + (value.size > 8 ? ", …" : "");
}

export function keepState(state: State, text: unknown): string {
  if (typeof text !== "string") return "";
  const value = parseText(text);
  if (value === undefined) return "";
  state.scriptState = text;
  if (!truthyValue(value)) return "";
  flag("script_state_kept", true);
  return stateSummary(value);
}

async function withDeadline<T>(seconds: number, run: () => Promise<T>): Promise<{ value: T } | { timedOut: true }> {
  const outer = currentSignal();
  const timer = new AbortController();
  const signal = outer === null ? timer.signal : AbortSignal.any([outer, timer.signal]);
  const stop = later(seconds * 1000, () => timer.abort(new Cancelled()));
  try {
    return { value: await withSignal(signal, run) };
  } catch (error) {
    if (timer.signal.aborted && !outer?.aborted && error instanceof Cancelled) return { timedOut: true };
    throw error;
  } finally {
    stop();
  }
}

export async function run(ctx: Ctx, source: string, seconds: number): Promise<Result> {
  if (!strip(source, isSpace)) throw new Usage("Usage: ardia browse script [file.js] (or the script on stdin: ardia browse script <<'EOF' … EOF)");
  if (pyLen(source) > MAX_SOURCE) throw new Usage(`The script is over ${Math.floor(MAX_SOURCE / 1024)} KB`);
  const state = ctx.state;
  await state.connect();
  await temptabs.sweep(state);
  const current = new Map<string, unknown>();
  const done: string[] = [];
  const calls: unknown[][] = [];
  const owned: string[] = [];
  let message: Message;
  try {
    const page = await openController(state, owned);
    const handle = await install(page);
    let outcome: { value: Message } | { timedOut: true };
    try {
      outcome = await withDeadline(seconds, () => drive(ctx, page, handle, source, current, done, calls));
    } catch (error) {
      if (error instanceof Cancelled) {
        const stopped = await shield(() => stopWorker(page, handle));
        if (keepState(state, stopped["state"])) flag("script_state_kept_on_interrupt", true);
      }
      throw error;
    }
    if ("timedOut" in outcome) {
      const stopped = await stopWorker(page, handle);
      const kept = keepState(state, stopped["state"]);
      const logs = Array.isArray(stopped["logs"]) ? stopped["logs"].map(String) : [];
      throw timedOut(seconds, current, source, logs, kept, done, stopped["state"]);
    }
    message = outcome.value;
  } finally {
    await temptabs.release(state, owned);
  }
  keepState(state, message["state"]);
  const logs = Array.isArray(message["logs"]) ? message["logs"].map(String) : [];
  if (message["logsDropped"]) logs.push(`[${String(message["logsDropped"])} more log lines dropped past ${Math.floor(LOG_LIMIT / 1024)} KB]`);
  const notes: string[] = [];
  const unawaited = Number(message["unawaited"]) || 0;
  if (unawaited) notes.push(`[${unawaited} command${unawaited !== 1 ? "s" : ""} the script didn't await never ran]`);
  if (message["kind"] === "error") {
    const line = sourceLine(source, message["line"]);
    const failed = message["command"];
    let hint = pageWorldHint(String(message["message"] || "error"), failed);
    if (hint) flag("script_page_world_hint", true);
    hint = hint ? `\n${hint}` : "";
    throw failure(`${errorText(message, source, calls)}${hint}`, [...logs, ...notes], { ...failureData(message, calls), line }, scriptCode(message["code"]));
  }
  const value = renderValue(message);
  const parts = [...logs, ...(value !== null ? [value] : []), ...notes];
  return new Result({ value: message["undefined"] ? null : (message["value"] ?? null), logs }, parts.length > 0 ? parts.join("\n") : "✓ Done", true);
}

export async function cmdScript(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options] = parse(argv, { "--timeout": "value", "--stdin": "bool" });
  return run(ctx, ctx.stdin || "", parseTimeout(options["timeout"] as string | undefined));
}

register("script", cmdScript);
