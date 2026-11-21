import { type JsonObject, type Value } from "./json.ts";
import { METRIC_COUNTS, METRIC_DURATIONS, METRIC_MAX_COUNT, METRIC_MAX_MS } from "./telemetry-tables.ts";
import { isMetricFlag } from "./command-metrics.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$/;
const COMMAND = /^[a-z][a-z0-9-]{0,31}$/;
const SUBCOMMAND = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,40}$/;
const FLAGS = /^(?:--?[a-z][a-z0-9-]{0,40}(?:,--?[a-z][a-z0-9-]{0,40}){0,19})?$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:(?:-[a-z]{1,16}\.\d{1,4})|(?:\.dev\d{1,4}))?$/;
const WATCH_REPORT = /^FB-[A-Z0-9]{2,16}$/;
const SOURCE = /^[a-z][a-z_]{0,39}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,60}$/;
const ERRNO_VALUE = /^\[Errno \d{1,4}\] [A-Za-z0-9 ,.'()/-]{1,80}$/;
const MODULE = /^[A-Za-z_][A-Za-z0-9_.]{0,120}$/;
const FUNCTION = /^[A-Za-z0-9_<>.]{1,100}$/;
const OTHER = "<other>";
const MAX_EXCEPTIONS = 10;
const MAX_FRAMES = 50;
const ENVIRONMENTS = ["production", "test", "dev"];
const SERVED_BY = ["python", "rust", "ts"];
const LEVELS = ["fatal", "error"];
const FIXED_MESSAGES = new Set([
  "division by zero", "integer division or modulo by zero", "float division by zero", "integer modulo by zero",
  "list index out of range", "tuple index out of range", "string index out of range", "list assignment index out of range",
  "pop from empty list", "pop from an empty set", "pop from an empty deque", "deque index out of range",
  "dictionary changed size during iteration", "Set changed size during iteration", "dictionary keys changed during iteration",
  "deque mutated during iteration", "maximum recursion depth exceeded", "maximum recursion depth exceeded while calling a Python object",
  "maximum recursion depth exceeded in comparison", "Event loop is closed", "This event loop is already running",
  "Cannot run the event loop while another loop is running", "no running event loop", "no current event loop",
  "cannot reuse already awaited coroutine", "coroutine ignored GeneratorExit", "generator already executing",
  "generator raised StopIteration", "coroutine raised StopIteration", "async generator raised StopIteration",
  "I/O operation on closed file.", "I/O operation on closed file", "read of closed file", "write to closed file",
  "can't start new thread", "substring not found", "empty separator", "empty range for randrange()",
  "cannot unpack non-iterable NoneType object", "'NoneType' object is not subscriptable", "'NoneType' object is not iterable",
  "'NoneType' object is not callable", "unhashable type: 'dict'", "unhashable type: 'list'",
]);
const DURATIONS = new Set(METRIC_DURATIONS);
const COUNTS = new Set(METRIC_COUNTS);

type Check = (value: Value) => Value | undefined;

const text = (pattern: RegExp): Check => (value) => (typeof value === "string" && pattern.test(value) ? value : undefined);
const oneOf = (allowed: readonly string[]): Check => (value) => (typeof value === "string" && allowed.includes(value) ? value : undefined);
const orNull = (check: Check): Check => (value) => (value === null ? null : check(value));
const boolean: Check = (value) => (typeof value === "boolean" ? value : undefined);
const exitCode: Check = (value) => (typeof value === "bigint" && value >= -1024n && value <= 1024n ? value : undefined);

function wholeUpTo(ceiling: number): Check {
  return (value) => (typeof value === "bigint" && value >= 0n && value <= BigInt(ceiling) ? value : undefined);
}

function exceptionValue(value: Value): Value | undefined {
  if (typeof value !== "string") return undefined;
  return IDENTIFIER.test(value) || ERRNO_VALUE.test(value) || FIXED_MESSAGES.has(value) ? value : undefined;
}

function listOf(check: Check, limit: number): Check {
  return (value) => {
    if (!Array.isArray(value) || value.length > limit) return undefined;
    const out: Value[] = [];
    for (const item of value) {
      const kept = check(item);
      if (kept === undefined) return undefined;
      out.push(kept);
    }
    return out;
  };
}

function shape(fields: [string, Check][]): Check {
  return (value) => {
    if (!(value instanceof Map)) return undefined;
    const out: JsonObject = new Map();
    for (const [key, check] of fields) {
      if (!value.has(key)) return undefined;
      const kept = check(value.get(key) as Value);
      if (kept === undefined) return undefined;
      out.set(key, kept);
    }
    return out;
  };
}

const label = (value: Value): Value | undefined => (value === OTHER || (typeof value === "string" && MODULE.test(value)) ? value : undefined);
const functionName = (value: Value): Value | undefined => (value === OTHER || (typeof value === "string" && FUNCTION.test(value)) ? value : undefined);
const lineNumber: Check = (value) => (value === null || (typeof value === "bigint" && value >= 0n && value < 10_000_000n) ? value : undefined);

const FRAME = shape([
  ["platform", oneOf(["custom"])],
  ["lang", oneOf(["python"])],
  ["function", functionName],
  ["module", label],
  ["filename", label],
  ["lineno", lineNumber],
  ["colno", (value) => (value === null ? null : undefined)],
  ["resolved", boolean],
  ["in_app", boolean],
]);

const EXCEPTION_ENTRY = shape([
  ["type", text(IDENTIFIER)],
  ["value", exceptionValue],
  ["mechanism", shape([["type", text(SOURCE)], ["handled", boolean], ["synthetic", boolean]])],
  ["stacktrace", shape([["type", oneOf(["raw"])], ["frames", listOf(FRAME, MAX_FRAMES)]])],
]);

const COMMON: [string, Check][] = [
  ["$session_id", text(UUID)],
  ["watch_report", text(WATCH_REPORT)],
  ["error_code", orNull(text(ERROR_CODE))],
  ["cli_version", text(VERSION)],
  ["$environment", oneOf(ENVIRONMENTS)],
];

const SCHEMAS: Record<string, Map<string, Check>> = {
  cli_command: new Map([
    ["command", text(COMMAND)],
    ["subcommand", orNull(text(SUBCOMMAND))],
    ["exit_code", exitCode],
    ["flags", text(FLAGS)],
    ["served_by", oneOf(SERVED_BY)],
    ...COMMON,
  ]),
  $exception: new Map([
    ["$exception_level", oneOf(LEVELS)],
    ["source", text(SOURCE)],
    ["$exception_types", listOf(text(IDENTIFIER), MAX_EXCEPTIONS)],
    ["$exception_values", listOf(exceptionValue, MAX_EXCEPTIONS)],
    ["$exception_list", listOf(EXCEPTION_ENTRY, MAX_EXCEPTIONS)],
    ...COMMON,
  ]),
};

function metricCheck(key: string): Check | undefined {
  if (isMetricFlag(key)) return boolean;
  if (DURATIONS.has(key)) return wholeUpTo(METRIC_MAX_MS);
  if (COUNTS.has(key)) return wholeUpTo(METRIC_MAX_COUNT);
  return undefined;
}

export function cleanEvent(record: JsonObject): JsonObject | undefined {
  const name = record.get("event");
  if (typeof name !== "string" || !Object.hasOwn(SCHEMAS, name)) return undefined;
  const schema = SCHEMAS[name] as Map<string, Check>;
  const uuid = record.get("uuid");
  const timestamp = record.get("timestamp");
  if (typeof uuid !== "string" || !UUID.test(uuid) || typeof timestamp !== "string" || !TIMESTAMP.test(timestamp)) return undefined;
  const properties = record.get("properties") as JsonObject;
  const kept: JsonObject = new Map();
  for (const [key, value] of properties) {
    const check = schema.get(key) ?? (name === "cli_command" ? metricCheck(key) : undefined);
    if (check === undefined) continue;
    const clean = check(value);
    if (clean !== undefined) kept.set(key, clean);
  }
  return new Map<string, Value>([...record].map(([key, value]): [string, Value] => [key, key === "properties" ? kept : value]));
}
