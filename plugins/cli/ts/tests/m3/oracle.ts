import fs from "node:fs";
import { dumps, parseText, type Value } from "../../src/json.ts";
import { BrowseError } from "../../src/browse/daemon-errors.ts";
import { Unsafe } from "../../src/browse/flowurl.ts";
import { PyException } from "../../src/pylib/str.ts";
import { FUNCTIONS } from "./oracle-fns.ts";
import { toValue } from "./values.ts";

const UNWORDED = new Set(["UnicodeEncodeError", "UnicodeDecodeError", "RecursionError"]);

function failure(error: unknown): Value {
  if (error instanceof BrowseError) {
    return new Map<string, Value>([
      ["type", error.constructor.name],
      ["message", error.text],
      ["code", error.code ?? null],
      ["data", error.data === undefined || error.data === null ? null : toValue(error.data)],
      ["exit", BigInt(error.exitCode)],
    ]);
  }
  if (error instanceof PyException) {
    const out = new Map<string, Value>([["type", error.type]]);
    if (!UNWORDED.has(error.type)) out.set("message", error.message);
    return out;
  }
  if (error instanceof Unsafe) return new Map<string, Value>([["type", "Unsafe"], ["message", error.message]]);
  if (error instanceof RangeError && /call stack/i.test(error.message)) return new Map<string, Value>([["type", "RecursionError"]]);
  return new Map<string, Value>([["type", `TS:${(error as Error)?.constructor?.name}`], ["message", String((error as Error)?.message ?? error)]]);
}

function answer(line: string): Value {
  const parsed = parseText(line);
  if (!(parsed instanceof Map)) throw new Error(`bad oracle line: ${line.slice(0, 200)}`);
  const name = parsed.get("fn") as string;
  const run = FUNCTIONS[name];
  if (run === undefined) return new Map<string, Value>([["raise", new Map<string, Value>([["type", "TS:missing"], ["message", name]])]]);
  try {
    return new Map<string, Value>([["ok", run(...(parsed.get("args") as Value[]))]]);
  } catch (error) {
    return new Map<string, Value>([["raise", failure(error)]]);
  }
}

const input = fs.readFileSync(0, "utf8");
const out: string[] = [];
for (const line of input.split("\n")) if (line.trim()) out.push(dumps(answer(line), "compact", true));
process.stdout.write(out.length ? `${out.join("\n")}\n` : "");
