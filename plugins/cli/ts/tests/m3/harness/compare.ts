import { isRecord, pyEqual, sortedJson } from "./pyvalues.ts";

const LIMIT = 40;
const DIFF_CELLS = 4_000_000;
const DIFF_LINES = 30;

export const STRICT = ["answers", "requests", "sources", "files"];
export const LIVE = ["answers", "request_sets", "sources", "files"];

export function short(value: unknown, width = 400): string {
  const text = typeof value === "string" ? value : (sortedJson(value) ?? "undefined");
  return text.length <= width ? text : `${text.slice(0, width)}… (${text.length} chars)`;
}

function lineDiff(a: string[], b: string[]): string[] {
  if (a.length * b.length > DIFF_CELLS) {
    let first = 0;
    while (first < a.length && first < b.length && a[first] === b[first]) first += 1;
    return ["--- A", "+++ B", `@@ first difference at line ${first + 1} @@`, `-${a[first] ?? ""}`, `+${b[first] ?? ""}`];
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j] ? (table[(i + 1) * cols + j + 1] as number) + 1 : Math.max(table[(i + 1) * cols + j] as number, table[i * cols + j + 1] as number);
    }
  }
  const ops: [string, string][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push([" ", a[i] as string]);
      i += 1;
      j += 1;
    } else if (j < b.length && (i >= a.length || (table[i * cols + j + 1] as number) >= (table[(i + 1) * cols + j] as number))) {
      ops.push(["+", b[j] as string]);
      j += 1;
    } else {
      ops.push(["-", a[i] as string]);
      i += 1;
    }
  }
  const out = ["--- A", "+++ B"];
  const changed = ops.map((op, index) => (op[0] !== " " ? index : -1)).filter((index) => index >= 0);
  let start = 0;
  while (start < changed.length) {
    let end = start;
    while (end + 1 < changed.length && (changed[end + 1] as number) - (changed[end] as number) <= 3) end += 1;
    const from = Math.max(0, (changed[start] as number) - 1);
    const to = Math.min(ops.length, (changed[end] as number) + 2);
    out.push("@@ @@");
    for (const [mark, text] of ops.slice(from, to)) out.push(`${mark}${text}`);
    start = end + 1;
  }
  return out;
}

export function diff(a: unknown, b: unknown, path = "", out: string[] = []): string[] {
  if (out.length >= LIMIT) return out;
  if (isRecord(a) && isRecord(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (!Object.hasOwn(a, key)) out.push(`${path}/${key}: only in B: ${short(b[key])}`);
      else if (!Object.hasOwn(b, key)) out.push(`${path}/${key}: only in A: ${short(a[key])}`);
      else diff(a[key], b[key], `${path}/${key}`, out);
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      if (index >= a.length) out.push(`${path}[${index}]: only in B: ${short(b[index])}`);
      else if (index >= b.length) out.push(`${path}[${index}]: only in A: ${short(a[index])}`);
      else diff(a[index], b[index], `${path}[${index}]`, out);
    }
    return out;
  }
  if (!pyEqual(a, b)) {
    if (typeof a === "string" && typeof b === "string" && (a + b).includes("\n")) {
      out.push(`${path}:\n    ${lineDiff(a.split(/\r\n|\r|\n/), b.split(/\r\n|\r|\n/)).slice(0, DIFF_LINES).join("\n    ")}`);
    } else out.push(`${path}: A ${short(a)} | B ${short(b)}`);
  }
  return out;
}

export function compared(a: Record<string, unknown>, b: Record<string, unknown>, parts: string[] = STRICT): string[] {
  const found: string[] = [];
  for (const part of parts) diff(a[part] ?? null, b[part] ?? null, part, found);
  return found;
}
