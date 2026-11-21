import { Float, floatRepr, type JsonObject, type Value } from "../json.ts";
import { reprText } from "../pylib/str.ts";
import { getOr } from "./pyvalue.ts";
import { StoreError } from "./store-fs.ts";
import { truthy } from "./store-repair.ts";

export function pyRepr(value: Value): string {
  if (typeof value === "string") return reprText(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (value instanceof Map) return `{${[...value].map(([key, item]) => `${reprText(key)}: ${pyRepr(item)}`).join(", ")}}`;
  return pyStr(value);
}

export function pyStr(value: Value | undefined): string {
  if (value === undefined || value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Float) return floatRepr(value.value);
  if (typeof value === "string") return value;
  return pyRepr(value);
}

function strings(record: JsonObject, key: string): string[] {
  const value = getOr(record, key, []);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new StoreError(`${pyStr(record.get("id"))}'s meta.json has a field of the wrong type; reinstall it`);
  }
  return value as string[];
}

export function describe(record: JsonObject): string {
  const version = truthy(record.get("version")) ? ` ${pyStr(record.get("version"))}` : "";
  const where = [...strings(record, "matches"), ...strings(record, "includes")].join(", ") || "nowhere";
  const world = getOr(record, "world", "MAIN");
  if (typeof world !== "string") throw new StoreError(`${pyStr(record.get("id"))}'s meta.json has a field of the wrong type; reinstall it`);
  return `${pyStr(record.get("name"))}${version} (${pyStr(record.get("id"))}): ${where} [${pyStr(record.get("run_at"))}, ${world.toLowerCase()} world]`;
}

export function profileLines(status: JsonObject | null, removed = false): [string[], boolean] {
  const profiles = status instanceof Map ? status.get("profiles") : undefined;
  if (!(profiles instanceof Map) || profiles.size === 0) return [["Ardia reported no profiles"], false];
  const lines: string[] = [];
  let failed = false;
  for (const [name, result] of profiles) {
    if (!(result instanceof Map)) lines.push(`${name}: unknown result`);
    else if (truthy(result.get("error"))) {
      failed = true;
      lines.push(`${name}: error ${pyStr(result.get("error"))}`);
    } else if (truthy(result.get("disabled"))) lines.push(`${name}: turned off in Extensions, so the scripts don't run there`);
    else if (truthy(result.get("removed"))) lines.push(`${name}: removed`);
    else if (truthy(result.get("ok"))) lines.push(`${name}: ${removed ? "removed" : "loaded"}`);
    else lines.push(`${name}: unknown result`);
  }
  return [lines, failed];
}
