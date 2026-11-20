import { BrowseError } from "../daemon-errors.ts";
import type { Page } from "../state/page.ts";
import type { State } from "../state/state.ts";
import type { Ctx } from "./ctx.ts";

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
