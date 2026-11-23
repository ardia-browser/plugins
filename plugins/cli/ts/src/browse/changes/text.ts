import { truthy } from "../../pylib/plain.ts";
import { shlexQuote } from "../../pylib/shlex.ts";
import { headPoints, PyException, pyInt, pyLen, reprText } from "../../pylib/str.ts";
import { redact } from "../../redact.ts";
import { flag } from "../metrics.ts";
import { quoted, squashed } from "../snapshot/render.ts";
import { type Node, walk } from "../snapshot/tree.ts";
import {
  CONTAINER_ROLES, containerKey, freshRows, itemRuns, keptWhole, MAX_ADDED, MAX_NAVIGATED, MAX_REMOVED_LINES, MAX_REMOVED_REFS, MAX_WRITES,
  MIN_NAVIGATED_LIST, MIN_NEW_TEXT, moved, NAVIGATED_REPORT, networkLine, OPENED_LEVEL, parentsOf, plainRow, plural, public_, type Report, type Row,
  RUN_HINT, RUN_LABEL, type TextBlock, type View, was,
} from "./report.ts";
import { maskedUrl, stripInlineRefs, wordCount } from "./urls.ts";
import { formatG } from "../../pylib/format.ts";
import { dialogLine, downloadLine } from "./dialogs.ts";
import { throttleLine } from "./throttle.ts";

export function runLabel(value: string | null | undefined): string {
  const text = squashed(redact(value || ""));
  return pyLen(text) <= RUN_LABEL ? text : `${headPoints(text, RUN_LABEL - 1)}…`;
}

export function runText(items: readonly Row[], parent: Row | undefined, verb = ""): string {
  const role = (items[0] as Row).role;
  const where = parent && parent.name ? ` in ${parent.role} ${quoted(runLabel(parent.name))}` : "";
  const names = items.map((item) => runLabel(item.name || item.value));
  const span = names[0] || names.at(-1) ? `${names[0]} … ${names.at(-1)}` : "";
  const refs = `${(items[0] as Row).ref}…${(items.at(-1) as Row).ref}`;
  const disabled = items.filter((item) => item.attrs.includes("disabled")).length;
  const extra = disabled ? `; ${disabled} disabled` : "";
  const detail = [span, refs].filter((part) => part).join("; ");
  return `${items.length} ${plural(role, items.length)}${where}${verb} (${detail}${extra})`;
}

function choicesLines(on: readonly Row[], off: readonly Row[], indent: string, refs?: string[][]): string[] {
  flag("change_run_choices", true);
  const role = (on[0] as Row).role;
  const lines = on.slice(0, MAX_ADDED).map((row) => `+ ${indent}${row.line}`);
  refs?.push(...on.slice(0, MAX_ADDED).map((row) => [row.ref]));
  if (on.length > MAX_ADDED) {
    lines.push(`+ ${indent}… ${on.length - MAX_ADDED} more enabled ${plural(role, on.length - MAX_ADDED)} (\`snapshot -i\` lists every one)`);
    refs?.push([]);
  }
  const first = off[0] as Row;
  const last = off.at(-1) as Row;
  const span = off.length > 1 ? `${runLabel(first.name || first.value)} … ${runLabel(last.name || last.value)}` : runLabel(first.name);
  lines.push(`+ ${indent}${off.length} disabled ${plural(role, off.length)} (${span})`);
  refs?.push([]);
  return lines;
}

export function addedLines(added: readonly Row[], parents: ReadonlyMap<string, Row>, refs?: string[][]): string[] {
  const base = Math.min(...added.map((row) => row.level));
  const indent = (row: Row) => "  ".repeat(Math.max(0, row.level - base));
  const lines: string[] = [];
  for (const part of itemRuns(added, parents)) {
    if (part.kind === "row") {
      lines.push(`+ ${indent(part.row)}${part.row.line}`);
      refs?.push([part.row.ref]);
      continue;
    }
    const off = part.items.filter((item) => item.attrs.includes("disabled"));
    const on = part.items.filter((item) => !item.attrs.includes("disabled"));
    if (off.length && on.length) {
      lines.push(...choicesLines(on, off, indent(part.items[0] as Row), refs));
      continue;
    }
    lines.push(`+ ${indent(part.items[0] as Row)}${runText(part.items, part.parent)}`);
    refs?.push(part.items.map((item) => item.ref));
    for (const row of part.rows) {
      if (!keptWhole(row)) continue;
      lines.push(`+ ${indent(row)}${row.line}`);
      refs?.push([row.ref]);
    }
  }
  return lines;
}

export function textBlock(text: TextBlock): string[] {
  const lines = ["text:", ...text.lines.map((line) => `  ${line}`)];
  if (truthy(text.more)) lines.push(text.where ? `  … more: read -s ${shlexQuote(text.where)}` : "  … more: read");
  return lines;
}

export function within(lines: readonly string[], budget: number): number {
  let used = 0;
  for (const [index, line] of lines.entries()) {
    used += pyLen(line) + 1;
    if (used > budget) return index;
  }
  return lines.length;
}

