import { createHash } from "node:crypto";
import { ConfigError, readText } from "../configfiles.ts";
import { checkEvents, DECIDE_EVENTS, EVENTS, EventNameError, isIdleEvent, NAMED_ONLY_EVENTS } from "../events.ts";
import { dumps, Float, type JsonObject, type Value } from "../json.ts";
import { NeedsPython } from "../paths.ts";
import { didYouMean } from "../pylib/close.ts";
import { JsonDecodeError, JsonTooDeep, JsonValueError, parseConfigJson } from "../pylib/jsonloads.ts";
import { isSpace, strip } from "../py.ts";
import { codePoints } from "../pystr.ts";
import { formatG } from "../stream.ts";
import { matches, parse as parsePattern, PatternError, type Spec, split } from "../urlmatch.ts";
import { knownZone } from "./zones.ts";

export const HOOKS_FILE = "hooks.json";
export const DEFAULT_TIMEOUT = 60;
export const HOOK_KEYS = [
  "name", "on", "at", "days", "timezone", "every", "match", "run", "command", "arg", "timeout", "idle", "fullUrls",
  "rewrite", "cancel", "route", "drop", "from", "folder", "permission", "kinds", "omnibox",
];
export const RULE_KEYS: Record<string, string> = { rewrite: "tab.opening", cancel: "tab.opening", route: "link.opening", drop: "link.opening", folder: "download.deciding", permission: "permission.requested" };
const RULE_ORDER = ["rewrite", "cancel", "route", "drop", "folder", "permission"];
const FILTER_KEYS: Record<string, string> = { from: "link.opening", kinds: "permission.requested" };
export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const OPEN_MODES = ["tab", "littleArdia", "window"];
export const MIN_IDLE = 60;
const MAX_HOOKS = 200;
const MAX_REWRITES = 50;

export class HooksError extends Error {}
export class HookValueError extends Error {}

export type Omnibox = { title: string; keyword: string | null; global: boolean };

export type HookInit = {
  name: string;
  events: string[];
  patterns?: string[];
  program?: string[];
  timeout?: number;
  specs?: Spec[];
  command?: string | null;
  arg?: string | null;
  decide?: string | null;
  rules?: boolean;
  omnibox?: Omnibox | null;
  idle?: number | null;
  fullUrls?: boolean;
  at?: string | null;
  days?: string[];
  timezone?: string | null;
  every?: number | null;
  raw?: string;
  definition?: Value;
};

export class Hook {
  readonly name: string;
  readonly events: string[];
  readonly patterns: string[];
  readonly program: string[];
  readonly timeout: number;
  readonly specs: Spec[];
  readonly command: string | null;
  readonly arg: string | null;
  readonly decide: string | null;
  readonly rules: boolean;
  readonly omnibox: Omnibox | null;
  readonly idle: number | null;
  readonly fullUrls: boolean;
  readonly at: string | null;
  readonly days: string[];
  readonly timezone: string | null;
  readonly every: number | null;
  readonly raw: string;
  private readonly sorted: Value | undefined;

  constructor(init: HookInit) {
    this.name = init.name;
    this.events = init.events;
    this.patterns = init.patterns ?? [];
    this.program = init.program ?? [];
    this.timeout = init.timeout ?? DEFAULT_TIMEOUT;
    this.specs = init.specs ?? [];
    this.command = init.command ?? null;
    this.arg = init.arg ?? null;
    this.decide = init.decide ?? null;
    this.rules = init.rules ?? false;
    this.omnibox = init.omnibox ?? null;
    this.idle = init.idle ?? null;
    this.fullUrls = init.fullUrls ?? false;
    this.at = init.at ?? null;
    this.days = init.days ?? [];
    this.timezone = init.timezone ?? null;
    this.every = init.every ?? null;
    this.raw = init.raw ?? "";
    this.sorted = init.definition;
  }

  get identity(): string {
    return JSON.stringify([this.name, this.events, this.patterns, this.program, this.timeout, this.command, this.arg, this.decide, this.rules, this.idle, this.fullUrls, this.at, this.days, this.timezone, this.every, this.raw]);
  }

  equals(other: Hook | undefined): boolean {
    return other !== undefined && other.identity === this.identity;
  }

