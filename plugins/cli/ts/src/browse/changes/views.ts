import { BrowseError, ConnectionLost } from "../daemon-errors.ts";
import { collect } from "../snapshot/collect.ts";
import type { Node } from "../snapshot/tree.ts";
import type { Page } from "../state/page.ts";
import type { State } from "../state/state.ts";
import { containersOf, entriesOf, type Report, type View } from "./report.ts";

const SHOWN = new WeakMap<State, Map<string, string>>();

export function shownOf(state: State): Map<string, string> {
  let shown = SHOWN.get(state);
  if (shown === undefined) {
    shown = new Map();
    SHOWN.set(state, shown);
  }
  return shown;
}

export function viewFrame(state: State, page: Page): string {
  return (state.frameFor(page) || page.mainFrame) as string;
}

export async function titleOf(page: Page): Promise<string> {
  let title: unknown;
  try {
    title = await page.call("() => document.title", [], { frame: page.mainFrame, read: true });
  } catch (error) {
    if (error instanceof ConnectionLost || !(error instanceof BrowseError)) throw error;
    return "";
  }
  return typeof title === "string" ? title : "";
}

export async function view(state: State, page: Page, nodes: Node[] | null = null): Promise<View> {
  const seen = nodes ?? (await collect(state, page));
  return {
    target: page.targetId,
    loader: page.loader(viewFrame(state, page)) || "",
    url: page.url,
    title: await titleOf(page),
    entries: entriesOf(seen),
    containers: containersOf(seen),
  };
}

export async function remember(state: State, page: Page, nodes: Node[]): Promise<View> {
  const seen = await view(state, page, nodes);
  state.views.set(page.targetId, seen);
  return seen;
}

export function noteShown(state: State, seen: View): void {
  const shown = shownOf(state);
  for (const row of seen.entries) shown.set(row.ref, row.line);
}

export function markShown(state: State, report: Report, after: View): void {
  const shown = shownOf(state);
  report.back = report.added.filter((row) => shown.get(row.ref) === row.line).map((row) => row.ref);
  for (const row of after.entries) shown.set(row.ref, row.line);
}

export function previous(state: State, page: Page): View | null {
  const seen = state.views.get(page.targetId) as View | undefined;
  if (seen === undefined || seen.loader !== (page.loader(viewFrame(state, page)) || "")) return null;
  return seen;
}
