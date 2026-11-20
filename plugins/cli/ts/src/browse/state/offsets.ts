import type { Page } from "./page.ts";

export type Offset = [number, number];

export function localRoot(page: Page, frame: string): string | null {
  const session = page.frameSessions.get(frame);
  if (session === undefined) return page.mainFrame;
  return page.oopifs.get(session)?.root ?? null;
}

export async function ownerOffset(page: Page, frame: string, session: string | null): Promise<Offset> {
  const owner = await page.send("DOM.getFrameOwner", { frameId: frame }, { session });
  const quads = (await page.send("DOM.getContentQuads", { backendNodeId: owner["backendNodeId"] }, { session }))["quads"];
  const quad = Array.isArray(quads) && Array.isArray(quads[0]) ? (quads[0] as number[]) : null;
  if (quad === null) return [0, 0];
  return [Math.min(...quad.filter((_, index) => index % 2 === 0)), Math.min(...quad.filter((_, index) => index % 2 === 1))];
}

export async function frameOffset(page: Page, frame: string): Promise<Offset> {
  let x = 0;
  let y = 0;
  let here: string | null | undefined = frame;
  while (here && here !== page.mainFrame) {
    const session = page.sessionFor(here);
    const root = localRoot(page, here);
    let dx: number;
    let dy: number;
    if (root !== here) {
      [dx, dy] = await ownerOffset(page, here, session);
      here = root;
    } else {
      const parentSession = page.oopifs.get(session as string)?.parentSession ?? page.session;
      [dx, dy] = await ownerOffset(page, here, parentSession);
      here = page.frames.get(here)?.parent;
    }
    x += dx;
    y += dy;
  }
  return [x, y];
}
