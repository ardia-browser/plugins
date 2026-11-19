import { type Entry, type Message } from "./canon.ts";
import { forbidden, INPUT_METHODS, KEY_COMMANDS, SENT_METHODS } from "../../src/browse/plugin/policy.ts";

export type Violation = { rule: "forbidden" | "unlisted" | "pipelined" | "key_params" | "drag"; at: number; method: string; detail: string };

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
  const pressedAt = new Map<number, string>();
  entries.forEach((entry, at) => {
    const conn = entry.c ?? 0;
    const message = parsed(entry.m);
    if (message === null) return;
    const waiting = outstanding.get(conn) ?? new Map<number, string>();
    outstanding.set(conn, waiting);
    if (entry.k === "in" && typeof message.id === "number") {
      waiting.delete(message.id);
      return;
    }
    if (entry.k !== "out" || typeof message.method !== "string") return;
    const method = message.method;
    const params = (message.params ?? {}) as Record<string, unknown>;
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
      const type = params["type"];
      const point = `${String(params["x"])},${String(params["y"])}`;
      const session = message.sessionId ?? "";
      if (type === "mousePressed") pressedAt.set(conn, `${session}@${point}`);
      else if (type === "mouseReleased") {
        const pressed = pressedAt.get(conn);
        if (pressed !== undefined && pressed !== `${session}@${point}`) found.push({ rule: "drag", at, method, detail: `released at ${point} after pressing at ${pressed}` });
        pressedAt.delete(conn);
      } else if (type === "mouseMoved" && (pressedAt.has(conn) || Number(params["buttons"] ?? 0) !== 0)) {
        found.push({ rule: "drag", at, method, detail: "moved with a button held" });
      }
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
