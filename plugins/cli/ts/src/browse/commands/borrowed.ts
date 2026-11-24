import { BrowseError } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import { flag } from "../metrics.ts";
import type { Page } from "../state/page.ts";
import type { State } from "../state/state.ts";
import type { Ctx, Handler } from "./ctx.ts";

export function borrowedTab(state: State): string | null {
  const attached = state.attached;
  return state.current && state.current === attached ? attached : null;
}

export function refuseOnBorrowed(ctx: Ctx, page: Page, what: string): void {
  const borrowed = borrowedTab(ctx.state);
  if (borrowed && borrowed === page.targetId) {
    const tab = ctx.state.tabId(borrowed);
    throw new BrowseError(
      `This session is using your tab [${tab}] (picked with \`tab active\`), so it won't ${what} it. To drive that tab anyway, ` +
        `pick it with \`ardia browse tab ${tab}\`; to browse on your own, use \`ardia browse open <url>\``,
      { tabId: tab },
      "borrowed_tab",
    );
  }
}

const HINTED = new WeakMap<State, Set<string>>();

export function hintOnce(state: State, key: string, text: string): void {
  let hinted = HINTED.get(state);
  if (hinted === undefined) {
    hinted = new Set();
    HINTED.set(state, hinted);
  }
  if (hinted.has(key)) return;
  hinted.add(key);
  state.addNotice(text);
}

export type History = { index: number; entries: unknown[] };
type Trail = { index: number; entry: unknown; ahead: number };

const TRAILS = new WeakMap<State, Map<string, Trail>>();

function trailsOf(state: State): Map<string, Trail> {
  let trails = TRAILS.get(state);
  if (trails === undefined) {
    trails = new Map();
    TRAILS.set(state, trails);
  }
  return trails;
}

function field(entry: unknown, key: string): unknown {
  return entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>)[key] : undefined;
}

export function borrowedDepth(state: State, target: string): number {
  return state.borrowedNavDepth.get(target) ?? 0;
}

export function borrowedAhead(state: State, target: string): number {
  return trailsOf(state).get(target)?.ahead ?? 0;
}

export function forgetBorrowedNav(state: State, target: string): void {
  state.borrowedNavDepth.delete(target);
  trailsOf(state).delete(target);
}

export function historyFrom(raw: Record<string, unknown>): History {
  return { index: typeof raw["currentIndex"] === "number" ? raw["currentIndex"] : 0, entries: Array.isArray(raw["entries"]) ? raw["entries"] : [] };
}

export function pushedEntries(history: History, fromUrl: string, most: number): number {
  const limit = Math.max(1, most);
  for (let back = 1; back <= limit && history.index - back >= 0; back += 1) {
    if (field(history.entries[history.index - back], "url") === fromUrl) return back;
  }
  return 0;
}

export function recordBorrowedNav(state: State, target: string, history: History, fromUrl: string, documents: number): number {
  const trails = trailsOf(state);
  const trail = trails.get(target);
  const depth = borrowedDepth(state, target);
  const entry = field(history.entries[history.index], "id");
  const pushed = pushedEntries(history, fromUrl, documents);
  if (pushed > 0) {
    const continued = trail !== undefined && depth > 0 && trail.index + pushed === history.index ? depth : 0;
    state.borrowedNavDepth.set(target, continued + pushed);
    trails.set(target, { index: history.index, entry, ahead: 0 });
    flag("borrowed_nav_tracked", true);
    return pushed;
  }
  if (depth > 0 && trail !== undefined && trail.index === history.index) {
    trails.set(target, { index: history.index, entry, ahead: 0 });
    return 0;
  }
  forgetBorrowedNav(state, target);
  return 0;
}

export function borrowedStepAllowed(state: State, target: string, step: number, history: History): boolean {
  const trail = trailsOf(state).get(target);
  if (trail === undefined) return false;
  const here = field(history.entries[history.index], "id");
  if (trail.index !== history.index || trail.entry !== here) {
    forgetBorrowedNav(state, target);
    return false;
  }
  return step < 0 ? borrowedDepth(state, target) > 0 : trail.ahead > 0;
}

export function noteBorrowedStep(state: State, target: string, step: number, history: History): void {
  const trails = trailsOf(state);
  const trail = trails.get(target);
  if (trail === undefined) return;
  const index = history.index + step;
  state.borrowedNavDepth.set(target, borrowedDepth(state, target) + step);
  trails.set(target, { index, entry: field(history.entries[index], "id"), ahead: trail.ahead - step });
  flag(step < 0 ? "borrowed_back_allowed" : "borrowed_forward_allowed", true);
}

async function historyOf(page: Page): Promise<History | null> {
  try {
    return historyFrom(await page.send("Page.getNavigationHistory"));
  } catch (error) {
    if (error instanceof BrowseError) return null;
    throw error;
  }
}

export async function trackBorrowedNav<T>(state: State, target: string | null, run: () => Promise<T>): Promise<T> {
  const page = target === null ? undefined : state.pages.get(target);
  if (page === undefined || target === null) return run();
  const navigations = page.navigations;
  const fromUrl = page.url;
  const result = await run().catch(async (error: unknown) => {
    await settleBorrowedNav(state, target, page, navigations, fromUrl);
    throw error;
  });
  await settleBorrowedNav(state, target, page, navigations, fromUrl);
  return result;
}

async function settleBorrowedNav(state: State, target: string, page: Page, navigations: number, fromUrl: string): Promise<void> {
  if (page.navigations === navigations && page.url === fromUrl) return;
  if (borrowedTab(state) !== target || state.pages.get(target) !== page) return;
  let history: History | null = null;
  try {
    history = await historyOf(page);
  } catch {
    return;
  }
  if (history === null) return;
  recordBorrowedNav(state, target, history, fromUrl, page.navigations - navigations);
}

export function tracksBorrowedNav(handler: Handler, targetOf: (state: State, argv: readonly string[]) => string | null = (state) => borrowedTab(state)): Handler {
  return async (ctx: Ctx, argv: string[]): Promise<Result> => trackBorrowedNav(ctx.state, ctx.state ? targetOf(ctx.state, argv) : null, () => handler(ctx, argv));
}

export function openTarget(state: State, argv: readonly string[]): string | null {
  return argv.includes("--here") ? state.attached : borrowedTab(state);
}