  get scheduled(): boolean {
    return this.at !== null || this.every !== null;
  }

  get listens(): boolean {
    return !this.decide && this.omnibox === null && !this.scheduled;
  }

  get served(): boolean {
    return this.program.length > 0 && (this.decide !== null || this.omnibox !== null);
  }

  get revision(): string {
    return createHash("sha256").update(Buffer.from(this.raw, "utf8")).digest("hex").slice(0, 32);
  }

  definition(): Value {
    return this.sorted ?? new Map();
  }

  definitionHas(key: string): boolean {
    const value = this.sorted;
    return value instanceof Map && value.has(key);
  }

  wants(event: JsonObject): boolean {
    if (!this.listens) return false;
    const name = event.get("event");
    if (typeof name === "string" && NAMED_ONLY_EVENTS.includes(name)) {
      if (!this.events.includes(name)) return false;
    } else if (!this.events.includes("*") && !(typeof name === "string" && this.events.includes(name))) return false;
    const rawData = event.get("data");
    const data = rawData instanceof Map ? rawData : new Map<string, Value>();
    if (typeof name === "string" && isIdleEvent(name)) {
      if (!sameIdle(data.get("idle"), this.idle)) return false;
    }
    if (this.specs.length === 0) return true;
    const url = data.get("url");
    if (typeof url !== "string" || url === "") return false;
    const parts = split(url);
    return this.specs.some((spec) => matches(spec, parts));
  }

  trigger(): string {
    if (this.omnibox !== null) {
      const keyword = this.omnibox.keyword;
      return `omnibox ${this.omnibox.title}${keyword ? ` (keyword ${keyword})` : " (global)"}`;
    }
    if (this.at !== null) {
      const days = this.days.length > 0 ? ` on ${this.days.join(",")}` : " daily";
      return `at ${this.at}${days}${this.timezone ? ` ${this.timezone}` : ""}`;
    }
    if (this.every !== null) return `every ${formatDuration(this.every)}`;
    const idle = this.idle ? ` idle ${formatDuration(this.idle)}` : "";
    return `on ${this.events.join(",")}${idle}`;
  }

  action(): string {
    if (this.rules) return `answers in Ardia (${RULE_ORDER.filter((key) => this.definitionHas(key)).join(", ")})`;
    if (this.command) return `command ${this.command}${this.arg ? `:${this.arg}` : ""}`;
    const tail = this.decide || this.omnibox !== null ? "" : `  timeout ${formatG(this.timeout)}s`;
    return `run ${this.program.join(" ")}${tail}`;
  }

  kind(): string {
    if (this.omnibox !== null) return "omnibox";
    if (this.decide) return "decide";
    if (this.scheduled) return "scheduled";
    return this.command ? "command" : "event";
  }

  toDict(): JsonObject {
    const out: JsonObject = new Map<string, Value>([
      ["name", this.name],
      ["kind", this.kind()],
      ["on", [...this.events]],
      ["match", [...this.patterns]],
      ["run", [...this.program]],
      ["timeout", new Float(this.timeout)],
    ]);
    const optional: [string, Value | null][] = [
      ["command", this.command],
      ["arg", this.arg],
      ["decide", this.decide],
      ["idle", this.idle === null ? null : BigInt(this.idle)],
      ["at", this.at],
      ["every", this.every === null ? null : BigInt(this.every)],
      ["timezone", this.timezone],
    ];
    for (const [key, value] of optional) if (value !== null) out.set(key, value);
    if (this.days.length > 0) out.set("days", [...this.days]);
    if (this.omnibox !== null) {
      out.set(
        "omnibox",
        new Map<string, Value>([
          ["title", this.omnibox.title],
          ["keyword", this.omnibox.keyword],
          ["global", this.omnibox.global],
        ]),
      );
    }
    if (this.rules) out.set("answers", this.action());
    return out;
  }
}

function sameIdle(value: Value | undefined, idle: number | null): boolean {
  if (idle === null) return value === null || value === undefined;
  if (typeof value === "bigint") return value === BigInt(idle);
  if (value instanceof Float) return value.value === idle;
  if (value === true) return idle === 1;
  if (value === false) return idle === 0;
  return false;
}

export function formatDuration(seconds: number): string {
  for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60]] as const) {
    if (seconds % size === 0) return `${seconds / size}${unit}`;
  }
  return `${seconds}s`;
}

