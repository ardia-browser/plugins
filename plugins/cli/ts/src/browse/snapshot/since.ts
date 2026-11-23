import { pyLen, pyRstrip, headPoints } from "../../pylib/str.ts";
import { maskedUrl } from "../changes/urls.ts";
import type { Page } from "../state/page.ts";
import type { State } from "../state/state.ts";
import { type Listed, quoted } from "./render.ts";

export const DIFF_SCOPE = "interactive";
export const MAX_CHANGED_SHARE = 0.4;
export const SHOWN_TITLE = 80;

export type Place = { target: string; instance: string | null; frame: string; loader: string; mainLoader: string; navigations: number };
export type ShownSnapshot = Place & { scope: string; command: number; url: string; title: string; listed: readonly Listed[] };
export type SnapshotChanges = { added: Listed[]; changed: [Listed, Listed][]; removed: Listed[]; unchanged: number };
export type SnapshotDiff = { text: string; data: Record<string, unknown> };

export function placeOf(state: State, page: Page): Place {
  const frame = (state.frameFor(page) || page.mainFrame || "") as string;
  return {
    target: page.targetId,
    instance: state.instance,
    frame,
    loader: page.loader(frame) || "",
    mainLoader: page.loader(page.mainFrame) || "",
    navigations: page.navigations,
  };
}

export function samePlace(a: Place, b: Place): boolean {
  return a.target === b.target && a.instance === b.instance && a.frame === b.frame && a.loader === b.loader && a.mainLoader === b.mainLoader && a.navigations === b.navigations;
}

export function scopeOf(options: Record<string, unknown>, selector: string | null, depth: number | null): string {
  const parts: string[] = [];
  if (options["interactive"]) parts.push(DIFF_SCOPE);
  if (options["compact"]) parts.push("compact");
  if (depth !== null) parts.push(`depth=${depth}`);
  if (selector) parts.push(`selector=${selector}`);
  if (options["urls"]) parts.push("urls");
  if (options["cursor"]) parts.push("cursor");
  if (options["diff"]) parts.push("diff");
  return parts.join(" ");
}

function shownOf(state: State): Map<string, ShownSnapshot> {
  return state.snapshotsShown as Map<string, ShownSnapshot>;
}

export function lastShown(state: State, place: Place): ShownSnapshot | null {
  const pending = state.pendingShown as Map<string, ShownSnapshot | null> | null;
  const shown = pending?.has(place.target) ? pending.get(place.target) : shownOf(state).get(place.target);
  if (shown === undefined || shown === null) return null;
  if (!samePlace(shown, place)) {
    forgetShown(state, place.target);
    return null;
  }
  return shown;
}

export function forgetShown(state: State, target: string): void {
  if (state.pendingShown !== null) state.pendingShown.set(target, null);
  else shownOf(state).delete(target);
}

export function commitShown(state: State, staged: ReadonlyMap<string, unknown>): void {
  for (const [target, entry] of staged) {
    if (entry === null) shownOf(state).delete(target);
    else shownOf(state).set(target, entry as ShownSnapshot);
  }
}

export function rememberShown(state: State, shown: ShownSnapshot): void {
  if (state.pendingShown !== null) state.pendingShown.set(shown.target, shown);
  else shownOf(state).set(shown.target, shown);
}

function refCount(listed: readonly Listed[]): number {
  return listed.reduce((sum, entry) => sum + (entry.ref === null ? 0 : 1), 0);
}

