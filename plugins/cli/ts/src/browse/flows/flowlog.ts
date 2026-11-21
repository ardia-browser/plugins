import { type Value } from "../../json.ts";
import { codePoints } from "../../pystr.ts";
import { hostnameOf, urlsplit } from "../../pylib/urllib.ts";
import { redact } from "../../redact.ts";
import { pyLoads } from "../cdp/params.ts";
import { Cancelled, currentSignal, later, withSignal } from "../cdp/cancel.ts";
import type { Ctx } from "../commands/ctx.ts";
import { hooks } from "../commands/index.ts";
import { type Flags, leadingSelector, parse, SELECTOR_ALIAS, withSelector } from "../commands/parse.ts";
import { BrowseError, ConnectionLost, Usage } from "../daemon-errors.ts";
import * as flowurl from "../flowurl.ts";
import { FLOWLOG_FIELD } from "../js/index.ts";
import type { Page } from "../state/page.ts";
import { parseRef } from "../state/refs.ts";
import type { State } from "../state/state.ts";

export const STEP_LIMIT = 200;
export const SECRET_LIMIT = 200;
export const BODY_BUDGET = 16 * 1024 * 1024;
export const BODY_LIMIT = 2 * 1024 * 1024;
export const BODIES_PER_STEP = 8;
export const CAPTURE_BUDGET = 2.0;
export const PROBE_BUDGET = 1.5;
export const CAPTURED_TYPES = new Set(["XHR", "Fetch", "Document"]);
export const RECORDED = new Set(["open", "click", "dblclick", "fill", "type", "press", "keyboard", "select", "check", "uncheck", "find", "back", "forward",
  "reload", "scroll", "scrollintoview", "hover", "focus", "wait", "pushstate"]);
export const ON_ELEMENT = new Set(["click", "dblclick", "fill", "type", "select", "check", "uncheck", "hover", "focus", "scrollintoview"]);
export const TYPING = new Set(["fill", "type"]);
export const KEPT_HEADERS = ["accept"];
const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|cookie)$|token|csrf|xsrf|api-?key|secret|session|signature|^x-auth/iu;
const NO_HUMANIZE: Flags = { "--no-humanize": "bool" };
const COMMAND_FLAGS: Readonly<Record<string, Flags>> = {
  open: { "--enable": "multi", "--init-script": "multi", "--capture-console": "bool", "--headers": "value", "--label": "value", "--show": "bool" },
  click: { "--new-tab": "bool", "--button": "value", "--no-humanize": "bool", "--selector": "value" },
  type: { "--no-humanize": "bool", "--delay": "value" },
  find: { "--name": "value", "--exact": "bool", "--partial": "bool", "--no-humanize": "bool", "--nth": "value" },
};
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu;
const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/gu;
const ASSIGNED = /^\s*(?:(?:window|self|globalThis)\.|var\s+|let\s+|const\s+)?([A-Za-z_$][\p{L}\p{N}_$.]*(?:\[\s*['"][^'"]+['"]\s*\])*)\s*=\s*([\s\S]+?)\s*;?\s*$/u;
const SECRET_HINT = /pass|secret|token|otp|\bpin\b|cvv|cvc|card/iu;
export const FIND_ACTIONS = ["click", "fill", "type", "press", "check", "uncheck", "select", "hover", "focus", "dblclick", "text"];
export const FIND_LOCATORS = ["role", "text", "label", "placeholder", "alt", "title", "testid", "first", "last", "nth"];

export type Spec = { scriptId?: string; scriptIndex?: number };
export type Typed = { value?: string; index?: number | null; hint?: string; secret?: boolean; field?: string };
export type FlowRequest = {
  id?: string;
  method: string;
  url: string;
  type: string;
  status: number | null;
  mime: string;
  headers: Record<string, string>;
  strippedAuth: boolean;
  kind: string;
  bytes: number;
  text: string | null;
  value?: Value;
  spec?: Spec;
  evicted?: boolean;
};
export type Step = {
  seq: number;
  command: string[];
  before: string;
  replay: string[] | null;
  requests: FlowRequest[];
  origins: string[];
  unkept: string[];
  url?: string;
  ok?: boolean;
  error?: string;
  typed?: Typed;
  why?: string;
  probeAfter?: boolean;
  outer?: Step | null;
};

export class Log {
  steps: Step[] = [];
  seq = 0;
  savedThrough = 0;
  bodyBytes = 0;
  dropped = 0;
  secrets: string[] = [];

