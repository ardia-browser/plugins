import fs from "node:fs";
import { dumps, Float, type Value } from "../../json.ts";
import { codePoints } from "../../pystr.ts";
import { groupThousands } from "../../pylib/format.ts";
import { compareText, PyException, pyInt, reprText } from "../../pylib/str.ts";
import { parseQsl, quote, quotePlus, unquote, unquotePlus, urlsplit, urlunsplit } from "../../pylib/urllib.ts";
import { codeOf } from "../../paths.ts";
import { HOST, pageSite } from "../../notes.ts";
import { cliVersion } from "../../version.ts";
import { plainParams } from "../cdp/params.ts";
import type { Ctx } from "../commands/ctx.ts";
import { register } from "../commands/index.ts";
import { type Flags, normalizeUrl, parse } from "../commands/parse.ts";
import { BrowseError, Usage } from "../daemon-errors.ts";
import { pyValue, Result } from "../daemon/render.ts";
import * as flowurl from "../flowurl.ts";
import { count, flag } from "../metrics.ts";
import { closeFd, entryInfo, listNames, O_CREAT, O_TRUNC, O_WRONLY, openPrivate, openPrivateFile, PathError, readPrivateJson, writeAllFd } from "../paths.ts";
import { renameAt, unlinkAt } from "../../libc.ts";
import * as shaping from "../shape.ts";
import type { State } from "../state/state.ts";
import { run } from "./flowrun.ts";
import { baseDomain, type FlowRequest, type Log, logOf, materialize, type Step, type Typed } from "./flowlog.ts";
import { type Action, actionFromReplay, actionProblem, isElementAction } from "./actions.ts";
import { applyPatch, applyProposals, loadEpisodes, parsePatch, proposals, writeEpisodes } from "./episodes.ts";
import { fixtureDir, fixtureFiles, writeFixture } from "./fixture.ts";
import { selectorOf } from "./locators.ts";

