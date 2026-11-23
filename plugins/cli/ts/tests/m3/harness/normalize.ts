import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { canonical, redactSecrets, type Entry, type Message } from "../canon.ts";
import { DAEMON_METRICS, PYTHON_COMMAND_METRICS } from "./paths.ts";
import { isPyInt, isRecord, type Json, type JsonRecord, PyFloat } from "./pyvalues.ts";

export const STRING_IDS = new Set(["targetId", "frameId", "parentFrameId", "loaderId", "sessionId", "openerId", "openerFrameId", "browserContextId", "objectId",
  "requestId", "interceptionId", "networkId", "scriptId", "identifier", "uniqueId", "executionContextUniqueId", "uniqueContextId", "workerId", "navigationId"]);
export const INT_IDS: Record<string, string> = { nodeId: "node", parentNodeId: "node", backendNodeId: "backend", backendDOMNodeId: "backend",
  executionContextId: "context", contextId: "context" };
const SOURCE_KEYS = ["expression", "functionDeclaration", "source"];
const READY_PROBE = "() => document.readyState";
const VISIBILITY_PROBE = "() => document.visibilityState === 'hidden'";

function cachedProbe(message: Record<string, unknown>): boolean {
  return message["method"] === "Page.getFrameTree" || ((message["params"] ?? {}) as Record<string, unknown>)["functionDeclaration"] === VISIBILITY_PROBE;
}
const KEY_TEXT = "[0-9a-f]{24}";
const KEY = new RegExp(`\\b${KEY_TEXT}\\b`, "g");
const WHOLE_KEY = new RegExp(`^${KEY_TEXT}$`);
const TABS_FILE = /tabs-[0-9a-f]+/g;
const READ_STAMP = /(?<=\[read )\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC(?=\])|(?:(?<=\(read )|(?<=, read ))\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC(?=[,)])/g;
const CONSOLE_DETECTABLE = ["(Runtime is on for this tab until the session ends)", "(Runtime is on for this tab until the session ends; the page can detect this)"] as const;
const REQUEST_ROW = /^\[\d+\.\d+\](?= [A-Z]+ \S+ \()/gm;
const JSON_ERROR_CODE = /^(\{"success":false,.*),"code":"(?:command_failed|unknown_command)"\}$/gm;
const PYTHON_MOVED_TAB = /\n→ \[(t\d+)\] is this session's tab now, a background tab of its own, since this session uses your tab \[(t\d+)\] and won't navigate it; `tab \2` goes back; (?:it takes input without being shown|(this Ardia doesn't deliver input there\. use: [^\n]*))/;
const TEMP_TAB = "about:blank#ardia-temp-";
const UNCODED_FAILURE = "command_failed";
export const RECORDED_FIXTURE = 9419;
const DAEMON_METRIC_SETS = ["FLAGS", "READ_FLAGS", "ACT_FLAGS", "CHANGE_FLAGS", "FLOW_FLAGS", "SAFETY_FLAGS", "COUNTS", "ACT_COUNTS", "CHANGE_COUNTS", "FLOW_COUNTS"];

export const RULES: Record<string, string> = {
  "browser-ids": "values of the CDP ID fields in STRING_IDS and INT_IDS become <kind#n>, numbered by first appearance in the step's own requests (browser events cross step marks by timing)",
  "after-fault": "in a fault run, the faulted step's requests before the fault are left out; only the cleanup after it is compared",
  "message-id": "the top-level `id` of a request is dropped; requests are matched by content",
  concurrency: "requests on one CDP session sent while another was unanswered are one group, compared as a sorted multiset",
  scratch: "the side's scratch root (data dir, HOME, TMPDIR) becomes <SCRATCH> in answers, files and requests",
  ports: "the tap's, Chromium's and the fixture server's port become <TAP>, <CHROME> and <FIXTURE> in answers and requests (recordings made before the fixture port was stored used 9419)",
  "ids-in-answers": "browser string IDs (8+ chars) seen in the transcript become their placeholder inside answer text",
  "session-key": "24-hex session keys in file names and answers become <KEY:session>",
  "tabs-file": "the tab registry's file name hash becomes tabs-<HASH>",
  "file-times": "`pid`, `started`, `at` and any float over 1e9 (epoch seconds) inside the session folder's JSON files become <PID> and <TIME>",
  "read-stamp": "the wall-clock time in `read`'s `[read YYYY-MM-DD HH:MM:SS UTC]` line, and in a page header's `(HTTP 200, read YYYY-MM-DD HH:MM:SS UTC)`, becomes <TIME>",
  "console-detectable": "the `console` capture notice Python ends with `until the session ends)` reads `until the session ends; the page can detect this)`, the TypeScript wording (designed divergence `console-detectable`, row 8)",
  "request-rows": "the `[<renderer pid>.<n>]` request id at the start of a `network requests` row becomes `[<REQUEST>]`; Chromium numbers subresource requests by its renderer's process id, which differs between any two browsers",
  "live-sets": "live mode compares each step's requests as a set of distinct forms; order, counts and concurrency are replay's job, because Chromium's load timing decides how often the daemon polls",
  "ready-probe": "live mode ignores the `() => document.readyState` probe, which the daemon sends only when the load event hasn't arrived yet",
  "cached-probes": "live mode ignores `Page.getFrameTree` and the `document.visibilityState` probe (its request and its source hash), which the TS daemon skips when it read them in the last 0.75 s and 0.25 s (plugins#92), so two runs differ only by timing",
  "replay-order": "replay checks order in the tap: a request matches the recording within `lookahead` concurrency groups (elastic.json), so tasks that interleave by timing don't fail",
  "replay-repeats": "replay lets the read-only probes listed in elastic.json repeat or be skipped, since their count follows the daemon's sleeps",
  "unstable-steps": "live mode compares only exit and stderr of the steps a scenario lists in `unstable_steps`, and none of their requests, with the reason in the scenario",
  build: "a session's <key>.json is compared without `build`, the build stamp only the TypeScript daemon records",
  metrics: "of an answer's `metrics` only the key set is compared, never values, and without the TS-only flags and counts (tsOnlyMetrics: the ones the daemon's metrics.ts registers and Python's command_metrics, frozen in python-command-metrics.json, didn't)",
  secrets: "credential-bearing request params (continueWithAuth's username and password, Authorization/Proxy-Authorization/Cookie header values, cookie values being set) become <REDACTED>; the tap writes them redacted too, and replay matches on the redacted form",
  "racy-steps": "every mode compares only the exit status of the steps a scenario lists in `racy_steps`, where Chromium decides which of two errors the same request gets (the reason is in the scenario)",
  "whole-floats": "a whole-number float in a request's params (91.0) is compared as the integer (91): Python's json wrote 91.0 for a float, JavaScript has one number type, and Chromium reads both the same",
  "fixture-dir": "the checkout's own fixture folder (recorded in subs) becomes {fixture_dir} in answers and requests, so a recording replays from any clone",
  "temp-tab-nonce": "a temporary tab's `Target.createTarget` URL `about:blank#ardia-temp-<nonce>` (the TS daemon marks the tabs it opens only to read, so a sweep can find one a crashed daemon left) becomes `about:blank`, Python's URL",
  "uncoded-failure": "an answer's `code` `command_failed`, which the TypeScript daemon gives a failure that has no code of its own (a batch line, a `wait` or `is` that reported one) where Python's daemon sent none, compares as no code on an exit-1 answer only; so does the code of an exit-1 `batch` answer that names a `failed_step_command` other than `close`: the first failed line's code, which Python's daemon didn't lift to the batch (a failed trailing close keeps its code, as Python's did)",
  "json-error-code": "a `--json` failure envelope's trailing `\"code\":\"command_failed\"` or `\"code\":\"unknown_command\"`, which the TypeScript client adds to a daemon error line that has no code (docs/cli.md, the error code table; designed divergence `json-error-code`) and Python's client printed without, is dropped",
  "open-moved-tab": "Python's `open` notice on a tab taken with `tab active` (`→ [t3] is this session's tab now, … goes back; …` after the title) reads as the TypeScript one, `→ Opened in a new background tab [t3]; the tab you picked with `tab active` [t2] is unchanged (…)` before the title (docs/cli.md, `tab active`; designed divergence `open-moved-tab`)",
  divergences: "designed TS differences from divergences.ts (`world-handle` always, the rest when a scenario names them) rewrite only the request fields they name, on both sides, before IDs are numbered",
};

export type Step = { exit?: Json; out?: Json; err?: Json; answers?: Json; [key: string]: Json | undefined };
export type RunResult = { root: string; transcript: string; steps: Step[]; files: JsonRecord; subs: JsonRecord; tap?: JsonRecord };
export type Shaped = { answers: Json[]; files: JsonRecord; requests: Record<string, unknown>; request_sets: Record<string, unknown>; sources: Record<string, unknown> };
export type Rewrite = { reply(key: string, message: Message): void; rewrite(message: Message, key: string): Message | null };

let tsOnly: Set<string> | undefined;

export function tsOnlyMetrics(): Set<string> {
  if (tsOnly !== undefined) return tsOnly;
  const source = readFileSync(DAEMON_METRICS, "utf8");
  const daemon = new Set<string>();
  for (const name of DAEMON_METRIC_SETS) {
    const body = new RegExp(`export const ${name} = new Set\\(\\[(.*?)\\]\\);`, "s").exec(source);
    if (body === null) throw new Error(`metrics.ts has no ${name} set`);
    for (const found of (body[1] as string).matchAll(/"([a-z0-9_]+)"/g)) daemon.add(found[1] as string);
  }
  const python = new Set(JSON.parse(readFileSync(PYTHON_COMMAND_METRICS, "utf8")) as string[]);
  tsOnly = new Set([...daemon].filter((name) => !python.has(name)));
  return tsOnly;
}

export function load(file: string): Entry[] {
  let raw = readFileSync(file);
  if (file.endsWith(".gz")) raw = gunzipSync(raw);
  return raw.toString("utf8").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Entry);
}

export function wholeNumbers(value: unknown): unknown {
  if (value instanceof PyFloat) return Number.isInteger(value.value) && Math.abs(value.value) < 2 ** 53 ? value.value : value;
  if (Array.isArray(value)) return value.map(wholeNumbers);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wholeNumbers(item)]));
  return value;
}

