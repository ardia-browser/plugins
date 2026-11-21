import { checkManifest } from "./app-manifest/pluginManifest.ts";
import { Float, type JsonObject, type Value } from "./json.ts";
import { isDict, isList } from "./pyvalue.ts";

export function plain(value: Value): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Float) return value.value;
  if (Array.isArray(value)) return value.map(plain);
  const out: Record<string, unknown> = {};
  for (const [key, item] of value) Object.defineProperty(out, key, { value: plain(item), enumerable: true, writable: true, configurable: true });
  return out;
}

function strings(value: Value | undefined): string[] {
  return isList(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function v2Problems(doc: JsonObject, rules: JsonObject): string[] {
  const read = checkManifest(plain(doc) as Record<string, unknown>, 2);
  if (read.manifest === null) return read.problems;
  const manifest = read.manifest;
  const problems: string[] = [];
  for (const key of strings(rules.get("approvedSettings"))) {
    if (Object.hasOwn(manifest.settings.defaults, key)) problems.push(`contributes.settings.defaults: ${key} needs its own approval in Settings, so a plugin can't set it`);
  }
  const untabbed = strings(rules.get("untabbedEvents"));
  const decides = strings(rules.get("decideEvents"));
  manifest.hooks.forEach((name, index) => {
    if ((decides.includes(name) || !untabbed.includes(name)) && !manifest.permissions.tabs) problems.push(`contributes.hooks[${index}]: ${name} needs the tabs permission`);
  });
  return problems;
}

export function v2Defaults(doc: JsonObject): Value | undefined {
  const contributes = doc.get("contributes");
  const settings = isDict(contributes) ? contributes.get("settings") : undefined;
  return isDict(settings) ? settings.get("defaults") : undefined;
}
