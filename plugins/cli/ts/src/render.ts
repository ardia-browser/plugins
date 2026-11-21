import { dumps, type JsonObject, type Value } from "./json.ts";
import { type Kind, type Listing, type Rendered, rendered } from "./listing.ts";
import { shown } from "./printable.ts";
import { charCount, dict, getOrNull, iterateOrEmpty, left, length, PythonError, rstrip, strOf, truthy, Unsupported } from "./py.ts";
import { groups, tabs } from "./render-tabs.ts";

export function pretty(value: Value): string {
  return dumps(value, "indented", false, true);
}

export function shownOf(value: Value | undefined): string {
  return value === undefined || value === null ? "" : shown(strOf(value));
}

function firstTruthy(...values: (Value | undefined)[]): Value | undefined {
  return values.find((value) => truthy(value));
}

export function render(kind: Kind, listing: Listing, result: Value): Rendered {
  try {
    if (kind === "windows") return windows(listing, result);
    if (kind === "commands") return commands(listing, result);
    if (kind === "tabs") return tabs(listing, result);
    return groups(listing, result);
  } catch (error) {
    if (!(error instanceof PythonError)) throw error;
    return { lines: error.printed, complaint: undefined, status: 1, errorCode: undefined, crash: error };
  }
}

function windows(listing: Listing, result: Value): Rendered {
  if (listing.json) return rendered([pretty(result)]);
  const out: string[] = [];
  try {
    windowLines(result, out);
  } catch (error) {
    if (error instanceof PythonError) error.printed = [...out];
    throw error;
  }
  return rendered(out);
}

function windowLines(result: Value, out: string[]): void {
  for (const window of iterateOrEmpty(result)) {
    if (!(window instanceof Map)) continue;
    const flags = [strOf(window.has("kind") ? window.get("kind") : "normal")];
    if (truthy(window.get("focused"))) flags.push("focused");
    const profileValue = firstTruthy(window.get("profileName"), window.get("profile"));
    const profile = profileValue === undefined ? "" : strOf(profileValue);
    const id = strOf(window.get("id") ?? null);
    out.push(shown(rstrip(`window ${id}  ${flags.join(", ")}  ${profile}`)));
    for (const tabValue of iterateOrEmpty(window.get("tabs") ?? null)) {
      const tab = dict(tabValue);
      const marks = `${truthy(tab.get("active")) ? "*" : " "}${truthy(tab.get("pinned")) ? "p" : " "}`;
      const groupValue = tab.get("group");
      const group = groupValue !== undefined && groupValue !== null ? `  (group ${strOf(groupValue)})` : "";
      const titleValue = tab.get("title");
      const title = truthy(titleValue) ? strOf(titleValue) : "";
      const url = strOf(tab.has("url") ? tab.get("url") : "");
      out.push(shown(`  ${marks} ${strOf(tab.get("id") ?? null)}  ${title}  ${url}${group}`));
    }
  }
}

function commands(listing: Listing, result: Value): Rendered {
  if (listing.json) return rendered([pretty(result)]);
  const rows = iterateOrEmpty(result).filter((row): row is JsonObject => row instanceof Map);
  const ids = rows.map((row) => strOf(row.has("id") ? row.get("id") : ""));
  const width = Math.min(40, Math.max(0, ...ids.map(charCount)));
  const out: string[] = [];
  rows.forEach((row, index) => {
    const variants = row.get("variants");
    const tail = truthy(variants) ? `  [${iterateOrEmpty(variants).map(strOf).join(", ")}]` : "";
    const title = strOf(row.has("title") ? row.get("title") : "");
    out.push(shown(`${left(ids[index] ?? "", width)}  ${title}${tail}`));
  });
  return rendered(out);
}

const PYTHON_GENERATOR_DEPTH = 989;

export function walk(items: Value, depth: number, into: [JsonObject, number][]): void {
  const pending: [Value[], number, number][] = [[iterateOrEmpty(items), 0, depth]];
  for (let frame = pending.at(-1); frame !== undefined; frame = pending.at(-1)) {
    const [list, next, level] = frame;
    if (next === list.length) {
      pending.pop();
      continue;
    }
    frame[1] = next + 1;
    const item = list[next];
    if (!(item instanceof Map)) continue;
    into.push([item, level]);
    const type = item.get("type");
    if (type !== "group" && type !== "folder") continue;
    if (level + 1 >= PYTHON_GENERATOR_DEPTH) throw new PythonError("RecursionError", "maximum recursion depth exceeded");
    pending.push([iterateOrEmpty(item.get("items") ?? null), 0, level + 1]);
  }
}