export function changedLines(changed: readonly [Row, Row][], parents: ReadonlyMap<string, Row>, refs?: string[][]): string[] {
  const news = changed.map(([, now]) => now);
  const olds = new Map(changed.map(([old, now]) => [now.ref, old]));
  const lines: string[] = [];
  for (const part of itemRuns(news, parents)) {
    if (part.kind === "row") {
      lines.push(`~ ${part.row.line}${was(olds.get(part.row.ref) as Row, part.row)}`);
      refs?.push([part.row.ref]);
      continue;
    }
    lines.push(`~ ${runText(part.items, part.parent, " changed")}`);
    refs?.push(part.items.map((item) => item.ref));
    for (const row of part.rows) {
      if (!keptWhole(row) || keptWhole(olds.get(row.ref) as Row)) continue;
      lines.push(`~ ${row.line}${was(olds.get(row.ref) as Row, row)}`);
      refs?.push([row.ref]);
    }
  }
  return lines;
}

export type ReportLine = { text: string; refs: string[] };

export function refsListed(refs: readonly string[]): string[] {
  const numbers = refs.map((ref) => ref.slice(1)).filter((digits) => digits && /^[0-9]+$/.test(digits));
  if (numbers.length === refs.length && refs.length > 2 && numbers.every((value, index) => Number(value) === Number(numbers[0]) + index)) return [...refs];
  return refs.slice(0, MAX_REMOVED_REFS);
}

export function renderReport(report: Report, beforeKnown = true): string {
  const lines = renderReportLines(report, beforeKnown).map((line) => line.text);
  return lines.length ? `changes:\n${lines.join("\n")}` : "changes: none";
}

export function renderReportLines(report: Report, beforeKnown = true): ReportLine[] {
  const lines: ReportLine[] = [];
  const plain = (text: string) => lines.push({ text, refs: [] });
  if (report.url) plain(`url: ${maskedUrl(report.url.from)} → ${maskedUrl(report.url.to)}`);
  if (report.title) plain(`title: ${reprText(report.title.from)} → ${reprText(report.title.to)}`);
  const back = new Set(report.back ?? []);
  const again = report.rerendered ?? [];
  const fresh = new Set(again.map(([, now]) => now.ref));
  const text = report.text;
  const inline = new Set(text ? text.refs : []);
  const added = report.added.filter((row) => !back.has(row.ref) && !fresh.has(row.ref) && !(inline.has(row.ref) && plainRow(row)));
  const context = report.context && report.context.length ? report.context : [...report.added, ...report.changed.map(([, now]) => now)];
  const parents = parentsOf(context);
  const navigated = moved(report);
  if (report.notes) plain(report.notes);
  if (report.document === "new" && beforeKnown) {
    const where = text && added.length < report.added.length ? "; the ones marked [@e…] in its text below aren't repeated here" : "";
    plain(`new document, ${report.added.length} interactive nodes (its snapshot -i, so no need to take one${where}):`);
  }
  if (back.size) {
    const refs = report.added.filter((row) => back.has(row.ref)).map((row) => row.ref);
    const more = refs.length > MAX_REMOVED_REFS ? ` … ${refs.length - MAX_REMOVED_REFS} more` : "";
    lines.push({ text: `+ ${refs.length} back as last shown: ${refs.slice(0, MAX_REMOVED_REFS).join(" ")}${more}`, refs: refs.slice(0, MAX_REMOVED_REFS) });
  }
  if (added.length) {
    const lineRefs: string[][] = [];
    const shown = addedLines(added, parents, lineRefs);
    let limit = navigated ? MAX_NAVIGATED : MAX_ADDED;
    if (navigated && text) {
      const used = textBlock(text).reduce((sum, line) => sum + pyLen(line) + 1, 0);
      limit = Math.min(limit, within(shown, Math.max(MIN_NAVIGATED_LIST, NAVIGATED_REPORT - used)));
    }
    shown.slice(0, limit).forEach((line, index) => lines.push({ text: line, refs: lineRefs[index] ?? [] }));
    if (shown.length > limit) plain(`+ … ${shown.length - limit} more lines (\`snapshot -i -s <css>\` shows one region)`);
  }
  if (again.length) {
    const now = again.map(([, row]) => row.ref);
    lines.push({ text: `+ ${again.length} redrawn as they were, with new refs: ${refsText(now)}`, refs: refsListed(now) });
  }
  if (text) for (const line of textBlock(text)) lines.push({ text: line, refs: text.refs.filter((ref) => line.includes(`[@${ref}]`)) });
  const changedRefs: string[][] = [];
  changedLines(report.changed, parents, changedRefs).forEach((line, index) => lines.push({ text: line, refs: changedRefs[index] ?? [] }));
  const gone = new Set(again.map(([old]) => old.ref));
  const removed = report.removed.filter((row) => !gone.has(row.ref));
  if (removed.length <= MAX_REMOVED_LINES) for (const row of removed) plain(`- ${row.line}`);
  else if (navigated && text) plain(`- ${removed.length} of the last view's nodes removed`);
  else {
    const refs = removed.slice(0, MAX_REMOVED_REFS).map((row) => row.ref).join(" ");
    const more = removed.length > MAX_REMOVED_REFS ? ` … ${removed.length - MAX_REMOVED_REFS} more` : "";
    plain(`- ${removed.length} removed: ${refs}${more}`);
  }
  const writes = report.network;
  for (const write of writes.slice(0, MAX_WRITES)) plain(networkLine(write));
  if (writes.length > MAX_WRITES) plain(`… ${writes.length - MAX_WRITES} more requests (\`network requests\`)`);
  if (report.navigationError) plain(`✗ the page didn't load: ${report.navigationError}`);
  for (const seen of report.dialogs ?? []) plain(dialogLine(seen));
  for (const seen of report.downloads ?? []) plain(downloadLine(seen));
  if (report.unsettled) plain(`(the page was still busy after ${formatG(report.settleLimit ?? 1.5)} s; snapshot again for the final state)`);
  if (report.throttle) plain(throttleLine(report.throttle));
  if (report.error) plain(`(couldn't read the page afterwards: ${report.error})`);
  if ([added, report.changed.map(([, now]) => now)].some((rows) => itemRuns(rows).some((part) => part.kind === "run"))) plain(RUN_HINT);
  return lines;
}

