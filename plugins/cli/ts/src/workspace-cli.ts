import { openSync, closeSync, fstatSync } from "node:fs";
import type { Option, Parsed, Positional, Spec } from "./argv.ts";
import { call as callControl } from "./control.ts";
import { dumps, type JsonObject, object, type Value } from "./json.ts";
import { errnoOf, strerror } from "./paths.ts";
import { shown } from "./printable.ts";
import { readFd } from "./privatefs.ts";
import { iterateOrEmpty, rstrip, strOf, truthy, Unsupported } from "./py.ts";
import { DecodeError, loads, TooDeepToJudge, utf8DecodeMessage, utf8Failure } from "./pyjson.ts";
import { pretty } from "./render.ts";
import { type Context, failureOf, noteUnreachable, readStdin } from "./runner.ts";

const APPLY_TIMEOUT = 120;
const TINTS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const COLORS = ["neutral", "none", ...TINTS];
const MAX_APPLY_BYTES = 256 * 1024 * 1024;

const DATA_DIR: Option = { names: ["--data-dir"], dest: "data_dir", kind: "value" };
const JSON_FLAG: Option = { names: ["--json"], dest: "json", kind: "flag" };
const COMMON = [DATA_DIR, JSON_FLAG];
const IDS: Positional = { dest: "ids", nargs: "some" };

function value(name: string, dest = name.slice(2).replaceAll("-", "_")): Option {
  return { names: [name], dest, kind: "value" };
}

function flag(name: string, group?: string): Option {
  const option: Option = { names: [name], dest: name.slice(2).replaceAll("-", "_"), kind: "flag" };
  return group === undefined ? option : { ...option, group };
}

function placement(group: string): Option[] {
  return [
    { ...value("--before"), group },
    { ...value("--after"), group },
  ];
}

const LOOKS = [value("--icon"), { ...value("--color"), choices: COLORS }];

export const TAB_VERBS = ["open", "move", "pin", "unpin", "mute", "unmute", "sleep", "wake", "close", "activate", "rename", "icon"];
export const GROUP_VERBS = ["create", "update", "rename", "move", "ungroup", "close", "delete"];

const ID_ONLY: Spec = { positionals: [IDS], options: COMMON };

export const TAB_SPECS: Record<string, Spec> = {
  open: {
    positionals: [{ dest: "urls", nargs: "some" }],
    options: [...COMMON, value("--window"), value("--profile"), value("--group"), { ...value("--pin"), choices: ["tile", "row"] }, flag("--activate"), ...placement("spot")],
  },
  move: {
    positionals: [IDS],
    options: [...COMMON, { ...value("--group"), group: "target" }, flag("--top", "target"), value("--window"), value("--profile"), ...placement("spot")],
  },
  pin: { positionals: [IDS], options: [...COMMON, flag("--row"), flag("--tile")] },
  unpin: ID_ONLY,
  mute: ID_ONLY,
  unmute: ID_ONLY,
  sleep: ID_ONLY,
  wake: ID_ONLY,
  close: ID_ONLY,
  activate: { positionals: [{ dest: "id", nargs: "one" }], options: COMMON },
  rename: {
    positionals: [
      { dest: "id", nargs: "one" },
      { dest: "name", nargs: "optional" },
    ],
    options: COMMON,
  },
  icon: {
    positionals: [
      { dest: "id", nargs: "one" },
      { dest: "icon", nargs: "optional" },
    ],
    options: COMMON,
  },
};

const GROUP_ONLY: Spec = { positionals: [{ dest: "id", nargs: "one" }], options: COMMON };

export const GROUP_SPECS: Record<string, Spec> = {
  create: {
    positionals: [{ dest: "ids", nargs: "many" }],
    options: [
      ...COMMON,
      { names: ["--url"], dest: "url", kind: "append" },
      value("--name"),
      ...LOOKS,
      flag("--collapsed"),
      value("--parent"),
      flag("--unpinned"),
      value("--window"),
      value("--profile"),
      ...placement("spot"),
    ],
  },
  update: {
    positionals: [{ dest: "id", nargs: "one" }],
    options: [...COMMON, value("--name"), ...LOOKS, flag("--reset-icon"), flag("--collapse", "fold"), flag("--expand", "fold")],
  },
  rename: {
    positionals: [
      { dest: "id", nargs: "one" },
      { dest: "name", nargs: "one" },
    ],
    options: COMMON,
  },
  move: {
    positionals: [{ dest: "id", nargs: "one" }],
    options: [
      ...COMMON,
      { ...value("--parent"), group: "nest" },
      flag("--top", "nest"),
      flag("--pin", "pinning"),
      flag("--unpin", "pinning"),
      value("--window"),
      value("--profile"),
      ...placement("spot"),
    ],
  },
  ungroup: GROUP_ONLY,
  close: GROUP_ONLY,
  delete: GROUP_ONLY,
};

