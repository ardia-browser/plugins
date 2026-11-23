import { DETACH_WAIT } from "../cdp/browser.ts";
import { shield } from "../cdp/cancel.ts";
import { BrowseError, ConnectionLost } from "../daemon-errors.ts";
import { flag } from "../metrics.ts";
import type { Frame, Page } from "./page.ts";
import { type Json, record } from "./records.ts";

export const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe" }, { exclude: true }] };
export const CHILD_SETUP_WAIT = 10;

export type Oopif = { root: string; parentSession: string };

function quiet(error: unknown): boolean {
  return error instanceof BrowseError && !(error instanceof ConnectionLost);
}

export async function autoAttach(page: Page, session: string | null): Promise<void> {
  try {
    await page.send("Target.setAutoAttach", AUTO_ATTACH, { session });
  } catch (error) {
    if (!quiet(error)) throw error;
    if (error instanceof BrowseError && (error.code === "tab_detached" || error.code === "tab_crashed")) throw error;
    flag("oopif_attach_refused", true);
  }
}

export function attached(page: Page, parentSession: string, params: Json): void {
  const child = params["sessionId"];
  const info = record(params["targetInfo"]);
  if (typeof child !== "string" || !child) return;
  if (info["type"] !== "iframe" || typeof info["targetId"] !== "string") {
    shield(() => page.send("Target.detachFromTarget", { sessionId: child }, { session: parentSession, timeout: DETACH_WAIT })).catch(() => {});
    return;
  }
  const frame = info["targetId"];
  page.oopifs.set(child, { root: frame, parentSession });
  page.frameSessions.set(frame, child);
  page.worlds.delete(frame);
  page.state.sessions.set(child, page);
  shield(() => page.send("Target.setAutoAttach", AUTO_ATTACH, { session: child, timeout: CHILD_SETUP_WAIT })).catch(() => {});
}

export function detached(page: Page, child: string): void {
  if (!page.oopifs.has(child)) return;
  page.oopifs.delete(child);
  if (page.state.sessions.get(child) === page) page.state.sessions.delete(child);
  for (const [frame, session] of [...page.frameSessions]) {
    if (session !== child) continue;
    page.frameSessions.delete(frame);
    page.frames.delete(frame);
    page.worlds.delete(frame);
  }
  for (const [nested, oopif] of [...page.oopifs]) if (oopif.parentSession === child) detached(page, nested);
}

export function forgetAll(page: Page): void {
  for (const child of page.oopifs.keys()) if (page.state.sessions.get(child) === page) page.state.sessions.delete(child);
  page.oopifs.clear();
  page.frameSessions.clear();
}

export function childEvent(page: Page, session: string, method: string, params: Json): void {
  if (method === "Target.attachedToTarget") attached(page, session, params);
  else if (method === "Target.detachedFromTarget" && typeof params["sessionId"] === "string") detached(page, params["sessionId"]);
}

export function rootOf(page: Page, frame: string): string | null {
  const session = page.frameSessions.get(frame);
  return session === undefined ? null : (page.oopifs.get(session)?.root ?? null);
}

export async function childFrames(page: Page, frames: Map<string, Frame>, frameOf: (raw: Json, parent: string | null) => Frame): Promise<Map<string, string>> {
  const kept = new Map<string, string>();
  for (const [session, oopif] of [...page.oopifs]) {
    let tree: Json;
    try {
      tree = record((await page.send("Page.getFrameTree", null, { session }))["frameTree"]);
    } catch (error) {
      if (!quiet(error)) throw error;
      if (error instanceof BrowseError && error.code === "tab_detached" && page.session === null) throw error;
      detached(page, session);
      continue;
    }
    const walk = (node: Json, parent: string | null) => {
      const raw = record(node["frame"]);
      const frame = frameOf(raw, parent);
      frames.set(frame.id, frame);
      kept.set(frame.id, session);
      const children = node["childFrames"];
      for (const child of Array.isArray(children) ? children : []) walk(record(child), frame.id);
    };
    const root = record(tree["frame"]);
    walk(tree, typeof root["parentId"] === "string" && root["parentId"] ? root["parentId"] : null);
    kept.set(oopif.root, session);
  }
  return kept;
}

export function useSessions(page: Page, kept: ReadonlyMap<string, string>): void {
  page.frameSessions.clear();
  for (const [frame, session] of kept) if (page.oopifs.has(session)) page.frameSessions.set(frame, session);
}