function asciiDigits(text: string): boolean {
  return /^[0-9]+$/.test(text);
}

function pyIsDigit(text: string): boolean {
  if (text === "") return false;
  if (asciiDigits(text)) return true;
  if ([...text].every((ch) => /\p{Nd}|\p{No}/u.test(ch))) throw new NeedsPython("non-ASCII digits in a duration or time");
  return false;
}

export function parseDuration(value: Value | undefined): number | null {
  if (typeof value !== "string") return null;
  const text = strip(value, isSpace);
  const points = codePoints(text);
  if (points.length < 2) return null;
  const unit = points[points.length - 1] as string;
  const digits = points.slice(0, -1).join("");
  if (!pyIsDigit(digits) || !"smhd".includes(unit) || unit.length !== 1) return null;
  const size = { s: 1, m: 60, h: 3600, d: 86400 }[unit as "s" | "m" | "h" | "d"];
  const count = Number(digits);
  if (!Number.isSafeInteger(count * size)) throw new NeedsPython("a duration too long for exact arithmetic");
  return count * size;
}

function numberOf(value: Value | undefined): number | undefined {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Float) return value.value;
  return undefined;
}

export function checkTimeout(value: Value | number | undefined): number {
  const number = typeof value === "number" ? value : numberOf(value);
  if (number === undefined || !(number > 0 && number <= 86400)) throw new HookValueError("timeout must be a number of seconds, more than 0 and at most 86400");
  return number;
}

export function checkHookEvents(names: readonly string[]): string[] {
  const known = [...EVENTS, ...DECIDE_EVENTS];
  for (const name of names) {
    if (name !== "*" && !known.includes(name)) throw new HookValueError(`unknown event ${name}${didYouMean(name, known)}; events: ${known.join(", ")}`);
  }
  return [...names];
}

export function parsePatterns(patterns: readonly string[]): Spec[] {
  const specs: Spec[] = [];
  for (const pattern of patterns) {
    try {
      specs.push(parsePattern(pattern));
    } catch (error) {
      if (error instanceof PatternError) throw new HookValueError(`bad match pattern ${pattern}: ${error.message}`);
      throw error;
    }
  }
  return specs;
}

export function makeHook(name: string, eventNames: readonly string[], patterns: readonly string[], program: readonly string[], timeout: number = DEFAULT_TIMEOUT, idle: number | null = null, fullUrls = false): Hook {
  let events: string[];
  try {
    events = checkEvents(eventNames);
  } catch (error) {
    if (error instanceof EventNameError) throw new HookValueError(error.message);
    throw error;
  }
  if (events.length === 0) throw new HookValueError("give at least one event");
  const idleEvents = events.filter(isIdleEvent);
  if (idleEvents.length > 0 && idle === null) throw new HookValueError(`${idleEvents[0]} needs an idle threshold, like --idle 30m`);
  if (idle !== null && (idleEvents.length === 0 || idle < MIN_IDLE)) throw new HookValueError("--idle goes with tab.idle, tab.resumed, user.idle or user.active and is at least 1m");
  const specs = parsePatterns(patterns);
  if (program.length === 0 || !program.every((part) => part !== "" && !part.includes("\0"))) throw new HookValueError("run must be a non-empty list of strings: [program, args…]");
  return new Hook({ name, events, patterns: [...patterns], program: [...program], timeout: checkTimeout(timeout), specs, idle, fullUrls });
}

function compareCodePoints(a: string, b: string): number {
  const left = codePoints(a);
  const right = codePoints(b);
  for (let at = 0; at < Math.min(left.length, right.length); at += 1) {
    const x = (left[at] as string).codePointAt(0) as number;
    const y = (right[at] as string).codePointAt(0) as number;
    if (x !== y) return x - y;
  }
  return left.length - right.length;
}

export function sortedKeys(value: Value): Value {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value instanceof Map) return new Map([...value.entries()].sort(([a], [b]) => compareCodePoints(a, b)).map(([key, item]) => [key, sortedKeys(item)] as [string, Value]));
  return value;
}

export function canonical(value: Value): string {
  return dumps(sortedKeys(value), "compact");
}

