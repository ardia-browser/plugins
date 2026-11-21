import { equalsFalse, equalsTrue, pyStr, truthy } from "../../pylib/plain.ts";
import { headPoints, joinedWords, pyLen, pyRstrip, pyStrip } from "../../pylib/str.ts";
import { flag } from "../metrics.ts";
import type { Node } from "./tree.ts";

export const SHOWN_NAME = 100;
export const DISABLED_RUN: Readonly<Record<string, number>> = { option: 6, link: 6, menuitem: 6, treeitem: 6, button: 12, radio: 12, checkbox: 12, switch: 12, tab: 12 };
export const MIN_DISABLED = 3;
export const NEAR_ROLES: Readonly<Record<string, number>> = { heading: 0, link: 1, cell: 2, gridcell: 2, rowheader: 2, StaticText: 3, img: 4 };
export const NEAR_LEVELS = 4;
export const UNLABELED_ROLES = new Set(["heading"]);
export const NEAR_SCAN = 120;
export const NEAR_CHARS = 60;
const CHECKABLE = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);

export const pyStripped = pyStrip;
export const squashed = joinedWords;
const head = headPoints;

const NO_ATTRS: string[] = [];

export function attrs(node: Node, urls: boolean): string[] {
  const props = node.props;
  if (props.size === 0 && !node.ref && !(urls && node.url)) return NO_ATTRS;
  const out: string[] = [];
  if (truthy(props.get("inputType"))) out.push(`type=${pyStr(props.get("inputType"))}`);
  if (node.role === "heading" && props.get("level") !== undefined && props.get("level") !== null) out.push(`level=${pyStr(props.get("level"))}`);
  if (props.has("checked") && CHECKABLE.has(node.role)) {
    const checked = props.get("checked");
    out.push(`checked=${checked === "mixed" ? "mixed" : equalsTrue(checked) || checked === "true" ? "true" : "false"}`);
  }
  if (props.has("expanded")) out.push(`expanded=${truthy(props.get("expanded")) ? "true" : "false"}`);
  if (truthy(props.get("selected"))) out.push("selected");
  if (props.has("pressed")) {
    const pressed = props.get("pressed");
    if (!(pressed === null || pressed === undefined || equalsFalse(pressed) || pressed === "false")) out.push("pressed");
  }
  if (truthy(props.get("disabled"))) out.push("disabled");
  if (truthy(props.get("required"))) out.push("required");
  if (node.ref) out.push(`ref=${node.ref}`);
  if (urls && node.url) out.push(`url=${node.url}`);
  return out;
}

export function quoted(text: string): string {
  if (text.indexOf("\\") < 0 && text.indexOf('"') < 0 && text.indexOf("\n") < 0) return `"${text}"`;
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}

export function shownName(name: string): string {
  if (name.length <= SHOWN_NAME || pyLen(name) <= SHOWN_NAME) return name;
  flag("names_clipped", true);
  return `${pyRstrip(head(name, SHOWN_NAME - 1))}…`;
}

export function line(node: Node, depth: number, urls: boolean, near?: string | null): string {
  let out = `${"  ".repeat(depth)}- ${node.role}`;
  if (node.name) out += ` ${quoted(node.role === "StaticText" ? node.name : shownName(node.name))}`;
  const shown = attrs(node, urls);
  if (shown.length) out += ` [${shown.join(", ")}]`;
  if (node.value && node.value !== node.name && node.role !== "StaticText" && node.role !== "link" && node.role !== "heading") out += `: ${node.value.replaceAll("\n", " ")}`;
  if (node.hints && node.hints.length) out += ` clickable [${node.hints.join(", ")}]`;
  if (near) out += ` (near ${quoted(near)})`;
  return out;
}

export type Row = readonly [number, Node];

function* nearCandidates(root: Node, skip: Node, budget: { left: number }): Generator<Node> {
  for (const child of root.children) {
    if (budget.left <= 0) return;
    budget.left -= 1;
    if (child === skip) continue;
    if (Object.hasOwn(NEAR_ROLES, child.role)) yield child;
    yield* nearCandidates(child, skip, budget);
  }
}

export function nearbyLabel(node: Node, parents: ReadonlyMap<Node, Node>, repeated: ReadonlySet<string> = new Set()): string | null {
  const own = pyStripped(node.name);
  let current = node;
  for (let level = 0; level < NEAR_LEVELS; level += 1) {
    const parent = parents.get(current);
    if (parent === undefined) return null;
    let best: [number, string] | undefined;
    for (const candidate of nearCandidates(parent, node, { left: NEAR_SCAN })) {
      const text = squashed(candidate.name);
      if (!text || text === own || pyLen(text) < 2 || repeated.has(text)) continue;
      const rank = NEAR_ROLES[candidate.role] as number;
      if (best === undefined || rank < best[0]) best = [rank, text];
      if (rank === 0) break;
    }
    if (best !== undefined) {
      const text = best[1];
      return pyLen(text) <= NEAR_CHARS ? text : `${pyRstrip(head(text, NEAR_CHARS - 1))}…`;
    }
    current = parent;
  }
  return null;
}

