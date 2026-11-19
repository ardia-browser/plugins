import { BrowseError, ConnectionLost } from "../daemon-errors.ts";

function unsupportedSnapshots(): BrowseError {
  return new BrowseError("The page's accessibility snapshot isn't served by the TypeScript daemon yet (it arrives with a later slice of the port)", null, "unsupported");
}
import type { Node } from "../snapshot/tree.ts";
import type { Page } from "../state/page.ts";
import { Refs } from "../state/refs.ts";
import type { State } from "../state/state.ts";
import { containersOf, entriesOf, type Report, type View } from "./report.ts";

const views = new WeakMap<State, Map<string, View>>();
const shownLines = new WeakMap<State, Map<string, string>>();

function seenViews(state: State): Map<string, View> {
  let found = views.get(state);
  if (found === undefined) views.set(state, (found = new Map()));
  return found;
}

export function shown(state: State): Map<string, string> {
  let found = shownLines.get(state);
  if (found === undefined) shownLines.set(state, (found = new Map()));
  return found;
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

export async function collect(state: State, page: Page): Promise<Node[]> {
  const snapshots = Refs.snapshots;
  if (snapshots === null) throw unsupportedSnapshots();
  return (await snapshots.collect(state, page)) as Node[];
}

export function adoptRefs(state: State, page: Page, nodes: Node[]): void {
  const snapshots = Refs.snapshots;
  if (snapshots === null) throw unsupportedSnapshots();
  state.setRefs(snapshots.refsOf(state, page, nodes), null, page);
}

export async function view(state: State, page: Page, given: Node[] | null = null): Promise<View> {
  const nodes = given ?? (await collect(state, page));
  return {
    target: page.targetId,
    loader: page.loader(viewFrame(state, page)) || "",
    url: page.url,
    title: await titleOf(page),
    entries: entriesOf(nodes),
    containers: containersOf(nodes),
  };
}

export async function remember(state: State, page: Page, nodes: Node[]): Promise<View> {
  const seen = await view(state, page, nodes);
  seenViews(state).set(page.targetId, seen);
  return seen;
}

export function previous(state: State, page: Page): View | null {
  const seen = seenViews(state).get(page.targetId);
  if (seen === undefined || seen.loader !== (page.loader(viewFrame(state, page)) || "")) return null;
  return seen;
}

export function noteShown(state: State, seen: View): void {
  const lines = shown(state);
  for (const row of seen.entries) lines.set(row.ref, row.line);
}

export function markShown(state: State, report: Report, after: View): void {
  const lines = shown(state);
  report.back = report.added.filter((row) => lines.get(row.ref) === row.line).map((row) => row.ref);
  for (const row of after.entries) lines.set(row.ref, row.line);
}
