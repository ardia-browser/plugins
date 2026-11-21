import type { Option, Parsed, Spec } from "./argv.ts";
import { didYouMean } from "./closest.ts";
import { CALL_TIMEOUT, type Failure, withSession } from "./control.ts";
import { dumps, type JsonObject, type Value } from "./json.ts";
import { shown } from "./printable.ts";
import { MAX_LINE_BYTES } from "./protocol.ts";
import { charCount, isSpace, left, lstrip, rstrip, strip, strOf, truthy, Unsupported } from "./py.ts";
import { DecodeError, loads, Refused, TooDeepToJudge, utf8Failure } from "./pyjson.ts";
import { utf8 } from "./pystr.ts";
import { pretty } from "./render.ts";
import { type Context, failureOf, HandBack, noteUnreachable, readStdin } from "./runner.ts";

export const MAX_TIMEOUT = 600;
const MAX_STDIN_PARAMS = 1024 * 1024;
const MAX_PARAMS_DEPTH = 64;
const WIDEST_ID = 2n ** 53n;
const TOO_OLD =
  "this Ardia is too old to list its methods (it has no `methods` method): update Ardia. " +
  "`ardia call` still sends the methods it knows: hello, commands, windows, workspace, apply, run, subscribe";
const FAMILIES = new Set(
  (
    "hello caller commands windows workspace offscreen apply subscribe answer run methods app window tab tabs group groups folder folders " +
    "pin pins space spaces profile profiles history bookmarks bookmark favorites cookies storage sitedata downloads download passwords " +
    "password autofill permissions settings prefs preferences extensions extension search themes theme notes sessions session media " +
    "notifications split peek sidebar command config plugins sync import certificates cache browser engine"
  ).split(" "),
);
const PROTOCOL_CODES = new Set(["bad_request", "unknown_method", "unknown_command", "refused", "no_window", "failed", "unsupported_protocol"]);
export const CALL_FLAGS = ["--params", "-p", "--param", "--timeout", "--json", "--data-dir"];
const DESCRIPTOR_FIELDS = new Set(["description", "mutates", "mutating", "params", "result", "area"]);

const PLAIN_SECONDS = /^([0-9]+\.?[0-9]*|\.[0-9]+)$/;

function acceptsSeconds(text: string): boolean {
  if (!PLAIN_SECONDS.test(text)) return false;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 && value <= MAX_TIMEOUT;
}

const DATA_DIR: Option = { names: ["--data-dir"], dest: "data_dir", kind: "value" };
const JSON_FLAG: Option = { names: ["--json"], dest: "json", kind: "flag" };

export const CALL_SPEC: Spec = {
  positionals: [{ dest: "method", nargs: "one" }],
  options: [
    { names: ["--params"], dest: "params", kind: "value" },
    { names: ["-p", "--param"], dest: "pairs", kind: "append" },
    { names: ["--timeout"], dest: "timeout", kind: "value", accepts: acceptsSeconds },
    JSON_FLAG,
    DATA_DIR,
  ],
};

export const METHODS_SPEC: Spec = { positionals: [{ dest: "name", nargs: "optional" }], options: [JSON_FLAG, DATA_DIR] };

export class ParamsError extends Error {}

export function family(method: string): string {
  const head = (method.split(".")[0] as string).split("/")[0]?.toLowerCase() ?? "";
  return FAMILIES.has(head) ? head : "other";
}

function recordedCode(code: string): string {
  return PROTOCOL_CODES.has(code) ? code : "other";
}

function loneSurrogate(text: string): number | undefined {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit < 0xdc00) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next < 0xe000) {
        index += 1;
        continue;
      }
      return unit;
    }
    if (unit >= 0xdc00 && unit < 0xe000) return unit;
  }
  return undefined;
}

function plainText(text: string, what: string): void {
  const unit = loneSurrogate(text);
  if (unit !== undefined) throw new ParamsError(`${what} has a lone surrogate (\\u${unit.toString(16).padStart(4, "0")}), which isn't valid Unicode`);
}