export function replaceText(text: string, from: string, to: string): string {
  return from ? text.split(from).join(to) : text;
}

export class Ids {
  readonly strings = new Map<string, string>();
  private readonly ints = new Map<string, string>();
  private readonly families = new Map<string, number>();

  string(value: string): string {
    let found = this.strings.get(value);
    if (found === undefined) {
      found = `<id#${this.strings.size + 1}>`;
      this.strings.set(value, found);
    }
    return found;
  }

  integer(family: string, value: number): string {
    const key = `${family}\u0000${value}`;
    let found = this.ints.get(key);
    if (found === undefined) {
      const count = (this.families.get(family) ?? 0) + 1;
      this.families.set(family, count);
      found = `<${family}#${count}>`;
      this.ints.set(key, found);
    }
    return found;
  }

  walk(value: unknown, key?: string): unknown {
    if (Array.isArray(value)) return value.map((item) => this.walk(item, key));
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, this.walk(item, name)]));
    if (key !== undefined && STRING_IDS.has(key) && typeof value === "string" && value) return this.string(value);
    if (key !== undefined && key in INT_IDS && isPyInt(value)) return this.integer(INT_IDS[key] as string, value);
    return value;
  }

  inText(text: string): string {
    const known = [...this.strings.keys()].filter((value) => value.length >= 8).sort((a, b) => b.length - a.length);
    for (const value of known) if (text.includes(value)) text = replaceText(text, value, this.strings.get(value) as string);
    return text;
  }
}

