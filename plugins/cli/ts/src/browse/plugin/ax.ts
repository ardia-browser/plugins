import { sleep } from "../cdp/cancel.ts";
import { BrowseError, ConnectionLost } from "../daemon-errors.ts";
import { containersOf, diff, entriesOf, type Report, type View } from "../changes/report.ts";
import { asData, renderReport } from "../changes/text.ts";
import { clock, flag, spent } from "../metrics.ts";
import { Result } from "../daemon/render.ts";
import { REF_ROLES, type AxNode, buildTree, isAxList, type Node, walk } from "../snapshot/tree.ts";
import { type PluginPage } from "./page.ts";
import { type PluginSession, type Ref } from "./session.ts";

export const FIRST_QUIET = 0.05;
export const QUIET = 0.12;
export const SETTLE_LIMIT = 1.5;
export const POLL = 0.025;

export async function axNodes(page: PluginPage): Promise<AxNode[]> {
  const nodes = (await page.send("Accessibility.getFullAXTree", {}))["nodes"];
  return isAxList(nodes) ? nodes : [];
}

export async function collect(session: PluginSession, page: PluginPage, scope: number | null = null): Promise<Node[]> {
  const started = clock();
  const frame = page.mainFrame ?? "";
  const nodes = buildTree(await axNodes(page), scope);
  for (const node of walk(nodes)) {
    node.frame = frame;
    if (!REF_ROLES.has(node.role) || node.backend === null || (node.role === "heading" && !node.name)) continue;
    node.ref = session.refFor(page, frame, node.backend);
  }
  spent("snapshot_build_ms", started);
  return nodes;
}

export function refsOf(session: PluginSession, page: PluginPage, nodes: readonly Node[]): Ref[] {
  const out: Ref[] = [];
  for (const node of walk(nodes)) {
    if (!node.ref || node.backend === null) continue;
    out.push({ id: node.ref, target: page.targetId, frame: node.frame ?? "", loader: page.frames.get(node.frame ?? "")?.loader ?? "", backend: node.backend, role: node.role, name: node.name });
  }
  return out;
}

export function keepRefs(session: PluginSession, page: PluginPage, nodes: readonly Node[], current: boolean): void {
  const refs = refsOf(session, page, nodes);
  for (const ref of refs) session.keepRef(ref);
  if (current) session.currentRefs = refs.map((ref) => ref.id);
}

export async function viewOf(session: PluginSession, page: PluginPage, nodes: readonly Node[]): Promise<View> {
  return { target: page.targetId, loader: page.loader ?? "", url: page.url, title: await session.title(page), entries: entriesOf(nodes), containers: containersOf(nodes) };
}

export async function remember(session: PluginSession, page: PluginPage, nodes: readonly Node[]): Promise<View> {
  const seen = await viewOf(session, page, nodes);
  session.views.set(page.targetId, seen);
  return seen;
}

export function previous(session: PluginSession, page: PluginPage): View | null {
  const seen = session.views.get(page.targetId);
  return seen === undefined || seen.loader !== (page.loader ?? "") ? null : seen;
}

export function noteShown(session: PluginSession, seen: View): void {
  for (const row of seen.entries) session.shown.set(row.ref, row.line);
}

function markShown(session: PluginSession, report: Report, after: View): void {
  report.back = report.added.filter((row) => session.shown.get(row.ref) === row.line).map((row) => row.ref);
  noteShown(session, after);
}

export async function settle(page: PluginPage, navigations: number): Promise<boolean> {
  const started = clock();
  await sleep(FIRST_QUIET);
  for (;;) {
    const moving = page.loading || (page.navigations !== navigations && page.mainFrame !== null && !page.reached("load"));
    if (!moving && page.quietFor() >= QUIET) return true;
    if (clock() - started >= SETTLE_LIMIT) return false;
    await sleep(POLL);
  }
}

export async function observe<T>(session: PluginSession, page: PluginPage, options: Record<string, unknown>, run: () => Promise<T>): Promise<[T, Report | null]> {
  if (options["no_changes"]) {
    const value = await run();
    await settle(page, page.navigations);
    return [value, null];
  }
  let before: View | null;
  try {
    before = await viewOf(session, page, await collect(session, page));
  } catch (error) {
    if (error instanceof ConnectionLost || !(error instanceof BrowseError)) throw error;
    before = null;
  }
  const navigations = page.navigations;
  const value = await run();
  const settling = clock();
  const settled = await settle(page, navigations);
  spent("settle_ms", settling);
  let nodes: Node[];
  let after: View;
  try {
    await page.refreshFrames();
    nodes = await collect(session, page);
    keepRefs(session, page, nodes, false);
    after = await remember(session, page, nodes);
  } catch (error) {
    if (error instanceof ConnectionLost || !(error instanceof BrowseError)) throw error;
    const report = diff(null, { target: page.targetId, loader: "", url: page.url, title: "", entries: [], containers: new Set() });
    report.document = "unknown";
    report.error = error.text;
    return [value, report];
  }
  const report = diff(before, after);
  markShown(session, report, after);
  if (!settled) {
    report.unsettled = true;
    flag("unsettled", true);
  }
  if (before === null) report.document = "unknown";
  return [value, report];
}

export function attach(result: Result, report: Report | null): Result {
  if (report === null) return result;
  (result.data as Record<string, unknown>)["changes"] = asData(report);
  let text = renderReport(report, report.document !== "unknown");
  if (report.document === "unknown" && report.added.length) text = text.replace("changes:\n", "changes (no view of the page before, so everything shows as added):\n");
  const out = new Result(result.data, `${result.text ?? "✓ Done"}\n${text}`, result.pageContent);
  out.failed = result.failed;
  return out;
}

export function onlyTheFieldChanged(report: Report | null): boolean {
  if (!report || report.document !== "same" || report.unsettled) return false;
  const quiet = !(report.added.length || report.removed.length || report.network.length || report.text || report.url || report.title);
  return quiet && report.changed.length <= 1;
}