  knownSecrets(): string[] {
    const found = [...this.secrets];
    for (const step of this.steps) {
      const typed = step.typed;
      if (typed?.secret && typed.value && !found.includes(typed.value)) found.push(typed.value);
    }
    return found;
  }

  add(step: Step): void {
    this.seq += 1;
    step.seq = this.seq;
    const typed = step.typed;
    if (typed?.secret && typed.value && !this.secrets.includes(typed.value)) {
      this.secrets.push(typed.value);
      this.secrets.splice(0, Math.max(0, this.secrets.length - SECRET_LIMIT));
    }
    step.requests.forEach((request, index) => {
      request.id = `s${this.seq}r${index + 1}`;
      this.bodyBytes += request.bytes || 0;
    });
    this.steps.push(step);
    while (this.steps.length > STEP_LIMIT) {
      this.forget(this.steps.shift() as Step);
      this.dropped += 1;
    }
    for (const older of this.steps) {
      if (this.bodyBytes <= BODY_BUDGET) break;
      this.forget(older, true);
    }
  }

  forget(step: Step, keepStep = false): void {
    for (const request of step.requests) {
      if (request.text !== null) {
        this.bodyBytes -= request.bytes || 0;
        request.text = null;
        delete request.value;
        request.evicted = keepStep;
      }
    }
  }

  find(seq: number): Step | null {
    return this.steps.find((step) => step.seq === seq) ?? null;
  }
}

const LOGS = new WeakMap<State, Log>();
const SINKS = new WeakMap<State, Step | null>();

export function logOf(state: State): Log {
  let log = LOGS.get(state);
  if (log === undefined) {
    log = new Log();
    LOGS.set(state, log);
  }
  return log;
}

export const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "nic", "mil", "ltd", "plc", "nhs", "sch"]);
export const SHARED_SUFFIXES = ["github.io", "githubusercontent.com", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "web.app",
  "firebaseapp.com", "appspot.com", "herokuapp.com", "fly.dev", "onrender.com", "glitch.me", "blogspot.com",
  "azurewebsites.net", "cloudfront.net", "s3.amazonaws.com", "amplifyapp.com", "repl.co", "ngrok.io", "ngrok-free.app",
  "trycloudflare.com", "wordpress.com", "tumblr.com", "substack.com", "myshopify.com", "lovable.app", "deno.dev"];

