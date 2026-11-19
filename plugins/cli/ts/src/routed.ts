import { fstatSync } from "node:fs";
import { parse, TooDeep, type Value } from "./json.ts";

export const HAND_BACK = 253;
const CALLER_DEPTH = 2;
const MARKER = /^--ardia-routed=2:([01]):([1-9][0-9]{0,8}):((?:[0-9a-f]{2})+)$/;
const FIRST_FREE_FD = 3;

export type Routed = { interruptsIgnored: boolean; lifeline: number; caller: Value; argv: string[] };

let current: Value | undefined;

function parsedCaller(hex: string): Value | undefined {
  try {
    return parse(Buffer.from(hex, "hex"), CALLER_DEPTH);
  } catch (error) {
    if (error instanceof TooDeep) return undefined;
    throw error;
  }
}

function callerOf(hex: string): Value | undefined {
  const value = parsedCaller(hex);
  if (!(value instanceof Map) || typeof value.get("name") !== "string") return undefined;
  for (const [key, field] of value) {
    if ((key !== "name" && key !== "app") || typeof field !== "string") return undefined;
  }
  return value;
}

function isPipe(fd: number): boolean {
  if (fd < FIRST_FREE_FD) return false;
  try {
    return fstatSync(fd).isFIFO();
  } catch {
    return false;
  }
}

export function takeMarker(words: string[]): Routed | undefined {
  const found = MARKER.exec(words[0] ?? "");
  if (found === null) return undefined;
  const lifeline = Number(found[2]);
  const caller = callerOf(found[3] ?? "");
  if (caller === undefined || !isPipe(lifeline)) return undefined;
  current = caller;
  return { interruptsIgnored: found[1] === "1", lifeline, caller, argv: words.slice(1) };
}

export function routedCaller(): Value {
  if (current === undefined) throw new Error("ardia-ts runs only through ardia");
  return current;
}
