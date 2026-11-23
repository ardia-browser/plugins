import fs from "node:fs";
import path from "node:path";
import { isSpace, strip } from "../../py.ts";
import { groupThousands } from "../../pylib/format.ts";
import { pyLen, splitlines } from "../../pylib/str.ts";
import { shlexSplit } from "../../pylib/shlex.ts";
import { codeLine } from "./batch-line.ts";
import { redact } from "../../redact.ts";
import { BrowseError, ConnectionLost, OutcomeUnknown, Usage } from "../daemon-errors.ts";
import type { JsonObject } from "../../json.ts";
import { OUTPUT_CAP, pyValue, Result } from "../daemon/render.ts";
import { content, savedBodyLine } from "../outfile.ts";
import { add, failedStep, flag } from "../metrics.ts";
import { wellFormed, writeAllFd } from "../paths.ts";
import { Ctx } from "./ctx.ts";
import { ALIASES, dispatch, hooks, register } from "./index.ts";
import { parse } from "./parse.ts";
import { commitShown } from "../snapshot/since.ts";
import { attach, beginBatch, endBatch, flushBatch, hasPendingReaction } from "../changes/observe.ts";
import type { Report } from "../changes/report.ts";
import { parseRef } from "../state/refs.ts";
import type { State } from "../state/state.ts";

export const BATCH_DEFAULT_CAP = OUTPUT_CAP;
const NESTED_BATCH = "batch can't run inside batch";
const CLOSE_INSIDE = "close ends this session, so in a batch it only runs as the last line; to close this session's tab and go on, use `tab close`";
const TAKES_OUT = ["script", "eval", "read", "snapshot", "get"];
const AS_TEXT = ["snapshot", "get"];
const VALUE_FLAGS = ["--cdp", "--data-dir", "--enable", "--expect-loader", "--idle-timeout", "--init-script", "--max-output", "--namespace", "--port", "--screenshot-dir", "--screenshot-format", "--screenshot-quality", "--session", "--ws"];
const BOOL_FLAGS = ["--annotate", "--capture-console", "--content-boundaries", "--debug", "--full", "--humanize", "--json", "--no-auto-dialog", "--no-changes", "--no-humanize", "--no-pin-tab", "--no-text", "--pin-tab", "--show"];
const LAUNCH_ONLY = [
  "--action-policy", "--allow-file-access", "--allowed-domains", "--args", "--auto-connect", "--ca-cert", "--config", "--confirm-actions", "--confirm-interactive", "--engine",
  "--executable-path", "--extension", "--headed", "--hide-scrollbars", "--ignore-https-errors", "--model", "--no-ca-cert", "--profile", "--provider", "--proxy", "--proxy-bypass",
  "--quiet", "--restore", "--restore-check-fn", "--restore-check-text", "--restore-check-url", "--restore-save", "--session-name", "--state", "--user-agent", "--verbose", "--webgpu",
  "-p", "-q", "-v",
];
const LAUNCH_HINTS: Readonly<Record<string, string>> = {
  "--color-scheme": "run `ardia browse set media dark|light` instead",
  "--download-path": "pass the path to `ardia browse download <sel> <path>` instead",
  "--headers": "run `ardia browse set headers <json>` instead",
};
const COMMAND_OWNS: Readonly<Record<string, readonly string[]>> = { diff: ["--full"], screenshot: ["--annotate", "--full"], stream: ["--port"] };
const COMMAND_LAUNCH_NAMES: Readonly<Record<string, readonly string[]>> = { wait: ["--state"] };
const LINE_OPTIONS: Readonly<Record<string, string>> = {
  full: "full", max_output: "max_output", no_changes: "no_changes", no_text: "no_text", humanize: "humanize", show: "show", annotate: "annotate", capture_console: "capture_console",
};
const VALUE_ONLY_LINE = /^~ .*\(was .*\)$|^~ option .*\(was (\[selected\]|plain)\)$/u;
const NOTHING_ELSE = "→ Nothing else on the page changed yet.";
const COMPACTED_COMMANDS = new Set(["fill", "select", "check", "uncheck", "type"]);
const HELD_FLAGS = new Set(["--no-humanize"]);
const PARTLY_FAILED = "\n(this report also holds what the failed line after it did before it failed)";
const PLAIN_WORD = /^[\p{L}\p{N}_@#.:/=+,-]+$/u;

function truthy(value: string): boolean {
  return !["", "0", "false", "no", "off"].includes(strip(value, isSpace).toLowerCase());
}

function keyOf(name: string): string {
  return name.replace(/^-+/u, "").replaceAll("-", "_");
}

export function splitGlobals(argv: readonly string[]): [Map<string, unknown>, string[]] {
  const found = new Map<string, unknown>();
  const rest: string[] = [];
  let command: string | null = null;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    index += 1;
    if (token === "--") {
      rest.push(token, ...argv.slice(index));
      break;
    }
    const split = token.startsWith("--") && token.includes("=");
    const name = split ? token.slice(0, token.indexOf("=")) : token;
    let inline: string | null = split ? token.slice(token.indexOf("=") + 1) : null;
    const owned = (COMMAND_OWNS[command ?? ""] ?? []).includes(name);
    if (VALUE_FLAGS.includes(name) && !owned) {
      if (inline === null) {
        if (index >= argv.length) throw new Usage(`${name} needs a value`);
        inline = argv[index] as string;
        index += 1;
      }
      const key = keyOf(name);
      if (name === "--enable") found.set(key, [...((found.get(key) as string[] | undefined) ?? []), ...inline.split(",")]);
      else if (name === "--init-script") found.set(key, [...((found.get(key) as string[] | undefined) ?? []), inline]);
      else found.set(key, inline);
      continue;
    }
    if (BOOL_FLAGS.includes(name) && !owned) {
      found.set(keyOf(name), inline === null ? true : truthy(inline));
      continue;
    }
    if (command !== null && COMMAND_LAUNCH_NAMES[command]?.includes(name)) {
      rest.push(token);
      continue;
    }
    const hint = LAUNCH_HINTS[name];
    if (hint !== undefined) throw new Usage(`${name} is a launch option agent-browser applies when it starts its own browser; ${hint}`);
    if (LAUNCH_ONLY.includes(name)) throw new Usage(`${name} doesn't apply to Ardia: ardia browse drives the browser you're running, so launch options have no effect`);
    if (command === null && !token.startsWith("-")) command = token;
    rest.push(token);
  }
  return [found, rest];
}

