import type { Option, Parsed, Spec } from "./argv.ts";
import { didYouMean } from "./closest.ts";
import { withSession } from "./control.ts";
import { dumps, type JsonObject, object, type Value } from "./json.ts";
import { shown } from "./printable.ts";
import { isNumber, iterateOrEmpty, number, PythonError, strOf, truthy, Unsupported } from "./py.ts";
import { HookValueError, parseDurationExact } from "./hooks/model.ts";
import { intOfDigits, isDigits, PyException } from "./pylib/str.ts";
import { codePoints } from "./pystr.ts";
import { type Context, failureOf, HandBack, noteUnreachable } from "./runner.ts";

export const EVENTS = [
  "window.opened",
  "window.closed",
  "window.focused",
  "tab.opened",
  "tab.closed",
  "tab.activated",
  "tab.navigated",
  "settings.changed",
  "app.launched",
  "app.quitting",
  "app.activated",
  "app.deactivated",
  "tab.idle",
  "tab.resumed",
  "media.started",
  "media.stopped",
  "tab.crashed",
  "notification.shown",
  "peek.opened",
  "peek.closed",
  "littleArdia.opened",
  "split.created",
  "split.closed",
  "pin.added",
  "pin.removed",
  "tab.moved",
  "profile.switched",
  "system.sleep",
  "system.wake",
  "user.idle",
  "user.active",
  "page.error",
];
const MIN_IDLE = 60;

const DATA_DIR: Option = { names: ["--data-dir"], dest: "data_dir", kind: "value" };
const JSON_FLAG: Option = { names: ["--json"], dest: "json", kind: "flag" };

export const RUN_SPEC: Spec = {
  positionals: [
    { dest: "command_id", nargs: "one" },
    { dest: "arg", nargs: "optional" },
  ],
  options: [DATA_DIR, { names: ["--window"], dest: "window", kind: "value" }, { names: ["--tab"], dest: "tab", kind: "value" }, JSON_FLAG],
};

export const EVENTS_SPEC: Spec = {
  positionals: [{ dest: "events", nargs: "many" }],
  options: [
    DATA_DIR,
    JSON_FLAG,
    { names: ["--full-urls"], dest: "full_urls", kind: "flag" },
    { names: ["--idle"], dest: "idle", kind: "value" },
  ],
};

function parseId(text: string): Value {
  if (!isDigits(text) || codePoints(text).length >= 16) return text;
  try {
    return intOfDigits(text);
  } catch (error) {
    if (error instanceof PyException) throw new PythonError(error.type, error.message);
    throw error;
  }
}

function commandIds(catalog: Value): Value[] {
  return iterateOrEmpty(catalog)
    .filter((item): item is JsonObject => item instanceof Map)
    .map((item) => item.get("id"))
    .filter((id): id is string => typeof id === "string");
}

function iterable(value: Value): boolean {
  return value === null || typeof value === "string" || Array.isArray(value) || value instanceof Map || !truthy(value);
}

function runHint(code: string, catalog: Value | undefined, command: string, arg: string | undefined): string {
  if (catalog === undefined || !iterable(catalog)) return "";
  if (code === "unknown_command") return didYouMean(command, commandIds(catalog));
  if (arg === undefined) return "";
  const spec = iterateOrEmpty(catalog).find((item) => item instanceof Map && item.get("id") === command);
  const variants = spec instanceof Map ? spec.get("variants") : undefined;
  if (!truthy(variants) || variants === undefined || !iterable(variants)) return "";
  return didYouMean(arg, iterateOrEmpty(variants));
}

type RunOutcome = { ok: true; result: Value } | { ok: false; code: string; message: string; catalog: Value | undefined };

export async function runRun(context: Context, parsed: Parsed): Promise<number> {
  let command = parsed.values.get("command_id") as string;
  let arg = parsed.values.get("arg");
  if (arg === undefined && command.includes(":")) {
    const split = command.indexOf(":");
    arg = command.slice(split + 1);
    command = command.slice(0, split);
  }
  const params: JsonObject = object([["command", command]]);
  if (arg !== undefined) params.set("arg", arg);
  const window = parsed.values.get("window");
  const tab = parsed.values.get("tab");
  if (window !== undefined) params.set("window", parseId(window));
  if (tab !== undefined) params.set("tab", parseId(tab));
  let outcome: RunOutcome;
  try {
    outcome = await withSession(parsed.values.get("data_dir"), async (session) => {
      try {
        context.committed();
        return { ok: true, result: await session.call("run", params) };
      } catch (error) {
        const failure = failureOf(error, context);
        if (failure?.kind !== "method") throw error;
        let catalog: Value | undefined;
        if (failure.code === "unknown_command" || failure.code === "bad_request") {
          try {
            const found = await session.call("commands", undefined);
            catalog = found === null ? undefined : found;
          } catch (inner) {
            if (failureOf(inner, context) === undefined) throw inner;
          }
        }
        return { ok: false, code: failure.code, message: failure.message, catalog };
      }
    });
  } catch (error) {
    const failure = failureOf(error, context);
    if (failure === undefined || failure.kind === "method") throw error;
    noteUnreachable(context, failure);
    const message = "message" in failure ? failure.message : "";
    if (failure.kind === "unreachable" && failure.sent) {
      context.complain(`ardia run: the connection dropped after the request went out, so ${command} may or may not have run (${message})`);
    } else context.complain(`ardia: ${message}`);
    return 2;
  }
  if (!outcome.ok) {
    context.complain(`ardia run: ${outcome.message}${runHint(outcome.code, outcome.catalog, command, arg)}`);
    return 1;
  }
  const json = parsed.flags.has("json");
  await context.say(json ? dumps(outcome.result, "spaced") : `ran ${command}${arg ? `:${arg}` : ""}`);
  return 0;
}


