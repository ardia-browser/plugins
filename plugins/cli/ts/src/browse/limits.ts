import { isSpace, strip } from "../py.ts";
import { decimalDigits } from "../pylib/str.ts";

export const QUEUE_WAIT = 30.0;
export const BEHIND_SCRIPT_WAIT = 300.0;
export const COMMAND_LIMIT = 120.0;
export const LIMIT_MARGIN = 30.0;
export const SCRIPT_DEFAULT = 90.0;
export const DEFAULT_TIMEOUT_MS = 25000;
export const LONG_COMMANDS: Readonly<Record<string, number>> = { batch: 600.0, read: 600.0, record: 600.0 };
const UNITS: Readonly<Record<string, number>> = { ms: 0.001, s: 1, m: 60 };

function plainDecimal(text: string): string | undefined {
  const point = text.indexOf(".");
  const whole = decimalDigits(point < 0 ? text : text.slice(0, point));
  if (whole === undefined || whole === "") return undefined;
  if (point < 0) return whole;
  const fraction = decimalDigits(text.slice(point + 1));
  return fraction === undefined || fraction === "" ? undefined : `${whole}.${fraction}`;
}

export function isPlainNumber(text: string): boolean {
  return plainDecimal(text) !== undefined;
}

export function secondsOf(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const body = strip(text, isSpace);
  let unit = "ms";
  let number = body;
  for (const suffix of ["ms", "s", "m"]) {
    if (body.endsWith(suffix)) {
      unit = suffix;
      number = body.slice(0, -suffix.length);
      break;
    }
  }
  const digits = plainDecimal(number);
  if (digits === undefined) return undefined;
  return Number(digits) * (UNITS[unit] as number);
}

function or(...values: (number | undefined)[]): number | undefined {
  for (const value of values.slice(0, -1)) if (value !== undefined && value !== 0) return value;
  return values.at(-1);
}

function max(first: number, second: number): number {
  return second > first ? second : first;
}

export function givenTimeout(argv: readonly string[]): number | undefined {
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
    const found = argv.find(isPlainNumber);
    const plain = found === undefined ? undefined : secondsOf(found);
    return max(COMMAND_LIMIT, (or(given, plain, timeout) as number) + LIMIT_MARGIN);
  }
  if (name === "script") return (or(given, SCRIPT_DEFAULT) as number) + LIMIT_MARGIN;
  return max(LONG_COMMANDS[name] ?? COMMAND_LIMIT, (or(given, 0) as number) + LIMIT_MARGIN);
}

export function queueWait(name: string, argv: readonly string[], base = QUEUE_WAIT, patient = false): number {
  if (patient) return max(base, commandLimit(name, argv, DEFAULT_TIMEOUT_MS / 1000) - LIMIT_MARGIN);
  if (name !== "script") return base;
  return max(base, or(givenTimeout(argv), SCRIPT_DEFAULT) as number);
}