export function batchLineOptions(item: readonly string[]): [string[], Record<string, unknown>] {
  const [found, rest] = splitGlobals(item);
  const unusable = [...found.keys()]
    .filter((key) => !Object.hasOwn(LINE_OPTIONS, key) && key !== "no_humanize" && key !== "json")
    .map((key) => `--${key.replaceAll("_", "-")}`)
    .sort();
  if (unusable.length > 0) throw new Usage(`${unusable.join(", ")} applies to the whole session, so it goes on the \`batch\` command, not a line inside it`);
  const line: Record<string, unknown> = {};
  for (const [key, value] of found) if (Object.hasOwn(LINE_OPTIONS, key)) line[LINE_OPTIONS[key] as string] = value;
  if (found.get("no_humanize")) line["humanize"] = false;
  if (line["max_output"] !== undefined && line["max_output"] !== null) {
    const text = strip(String(line["max_output"]), isSpace).replaceAll("_", "");
    if (!/^[+-]?[0-9]+$/u.test(text)) throw new Usage(`--max-output takes a number of characters, not ${String(line["max_output"])}`);
    line["max_output"] = Number(text);
  }
  return [rest, line];
}

function checkedOut(target: string): string {
  if (!target || target.startsWith("-")) throw new Usage("--out takes a file path, like --out data.json");
  return target;
}

export function takeOut(argv: string[], command: string): [string[], string | null] {
  if (!TAKES_OUT.includes(command) || !argv.includes(command)) return [argv, null];
  for (let index = argv.indexOf(command) + 1; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === "--") break;
    if (token.startsWith("--out=")) return [[...argv.slice(0, index), ...argv.slice(index + 1)], checkedOut(token.slice(token.indexOf("=") + 1))];
    if (token === "--out") {
      if (index + 1 >= argv.length) throw new Usage(`--out takes a file path: ${command} … --out data.json`);
      return [[...argv.slice(0, index), ...argv.slice(index + 2)], checkedOut(argv[index + 1] as string)];
    }
  }
  return [argv, null];
}