function portPattern(port: unknown): RegExp {
  return new RegExp(`(?<=127\\.0\\.0\\.1:)${port}\\b|(?<=localhost:)${port}\\b|(?<=--port )${port}\\b`, "g");
}

export class Subs {
  readonly root: string;
  readonly fixtureDir: string;
  private readonly ports: [RegExp, string][];

  constructor(subs: JsonRecord) {
    this.root = typeof subs["root"] === "string" ? subs["root"] : "";
    this.fixtureDir = typeof subs["fixture_dir"] === "string" ? subs["fixture_dir"] : "";
    const fixture = "fixture" in subs ? subs["fixture"] : RECORDED_FIXTURE;
    this.ports = ([[subs["tap"], "<TAP>"], [subs["chrome"], "<CHROME>"], [fixture, "<FIXTURE>"]] as [Json | undefined, string][])
      .filter(([port]) => typeof port === "number" && port !== 0)
      .map(([port, name]) => [portPattern(port), name]);
  }

  text(text: string): string {
    if (this.fixtureDir) text = replaceText(text, this.fixtureDir, "{fixture_dir}");
    if (this.root) text = replaceText(text, this.root, "<SCRATCH>");
    for (const [pattern, name] of this.ports) text = text.replace(pattern, name);
    return text;
  }
}