function checked(value: Value, what: string, depth: number): void {
  const stack: [Value, number][] = [[value, depth]];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [item, level] = next;
    if (item instanceof Map || Array.isArray(item)) {
      if (level >= MAX_PARAMS_DEPTH) throw new ParamsError(`${what} is nested deeper than ${MAX_PARAMS_DEPTH} levels`);
      if (item instanceof Map) {
        for (const key of item.keys()) plainText(key, what);
        for (const child of item.values()) stack.push([child, level + 1]);
      } else for (const child of item) stack.push([child, level + 1]);
    } else if (typeof item === "string") plainText(item, what);
  }
}

function strictJson(text: string, what: string, depth: number): Value {
  if (strip(text, isSpace) === "") throw new ParamsError(`${what} is empty; give a JSON object, like {}`);
  let value: Value;
  try {
    value = loads(text, { what });
  } catch (error) {
    if (error instanceof Refused) throw new ParamsError(error.message);
    if (error instanceof DecodeError) throw new ParamsError(`${what} isn't valid JSON (${error.message})`);
    if (error instanceof TooDeepToJudge) throw new ParamsError(`${what} is nested deeper than ${MAX_PARAMS_DEPTH} levels`);
    throw error;
  }
  checked(value, what, depth);
  return value;
}

async function paramsFromStdin(): Promise<string> {
  const raw = await readStdin(MAX_STDIN_PARAMS + 1);
  if (raw.length > MAX_STDIN_PARAMS) throw new ParamsError("--params from stdin is over 1 MB");
  const failure = utf8Failure(raw);
  if (failure !== undefined) {
    const byte = (raw[failure.start] as number).toString(16).padStart(2, "0");
    throw new ParamsError(`--params from stdin isn't UTF-8 (byte 0x${byte} at offset ${failure.start})`);
  }
  return raw.toString("utf8");
}

async function buildParams(context: Context, raw: string | undefined, pairs: string[]): Promise<JsonObject | undefined> {
  let params: JsonObject | undefined;
  if (raw !== undefined) {
    let text = raw;
    if (raw === "-") {
      context.committed();
      text = await paramsFromStdin();
    }
    const value = strictJson(text, "--params", 0);
    if (!(value instanceof Map)) throw new ParamsError("--params must be a JSON object, like '{\"limit\": 10}'");
    params = value;
  }
  for (const pair of pairs) {
    const split = pair.indexOf("=");
    const key = split < 0 ? pair : pair.slice(0, split);
    if (split < 0 || key === "" || key === ":") throw new ParamsError(`-p ${pair}: give key=value, or key:=json`);
    const value = pair.slice(split + 1);
    params ??= new Map();
    if (key.endsWith(":")) {
      const name = key.slice(0, -1);
      plainText(name, `-p ${name}`);
      params.set(name, strictJson(value, `-p ${name}: the value after :=`, 1));
    } else {
      plainText(key, `-p ${key}`);
      plainText(value, `-p ${key}`);
      params.set(key, value);
    }
  }
  return params;
}

function requestLength(method: string, params: JsonObject | undefined): number {
  const request: JsonObject = new Map<string, Value>([
    ["id", WIDEST_ID],
    ["method", method],
  ]);
  if (params !== undefined) request.set("params", params);
  return utf8(`${dumps(request, "compact")}\n`).length;
}

function isDescriptor(value: Value | undefined): boolean {
  if (!(value instanceof Map) || value.size === 0 || [...value.keys()].some((key) => !DESCRIPTOR_FIELDS.has(key))) return false;
  if (value.has("description") && typeof value.get("description") !== "string") return false;
  return ["mutates", "mutating"].every((key) => !value.has(key) || typeof value.get(key) === "boolean");
}

function isWrapper(catalog: Value): boolean {
  if (!(catalog instanceof Map) || !catalog.has("methods")) return false;
  const inner = catalog.get("methods");
  if (Array.isArray(inner)) return true;
  if (!(inner instanceof Map) || isDescriptor(inner)) return false;
  return ![...catalog].some(([key, value]) => key !== "methods" && isDescriptor(value));
}

function withName(name: Value, fields: JsonObject): JsonObject {
  const row: JsonObject = new Map([["name", name]]);
  for (const [key, value] of fields) row.set(key, value);
  return row;
}