export function saveText(given: string, text: string | Uint8Array): string {
  const target = given.startsWith("~/") ? path.join(process.env["HOME"] ?? "~", given.slice(2)) : given;
  let isDir = false;
  try {
    isDir = fs.statSync(target).isDirectory();
  } catch {}
  if (isDir) throw new Usage(`--out ${given} is a folder; give a file path, like ${path.join(given, "data.json")}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.part`);
  try {
    const fd = fs.openSync(temporary, "wx", 0o666);
    try {
      writeAllFd(fd, typeof text === "string" ? Buffer.from(wellFormed(redact(text)), "utf8") : text);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.chmodSync(temporary, fs.statSync(target).mode & 0o777);
    } catch {}
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return target;
}

function writeFailure(error: unknown): string {
  if (error instanceof Usage) return error.message;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const reasons: Record<string, string> = {
    EACCES: "Permission denied",
    EPERM: "Operation not permitted",
    ENOENT: "No such file or directory",
    ENOTDIR: "Not a directory",
    EROFS: "Read-only file system",
    ENOSPC: "No space left on device",
    EISDIR: "Is a directory",
  };
  return (code && reasons[code]) || (error instanceof Error ? error.message : String(error));
}

function saveBatchBody(ctx: Ctx, target: string, body: Uint8Array, data: JsonObject): [string, boolean] {
  let saved: string;
  try {
    saved = saveText(ctx.path(target), body);
  } catch (error) {
    if (!(error instanceof Usage) && !(error instanceof Error && "code" in error)) throw error;
    return [`✗ Couldn't write ${target}: ${writeFailure(error)}`, false];
  }
  flag("saved_to_file", true);
  flag("batch_line_saved", true);
  flag("read_binary_saved", true);
  return [savedBodyLine(saved, body, data).trimEnd(), true];
}

function saveBatchLine(ctx: Ctx, name: string, result: Result, target: string): [string, boolean] {
  if (name === "read" && result.body) {
    const data = pyValue(result.data ?? {});
    return saveBatchBody(ctx, target, result.body, data instanceof Map ? data : new Map());
  }
  let text = result.text ?? "";
  let summary = "its text";
  if (name === "snapshot") {
    const data = pyValue(result.data ?? {});
    const tree = data instanceof Map && data.has("diff") ? data.get("snapshot") : null;
    if (typeof tree === "string") text = tree;
  } else if (!AS_TEXT.includes(name)) {
    const data = pyValue(result.data ?? {});
    [text, summary] = content(name, data instanceof Map ? data : new Map(), target);
  }
  if (!strip(text, isSpace)) return [`✗ ${name} returned nothing to save, so ${target} wasn't written`, false];
  let saved: string;
  try {
    saved = saveText(ctx.path(target), text);
  } catch (error) {
    if (!(error instanceof Usage) && !(error instanceof Error && "code" in error)) throw error;
    return [`✗ Couldn't write ${target}: ${writeFailure(error)}\n${result.text ?? ""}`, false];
  }
  flag("saved_to_file", true);
  flag("batch_line_saved", true);
  return [`✓ Saved to ${saved} (${groupThousands(String(pyLen(text)))} characters): ${summary}`, true];
}

type Outcome = { command: unknown; success: boolean; result: unknown; error: string | null; code?: string | null; text?: string | null };

function saveBatch(ctx: Ctx, target: string, text: string, outcomes: Outcome[]): string {
  const failed = outcomes.filter((outcome) => !outcome.success).map((outcome) => `✗ ${(outcome.command as string[]).join(" ")}: ${outcome.error}`);
  if (!strip(text, isSpace)) return [`✗ The batch printed nothing, so ${target} wasn't written`, ...failed].join("\n");
  let saved: string;
  try {
    saved = saveText(ctx.path(target), text);
  } catch (error) {
    if (!(error instanceof Usage) && !(error instanceof Error && "code" in error)) throw error;
    return `✗ Couldn't write ${target}: ${writeFailure(error)}\n${text}`;
  }
  flag("saved_to_file", true);
  flag("batch_saved", true);
  const lines = outcomes.length - failed.length;
  return [`✓ Saved the output of ${lines} of ${outcomes.length} lines to ${saved} (${groupThousands(String(pyLen(text)))} characters)`, ...failed].join("\n");
}

function valueOnly(text: string | null | undefined): boolean {
  const lines = (text || "").split("\n").filter((line) => strip(line, isSpace));
  if (lines.length < 2 || !(lines[0] as string).startsWith("✓") || strip(lines[1] as string, isSpace) !== "changes:") return false;
  const rest = lines.slice(2).filter((line) => !line.startsWith(NOTHING_ELSE));
  return rest.length > 0 && rest.every((line) => VALUE_ONLY_LINE.test(strip(line, isSpace)));
}

function quoteWord(word: string): string {
  return PLAIN_WORD.test(word) ? word : JSON.stringify(word).replace(/[\u007f-￿]/gu, (char) => char);
}

function compactBatchLines(outcomes: Outcome[]): void {
  const succeeded = outcomes.flatMap((outcome, index) => (outcome.success ? [index] : []));
  if (succeeded.length < 2) return;
  let compacted = 0;
  for (const index of succeeded.slice(0, -1)) {
    const outcome = outcomes[index] as Outcome;
    const command = outcome.command;
    const words = Array.isArray(command) ? (command as string[]) : shlexSplit(String(command));
    let name = words[0] ?? "";
    if (words[0] === "find" && words.length >= 4) name = (["role", "text", "label", "placeholder", "alt", "title", "testid"].includes(words[1] as string) ? words[3] : words[2]) as string;
    if (!COMPACTED_COMMANDS.has(name) || !valueOnly(outcome.text)) continue;
    outcome.text = `✓ ${words.map(quoteWord).join(" ")}`;
    compacted += 1;
  }
  if (compacted) add("batch_lines_compacted", compacted);
}

export function fieldTarget(command: readonly string[]): string | null {
  const name = command.length > 0 ? (ALIASES[command[0] as string] ?? (command[0] as string)) : "";
  if (!COMPACTED_COMMANDS.has(name)) return null;
  for (let index = 1; index < command.length; index += 1) {
    const word = command[index] as string;
    if (word === "-s" || word === "--selector") return command[index + 1] ?? null;
    if (word.startsWith("--selector=")) return word.slice("--selector=".length) || null;
    if (word === "--" || !word.startsWith("-")) return word === "--" ? (command[index + 1] ?? null) : word;
    if (!HELD_FLAGS.has(word)) return null;
  }
  return null;
}

function heldLine(state: State, item: readonly string[] | undefined, needsKnownRef: boolean): boolean {
  if (item === undefined) return false;
  let command: string[];
  let lineOptions: Record<string, unknown>;
  try {
    const name = item.length > 0 ? (ALIASES[item[0] as string] ?? (item[0] as string)) : "";
    const [taken, saving] = takeOut([...item], name);
    if (saving) return false;
    [command, lineOptions] = batchLineOptions(taken);
  } catch (error) {
    if (error instanceof Usage) return false;
    throw error;
  }
  if (lineOptions["no_changes"] || lineOptions["full"] || lineOptions["max_output"] !== undefined) return false;
  const target = fieldTarget(command);
  if (target === null) return false;
  const ref = parseRef(target);
  return !needsKnownRef || ref === null || state.refs.has(ref);
}

export type BatchExtras = { closeAfterBatch: boolean };
const batchState = new WeakMap<object, BatchExtras>();

export function takeCloseAfterBatch(state: object): boolean {
  const found = batchState.get(state);
  if (found === undefined) return false;
  const close = found.closeAfterBatch;
  found.closeAfterBatch = false;
  return close;
}

function extras(ctx: Ctx): BatchExtras {
  let found = batchState.get(ctx.state);
  if (found === undefined) batchState.set(ctx.state, (found = { closeAfterBatch: false }));
  return found;
}

export async function runOne(ctx: Ctx, argv: readonly string[], options: Record<string, unknown> = {}): Promise<[Result | null, BrowseError | null]> {
  if (argv.length === 0) return [null, new BrowseError("No command given")];
  const name = ALIASES[argv[0] as string] ?? (argv[0] as string);
  const sub = new Ctx(ctx.state, { ...ctx.options, ...options }, ctx.cwd, ctx.env, ctx.stdin, name);
  try {
    return [await dispatch(sub, name, argv.slice(1)), null];
  } catch (error) {
    if (error instanceof BrowseError) return [null, error];
    throw error;
  }
}

function parsedLine(line: string): string[] {
  let item: unknown;
  if (line.startsWith("[")) {
    try {
      item = JSON.parse(line);
    } catch {
      throw new Usage(`A batch command must be a JSON array of strings or a command line: ${line}`);
    }
  } else item = codeLine(line) ?? shlexSplit(line);
  if (!Array.isArray(item) || !item.every((part) => typeof part === "string")) throw new Usage(`A batch command must be a JSON array of strings or a command line: ${line}`);
  return item as string[];
}

export function stepName(command: unknown): string {
  const words = Array.isArray(command) && command.every((word) => typeof word === "string") ? (command as string[]) : [];
  try {
    return batchLineOptions(words)[0][0] ?? "";
  } catch (error) {
    if (!(error instanceof Usage)) throw error;
  }
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string;
    const flagName = word.split("=")[0] as string;
    if (word === "--") return words[index + 1] ?? "";
    if (LAUNCH_ONLY.includes(flagName) || Object.hasOwn(LAUNCH_HINTS, flagName)) return "";
    if (VALUE_FLAGS.includes(word)) index += 1;
    else if (!word.startsWith("-")) return word;
  }
  return "";
}

