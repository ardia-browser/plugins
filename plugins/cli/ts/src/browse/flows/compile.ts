import { codePoints } from "../../pystr.ts";
import { literalOk } from "../flowurl.ts";
import { type Action, candidateArgv, fingerprintArgv } from "./actions.ts";
import { type Descriptor, fingerprintOf, intentOf, rankCandidates } from "./locators.ts";

export const MAX_EVENTS = 500;
export const MAX_VALUE = 2000;
export const CAUSED_WINDOW_MS = 2500;
export const REDACTED = "<redacted>";
const PARAM_NAME = /^[a-z][a-z0-9_]{0,23}$/u;
export const TOGGLE_ROLES: ReadonlySet<string> = new Set(["switch", "checkbox", "radio", "menuitemcheckbox", "menuitemradio"]);

export type RecEvent = {
  kind: "click" | "confirm" | "fill" | "select" | "press" | "submit" | "navigate";
  pointer?: string;
  at: number;
  target?: Descriptor | null;
  value?: string | null;
  checked?: boolean | null;
  secret?: boolean;
  key?: string | null;
  url?: string | null;
  frame?: { css?: string | null; url?: string | null } | null;
  method?: string | null;
};

export type CompiledStep = { seq: number; command: string[]; url: string; ok: boolean; requests: never[]; action: Action };
export type CompiledParam = { name: string; example: string | null; source: string };
export type Compiled = { steps: CompiledStep[]; params: CompiledParam[]; writes: boolean; skipped: { at: number; why: string }[]; hosts: string[] };

function slug(text: string): string | null {
  const name = String(text || "")
    .replace(/(?<=[a-z0-9])(?=[A-Z])/gu, "_")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 24)
    .replace(/_+$/u, "");
  return PARAM_NAME.test(name) ? name : null;
}

function clip(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  const points = codePoints(text);
  return points.length <= MAX_VALUE ? text : points.slice(0, MAX_VALUE).join("");
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function sameTarget(a: Descriptor | null | undefined, b: Descriptor | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.css && b.css) return a.css === b.css;
  return (a.xpath ?? "") === (b.xpath ?? "") && (a.name ?? "") === (b.name ?? "");
}

function elementAction(type: string, target: Descriptor, value: string | null = null, desired: boolean | null = null): Action | null {
  const candidates = rankCandidates(target);
  const fingerprint = fingerprintOf(target);
  if (candidates.length === 0 && fingerprint === null) return null;
  const action: Action = { type, intent: intentOf(type, fingerprint, candidates, value), candidates, fingerprint };
  if (value !== null) action.value = value;
  if (desired !== null) action.desired_state = desired;
  return action;
}

function commandOf(action: Action): string[] {
  if (action.argv) return [...action.argv];
  if (action.type === "open") return ["open", action.value ?? ""];
  const first = action.candidates[0];
  if (first) return candidateArgv(action, first, {});
  return fingerprintArgv(action, action.fingerprint, {}) ?? [action.type];
}

function submitsWrite(event: RecEvent): boolean {
  return (event.method ?? "get").toLowerCase() !== "get";
}

export function settledClicks(given: readonly RecEvent[]): RecEvent[] {
  const confirmed = new Map<string, boolean | null>();
  for (const event of given) if (event.kind === "confirm" && typeof event.pointer === "string") confirmed.set(event.pointer, event.checked ?? null);
  const navigations = given.filter((event) => event.kind === "navigate").map((event) => event.at);
  const out: RecEvent[] = [];
  for (const event of given) {
    if (event.kind === "confirm") continue;
    if (event.kind === "click" && typeof event.pointer === "string") {
      if (confirmed.has(event.pointer)) {
        const checked = confirmed.get(event.pointer);
        out.push(checked === null || checked === undefined ? event : { ...event, checked });
      } else if (navigations.some((at) => at >= event.at && at - event.at <= CAUSED_WINDOW_MS)) out.push(event);
      continue;
    }
    out.push(event);
  }
  return out;
}