export function entries(catalog: Value): JsonObject[] {
  const source = isWrapper(catalog) ? ((catalog as JsonObject).get("methods") as Value) : catalog;
  const rows: JsonObject[] = [];
  if (source instanceof Map) {
    for (const [name, spec] of source) rows.push(withName(name, spec instanceof Map ? spec : new Map([["description", spec]])));
  } else if (Array.isArray(source)) {
    for (const item of source) {
      if (typeof item === "string") rows.push(new Map([["name", item]]));
      else if (item instanceof Map) {
        const name = truthy(item.get("name")) ? item.get("name") : item.get("method");
        if (typeof name === "string") {
          const row: JsonObject = new Map(item);
          row.set("name", name);
          rows.push(row);
        }
      }
    }
  }
  return rows;
}

function mutates(row: JsonObject): boolean {
  return truthy(row.has("mutates") ? row.get("mutates") : row.get("mutating"));
}

function scalar(value: Value): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Map || Array.isArray(value)) return dumps(value, "spaced");
  return shown(strOf(value));
}

function nonEmptyContainer(value: Value): boolean {
  return (value instanceof Map && value.size > 0) || (Array.isArray(value) && value.length > 0);
}

export function readable(value: Value, indent = 0): string[] {
  const pad = "  ".repeat(indent);
  if (value instanceof Map) {
    if (value.size === 0) return [`${pad}{}`];
    const lines: string[] = [];
    for (const [key, item] of value) {
      if (nonEmptyContainer(item)) {
        lines.push(`${pad}${shown(key)}:`);
        lines.push(...readable(item, indent + 1));
      } else lines.push(`${pad}${shown(key)}: ${scalar(item)}`);
    }
    return lines;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`];
    const lines: string[] = [];
    for (const item of value) {
      if (nonEmptyContainer(item)) {
        const inner = readable(item, indent + 1);
        lines.push(`${pad}- ${lstrip(inner[0] as string)}`);
        lines.push(...inner.slice(1));
      } else lines.push(`${pad}- ${scalar(item)}`);
    }
    return lines;
  }
  return [pad + scalar(value)];
}

function names(catalog: Value): Value[] {
  return entries(catalog).map((row) => row.get("name") ?? null);
}

function unreachableExit(context: Context, failure: Failure, method: string | undefined): number {
  noteUnreachable(context, failure);
  const message = "message" in failure ? failure.message : "";
  if (failure.kind === "invalid" && method !== undefined) context.complain(`ardia call: ${message}, so ${method} may or may not have run`);
  else if (failure.kind === "unreachable" && failure.sent && method !== undefined) {
    context.complain(`ardia call: the connection dropped after the request went out, so ${method} may or may not have run (${message})`);
  } else context.complain(`ardia: ${message}`);
  return 2;
}

type Outcome = { ok: true; result: Value } | { ok: false; code: string; message: string; catalog: Value | undefined };

async function send(context: Context, dataDir: string | undefined, method: string, params: JsonObject | undefined, timeout: number): Promise<Outcome> {
  return withSession(dataDir, async (session) => {
    const started = performance.now();
    try {
      context.committed();
      return { ok: true, result: await session.call(method, params, timeout, true) };
    } catch (error) {
      const failure = failureOf(error, context);
      if (failure?.kind !== "method") throw error;
      let catalog: Value | undefined;
      const left = timeout - (performance.now() - started) / 1000;
      if (failure.code === "unknown_method" && method !== "methods" && left > 0) {
        try {
          const found = await session.call("methods", undefined, left);
          catalog = found === null ? undefined : found;
        } catch (inner) {
          const lost = failureOf(inner, context);
          if (lost === undefined) throw inner;
        }
      }
      return { ok: false, code: failure.code, message: failure.message, catalog };
    }
  });
}

export async function runCall(context: Context, parsed: Parsed): Promise<number> {
  const method = parsed.values.get("method") as string;
  const dataDir = parsed.values.get("data_dir");
  const timeoutText = parsed.values.get("timeout");
  const timeout = timeoutText === undefined ? CALL_TIMEOUT : Number(timeoutText);
  let params: JsonObject | undefined;
  try {
    plainText(method, "METHOD");
    params = await buildParams(context, parsed.values.get("params"), parsed.lists.get("pairs") ?? []);
    if (requestLength(method, params) > MAX_LINE_BYTES) throw new ParamsError("the request is over 1 MB, the most Ardia's control socket takes in one line");
  } catch (error) {
    if (!(error instanceof ParamsError)) throw error;
    context.noteErrorCode("bad_params");
    context.complain(`ardia call: ${error.message}`);
    return 2;
  }
  let outcome: Outcome;
  try {
    outcome = await send(context, dataDir, method, params, timeout);
  } catch (error) {
    const failure = failureOf(error, context);
    if (failure === undefined || failure.kind === "method") throw error;
    return unreachableExit(context, failure, method);
  }
  if (!outcome.ok) {
    context.noteErrorCode(recordedCode(outcome.code));
    let hint = "";
    if (outcome.catalog !== undefined) hint = didYouMean(method, names(outcome.catalog));
    else if (outcome.code === "unknown_method") hint = " (this Ardia can't list its methods, so it may be too old for this one: update Ardia)";
    context.complain(`ardia call: ${outcome.message}${hint}`);
    return 1;
  }
  const result = outcome.result;
  if (parsed.flags.has("json")) await context.say(pretty(result));
  else if (result === null) await context.say(`✓ ${shown(method)}`);
  else await context.say(readable(result).join("\n"));
  return 0;
}

function describe(row: JsonObject): string {
  const name = row.get("name") as string;
  const lines = [shown(name) + (mutates(row) ? "  (changes things)" : "  (reads only)")];
  if (truthy(row.get("description"))) lines.push(shown(strOf(row.get("description"))));
  for (const key of ["params", "result"]) {
    const value = row.get(key);
    if (value !== undefined && value !== null) {
      lines.push(`${key}:`);
      lines.push(...readable(value, 1));
    }
  }
  const hidden = new Set(["name", "description", "params", "result", "mutates", "mutating"]);
  const extra: JsonObject = new Map([...row].filter(([key]) => !hidden.has(key)));
  if (extra.size > 0) lines.push(...readable(extra));
  return lines.join("\n");
}

export async function runMethods(context: Context, parsed: Parsed): Promise<number> {
  const dataDir = parsed.values.get("data_dir");
  const wanted = parsed.values.get("name");
  const json = parsed.flags.has("json");
  let catalog: Value;
  try {
    catalog = await withSession(dataDir, (session) => session.call("methods", undefined, CALL_TIMEOUT, true));
  } catch (error) {
    const failure = failureOf(error);
    if (failure === undefined) throw error;
    if (failure.kind === "invalid") {
      noteUnreachable(context, failure);
      context.complain(`ardia methods: ${failure.message}`);
      return 2;
    }
    if (failure.kind === "method") {
      context.noteErrorCode(recordedCode(failure.code));
      if (failure.code === "unknown_method") {
        context.noteErrorCode("methods_unsupported");
        context.complain(`ardia methods: ${TOO_OLD}`);
      } else context.complain(`ardia methods: ${failure.message}`);
      return 1;
    }
    return unreachableExit(context, failure, undefined);
  }
  const rows = entries(catalog);
  if (rows.some((row) => typeof row.get("name") !== "string")) throw new HandBack();
  if (wanted !== undefined) {
    const row = rows.find((item) => item.get("name") === wanted);
    if (row === undefined) {
      context.complain(`ardia methods: Ardia has no method ${wanted}${didYouMean(wanted, names(catalog))}`);
      return 1;
    }
    await context.say(json ? pretty(row) : renderOrHandBack(() => describe(row)));
    return 0;
  }
  if (json) {
    await context.say(pretty(rows));
    return 0;
  }
  const width = Math.min(Math.max(0, ...rows.map((row) => charCount(row.get("name") as string))), 40);
  const lines = renderOrHandBack(() =>
    rows.map((row) => {
      const mark = mutates(row) ? "changes" : "reads  ";
      const description = truthy(row.get("description")) ? strOf(row.get("description")) : "";
      return shown(rstrip(`${left(row.get("name") as string, width)}  ${mark}  ${description}`));
    }),
  );
  for (const line of lines) await context.say(line);
  return 0;
}

function renderOrHandBack<T>(render: () => T): T {
  try {
    return render();
  } catch (error) {
    if (error instanceof Unsupported) throw new HandBack();
    throw error;
  }
}