class EventsRefused extends Error {}

function checkEvents(names: string[]): string[] {
  for (const name of names) {
    if (name !== "*" && !EVENTS.includes(name)) {
      throw new EventsRefused(`unknown event ${name}${didYouMean(name, EVENTS)}; events: ${EVENTS.join(", ")}`);
    }
  }
  return names;
}

function idleSeconds(text: string | undefined): bigint | undefined {
  if (text === undefined) return undefined;
  let seconds: bigint | null;
  try {
    seconds = parseDurationExact(text);
  } catch (error) {
    if (error instanceof HookValueError) throw new EventsRefused(error.message);
    throw error;
  }
  if (seconds === null || seconds < BigInt(MIN_IDLE)) throw new EventsRefused(`--idle ${text}: give a duration like 30m, at least 1m`);
  return seconds;
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

function clock(stamp: Value | undefined): string {
  if (!isNumber(stamp) || stamp === undefined) return "--:--:--";
  let milliseconds: number;
  try {
    milliseconds = number(stamp);
  } catch (error) {
    if (error instanceof Unsupported) return "--:--:--";
    throw error;
  }
  const seconds = Math.floor(milliseconds / 1000);
  const when = new Date(seconds * 1000);
  if (Number.isNaN(when.getTime())) return "--:--:--";
  return `${two(when.getHours())}:${two(when.getMinutes())}:${two(when.getSeconds())}`;
}

function textOf(value: Value | undefined): string {
  try {
    return strOf(value);
  } catch (error) {
    if (error instanceof Unsupported) return dumps(value ?? null, "spaced");
    throw error;
  }
}

export function describeEvent(event: Value): string {
  const fields = event instanceof Map ? event : new Map<string, Value>();
  const rawData = fields.get("data");
  const data: JsonObject = rawData instanceof Map ? rawData : new Map();
  const parts = [clock(fields.get("time")), textOf(fields.get("event"))];
  if (data.has("windowId")) parts.push(`window ${textOf(data.get("windowId"))}`);
  if (data.has("tabId")) parts.push(`tab ${textOf(data.get("tabId"))}`);
  if (truthy(data.get("url"))) parts.push(textOf(data.get("url")));
  if (truthy(data.get("title"))) parts.push(dumps(data.get("title") ?? null, "spaced"));
  if (truthy(data.get("sameDocument"))) parts.push("(same document)");
  const keys = data.get("keys");
  if (data.has("keys") && Array.isArray(keys)) parts.push(keys.map(textOf).join(", "));
  if (!data.has("tabId") && truthy(data.get("profile"))) parts.push(textOf(data.get("profile")));
  return parts.map(shown).join("  ");
}

function plural(count: number): string {
  return count !== 1 ? "s" : "";
}

export async function runEvents(context: Context, parsed: Parsed): Promise<number> {
  let names: string[];
  let idle: bigint | undefined;
  try {
    const given = checkEvents(parsed.lists.get("events") ?? []);
    names = given.length > 0 ? given : ["*"];
    idle = idleSeconds(parsed.values.get("idle"));
  } catch (error) {
    if (!(error instanceof EventsRefused)) throw error;
    context.complain(`ardia events: ${error.message}`);
    return 1;
  }
  const params: JsonObject = object([["events", names]]);
  if (parsed.flags.has("full_urls")) params.set("fullUrls", true);
  if (idle !== undefined) params.set("idle", object([["tab", [idle]], ["user", [idle]]]));
  const json = parsed.flags.has("json");
  try {
    await withSession(parsed.values.get("data_dir"), async (session) => {
      context.committed();
      await session.call("subscribe", params);
      for (;;) {
        const { message, raw } = await session.nextEvent();
        const behind = session.takeDropped();
        if (behind > 0) context.complain(`ardia events: ${behind} event${plural(behind)} dropped before this one because printing fell behind`);
        const dropped = message instanceof Map ? message.get("dropped") : undefined;
        if (typeof dropped === "bigint" && dropped > 0n && !json) {
          context.complain(`ardia events: Ardia dropped ${dropped} event${dropped !== 1n ? "s" : ""} before this one`);
        }
        await context.say(json ? raw : describeEvent(message));
      }
    });
  } catch (error) {
    const failure = failureOf(error, context);
    if (failure === undefined) throw error;
    if (failure.kind === "method") {
      context.complain(`ardia events: ${failure.message}`);
      return 1;
    }
    noteUnreachable(context, failure);
    context.complain(`ardia: ${"message" in failure ? failure.message : ""}`);
    return 2;
  }
  return 0;
}