export function baseDomain(given: string): string {
  const host = (given || "").toLowerCase().replace(/\.+$/u, "").replace(/^[[\]]+|[[\]]+$/gu, "");
  if (!host || host.includes(":") || /^[0-9.]+$/u.test(host) || !host.includes(".")) return host;
  const labels = host.split(".");
  for (const suffix of SHARED_SUFFIXES) {
    if (host.endsWith(`.${suffix}`)) return labels.slice(-(suffix.split(".").length - 1 + 2)).join(".");
  }
  if (labels.length >= 3 && (labels.at(-1) as string).length === 2 && SECOND_LEVEL.has(labels.at(-2) as string)) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

export function hostOf(url: string): string {
  try {
    return (hostnameOf(urlsplit(url).netloc) ?? "").toLowerCase();
  } catch {
    return "";
  }
}

export function firstParty(url: string, bases: ReadonlySet<string>): boolean {
  const host = hostOf(url);
  return Boolean(host) && bases.has(baseDomain(host));
}

export function keptHeaders(headers: unknown): [Record<string, string>, boolean] {
  const kept: Record<string, string> = {};
  let stripped = false;
  const entries = headers !== null && typeof headers === "object" ? Object.entries(headers as Record<string, unknown>) : [];
  for (const [name, value] of entries) {
    const lower = String(name).toLowerCase();
    if (CREDENTIAL_HEADER.test(lower)) stripped = true;
    else if (KEPT_HEADERS.includes(lower)) kept[lower] = codePoints(String(value)).slice(0, 1024).join("");
  }
  return [kept, stripped];
}

function attributes(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of text.matchAll(ATTRIBUTE)) found[(match[1] as string).toLowerCase()] = (match[2] as string).replace(/^["']+|["']+$/gu, "");
  return found;
}

function loads(text: string): Value | undefined {
  try {
    return pyLoads(text);
  } catch {
    return undefined;
  }
}

export function embeddedJson(html: string): [Spec, Value, number][] {
  const out: [Spec, Value, number][] = [];
  let index = 0;
  for (const match of html.matchAll(SCRIPT)) {
    const attrs = attributes(match[1] as string);
    const kind = (attrs["type"] ?? "").toLowerCase();
    if (kind && !kind.includes("json") && !["text/javascript", "application/javascript", "module"].includes(kind)) continue;
    let content = (match[2] as string).trim();
    if (!kind.includes("json")) {
      const assigned = ASSIGNED.exec(content);
      if (!assigned) continue;
      content = (assigned[2] as string).trim();
    }
    if (!content.startsWith("{") && !content.startsWith("[")) continue;
    const value = loads(content);
    if (value === undefined) continue;
    const spec: Spec = attrs["id"] ? { scriptId: attrs["id"] } : { scriptIndex: index };
    index += 1;
    out.push([spec, value, codePoints(content).length]);
  }
  return out;
}

export function materialize(request: FlowRequest): Value | null {
  if (Object.hasOwn(request, "value")) return request.value ?? null;
  const text = request.text;
  let value: Value | null = null;
  if (text !== null && request.kind === "document") {
    const block = heaviestBlock(text);
    if (block !== null) {
      request.spec = block[0];
      value = block[1];
    }
  } else if (text !== null) {
    const parsed = loads(text);
    value = parsed instanceof Map || Array.isArray(parsed) ? parsed : null;
  }
  request.value = value;
  return value;
}

export function looksReadable(kind: string, text: string): boolean {
  if (kind === "document") {
    const lower = text.toLowerCase();
    return lower.includes("<script") && (lower.includes("json") || lower.includes("__") || lower.includes("= {") || lower.includes("={"));
  }
  const head = text.replace(/^\s+/u, "").slice(0, 1);
  return head === "{" || head === "[";
}

export function heaviestBlock(html: string): [Spec, Value] | null {
  const blocks = embeddedJson(html);
  if (blocks.length === 0) return null;
  let best = blocks[0] as [Spec, Value, number];
  for (const block of blocks) if (block[2] > best[2]) best = block;
  return [best[0], best[1]];
}

export function extractEmbedded(html: string, spec: Spec): Value | null {
  for (const [found, value] of embeddedJson(html)) {
    if (("scriptId" in spec && found.scriptId === spec.scriptId) || ("scriptIndex" in spec && found.scriptIndex === spec.scriptIndex)) return value;
  }
  return null;
}

export function findArguments(given: string[], wanted: string | null): [string, string[], string | null] {
  let locator = given[0] as string;
  const args = given.slice(1);
  let name = wanted;
  const cut = locator.indexOf("=");
  if (cut >= 0 && FIND_LOCATORS.includes(locator.slice(0, cut))) {
    args.unshift(locator.slice(cut + 1));
    locator = locator.slice(0, cut);
  }
  if (locator === "role" && args.length > 1 && FIND_ACTIONS.includes(args[0] as string) && !FIND_ACTIONS.includes(args[1] as string)) {
    [args[0], args[1]] = [args[1] as string, args[0] as string];
  }
  if (locator === "role" && name === null && args.length >= 2 && !FIND_ACTIONS.includes(args[1] as string)) name = args.splice(1, 1)[0] as string;
  return [locator, args, name];
}

function elementTarget(state: State, selector: string): Record<string, string> | null {
  const refId = parseRef(selector);
  if (!refId) return { css: selector };
  const ref = state.refs.get(refId);
  if (ref !== undefined && ref.role && ref.name) return { role: ref.role, name: ref.name };
  return null;
}

function onElement(target: Record<string, string>, name: string, rest: string[]): string[] {
  if ("css" in target) return [name, target["css"] as string, ...rest];
  return ["find", "role", target["role"] as string, name, ...rest, "--name", target["name"] as string, "--exact"];
}

async function fieldOf(state: State, page: Page | null): Promise<Typed | null> {
  if (page === null || page.sessionId === null) return null;
  return (await page.call(FLOWLOG_FIELD, [null], { frame: state.frameFor(page) || page.mainFrame, read: true })) as Typed | null;
}

function registeredSecret(text: string): boolean {
  return Boolean(text) && redact(text) !== text;
}

function describeFind(options: Record<string, unknown>, given: string[], step: Step): void {
  if (given.length === 0) return;
  const [locator, args, wanted] = findArguments(given, (options["name"] as string | undefined) ?? null);
  const head = ["find", locator];
  let rest: string[];
  if (locator === "nth") {
    if (args.length < 2) return;
    head.push(...args.slice(0, 2));
    rest = args.slice(2);
  } else {
    if (args.length === 0) return;
    head.push(args[0] as string);
    rest = args.slice(1);
  }
  const action = rest[0] ?? "click";
  const flags = [
    ...(wanted ? ["--name", wanted] : []),
    ...(options["exact"] ? ["--exact"] : []),
    ...(options["partial"] ? ["--partial"] : []),
    ...(options["nth"] !== undefined ? ["--nth", String(options["nth"])] : []),
  ];
  if (TYPING.has(action)) {
    const text = rest.slice(1).join(" ");
    step.replay = [...head, action, text, ...flags];
    step.typed = { value: text, index: head.length + 1, hint: [...head.slice(2), wanted ?? ""].join(" ") };
    step.probeAfter = true;
  } else step.replay = [...head, action, ...rest.slice(1), ...flags];
}

async function describe(state: State, page: Page | null, name: string, argv: string[], step: Step): Promise<void> {
  let options: Record<string, unknown>;
  let args: string[];
  try {
    [options, args] = parse(name === "fill" ? leadingSelector(argv) : argv, COMMAND_FLAGS[name] ?? NO_HUMANIZE, name === "click" ? SELECTOR_ALIAS : {});
    if (name === "click") args = withSelector(options, args, 0, 0);
  } catch (error) {
    if (!(error instanceof Usage)) throw error;
    step.why = "its arguments didn't parse";
    return;
  }
  if (name === "open") {
    step.replay = args.length > 0 ? ["open", args[0] as string] : null;
    if (args.length === 0) step.why = "open without a URL";
    return;
  }
  if (ON_ELEMENT.has(name) || (name === "press" && args.length >= 2)) {
    if (args.length === 0) return;
    if (name === "click" && options["new_tab"]) {
      step.why = "click --new-tab opens another tab";
      return;
    }
    const target = elementTarget(state, args[0] as string);
    const rest = TYPING.has(name) ? [args.slice(1).join(" ")] : args.slice(1);
    if (target === null) step.why = `${args[0]} was a ref with no role and name to find it by`;
    else if ("role" in target && name === "scrollintoview") step.why = "scrollintoview of a ref has no role-based form";
    else step.replay = onElement(target, name, rest);
    if (TYPING.has(name)) {
      const hint = target ? Object.values(target).join(" ") : (args[0] as string);
      step.typed = { value: rest[0] as string, index: step.replay ? (target !== null && "role" in target ? 4 : 2) : null, hint };
      step.probeAfter = true;
    }
    return;
  }
  if (name === "keyboard") {
    if (args.length >= 2 && (args[0] === "type" || args[0] === "inserttext")) {
      const text = args.slice(1).join(" ");
      step.replay = ["keyboard", args[0] as string, text];
      step.typed = { value: text, index: 2 };
      step.probeAfter = true;
    } else step.why = "an unknown keyboard command";
    return;
  }
  if (name === "find") {
    describeFind(options, args, step);
    return;
  }
  if (name === "wait" && argv.some((arg) => arg === "--fn" || arg.startsWith("--fn="))) {
    step.why = "wait --fn runs page script";
    return;
  }
  step.replay = [name, ...argv];
}

async function within<T>(seconds: number, run: () => Promise<T>, keep: (error: unknown) => boolean = () => false): Promise<T | undefined> {
  const outer = currentSignal();
  const timer = new AbortController();
  const signal = outer === null ? timer.signal : AbortSignal.any([outer, timer.signal]);
  const stop = later(seconds * 1000, () => timer.abort(new Cancelled()));
  try {
    return await withSignal(signal, run);
  } catch (error) {
    if (outer?.aborted || keep(error)) throw error;
    return undefined;
  } finally {
    stop();
  }
}

export async function begin(ctx: Ctx, name: string, argv: string[]): Promise<Step | null> {
  const state = ctx.state;
  if (!RECORDED.has(name)) return null;
  const page = state.current ? (state.pages.get(state.current) ?? null) : null;
  const step: Step = { seq: 0, command: [name, ...argv], before: page ? page.url : "", replay: null, requests: [], origins: [], unkept: [] };
  await within(PROBE_BUDGET, () => describe(state, page, name, [...argv], step));
  step.outer = SINKS.get(state) ?? null;
  SINKS.set(state, step);
  return step;
}

export function abandon(ctx: Ctx, step: Step | null): void {
  if (step === null) return;
  SINKS.set(ctx.state, step.outer ?? null);
  delete step.outer;
}

export async function end(ctx: Ctx, step: Step | null, error: BrowseError | null = null): Promise<void> {
  if (step === null) return;
  const state = ctx.state;
  abandon(ctx, step);
  const page = state.current ? (state.pages.get(state.current) ?? null) : null;
  step.url = page ? page.url : "";
  step.ok = error === null;
  if (error !== null) step.error = error.code || "failed";
  const typed = step.typed;
  if (typed !== undefined) {
    if (step.probeAfter) {
      delete step.probeAfter;
      const found = await within(PROBE_BUDGET, () => fieldOf(state, page));
      if (found && typeof found === "object") Object.assign(typed, found);
    }
    if (registeredSecret(typed.value || "") || SECRET_HINT.test(typed.hint || "")) typed.secret = true;
  }
  logOf(state).add(step);
}

function decoded(body: Record<string, unknown>): string | null {
  const text = String(body["body"] || "");
  if (!body["base64Encoded"]) return text;
  try {
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(text.replace(/[^A-Za-z0-9+/=]/gu, "")) || text.replace(/[^A-Za-z0-9+/]/gu, "").length % 4 === 1) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(text, "base64"));
  } catch {
    return null;
  }
}