export const APPLY_SPEC: Spec = { positionals: [{ dest: "file", nargs: "optional" }], options: COMMON };

class OpRefused extends Error {}

function placed(parsed: Parsed, op: JsonObject): JsonObject {
  for (const key of ["before", "after", "window", "profile"]) {
    const given = parsed.values.get(key);
    if (given !== undefined) op.set(key, given);
  }
  return op;
}

function list(parsed: Parsed, dest: string): Value[] {
  return parsed.lists.get(dest) ?? [];
}

function optional(parsed: Parsed, dest: string): Value {
  return parsed.values.get(dest) ?? null;
}

function tabOp(verb: string, parsed: Parsed): JsonObject {
  const has = (dest: string) => parsed.flags.has(dest);
  const given = (dest: string) => parsed.values.get(dest);
  if (verb === "open") {
    const op = placed(parsed, object([["op", "open"], ["urls", list(parsed, "urls")]]));
    if (truthy(given("group") ?? null)) op.set("group", given("group") as string);
    if (truthy(given("pin") ?? null)) op.set("pin", given("pin") as string);
    if (has("activate")) op.set("activate", true);
    return op;
  }
  if (verb === "move") {
    const op = placed(parsed, object([["op", "tab.move"], ["tabs", list(parsed, "ids")]]));
    if (truthy(given("group") ?? null)) op.set("group", given("group") as string);
    else if (has("top")) op.set("group", null);
    return op;
  }
  if (verb === "pin") {
    if (has("row") && has("tile")) throw new OpRefused("give --row or --tile, not both");
    const op = object([["op", "tab.pin"], ["tabs", list(parsed, "ids")]]);
    if (has("row") || has("tile")) op.set("as", has("row") ? "row" : "tile");
    return op;
  }
  if (verb === "activate") return object([["op", "tab.activate"], ["tab", given("id") as string]]);
  if (verb === "rename") return object([["op", "tab.rename"], ["tab", given("id") as string], ["title", optional(parsed, "name")]]);
  if (verb === "icon") return object([["op", "tab.icon"], ["tab", given("id") as string], ["icon", optional(parsed, "icon")]]);
  return object([["op", `tab.${verb}`], ["tabs", list(parsed, "ids")]]);
}

function groupOp(verb: string, parsed: Parsed): JsonObject {
  const has = (dest: string) => parsed.flags.has(dest);
  const given = (dest: string) => parsed.values.get(dest);
  const id = given("id") as string;
  if (verb === "create") {
    const op = placed(parsed, object([["op", "group.create"]]));
    const ids = list(parsed, "ids");
    const urls = list(parsed, "url");
    const fields: [string, Value | undefined][] = [
      ["tabs", ids.length > 0 ? ids : undefined],
      ["urls", urls.length > 0 ? urls : undefined],
      ["name", given("name")],
      ["icon", given("icon")],
      ["color", given("color")],
      ["parent", given("parent")],
    ];
    for (const [key, item] of fields) if (item !== undefined) op.set(key, item);
    if (has("collapsed")) op.set("collapsed", true);
    if (has("unpinned")) op.set("pinned", false);
    return op;
  }
  if (verb === "update") {
    const op = object([["op", "group.update"], ["group", id]]);
    if (given("icon") !== undefined && has("reset_icon")) throw new OpRefused("give --icon or --reset-icon, not both");
    for (const key of ["name", "icon", "color"]) {
      const item = given(key);
      if (item !== undefined) op.set(key, item);
    }
    if (has("reset_icon")) op.set("icon", null);
    if (has("collapse") || has("expand")) op.set("collapsed", has("collapse"));
    if (op.size === 2) throw new OpRefused("give --name, --icon, --reset-icon, --color, --collapse or --expand");
    return op;
  }
  if (verb === "rename") return object([["op", "group.update"], ["group", id], ["name", given("name") as string]]);
  if (verb === "move") {
    const op = placed(parsed, object([["op", "group.move"], ["group", id]]));
    if (truthy(given("parent") ?? null)) op.set("parent", given("parent") as string);
    else if (has("top")) op.set("parent", null);
    if (has("pin") || has("unpin")) op.set("pinned", has("pin"));
    if (op.size === 2) throw new OpRefused("give --parent, --top, --pin, --unpin, --before, --after, --window or --profile");
    return op;
  }
  return object([["op", `group.${verb}`], ["group", id]]);
}

const VERBS: Record<string, string> = {
  open: "opened",
  "tab.move": "moved",
  "tab.pin": "pinned",
  "tab.unpin": "unpinned",
  "tab.activate": "showing",
  "tab.mute": "muted",
  "tab.unmute": "unmuted",
  "tab.close": "closed",
  "tab.rename": "renamed",
  "tab.icon": "set the icon of",
};

