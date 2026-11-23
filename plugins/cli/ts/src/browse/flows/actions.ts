import { codePoints } from "../../pystr.ts";
import {
  type Candidate,
  CANDIDATE_KINDS,
  candidateProblem,
  type Fingerprint,
  intentOf,
  MAX_CANDIDATES,
  selectorOf,
  sortCandidates,
} from "./locators.ts";

export const ELEMENT_ACTIONS = ["click", "dblclick", "fill", "type", "select", "check", "uncheck", "hover", "focus", "press", "submit"] as const;
export const PAGE_ACTIONS = ["open", "keyboard", "scroll", "wait", "back", "forward", "reload", "frame"] as const;
export const ACTION_TYPES: readonly string[] = [...ELEMENT_ACTIONS, ...PAGE_ACTIONS];
export const ACTION_FIELDS = new Set(["type", "intent", "candidates", "fingerprint", "value", "desired_state", "argv"]);
export const FIND_KINDS: Readonly<Record<string, Candidate["by"]>> = { label: "aria-label", placeholder: "placeholder", text: "text", testid: "testid" };
const FIND_ACTIONS = new Set(["click", "dblclick", "fill", "type", "select", "check", "uncheck", "hover", "focus"]);
const MAX_INTENT = 120;
const MAX_ARGV = 12;
const PARAM = /\{\{([a-z][a-z0-9_]{0,23})\}\}/gu;
const ATTRIBUTE_SELECTOR = /^(?:([a-z][a-z0-9-]*))?\[(aria-label|placeholder|name|data-testid)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\]\s"']+))\s*\]$/u;
const TEXT_SELECTOR = /^text=(?:"((?:[^"\\]|\\.)*)"|(.+))$/u;
const ROLE_SELECTOR = /^role=([a-z-]+)\[name=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\]$/u;

export type Action = {
  type: string;
  intent: string;
  candidates: Candidate[];
  fingerprint: Fingerprint | null;
  value?: string | null;
  desired_state?: boolean;
  argv?: string[];
};

function unescaped(text: string): string {
  return text.replace(/\\(.)/gu, "$1");
}

export function candidatesFromSelector(selector: string): Candidate[] {
  const attribute = ATTRIBUTE_SELECTOR.exec(selector);
  if (attribute) {
    const value = unescaped(attribute[3] ?? attribute[4] ?? attribute[5] ?? "");
    const kind = attribute[2] as string;
    if (kind === "aria-label") return [{ by: "aria-label", value }];
    if (kind === "placeholder") return [{ by: "placeholder", value }];
    if (kind === "data-testid") return [{ by: "testid", value }];
    return [attribute[1] ? { by: "name", value, tag: attribute[1] } : { by: "name", value }];
  }
  const text = TEXT_SELECTOR.exec(selector);
  if (text) return [{ by: "text", value: unescaped(text[1] ?? text[2] ?? "") }];
  const role = ROLE_SELECTOR.exec(selector);
  if (role) return [{ by: "role", value: role[1] as string, name: unescaped(role[2] ?? role[3] ?? "") }];
  if (selector.startsWith("xpath=") || selector.startsWith("//")) return [{ by: "xpath", value: selector.replace(/^xpath=/u, "") }];
  return [{ by: "css", value: selector }];
}

function flagValue(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(name);
  return at >= 0 && at + 1 < argv.length ? (argv[at + 1] as string) : null;
}

function withoutFlags(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === "--name" || token === "--nth") {
      index += 1;
      continue;
    }
    if (token.startsWith("--")) continue;
    out.push(token);
  }
  return out;
}

function make(type: string, candidates: Candidate[], fingerprint: Fingerprint | null, value: string | null = null): Action {
  const ranked = sortCandidates(candidates.filter((candidate) => candidateProblem(candidate) === null)).slice(0, MAX_CANDIDATES);
  const action: Action = { type, intent: intentOf(type, fingerprint, ranked, value), candidates: ranked, fingerprint };
  if (value !== null) action.value = value;
  if (type === "check") action.desired_state = true;
  if (type === "uncheck") action.desired_state = false;
  return action;
}

export function actionFromReplay(replay: readonly string[] | null | undefined): Action | null {
  if (!replay || replay.length === 0) return null;
  const [name, ...rest] = replay as [string, ...string[]];
  if (name === "open") return rest[0] ? { type: "open", intent: intentOf("open", null, []), candidates: [], fingerprint: null, value: rest[0] } : null;
  if (name === "find") {
    const plain = withoutFlags(rest);
    const locator = plain[0];
    const wanted = flagValue(rest, "--name");
    if (locator === "role") {
      const role = plain[1];
      const action = plain[2] ?? "click";
      if (!role || !FIND_ACTIONS.has(action)) return null;
      const fingerprint = wanted ? { role, name: wanted } : null;
      const candidates: Candidate[] = wanted ? [{ by: "role", value: role, name: wanted }] : [];
      if (candidates.length === 0) return null;
      return make(action, candidates, fingerprint, ["fill", "type", "select"].includes(action) ? plain.slice(3).join(" ") : null);
    }
    const kind = locator ? FIND_KINDS[locator] : undefined;
    const target = plain[1];
    const action = plain[2] ?? "click";
    if (!kind || !target || !FIND_ACTIONS.has(action)) return null;
    return make(action, [{ by: kind, value: target }], null, ["fill", "type", "select"].includes(action) ? plain.slice(3).join(" ") : null);
  }
  if (name === "press") {
    if (rest.length >= 2) return make("press", candidatesFromSelector(rest[0] as string), null, rest[1] as string);
    if (rest.length === 1) return { type: "press", intent: intentOf("press", null, [], rest[0] as string), candidates: [], fingerprint: null, value: rest[0] as string };
    return null;
  }
  if (["click", "dblclick", "hover", "focus", "check", "uncheck"].includes(name)) {
    const plain = withoutFlags(rest);
    return plain[0] ? make(name, candidatesFromSelector(plain[0]), null) : null;
  }
  if (name === "fill" || name === "type") return rest[0] ? make(name, candidatesFromSelector(rest[0]), null, rest.slice(1).join(" ")) : null;
  if (name === "select") return rest[0] ? make("select", candidatesFromSelector(rest[0]), null, rest.slice(1).join(" ")) : null;
  if ((PAGE_ACTIONS as readonly string[]).includes(name)) {
    return { type: name, intent: name === "keyboard" ? "type at the focused field" : `${name} the page`, candidates: [], fingerprint: null, argv: [...replay].slice(0, MAX_ARGV) };
  }
  return null;
}

