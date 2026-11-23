import { CDP_FLAGS, cdpTarget } from "../commands/cdp.ts";
import { notesTab } from "../commands/notes.ts";
import { parse } from "../commands/parse.ts";
import type { State } from "../state/state.ts";
import type { Keys } from "./scheduler.ts";

export const SESSION_LANE = "session";
export const BROWSER_TARGET = "browser";
export const EXCLUSIVE: ReadonlySet<string> = new Set([
  "close", "batch", "script", "flow", "auth", "open", "tab", "window", "state", "cookies", "set", "clipboard", "stream", "record", "trace", "profiler",
  "network", "plugin", "diff", "addinitscript", "removeinitscript", "frame", "highlight", "react", "vitals", "a11y", "upload", "download",
]);
const CLEAR_FLAGS = { "--clear": "bool" } as const;

export type TabLane = { kind: "tab"; primary: boolean; keys: Keys; bound: () => string | null };
export type Lane = { kind: "read" } | { kind: "exclusive" } | TabLane;

export function tabNamed(state: State, ref: string): string | null {
  const labelled = state.labels.get(ref);
  if (labelled !== undefined) return labelled;
  for (const [targetId, tab] of state.tabIds) if (tab === ref && state.targetInfos.has(targetId)) return targetId;
  return state.targetInfos.has(ref) ? ref : null;
}

function currentReadable(state: State): boolean {
  const current = state.current;
  if (state.lost || !state.connected || current === null || !state.targetInfos.has(current)) return false;
  const page = state.pages.get(current);
  return page !== undefined && page.runtimeOn && state.attachedFully(page);
}

export function primaryKeys(state: State): Keys {
  return () => (state.current === null ? [SESSION_LANE] : [SESSION_LANE, state.current]);
}

function primaryLane(state: State): TabLane {
  return { kind: "tab", primary: true, keys: primaryKeys(state), bound: () => null };
}

function explicitLane(state: State, ref: string): TabLane {
  let resolved: string | null = null;
  return {
    kind: "tab",
    primary: false,
    keys: () => {
      resolved = tabNamed(state, ref);
      if (resolved === null) return null;
      return resolved === state.current || state.current === null ? [SESSION_LANE, resolved] : [resolved];
    },
    bound: () => resolved,
  };
}

function parsedOrNull<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function readsWithoutClearing(words: readonly string[]): boolean {
  const parsed = parsedOrNull(() => parse(words, CLEAR_FLAGS));
  return parsed !== null && parsed[0]["clear"] !== true;
}

export function laneOf(name: string, words: readonly string[], state: State): Lane {
  if (name === "session" && words.length === 1 && words[0] === "info") return { kind: "read" };
  if ((name === "console" || name === "errors") && readsWithoutClearing(words) && currentReadable(state)) return { kind: "read" };
  if (EXCLUSIVE.has(name)) return { kind: "exclusive" };
  if (name === "click" && words.some((word) => word === "--new-tab" || word.startsWith("--new-tab="))) return { kind: "exclusive" };
  if (name === "cdp") {
    const target = parsedOrNull(() => cdpTarget(parse(words, CDP_FLAGS)[0]));
    if (target === null) return parsedOrNull(() => parse(words, CDP_FLAGS)) === null ? { kind: "exclusive" } : primaryLane(state);
    if (target === BROWSER_TARGET) return { kind: "exclusive" };
    return explicitLane(state, target);
  }
  if (name === "notes") {
    const tab = parsedOrNull(() => notesTab(words));
    if (tab === null) return { kind: "exclusive" };
    if (tab.tab !== null) return explicitLane(state, tab.tab);
  }
  return primaryLane(state);
}