const GROUP_PAST: Record<string, string> = {
  "group.update": "updated",
  "group.move": "moved",
  "group.ungroup": "ungrouped",
  "group.close": "closed",
  "group.delete": "deleted",
};

function shownOf(item: Value | undefined): string {
  return item === undefined || item === null ? "" : shown(strOf(item));
}

function groupName(result: JsonObject): string {
  const group = shownOf(result.get("group"));
  const icon = result.get("icon");
  const label = result.get("label");
  const shownIcon = typeof icon === "string" && icon !== "none" && !icon.startsWith("symbol:") ? `${shown(icon)} ` : "";
  return truthy(label) ? `${shownIcon}${shownOf(label)} (${group})` : group;
}

type Titles = { lookup(id: Value): Value | undefined };

function tabName(id: Value, titles: Titles): string {
  const title = titles.lookup(id);
  return truthy(title) ? `${shownOf(title)} (${shownOf(id)})` : shownOf(id);
}

function describeResult(result: Value, titles: Titles): string {
  if (!(result instanceof Map)) throw new Unsupported();
  const op = strOf(result.has("op") ? result.get("op") : null);
  const tabs = iterateOrEmpty(result.get("tabs") ?? null).map((tab) => tabName(tab, titles));
  const outcomes = result.get("outcomes");
  if (outcomes instanceof Map) return [...outcomes].map(([tab, outcome]) => `${tabName(tab, titles)}: ${shownOf(outcome)}`).join("  ");
  if (op === "group.create") return `created group ${groupName(result)} with ${tabs.length} tab${tabs.length !== 1 ? "s" : ""}`;
  if (op === "group.ungroup") return `ungrouped ${groupName(result)}`;
  if (op.startsWith("group.")) return `${GROUP_PAST[op] ?? shown(op)} group ${groupName(result)}`;
  return rstrip(`${VERBS[op] ?? shown(op)} ${tabs.join(", ")}`);
}

function hashable(id: Value): string | undefined {
  if (id === null) return "n";
  if (typeof id === "string") return `s${id}`;
  if (typeof id === "bigint") return `i${id}`;
  if (typeof id === "boolean") return `i${id ? 1 : 0}`;
  return undefined;
}

function titlesOf(reply: JsonObject): Titles {
  const known = new Map<string, Value>();
  for (const tab of iterateOrEmpty(reply.get("tabs") ?? null)) {
    if (!(tab instanceof Map)) continue;
    const key = hashable(tab.get("id") ?? null);
    if (key === undefined) throw new Unsupported();
    known.set(key, tab.get("title") ?? null);
  }
  return {
    lookup(id: Value) {
      const key = hashable(id);
      if (key === undefined) throw new Unsupported();
      return known.get(key);
    },
  };
}

function methodFailed(context: Context, command: string, code: string, message: string): number {
  context.noteErrorCode(code);
  if (code === "unknown_method") context.complain(`ardia ${command}: this Ardia doesn't know ${command} yet; update Ardia`);
  else context.complain(`ardia ${command}: ${message}`);
  return 1;
}

async function applyOps(context: Context, parsed: Parsed, command: string, ops: Value[]): Promise<number> {
  context.noteCount("batch_steps", ops.length);
  let reply: Value;
  try {
    context.committed();
    reply = await callControl(parsed.values.get("data_dir"), "apply", object([["ops", ops]]), APPLY_TIMEOUT);
  } catch (error) {
    const failure = failureOf(error, context);
    if (failure === undefined) throw error;
    if (failure.kind === "method") return methodFailed(context, command, failure.code, failure.message);
    noteUnreachable(context, failure);
    const message = "message" in failure ? failure.message : "";
    if (failure.kind === "unreachable" && failure.sent) {
      context.complain(`ardia ${command}: the connection dropped after the request went out, so it may or may not have run (${message})`);
    } else context.complain(`ardia: ${message}`);
    return 2;
  }
  const answer: JsonObject = reply instanceof Map ? reply : new Map();
  if (parsed.flags.has("json")) await context.say(pretty(answer));
  else {
    const lines = renderLines(answer);
    for (const line of lines) await context.say(line);
  }
  const error = answer.get("error");
  if (!truthy(answer.get("ok"))) {
    const detail = error instanceof Map ? error : undefined;
    context.noteErrorCode(detail !== undefined ? codeText(detail.get("code")) : "failed");
    const message = detail !== undefined ? textOrNone(detail.get("message")) : "it failed";
    const ran = answer.has("applied") ? textOrNone(answer.get("applied")) : "0";
    const tail = ops.length > 1 ? ` (${ran} of ${ops.length} operations ran)` : "";
    context.complain(`ardia ${command}: ${message}${tail}`);
    return 1;
  }
  return 0;
}