async function cmdBatch(ctx: Ctx, argv: string[]): Promise<Result> {
  ctx.state.pendingShown = new Map();
  try {
    return await runBatch(ctx, argv);
  } finally {
    ctx.state.pendingShown = null;
  }
}

async function runBatch(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--bail": "bool", "--out": "value" });
  const lines = args.length > 0 ? args : splitlines(ctx.stdin || "").filter((line) => strip(line, isSpace) && !strip(line, isSpace).startsWith("#"));
  const runs = lines.map((line, index) => {
    try {
      return parsedLine(strip(line, isSpace));
    } catch (error) {
      failedStep(index, "", error instanceof BrowseError ? error.code : null);
      throw error;
    }
  });
  const names = runs.map((item) => (item.length > 0 ? (ALIASES[item[0] as string] ?? (item[0] as string)) : ""));
  const closing = names.length > 0 && names.at(-1) === "close" && (runs.at(-1) as string[]).length === 1 && !names.slice(0, -1).includes("close");
  if (closing) runs.pop();
  const state = extras(ctx);
  state.closeAfterBatch = false;
  const outcomes: Outcome[] = [];
  const notices: string[] = [];
  const fullListing = Boolean(ctx.options["full"]);
  let noted = false;
  const settle = (outcome: Outcome, index: number) => {
    outcomes.push(outcome);
    if (noted || outcome.success) return;
    noted = true;
    failedStep(index, stepName(outcome.command), outcome.code);
  };
  let running = -1;
  const observing = beginBatch(ctx.state);
  let held: { outcome: Outcome; result: Result } | null = null;
  const placeReport = (report: Report | null, partly = false) => {
    if (report === null || held === null) return;
    const attached = attach(held.result, report);
    held.outcome.text = partly ? `${attached.text}${PARTLY_FAILED}` : attached.text;
    held.outcome.result = partly ? { ...(attached.data as Record<string, unknown>), partlyFailedNext: true } : attached.data;
    held = null;
  };
  try {
    await runLines();
    placeReport(await flushBatch(ctx, observing));
  } catch (error) {
    if (!noted && running >= 0) failedStep(running, stepName(runs[running]), error instanceof BrowseError ? error.code : null, true);
    throw error;
  } finally {
    await endBatch(ctx.state, observing);
  }

  async function runLines(): Promise<void> {
  for (let index = 0; index < runs.length; index += 1) {
    running = index;
    let item = runs[index] as string[];
    const name = item.length > 0 ? (ALIASES[item[0] as string] ?? (item[0] as string)) : "";
    if (name === "batch" || name === "close") {
      const why = name === "batch" ? NESTED_BATCH : CLOSE_INSIDE;
      settle({ command: item, success: false, result: null, error: why }, index);
      if (options["bail"]) break;
      continue;
    }
    let saving: string | null;
    let command: string[];
    let lineOptions: Record<string, unknown>;
    try {
      [item, saving] = takeOut(item, name);
      [command, lineOptions] = batchLineOptions(item);
    } catch (error) {
      if (!(error instanceof Usage)) throw error;
      settle({ command: item, success: false, result: null, error: error.message, code: error.code ?? null } as Outcome, index);
      if (options["bail"]) break;
      continue;
    }
    const ran = command.length > 0 ? (ALIASES[command[0] as string] ?? (command[0] as string)) : "";
    if (ran === "batch" || ran === "close") {
      const why = ran === "batch" ? NESTED_BATCH : CLOSE_INSIDE;
      settle({ command: item, success: false, result: null, error: why }, index);
      if (options["bail"]) break;
      continue;
    }
    const lineFull = Boolean(lineOptions["full"]);
    if (lineFull) ctx.options["full"] = true;
    delete lineOptions["full"];
    lineOptions["full_listing"] = fullListing || lineFull;
    const wider = lineOptions["max_output"] as number | undefined;
    delete lineOptions["max_output"];
    if (wider !== undefined) {
      const given = ctx.options["max_output"];
      const current = given === undefined || given === null ? BATCH_DEFAULT_CAP : Number(given);
      ctx.options["max_output"] = current === 0 || wider === 0 ? 0 : Math.max(current, wider);
    }
    if (saving && ran === "read") lineOptions["out_body"] = true;
    const staged = saving && ctx.state.pendingShown !== null ? new Map(ctx.state.pendingShown) : null;
    const holding = !ctx.options["no_changes"] && heldLine(ctx.state, item, false) && heldLine(ctx.state, runs[index + 1], true);
    if (hasPendingReaction(ctx.state)) observing.current = null;
    observing.nextLine(holding);
    const [result, error] = await runOne(ctx, command, lineOptions);
    observing.defer = false;
    if (observing.flushed !== null) {
      placeReport(observing.flushed, observing.flushedPartly);
      observing.flushed = null;
      observing.flushedPartly = false;
    }
    const failed = error === null && Boolean(result?.failed);
    const outcome: Outcome = {
      command: item,
      success: error === null && !failed,
      result: result ? result.data : null,
      error: error ? error.message : failed ? "the command reported a failure" : null,
      text: result ? result.text : null,
    };
    if (error !== null && error.code) outcome.code = error.code;
    if (result?.notice && outcome.text?.endsWith(result.notice)) outcome.text = outcome.text.slice(0, outcome.text.length - result.notice.length).replace(/\n$/u, "");
    let wrote = false;
    if (saving && outcome.success && result) {
      [outcome.text, wrote] = saveBatchLine(ctx, name, result, saving);
      if (!wrote) {
        outcome.success = false;
        outcome.error = (outcome.text ?? "").split("\n")[0]?.replace(/^✗ /u, "") ?? "the output couldn't be saved";
        outcome.code = "failed";
      }
    }
    if (wrote && staged !== null && ctx.state.pendingShown !== null) {
      ctx.state.pendingShown.clear();
      for (const [target, entry] of staged) ctx.state.pendingShown.set(target, entry);
    }
    if (!wrote && result?.notice) notices.push(result.notice);
    if (holding && outcome.success && result && observing.pending !== null) {
      if (!outcome.text || outcome.text === "✓ Done") outcome.text = `✓ ${command.map(quoteWord).join(" ")}`;
      held = { outcome, result };
      add("batch_lines_held");
    } else if (observing.pending !== null) placeReport(await flushBatch(ctx, observing), !outcome.success);
    settle(outcome, index);
    if (error instanceof OutcomeUnknown || error instanceof ConnectionLost) {
      for (const rest of runs.slice(index + 1)) {
        outcomes.push({ command: rest, success: false, result: null, error: "not run: an earlier command's outcome is unknown", code: "not_run", text: null });
      }
      break;
    }
    if (!outcome.success && options["bail"]) break;
  }
  }
  if (closing) {
    if (outcomes.length === runs.length && outcomes.every((outcome) => outcome.success)) state.closeAfterBatch = true;
    else {
      outcomes.push({
        command: ["close"],
        success: false,
        result: null,
        code: "not_run",
        text: null,
        error: "close not run: an earlier line failed or didn't run, so the session stays open",
      });
    }
  }
  compactBatchLines(outcomes);
  let text = outcomes.map((outcome) => (outcome.success || outcome.text ? outcome.text : `✗ ${outcome.error}`) || "").join("\n\n");
  let savedWhole = false;
  if (options["out"]) {
    text = saveBatch(ctx, options["out"] as string, text, outcomes);
    savedWhole = text.startsWith("✓ Saved the output");
  }
  for (const outcome of outcomes) delete outcome.text;
  const result = new Result({ results: outcomes }, text);
  if (notices.length > 0) result.notice = notices.join("\n");
  const batchCap = ctx.options["full"] ? 0 : ctx.options["max_output"] === undefined || ctx.options["max_output"] === null ? OUTPUT_CAP : Number(ctx.options["max_output"]);
  const shown = ctx.state.pendingShown;
  ctx.state.pendingShown = null;
  if (shown !== null && !savedWhole && !(batchCap > 0 && pyLen(text) > batchCap)) commitShown(ctx.state, shown);
  result.batch = outcomes;
  if (outcomes.some((outcome) => !outcome.success)) result.failed = true;
  return result;
}

register("batch", cmdBatch);
hooks.closeAfterBatch = takeCloseAfterBatch;