export function compileEvents(given: readonly RecEvent[], startUrl: string): Compiled {
  const events = settledClicks([...given].slice(0, MAX_EVENTS).sort((a, b) => a.at - b.at));
  const steps: CompiledStep[] = [];
  const params: CompiledParam[] = [];
  const skipped: { at: number; why: string }[] = [];
  const hosts = new Set<string>();
  const start = originOf(startUrl);
  if (start) hosts.add(start);
  let writes = false;
  let url = startUrl;
  let frame: string | null = null;
  let lastUserAt = Number.NEGATIVE_INFINITY;
  let lastTarget: Descriptor | null = null;
  const push = (action: Action) => {
    steps.push({ seq: steps.length + 1, command: commandOf(action), url, ok: true, requests: [], action });
  };
  const paramFor = (target: Descriptor, value: string, secret: boolean): string => {
    const taken = new Set(params.map((param) => param.name));
    const hint = slug(target.ariaLabel || target.placeholder || target.fieldName || target.name || (secret ? "password" : "text")) ?? (secret ? "password" : "text");
    let name = hint;
    let number = 2;
    while (taken.has(name)) name = `${hint.slice(0, 21)}_${number++}`;
    params.push({ name, example: secret || !literalOk(value) ? null : value, source: secret ? "secret" : "typed" });
    return `{{${name}}}`;
  };
  const enterFrame = (event: RecEvent) => {
    const wanted = event.frame?.css ?? null;
    if (wanted === frame) return;
    const argv = wanted === null ? ["frame", "main"] : ["frame", wanted];
    push({ type: "frame", intent: wanted === null ? "go back to the main page" : "go into the frame", candidates: [], fingerprint: null, argv });
    frame = wanted;
  };
  push({ type: "open", intent: intentOf("open", null, []), candidates: [], fingerprint: null, value: startUrl });
  for (const event of events) {
    if (event.kind === "navigate") {
      const target = typeof event.url === "string" ? event.url : "";
      const origin = originOf(target);
      if (!origin) continue;
      hosts.add(origin);
      if (event.at - lastUserAt > CAUSED_WINDOW_MS && target !== url) {
        frame = null;
        push({ type: "open", intent: "open a page", candidates: [], fingerprint: null, value: target });
      }
      url = target;
      continue;
    }
    const target = event.target ?? null;
    if (target === null && event.kind !== "press") {
      skipped.push({ at: event.at, why: `a ${event.kind} with no element` });
      continue;
    }
    enterFrame(event);
    lastUserAt = event.at;
    if (event.kind === "fill") {
      const value = clip(event.value);
      const previous = steps.at(-1);
      if (previous && previous.action.type === "fill" && sameTarget(lastTarget, target)) {
        const old = previous.action.value ?? "";
        const oldName = /^\{\{([a-z0-9_]+)\}\}$/u.exec(old)?.[1];
        const at = oldName ? params.findIndex((param) => param.name === oldName) : -1;
        if (at >= 0) params.splice(at, 1);
        steps.pop();
      }
      const text = event.secret ? paramFor(target as Descriptor, REDACTED, true) : value === "" ? "" : paramFor(target as Descriptor, value, false);
      const action = elementAction("fill", target as Descriptor, text);
      if (action === null) skipped.push({ at: event.at, why: "a field with nothing stable to find it by" });
      else push(action);
      lastTarget = target;
      continue;
    }
    if (event.kind === "select") {
      const action = elementAction("select", target as Descriptor, clip(event.value));
      if (action === null) skipped.push({ at: event.at, why: "a list with nothing stable to find it by" });
      else push(action);
      lastTarget = target;
      continue;
    }
    if (event.kind === "click") {
      const kind = (target?.type ?? "").toLowerCase();
      const toggle = kind === "checkbox" || kind === "radio" || TOGGLE_ROLES.has((target?.role ?? "").toLowerCase());
      const type = toggle ? (event.checked === false ? "uncheck" : "check") : "click";
      const previous = steps.at(-1);
      if (toggle && previous && ["check", "uncheck"].includes(previous.action.type) && sameTarget(lastTarget, target)) steps.pop();
      const action = elementAction(type, target as Descriptor, null, toggle ? event.checked !== false : null);
      if (action === null) skipped.push({ at: event.at, why: "a click on something with nothing stable to find it by" });
      else push(action);
      if (kind === "submit" && submitsWrite(event)) writes = true;
      lastTarget = target;
      continue;
    }
    if (event.kind === "press") {
      const key = event.key ?? "Enter";
      const where = target ?? lastTarget;
      const action = where ? elementAction("press", where, key) : null;
      push(action ?? { type: "press", intent: intentOf("press", null, [], key), candidates: [], fingerprint: null, value: key });
      continue;
    }
    if (event.kind === "submit") {
      if (submitsWrite(event)) writes = true;
      const previous = steps.at(-1);
      const caused = previous && (previous.action.type === "click" || (previous.action.type === "press" && previous.action.value === "Enter"));
      if (caused) continue;
      const field = lastTarget;
      const action = field ? elementAction("press", field, "Enter") : null;
      if (action === null) skipped.push({ at: event.at, why: "a form sent with no field to press Enter in" });
      else push({ ...action, type: "submit", intent: intentOf("submit", action.fingerprint, action.candidates) });
    }
  }
  if (frame !== null) push({ type: "frame", intent: "go back to the main page", candidates: [], fingerprint: null, argv: ["frame", "main"] });
  if (steps.some((step) => step.action.type !== "open" && step.action.type !== "frame")) writes = true;
  return { steps, params, writes, skipped, hosts: [...hosts].sort() };
}