function codeText(code: Value | undefined): string | undefined {
  return typeof code === "string" ? code : undefined;
}

function textOrNone(item: Value | undefined): string {
  try {
    return strOf(item ?? null);
  } catch (error) {
    if (error instanceof Unsupported) return dumps(item ?? null, "spaced");
    throw error;
  }
}

function renderLines(answer: JsonObject): string[] {
  try {
    const titles = titlesOf(answer);
    return iterateOrEmpty(answer.get("results") ?? null).map((result) => describeResult(result, titles));
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
    return iterateOrEmpty(answer.get("results") ?? null).map((result) => shown(textOrNone(result)));
  }
}

export async function runTabsVerb(context: Context, verb: string, parsed: Parsed): Promise<number> {
  let op: JsonObject;
  try {
    op = tabOp(verb, parsed);
  } catch (error) {
    if (!(error instanceof OpRefused)) throw error;
    context.complain(`ardia tabs ${verb}: ${error.message}`);
    return 1;
  }
  return applyOps(context, parsed, `tabs ${verb}`, [op]);
}

export async function runGroupsVerb(context: Context, verb: string, parsed: Parsed): Promise<number> {
  let op: JsonObject;
  try {
    op = groupOp(verb, parsed);
  } catch (error) {
    if (!(error instanceof OpRefused)) throw error;
    context.complain(`ardia groups ${verb}: ${error.message}`);
    return 1;
  }
  return applyOps(context, parsed, `groups ${verb}`, [op]);
}

class FileFailed extends Error {
  constructor(readonly errno: number) {
    super("file");
  }
}

function readFile(path: string): Buffer {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    throw new FileFailed(errnoOf(error));
  }
  try {
    if (fstatSync(fd).isDirectory()) throw new FileFailed(21);
    return readFd(fd, MAX_APPLY_BYTES);
  } catch (error) {
    if (error instanceof FileFailed) throw error;
    throw new FileFailed(errnoOf(error));
  } finally {
    closeSync(fd);
  }
}

function universalNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function surrogateEscapeLocale(): boolean {
  const name = [process.env.LC_ALL, process.env.LC_CTYPE, process.env.LANG].find((value) => value !== undefined && value !== "") ?? "C";
  return ["C", "POSIX", "C.UTF-8", "C.utf8", "UTF-8"].includes(name);
}

function escapedText(raw: Buffer): string {
  const parts: string[] = [];
  let rest = raw;
  for (let failure = utf8Failure(rest); failure !== undefined; failure = utf8Failure(rest)) {
    parts.push(rest.subarray(0, failure.start).toString("utf8"));
    for (const byte of rest.subarray(failure.start, failure.end)) parts.push(String.fromCharCode(0xdc00 + byte));
    rest = rest.subarray(failure.end);
  }
  parts.push(rest.toString("utf8"));
  return parts.join("");
}

function textOfInput(raw: Buffer, fromStdin: boolean): string {
  const failure = utf8Failure(raw);
  if (failure === undefined) return fromStdin ? raw.toString("utf8") : universalNewlines(raw.toString("utf8"));
  if (!fromStdin || !surrogateEscapeLocale()) throw new DecodeError(utf8DecodeMessage(raw, failure));
  const text = escapedText(raw);
  loads(text);
  throw new DecodeError(utf8DecodeMessage(raw, failure));
}

export async function runApply(context: Context, parsed: Parsed): Promise<number> {
  const file = parsed.values.get("file");
  const fromStdin = file === undefined || file === "-";
  let raw: Buffer;
  try {
    if (fromStdin) {
      context.committed();
      raw = await readStdin(MAX_APPLY_BYTES);
    } else raw = readFile(file);
  } catch (error) {
    if (!(error instanceof FileFailed)) throw error;
    context.complain(`ardia apply: ${file}: ${strerror(error.errno)}`);
    return 1;
  }
  let doc: Value;
  try {
    doc = loads(textOfInput(raw, fromStdin));
  } catch (error) {
    if (error instanceof DecodeError) {
      context.complain(`ardia apply: that isn't JSON (${error.message})`);
      return 1;
    }
    if (error instanceof TooDeepToJudge) {
      context.complain("ardia apply: that isn't JSON (maximum recursion depth exceeded while decoding a JSON array from a unicode string)");
      return 1;
    }
    throw error;
  }
  const ops = doc instanceof Map ? (doc.get("ops") ?? null) : doc;
  if (!Array.isArray(ops) || ops.length === 0) {
    context.complain('ardia apply: give a list of operations, or {"ops": [...]}');
    return 1;
  }
  return applyOps(context, parsed, "apply", ops);
}
