import type { Ctx } from "../commands/ctx.ts";
import { BrowseError } from "../daemon-errors.ts";
import { appCall, appTabMap, ControlRefused } from "../state/apptabs.ts";
import type { Page } from "../state/page.ts";
import { record } from "../state/records.ts";

export const SOCKET_LINE_LIMIT = 900 * 1024;
export const INSPECTION_MISSING = /inspection session/iu;
const SOCKET_MARGIN = 10;

export function inspectionUnavailable(error: unknown): boolean {
  if (!(error instanceof ControlRefused)) return false;
  if (["unknown_method", "not_connected", "unreachable", "unsafe"].includes(error.code)) return true;
  return error.code === "failed" && INSPECTION_MISSING.test(error.message);
}

export function refusedBy(method: string, error: ControlRefused, code = "rejected"): BrowseError {
  if (error.code === "timeout") return new BrowseError(`Ardia didn't answer ${method} in time`, { method }, "timeout");
  return new BrowseError(`Ardia refused ${method}: ${error.message}`, { method, socketCode: error.code }, error.code === "refused" ? code : "rejected");
}

export async function appTabFor(ctx: Ctx, page: Page): Promise<string | null> {
  const known = ctx.state.appTabOf(page.targetId);
  if (known) return known;
  try {
    return (await appTabMap(ctx.state)).get(page.targetId) ?? null;
  } catch (error) {
    if (error instanceof ControlRefused) return null;
    throw error;
  }
}

export async function freshAppTab(ctx: Ctx, page: Page): Promise<string | null> {
  try {
    return (await appTabMap(ctx.state)).get(page.targetId) ?? null;
  } catch (error) {
    if (error instanceof ControlRefused) return null;
    throw error;
  }
}

export function fitsOnLine(params: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(params)) <= SOCKET_LINE_LIMIT;
}

export async function askArdia(ctx: Ctx, method: string, params: Record<string, unknown>, seconds: number, refusalCode = "rejected"): Promise<Record<string, unknown> | null> {
  if (!fitsOnLine(params)) return null;
  try {
    return record(await appCall(ctx.state, method, params, seconds + SOCKET_MARGIN));
  } catch (error) {
    if (inspectionUnavailable(error)) return null;
    if (error instanceof ControlRefused) throw refusedBy(method, error, refusalCode);
    throw error;
  }
}

export async function askArdiaAboutTab(ctx: Ctx, page: Page, method: string, params: Record<string, unknown>, seconds: number, refusalCode = "rejected"): Promise<Record<string, unknown> | null> {
  const tab = await appTabFor(ctx, page);
  if (tab === null) return null;
  return askArdia(ctx, method, { tab, ...params }, seconds, refusalCode);
}