function stringList(value: Value | undefined): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function strings(value: Value | undefined): Value | undefined {
  return typeof value === "string" ? [value] : value;
}

function checkTrigger(item: JsonObject): void {
  const triggers = ["on", "at", "every", "omnibox"].filter((key) => item.has(key));
  if (triggers.length !== 1) throw new HookValueError("give exactly one of on, at, every or omnibox");
  if (item.has("at")) {
    const at = item.get("at");
    const points = typeof at === "string" ? codePoints(at) : [];
    const ok =
      typeof at === "string" &&
      points.length === 5 &&
      points[2] === ":" &&
      pyIsDigit(points.slice(0, 2).join("")) &&
      pyIsDigit(points.slice(3).join("")) &&
      Number(points.slice(0, 2).join("")) <= 23 &&
      Number(points.slice(3).join("")) <= 59;
    if (!ok) throw new HookValueError('at must be a time like "09:00"');
  }
  if (item.has("days")) {
    if (!item.has("at")) throw new HookValueError("days only goes with at");
    const days = item.get("days");
    if (!stringList(days) || days.length === 0 || days.some((day) => !DAYS.includes(day))) throw new HookValueError(`days must be a list of ${DAYS.join(", ")}`);
  }
  if (item.has("timezone")) {
    const zone = item.get("timezone");
    if (!item.has("at") || typeof zone !== "string") throw new HookValueError("timezone goes with at and is a name like Europe/Paris");
    if (!knownZone(zone)) throw new HookValueError(`timezone ${zone} isn't a known time zone`);
  }
  if (item.has("every")) {
    const every = parseDuration(item.get("every"));
    if (every === null || every < 60) throw new HookValueError('every must be a duration like "15m" or "1h", at least 1m');
  }
}

function lowerStartsWithHttp(target: string): boolean {
  const lowered = target.toLowerCase();
  return lowered.startsWith("http://") || lowered.startsWith("https://");
}

function checkRules(item: JsonObject, decide: string | null): void {
  if (item.has("rewrite")) {
    const rules = item.get("rewrite");
    if (!Array.isArray(rules) || rules.length < 1 || rules.length > MAX_REWRITES) throw new HookValueError(`rewrite must be a list of 1 to ${MAX_REWRITES} {"match", "to"} rules`);
    for (const rule of rules) {
      if (!(rule instanceof Map) || rule.size !== 2 || !rule.has("match") || !rule.has("to") || typeof rule.get("match") !== "string" || typeof rule.get("to") !== "string") {
        throw new HookValueError('each rewrite rule is {"match": pattern, "to": URL}');
      }
      parsePatterns([rule.get("match") as string]);
      const to = rule.get("to") as string;
      let target = to;
      for (const lead of ["{url}", "{origin}"]) if (target.startsWith(lead)) target = `https://x${target.slice(lead.length)}`;
      if (!lowerStartsWithHttp(target)) throw new HookValueError(`rewrite to ${to} must be an http or https URL`);
    }
  }
  for (const key of ["cancel", "drop"]) {
    if (item.has(key) && item.get(key) !== true) throw new HookValueError(`${key} must be true`);
  }
  if (item.has("route")) {
    const route = item.get("route");
    if (!(route instanceof Map) || [...route.keys()].some((key) => key !== "profile" && key !== "open") || route.size === 0) {
      throw new HookValueError('route is {"profile"?: name, "open"?: "tab" | "littleArdia" | "window"}');
    }
    if (route.has("profile")) {
      const profile = route.get("profile");
      if (typeof profile !== "string" || profile === "") throw new HookValueError("route.profile must be a profile name or id");
    }
    if (route.has("open")) {
      const open = route.get("open");
      if (typeof open !== "string" || !OPEN_MODES.includes(open)) throw new HookValueError(`route.open must be ${OPEN_MODES.join(", ")}`);
    }
  }
  if (item.has("folder")) {
    const folder = item.get("folder");
    if (typeof folder !== "string" || !folder.startsWith("~/")) throw new HookValueError("folder must be a path under your home folder, starting with ~/");
    if (folder.split("/").some((part) => part === "." || part === "..")) throw new HookValueError("folder can't contain . or .. parts");
  }
  if (item.has("permission")) {
    const permission = item.get("permission");
    if (typeof permission !== "string" || !["allow", "deny", "ask"].includes(permission)) throw new HookValueError("permission must be allow, deny or ask");
  }
  const answers = RULE_ORDER.filter((key) => item.has(key));
  if (answers.length > 1 && !(decide === "tab.opening" && item.has("rewrite") && !item.has("cancel"))) throw new HookValueError("give one answer: one of the decide keys");
}