export function withoutTempNonce(message: Message): Message {
  const params = (message.params ?? {}) as Record<string, unknown>;
  if (message.method === "Target.createTarget" && String(params["url"] || "").startsWith(TEMP_TAB)) return { ...message, params: { ...params, url: "about:blank" } };
  return message;
}

function sha16(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function parsed(text: string | undefined): Message | null {
  if (text === undefined) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Message) : null;
  } catch {
    return null;
  }
}

export function transcript(entries: Entry[], subs: Subs, rewrite: Rewrite | null = null): { shaped: Pick<Shaped, "requests" | "request_sets" | "sources">; ids: Ids } {
  const ids = new Ids();
  let local = new Ids();
  let setLocal = new Ids();
  let step = "setup";
  const steps = new Map<string, Map<string, string[][]>>();
  const setSteps = new Map<string, Map<string, Set<string>>>();
  const openBySession = new Map<string, Set<unknown>>();
  const sessionOf = new Map<string, string>();
  const sources = new Map<string, Set<string>>();
  const dropped = new Set<string>();
  for (const entry of entries) {
    const kind = entry.k;
    if (kind === "mark") {
      step = String(entry.step === undefined ? "None" : entry.step);
      local = new Ids();
      setLocal = new Ids();
      continue;
    }
    if (kind === "fault") {
      step = `${step}/after-fault`;
      continue;
    }
    if (kind !== "in" && kind !== "out") continue;
    let message = parsed(entry.m);
    if (message === null) continue;
    const conn = entry.c ?? 0;
    if (kind === "in") {
      const key = `${conn}:${message.id}`;
      if (dropped.has(key)) {
        dropped.delete(key);
        rewrite?.reply(key, message);
        continue;
      }
      ids.walk(message);
      const session = sessionOf.get(key);
      if (session !== undefined) {
        sessionOf.delete(key);
        openBySession.get(session)?.delete(message.id);
      }
      continue;
    }
    if (!("method" in message) || !("id" in message)) continue;
    message = redactSecrets(message);
    if (rewrite !== null) {
      const rewritten = rewrite.rewrite(message, `${conn}:${message.id}`);
      if (rewritten === null) {
        dropped.add(`${conn}:${message.id}`);
        continue;
      }
      message = rewritten;
    }
    message = withoutTempNonce(message);
    const sessionId = message.sessionId || "";
    const session = `${conn}\u0000${sessionId}`;
    ids.walk(message);
    const { id: _id, ...rest } = message;
    const normalized = local.walk(rest);
    const form = subs.text(canonical(wholeNumbers(normalized)));
    const byStep = steps.get(step) ?? new Map<string, string[][]>();
    steps.set(step, byStep);
    const label = `${conn}:${sessionId ? (local.walk(sessionId, "sessionId") as string) : "browser"}`;
    const groups = byStep.get(label) ?? [];
    byStep.set(label, groups);
    const waiting = openBySession.get(session) ?? new Set<unknown>();
    openBySession.set(session, waiting);
    if (waiting.size === 0 || groups.length === 0) groups.push([]);
    (groups[groups.length - 1] as string[]).push(form);
    if (!cachedProbe(message)) {
      const setForm = subs.text(canonical(wholeNumbers(setLocal.walk(rest))));
      const setSession = `${conn}:${sessionId ? (setLocal.walk(sessionId, "sessionId") as string) : "browser"}`;
      const setByStep = setSteps.get(step) ?? new Map<string, Set<string>>();
      setSteps.set(step, setByStep);
      const forms = setByStep.get(setSession) ?? new Set<string>();
      setByStep.set(setSession, forms);
      forms.add(setForm);
    }
    waiting.add(message.id);
    sessionOf.set(`${conn}:${message.id}`, session);
    for (const name of SOURCE_KEYS) {
      const source = ((message.params ?? {}) as Record<string, unknown>)[name];
      if (typeof source === "string" && source !== READY_PROBE && source !== VISIBILITY_PROBE) {
        const found = sources.get(step) ?? new Set<string>();
        sources.set(step, found);
        found.add(sha16(subs.text(source)));
      }
    }
  }
  const requests: Record<string, unknown> = {};
  const sets: Record<string, unknown> = {};
  for (const [name, sessions] of steps) {
    const shapedSessions: Record<string, string[][]> = {};
    for (const [session, groups] of sessions) shapedSessions[session] = groups.map((group) => [...group].sort());
    requests[name] = shapedSessions;
  }
  for (const [name, sessions] of setSteps) {
    const setSessions: Record<string, string[]> = {};
    for (const [session, forms] of sessions) setSessions[session] = [...forms].filter((form) => !form.includes(READY_PROBE)).sort();
    sets[name] = setSessions;
  }
  const shapedSources: Record<string, unknown> = {};
  for (const [name, found] of sources) shapedSources[name] = [...found].sort();
  return { shaped: { requests, request_sets: sets, sources: shapedSources }, ids };
}