export const SECTIONS: [string, string][] = [
  ["Top Apps", "topApps"],
  ["Pinned", "pinned"],
  ["Tabs", "tabs"],
];

function spaces(tree: Value): [JsonObject, JsonObject][] {
  const out: [JsonObject, JsonObject][] = [];
  for (const windowValue of iterateOrEmpty(getOrNull(tree, "windows"))) {
    const window = dict(windowValue);
    for (const space of iterateOrEmpty(getOrNull(window, "spaces"))) out.push([window, dict(space)]);
  }
  return out;
}

function merged(item: JsonObject, extra: [string, Value][], skip?: string): JsonObject {
  const map: JsonObject = new Map();
  for (const [key, value] of item) if (key !== skip) map.set(key, value);
  for (const [key, value] of extra) map.set(key, value);
  return map;
}

export function flatTabs(tree: Value): JsonObject[] {
  const out: JsonObject[] = [];
  for (const [window, space] of spaces(tree)) {
    for (const [section, key] of SECTIONS) {
      const walked: [JsonObject, number][] = [];
      walk(getOrNull(space, key), 0, walked);
      for (const [item] of walked) {
        if (item.get("type") !== "tab") continue;
        out.push(merged(item, [["window", getOrNull(window, "id")], ["profile", getOrNull(space, "profile")], ["section", section]]));
      }
    }
  }
  return out;
}

export function flatGroups(tree: Value): JsonObject[] {
  const out: JsonObject[] = [];
  for (const [window, space] of spaces(tree)) {
    for (const [, key] of SECTIONS) {
      const walked: [JsonObject, number][] = [];
      walk(getOrNull(space, key), 0, walked);
      walked.forEach(([item, depth], index) => {
        if (item.get("type") !== "group") return;
        const tabIds: Value[] = [];
        for (let inner = index + 1; inner < walked.length; inner += 1) {
          const [tab, level] = walked[inner] as [JsonObject, number];
          if (level <= depth) break;
          if (tab.get("type") === "tab") tabIds.push(tab.get("id") ?? null);
        }
        out.push(
          merged(
            item,
            [["window", getOrNull(window, "id")], ["profile", getOrNull(space, "profile")], ["depth", BigInt(depth)], ["tabs", tabIds]],
            "items",
          ),
        );
      });
    }
  }
  return out;
}

export function tabLine(tab: Value, prefix: string): string {
  const fields = dict(tab);
  const marks: string[] = [];
  if (truthy(fields.get("muted"))) marks.push("muted");
  if (truthy(fields.get("asleep"))) marks.push("asleep");
  const pin = fields.get("pin");
  if (truthy(pin)) marks.push(`pinned ${strOf(pin)}`);
  const title = shownOf(fields.get("title") ?? null);
  const tail = marks.length === 0 ? "" : `  (${shown(marks.join(", "))})`;
  const active = truthy(fields.get("active")) ? "*" : " ";
  const id = shownOf(fields.get("id") ?? null);
  const url = shownOf(fields.get("url") ?? null);
  return rstrip(`${active} ${prefix}${id}  ${title}  ${url}${tail}`);
}

export function groupLine(group: Value, indent: string): string {
  const fields = dict(group);
  const looks: string[] = [];
  for (const key of ["icon", "color"]) {
    const value = fields.get(key);
    if (truthy(value) && value !== "neutral") looks.push(shownOf(value));
  }
  if (truthy(fields.get("collapsed"))) looks.push("collapsed");
  if (truthy(fields.get("pinned"))) looks.push("pinned");
  const labelValue = fields.get("label");
  const label = truthy(labelValue) && labelValue !== undefined ? labelValue : "";
  const parts = [`group ${shownOf(fields.get("id") ?? null)}`, shown(dumps(label, "spaced"))];
  if (looks.length > 0) parts.push(looks.join(" "));
  if (fields.has("window")) {
    parts.push(`window ${shownOf(getOrNull(group, "window"))}`);
    if (!fields.has("profile")) throw new Unsupported();
    parts.push(`profile ${shownOf(fields.get("profile"))}`);
    const parent = fields.get("parent");
    if (truthy(parent)) parts.push(`in ${shownOf(parent)}`);
  }
  if (fields.has("tabs")) parts.push(`${length(fields.get("tabs"))} tabs`);
  return indent + parts.join("  ");
}
