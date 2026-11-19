import { Float, type JsonObject, type Value } from "../json.ts";
import { reprStr, truthy } from "../py.ts";
import { codePointCount } from "../pystr.ts";
import { pythonInt } from "./args.ts";
import { builtinCrash, type PythonCrash } from "./errors.ts";
import { METRIC_COUNTS, METRIC_DURATIONS, METRIC_FLAGS, METRIC_MAX_COUNT, METRIC_MAX_MS } from "./tables.ts";

const LONG_MIN = -(1n << 63n);
const LONG_MAX = (1n << 63n) - 1n;

export function typeName(value: Value | undefined): string {
  if (value === null || value === undefined) return "NoneType";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "bigint") return "int";
  if (value instanceof Float) return "float";
  if (typeof value === "string") return "str";
  return Array.isArray(value) ? "list" : "dict";
}

export function noGet(value: Value): PythonCrash {
  return builtinCrash("AttributeError", `'${typeName(value)}' object has no attribute 'get'`);
}

function roundHalfEven(value: number): bigint {
  const floor = Math.floor(value);
  const diff = value - floor;
  const rounded = diff > 0.5 || (diff === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
  return BigInt(rounded);
}

export function cleanMetrics(values: Value | undefined): Map<string, Value> {
  const out = new Map<string, Value>();
  if (!(values instanceof Map)) return out;
  for (const [key, value] of values) {
    if (METRIC_FLAGS.includes(key) && typeof value === "boolean") {
      out.set(key, value);
      continue;
    }
    if (!METRIC_DURATIONS.includes(key) && !METRIC_COUNTS.includes(key)) continue;
    let whole: bigint;
    if (typeof value === "bigint") whole = value;
    else if (value instanceof Float && Number.isFinite(value.value)) whole = roundHalfEven(value.value);
    else continue;
    const ceiling = BigInt(METRIC_DURATIONS.includes(key) ? METRIC_MAX_MS : METRIC_MAX_COUNT);
    out.set(key, whole < 0n ? 0n : whole > ceiling ? ceiling : whole);
  }
  return out;
}

export function outputChars(answer: JsonObject): bigint {
  let total = 0;
  for (const key of ["out", "err"]) {
    const value = answer.get(key);
    const given = truthy(value) ? value : "";
    if (typeof given === "string") total += codePointCount(given);
  }
  return BigInt(total);
}

export function textOf(value: Value | undefined, secretsKnown: boolean): string | PythonCrash {
  if (!truthy(value)) return "";
  if (typeof value === "string") return value;
  const kind = typeName(value);
  if (secretsKnown) return builtinCrash("AttributeError", `'${kind}' object has no attribute 'replace'`);
  return builtinCrash("TypeError", `expected string or bytes-like object, got '${kind}'`);
}

export function exitOf(value: Value | undefined): bigint | PythonCrash {
  if (!truthy(value)) return 0n;
  if (value === true) return 1n;
  if (typeof value === "bigint") return value;
  if (value instanceof Float) {
    if (Number.isNaN(value.value)) return builtinCrash("ValueError", "cannot convert float NaN to integer");
    if (!Number.isFinite(value.value)) return builtinCrash("OverflowError", "cannot convert float infinity to integer");
    return BigInt(Math.trunc(value.value));
  }
  if (typeof value === "string") {
    const parsed = pythonInt(value);
    if ("value" in parsed) return parsed.value;
    return builtinCrash("ValueError", `invalid literal for int() with base 10: ${reprStr(value)}`);
  }
  return builtinCrash("TypeError", `int() argument must be a string, a bytes-like object or a real number, not '${typeName(value as Value)}'`);
}

export function processStatus(status: bigint): number {
  if (status < LONG_MIN || status > LONG_MAX) return 255;
  return Number(BigInt.asUintN(8, status));
}
