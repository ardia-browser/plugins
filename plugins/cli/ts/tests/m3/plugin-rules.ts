import { type Entry, type Message } from "./canon.ts";
import { forbidden, INPUT_METHODS, KEY_COMMANDS, mouseViolation, PAGE_SESSION_ONLY, SENT_METHODS } from "../../src/browse/plugin/policy.ts";

export type Violation = { rule: "forbidden" | "unlisted" | "pipelined" | "key_params" | "session"; at: number; method: string; detail: string };

type Wire = { asked: Map<number, Message>; pageTargets: Set<string>; pageSessions: Set<string> };

function noteTargets(wire: Wire, infos: unknown): void {
  for (const info of Array.isArray(infos) ? infos : [infos]) {
    if (info === null || typeof info !== "object") continue;
    const { targetId, type, subtype } = info as Record<string, unknown>;
    if (typeof targetId !== "string") continue;
    if (type === "page" && (subtype === undefined || subtype === "")) wire.pageTargets.add(targetId);
    else wire.pageTargets.delete(targetId);
  }
}

function noteAnswer(wire: Wire, message: Message): void {
  const asked = wire.asked.get(message.id as number);
  wire.asked.delete(message.id as number);
  const result = (message.result ?? {}) as Record<string, unknown>;
  if (asked?.method === "Target.getTargets") noteTargets(wire, result["targetInfos"]);
  else if (asked?.method === "Target.getTargetInfo") noteTargets(wire, result["targetInfo"]);
  else if (asked?.method === "Target.attachToTarget" && typeof result["sessionId"] === "string") {
    const target = (asked.params as Record<string, unknown> | undefined)?.["targetId"];
    if (typeof target === "string" && wire.pageTargets.has(target)) wire.pageSessions.add(result["sessionId"]);
  }
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

function keyViolation(params: Record<string, unknown>): string | null {
  if ("nativeVirtualKeyCode" in params) return "nativeVirtualKeyCode";
  if ("isSystemKey" in params) return "isSystemKey";
  const commands = params["commands"];
  if (commands !== undefined && (!Array.isArray(commands) || commands.some((command) => !KEY_COMMANDS.has(String(command))))) return `commands ${JSON.stringify(commands)}`;
  return null;
}

export function pluginViolations(entries: readonly Entry[]): Violation[] {
  const found: Violation[] = [];
  const outstanding = new Map<number, Map<number, string>>();
  const wires = new Map<number, Wire>();
  entries.forEach((entry, at) => {
    if (entry.k === "mark") return;
    const conn = entry.c ?? 0;
    const message = parsed(entry.m);
    if (message === null) return;
    const waiting = outstanding.get(conn) ?? new Map<number, string>();
    outstanding.set(conn, waiting);
    const wire = wires.get(conn) ?? { asked: new Map(), pageTargets: new Set(), pageSessions: new Set() };
    wires.set(conn, wire);
    if (entry.k === "emulated") return;
    if (entry.k === "in" && typeof message.id === "number") {
      waiting.delete(message.id);
      noteAnswer(wire, message);
      return;
    }
    if (entry.k === "in" && message.method === "Target.detachedFromTarget") {
      wire.pageSessions.delete(String((message.params as Record<string, unknown> | undefined)?.["sessionId"]));
      return;
    }
    if (entry.k !== "out" || typeof message.method !== "string") return;
    const method = message.method;
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (typeof message.id === "number") wire.asked.set(message.id, message);
    if (PAGE_SESSION_ONLY.has(method) && (message.sessionId === undefined || !wire.pageSessions.has(message.sessionId))) {
      found.push({ rule: "session", at, method, detail: message.sessionId === undefined ? "sent on the browser session, not a page target's own" : `sent on session ${message.sessionId}, which isn't a page target's own` });
    }
    if (forbidden(method)) found.push({ rule: "forbidden", at, method, detail: "never sent in plugin mode" });
    else if (!SENT_METHODS.has(method)) found.push({ rule: "unlisted", at, method, detail: "not on the plugin daemon's method list" });
    if (!INPUT_METHODS.has(method)) return;
    if (waiting.size > 0) {
      const [earlierId, earlier] = [...waiting][0] as [number, string];
      found.push({ rule: "pipelined", at, method, detail: `sent while ${earlier} (id ${earlierId}) was still unanswered` });
    }
    if (typeof message.id === "number") waiting.set(message.id, method);
    if (method === "Input.dispatchKeyEvent") {
      const bad = keyViolation(params);
      if (bad !== null) found.push({ rule: "key_params", at, method, detail: bad });
    }
    if (method === "Input.dispatchMouseEvent") {
      const bad = mouseViolation(params);
      if (bad !== null) found.push({ rule: "forbidden", at, method, detail: bad });
    }
  });
  return found;
}

export function methodsBetweenMarks(entries: readonly Entry[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let step = "";
  for (const entry of entries) {
    if (entry.k === "mark") {
      step = String(entry.step ?? "");
      out.set(step, []);
      continue;
    }
    if (entry.k !== "out") continue;
    const message = parsed(entry.m);
    if (message?.method) out.get(step)?.push(message.method);
  }
  return out;
}
