import { pyStr, truthy } from "../../pylib/plain.ts";
import { reprText } from "../../pylib/str.ts";
import { attrs, interactiveRows, line } from "../snapshot/render.ts";
import { type Node, walk } from "../snapshot/tree.ts";
import type { DialogSeen, DownloadSeen } from "./dialogs.ts";
import type { Throttle } from "./throttle.ts";

export const MAX_ADDED = 40;
export const MAX_NAVIGATED = 150;
export const COLLAPSE_RUN = 6;
export const COLLAPSE_LONG_RUN = 12;
export const RUN_LABEL = 40;
export const COLLAPSED_ROLES: Readonly<Record<string, number>> = {
  option: COLLAPSE_RUN, link: COLLAPSE_RUN, menuitem: COLLAPSE_RUN, menuitemradio: COLLAPSE_RUN, menuitemcheckbox: COLLAPSE_RUN, treeitem: COLLAPSE_RUN,
  generic: COLLAPSE_RUN, button: COLLAPSE_LONG_RUN, radio: COLLAPSE_LONG_RUN, checkbox: COLLAPSE_LONG_RUN, switch: COLLAPSE_LONG_RUN, tab: COLLAPSE_LONG_RUN,
};
export const KEPT_STATES = new Set(["selected", "pressed", "expanded=true"]);
export const RUN_HINT = "(a run of the same role is one line; `snapshot -i` lists each, `find role <role> <action> --name <text>` acts on one)";
export const MAX_REMOVED_LINES = 5;
export const MAX_REMOVED_REFS = 30;
export const MAX_WRITES = 20;
export const OPENED_TEXT = 1200;
export const NAVIGATED_TEXT = 3000;
export const NAVIGATED_REPORT = 5400;
export const MIN_NAVIGATED_LIST = 1200;
export const OPENED_LEVEL = 2;
export const CONTAINER_ROLES = new Set(["dialog", "alertdialog", "article", "region"]);
export const MIN_NEW_TEXT = 40;

export type Row = { ref: string; level: number; role: string; name: string; value: string; attrs: string[]; line: string };
export type Write = Record<string, unknown>;
export type View = { target: string; loader: string; url: string; title: string; entries: Row[]; containers: Set<string> };
export type TextBlock = { lines: string[]; more?: unknown; where?: string | null; refs: string[] };
export type Report = {
  rerendered: [Row, Row][];
  document: string;
  url: { from: string; to: string } | null;
  title: { from: string; to: string } | null;
  added: Row[];
  removed: Row[];
  changed: [Row, Row][];
  network: Write[];
  context: Row[];
  back?: string[];
  text?: TextBlock | null;
  notes?: string | null;
  unsettled?: boolean;
  error?: string | null;
  dialogs?: DialogSeen[];
  downloads?: DownloadSeen[];
  throttle?: Throttle | null;
  navigationError?: string | null;
  settleLimit?: number;
};

export function entry(level: number, node: Node): Row {
  return {
    ref: node.ref as string,
    level,
    role: node.role,
    name: node.name,
    value: node.value,
    attrs: attrs(node, false).filter((attr) => !attr.startsWith("ref=")),
    line: line(node, 0, false).slice(2),
  };
}

export function entriesOf(nodes: readonly Node[]): Row[] {
  return interactiveRows(nodes).map(([level, node]) => entry(level, node));
}

export function containerKey(frame: string | null, backend: number): string {
  return JSON.stringify([frame, backend]);
}

export function containersOf(nodes: readonly Node[]): Set<string> {
  const out = new Set<string>();
  for (const node of walk(nodes)) if (CONTAINER_ROLES.has(node.role) && node.backend !== null) out.add(containerKey(node.frame, node.backend));
  return out;
}

export function rowKey(row: Row): string {
  return JSON.stringify([row.role, row.name, row.value, row.attrs]);
}

export function rerendered(added: readonly Row[], removed: readonly Row[]): [Row, Row][] {
  const waiting = new Map<string, Row[]>();
  for (const row of removed) {
    const key = JSON.stringify([row.level, rowKey(row)]);
    const list = waiting.get(key) ?? [];
    list.push(row);
    waiting.set(key, list);
  }
  const pairs: [Row, Row][] = [];
  for (const row of added) {
    const same = waiting.get(JSON.stringify([row.level, rowKey(row)]));
    if (same && same.length) pairs.push([same.shift() as Row, row]);
  }
  return pairs;
}

