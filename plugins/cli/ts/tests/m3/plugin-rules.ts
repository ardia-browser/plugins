import { type Entry, type Message } from "./canon.ts";
import { canonical } from "../../src/browse/daemon/names.ts";
import { findAction } from "../../src/browse/plugin/commands2.ts";
import { forbidden, INPUT_METHODS, KEY_COMMANDS, LEASE_GATED, mouseViolation, SENT_METHODS } from "../../src/browse/plugin/policy.ts";

export type Violation = { rule: "forbidden" | "unlisted" | "pipelined" | "key_params" | "lease"; at: number; method: string; detail: string };

const ACTING = new Set(["click", "fill", "type", "press", "scroll"]);

export function actingStep(argv: readonly string[]): boolean {
  const name = canonical(String(argv[0] ?? ""));
  if (ACTING.has(name)) return true;
  if (name !== "find") return false;
  try {
    return findAction(argv.slice(1).map(String)) !== "text";
  } catch {
    return true;
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
  let acting: boolean | null = null;
  let stepName = "";
  entries.forEach((entry, at) => {
    if (entry.k === "mark") {
      stepName = String(entry.step ?? "");
      acting = Array.isArray(entry["argv"]) ? actingStep(entry["argv"] as string[]) : null;
      return;
    }
    const conn = entry.c ?? 0;
    const message = parsed(entry.m);
    if (message === null) return;
    const waiting = outstanding.get(conn) ?? new Map<number, string>();
    outstanding.set(conn, waiting);
    if (entry.k === "emulated") return;
    if (entry.k === "in" && typeof message.id === "number") {
      waiting.delete(message.id);
      return;
    }
    if (entry.k !== "out" || typeof message.method !== "string") return;
    const method = message.method;
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (LEASE_GATED.has(method) && acting !== true) found.push({ rule: "lease", at, method, detail: `sent during ${acting === false ? "a read" : "a step the harness didn't classify"} (${stepName || "before any step"}); it needs a live act lease, so only acting steps send it` });
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
