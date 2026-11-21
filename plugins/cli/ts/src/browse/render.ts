import { dumps, type JsonObject, type Value } from "../json.ts";
import { inert, jsonSafe } from "../printable.ts";
import type { BrowseError } from "./errors.ts";
import type { Secrets } from "../redact.ts";

function sanitize(value: Value, secrets: Secrets): Value {
  if (typeof value === "string") return secrets.redact(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, secrets));
  if (value instanceof Map) {
    const out: JsonObject = new Map();
    for (const [key, item] of value) out.set(secrets.redact(key), sanitize(item, secrets));
    return out;
  }
  return value;
}

export function renderError(error: BrowseError, asJson: boolean, secrets: Secrets): { out: string; err: string } {
  if (asJson) {
    const payload: JsonObject = new Map<string, Value>([
      ["success", false],
      ["data", null],
      ["error", error.text],
    ]);
    payload.set("code", error.code || error.fallback);
    const rendered = `${jsonSafe(dumps(sanitize(payload, secrets), "compact"))}\n`;
    return { out: secrets.redact(secrets.redact(rendered)), err: "" };
  }
  return { out: "", err: secrets.redact(secrets.redact(`✗ ${inert(error.text)}\n`)) };
}
