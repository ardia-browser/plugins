import { dumps } from "../../json.ts";
import { strip, isSpace } from "../../py.ts";
import { pyValue, Result } from "../daemon/render.ts";
import { BrowseError, Gated, Usage } from "../daemon-errors.ts";
import { buildParams, encodedSize, MAX_CDP_PARAMS, ParamsError, wireParams } from "../cdp/params.ts";
import * as raw from "../cdp/raw.ts";
import { parseTimeout } from "../script/timeout.ts";
import type { Page } from "../state/page.ts";
import type { State } from "../state/state.ts";
import { borrowedTab } from "./borrowed.ts";
import type { Ctx } from "./ctx.ts";
import { register } from "./index.ts";
import { type Flags, need, parse } from "./parse.ts";
import { noteRawThrottle } from "../changes/throttle.ts";

export const CDP_METHOD = /^[A-Z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/u;
export const CDP_USAGE = "cdp <Domain.method> [--params <json>|-] [--param k=v | k:=json] [--target browser|<tab>] [--timeout 30s]";
export const CDP_FLAGS: Flags = { "--params": "value", "--param": "multi", "--target": "value", "--timeout": "value" };

export function cdpTarget(options: Record<string, unknown>): string | null {
  const target = options["target"];
  if (target === undefined || target === null) return null;
  if (strip(String(target), isSpace) === "") {
    throw new Usage("cdp --target is empty; name a tab (like t2) or browser, or leave --target out for this session's tab");
  }
  return String(target);
}

export function cdpParams(given: string | null | undefined, pairs: readonly string[], stdin: string | null): ReturnType<typeof buildParams> & object {
  let params;
  try {
    params = buildParams(given, pairs, stdin ?? "") ?? new Map();
  } catch (error) {
    if (error instanceof ParamsError) throw new Usage(error.message.replaceAll("-p ", "--param "));
    throw error;
  }
  if (encodedSize(params) > MAX_CDP_PARAMS) throw new Usage("--params is over 1 MB once encoded");
  return params;
}

function refuseRawOnBorrowed(ctx: Ctx, page: Page, method: string): void {
  const borrowed = borrowedTab(ctx.state);
  if (borrowed && borrowed === page.targetId) {
    const tab = ctx.state.tabId(borrowed);
    throw new BrowseError(
      `This session is using your tab [${tab}] (picked with \`tab active\`), so it won't send raw DevTools calls to it ` +
        `unless you name it. To send this one there anyway: \`ardia browse cdp ${method} --target ${tab}\`; to browse on ` +
        "your own, use `ardia browse open <url>`",
      { tabId: tab },
      "borrowed_tab",
    );
  }
}

function liveWhile(state: State, targetId: string): () => boolean {
  const session = raw.rawSessionOf(state, targetId);
  return () => session !== null && raw.rawSessionOf(state, targetId) === session;
}

export async function cmdCdp(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, CDP_FLAGS);
  need(args, 1, CDP_USAGE);
  if (args.length > 1) throw new Usage(`Usage: ardia browse ${CDP_USAGE} (params go in --params or --param)`);
  const method = args[0] as string;
  if (!CDP_METHOD.test(method)) throw new Usage(`${method} isn't a DevTools method name; give Domain.method, like Page.getLayoutMetrics`);
  const params = wireParams(cdpParams(options["params"] as string | undefined, (options["param"] as string[] | undefined) ?? [], ctx.stdin));
  const timeout = options["timeout"] ? parseTimeout(options["timeout"] as string) : 30;
  const target = cdpTarget(options);
  const state = ctx.state;
  let result: Record<string, unknown>;
  let session: raw.RawStatus;
  let where: string;
  try {
    if (target === raw.BROWSER) {
      await state.connect();
      [result, session] = await raw.send(state, raw.BROWSER, method, params, timeout);
      where = raw.BROWSER;
    } else if (target) {
      await state.connect();
      await state.refreshTargets();
      const targetId = await state.findTab(target);
      [result, session] = await state.registry.holding(state.instance, targetId, () => raw.send(state, targetId, method, params, timeout));
      noteRawThrottle(state, targetId, method, params, liveWhile(state, targetId));
      where = state.tabId(targetId);
    } else {
      const page = await state.page();
      refuseRawOnBorrowed(ctx, page, method);
      [result, session] = await raw.send(state, page.targetId, method, params, timeout);
      noteRawThrottle(state, page.targetId, method, params, liveWhile(state, page.targetId));
      where = state.tabId(page.targetId);
    }
  } catch (error) {
    if (error instanceof Gated) throw error.during("cdp");
    throw error;
  }
  const filled = Object.keys(result).length > 0;
  const text = filled ? dumps(pyValue(result), "indented") : `✓ ${method}`;
  const answer = new Result({ method, target: where, session, result }, text, filled);
  answer.whole = true;
  return answer;
}

register("cdp", cmdCdp);