function keyed(text: string, keys: Map<string, string>): string {
  return text.replace(KEY, (found) => keys.get(found) ?? "<KEY>");
}

export function typescriptMovedTab(text: string): string {
  const found = PYTHON_MOVED_TAB.exec(text);
  if (found === null) return text;
  const [whole, tab, left, noInput] = found;
  const notice = `→ Opened in a new background tab [${tab}]; the tab you picked with \`tab active\` [${left}] is unchanged (\`open --here <url>\` navigates it, \`tab ${left}\` goes back)\n`;
  const after = noInput ? `\n→ Opened in its own background tab [${tab}]; ${noInput}` : "";
  return `${notice}${text.slice(0, found.index)}${after}${text.slice(found.index + whole.length)}`;
}

export function withoutClientErrorCode(text: string): string {
  return text.replace(JSON_ERROR_CODE, "$1}");
}

export function answer(step: Step, subs: Subs, ids: Ids, keys: Map<string, string>): JsonRecord {
  const clean = (text: Json | undefined) => {
    const typescriptForm = withoutClientErrorCode(typescriptMovedTab(typeof text === "string" ? text : ""));
    const shaped = ids.inText(subs.text(typescriptForm)).replace(READ_STAMP, "<TIME>").replace(REQUEST_ROW, "[<REQUEST>]");
    return keyed(replaceText(shaped, CONSOLE_DETECTABLE[0], CONSOLE_DETECTABLE[1]), keys);
  };
  const fields: Json[] = [];
  const answers = Array.isArray(step.answers) ? step.answers : [];
  for (const item of answers) {
    const got = (isRecord(item) && isRecord(item["answer"]) ? item["answer"] : {}) as JsonRecord;
    const request = isRecord(item) && isRecord(item["request"]) ? item["request"] : {};
    const argv = Array.isArray(request["argv"]) && request["argv"].length > 0 ? request["argv"] : [""];
    const code = got["code"] ?? null;
    const failedStep = got["failed_step_command"] ?? null;
    const lifted = argv[0] === "batch" && failedStep !== null && failedStep !== "close";
    const exit = got["exit"] ?? null;
    const typescriptOnly = (exit === 1 || (exit instanceof PyFloat && exit.value === 1) || exit === true) && (code === UNCODED_FAILURE || lifted);
    const metrics = got["metrics"];
    fields.push({
      code: typescriptOnly ? null : code,
      busy_elsewhere: got["busy_elsewhere"] ?? null,
      exit,
      metrics: isRecord(metrics) ? Object.keys(metrics).filter((name) => !tsOnlyMetrics().has(name)).sort() : metrics !== undefined && metrics !== null,
    });
  }
  return { exit: step.exit ?? null, out: clean(step.out ?? ""), err: clean(step.err ?? ""), answers: fields };
}