export function changesOf(before: readonly Listed[], after: readonly Listed[]): SnapshotChanges {
  const old = new Map<string, Listed>();
  const oldSummaries = new Map<string, number>();
  for (const entry of before) {
    if (entry.ref !== null) old.set(entry.ref, entry);
    else oldSummaries.set(entry.key, (oldSummaries.get(entry.key) ?? 0) + 1);
  }
  const now = new Set<string>();
  const added: Listed[] = [];
  const changed: [Listed, Listed][] = [];
  let unchanged = 0;
  for (const entry of after) {
    if (entry.ref === null) {
      const left = oldSummaries.get(entry.key) ?? 0;
      if (left > 0) oldSummaries.set(entry.key, left - 1);
      else added.push(entry);
      continue;
    }
    now.add(entry.ref);
    const was = old.get(entry.ref);
    if (was === undefined) added.push(entry);
    else if (was.key !== entry.key || indentOf(was) !== indentOf(entry)) changed.push([was, entry]);
    else unchanged += 1;
  }
  const removed: Listed[] = [];
  for (const entry of before) {
    if (entry.ref !== null) {
      if (!now.has(entry.ref)) removed.push(entry);
      continue;
    }
    const left = oldSummaries.get(entry.key) ?? 0;
    if (left > 0) {
      removed.push(entry);
      oldSummaries.set(entry.key, left - 1);
    }
  }
  return { added, changed, removed, unchanged };
}

function shownTitle(title: string): string {
  const flat = title.replace(/\s+/gu, " ").trim();
  if (!flat) return "this page";
  return quoted(pyLen(flat) <= SHOWN_TITLE ? flat : `${pyRstrip(headPoints(flat, SHOWN_TITLE - 1))}…`);
}

function ago(commands: number): string {
  if (commands <= 0) return "just now";
  return `${commands} command${commands === 1 ? "" : "s"} ago`;
}

function plain(entry: Listed): string {
  return entry.text.trimStart().slice(2);
}

function sameOrder(before: readonly Listed[], after: readonly Listed[]): boolean {
  const now = new Set(after.flatMap((entry) => (entry.ref === null ? [] : [entry.ref])));
  const was = new Set(before.flatMap((entry) => (entry.ref === null ? [] : [entry.ref])));
  const kept = before.flatMap((entry) => (entry.ref !== null && now.has(entry.ref) ? [entry.ref] : []));
  const still = after.flatMap((entry) => (entry.ref !== null && was.has(entry.ref) ? [entry.ref] : []));
  return kept.length === still.length && kept.every((ref, index) => ref === still[index]);
}

function indentOf(entry: Listed): number {
  return entry.text.length - entry.text.trimStart().length;
}

export function diffAgainst(before: ShownSnapshot, after: readonly Listed[], fullText: string, command: number, url: string): SnapshotDiff | null {
  const total = Math.max(refCount(before.listed), refCount(after));
  if (total === 0) return null;
  if (!sameOrder(before.listed, after)) return null;
  const changes = changesOf(before.listed, after);
  const count = changes.added.length + changes.changed.length + changes.removed.length;
  if (count > MAX_CHANGED_SHARE * total) return null;
  const since = `since your snapshot ${ago(command - before.command)} of ${shownTitle(before.title)}`;
  const valid = `${count === 0 ? "all " : ""}${changes.unchanged} ref${changes.unchanged === 1 ? "" : "s"} unchanged and still valid`;
  const lines = [`snapshot -i (${count === 0 ? "no changes" : "changes"} ${since}; ${valid}; \`snapshot -i --full\` lists everything)`];
  if (url !== before.url) lines.push(`url: ${maskedUrl(before.url)} → ${maskedUrl(url)}`);
  for (const entry of changes.added) lines.push(`+ ${plain(entry)}`);
  for (const [was, now] of changes.changed) lines.push(`~ ${plain(now)} (was: ${was.key})`);
  for (const entry of changes.removed) lines.push(`- ${plain(entry)}`);
  const text = lines.join("\n");
  if (pyLen(text) >= pyLen(fullText)) return null;
  return {
    text,
    data: {
      commandsAgo: Math.max(command - before.command, 0),
      unchanged: changes.unchanged,
      added: changes.added.map((entry) => entry.ref ?? plain(entry)),
      changed: changes.changed.map(([, now]) => now.ref),
      removed: changes.removed.map((entry) => entry.ref ?? plain(entry)),
    },
  };
}