export const VERSION = 1;
export const ACTIONS_VERSION = 2;
export const DIR_NAME = "Flows";
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const PARAM_NAME = /^[a-z][a-z0-9_]{0,23}$/u;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,23}(\.[A-Za-z_][A-Za-z0-9_]{0,23})?$/u;
export const MAX_DESCRIPTION = 120;
export const HINT_DESCRIPTION = 80;
export const MAX_FLOW = 4 * 1024 * 1024;
export const REDACTED = "<redacted>";
const MIN_SUBSTRING = 3;
const NOISE_KEY = /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_[a-z]+|_ga|_gl|ref|ref_src|spm|igshid)$/iu;
const SIGNATURE_DEPTH = 6;
const SIGNATURE_KEYS = 80;
const HINT_LIMIT = 5;
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/u;
const SCRIPT_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u;
const ANY_KEY = "*";
const MAX_EXAMPLE = 40;
const MAX_WORD = 200;
const FIELDS = new Set(["version", "name", "description", "site", "origin", "startUrl", "hosts", "createdAt", "createdBy", "params", "output", "verified", "steps"]);
const V2_FIELDS = new Set([...FIELDS, "kind", "writes"]);
const KINDS = new Set(["requests", "actions"]);
const REQUIRED = ["version", "name", "site", "origin", "startUrl", "hosts", "params", "output", "steps"];
const STEP_FIELDS = new Set(["seq", "command", "url", "ok", "requests"]);
const V2_STEP_FIELDS = new Set([...STEP_FIELDS, "action"]);
const REQUEST_FIELDS = new Set(["id", "method", "url", "headers", "kind", "expect", "strippedAuth"]);
const KEPT_HEADERS = new Set(["accept"]);
const HEADER_VALUE = /^[A-Za-z0-9/*+.,;= -]{0,100}$/u;
const PARAM = /\{\{([a-z][a-z0-9_]{0,23})\}\}/gu;
const SCHEMED = /^[a-z][a-z0-9+.-]*:\/\//iu;
const HOSTED = /^(localhost|[\p{L}\p{N}_-]+(\.[\p{L}\p{N}_-]+)+)(:\p{Nd}+)?\//iu;
export const SAVE_FLAGS: Flags = { "--from": "value", "--to": "value", "--param": "multi", "--output": "value", "--description": "value", "--actions": "bool", "--fixture": "value" };
export const RUN_FLAGS: Flags = {
  "--param": "multi", "--fields": "value", "--where": "multi", "--limit": "value", "--site": "value", "--timeout": "value", "--replay": "bool", "--yes": "bool", "--fixture": "value",
};
export const HEAL_FLAGS: Flags = { "--site": "value", "--step": "value", "--selector": "value", "--role": "value", "--name": "value", "--patch": "value", "--apply": "bool", "--clear": "bool" };
const SITE_FLAGS: Flags = { "--site": "value" };
const READ_ONLY =
  "Flows are read-only for now: they keep and send GET requests only, and the answer in that range came from {methods}. Do this task in the page";
export const USAGE =
  "Usage: ardia browse flow steps [--all] | save <name> [--from n] [--to n] [--param k=v] [--output id] [--description text]\n" +
  "  | run <name> [--param k=v] [--fields a,b.c] [--where f=v] [--limit n]\n" +
  "  | list [site] | show <name> [--site s] | rm <name> [--site s]";

export type Json = Record<string, any>;
type Pair = [string, string];

export function placeholder(name: string): string {
  return `{{${name}}}`;
}

export function checkName(name: unknown): string {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new Usage(`A flow name is 1 to 64 letters, digits, '-' or '_', starting with a letter or digit, not ${typeof name === "string" ? reprText(name) : String(name)}`);
  }
  return name;
}

export function slug(text: string): string | null {
  const name = String(text || "")
    .replace(/(?<=[a-z0-9])(?=[A-Z])/gu, "_")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return PARAM_NAME.test(name) ? name : null;
}

export function siteOf(url: string): string | null {
  const site = pageSite(url);
  if (site === null) return null;
  const match = /^(\[[^\]]+\]|[^:]+)(:[0-9]+)?$/u.exec(site);
  if (!match) return null;
  const host = match[1] as string;
  return (host.startsWith("[") ? host : baseDomain(host)) + (match[2] ?? "");
}

function isLocal(host: string): boolean {
  const lower = (host || "").toLowerCase();
  return lower === "localhost" || lower.endsWith(".localhost");
}

export function originAllowed(url: flowurl.Url, start: flowurl.Url): boolean {
  if (url.port !== start.port && url.port !== flowurl.DEFAULT_PORTS[url.scheme]) return false;
  if (url.literal || start.literal || isLocal(url.host) || isLocal(start.host)) return url.host === start.host && url.port === start.port;
  return baseDomain(url.host) === baseDomain(start.host);
}

function keyOk(key: unknown, secrets: readonly string[] = []): boolean {
  return typeof key === "string" && KEY_NAME.test(key) && !secrets.some((secret) => flowurl.carries(key, secret));
}

export function signature(value: Value | undefined, depth = 0, secrets: readonly string[] = []): unknown {
  if (value instanceof Map) {
    if (depth >= SIGNATURE_DEPTH) return "object";
    const shape: Json = {};
    for (const [key, inner] of [...value].slice(0, SIGNATURE_KEYS)) {
      const name = keyOk(key, secrets) ? String(key) : ANY_KEY;
      if (!Object.hasOwn(shape, name)) shape[name] = name !== ANY_KEY ? signature(inner, depth + 1, secrets) : "any";
    }
    return shape;
  }
  if (Array.isArray(value)) {
    if (depth >= SIGNATURE_DEPTH) return "array";
    return value.length > 0 ? [signature(value[0], depth + 1, secrets)] : [];
  }
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "bigint" || value instanceof Float) return "number";
  if (value === null || value === undefined) return "null";
  return "string";
}

function joined(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function drift(recorded: unknown, value: Value | undefined, path = ""): string | null {
  const where = path || "the answer";
  if (isObject(recorded)) {
    if (!(value instanceof Map)) return `${where} is no longer an object`;
    for (const [key, inner] of Object.entries(recorded)) {
      if (key === ANY_KEY) continue;
      if (!value.has(key)) return `${joined(path, key)} is missing`;
      const found = drift(inner, value.get(key), joined(path, key));
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(recorded)) {
    if (!Array.isArray(value)) return `${where} is no longer a list`;
    return recorded.length > 0 && value.length > 0 ? drift(recorded[0], value[0], `${path}[0]`) : null;
  }
  if (recorded === "object") return value instanceof Map ? null : `${where} is no longer an object`;
  if (recorded === "array") return Array.isArray(value) ? null : `${where} is no longer a list`;
  if (recorded === "null" || recorded === "any" || value === null || value === undefined) return null;
  const now = value instanceof Map ? "an object" : Array.isArray(value) ? "a list" : `a ${String(signature(value))}`;
  return signature(value) === recorded ? null : `${where} was a ${String(recorded)}, now ${now}`;
}

export function listGone(path: string | null | undefined, value: Value): boolean {
  if (!path) return false;
  return !Array.isArray(shaping.lookup(value, path));
}

function encodedForms(example: string, inPath: boolean): string[] {
  const forms = inPath ? [quote(example, "")] : [quotePlus(example), quote(example, "")];
  return [...new Set([...forms, example])];
}

function templatePart(given: string, values: readonly Pair[], inPath: boolean): string {
  let text = given;
  const decoded = inPath ? unquote(text) : unquotePlus(text);
  for (const [name, example] of values) if (example && decoded === example) return placeholder(name);
  for (const [name, example] of values) {
    if (codePoints(example).length < MIN_SUBSTRING) continue;
    for (const form of encodedForms(example, inPath)) {
      if (text.includes(form)) {
        text = text.replaceAll(form, placeholder(name));
        break;
      }
    }
  }
  return text;
}

function partition(text: string, separator: string): [string, string, string] {
  const at = text.indexOf(separator);
  return at < 0 ? [text, "", ""] : [text.slice(0, at), separator, text.slice(at + separator.length)];
}

function templatePair(pair: string, values: readonly Pair[]): string {
  const [key, sep, value] = partition(pair, "=");
  return sep ? `${key}=${templatePart(value, values, false)}` : pair;
}

export function templateUrl(url: string, values: readonly Pair[]): string {
  const parts = urlsplit(url);
  const path = parts.path
    .split("/")
    .map((segment) => templatePart(segment, values, true))
    .join("/");
  const query = parts.query ? parts.query.split("&").map((pair) => templatePair(pair, values)).join("&") : "";
  return urlunsplit(parts.scheme, parts.netloc, path, query, "");
}

function fillText(text: string, values: Readonly<Record<string, string>>, encode: (value: string) => string = (value) => value): string {
  return text.replace(PARAM, (whole: string, name: string) => (Object.hasOwn(values, name) ? encode(values[name] as string) : whole));
}

function fillPair(pair: string, values: Readonly<Record<string, string>>): string {
  const [key, sep, value] = partition(pair, "=");
  return sep ? key + sep + fillText(value, values, (item) => quotePlus(item)) : pair;
}

export function fillUrl(url: string, values: Readonly<Record<string, string>>): string {
  const parts = urlsplit(url);
  const path = parts.path
    .split("/")
    .map((segment) => fillText(segment, values, (value) => quote(value, "")))
    .join("/");
  const query = parts.query ? parts.query.split("&").map((pair) => fillPair(pair, values)).join("&") : "";
  return urlunsplit(parts.scheme, parts.netloc, path, query, parts.fragment);
}

function scrub(value: string[], secrets: readonly string[]): string[] {
  return value.map((item) => (secrets.some((secret) => flowurl.carries(item, secret)) ? REDACTED : item));
}

function exampleOk(value: string, secrets: readonly string[]): boolean {
  return flowurl.literalOk(value) && !secrets.some((secret) => flowurl.carries(value, secret));
}

function defaultOutput(requests: Json[]): string {
  const withParams = requests.filter((request) => String(request["url"]).includes("{{"));
  const pool = withParams.length > 0 ? withParams : requests;
  if (pool.length === 0) return "";
  let best = pool[0] as Json;
  for (const request of pool) if (request["expect"]["bytes"] > best["expect"]["bytes"]) best = request;
  return best["id"];
}

function startUrl(steps: Step[]): string {
  const first = steps[0] as Step;
  if (first.command[0] === "open" && /^https?:\/\//u.test(String(first.url || ""))) return first.url as string;
  return first.before || "";
}

function requestValues(url: string): Set<string> {
  const parts = urlsplit(url);
  return new Set([...flowurl.queryPairs(parts.query).map(([, value]) => value), ...parts.path.split("/").map((segment) => unquote(segment))]);
}

export function headerOk(name: unknown, value: unknown): boolean {
  return typeof name === "string" && KEPT_HEADERS.has(name) && typeof value === "string" && HEADER_VALUE.test(value);
}

function safeUrl(url: string, values: readonly Pair[], secrets: readonly string[], start: flowurl.Url): string | null {
  let parsed: flowurl.Url;
  try {
    parsed = flowurl.checked(templateUrl(url, values), secrets);
  } catch (error) {
    if (error instanceof flowurl.Unsafe || error instanceof PyException) return null;
    throw error;
  }
  return originAllowed(parsed, start) ? parsed.text : null;
}

function unsafeReason(url: string, values: readonly Pair[], secrets: readonly string[]): string {
  try {
    return flowurl.problem(flowurl.parse(templateUrl(url, values)), secrets) || "its URL isn't safe to keep";
  } catch (error) {
    if (error instanceof flowurl.Unsafe || error instanceof PyException) return `its URL isn't safe to keep (${error.message})`;
    throw error;
  }
}

export function maskedPart(part: string, typed: Typed, secrets: readonly string[] = [], values: readonly Pair[] = []): string {
  if ((typed.secret && part === typed.value) || secrets.some((secret) => part === secret)) return REDACTED;
  if (SCHEMED.test(part) || HOSTED.test(part)) {
    return flowurl.mask(values.length > 0 ? templateUrl(normalizeUrl(part), values) : normalizeUrl(part), secrets);
  }
  return secrets.some((secret) => flowurl.carries(part, secret)) ? REDACTED : part;
}

export function logSecrets(steps: Step[]): string[] {
  return steps.filter((step) => step.typed?.secret && step.typed.value).map((step) => step.typed?.value as string);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function buildFlow(
  name: string,
  steps: Step[],
  givenParams: Readonly<Record<string, string>> = {},
  output: string | null = null,
  description: string | null = null,
  toolVersion = "",
  knownSecrets: readonly string[] = [],
  withActions = false,
): [Json, Json] {
  const given = { ...givenParams };
  checkName(name);
  if (steps.length === 0) throw new BrowseError("No recorded steps in that range; `ardia browse flow steps --all` lists what this session recorded", null, "no_steps");
  let start: flowurl.Url;
  try {
    start = flowurl.parse(startUrl(steps));
  } catch (error) {
    if (!(error instanceof flowurl.Unsafe)) throw error;
    throw new BrowseError(
      `flow save needs a range that starts on a plain web page (${error.message}): begin it with \`open <url>\` or pick it with --from`,
      null,
      "not_a_web_page",
    );
  }
  const site = siteOf(start.text);
  const secrets = unique([...knownSecrets, ...logSecrets(steps)]);
  const params: Json[] = [];
  const named = new Map<string, string>();
  const add = (hint: string, value: string, source: string, example: boolean): string => {
    const known = named.get(value);
    if (known !== undefined) return known;
    const taken = new Set(params.map((param) => param["name"]));
    let candidate = slug(hint);
    if (candidate === null || taken.has(candidate)) {
      let number = 1;
      while (taken.has(`p${number}`)) number += 1;
      candidate = `p${number}`;
    }
    params.push({ name: candidate, example: example && exampleOk(value, secrets) ? value : null, source });
    named.set(value, candidate);
    return candidate;
  };
  for (const key of Object.keys(given)) {
    if (!PARAM_NAME.test(key)) throw new Usage(`A param name is 1 to 24 lowercase letters, digits and '_', starting with a letter, not ${reprText(key)}`);
  }
  const byGiven = new Map<string, string>();
  for (const [key, value] of Object.entries(given)) byGiven.set(value, key);
  for (const step of steps) {
    const typed = step.typed ?? {};
    const value = typed.value;
    if (!value || typed.secret) continue;
    add(byGiven.get(value) || typed.field || "text", value, "typed", byGiven.has(value));
  }
  for (const [key, value] of Object.entries(given)) if (!named.has(value)) add(key, value, "given", true);

  const captured: [Step, FlowRequest][] = [];
  const dropped: Json[] = [];
  const unkept = steps.flatMap((step) => step.unkept ?? []);
  for (const step of steps) {
    for (const request of step.requests ?? []) {
      if (request.method !== "GET") {
        unkept.push(String(request.method || "?"));
        continue;
      }
      if (materialize(request) === null) {
        if (request.evicted) dropped.push({ id: request.id, why: "its answer was dropped to keep the recording small; record it again" });
        continue;
      }
      let parsed: flowurl.Url;
      try {
        parsed = flowurl.parse(request.url);
      } catch (error) {
        if (!(error instanceof flowurl.Unsafe)) throw error;
        dropped.push({ id: request.id, why: `its URL isn't safe to keep (${error.message})` });
        continue;
      }
      if (originAllowed(parsed, start)) captured.push([step, request]);
    }
  }

  for (const url of [start.text, ...steps.filter((step) => step.command[0] === "open").map((step) => step.url || "")]) {
    for (const [key, value] of parseQsl(urlsplit(url).query, false)) {
      if (NOISE_KEY.test(key) || flowurl.credentialKey(key) || named.has(value)) continue;
      if (captured.some(([, request]) => requestValues(request.url).has(value))) add(key, value, "query", true);
    }
  }

  const values: Pair[] = [];
  for (const [value, paramName] of named) for (const param of params) if (param["name"] === paramName) values.push([param["name"], value]);
  values.sort((a, b) => codePoints(b[1]).length - codePoints(a[1]).length);
  const keptByStep = new Map<number, Json[]>();
  const requests: Json[] = [];
  const hosts = new Set([start.origin]);
  for (const step of steps) {
    for (const origin of step.origins ?? []) {
      let parsed: flowurl.Url;
      try {
        parsed = flowurl.parse(`${origin}/`);
      } catch (error) {
        if (error instanceof flowurl.Unsafe) continue;
        throw error;
      }
      if (originAllowed(parsed, start)) hosts.add(parsed.origin);
    }
  }
  for (const [step, request] of captured) {
    const url = safeUrl(request.url, values, secrets, start);
    if (url !== null && Object.entries(request.headers ?? {}).some(([key, value]) => secrets.some((secret) => flowurl.carries(`${key} ${value}`, secret)))) {
      dropped.push({ id: request.id, why: "a header it sent carries a value typed into a secret field" });
      continue;
    }
    if (url === null) {
      dropped.push({ id: request.id, why: unsafeReason(request.url, values, secrets) });
      continue;
    }
    const value = materialize(request) as Value;
    const found = shaping.mainList(value);
    const listPath = found && found[0] && found[0].split(".").every((part) => keyOk(part, secrets)) ? found[0] : null;
    const expect: Json = {
      status: request.status,
      mime: request.mime || "",
      signature: signature(value, 0, secrets),
      bytes: request.bytes || 0,
      list: listPath,
      itemFields: found ? shaping.itemFields(found[1]).filter((field) => FIELD_NAME.test(field) && !secrets.some((secret) => flowurl.carries(field, secret))) : [],
    };
    if (request.kind === "document") {
      const spec = (request.spec ?? {}) as Json;
      if (Object.hasOwn(spec, "scriptId") && !SCRIPT_ID.test(String(spec["scriptId"]))) {
        dropped.push({ id: request.id, why: "the page's JSON block has an id a flow doesn't keep" });
        continue;
      }
      expect["extract"] = spec;
    }
    const headers: Json = {};
    for (const [key, item] of Object.entries(request.headers ?? {})) if (headerOk(key, item)) headers[key] = item;
    const kept: Json = { id: request.id, method: "GET", url, headers, kind: request.kind || "json", expect };
    if (request.strippedAuth) kept["strippedAuth"] = true;
    const list = keptByStep.get(step.seq) ?? [];
    list.push(kept);
    keptByStep.set(step.seq, list);
    requests.push(kept);
    hosts.add(flowurl.parse(url).origin);
  }
  const actionMode = withActions && steps.some((step) => isElementAction(actionFromReplay(step.replay ?? step.command)));
  if (requests.length === 0 && !actionMode) {
    if (unkept.length > 0) {
      throw new BrowseError(READ_ONLY.replace("{methods}", unique(unkept).sort(compareText).join(", ")), { dropped }, "flow_not_get");
    }
    const why = dropped.map((item) => `${item["id"]}: ${item["why"]}`).join("; ");
    throw new BrowseError(
      "Nothing to save: the steps in that range caused no first-party JSON answers or pages with embedded JSON a flow can keep " +
        `(\`flow steps\` lists what each step caused)${why ? `; left out ${why}` : ""}`,
      { dropped },
      "nothing_to_save",
    );
  }
  if (output !== null && (requests.length > 0 || !actionMode) && !requests.some((request) => request["id"] === output)) {
    throw new Usage(`--output ${output} isn't one of the GET requests kept: ${requests.map((request) => request["id"]).join(", ")}`);
  }

  const savedSteps: Json[] = [];
  const secretParams = new Map<string, string>();
  for (const step of steps) {
    let command = (step.replay ?? step.command).map(String);
    const typed = step.typed ?? {};
    let actionCommand: string[] | null = null;
    if (typed.value) {
      const shown = typed.secret ? REDACTED : named.has(typed.value) ? placeholder(named.get(typed.value) as string) : null;
      if (actionMode && typed.secret) {
        let secretName = secretParams.get(typed.value);
        if (secretName === undefined) {
          const taken = new Set(params.map((param) => param["name"]));
          const hint = slug(typed.field || "password") ?? "password";
          secretName = hint;
          for (let number = 2; taken.has(secretName); number += 1) secretName = `${hint.slice(0, 20)}_${number}`;
          params.push({ name: secretName, example: null, source: "secret" });
          secretParams.set(typed.value, secretName);
        }
        const secretParam = placeholder(secretName);
        actionCommand = command.map((part) => (part === typed.value ? secretParam : part));
      }
      command = command.map((part) => (shown && part === typed.value ? shown : part));
    }
    command = scrub(command, secrets).map((part) => maskedPart(part, {}, secrets, values));
    command = command.map((part) => (codePoints(part).length <= MAX_WORD ? part : `${codePoints(part).slice(0, MAX_WORD).join("")}…`));
    const pageUrl = step.url || "";
    const after = pageUrl ? flowurl.mask(templateUrl(pageUrl, values), secrets) : "";
    const saved: Json = { seq: step.seq, command, url: after, ok: step.ok ?? true, requests: keptByStep.get(step.seq) ?? [] };
    if (actionMode && (step.ok ?? true)) {
      const source = actionCommand ? scrub(actionCommand, secrets).map((part) => maskedPart(part, {}, secrets, values)) : command;
      const action = actionFromReplay(source.some((part) => part.endsWith("…") || part === REDACTED) ? null : source);
      if (action !== null && actionProblem(action, new Set(params.map((param) => param["name"]))) === null && openOk(action, [...hosts])) saved["action"] = action;
    }
    savedSteps.push(saved);
  }
  const startSaved = safeUrl(start.text, values, secrets, start);
  const words = String(description ?? "").split(/\s+/u).filter((word) => word).join(" ");
  const flow: Json = {
    version: actionMode ? ACTIONS_VERSION : VERSION,
    name,
    description: codePoints(words).slice(0, MAX_DESCRIPTION).join("") || null,
    site,
    origin: start.origin,
    startUrl: startSaved || `${start.origin}/`,
    hosts: [...hosts].sort(compareText),
    createdAt: `${new Date().toISOString().slice(0, 19)}Z`,
    createdBy: { tool: "ardia browse", version: toolVersion },
    params,
    output: requests.length > 0 ? output || defaultOutput(requests) : null,
    verified: true,
    steps: savedSteps,
  };
  if (actionMode) {
    flow["kind"] = requests.length > 0 ? "requests" : "actions";
    flow["writes"] = true;
  }
  const report: Json = {
    requests: requests.map((request) => ({ id: request["id"], method: request["method"], url: request["url"], kind: request["kind"], list: request["expect"]["list"] })),
    params,
    dropped,
    unkept: unique(unkept).sort(compareText),
    output: flow["output"],
  };
  return [flow, report];
}

export function outputRequest(flow: Json): Json | null {
  for (const step of flow["steps"]) {
    if (!isObject(step)) continue;
    for (const request of step["requests"] || []) if (isObject(request) && request["id"] === flow["output"]) return request;
  }
  return null;
}

function invalid(why: string): BrowseError {
  return new BrowseError(`That flow file ${why}; save the flow again`, null, "flow_invalid");
}

function strict(url: unknown, hosts: unknown[], what: string): flowurl.Url {
  let parsed: flowurl.Url;
  try {
    parsed = flowurl.checked(url as string);
  } catch (error) {
    if (!(error instanceof flowurl.Unsafe)) throw error;
    throw invalid(`has ${what} that isn't safe (${error.message})`);
  }
  if (!hosts.includes(parsed.origin)) throw invalid(`has ${what} on a host it doesn't list`);
  return parsed;
}

function checkCommand(command: unknown): void {
  if (command === null || command === undefined) return;
  if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === "string" && codePoints(part).length <= MAX_WORD + 1)) {
    throw invalid("has a step that isn't a short list of words");
  }
}

function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return value;
  return dumps(pyValue(value), "spaced");
}

export function validate(flow: unknown, site: string | null = null, name: string | null = null): Json {
  if (!isObject(flow)) throw invalid("isn't a JSON object");
  if (flow["version"] !== VERSION && !(flow["version"] === ACTIONS_VERSION && KINDS.has(flow["kind"]))) {
    throw invalid(`is version ${reprText(codePoints(pyStr(flow["version"])).slice(0, 10).join(""))}; this ardia reads version ${VERSION}.`);
  }
  const v2 = flow["version"] === ACTIONS_VERSION;
  const unknown = Object.keys(flow).filter((key) => !(v2 ? V2_FIELDS : FIELDS).has(key)).sort(compareText);
  const missing = REQUIRED.filter((key) => !Object.hasOwn(flow, key));
  if (unknown.length > 0 || missing.length > 0) {
    const parts = [unknown.length > 0 ? `unknown fields ${codePoints(unknown.join(", ")).slice(0, 80).join("")}` : "", missing.length > 0 ? `missing ${missing.join(", ")}` : ""];
    throw invalid(`has ${parts.filter((part) => part).join("; ")}`);
  }
  let start: flowurl.Url;
  try {
    start = flowurl.parse(flow["startUrl"]);
  } catch (error) {
    if (!(error instanceof flowurl.Unsafe)) throw error;
    throw invalid(`has a start URL that isn't safe (${error.message})`);
  }
  if ((site !== null && flow["site"] !== site) || (name !== null && flow["name"] !== name) || siteOf(start.text) !== flow["site"]) {
    throw invalid("has a site or name that doesn't match where it's stored");
  }
  if (flow["origin"] !== start.origin) throw invalid("has an origin that isn't its start URL's");
  const hosts = flow["hosts"];
  if (!Array.isArray(hosts) || !hosts.includes(start.origin)) throw invalid("doesn't list its start URL's host");
  for (const host of hosts) {
    let parsed: flowurl.Url | null = null;
    try {
      parsed = typeof host === "string" ? flowurl.parse(`${host}/`) : null;
    } catch (error) {
      if (!(error instanceof flowurl.Unsafe)) throw error;
    }
    if (parsed === null || parsed.origin !== host || !originAllowed(parsed, start)) {
      throw invalid(`allows ${codePoints(pyStr(host)).slice(0, 60).join("")}, which isn't on ${pyStr(flow["site"])} or is another local or IP address`);
    }
  }
  strict(flow["startUrl"], hosts, "a start URL");
  const description = flow["description"];
  if (description !== null && description !== undefined && (typeof description !== "string" || codePoints(description).length > MAX_DESCRIPTION || description.includes("\n"))) {
    throw invalid("has a description longer than one short line");
  }
  if (!Array.isArray(flow["params"]) || !flow["params"].every((param: unknown) => isObject(param) && typeof param["name"] === "string" && PARAM_NAME.test(param["name"]))) {
    throw invalid("has a param whose name isn't a short identifier");
  }
  for (const param of flow["params"]) {
    const example = param["example"];
    if (example !== null && example !== undefined && (typeof example !== "string" || !flowurl.literalOk(example))) throw invalid("has a param example that isn't a short word");
  }
  if (!Array.isArray(flow["steps"])) throw invalid("has no list of steps");
  if (v2 && (!KINDS.has(flow["kind"]) || (flow["writes"] !== undefined && typeof flow["writes"] !== "boolean"))) throw invalid("has a kind that isn't requests or actions");
  const paramNames = new Set<string>(flow["params"].map((param: Json) => param["name"]));
  for (const step of flow["steps"]) {
    if (!isObject(step) || !Object.keys(step).every((key) => (v2 ? V2_STEP_FIELDS : STEP_FIELDS).has(key))) throw invalid("has a step with fields a flow doesn't have");
    checkCommand(step["command"]);
    if (step["action"] !== undefined) {
      const problem = actionProblem(step["action"], paramNames);
      if (problem) throw invalid(`has ${problem}`);
      checkAction(step["action"] as Action, hosts);
    }
    for (const request of step["requests"] || []) {
      if (!isObject(request) || !Object.keys(request).every((key) => REQUEST_FIELDS.has(key))) throw invalid("has a request with fields a flow doesn't keep (a body?)");
      if (request["method"] !== "GET") throw invalid("has a request that isn't a GET; flows are read-only");
      strict(request["url"], hosts, "a request URL");
      const headers = request["headers"] || {};
      if (!isObject(headers) || !Object.entries(headers).every(([key, value]) => headerOk(key, value))) throw invalid("has a request header a flow doesn't keep");
      const fields = (request["expect"] || {})["itemFields"] || [];
      if (!fields.every((field: unknown) => typeof field === "string" && FIELD_NAME.test(field))) throw invalid("has an item field that isn't a short identifier");
    }
  }
  if (v2 && flow["kind"] === "actions") {
    if (flow["output"] !== null) throw invalid("is an action flow with an output request");
    if (!flow["steps"].some((step: Json) => isElementAction(step["action"]))) throw invalid("is an action flow with no actions");
  } else if (outputRequest(flow) === null) throw invalid("has no output request");
  return flow;
}

export function openOk(action: Action, hosts: readonly string[]): boolean {
  if (action.type !== "open" || typeof action.value !== "string" || action.value.includes("{{")) return true;
  try {
    return hosts.includes(flowurl.checked(action.value).origin);
  } catch (error) {
    if (error instanceof flowurl.Unsafe || error instanceof PyException) return false;
    throw error;
  }
}

function checkAction(action: Action, hosts: unknown[]): void {
  if (action.type === "open" && typeof action.value === "string" && !action.value.includes("{{")) strict(action.value, hosts, "an open step");
  if (action.argv !== undefined && action.argv[0] !== action.type) throw invalid("has a step whose command isn't its action");
}

export function checkSite(site: unknown): string {
  if (typeof site !== "string" || !HOST.test(site)) throw new Usage(`${typeof site === "string" ? reprText(site) : String(site)} isn't a site (host[:port])`);
  return site;
}

function openSite(root: string, site: string, create: boolean): number | null {
  try {
    return openPrivate(root, [DIR_NAME, checkSite(site)], create);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    if (error instanceof PathError) {
      if (!create && error.message.includes("doesn't exist")) return null;
      throw new BrowseError(error.message);
    }
    throw error;
  }
}

export function save(root: string, flow: Json): string {
  const folder = openSite(root, flow["site"], true) as number;
  const name = `${checkName(flow["name"])}.json`;
  const data = Buffer.from(dumps(pyValue(flow), "indented", false, false, 1), "utf8");
  if (data.length > MAX_FLOW) {
    closeFd(folder);
    throw new BrowseError(
      `That flow would be ${groupThousands(String(data.length))} bytes; the limit is ${MAX_FLOW / (1024 * 1024)} MB. Save a narrower range (--from, --to)`,
      null,
      "flow_too_large",
    );
  }
  const temp = `.${name}.${process.pid}.tmp`;
  try {
    const fd = openPrivateFile(temp, folder, O_WRONLY | O_CREAT | O_TRUNC);
    try {
      writeAllFd(fd, data);
    } finally {
      closeFd(fd);
    }
    renameAt(folder, temp, name);
  } finally {
    closeFd(folder);
  }
  return `${root.replace(/\/+$/u, "")}/${DIR_NAME}/${flow["site"]}/${name}`;
}

export function load(root: string, site: string, name: string): Json {
  if (!names(root, site).includes(name)) throw new BrowseError(`No flow ${checkName(name)} for ${site}`, null, "no_flow");
  const folder = openSite(root, site, false) as number;
  let flow: Value | undefined;
  try {
    flow = readPrivateJson(`${name}.json`, folder, MAX_FLOW);
  } catch (error) {
    if (error instanceof PathError || (error instanceof Error && "code" in error)) throw new BrowseError(`Can't read flow ${name} for ${site}: ${error.message}`, null, "flow_invalid");
    throw error;
  } finally {
    closeFd(folder);
  }
  if (flow === undefined) throw new BrowseError(`Flow ${name} for ${site} isn't valid JSON; save it again`, null, "flow_invalid");
  return validate(plainParams(flow), site, name);
}

export function sites(root: string): string[] {
  let folder: number;
  try {
    folder = openPrivate(root, [DIR_NAME], false);
  } catch (error) {
    if (codeOf(error) === "ENOENT" || error instanceof PathError) return [];
    throw error;
  }
  try {
    return listNames(folder)
      .filter((entry) => !entry.startsWith(".") && (entryInfo(folder, entry).mode & 0o170000) === 0o040000)
      .sort(compareText);
  } finally {
    closeFd(folder);
  }
}

export function names(root: string, site: string): string[] {
  const folder = openSite(root, site, false);
  if (folder === null) return [];
  try {
    return listNames(folder)
      .filter((entry) => entry.endsWith(".json") && !entry.startsWith(".") && NAME.test(entry.slice(0, -5)))
      .map((entry) => entry.slice(0, -5))
      .sort(compareText);
  } finally {
    closeFd(folder);
  }
}

export function summary(flow: Json): Json {
  const request = outputRequest(flow) ?? {};
  return {
    site: flow["site"],
    name: flow["name"],
    description: flow["description"] ?? null,
    params: flow["params"].map((param: Json) => ({ name: param["name"], example: param["example"] ?? null, source: param["source"] ?? null })),
    itemFields: (request["expect"] || {})["itemFields"] || [],
    verified: Boolean(flow["verified"] ?? true),
    ...(flow["kind"] ? { kind: flow["kind"], writes: Boolean(flow["writes"]) } : {}),
  };
}

export function listing(root: string, site: string | null = null): Json[] {
  const rows: Json[] = [];
  for (const one of site ? [site] : sites(root)) {
    for (const name of names(root, one)) {
      try {
        rows.push(summary(load(root, one, name)));
      } catch (error) {
        if (!(error instanceof BrowseError)) throw error;
        rows.push({ site: one, name, error: error.text });
      }
    }
  }
  return rows;
}

export function remove(root: string, site: string, name: string): boolean {
  const folder = openSite(root, site, false);
  if (folder === null) return false;
  try {
    try {
      unlinkAt(folder, `${checkName(name)}.json`);
    } catch (error) {
      if (codeOf(error) === "ENOENT") return false;
      throw error;
    }
    return true;
  } finally {
    closeFd(folder);
  }
}

export function locate(root: string, name: string, site: string | null | undefined, pageUrl: string | null): string {
  checkName(name);
  if (site) return checkSite(site);
  const found = sites(root).filter((one) => names(root, one).includes(name));
  if (found.length === 1) return found[0] as string;
  const here = pageUrl ? siteOf(pageUrl) : null;
  if (here !== null && found.includes(here)) return here;
  if (found.length === 0) throw new BrowseError(`No saved flow named ${name} (\`ardia browse flow list\` lists them)`, null, "no_flow");
  throw new Usage(`${name} is saved for ${found.join(", ")}; pick one with --site <site>`);
}

function clipped(text: string, limit: number): string {
  const flat = String(text).split(/\s+/u).filter((word) => word).join(" ");
  const points = codePoints(flat);
  return points.length <= limit ? flat : `${points.slice(0, limit - 1).join("")}…`;
}

export function signatureLine(row: Json, limit = MAX_DESCRIPTION): string {
  const params = (row["params"] || []).map((param: Json) => param["name"]).join(", ");
  const described = row["description"] ? ` [saved description: ${dumps(clipped(row["description"], limit), "spaced")}]` : "";
  return `${row["name"]}(${params})${described}`;
}

function listingText(rows: Json[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    if (row["error"]) {
      lines.push(`${row["site"]}  ${row["name"]}  (unreadable: ${row["error"]})`);
      continue;
    }
    const fields = row["itemFields"].slice(0, 12).join(", ") + (row["itemFields"].length > 12 ? " …" : "");
    const examples = row["params"]
      .filter((param: Json) => param["example"])
      .map((param: Json) => `${param["name"]}=${dumps(clipped(param["example"], MAX_EXAMPLE), "spaced")}`)
      .join(", ");
    const extra = [examples ? `examples ${examples}` : "", fields ? `items: ${fields}` : "", !row["verified"] ? "unverified" : ""].filter((part) => part).join("; ");
    lines.push(`${row["site"]}  ${signatureLine(row)}${extra ? `  [${extra}]` : ""}`);
  }
  return lines.join("\n") || "No saved flows yet (`ardia browse flow save <name>` after doing the task once)";
}

function showText(flow: Json): string {
  const lines = [
    `${flow["name"]} on ${flow["site"]}` + (flow["description"] ? ` [saved description: ${dumps(flow["description"], "spaced")}]` : ""),
    `start: ${flow["startUrl"]}`,
  ];
  for (const param of flow["params"]) {
    const example = param["example"] ? ` (recorded: ${param["example"]})` : " (required)";
    lines.push(`param ${param["name"]} [${pyStr(param["source"])}]${example}`);
  }
  if (flow["kind"] === "actions") lines.push(`replays ${flow["steps"].length} steps in the page${flow["writes"] ? "; its clicks and forms may change things, so runs need --yes" : ""}`);
  for (const step of flow["steps"]) {
    const command = step["command"] ? step["command"].join(" ") : "(a step with no command)";
    lines.push(`[${step["seq"]}] ${command}`);
    const action = step["action"] as Action | undefined;
    if (action) {
      const located = [...action.candidates.map((candidate) => selectorOf(candidate)), ...(action.fingerprint ? [`role ${action.fingerprint.role} ${dumps(action.fingerprint.name, "spaced")}`] : [])];
      const state = action.desired_state === undefined ? "" : ` → ${action.desired_state ? "on" : "off"}`;
      lines.push(`    ${action.intent}${state}${located.length > 0 ? ` (by ${located.join(" | ")})` : ""}`);
    }
    for (const request of step["requests"] || []) {
      const mark = request["id"] === flow["output"] ? " ← output" : "";
      lines.push(`    ${request["id"]} ${request["method"]} ${request["url"]} (${request["kind"]})${mark}`);
    }
  }
  if (!(flow["verified"] ?? true)) lines.push("unverified: the last run saw the answer's shape change; save it again");
  return lines.join("\n");
}

export function runLocal(root: string, args: string[], pageUrl: string | null = null): Result {
  const action = args[0] ?? "list";
  if (action === "list") {
    const [, positional] = parse(args.slice(1), SITE_FLAGS);
    const site = positional.length > 0 ? checkSite(siteOf(positional[0] as string) || (positional[0] as string)) : null;
    const rows = listing(root, site);
    return new Result({ flows: rows }, listingText(rows), true);
  }
  if (action === "show") {
    const [options, positional] = parse(args.slice(1), SITE_FLAGS);
    if (positional.length === 0) throw new Usage("Usage: ardia browse flow show <name> [--site s]");
    const site = locate(root, positional[0] as string, options["site"] as string | undefined, pageUrl);
    const flow = load(root, site, positional[0] as string);
    return new Result({ flow }, showText(flow), true);
  }
  if (action === "heal") return heal(root, args.slice(1), pageUrl);
  if (action === "rm" || action === "remove" || action === "delete") {
    const [options, positional] = parse(args.slice(1), SITE_FLAGS);
    if (positional.length === 0) throw new Usage("Usage: ardia browse flow rm <name> [--site s]");
    const name = positional[0] as string;
    const site = locate(root, name, options["site"] as string | undefined, pageUrl);
    const removed = remove(root, site, name);
    return new Result({ site, name, removed }, removed ? `✓ Removed flow ${name} for ${site}` : `No flow ${name} for ${site}`);
  }
  throw new Usage(USAGE);
}

export function runsLocally(args: string[]): boolean {
  return ["list", "show", "rm", "remove", "delete", "heal"].includes(args[0] ?? "list");
}

function readPatch(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file === "-" ? 0 : file, "utf8");
  } catch (error) {
    throw new Usage(`Can't read the heal patch ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Usage(`The heal patch ${file} isn't JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function episodeLine(episode: Json): string {
  const tried = (episode["tried"] || []).map((item: Json) => `${item["tier"]} ${item["ok"] ? "✓" : `✗ ${item["code"] ?? ""}`}`.trim()).join(", ");
  const how = episode["kind"] === "healed" ? `passed by ${episode["tier"]}` : `failed${episode["fatal"] ? `: ${episode["fatal"]}` : " at every tier"}`;
  return `  ${episode["at"]} step ${episode["seq"]} (${episode["intent"]}) ${how}${tried ? ` [${tried}]` : ""}`;
}

function heal(root: string, args: string[], pageUrl: string | null): Result {
  const [options, positional] = parse(args, HEAL_FLAGS);
  if (positional.length !== 1) throw new Usage("Usage: ardia browse flow heal <name> [--apply] [--step n --selector s | --step n --role r --name n | --patch file.json] [--clear]");
  const name = positional[0] as string;
  const site = locate(root, name, options["site"] as string | undefined, pageUrl);
  const flow = load(root, site, name);
  const episodes = loadEpisodes(root, site, name);
  let patch = null;
  if (options["patch"]) patch = parsePatch(readPatch(options["patch"] as string));
  else if (options["step"] !== undefined) {
    const seq = seqOf(options["step"] as string, "--step") as number;
    const role = options["role"] as string | undefined;
    const roleName = options["name"] as string | undefined;
    if (!options["selector"] && !(role && roleName)) throw new Usage("flow heal --step n needs --selector <sel> or --role <role> --name <name>");
    patch = parsePatch({ steps: [{ seq, ...(options["selector"] ? { selector: options["selector"] as string } : {}), ...(role && roleName ? { fingerprint: { role, name: roleName } } : {}) }] });
  }
  if (patch !== null) {
    const { flow: next, changes, rejected } = applyPatch(flow, patch, episodes);
    if (rejected.length > 0) {
      flag("flow_heal_rejected", true);
      throw new BrowseError(`Nothing was changed: ${rejected.map((item) => `step ${item.seq} ${item.what}: ${item.why}`).join("; ")}`, { rejected }, "heal_rejected");
    }
    validate(next, site, name);
    save(root, next);
    const healed = new Set(changes.map((change) => change.seq));
    writeEpisodes(root, site, name, episodes.filter((episode) => !healed.has(episode.seq)));
    flag("flow_heal_applied", true);
    return new Result({ flow: name, site, changes }, [`✓ Healed ${name} for ${site}`, ...changes.map((change) => `  step ${change.seq}: ${change.candidates.map((candidate) => selectorOf(candidate)).join(" | ")}`)].join("\n"));
  }
  const changes = proposals(flow, episodes);
  if (options["apply"]) {
    if (changes.length === 0) return new Result({ flow: name, site, changes: [] }, `Nothing to heal in ${name}: no run found a step by a later tier`);
    const next = applyProposals(flow, changes);
    validate(next, site, name);
    save(root, next);
    const healed = new Set(changes.map((change) => change.seq));
    writeEpisodes(root, site, name, episodes.filter((episode) => !healed.has(episode.seq)));
    flag("flow_heal_applied", true);
    return new Result({ flow: name, site, changes }, [`✓ Healed ${name} for ${site}`, ...changes.map((change) => `  step ${change.seq}: ${change.why}`)].join("\n"));
  }
  if (options["clear"]) {
    writeEpisodes(root, site, name, []);
    return new Result({ flow: name, site, cleared: episodes.length }, `✓ Cleared ${episodes.length} recorded runs of ${name}`);
  }
  const lines = [`${name} on ${site}: ${episodes.length} recorded fallback${episodes.length === 1 ? "" : "s"}`];
  for (const episode of episodes.slice(-10)) lines.push(episodeLine(episode as unknown as Json));
  for (const change of changes) lines.push(`  proposal for step ${change.seq}: ${change.why} → ${change.candidates.map((candidate) => selectorOf(candidate)).join(" | ")}`);
  if (changes.length > 0) lines.push(`→ ardia browse flow heal ${name} --apply`);
  const stuck = episodes.filter((episode) => episode.kind === "fallback");
  if (stuck.length > 0) {
    const last = stuck.at(-1) as (typeof stuck)[number];
    lines.push(`→ step ${last.seq} needs a new locator: ardia browse flow heal ${name} --step ${last.seq} --selector '<css>' (or --role <role> --name <name>); --json has each failure's snapshot`);
  }
  return new Result({ flow: name, site, episodes, proposals: changes }, lines.join("\n"), true);
}

const HINTED = new WeakMap<State, Set<string>>();

function hintedOf(state: State): Set<string> {
  let shown = HINTED.get(state);
  if (shown === undefined) {
    shown = new Set();
    HINTED.set(state, shown);
  }
  return shown;
}

export function hint(state: State, url: string | null): string | null {
  const root = state.dataRoot;
  const site = url ? siteOf(url) : null;
  if (!root || site === null) return null;
  const shown = hintedOf(state);
  if (shown.has(site)) return null;
  let rows: Json[];
  try {
    rows = listing(root, site).filter((row) => !row["error"]);
  } catch (error) {
    if (error instanceof BrowseError) return null;
    throw error;
  }
  if (rows.length === 0) return null;
  shown.add(site);
  flag("flow_hint_shown", true);
  const more = rows.length > HINT_LIMIT ? `; … ${rows.length - HINT_LIMIT} more: \`ardia browse flow list ${site}\`` : "";
  return (
    `# saved flows for ${site} (\`ardia browse flow run <name> --param k=v\`, \`flow show <name>\`): ` +
    rows
      .slice(0, HINT_LIMIT)
      .map((row) => signatureLine(row, HINT_DESCRIPTION))
      .join("; ") +
    more
  );
}

export function parseParams(values: readonly string[] | null | undefined): Record<string, string> {
  const params: Record<string, string> = Object.create(null);
  for (const item of values ?? []) {
    const [key, sep, value] = partition(item, "=");
    if (!sep || !key) throw new Usage(`--param takes name=value, not ${reprText(item)}`);
    params[key.trim()] = value;
  }
  return params;
}

function seqOf(value: string | null | undefined, what: string): number | null {
  if (value === null || value === undefined) return null;
  try {
    return Number(pyInt(String(value).replace(/^s+/u, "")));
  } catch (error) {
    if (!(error instanceof PyException)) throw error;
    throw new Usage(`${what} takes a step number from \`flow steps\`, not ${reprText(String(value))}`);
  }
}

export function saveRange(log: Log, given: number | null, until: number | null): Step[] {
  const steps = [...log.steps];
  const last = until ?? (steps.length > 0 ? (steps.at(-1) as Step).seq : 0);
  let first = given;
  if (first === null) {
    const fresh = steps.filter((step) => step.seq > log.savedThrough && step.seq <= last);
    const opens = fresh.filter((step) => step.command[0] === "open").map((step) => step.seq);
    first = opens.length > 0 ? (opens.at(-1) as number) : fresh.length > 0 ? (fresh[0] as Step).seq : last + 1;
  }
  const from = first;
  return steps.filter((step) => from <= step.seq && step.seq <= last);
}

function shownCommand(step: Step, secrets: readonly string[] = []): string[] {
  const typed = step.typed ?? {};
  return (step.replay ?? step.command).map((part) => maskedPart(String(part), typed, secrets));
}

function stepLine(step: Step, secrets: readonly string[] = []): string[] {
  const status = step.ok ?? true ? "" : `  ✗ ${step.error || "failed"}`;
  const page = step.url ? flowurl.mask(step.url, secrets) : "(no page)";
  const lines = [`[${step.seq}] ${shownCommand(step, secrets).join(" ")}  → ${page}${status}`];
  for (const request of step.requests ?? []) {
    const kind = request.kind || "json";
    const body = materialize(request) !== null ? "" : " (answer dropped)";
    lines.push(`    ${request.id} GET ${flowurl.mask(request.url, secrets)} ${pyStr(request.status)} ${kind}${body}`);
  }
  const unkept = step.unkept ?? [];
  if (unkept.length > 0) lines.push(`    not kept (flows are read-only): ${unique(unkept).sort(compareText).join(", ")} ×${unkept.length}`);
  return lines;
}

function stepsResult(log: Log, everything: boolean): Result {
  const secrets = log.knownSecrets();
  const steps = log.steps.filter((step) => everything || step.seq > log.savedThrough);
  const rows = steps.map((step) => ({
    seq: step.seq,
    command: shownCommand(step, secrets),
    url: step.url ? flowurl.mask(step.url, secrets) : null,
    ok: step.ok ?? true,
    requests: (step.requests ?? []).map((request) => ({ id: request.id, method: "GET", url: flowurl.mask(request.url, secrets), status: request.status, kind: request.kind })),
    notKept: (step.unkept ?? []).length,
  }));
  const lines = steps.flatMap((step) => stepLine(step, secrets));
  if (log.dropped) lines.unshift(`(${log.dropped} older steps dropped)`);
  const empty = log.steps.length > 0
    ? "Nothing recorded since the last save"
    : "Nothing recorded yet: open a page and do the task once (open, click, fill, select, press …), then `flow save <name>`";
  return new Result({ steps: rows, savedThrough: log.savedThrough, dropped: log.dropped }, lines.join("\n") || empty, true);
}

function saveText(name: string, path: string, flow: Json, report: Json, secrets: readonly string[] = []): string {
  const lines = [`✓ Saved flow ${name} for ${flow["site"]} (${path})`];
  for (const request of report["requests"]) {
    const mark = request["id"] === report["output"] ? " ← output" : "";
    const detail = request["list"] ? `, list ${request["list"]}` : "";
    lines.push(`  ${request["id"]} GET ${flowurl.mask(request["url"], secrets)} (${request["kind"]}${detail})${mark}`);
  }
  for (const param of report["params"]) {
    const shown = param["example"] && !secrets.some((secret) => flowurl.carries(param["example"], secret));
    const how = shown ? `recorded ${param["example"]}` : "no recorded value: runs pass it";
    lines.push(`  param ${param["name"]} (${param["source"]}; ${how})`);
  }
  if (report["params"].length === 0) lines.push("  no params: name a typed or URL value with --param k=v to make one");
  for (const item of report["dropped"]) lines.push(`  left out ${item["id"]}: ${item["why"]}`);
  if (report["unkept"].length > 0) lines.push(`  not kept: ${report["unkept"].join(", ")} requests (flows are read-only)`);
  const usage = report["params"].map((param: Json) => `--param ${param["name"]}=…`).join(" ");
  lines.push(`→ ardia browse flow run ${name}${usage ? ` ${usage}` : ""} [--fields a,b] [--where f=v] [--limit n]`);
  return lines.join("\n");
}

function saveFixture(ctx: Ctx, dir: string, flow: Json, steps: Step[], secrets: readonly string[]): string[] {
  const request = outputRequest(flow);
  if (request === null) throw new BrowseError("--fixture needs a flow that keeps a GET answer; an action-only flow has nothing to extract", null, "fixture_failed");
  const recorded = steps.flatMap((step) => step.requests ?? []).find((item) => item.id === request["id"]);
  if (!recorded || typeof recorded.text !== "string") throw new BrowseError("--fixture needs the recorded answer, and it was dropped to keep the recording small; record it again", null, "fixture_failed");
  flag("flow_fixture", true);
  return writeFixture(fixtureDir(ctx.cwd, dir), fixtureFiles(flow, request, recorded.text, secrets));
}

export type FlowRunner = (ctx: Ctx, root: string, flow: Json, options: Record<string, unknown>) => Promise<Result>;
export const runner: { run: FlowRunner } = { run: (ctx, root, flow, options) => run(ctx, root, flow, options) };

export async function cmdFlow(ctx: Ctx, argv: string[]): Promise<Result> {
  const state = ctx.state;
  const root = state.dataRoot;
  if (root === null) throw new BrowseError("This session has no data folder for flows");
  const action = argv[0] ?? "list";
  const rest = argv.slice(1);
  const log = logOf(state);
  if (action === "steps") {
    const [options] = parse(rest, { "--all": "bool" });
    return stepsResult(log, Boolean(options["all"]));
  }
  if (action === "save") {
    const [options, positional] = parse(rest, SAVE_FLAGS);
    if (positional.length !== 1) throw new Usage("Usage: ardia browse flow save <name> [--from n] [--to n] [--param k=v] [--output id] [--description text]");
    const steps = saveRange(log, seqOf(options["from"] as string | undefined, "--from"), seqOf(options["to"] as string | undefined, "--to"));
    const [flow, report] = buildFlow(
      positional[0] as string,
      steps,
      parseParams(options["param"] as string[] | undefined),
      (options["output"] as string | undefined) ?? null,
      (options["description"] as string | undefined) ?? null,
      cliVersion(),
      log.knownSecrets(),
      Boolean(options["actions"]),
    );
    validate(flow);
    const path = save(root, flow);
    let fixture: string[] = [];
    if (options["fixture"]) fixture = saveFixture(ctx, options["fixture"] as string, flow, steps, log.knownSecrets());
    log.savedThrough = Math.max(log.savedThrough, (steps.at(-1) as Step).seq);
    hintedOf(state).add(flow["site"]);
    flag("flow_saved", true);
    count("flow_requests_kept", report["requests"].length);
    count("flow_params", report["params"].length);
    if (flow["kind"]) flag("flow_saved_actions", true);
    const text = saveText(positional[0] as string, path, flow, report, log.knownSecrets());
    const extra = fixture.length > 0 ? `\n  fixture: ${fixture.join(", ")} (offline: node --test ${fixture.find((file) => file.endsWith(".test.mjs"))})` : "";
    return new Result({ flow: summary(flow), path, ...report, ...(fixture.length > 0 ? { fixture } : {}) }, text + extra);
  }
  if (action === "run") {
    const [options, positional] = parse(rest, RUN_FLAGS);
    if (positional.length !== 1) throw new Usage("Usage: ardia browse flow run <name> [--param k=v] [--fields a,b.c] [--where f=v] [--limit n]");
    const page = state.current ? (state.pages.get(state.current) ?? null) : null;
    const site = locate(root, positional[0] as string, options["site"] as string | undefined, page ? page.url : null);
    const flow = load(root, site, positional[0] as string);
    return runner.run(ctx, root, flow, options);
  }
  if (runsLocally([action])) {
    const page = state.current ? (state.pages.get(state.current) ?? null) : null;
    return runLocal(root, [action, ...rest], page ? page.url : null);
  }
  throw new Usage(USAGE);
}

register("flow", cmdFlow);
