import type { Result } from "../daemon/render.ts";
import type { State } from "../state/state.ts";
import type { Ctx } from "./ctx.ts";
import { hooks } from "./index.ts";

export const PAGE_BY_PAGE_HINT =
  "→ tip: reading page after page? `ardia browse read <url> <url>…` reads many in one call (`read --links <pattern>` " +
  "takes every matching link on this page), and `ardia browse script` loops over pages that need clicks";
export const PAGE_BY_PAGE = 3;

const KEEPS_STREAK = new Set(["wait", "notes", "tab", "get", "is", "screenshot", "snapshot", "eval"]);

type Streak = { pages: number; arrived: boolean };

const hinted = new WeakMap<State, Set<string>>();
const streaks = new WeakMap<State, Streak>();

export function hintOnce(state: State, key: string, text: string): void {
  let seen = hinted.get(state);
  if (seen === undefined) {
    seen = new Set();
    hinted.set(state, seen);
  }
  if (seen.has(key)) return;
  seen.add(key);
  state.addNotice(text);
}

function positionals(argv: readonly string[]): string[] {
  return argv.filter((arg) => !arg.startsWith("-"));
}

export function readsPage(name: string, argv: readonly string[]): boolean {
  if (name === "get") return argv.length > 0 && (argv[0] === "text" || argv[0] === "html");
  return name === "read" && positionals(argv).length === 0;
}

function loadedNewDocument(result: Result): boolean {
  const data = result.data;
  if (data === null || typeof data !== "object") return false;
  const changes = (data as Record<string, unknown>)["changes"];
  if (changes === null || typeof changes !== "object") return false;
  return (changes as Record<string, unknown>)["document"] === "new";
}

export function noteReading(state: State, name: string, argv: readonly string[], result: Result): void {
  let streak = streaks.get(state);
  if (streak === undefined) {
    streak = { pages: 0, arrived: false };
    streaks.set(state, streak);
  }
  const arrives = (name === "open" || name === "back" || name === "forward") && (name !== "open" || positionals(argv).length > 0);
  if (arrives || loadedNewDocument(result)) {
    streak.arrived = true;
    return;
  }
  if (readsPage(name, argv)) {
    if (streak.arrived) {
      streak.pages += 1;
      streak.arrived = false;
      if (streak.pages >= PAGE_BY_PAGE) hintOnce(state, "page_by_page", PAGE_BY_PAGE_HINT);
    }
    return;
  }
  if (!KEEPS_STREAK.has(name)) {
    streak.pages = 0;
    streak.arrived = false;
  }
}

hooks.after = (ctx: Ctx, name: string, argv: string[], result: Result) => noteReading(ctx.state, name, argv, result);
