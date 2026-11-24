import { noteShown, remember } from "../changes/views.ts";
import type { Page } from "../state/page.ts";
import { quiet } from "../state/page.ts";
import type { Ref } from "../state/refs.ts";
import { record } from "../state/records.ts";
import type { State } from "../state/state.ts";
import { type Tier, tierOf } from "./budget.ts";
import { type Collected, collect, collectedInfo, linkUrls, refsOf, sameIdentity, settledAll, verifyIdentity } from "./collect.ts";
export { verifyIdentity } from "./collect.ts";
import { ambiguousControls, type Clue, CLUE_OF, compactTree, noteOf, type Trimmed } from "./compact.ts";
import { add, flag } from "../metrics.ts";
import { advance } from "./epoch.ts";
import { interactiveRows, labelsForRepeats, type Listed, render, renderListed, renderRows } from "./render.ts";
import { type Node, walk } from "./tree.ts";

export const MAX_CLUES = 24;

export type TakeOptions = { interactive?: boolean; compact?: boolean; depth?: number | null; selector?: string | null; urls?: boolean; cursor?: boolean };
export type ShootOptions = TakeOptions & { modal?: boolean; visible?: boolean; tidy?: boolean; lean?: boolean };
export type Line = { text: string; level: number; ref: string | null; node: Node | null; tier: Tier };
export type Shot = {
  nodes: Node[];
  shown: Node[];
  lines: Line[];
  listed: Listed[] | null;
  info: Collected | null;
  whole: boolean;
  tidy: boolean;
};

export async function take(state: State, page: Page, options: TakeOptions = {}): Promise<[string, Ref[], Listed[] | null]> {
  const { interactive = false, compact = false, depth = null, selector = null, urls = false, cursor = true } = options;
  const nodes = await collect(state, page, selector, cursor);
  if (urls) await linkAll(page, nodes);
  const listed = interactive ? renderListed(nodes, depth, urls) : null;
  const text = listed === null ? render(nodes, { interactive, compact, depth, urls }) : listed.map((entry) => entry.text).join("\n");
  await verifyIdentity(page, nodes);
  const refs = refsOf(state, page, nodes, !selector);
  const whole = !(depth !== null || selector);
  state.setRefs(refs, text, page);
  if (whole) noteShown(state, await remember(state, page, nodes));
  return [text, refs, listed];
}

async function linkAll(page: Page, nodes: readonly Node[]): Promise<void> {
  const frames = [...new Set([...walk(nodes)].map((node) => node.frame as string))];
  for (const used of frames) await linkUrls(page, [...walk(nodes)].filter((node) => node.frame === used), used);
}

async function clueOf(page: Page, node: Node): Promise<Clue> {
  try {
    const element = await page.resolveBackend(node.backend as number, node.frame as string, "control");
    if (element === null) return {};
    const found = record(await page.call(CLUE_OF, [element], { frame: node.frame, read: true }));
    const text = (value: unknown) => (typeof value === "string" ? value : null);
    return { testid: text(found["testid"]), icon: text(found["icon"]), alt: text(found["alt"]) };
  } catch (error) {
    if (quiet(error)) return {};
    throw error;
  }
}

export async function disambiguators(page: Page, shown: readonly Node[], interactive: boolean): Promise<Map<Node, string>> {
  const ambiguous = ambiguousControls(shown);
  const notes = new Map<Node, string>();
  if (ambiguous.length === 0) return notes;
  const near = labelsForRepeats(shown, interactiveRows(shown));
  const wanted = ambiguous.filter(({ node, nameless }) => node.backend !== null && (nameless || !near.has(node))).slice(0, MAX_CLUES);
  const clues = new Map<Node, Clue>();
  await settledAll(wanted.map(async ({ node }) => clues.set(node, await clueOf(page, node))));
  for (const { node, nameless } of ambiguous) {
    const note = noteOf(clues.get(node) ?? {}, nameless, near.get(node) ?? null);
    if (note === null) continue;
    if (interactive && note.startsWith("near ")) continue;
    notes.set(node, note);
  }
  return notes;
}

export async function shoot(state: State, page: Page, options: ShootOptions = {}): Promise<Shot> {
  const { interactive = false, compact = false, depth = null, selector = null, urls = false, cursor = true, modal = false, visible = false, tidy = false, lean = false } = options;
  const nodes = await collect(state, page, selector, cursor, { modal: modal && !selector, visible });
  if (urls) await linkAll(page, nodes);
  const info = collectedInfo.get(nodes) ?? null;
  const trimmed: Trimmed = { lines: 0 };
  const shown = tidy ? compactTree(nodes, lean && !interactive, trimmed) : nodes;
  if (trimmed.lines > 0) {
    flag("snapshot_lean_trimmed", true);
    add("snapshot_lean_lines", trimmed.lines);
  }
  const notes = tidy ? await disambiguators(page, shown, interactive) : new Map<Node, string>();
  let lines: Line[];
  let listed: Listed[] | null = null;
  if (interactive) {
    listed = renderListed(shown, depth, urls, notes);
    lines = listed.map((entry) => ({ text: entry.text, level: entry.level ?? 0, ref: entry.ref, node: entry.node ?? null, tier: tierOf(entry.node, entry.ref) }));
  } else {
    lines = renderRows(shown, { compact, depth, urls }, notes).map((row) => ({ text: row.text, level: row.level, ref: row.node.ref, node: row.node, tier: tierOf(row.node, row.node.ref) }));
  }
  const whole = !(depth !== null || selector) && info?.modal == null;
  return { nodes, shown, lines, listed, info, whole, tidy };
}

export type Committed = { refs: Ref[]; epoch: number };

export function candidates(state: State, page: Page, shot: Shot, excluded: ReadonlySet<string> | null = null, scoped = false): Ref[] {
  sameIdentity(page, shot.nodes);
  const inTree = shot.tidy ? new Set([...walk(shot.shown)].flatMap((node) => (node.ref ? [node.ref] : []))) : null;
  const wholePage = !scoped && shot.info?.modal == null && shot.whole;
  return refsOf(state, page, shot.nodes, wholePage).filter((ref) => (inTree === null || inTree.has(ref.id)) && (excluded === null || !excluded.has(ref.id)));
}

export async function commit(state: State, page: Page, shot: Shot, text: string, excluded: ReadonlySet<string> | null = null, scoped = false, keepView = false): Promise<Committed> {
  await verifyIdentity(page, shot.nodes);
  const wholePage = !scoped && shot.info?.modal == null && shot.whole;
  const refs = candidates(state, page, shot, excluded, scoped);
  const epochs = advance(state, page, refs, wholePage && (excluded === null || excluded.size === 0));
  for (const ref of refs) ref.epoch = epochs.frames.get(ref.frame) ?? epochs.main;
  const epoch = epochs.main;
  state.setRefs(refs, text, page);
  if (!keepView && shot.whole && !scoped && (shot.info === null || shot.info.hiddenDropped === 0)) noteShown(state, await remember(state, page, shot.nodes));
  return { refs, epoch };
}

export function contentLines(shot: Shot): Line[] {
  if (shot.listed === null) return shot.lines;
  return renderRows(shot.shown).map((row) => ({ text: row.text, level: row.level, ref: row.node.ref, node: row.node, tier: tierOf(row.node, row.node.ref) }));
}

export function refsLeftOut(lines: readonly Line[], kept: readonly boolean[]): Set<string> {
  const out = new Set<string>();
  lines.forEach((line, index) => {
    if (line.ref && !kept[index]) out.add(line.ref);
  });
  return out;
}
