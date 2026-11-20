import { type Entry, type Message } from "./canon.ts";
import { actingStep } from "../../src/browse/plugin/acting.ts";
import { engineRefusal } from "../../src/browse/plugin/engine-codes.ts";
import { forbidden, INPUT_METHODS, KEY_COMMANDS, mouseViolation, PAGE_SESSION_ONLY, SENT_METHODS } from "../../src/browse/plugin/policy.ts";

export type Violation = { rule: "forbidden" | "unlisted" | "pipelined" | "key_params" | "session" | "wheel_outside_act" | "hidden_wheel" | "between_steps"; at: number; method: string; detail: string };

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
  const hiddenWheels = new Set<string>();
  let acting: boolean | null = null;
  let between = false;
  let stepName = "";
  entries.forEach((entry, at) => {
    if (entry.k === "done") {
      between = true;
      return;
    }
    if (entry.k === "mark") {
      between = false;
      stepName = String(entry.step ?? "");
      acting = Array.isArray(entry["argv"]) ? actingStep(entry["argv"] as unknown[]) : null;
      return;
    }
    if (entry.k === "visibility") {
      if (entry["state"] === "hidden") hiddenWheels.add(`${entry.c ?? 0}:${String(entry["wheel"])}`);
      return;
    }
    const conn = entry.c ?? 0;
    const message = parsed(entry.m);
    if (message === null) return;
    if (between && (entry.k === "out" || (entry.k === "in" && message.id === undefined))) {
      found.push({ rule: "between_steps", at, method: message.method ?? `answer ${String(message.id)}`, detail: `a CDP message ${entry.k === "out" ? "from" : "to"} the daemon after ${stepName || "a step"} answered and before the next step` });
    }
    const waiting = outstanding.get(conn) ?? new Map<number, string>();
    outstanding.set(conn, waiting);
    const wire = wires.get(conn) ?? { asked: new Map(), pageTargets: new Set(), pageSessions: new Set() };
    wires.set(conn, wire);
    if (entry.k === "emulated") return;
    if (entry.k === "in" && typeof message.id === "number") {
      if (hiddenWheels.delete(`${conn}:${message.id}`)) {
        const said = String((message.error as { message?: unknown } | undefined)?.message ?? "");
        if (engineRefusal(said)?.code !== "page_hidden") found.push({ rule: "hidden_wheel", at, method: "Input.dispatchMouseEvent", detail: "a wheel reached a hidden page instead of being refused" });
      }
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
    if (method === "Input.dispatchMouseEvent" && params["type"] === "mouseWheel" && acting !== true) {
      found.push({ rule: "wheel_outside_act", at, method, detail: `a wheel during ${acting === false ? "a read" : "a step the harness didn't classify"} (${stepName || "before any step"})` });
    }
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