export function labelsForRepeats(nodes: readonly Node[], rows: readonly Row[]): Map<Node, string> {
  const seen = new Map<string, number>();
  const keyOf = (node: Node) => JSON.stringify([node.role, pyStripped(node.name)]);
  for (const [, node] of rows) seen.set(keyOf(node), (seen.get(keyOf(node)) ?? 0) + 1);
  const wanted = new Set<Node>();
  for (const [, node] of rows) {
    if (!UNLABELED_ROLES.has(node.role) && (!pyStripped(node.name) || (seen.get(keyOf(node)) as number) > 1)) wanted.add(node);
  }
  if (wanted.size === 0) return new Map();
  const repeated = new Set<string>();
  for (const [key, count] of seen) {
    const name = (JSON.parse(key) as [string, string])[1];
    if (count > 1 && name) repeated.add(squashed(name));
  }
  const parents = new Map<Node, Node>();
  const stack: Node[] = [...nodes];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    for (const child of node.children) {
      parents.set(child, node);
      stack.push(child);
    }
  }
  const labels = new Map<Node, string>();
  const groups = new Map<string, Node[]>();
  for (const [, node] of rows) {
    if (!wanted.has(node)) continue;
    const found = nearbyLabel(node, parents, repeated);
    if (found) {
      labels.set(node, found);
      const members = groups.get(keyOf(node)) ?? [];
      members.push(node);
      groups.set(keyOf(node), members);
    }
  }
  for (const members of groups.values()) {
    const shared = new Map<string, number>();
    for (const member of members) shared.set(labels.get(member) as string, (shared.get(labels.get(member) as string) ?? 0) + 1);
    for (const member of members) if ((shared.get(labels.get(member) as string) as number) > 1) labels.delete(member);
  }
  if (labels.size) flag("snapshot_repeat_labels", true);
  return labels;
}

export function interactiveRows(nodes: readonly Node[]): Row[] {
  const rows: Row[] = [];
  const visit = (node: Node, level: number) => {
    let here = level;
    if (node.ref) {
      rows.push([here, node]);
      here += 1;
    }
    for (const child of node.children) visit(child, here);
  };
  for (const node of nodes) visit(node, 0);
  return rows;
}

function disabled(node: Node): boolean {
  return truthy(node.props.get("disabled"));
}

function spanLabel(node: Node): string {
  const text = squashed(node.name || node.value);
  return pyLen(text) <= 40 ? text : `${head(text, 39)}…`;
}

function runSpan(nodes: readonly Node[]): string {
  return nodes.length > 1 ? `${spanLabel(nodes[0] as Node)} … ${spanLabel(nodes.at(-1) as Node)}` : spanLabel(nodes[0] as Node);
}

export function interactiveLines(rows: readonly Row[], urls: boolean, near: ReadonlyMap<Node, string> = new Map()): string[] {
  const lines: string[] = [];
  let index = 0;
  while (index < rows.length) {
    const [level, node] = rows[index] as Row;
    const members: Node[] = [node];
    let end = index + 1;
    while (end < rows.length && (rows[end] as Row)[0] >= level) {
      if ((rows[end] as Row)[0] === level) {
        if ((rows[end] as Row)[1].role !== node.role) break;
        members.push((rows[end] as Row)[1]);
      }
      end += 1;
    }
    const off = members.filter(disabled);
    const run = Object.hasOwn(DISABLED_RUN, node.role) ? (DISABLED_RUN[node.role] as number) : members.length + 1;
    if (members.length < run || off.length < MIN_DISABLED) {
      lines.push(line(node, level, urls, near.get(node)));
      index += 1;
      continue;
    }
    let noted = false;
    let hiding = false;
    for (let position = index; position < end; position += 1) {
      const [rowLevel, row] = rows[position] as Row;
      if (hiding && rowLevel > level) continue;
      hiding = rowLevel === level && disabled(row);
      if (hiding) {
        flag("snapshot_disabled_folded", true);
        if (!noted) {
          lines.push(`${"  ".repeat(level)}- ${off.length} disabled ${row.role}${off.length > 1 ? "s" : ""} (${runSpan(off)})`);
          noted = true;
        }
        continue;
      }
      lines.push(line(row, rowLevel, urls, near.get(row)));
    }
    index = end;
  }
  return lines;
}

export type RenderOptions = { interactive?: boolean; compact?: boolean; depth?: number | null; urls?: boolean };

export function render(nodes: readonly Node[], options: RenderOptions = {}): string {
  const { interactive = false, compact = false, depth = null, urls = false } = options;
  if (interactive) {
    const rows = interactiveRows(nodes).filter(([level]) => depth === null || level <= depth);
    return interactiveLines(rows, urls, labelsForRepeats(nodes, rows)).join("\n");
  }
  const lines: string[] = [];
  const kept = new Map<Node, boolean>();
  const keepCompact = (node: Node): boolean => {
    const known = kept.get(node);
    if (known !== undefined) return known;
    let keep: boolean;
    if (node.role === "StaticText") keep = Boolean(pyStripped(node.name));
    else keep = Boolean(node.ref) || Boolean(pyStripped(node.name)) || node.children.some(keepCompact);
    kept.set(node, keep);
    return keep;
  };
  const emit = (node: Node, level: number, parentName: string): void => {
    if (node.role === "generic" && !node.name && !node.ref && !(node.hints && node.hints.length)) {
      for (const child of node.children) emit(child, level, parentName);
      return;
    }
    if (node.role === "StaticText" && parentName && pyStripped(node.name) === pyStripped(parentName)) return;
    if (compact && !keepCompact(node)) return;
    if (node.role === "StaticText" && !pyStripped(node.name)) return;
    if (depth !== null && level > depth) return;
    lines.push(line(node, level, urls));
    for (const child of node.children) emit(child, level + 1, node.name);
  };
  for (const node of nodes) emit(node, 0, "");
  return lines.join("\n");
}