function isSpaceChar(ch: string): boolean {
  return isSpace(ch);
}

function checkOmnibox(value: Value | undefined): Omnibox {
  if (!(value instanceof Map) || [...value.keys()].some((key) => !["title", "keyword", "global"].includes(key))) {
    throw new HookValueError('omnibox is {"title", "keyword"} or {"title", "global": true}');
  }
  const title = value.get("title");
  if (typeof title !== "string" || strip(title, isSpace) === "") throw new HookValueError("omnibox needs a title");
  const keyword = value.get("keyword");
  if (keyword !== undefined && keyword !== null) {
    const points = typeof keyword === "string" ? codePoints(keyword) : [];
    if (typeof keyword !== "string" || points.length < 1 || points.length > 32 || points.some(isSpaceChar)) throw new HookValueError("omnibox.keyword must be one word");
  }
  if (value.has("global") && value.get("global") !== true) throw new HookValueError("omnibox.global must be true");
  if (value.has("keyword") === value.has("global")) throw new HookValueError("omnibox takes a keyword or global: true, not both");
  return { title: strip(title, isSpace), keyword: typeof keyword === "string" ? keyword : null, global: value.get("global") === true };
}

export function hookFrom(item: JsonObject): Hook {
  const name = item.get("name") as string;
  const unknown = [...item.keys()].filter((key) => !HOOK_KEYS.includes(key));
  if (unknown.length > 0) throw new HookValueError(`unknown key ${unknown[0]}${didYouMean(unknown[0] as string, HOOK_KEYS)}`);
  checkTrigger(item);
  const events = strings(item.has("on") ? item.get("on") : []);
  if (!stringList(events)) throw new HookValueError("on must be a list of event names");
  checkHookEvents(events);
  if (item.has("on") && events.length === 0) throw new HookValueError("give at least one event");
  const decide = events.find((event) => DECIDE_EVENTS.includes(event)) ?? null;
  if (decide !== null && events.length !== 1) throw new HookValueError(`${decide} goes alone in on`);
  const patterns = strings(item.has("match") ? item.get("match") : []);
  if (!stringList(patterns)) throw new HookValueError("match must be a list of match patterns");
  const specs = parsePatterns(patterns);
  const ruleKeys = [...item.keys()].filter((key) => key in RULE_KEYS);
  const actions = ["run", "command"].filter((key) => item.has(key)).length + (ruleKeys.length > 0 ? 1 : 0);
  if (actions !== 1) throw new HookValueError("give exactly one of run, command or a decide answer (rewrite, cancel, route, drop, folder, permission)");
  for (const key of [...ruleKeys, ...[...item.keys()].filter((key) => key in FILTER_KEYS)]) {
    const owner = RULE_KEYS[key] ?? FILTER_KEYS[key];
    if (decide !== owner) throw new HookValueError(`${key} only goes with on: ["${owner}"]`);
  }
  const program = item.get("run");
  if (typeof program === "string") throw new HookValueError(`run must be a list, like ["${program}"], or ["/bin/sh", "-c", "…"] for a shell line`);
  if (item.has("run") && (!stringList(program) || program.length === 0 || !program.every((part) => part !== "" && !part.includes("\0")))) {
    throw new HookValueError("run must be a non-empty list of strings: [program, args…]");
  }
  const command = item.get("command");
  if (item.has("command")) {
    if (typeof command !== "string" || command === "") throw new HookValueError("command must be a command id");
    if (decide || item.has("omnibox")) throw new HookValueError("command can't answer a decide event or the omnibox");
  }
  if (item.has("arg")) {
    if (!item.has("command")) throw new HookValueError("arg only goes with command");
    if (typeof item.get("arg") !== "string") throw new HookValueError("arg must be a string");
  }
  let timeout = DEFAULT_TIMEOUT;
  if (item.has("timeout")) {
    if (decide || item.has("omnibox") || !item.has("run")) throw new HookValueError("timeout only goes with run on events and schedules; decide and omnibox hooks have fixed deadlines");
    timeout = checkTimeout(item.get("timeout"));
  }
  const idleEvents = events.filter(isIdleEvent);
  let idle: number | null = null;
  if (item.has("idle")) {
    idle = parseDuration(item.get("idle"));
    if (idleEvents.length === 0) throw new HookValueError("idle only goes with tab.idle, tab.resumed, user.idle or user.active");
    if (idle === null || idle < MIN_IDLE) throw new HookValueError('idle must be a duration like "30m", at least 1m');
  } else if (idleEvents.length > 0) throw new HookValueError(`${idleEvents[0]} needs idle, like "idle": "30m"`);
  if (item.has("fullUrls") && typeof item.get("fullUrls") !== "boolean") throw new HookValueError("fullUrls must be true or false");
  if (ruleKeys.length > 0) checkRules(item, decide);
  let omnibox: Omnibox | null = null;
  if (item.has("omnibox")) {
    omnibox = checkOmnibox(item.get("omnibox"));
    if (!item.has("run")) throw new HookValueError("an omnibox hook needs run");
  }
  for (const key of Object.keys(FILTER_KEYS)) {
    const value = strings(item.has(key) ? item.get(key) : []);
    if (!stringList(value)) throw new HookValueError(`${key} must be a list of strings`);
  }
  const definition = sortedKeys(item);
  return new Hook({
    name,
    events,
    patterns,
    program: stringList(program) ? program : [],
    timeout,
    specs,
    command: typeof command === "string" ? command : null,
    arg: typeof item.get("arg") === "string" ? (item.get("arg") as string) : null,
    decide,
    rules: ruleKeys.length > 0,
    omnibox,
    idle,
    fullUrls: item.get("fullUrls") === true,
    at: typeof item.get("at") === "string" ? (item.get("at") as string) : null,
    days: stringList(item.get("days")) ? (item.get("days") as string[]) : [],
    timezone: typeof item.get("timezone") === "string" ? (item.get("timezone") as string) : null,
    every: item.has("every") ? parseDuration(item.get("every")) : null,
    raw: dumps(definition, "compact"),
    definition,
  });
}