export function sessionKeys(files: JsonRecord): Map<string, string> {
  const keys = new Map<string, string>();
  for (const [name, entry] of Object.entries(files)) {
    const stem = name.endsWith(".json") ? name.slice(0, -5) : name;
    const json = isRecord(entry) ? entry["json"] : undefined;
    if (WHOLE_KEY.test(stem) && isRecord(json)) keys.set(stem, `<KEY:${pyStr(json["session"] ?? null)}>`);
  }
  return keys;
}

function pyStr(value: Json): string {
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function floatOverEpoch(value: unknown): boolean {
  if (value instanceof PyFloat) return value.value > 1e9;
  return typeof value === "number" && !Number.isInteger(value) && value > 1e9;
}

export function fileValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => fileValue(item, key));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, fileValue(item, name)]));
  if (key === "pid") return "<PID>";
  if (key === "started" || key === "at" || floatOverEpoch(value)) return "<TIME>";
  return value;
}

export function files(found: JsonRecord, subs: Subs, ids: Ids, keys: Map<string, string>): JsonRecord {
  const shaped: JsonRecord = {};
  for (const [name, raw] of Object.entries(found)) {
    const entry = (isRecord(raw) ? raw : {}) as JsonRecord;
    const clean = keyed(name, keys).replace(TABS_FILE, "tabs-<HASH>");
    const item: JsonRecord = { mode: entry["mode"] ?? null, kind: entry["kind"] ?? null };
    if ("json" in entry) {
      let value = entry["json"] ?? null;
      const stem = name.endsWith(".json") ? name.slice(0, -5) : name;
      if (WHOLE_KEY.test(stem) && isRecord(value)) value = Object.fromEntries(Object.entries(value).filter(([field]) => field !== "build")) as JsonRecord;
      const text = ids.inText(subs.text(JSON.stringify(ids.walk(fileValue(value)))));
      item["json"] = JSON.parse(keyed(text, keys)) as Json;
    }
    shaped[clean] = item;
  }
  return shaped;
}

const UNSTABLE = "<unstable>";
const RACY = "<racy>";

export function run(result: RunResult, unstable: number[] | null = null, racy: number[] | null = null, rewrite: Rewrite | null = null): Shaped {
  const subs = new Subs(result.subs);
  const { shaped: requests, ids } = transcript(load(result.transcript), subs, rewrite);
  const keys = sessionKeys(result.files);
  const answers: JsonRecord[] = result.steps.map((step) => answer(step, subs, ids, keys));
  for (const index of unstable ?? []) {
    const found = answers[index];
    if (found !== undefined) answers[index] = { exit: found["exit"] ?? null, err: found["err"] ?? null, out: UNSTABLE, answers: UNSTABLE };
    for (const part of [requests.requests, requests.request_sets, requests.sources]) if (String(index) in part) part[String(index)] = UNSTABLE;
  }
  for (const index of racy ?? []) {
    const found = answers[index];
    if (found !== undefined) answers[index] = { exit: found["exit"] ?? null, err: RACY, out: RACY, answers: RACY };
  }
  return { answers, files: files(result.files, subs, ids, keys), ...requests };
}
