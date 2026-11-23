import { inert, jsonSafe, shown } from "../../src/printable.ts";
import { BrowseError } from "../../src/browse/daemon-errors.ts";
import { Unsafe } from "../../src/browse/flowurl.ts";
import { dumps, parseText, type Value } from "../../src/json.ts";
import { PyException } from "../../src/pylib/str.ts";
import { PURE } from "./oracle-fns.ts";
import { toValue } from "./values.ts";

type Twin = (...args: never[]) => unknown;

const FUNCTIONS: Record<string, Twin> = {
  "printable.shown": shown as Twin,
  "printable.inert": inert as Twin,
  "printable.json_safe": jsonSafe as Twin,
};
const UNWORDED = new Set(["UnicodeEncodeError", "UnicodeDecodeError", "RecursionError"]);

function errorName(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function failure(error: unknown): Map<string, Value> {
  if (error instanceof BrowseError) {
    return new Map<string, Value>([
      ["error", `${error.constructor.name}: ${error.text}`],
      ["code", error.code ?? null],
      ["data", error.data === undefined || error.data === null ? null : toValue(error.data)],
      ["exit", BigInt(error.exitCode)],
    ]);
  }
  if (error instanceof PyException) return new Map<string, Value>([["error", UNWORDED.has(error.type) ? error.type : `${error.type}: ${error.message}`]]);
  if (error instanceof Unsafe) return new Map<string, Value>([["error", `Unsafe: ${error.message}`]]);
  if (error instanceof RangeError && /call stack/i.test(error.message)) return new Map<string, Value>([["error", "RecursionError"]]);
  return new Map<string, Value>([["error", `TS:${errorName(error)}`]]);
}

function runPure(name: string, input: string): string {
  const run = PURE[name] as (...args: Value[]) => Value;
  const cases = parseText(input);
  if (!Array.isArray(cases)) throw new Error("oracle.ts: stdin isn't a JSON list of argument lists");
  const results: Value[] = cases.map((args) => {
    try {
      return new Map<string, Value>([["ok", run(...(args as Value[]))]]);
    } catch (error) {
      return failure(error);
    }
  });
  return dumps(results, "compact", true);
}

export function answers(name: string, input: string): string {
  if (Object.hasOwn(PURE, name)) return runPure(name, input);
  const twin = FUNCTIONS[name];
  if (!twin) throw new Error(`oracle.ts: no TypeScript twin registered for ${JSON.stringify(name)}`);
  const cases = JSON.parse(input) as unknown[][];
  const results = cases.map((args) => {
    try {
      return { ok: twin(...(args as never[])) ?? null };
    } catch (error) {
      return { error: errorName(error) };
    }
  });
  return JSON.stringify(results);
}

if (import.meta.main) {
  const name = process.argv[2] ?? "";
  if (!Object.hasOwn(PURE, name) && !FUNCTIONS[name]) {
    process.stderr.write(`oracle.ts: no TypeScript twin registered for ${JSON.stringify(name)}\n`);
    process.exitCode = 2;
  } else process.stdout.write(answers(name, await Bun.stdin.text()));
}