export function parseHooks(text: string): Hook[] {
  let document: Value;
  try {
    document = parseConfigJson(text);
  } catch (error) {
    if (error instanceof JsonDecodeError) throw new HooksError(`${HOOKS_FILE} doesn't parse: line ${error.lineno} column ${error.colno}: ${error.msg}`);
    if (error instanceof JsonValueError) throw new HooksError(`${HOOKS_FILE} doesn't parse: ${error.message}`);
    if (error instanceof JsonTooDeep) throw new NeedsPython("hooks.json nests deeper than Python's recursion limit");
    throw error;
  }
  const list = document instanceof Map ? document.get("hooks") : undefined;
  if (!(document instanceof Map) || !Array.isArray(list)) throw new HooksError(`${HOOKS_FILE} must be an object with a "hooks" list`);
  if (list.length > MAX_HOOKS) throw new HooksError(`${HOOKS_FILE} has more than ${MAX_HOOKS} hooks`);
  const hooks: Hook[] = [];
  const problems: string[] = [];
  const names = new Set<string>();
  list.forEach((item, index) => {
    let label = `hook ${index + 1}`;
    if (!(item instanceof Map)) {
      problems.push(`${label} must be an object`);
      return;
    }
    const name = item.get("name");
    if (typeof name !== "string" || strip(name, isSpace) === "") {
      problems.push(`${label} needs a name`);
      return;
    }
    label = `hook ${name}`;
    if (names.has(name)) {
      problems.push(`${label}: the name is used twice`);
      return;
    }
    names.add(name);
    try {
      hooks.push(hookFrom(item));
    } catch (error) {
      if (error instanceof HookValueError) problems.push(`${label}: ${error.message}`);
      else throw error;
    }
  });
  if (problems.length > 0) throw new HooksError(problems.join("; "));
  return hooks;
}

export function readHooks(path: string): Hook[] {
  let text: string;
  try {
    text = readText(path);
  } catch (error) {
    if (error instanceof ConfigError) throw new HooksError(error.message);
    throw error;
  }
  return parseHooks(text);
}
