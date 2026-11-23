import { parseText, type Value } from "../../json.ts";
import { isSpace, strip } from "../../py.ts";
import { redact } from "../../redact.ts";
import { PY_SPACE_CLASS } from "../../pylib/re.ts";
import { codePoints } from "../../pystr.ts";
import { formatG, groupThousands } from "../../pylib/format.ts";
import { shlexQuote, shlexSplit } from "../../pylib/shlex.ts";
import { PyException, pyLen } from "../../pylib/str.ts";
import { Cancelled, currentSignal, later, sleep, untilCancelled, withSignal } from "../cdp/cancel.ts";
import { Ctx } from "../commands/ctx.ts";
import { canonical, dispatch, OWNERS, register, SKIPPED } from "../commands/index.ts";
import { parse } from "../commands/parse.ts";
import { BrowseError, ConnectionLost, OutcomeUnknown, Usage } from "../daemon-errors.ts";
import { MUTATING } from "../daemon/names.ts";
import { safeCode } from "../codes.ts";
import { Result } from "../daemon/render.ts";
import { add, count, flag } from "../metrics.ts";
import { record } from "../state/records.ts";
import type { State } from "../state/state.ts";
import { Dropped, Gate, MEMORY_LIMIT, type Runner, type RunnerEvent, takeRunner, whenReady } from "./host.ts";
import { ArgumentsTooDeep, evaluateExpression, frameFunction, framesAnswer, selectorExpression, validEvaluate } from "./page-calls.ts";
import { renderJson } from "./render.ts";
import { MAX_TIMEOUT, parseTimeout } from "./timeout.ts";
import { EVAL_TIMEOUT } from "../commands/pagejs.ts";
import { hasPendingReaction, reactionWaits, settleReaction } from "../changes/observe.ts";

export { DEFAULT_TIMEOUT, MAX_TIMEOUT, parseTimeout } from "./timeout.ts";
export { SOURCE_URL } from "./runner.ts";

export const READ_HINT_OPENS = 3;
export const MAX_SOURCE = 1024 * 1024;
export const STATE_LIMIT = 16 * 1024 * 1024;
export const LOG_LIMIT = 1024 * 1024;
export const REFUSED = ["close", "script", "batch"];
export const FATAL = ["outcome_unknown", "connection_lost"];
export const READ_BATCH = 100;
export const STATE_PREVIEW_CHARS = 1500;
export const CONCURRENT_CALLS: ReadonlySet<string> = new Set(["get", "is", "read"]);
export const MAX_PENDING = 1000;
export const MAX_CALLS = 200_000;
export const RESULT_LIMIT = 64 * 1024 * 1024;
export const REQUEST_LIMIT = 16 * 1024 * 1024 + 64 * 1024;
export const IN_FLIGHT_BYTES = 64 * 1024 * 1024;
export const LIGHT_CALLS: ReadonlySet<string> = new Set(["click", "dblclick", "fill", "type", "press", "keyboard", "select", "check", "uncheck", "hover", "focus", "scroll"]);
const PY_WHITESPACE = new RegExp(`[${PY_SPACE_CLASS}]+`, "u");
const PAGE_GLOBAL = /\b(document|window|localStorage|sessionStorage|getComputedStyle) is not defined/u;
const PAGE_MISSING = /ReferenceError: ([\p{L}\p{N}_]+) is not defined/u;

type Message = Record<string, unknown>;
type Answer = { ok: boolean; text?: string | null; data?: unknown; error?: string; code?: string | null; call?: number };

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

const SANDBOX_MISSING = /\b(require|process|fetch|Bun|Deno|XMLHttpRequest|WebSocket|Worker|module|exports|__dirname|Buffer) is not defined/u;

export function sandboxHint(text: string, command: unknown): string | null {
  if (Array.isArray(command) && command.length > 0) return null;
  const missing = SANDBOX_MISSING.exec(text);
  if (!missing) return null;
  return `${missing[1] as string} isn't here: a script runs in a sandbox with no modules, files or network. Load pages through the browser with read(urls) or page.goto(url), and return the data (--out <file> saves it)`;
}

