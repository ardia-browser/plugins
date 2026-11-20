import type { CdpResult } from "../cdp/browser.ts";
import { BrowseError } from "../daemon-errors.ts";
import type { Page, SendOptions } from "./page.ts";

type Oopif = { root: string; parentSession: string };
type FrameMaps = { frameSessions?: Map<string, string>; oopifs?: Map<string, Oopif> };

function maps(page: Page): FrameMaps {
  return page as unknown as FrameMaps;
}

export function sessionOfFrame(page: Page, frameId: string | null): string | null {
  if (frameId === null) return page.session;
  return maps(page).frameSessions?.get(frameId) ?? page.session;
}

export function inOwnSession(page: Page, frameId: string | null): boolean {
  return sessionOfFrame(page, frameId) !== page.session;
}

export const UNROUTED =
  "this frame lives in its own CDP session (an out-of-process iframe), and this build of the daemon can't send to a frame's own session yet";

function topOnly(page: Page, session: string | null): void {
  if (session !== page.session) throw new BrowseError(UNROUTED, null, "internal_error");
}

export async function sendIn(page: Page, frameId: string | null, method: string, params: CdpResult | null = null, options: SendOptions = {}): Promise<CdpResult> {
  topOnly(page, sessionOfFrame(page, frameId));
  return page.send(method, params, options);
}

async function ownerCorner(page: Page, session: string | null, frameId: string): Promise<[number, number]> {
  topOnly(page, session);
  const owner = await page.send("DOM.getFrameOwner", { frameId });
  const found = await page.send("DOM.getContentQuads", { backendNodeId: owner["backendNodeId"] });
  const quads = Array.isArray(found["quads"]) ? (found["quads"] as number[][]) : [];
  const quad = quads[0];
  if (quad === undefined) return [0, 0];
  return [Math.min(...quad.filter((_, index) => index % 2 === 0)), Math.min(...quad.filter((_, index) => index % 2 === 1))];
}

export async function localRootOffset(page: Page, frameId: string): Promise<[number, number]> {
  const session = sessionOfFrame(page, frameId);
  const host = session === page.session ? undefined : maps(page).oopifs?.get(session as string);
  return host === undefined ? [0, 0] : frameOffset(page, host.root);
}

export async function frameOffset(page: Page, frameId: string): Promise<[number, number]> {
  if (frameId === page.mainFrame) return [0, 0];
  const oopifs = maps(page).oopifs;
  let session = sessionOfFrame(page, frameId);
  let frame = frameId;
  let x = 0;
  let y = 0;
  for (let hops = 0; hops < 32; hops += 1) {
    const host = session === page.session ? undefined : oopifs?.get(session as string);
    if (host === undefined) {
      if (frame === page.mainFrame) return [x, y];
      const [dx, dy] = await ownerCorner(page, session, frame);
      return [x + dx, y + dy];
    }
    if (frame !== host.root) {
      const [dx, dy] = await ownerCorner(page, session, frame);
      x += dx;
      y += dy;
    }
    const [dx, dy] = await ownerCorner(page, host.parentSession, host.root);
    x += dx;
    y += dy;
    session = host.parentSession;
    const parent = page.frames.get(host.root)?.parent ?? null;
    if (parent === null || parent === page.mainFrame) return [x, y];
    frame = parent;
  }
  return [x, y];
}