export function diff(before: View | null, after: View, writes: readonly Write[] | null = null): Report {
  const newDocument = before === null || before.loader !== after.loader;
  const old = new Map<string, Row>();
  if (!newDocument) for (const row of before.entries) old.set(row.ref, row);
  const now = new Map<string, Row>();
  for (const row of after.entries) now.set(row.ref, row);
  const added = after.entries.filter((row) => !old.has(row.ref));
  const removed = newDocument ? [] : before.entries.filter((row) => !now.has(row.ref));
  const changed: [Row, Row][] = [];
  for (const row of after.entries) {
    const was = old.get(row.ref);
    if (was !== undefined && rowKey(was) !== rowKey(row)) changed.push([was, row]);
  }
  return {
    rerendered: rerendered(added, removed),
    document: newDocument ? "new" : "same",
    url: before !== null && before.url !== after.url ? { from: before.url, to: after.url } : null,
    title: before !== null && before.title !== after.title ? { from: before.title, to: after.title } : null,
    added,
    removed,
    changed,
    network: [...(writes ?? [])],
    context: after.entries,
  };
}

export function public_(row: Row): Pick<Row, "ref" | "role" | "name" | "value" | "attrs"> {
  return { ref: row.ref, role: row.role, name: row.name, value: row.value, attrs: row.attrs };
}

export function was(old: Row, now: Row): string {
  if (old.value !== now.value) return old.value ? ` (was ${reprText(old.value)})` : " (was empty)";
  if (old.name !== now.name) return ` (was named ${reprText(old.name)})`;
  if (JSON.stringify(old.attrs) !== JSON.stringify(now.attrs)) return old.attrs.length ? ` (was [${old.attrs.join(", ")}])` : " (was plain)";
  return "";
}

export function networkLine(write: Write): string {
  const list = write.statuses;
  const statuses = truthy(list) && Array.isArray(list) ? list.map(pyStr).join(" → ") : "";
  const failed = write.failed;
  const outcome = truthy(failed) ? pyStr(failed) : statuses || "pending";
  return `${pyStr(write.method)} ${pyStr(write.url)} → ${outcome}`;
}

export function plural(role: string, count: number): string {
  if (count === 1) return role;
  return role + (role.endsWith("x") || role.endsWith("s") || role.endsWith("ch") ? "es" : "s");
}

export function keptWhole(row: Row): boolean {
  return row.attrs.some((attr) => KEPT_STATES.has(attr) || attr.startsWith("checked=true") || attr === "checked=mixed");
}

export type Part = { kind: "row"; row: Row } | { kind: "run"; rows: Row[]; items: Row[]; parent: Row | undefined };

export function itemRuns(rows: readonly Row[], parents: ReadonlyMap<string, Row> = new Map()): Part[] {
  const out: Part[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index] as Row;
    const items: Row[] = [row];
    let end = index + 1;
    while (end < rows.length) {
      const other = rows[end] as Row;
      if (other.level > row.level) {
        end += 1;
        continue;
      }
      if (other.level === row.level && other.role === row.role) {
        items.push(other);
        end += 1;
        continue;
      }
      break;
    }
    const run = Object.hasOwn(COLLAPSED_ROLES, row.role) ? (COLLAPSED_ROLES[row.role] as number) : items.length + 1;
    if (items.length >= run) {
      out.push({ kind: "run", rows: rows.slice(index, end), items, parent: parents.get(row.ref) });
      index = end;
    } else {
      out.push({ kind: "row", row });
      index += 1;
    }
  }
  return out;
}

export function parentsOf(rows: readonly Row[]): Map<string, Row> {
  const stack: Row[] = [];
  const out = new Map<string, Row>();
  for (const row of rows) {
    while (stack.length && (stack.at(-1) as Row).level >= row.level) stack.pop();
    if (stack.length) out.set(row.ref, stack.at(-1) as Row);
    stack.push(row);
  }
  return out;
}

export function moved(report: Report): boolean {
  return report.document === "new" || truthy(report.url) || truthy(report.title);
}

export function freshRows(report: Report): Row[] {
  const back = new Set(report.back ?? []);
  const redrawn = new Set((report.rerendered ?? []).map(([, now]) => now.ref));
  return report.added.filter((row) => !back.has(row.ref) && !redrawn.has(row.ref));
}

export function plainRow(row: Row): boolean {
  return !row.value && row.attrs.every((attr) => attr.startsWith("level="));
}
