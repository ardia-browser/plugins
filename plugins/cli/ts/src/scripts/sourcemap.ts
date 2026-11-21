import { abspath, normpath } from "../paths.ts";
import { PyException, reprText } from "../pylib/str.ts";

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export type RawSourceMap = { sources?: unknown; mappings?: unknown };
type Segment = [number, number, number, number];

export function vlq(segment: string): number[] {
  const values: number[] = [];
  let shift = 0;
  let value = 0;
  for (const char of segment) {
    const digit = BASE64.indexOf(char);
    if (digit < 0) throw new PyException("KeyError", reprText(char));
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    const half = Math.floor(value / 2);
    values.push(value % 2 ? -half : half);
    shift = 0;
    value = 0;
  }
  return values;
}

export class SourceMap {
  readonly sources: string[];
  readonly lines: Segment[][] = [];

  constructor(
    data: RawSourceMap | null,
    readonly offset: number,
  ) {
    this.sources = data && Array.isArray(data.sources) ? data.sources.map(String) : [];
    if (!data) return;
    let source = 0;
    let line = 0;
    let column = 0;
    const mappings = typeof data.mappings === "string" ? data.mappings : "";
    for (const text of mappings.split(";")) {
      const row: Segment[] = [];
      let generated = 0;
      for (const segment of text.split(",")) {
        if (!segment) continue;
        const values = vlq(segment);
        if (values.length === 0) throw new PyException("IndexError", "list index out of range");
        generated += values[0] as number;
        if (values.length >= 4) {
          source += values[1] as number;
          line += values[2] as number;
          column += values[3] as number;
          row.push([generated, source, line, column]);
        }
      }
      this.lines.push(row);
    }
  }

  lookup(line: number, column: number): [string, number, number] | null {
    const row = this.lines[line - this.offset];
    if (line - this.offset < 0 || row === undefined || row.length === 0) return null;
    let best = row[0] as Segment;
    for (const entry of row) {
      if (entry[0] > column) break;
      best = entry;
    }
    if (best[1] < 0 || best[1] >= this.sources.length) return null;
    return [this.sources[best[1]] as string, best[2] + 1, best[3] + 1];
  }
}

export function relpath(path: string, start = "."): string {
  const target = abspath(path).split("/").filter(Boolean);
  const from = abspath(start).split("/").filter(Boolean);
  let shared = 0;
  while (shared < target.length && shared < from.length && target[shared] === from[shared]) shared += 1;
  const parts = [...Array<string>(from.length - shared).fill(".."), ...target.slice(shared)];
  return parts.length === 0 ? "." : parts.join("/");
}

export function displayPath(base: string, name: string): string {
  const full = normpath(name.startsWith("/") ? name : `${base}/${name}`);
  const relative = relpath(full);
  return relative.startsWith("../../") ? full : relative;
}
