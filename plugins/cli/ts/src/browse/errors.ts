import type { Crash } from "../crash.ts";
import { ALIASES, MUTATING } from "./tables.ts";

export class BrowseError extends Error {
  constructor(
    readonly text: string,
    readonly exit: number = 1,
    readonly code?: string,
    readonly fallback: string = "browse_error",
  ) {
    super(text);
  }
}

export class PythonCrash extends Error {
  constructor(
    readonly crash: Crash,
    readonly line: string,
  ) {
    super(line);
  }
}

export function builtinCrash(kind: string, message: string): PythonCrash {
  return new PythonCrash({ kind, value: kind }, `${kind}: ${message}`);
}

export function unreachable(message: string): BrowseError {
  return new BrowseError(message, 2, undefined, "daemon_unreachable");
}

export function outcomeUnknown(action: string, why: string): BrowseError {
  return new BrowseError(`${why}; the outcome of ${action} is unknown, so it wasn't retried`, 1, "outcome_unknown");
}

function commandOf(command: string): { name: string; mutating: boolean } {
  const name = ALIASES[command] ?? command;
  return { name, mutating: MUTATING.includes(name) };
}

export function gone(command: string): BrowseError {
  const { name, mutating } = commandOf(command);
  if (mutating) return outcomeUnknown(`\`${name}\``, "the ardia browse daemon went away after it took the command (see the session log)");
  return unreachable("the ardia browse daemon closed the connection without answering (it may have exited; see the session log)");
}

export function stalled(command: string, seconds: number): BrowseError {
  const { name, mutating } = commandOf(command);
  const why = `the ardia browse daemon didn't answer in ${formatG(seconds)} s (see the session log)`;
  return mutating ? outcomeUnknown(`\`${name}\``, why) : new BrowseError(why, 2, undefined, "daemon_timeout");
}

function exactDigits(value: number): { digits: string; point: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = exponentBits === 0 ? fraction : fraction | (1n << 52n);
  const exponent = (exponentBits === 0 ? 1 : exponentBits) - 1075;
  if (exponent >= 0) {
    const digits = (mantissa << BigInt(exponent)).toString();
    return { digits, point: digits.length };
  }
  const scaled = (mantissa * 5n ** BigInt(-exponent)).toString();
  return { digits: scaled, point: scaled.length + exponent };
}

function roundedDigits(value: number, precision: number): { digits: string; exponent: number } {
  const { digits, point } = exactDigits(value);
  const start = digits.search(/[1-9]/);
  const significant = digits.slice(start);
  let exponent = point - start - 1;
  let kept = significant.slice(0, precision).padEnd(precision, "0");
  const rest = significant.slice(precision);
  const first = rest.charCodeAt(0) - 48;
  const beyond = /[1-9]/.test(rest.slice(1));
  const odd = (kept.charCodeAt(precision - 1) - 48) % 2 === 1;
  if (rest !== "" && (first > 5 || (first === 5 && (beyond || odd)))) {
    const bumped = (BigInt(kept) + 1n).toString();
    if (bumped.length > precision) {
      exponent += 1;
      kept = bumped.slice(0, precision);
    } else kept = bumped;
  }
  return { digits: kept, exponent };
}

export function formatG(value: number, precision = 6): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const sign = value < 0 ? "-" : "";
  const { digits, exponent } = roundedDigits(Math.abs(value), precision);
  const trimmed = (text: string) => (text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text);
  if (exponent < -4 || exponent >= precision) {
    const mantissa = trimmed(`${digits[0]}.${digits.slice(1)}`);
    return `${sign}${mantissa}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  if (exponent < 0) return `${sign}${trimmed(`0.${"0".repeat(-exponent - 1)}${digits}`)}`;
  return `${sign}${trimmed(`${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`)}`;
}
