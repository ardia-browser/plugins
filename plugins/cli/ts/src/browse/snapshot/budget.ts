import { pyLen } from "../../pylib/str.ts";
import { INTERACTIVE, type Node } from "./tree.ts";

export type Tier = 1 | 2 | 3;
export type BudgetRow = { text: string; level: number; tier: Tier; ref: string | null; bare?: boolean };
export type TierCounts = [number, number, number];
export type Fitted = { kept: boolean[]; text: string; trimmed: boolean; shown: TierCounts; total: TierCounts };

export const CONTEXT_ROLES = new Set([
  "heading", "banner", "navigation", "main", "complementary", "contentinfo", "region", "form", "search", "dialog", "alertdialog", "LabelText", "label",
  "legend", "caption", "Legend", "Caption", "columnheader", "rowheader", "tablist", "menu", "menubar", "toolbar", "table", "grid", "treegrid", "list",
  "listbox", "tree", "radiogroup", "figure", "article", "alert", "status", "group", "tabpanel", "feed",
]);

export function tierOf(node: Node | null | undefined, ref: string | null): Tier {
  if (node === null || node === undefined) return ref ? 1 : 2;
  if (node.ref && (INTERACTIVE.has(node.role) || (node.hints && node.hints.length > 0))) return 1;
  if (CONTEXT_ROLES.has(node.role)) return 2;
  return 3;
}

export function parentsOf(rows: readonly { level: number }[]): number[] {
  const parents: number[] = [];
  const stack: number[] = [];
  rows.forEach((row, index) => {
    while (stack.length > 0 && (rows[stack.at(-1) as number] as { level: number }).level >= row.level) stack.pop();
    parents.push(stack.length > 0 ? (stack.at(-1) as number) : -1);
    stack.push(index);
  });
  return parents;
}

function totals(rows: readonly BudgetRow[], kept?: readonly boolean[]): TierCounts {
  const out: TierCounts = [0, 0, 0];
  rows.forEach((row, index) => {
    if (kept === undefined || kept[index]) out[row.tier - 1] = (out[row.tier - 1] as number) + 1;
  });
  return out;
}

export function fit(rows: readonly BudgetRow[], limit: number | null): Fitted {
  const all = rows.map((row) => row.text).join("\n");
  const total = totals(rows);
  if (limit === null || pyLen(all) <= limit) return { kept: rows.map(() => true), text: all, trimmed: false, shown: total, total };
  const parents = parentsOf(rows);
  const cost = rows.map((row) => pyLen(row.text) + 1);
  const kept = rows.map(() => false);
  let used = 0;
  const room = limit + 1;
  for (const tier of [1, 2, 3] as const) {
    rows.forEach((row, index) => {
      if (row.tier !== tier || kept[index] || row.bare) return;
      const chain: number[] = [];
      for (let at = index; at >= 0 && !kept[at]; at = parents[at] as number) chain.push(at);
      const need = chain.reduce((sum, at) => sum + (cost[at] as number), 0);
      if (used + need > room) return;
      used += need;
      for (const at of chain) kept[at] = true;
    });
  }
  const text = rows.filter((_, index) => kept[index]).map((row) => row.text).join("\n");
  return { kept, text, trimmed: true, shown: totals(rows, kept), total };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function trimNotice(limit: number, shown: TierCounts, total: TierCounts): string {
  const parts = [`${shown[0]}/${plural(total[0], "control", "controls")}`, `${shown[1]}/${total[1]} headings and labels`, `${shown[2]}/${plural(total[2], "text line", "text lines")}`];
  return `[fit to ${limit} chars, controls first: ${parts.join(", ")}; -s <sel>, -i or --full for the rest]`;
}

export function isBare(node: Node | null | undefined, ref: string | null): boolean {
  return node !== null && node !== undefined && !ref && !node.name && !node.value && !(node.hints && node.hints.length) && node.children.length > 0;
}

export function shortNotice(limit: number): string {
  return `[fit to ${limit} chars; --full for all]`;
}

export function noticeRoom(limit: number, total: TierCounts): number {
  return pyLen(trimNotice(limit, total, total)) + 1;
}

export function fitWithNotice(rows: readonly BudgetRow[], limit: number, reserved = 0): Fitted & { notice: string | null } {
  if (limit <= 0) return { ...fit(rows, null), notice: null };
  const room = limit - reserved;
  const whole = fit(rows, Math.max(room, 0));
  if (!whole.trimmed) return { ...whole, notice: null };
  const full = noticeRoom(limit, whole.total);
  if (full <= room) {
    const fitted = fit(rows, room - full);
    return { ...fitted, notice: trimNotice(limit, fitted.shown, fitted.total) };
  }
  const short = shortNotice(limit);
  const fitted = fit(rows, Math.max(room - pyLen(short) - 1, 0));
  return { ...fitted, notice: pyLen(short) + 1 <= room ? short : null };
}

export function droppedRefs(rows: readonly BudgetRow[], kept: readonly boolean[]): Set<string> {
  const dropped = new Set<string>();
  rows.forEach((row, index) => {
    if (!kept[index] && row.ref) dropped.add(row.ref);
  });
  return dropped;
}

export function fitHeaders(headers: readonly string[], limit: number | null): string[] {
  if (limit === null) return [...headers];
  const out: string[] = [];
  let used = 0;
  for (const header of headers) {
    const cost = pyLen(header) + 1;
    if (used + cost > limit) continue;
    out.push(header);
    used += cost;
  }
  return out;
}

export function roomAfter(headers: readonly string[], limit: number, reserve = 0): number {
  if (limit <= 0) return 0;
  return Math.max(limit - reserve - headers.reduce((sum, header) => sum + pyLen(header) + 1, 0), 0);
}
