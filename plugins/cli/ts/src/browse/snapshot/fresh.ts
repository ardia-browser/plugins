import { joinedWords } from "../../pylib/str.ts";
import type { Page } from "../state/page.ts";
import type { Line } from "./take.ts";

export const CONTENT_ROLES = new Set([
  "StaticText", "heading", "img", "image", "paragraph", "alert", "status", "cell", "gridcell", "listitem", "row", "dialog", "alertdialog", "note", "log",
  "marquee", "timer", "figure", "blockquote", "code", "term", "definition", "math", "progressbar", "meter",
]);

export type Seen = { loader: string; refs: Set<string>; keys: Map<string, number>; command: number };
const seenBy = new WeakMap<object, Map<string, Seen>>();

function seenOf(state: object): Map<string, Seen> {
  let seen = seenBy.get(state);
  if (seen === undefined) {
    seen = new Map();
    seenBy.set(state, seen);
  }
  return seen;
}

export function keyOf(line: Line): string {
  const node = line.node;
  if (node === null) return line.text.trimStart();
  return JSON.stringify([node.role, joinedWords(node.name), joinedWords(node.value)]);
}

function counted(lines: readonly Line[]): Map<string, number> {
  const keys = new Map<string, number>();
  for (const line of lines) keys.set(keyOf(line), (keys.get(keyOf(line)) ?? 0) + 1);
  return keys;
}

export function wanted(line: Line): boolean {
  if (line.ref) return true;
  const node = line.node;
  if (node === null) return true;
  return CONTENT_ROLES.has(node.role) && Boolean(joinedWords(node.name) || joinedWords(node.value) || node.role === "img");
}

export function newIndexes(before: Seen, lines: readonly Line[]): number[] {
  const left = new Map(before.keys);
  const out: number[] = [];
  lines.forEach((line, index) => {
    const key = keyOf(line);
    const had = left.get(key) ?? 0;
    if (had > 0) left.set(key, had - 1);
    const fresh = line.ref ? !before.refs.has(line.ref) : had === 0;
    if (fresh && wanted(line)) out.push(index);
  });
  return out;
}

export function lastSeen(state: object, page: Page): Seen | null {
  return seenOf(state).get(page.targetId) ?? null;
}

export function rememberSeen(state: object, page: Page, lines: readonly Line[], command: number, content: readonly Line[] = lines): void {
  const refs = new Set(lines.flatMap((line) => (line.ref ? [line.ref] : [])));
  seenOf(state).set(page.targetId, { loader: page.loader(page.mainFrame) || "", refs, keys: counted(content), command });
}