export function failure(message: string, logs: string[], data: Record<string, unknown>, code: string | null = null): BrowseError {
  const shown = logs.map((line) => redact(line));
  let body = redact(message);
  if (shown.length > 0) body += `\nlogged before that:\n${tail(shown)}`;
  return new BrowseError(body, { ...data, logs: shown }, code || "script_failed");
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

function callIndex(calls: readonly unknown[][], command: unknown, given: unknown = null): number | null {
  if (typeof given === "number" && Number.isInteger(given) && given >= 1 && given <= calls.length) return given;
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
    const index = callIndex(calls, failed, message["call"]);
    command = index === null ? ` (in \`${commandName(failed)}\`)` : ` (in ${callLabel(index, failed)})`;
  }
  return `${where}${text}${command}`;
}

export function failureData(message: Message, calls: readonly unknown[][]): Record<string, unknown> {
  const failed = message["command"];
  const named = Array.isArray(failed) && failed.length > 0;
  return { line: null, call: named ? callIndex(calls, failed, message["call"]) : null, command: named ? commandName(failed) : null };
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

async function answerCall(ctx: Ctx, argv: string[], index: number, light: boolean): Promise<Answer> {
  const name = canonical(argv[0] as string);
  const options = light ? { ...ctx.options, settle_only: true } : { ...ctx.options };
  const sub = new Ctx(ctx.state, options, ctx.cwd, ctx.env, null, name);
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

type Tracked = { argv: unknown; call: number | null; line: unknown; type: string };
type Request = Record<string, unknown> & { id: number; op: string };

function fatalError(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof Dropped || error instanceof Cancelled) return false;
  return error instanceof OutcomeUnknown || error instanceof ConnectionLost || !(error instanceof BrowseError);
}

function pageFailure(error: unknown, index: number): Answer {
  if (fatalError(error) || !(error instanceof BrowseError)) throw error;
  return { ok: false, error: error.text, code: error.code ?? null, call: index };
}

class ScriptRun {
  readonly gate = new Gate();
  readonly calls: unknown[][] = [];
  readonly done: string[] = [];
  readonly inflight = new Map<number, Tracked>();
  readonly running = new Set<Promise<void>>();
  readonly logs: string[] = [];
  logSize = 0;
  logsDropped = 0;
  stateText: string | null = null;
  receiptsSkipped = 0;
  inflightBytes = 0;
  error: Error | null = null;
  readonly stop = new AbortController();
  readonly controls = new Map<number, AbortController>();
  readonly mutating = new Set<number>();
  readonly started = new Set<number>();
  private ended = false;
  private settling: Promise<void> | null = null;

  constructor(readonly ctx: Ctx, readonly runner: Runner) {}

  fail(error: Error): void {
    if (this.error !== null) return;
    this.error = error;
    this.gate.close();
    this.stop.abort(new Cancelled());
    this.runner.inject({ type: "fatal", error });
  }

  async drain(): Promise<void> {
    this.gate.close();
    if (!this.ended && this.running.size > 0) this.stop.abort(new Cancelled());
    await Promise.allSettled([...this.running]);
  }

  async admitted<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (fatalError(error)) this.fail(error as Error);
      throw error;
    }
  }

  stopRunning(): number {
    this.ended = true;
    this.gate.close();
    let cut = 0;
    for (const [id, control] of this.controls) {
      if (this.mutating.has(id)) continue;
      control.abort(new Cancelled());
      if (this.started.has(id)) cut += 1;
    }
    return cut;
  }

  keep(line: string): void {
    if (this.logSize + line.length > LOG_LIMIT) {
      this.logsDropped += 1;
      return;
    }
    this.logs.push(line);
    this.logSize += line.length + 1;
  }

  current(): Map<string, unknown> {
    const first = [...this.inflight.values()].sort((a, b) => (a.call ?? Infinity) - (b.call ?? Infinity))[0];
    const current = new Map<string, unknown>();
    if (first === undefined) return current;
    if (first.type === "sleep") current.set("type", "sleep");
    else current.set("argv", first.argv);
    if (first.call !== null) current.set("call", first.call);
    current.set("line", first.line);
    return current;
  }

  async settle(name: string, args: readonly string[]): Promise<void> {
    if (this.settling !== null) {
      await this.settling;
      return;
    }
    if (!hasPendingReaction(this.ctx.state) || !reactionWaits(name, args)) return;
    this.settling ??= settleReaction(this.ctx.state, name, args).finally(() => {
      this.settling = null;
    });
    await this.settling;
  }

  reply(id: number, answer: Answer): void {
    this.runner.send({ type: "reply", id, answer: JSON.stringify(answer) });
  }
}

