import { parse, type Value } from "./json.ts";

export const HAND_BACK = 253;
const CALLER_DEPTH = 2;
const MARKER = /^--ardia-routed=1:([01]):((?:[0-9a-f]{2})+)$/;

export type Routed = { interruptsIgnored: boolean; caller: Value; argv: string[] };

let current: Value | undefined;

function callerOf(hex: string): Value | undefined {
  const value = parse(Buffer.from(hex, "hex"), CALLER_DEPTH);
  if (!(value instanceof Map) || typeof value.get("name") !== "string") return undefined;
  for (const [key, field] of value) {
    if ((key !== "name" && key !== "app") || typeof field !== "string") return undefined;
  }
  return value;
}

export function takeMarker(words: string[]): Routed | undefined {
  const found = MARKER.exec(words[0] ?? "");
  if (found === null) return undefined;
  const caller = callerOf(found[2] ?? "");
  if (caller === undefined) return undefined;
  current = caller;
  return { interruptsIgnored: found[1] === "1", caller, argv: words.slice(1) };
}

export function routedCaller(): Value {
  if (current === undefined) throw new Error("ardia-ts runs only through ardia");
  return current;
}
