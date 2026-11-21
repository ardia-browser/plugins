import { readFileSync } from "node:fs";
import { dumps, parseText, type Value } from "../../src/json.ts";
import { PyException } from "../../src/pylib/str.ts";
import { IdnaFailure } from "../../src/urlmatch/idna.ts";
import { NotAnAddress } from "../../src/urlmatch/ip.ts";
import { PatternError } from "../../src/urlmatch/urlmatch.ts";
import { ScriptError } from "../../src/scripts/userscript.ts";
import { FUNCTIONS } from "./functions.ts";

export function toValue(value: unknown): Value {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "bigint" || typeof value === "boolean" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(toValue);
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [String(key), toValue(item)]));
  if (typeof value === "object") return new Map(Object.entries(value).map(([key, item]) => [key, toValue(item)]));
  throw new Error(`oracle.ts: can't show ${typeof value}`);
}

export function fromValue(value: Value | undefined): unknown {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(fromValue);
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [key, fromValue(item)]));
  return value ?? null;
}

function failure(error: unknown): Value {
  if (error instanceof PatternError) return new Map([["error", `PatternError: ${error.message}`]]);
  if (error instanceof ScriptError) return new Map([["error", `ScriptError: ${error.message}`]]);
  if (error instanceof IdnaFailure) return new Map([["error", "UnicodeError"]]);
  if (error instanceof NotAnAddress) return new Map([["error", "AddressValueError"]]);
  if (error instanceof PyException) return new Map([["error", error.type.startsWith("Unicode") ? "UnicodeError" : `${error.type}: ${error.message}`]]);
  if (error instanceof Error) return new Map([["error", `TS:${error.name}: ${error.message}`]]);
  return new Map([["error", `TS:${String(error)}`]]);
}

function main(): number {
  const name = process.argv[2] ?? "";
  const run = FUNCTIONS[name] as ((...args: unknown[]) => unknown) | undefined;
  if (run === undefined) {
    process.stderr.write(`oracle.ts: no TypeScript twin for ${JSON.stringify(name)}\n`);
    return 2;
  }
  const cases = parseText(readFileSync(0, "utf8"));
  if (!Array.isArray(cases)) throw new Error("oracle.ts: stdin isn't a JSON list of argument lists");
  const results = cases.map((args) => {
    try {
      return new Map<string, Value>([["ok", toValue(run(...(fromValue(args) as unknown[])))]]);
    } catch (error) {
      return failure(error);
    }
  });
  process.stdout.write(dumps(results, "compact", true));
  return 0;
}

if (import.meta.main) process.exitCode = main();
