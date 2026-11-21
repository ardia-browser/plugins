import { dumps, type Value } from "../../json.ts";
import { pyValue } from "../daemon/render.ts";

function rows(item: Value): boolean {
  return Array.isArray(item) && item.length > 0 && item.every((row) => row instanceof Map || Array.isArray(row));
}

export function renderJson(given: unknown): string {
  const value = pyValue(given);
  if (rows(value)) return (value as Value[]).map((item) => dumps(item, "spaced")).join("\n");
  if (value instanceof Map && [...value.values()].some(rows)) {
    const lines: string[] = [];
    for (const [key, item] of value) {
      if (rows(item)) {
        lines.push(`${key}: ${(item as Value[]).length} rows`);
        for (const row of item as Value[]) lines.push(dumps(row, "spaced"));
      } else lines.push(`${key}: ${dumps(item, "spaced")}`);
    }
    return lines.join("\n");
  }
  return dumps(value, "indented");
}
