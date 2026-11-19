import type { Value } from "../json.ts";
import { reprStr } from "../py.ts";
import { plainNumber, pythonFloat, secondsOf } from "./args.ts";
import { builtinCrash, type PythonCrash } from "./errors.ts";
import { BEHIND_SCRIPT_WAIT, COMMAND_LIMIT, DEFAULT_TIMEOUT_MS, LIMIT_MARGIN, LONG_COMMANDS, QUEUE_WAIT, SCRIPT_DEFAULT } from "./tables.ts";

const PYTIME_LIMIT = 2 ** 63;

function pyMax(first: number, second: number): number {
  return second > first ? second : first;
}

function pyOr(...values: (number | undefined)[]): number | undefined {
  for (const value of values.slice(0, -1)) if (value !== undefined && value !== 0) return value;
  return values.at(-1);
}

function givenTimeout(argv: readonly string[]): number | undefined {
  let given: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === "--") break;
    if (token === "--timeout" && index + 1 < argv.length) given = secondsOf(argv[index + 1]);
    else if (token.startsWith("--timeout=")) given = secondsOf(token.slice("--timeout=".length));
  }
  return given;
}

export function commandLimit(name: string, argv: readonly string[], timeout: number): number {
  const given = givenTimeout(argv);
  if (name === "wait") {
    const found = argv.find((arg) => plainNumber(arg));
    const plain = found === undefined ? undefined : secondsOf(found);
    return pyMax(COMMAND_LIMIT, (pyOr(given, plain, timeout) as number) + LIMIT_MARGIN);
  }
  if (name === "script") return (pyOr(given, SCRIPT_DEFAULT) as number) + LIMIT_MARGIN;
  return pyMax(LONG_COMMANDS[name] ?? COMMAND_LIMIT, (pyOr(given, 0) as number) + LIMIT_MARGIN);
}

export function queueWait(name: string, argv: readonly string[], patient: boolean): number {
  if (patient) return pyMax(QUEUE_WAIT, commandLimit(name, argv, DEFAULT_TIMEOUT_MS / 1000) - LIMIT_MARGIN);
  if (name !== "script") return QUEUE_WAIT;
  return pyMax(QUEUE_WAIT, pyOr(givenTimeout(argv), SCRIPT_DEFAULT) as number);
}

function timeoutOf(value: Value): number | PythonCrash {
  if (typeof value === "bigint") return Number(value) / 1000;
  const text = String(value);
  const parsed = pythonFloat(text);
  if (parsed === undefined) return builtinCrash("ValueError", `could not convert string to float: ${reprStr(text)}`);
  return parsed / 1000;
}

export function answerDeadline(argv: readonly string[], timeoutMs: Value, patient = false): number | PythonCrash {
  const timeout = timeoutOf(timeoutMs);
  if (typeof timeout !== "number") return timeout;
  const name = argv[0] ?? "";
  const rest = argv.slice(1);
  const waits = pyMax(queueWait(name, rest, patient), BEHIND_SCRIPT_WAIT);
  const seconds = waits + commandLimit(name, rest, timeout) + LIMIT_MARGIN;
  if (Number.isNaN(seconds)) return builtinCrash("ValueError", "Invalid value NaN (not a number)");
  if (Math.ceil(seconds * 1e9) >= PYTIME_LIMIT) return builtinCrash("OverflowError", "timestamp out of range for C PyTime_t");
  return seconds;
}
