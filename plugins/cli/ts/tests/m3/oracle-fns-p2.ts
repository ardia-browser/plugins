import fs from "node:fs";
import type { Value } from "../../src/json.ts";
import { begin } from "../../src/browse/metrics.ts";
import { diff, entriesOf, containersOf, freshRows, moved, type Report, type View, type Write } from "../../src/browse/changes/report.ts";
import { addsText, asData, openedAnchors, refsText, renderReport, runLabel, within } from "../../src/browse/changes/text.ts";
import { cleanUrl, maskedUrl } from "../../src/browse/changes/urls.ts";
import { render } from "../../src/browse/snapshot/render.ts";
import { type AxNode, buildTree, INTERACTIVE, type Node, REF_ROLES, walk, walkInContext } from "../../src/browse/snapshot/tree.ts";
import { addSecret, clearSecrets } from "../../src/redact.ts";
import { bool, num, optionalText, text, texts, toValue } from "./values.ts";
import { P2_MORE } from "./oracle-fns-p2b.ts";

const FLAGS = ["names_clipped", "snapshot_repeat_labels", "snapshot_disabled_folded", "change_run_choices"];

function setSecrets(secrets: Value | undefined): void {
  clearSecrets();
  for (const secret of texts(secrets)) addSecret(secret);
}

function flagged(run: () => string): Value {
  return begin({ argv: ["snapshot"] }, (metrics) => {
    const out = run();
    return [out, FLAGS.filter((name) => metrics.values.get(name) === true)];
  });
}

function dump(nodes: readonly Node[]): Value {
  return nodes.map((node) => new Map<string, Value>([
    ["role", node.role], ["name", node.name], ["value", node.value], ["props", toValue(node.props)],
    ["backend", node.backend === null ? null : BigInt(node.backend)], ["ref", node.ref], ["hints", node.hints], ["url", node.url],
    ["children", dump(node.children)],
  ]));
}

function stringMap(value: Value | undefined): Map<string, Value> {
  return value instanceof Map ? value : new Map();
}

function pyKey(backend: number | null): string {
  return backend === null ? "None" : String(backend);
}

function axOf(source: Value | undefined): AxNode[] {
  if (source instanceof Map) return JSON.parse(fs.readFileSync(text(source.get("file")), "utf8")).result.nodes;
  return JSON.parse(text(source));
}

function nodesOf(axText: Value | undefined, scope: number | null, hints: Map<string, Value>, urls: Map<string, Value>): Node[] {
  const nodes = buildTree(axOf(axText), scope);
  for (const node of walk(nodes)) {
    const key = pyKey(node.backend);
    if (hints.has(key) && !INTERACTIVE.has(node.role)) node.hints = texts(hints.get(key));
    if (node.role === "link" && urls.has(key)) node.url = text(urls.get(key));
  }
  for (const node of walk(nodes)) {
    if (REF_ROLES.has(node.role) || (node.hints && node.hints.length)) {
      if ((node.role === "heading" && !node.name) || node.backend === null) continue;
      node.ref = `e${node.backend}`;
    }
  }
  return nodes;
}

function viewOf(args: Value): [Node[], View] {
  const [axText, loader, url, title, hints] = args as Value[];
  const nodes = nodesOf(axText, null, stringMap(hints), new Map());
  return [nodes, { target: "t", loader: text(loader), url: text(url), title: text(title), entries: entriesOf(nodes), containers: containersOf(nodes) }];
}

function plainOf(value: Value | undefined): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "bigint") return Number(value);
  if (value !== null && typeof value === "object" && "value" in value && !(value instanceof Map) && !Array.isArray(value)) return (value as { value: number }).value;
  if (Array.isArray(value)) return value.map(plainOf);
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [key, plainOf(item)]));
  return value;
}

export const P2_FUNCTIONS: Record<string, (...args: Value[]) => Value> = {
  "snapshot.take": (axText, scope, hints, urls, options, secrets) => {
    setSecrets(secrets);
    const nodes = nodesOf(axText, scope === null ? null : num(scope), stringMap(hints), stringMap(urls));
    const renders = (options as Value[]).map((option) => {
      const [interactive, compact, depth, showUrls] = option as Value[];
      return flagged(() => render(nodes, { interactive: bool(interactive), compact: bool(compact), depth: depth === null ? null : num(depth), urls: bool(showUrls) }));
    });
    const contexts = walkInContext(nodes).filter(([node]) => node.ref).map(([node, context]): Value => [node.ref, context.map(([role, name]) => [role, name])]);
    return new Map<string, Value>([["tree", dump(nodes)], ["renders", renders], ["entries", toValue(entriesOf(nodes))], ["contexts", contexts]]);
  },
  "changes.report": (before, after, writes, extra, beforeKnown, secrets) => {
    setSecrets(secrets);
    const old = before === null ? null : viewOf(before)[1];
    const [nodes, now] = viewOf(after);
    const report: Report = diff(old, now, (plainOf(writes) as Write[] | null) ?? null);
    const options = stringMap(extra);
    const back = new Set(options.has("back") ? texts(options.get("back")) : []);
    report.back = report.added.filter((row) => back.has(row.ref)).map((row) => row.ref);
    for (const name of ["text", "notes", "unsettled", "error"] as const) if (options.has(name)) (report as Record<string, unknown>)[name] = plainOf(options.get(name));
    const rendered = flagged(() => renderReport(report, bool(beforeKnown))) as Value[];
    const fresh = freshRows(report);
    const lines = report.text?.lines ?? [];
    return new Map<string, Value>([
      ["text", rendered[0] as Value], ["flags", rendered[1] as Value], ["data", toValue(asData(report))], ["fresh", fresh.map((row) => row.ref)],
      ["anchors", openedAnchors(report, nodes, old).map((node): Value => [node.role, node.ref, node.backend === null ? null : BigInt(node.backend)])],
      ["adds_text", addsText(lines, fresh)], ["moved", moved(report)],
    ]);
  },
  "changes.clean_url": (url, secrets) => {
    setSecrets(secrets);
    return cleanUrl(text(url));
  },
  "changes.masked_url": (url, secrets) => {
    setSecrets(secrets);
    return maskedUrl(text(url));
  },
  "changes.refs_text": (refs) => refsText(texts(refs)),
  "changes.within": (lines, budget) => BigInt(within(texts(lines), num(budget))),
  "changes.run_label": (value, secrets) => {
    setSecrets(secrets);
    return runLabel(optionalText(value));
  },
  ...P2_MORE,
};