export function isElementAction(action: Action | null | undefined): boolean {
  return Boolean(action) && (ELEMENT_ACTIONS as readonly string[]).includes((action as Action).type) && (action as Action).candidates.length + ((action as Action).fingerprint ? 1 : 0) > 0;
}

export function paramsIn(text: string): string[] {
  return [...text.matchAll(PARAM)].map((match) => match[1] as string);
}

export function fill(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(PARAM, (whole: string, name: string) => (Object.hasOwn(values, name) ? (values[name] as string) : whole));
}

export function actionProblem(raw: unknown, params: ReadonlySet<string>): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "an action that isn't an object";
  const action = raw as Record<string, unknown>;
  if (!Object.keys(action).every((key) => ACTION_FIELDS.has(key))) return "an action with fields a flow doesn't have";
  if (typeof action["type"] !== "string" || !ACTION_TYPES.includes(action["type"])) return "an action of an unknown type";
  if (typeof action["intent"] !== "string" || codePoints(action["intent"]).length > MAX_INTENT || action["intent"].includes("\n")) return "an action whose intent isn't one short line";
  if (!Array.isArray(action["candidates"])) return "an action with no candidate list";
  if (action["candidates"].length > MAX_CANDIDATES) return "an action with too many candidates";
  for (const candidate of action["candidates"]) {
    if (candidate === null || typeof candidate !== "object" || !CANDIDATE_KINDS.includes((candidate as Candidate).by)) return "a candidate of an unknown kind";
    const problem = candidateProblem(candidate as Candidate);
    if (problem) return `a candidate that isn't stable (${problem})`;
  }
  const fingerprint = action["fingerprint"];
  if (fingerprint !== null && fingerprint !== undefined) {
    if (typeof fingerprint !== "object" || typeof (fingerprint as Fingerprint).role !== "string" || typeof (fingerprint as Fingerprint).name !== "string") return "a fingerprint without role and name";
  }
  const value = action["value"];
  if (value !== undefined && value !== null) {
    if (typeof value !== "string" || codePoints(value).length > 2000) return "an action value that isn't text";
    for (const name of paramsIn(value)) if (!params.has(name)) return `an action that uses {{${name}}}, which isn't a param`;
  }
  const state = action["desired_state"];
  if (state !== undefined && typeof state !== "boolean") return "a desired_state that isn't true or false";
  const argv = action["argv"];
  if (argv !== undefined && (!Array.isArray(argv) || argv.length > MAX_ARGV || !argv.every((part) => typeof part === "string"))) return "an action argv that isn't a short list of words";
  if ((ELEMENT_ACTIONS as readonly string[]).includes(action["type"]) && action["type"] !== "press" && action["candidates"].length === 0 && !fingerprint) return "an element action with no way to find its element";
  return null;
}

function stateCommand(action: Action): string {
  if (action.type === "check" || action.type === "uncheck") return action.desired_state === false ? "uncheck" : "check";
  return action.type;
}

export function candidateArgv(action: Action, candidate: Candidate, values: Readonly<Record<string, string>>): string[] {
  const value = action.value === undefined || action.value === null ? null : fill(action.value, values);
  const command = stateCommand(action);
  if (candidate.by === "role") {
    const found = fingerprintArgv(action, { role: candidate.value, name: candidate.name ?? "" }, values);
    if (found !== null) return found;
  }
  const selector = selectorOf(candidate);
  if (command === "submit") return ["press", selector, "Enter"];
  if (command === "press") return ["press", selector, value ?? "Enter"];
  if (command === "fill" || command === "type" || command === "select") return [command, selector, value ?? ""];
  return [command, selector];
}

export function fingerprintArgv(action: Action, fingerprint: Fingerprint | null, values: Readonly<Record<string, string>>): string[] | null {
  if (fingerprint === null) return null;
  const value = action.value === undefined || action.value === null ? null : fill(action.value, values);
  let command = stateCommand(action);
  if (command === "submit" || command === "press") return null;
  if (!FIND_ACTIONS.has(command)) command = "click";
  const tail = command === "fill" || command === "type" || command === "select" ? [value ?? ""] : [];
  return ["find", "role", fingerprint.role, command, ...tail, "--name", fingerprint.name, "--exact"];
}

export function pageArgv(action: Action, values: Readonly<Record<string, string>>): string[] | null {
  if (action.type === "open") return action.value ? ["open", fill(action.value, values)] : null;
  if (action.type === "press" && action.candidates.length === 0 && !action.fingerprint) return ["press", fill(action.value ?? "Enter", values)];
  if (action.argv) return action.argv.map((part) => fill(part, values));
  return null;
}

export function unfilled(argv: readonly string[]): string[] {
  return [...new Set(argv.flatMap((part) => paramsIn(part)))];
}
