import type { CdpResult } from "../cdp/browser.ts";
import { frameOffset, localRoot, mapLocalPoint, type Offset } from "./offsets.ts";
import type { Page, SendOptions } from "./page.ts";

export { frameOffset, mapLocalPoint };

export function sessionOfFrame(page: Page, frameId: string | null): string | null {
  return page.sessionFor(frameId);
}

export async function sendIn(page: Page, frameId: string | null, method: string, params: CdpResult | null = null, options: SendOptions = {}): Promise<CdpResult> {
  return page.send(method, params, { ...options, session: page.sessionFor(frameId) });
}

export async function localRootOffset(page: Page, frameId: string): Promise<Offset> {
  const root = localRoot(page, frameId);
  return root === null || root === page.mainFrame ? [0, 0] : frameOffset(page, root);
}