export function refsText(refs: readonly string[]): string {
  const numbers: number[] = [];
  for (const ref of refs) {
    const digits = ref.slice(1);
    if (digits && /^[0-9]+$/.test(digits)) numbers.push(Number(pyInt(digits)));
  }
  if (numbers.length === refs.length && refs.length > 2 && numbers.every((value, index) => value === (numbers[0] as number) + index)) {
    return `${refs[0]}…${refs.at(-1)}`;
  }
  const more = refs.length > MAX_REMOVED_REFS ? ` … ${refs.length - MAX_REMOVED_REFS} more` : "";
  return refs.slice(0, MAX_REMOVED_REFS).join(" ") + more;
}

export function asData(report: Report): Record<string, unknown> {
  const data: Record<string, unknown> = {
    document: report.document,
    url: report.url ? { from: maskedUrl(report.url.from), to: maskedUrl(report.url.to) } : null,
    title: report.title,
    added: report.added.map(public_),
    removed: report.removed.map(public_),
    changed: report.changed.map(([old, now]) => ({ ref: now.ref, from: public_(old), to: public_(now) })),
    network: report.network,
    back: [...(report.back ?? [])],
    rerendered: (report.rerendered ?? []).map(([old, now]) => ({ ref: now.ref, was: old.ref })),
  };
  if (report.notes) data.notes = report.notes;
  if (report.text) data.text = { lines: report.text.lines, more: truthy(report.text.more), where: report.text.where || null };
  if (report.unsettled) data.unsettled = true;
  if (report.error) data.error = report.error;
  if (report.navigationError) data.navigationError = report.navigationError;
  if (report.dialogs && report.dialogs.length) data.dialogs = report.dialogs;
  if (report.downloads && report.downloads.length) data.downloads = report.downloads;
  if (report.throttle) data.throttle = report.throttle;
  return data;
}

export function headingLevel(node: Node): number {
  const level = node.props.get("level");
  if (!truthy(level)) return 0;
  if (typeof level === "number") return Math.trunc(level);
  if (level === true) return 1;
  if (typeof level === "string") {
    try {
      return Number(pyInt(level));
    } catch (error) {
      if (error instanceof PyException) return 0;
      throw error;
    }
  }
  return 0;
}

export function openedAnchors(report: Report, nodes: readonly Node[], before: View | null): Node[] {
  const fresh = new Set(freshRows(report).map((row) => row.ref));
  const known = before !== null ? before.containers : new Set<string>();
  const anchors: Node[] = [];
  for (const node of walk(nodes)) {
    if (node.backend === null) continue;
    if (node.role === "heading" && node.ref !== null && fresh.has(node.ref) && headingLevel(node) > 0 && headingLevel(node) <= OPENED_LEVEL) anchors.push(node);
    else if (CONTAINER_ROLES.has(node.role) && !known.has(containerKey(node.frame, node.backend)) && [...walk(node.children)].some((inner) => inner.ref !== null && fresh.has(inner.ref))) {
      anchors.push(node);
    }
  }
  return anchors;
}

export function addsText(lines: readonly string[], rows: readonly Row[]): boolean {
  let rest = stripInlineRefs(lines.join("\n"));
  for (const row of rows) {
    if (pyLen(row.name) >= 3) {
      const at = rest.indexOf(row.name);
      if (at >= 0) rest = rest.slice(0, at) + rest.slice(at + row.name.length);
    }
  }
  return wordCount(rest) >= MIN_NEW_TEXT;
}