export type WatchRecord = {
  method: string;
  raw: string;
  headers: unknown;
  type: string;
  statuses: unknown[];
  done: boolean;
  mime?: string;
  failed?: string;
};
export type WatchLike = { records: ReadonlyMap<string, WatchRecord>; order: readonly string[] };

function readableType(record: WatchRecord): string | null {
  const mime = (record.mime || "").toLowerCase();
  if (record.type === "Document") return mime.includes("html") ? "document" : null;
  if (mime.includes("json") || mime.startsWith("text/plain") || !mime) return "json";
  return null;
}

export async function capture(page: Page, watch: WatchLike): Promise<void> {
  const step = SINKS.get(page.state) ?? null;
  if (step === null || watch.records.size === 0) return;
  try {
    await within(CAPTURE_BUDGET, () => collect(page, watch, step), (error) => error instanceof ConnectionLost || !(error instanceof BrowseError || error instanceof Cancelled));
  } catch (error) {
    if (error instanceof ConnectionLost) throw error;
    if (!(error instanceof BrowseError)) throw error;
  }
}

async function collect(page: Page, watch: WatchLike, step: Step): Promise<void> {
  const bases = new Set([step.before || "", page.url || ""].map((url) => baseDomain(hostOf(url))).filter((base) => base !== ""));
  let taken = 0;
  for (const requestId of [...watch.order]) {
    const record = watch.records.get(requestId);
    if (record === undefined) continue;
    const url = record.raw || "";
    if (!firstParty(url, bases)) continue;
    const method = record.method;
    const status = record.statuses.length > 0 ? (record.statuses.at(-1) as number | null) : null;
    if (method !== "GET") {
      if (["XHR", "Fetch", "Document"].includes(record.type) && status && status >= 200 && status < 300) step.unkept.push(method);
      continue;
    }
    let origin: string;
    try {
      origin = flowurl.parse(url).origin;
    } catch (error) {
      if (error instanceof flowurl.Unsafe) continue;
      throw error;
    }
    if (!step.origins.includes(origin)) step.origins.push(origin);
    const [headers, stripped] = keptHeaders(record.headers);
    const readable = CAPTURED_TYPES.has(record.type) ? readableType(record) : null;
    if (readable === null || !record.done || record.failed || !status || !(status >= 200 && status < 300) || taken >= BODIES_PER_STEP) continue;
    let text: string | null;
    try {
      text = decoded(await page.send("Network.getResponseBody", { requestId }, { timeout: CAPTURE_BUDGET }));
    } catch (error) {
      if (error instanceof BrowseError) continue;
      throw error;
    }
    if (text === null || codePoints(text).length > BODY_LIMIT || !looksReadable(readable, text)) continue;
    const entry: FlowRequest = {
      method: "GET",
      url,
      type: record.type,
      status,
      mime: record.mime || "",
      headers,
      strippedAuth: stripped,
      kind: readable,
      bytes: codePoints(text).length,
      text,
    };
    if (readable === "document" && materialize(entry) === null) continue;
    step.requests.push(entry);
    taken += 1;
  }
}

export function install(): void {
  hooks.begin = (ctx, name, argv) => begin(ctx, name, argv);
  hooks.end = (ctx, step, error) => end(ctx, step as Step | null, error);
  hooks.abandon = (ctx, step) => abandon(ctx, step as Step | null);
}

install();
