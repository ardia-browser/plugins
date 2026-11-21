import { now, parseIso } from "./clock.ts";
import { dumps, Float, type JsonObject, object, type Value } from "./json.ts";
import { plain } from "./pystr.ts";
import { systemInfo } from "./system-info.ts";
import { BROWSE_ALIASES, BROWSE_KNOWN } from "./telemetry-tables.ts";
import { cliVersion } from "./version.ts";

const EVENTS_SCOPE = "ardia.analytics";
const SERVICE_NAME = "ardia-cli";
const LIB = "ardia-cli";
const SAFE_INT = 2n ** 53n - 1n;
const KNOWN = new Set(BROWSE_KNOWN);
const LONE_SURROGATE = /\p{Cs}/u;

function context(): [string, Value][] {
  const info = systemInfo();
  return [
    ["$lib", LIB],
    ["$lib_version", "1"],
    ["$os", info.os],
    ["$os_version", info.osVersion],
    ["arch", info.arch],
    ["$process_person_profile", false],
    ["$geoip_disable", true],
  ];
}

export function resource(environment: string): JsonObject {
  const info = systemInfo();
  return object([
    ["service.name", SERVICE_NAME],
    ["service.version", cliVersion()],
    ["deployment.environment", environment === "production" ? "production" : "development"],
    ["os.type", info.osType],
    ["os.version", info.osVersion],
    ["host.arch", info.arch],
  ]);
}

function browseName(subcommand: Value | undefined): string {
  if (Array.isArray(subcommand) || subcommand instanceof Map) throw new TypeError("unhashable subcommand");
  const name = typeof subcommand === "string" && Object.hasOwn(BROWSE_ALIASES, subcommand) ? BROWSE_ALIASES[subcommand] : subcommand;
  return typeof name === "string" && KNOWN.has(name) ? name : "other";
}

export function mappedProperties(record: JsonObject): JsonObject {
  const properties = new Map(record.get("properties") as JsonObject);
  if (record.get("event") === "cli_command" && properties.get("command") === "browse") {
    properties.set("subcommand", browseName(properties.get("subcommand")));
  }
  return properties;
}

export function otlpValue(value: Value | undefined): JsonObject | undefined {
  if (typeof value === "boolean") return object([["boolValue", value]]);
  if (typeof value === "bigint") {
    const magnitude = value < 0n ? -value : value;
    if (magnitude <= SAFE_INT) return object([["intValue", value.toString()]]);
    const wide = Number(value);
    if (!Number.isFinite(wide)) throw new RangeError("int too large to convert to float");
    return object([["doubleValue", new Float(wide)]]);
  }
  if (value instanceof Float) {
    const number = value.value;
    if (!Number.isFinite(number)) return undefined;
    if (Number.isInteger(number) && Math.abs(number) <= Number(SAFE_INT)) return object([["intValue", BigInt(number).toString()]]);
    return object([["doubleValue", value]]);
  }
  if (typeof value === "string") return object([["stringValue", value]]);
  if (Array.isArray(value) || value instanceof Map) return object([["stringValue", dumps(value, "compact")]]);
  return undefined;
}

export function otlpAttributes(values: JsonObject): Value[] {
  const out: Value[] = [];
  for (const [key, raw] of values) {
    const value = otlpValue(raw);
    if (value !== undefined) out.push(object([["key", key], ["value", value]]));
  }
  return out;
}

function milliseconds(timestamp: string): number {
  const parsed = parseIso(timestamp);
  return Math.trunc((typeof parsed === "object" ? parsed.at : now()) * 1000);
}

function merged(base: [string, Value][], over: JsonObject): JsonObject {
  const out: JsonObject = new Map(base);
  for (const [key, value] of over) out.set(key, value);
  return out;
}

export function eventRecord(record: JsonObject): JsonObject {
  const ms = milliseconds(record.get("timestamp") as string);
  const properties = merged(context(), mappedProperties(record));
  const head: [string, Value][] = [
    ["event", record.get("event") as Value],
    ["uuid", record.get("uuid") as Value],
    ["distinct_id", record.get("distinct_id") as Value],
  ];
  return object([
    ["timeUnixNano", `${ms}000000`],
    ["severityNumber", 9n],
    ["severityText", "INFO"],
    ["body", object([["stringValue", record.get("event") as Value]])],
    ["attributes", otlpAttributes(merged(head, properties))],
  ]);
}

export function logsRequest(environment: string, records: JsonObject[]): Buffer {
  const body = object([
    [
      "resourceLogs",
      [
        object([
          ["resource", object([["attributes", otlpAttributes(resource(environment))]])],
          ["scopeLogs", [object([["scope", object([["name", EVENTS_SCOPE]])], ["logRecords", records.map(eventRecord)]])]],
        ]),
      ],
    ],
  ]);
  const text = plain(dumps(body, "compact"));
  if (LONE_SURROGATE.test(text)) throw new RangeError("surrogates not allowed");
  return Buffer.from(text, "utf8");
}