function parseRequest(text: unknown): Request | null {
  if (typeof text !== "string" || text.length > REQUEST_LIMIT) return null;
  let given: unknown;
  try {
    given = JSON.parse(text);
  } catch {
    return null;
  }
  if (given === null || typeof given !== "object" || Array.isArray(given)) return null;
  const request = given as Record<string, unknown>;
  const id = request["id"];
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || typeof request["op"] !== "string") return null;
  return request as Request;
}

async function serveCall(run: ScriptRun, request: Request): Promise<Answer> {
  const given = request["argv"];
  run.calls.push([commandName(given)]);
  const index = run.calls.length;
  const argv = Array.isArray(given) && given.every((word) => typeof word === "string") ? splitCommandLine(given as string[]) : given;
  run.inflight.set(request.id, { argv, call: index, line: request["line"], type: "call" });
  const refused = refusedCall(given);
  if (refused !== null) return { ...refused, call: index };
  const words = argv as string[];
  const name = canonical(words[0] as string);
  if (request["via"] === "page.eval") flag("script_eval_alias", true);
  const exclusive = !CONCURRENT_CALLS.has(name) || words.some((word) => word === "--scroll" || word.startsWith("--scroll="));
  const light = request["light"] === true && request["receipt"] !== true && LIGHT_CALLS.has(name);
  if (light) run.receiptsSkipped += 1;
  try {
    const answer = await run.gate.run(exclusive, () => run.admitted(async () => {
      run.started.add(request.id);
      if (exclusive) run.mutating.add(request.id);
      if (!exclusive) await run.settle(name, words.slice(1));
      return answerCall(run.ctx, words, index, light);
    }));
    return answer.ok ? answer : { ...answer, call: index };
  } finally {
    run.done.push(commandName(given));
  }
}

async function servePage(run: ScriptRun, request: Request): Promise<Answer> {
  run.calls.push(["eval"]);
  const index = run.calls.length;
  run.inflight.set(request.id, { argv: ["eval"], call: index, line: request["line"], type: "call" });
  const op = request.op;
  if (op === "evaluate" && Array.isArray(request["args"]) && request["args"].length > 1) flag("script_eval_args", true);
  if (op === "$eval" || op === "$$eval") flag("script_selector_eval", true);
  if (request["via"] === "page.eval") flag("script_eval_alias", true);
  const frame = typeof request["frame"] === "string" && request["frame"] ? request["frame"] : null;
  try {
    return await run.gate.run(false, () => run.admitted(async () => {
      run.started.add(request.id);
      await run.settle("eval", []);
      const invalid = op === "frames" ? null : validEvaluate(request);
      if (invalid !== null) return { ok: false, error: invalid, code: "usage", call: index };
      try {
        if (op === "frames") {
          flag("script_frames_listed", true);
          return { ok: true, text: "", data: await framesAnswer(await run.ctx.state.page()) };
        }
        if (frame !== null) {
          flag("script_frame_eval", true);
          const page = await run.ctx.state.page();
          const [declaration, args] = frameFunction(request);
          return { ok: true, text: "", data: { result: jsonCopy(await page.call(declaration, args, { frame, read: false, timeout: EVAL_TIMEOUT })) } };
        }
        const expression = op === "evaluate" ? evaluateExpression(request) : selectorExpression(request);
        const answer = await answerCall(run.ctx, ["eval", expression], index, false);
        return answer.ok ? answer : { ...answer, call: index };
      } catch (error) {
        if (error instanceof ArgumentsTooDeep) return { ok: false, error: error.message, code: "usage", call: index };
        return pageFailure(error, index);
      }
    }));
  } finally {
    run.done.push("eval");
  }
}

async function serve(run: ScriptRun, request: Request): Promise<void> {
  let answer: Answer;
  try {
    add("script_calls");
    if (request.op === "sleep") {
      run.started.add(request.id);
      run.inflight.set(request.id, { argv: null, call: null, line: request["line"], type: "sleep" });
      await sleep(Math.min(Math.max(Number(request["ms"]) || 0, 0), MAX_TIMEOUT * 1000) / 1000);
      answer = { ok: true, text: "", data: {} };
    } else if (request.op === "call") answer = await serveCall(run, request);
    else if (["evaluate", "$eval", "$$eval", "frames"].includes(request.op)) answer = await servePage(run, request);
    else answer = { ok: false, error: `unknown script call ${JSON.stringify(request.op.slice(0, 40))}`, code: "usage" };
  } catch (error) {
    if (error instanceof Dropped) return;
    if (error instanceof Error && !(error instanceof Cancelled)) run.fail(error);
    return;
  } finally {
    run.inflight.delete(request.id);
    run.controls.delete(request.id);
    run.mutating.delete(request.id);
    run.started.delete(request.id);
    run.inflightBytes -= Number(request["bytes"]) || 0;
  }
  run.reply(request.id, answer);
}

function crashed(event: RunnerEvent & { type: "exit" }, overMemory = false): Message {
  if (overMemory) {
    flag("script_memory_limit", true);
    return {
      kind: "error",
      message: `The script used more than ${MEMORY_LIMIT / 1024 / 1024 / 1024} GB of memory and was stopped. Keep less in variables at once: push results into \`state\` and read pages in smaller batches`,
      name: "",
      line: null,
      code: null,
    };
  }
  flag("script_runner_crashed", true);
  const how = event.signal ? `it was stopped by ${event.signal}` : `it exited with status ${String(event.code)}`;
  return {
    kind: "error",
    message: `The script's runner stopped before the script finished (${how}). A script that runs out of memory or crashes the JavaScript engine does this; do less per run and keep results in \`state\``,
    name: "",
    line: null,
    code: null,
  };
}

function tooBusy(message: string): BrowseError {
  return new BrowseError(message, null, "script_failed");
}

async function drive(run: ScriptRun, source: string): Promise<Message> {
  const runner = run.runner;
  runner.watchMemory();
  if (!runner.send({ type: "start", source, state: run.ctx.state.scriptState, readBatch: READ_BATCH, stateLimit: STATE_LIMIT })) return crashed({ type: "exit", code: null, signal: null });
  const seen = new Set<number>();
  const outer = currentSignal();
  const signal = outer === null ? run.stop.signal : AbortSignal.any([outer, run.stop.signal]);
  for (;;) {
    const event = await untilCancelled(runner.next());
    if (event.type === "fatal") throw event.error;
    if (run.error !== null) throw run.error;
    if (event.type === "request") {
      const request = parseRequest(event.request);
      if (request === null || seen.has(request.id)) continue;
      seen.add(request.id);
      if (seen.size > MAX_CALLS) {
        run.fail(tooBusy(`The script made more than ${MAX_CALLS.toLocaleString("en-US")} calls; do less per run and keep results in \`state\``));
        continue;
      }
      const bytes = Buffer.byteLength(event.request, "utf8");
      if (run.inflightBytes + bytes > IN_FLIGHT_BYTES) {
        run.fail(tooBusy(`The script's waiting calls carried more than ${IN_FLIGHT_BYTES / 1024 / 1024} MB of arguments; send less at once`));
        continue;
      }
      if (run.running.size >= MAX_PENDING) {
        run.fail(tooBusy(`The script had more than ${MAX_PENDING.toLocaleString("en-US")} calls waiting at once; await them in smaller groups (Promise.all over a few dozen at a time)`));
        continue;
      }
      request["bytes"] = bytes;
      run.inflightBytes += bytes;
      const control = new AbortController();
      run.controls.set(request.id, control);
      const work = withSignal(AbortSignal.any([signal, control.signal]), () => serve(run, request));
      run.running.add(work);
      void work.finally(() => run.running.delete(work));
    } else if (event.type === "log") {
      if (typeof event.line === "string") run.keep(event.line);
    } else if (event.type === "state") {
      if (typeof event.value === "string" && event.value.length <= STATE_LIMIT) run.stateText = event.value;
    } else if (event.type === "missing") {
      flag("script_missing_api", true);
    } else if (event.type === "done") {
      const text = typeof event.result === "string" && event.result.length <= RESULT_LIMIT ? event.result : null;
      const result = text !== null && parseText(text) !== undefined ? (JSON.parse(text) as unknown) : null;
      const unawaited = run.gate.close();
      const cut = run.stopRunning();
      if (run.error !== null) throw run.error;
      const message: Message =
        result !== null && typeof result === "object" && !Array.isArray(result)
          ? (result as Message)
          : { kind: "error", message: text === null ? "the script's result is over 64 MB; return less, or keep it in `state`" : "the script's result couldn't be read" };
      return { ...message, unawaited, cut, logs: run.logs, logsDropped: run.logsDropped, state: run.stateText };
    } else if (event.type === "exit") {
      run.stopRunning();
      if (run.error !== null) throw run.error;
      if (runner.overBudget) throw tooBusy("The script sent more than 128 MB of calls faster than they were served; send less at once");
      return { ...crashed(event, runner.overMemory), logs: run.logs, logsDropped: run.logsDropped, state: run.stateText };
    }
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
  const { runner, warm } = takeRunner();
  flag("script_runner_warm", warm);
  let script: ScriptRun | null = null;
  let message: Message;
  try {
    const confined = await whenReady(runner);
    if (confined < 0) throw new BrowseError("The script didn't run: its runner couldn't sandbox itself", null, "script_failed");
    if (confined === 0) flag("script_runner_unconfined", true);
    const started = new ScriptRun(ctx, runner);
    script = started;
    let outcome: { value: Message } | { timedOut: true };
    try {
      outcome = await withDeadline(seconds, async () => {
        const finished = await drive(started, source);
        await untilCancelled(started.drain());
        return finished;
      });
    } catch (error) {
      if (error instanceof Cancelled && keepState(state, started.stateText)) flag("script_state_kept_on_interrupt", true);
      throw error;
    }
    if ("timedOut" in outcome) {
      runner.kill();
      const kept = keepState(state, started.stateText);
      throw timedOut(seconds, started.current(), source, started.logs, kept, started.done, started.stateText);
    }
    message = outcome.value;
  } finally {
    runner.kill();
    if (script !== null) await (script as ScriptRun).drain();
    if (script !== null) {
      count("script_concurrent_peak", script.gate.peak);
      count("script_receipts_skipped", script.receiptsSkipped);
    }
  }
  keepState(state, message["state"]);
  if (script !== null && script.error !== null) {
    const late = script.error;
    if (message["kind"] !== "error" || late instanceof ConnectionLost || !(late instanceof BrowseError)) throw late;
    const line = sourceLine(source, message["line"]);
    throw new BrowseError(
      `${errorText(message, source, script.calls)}\nA call the script didn't await then failed too: ${late.text}`,
      { ...failureData(message, script.calls), line },
      late.code ?? "script_failed",
    );
  }
  const logs = Array.isArray(message["logs"]) ? message["logs"].map(String) : [];
  if (message["logsDropped"]) logs.push(`[${String(message["logsDropped"])} more log lines dropped past ${Math.floor(LOG_LIMIT / 1024)} KB]`);
  const notes: string[] = [];
  const unawaited = script !== null ? script.gate.dropped : Number(message["unawaited"]) || 0;
  if (unawaited) notes.push(`[${unawaited} command${unawaited !== 1 ? "s" : ""} the script didn't await never ran]`);
  const cut = Number(message["cut"]) || 0;
  if (cut) notes.push(`[${cut} command${cut !== 1 ? "s" : ""} the script didn't await ${cut !== 1 ? "were" : "was"} still running when it ended and ${cut !== 1 ? "were" : "was"} stopped]`);
  if (message["kind"] === "error") {
    const line = sourceLine(source, message["line"]);
    const failed = message["command"];
    let hint = pageWorldHint(String(message["message"] || "error"), failed);
    if (hint) flag("script_page_world_hint", true);
    else {
      hint = sandboxHint(String(message["message"] || "error"), failed);
      if (hint) flag("script_sandbox_hint", true);
    }
    hint = hint ? `\n${hint}` : "";
    throw failure(`${errorText(message, source, script?.calls ?? [])}${hint}`, [...logs, ...notes], { ...failureData(message, script?.calls ?? []), line }, scriptCode(message["code"]));
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
