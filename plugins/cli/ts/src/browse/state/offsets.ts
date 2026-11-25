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

async function ownerContentQuad(page: Page, frame: string, session: string | null): Promise<number[] | null> {
  const owner = await page.send("DOM.getFrameOwner", { frameId: frame }, { session });
  const backendNodeId = owner["backendNodeId"];
  try {
    const model = (await page.send("DOM.getBoxModel", { backendNodeId }, { session }))["model"] as Record<string, unknown> | undefined;
    const content = model?.["content"];
    if (Array.isArray(content) && content.length >= 8) return content as number[];
  } catch {}
  const quads = (await page.send("DOM.getContentQuads", { backendNodeId }, { session }))["quads"];
  return Array.isArray(quads) && Array.isArray(quads[0]) && (quads[0] as unknown[]).length >= 8 ? (quads[0] as number[]) : null;
}

export async function mapLocalPoint(page: Page, frame: string, x: number, y: number): Promise<Offset> {
  let px = x;
  let py = y;
  let here: string | null | undefined = frame;
  while (here && here !== page.mainFrame) {
    const parent: string | null = page.frames.get(here)?.parent ?? null;
    const session = page.sessionFor(here);
    const root = localRoot(page, here);
    const parentSession = root === here ? (page.oopifs.get(session as string)?.parentSession ?? page.session) : page.sessionFor(parent);
    const quad = await ownerContentQuad(page, here, parentSession);
    if (quad !== null) {
      let dims: unknown = null;
      try {
        dims = await page.call("() => [innerWidth, innerHeight]", [], { frame: here, read: true });
      } catch {}
      const w = Array.isArray(dims) ? Number(dims[0]) : 0;
      const h = Array.isArray(dims) ? Number(dims[1]) : 0;
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        const u = px / w;
        const v = py / h;
        const q = quad as [number, number, number, number, number, number, number, number];
        px = q[0] + u * (q[2] - q[0]) + v * (q[6] - q[0]);
        py = q[1] + u * (q[3] - q[1]) + v * (q[7] - q[1]);
      } else {
        px += Math.min(quad[0] as number, quad[2] as number, quad[4] as number, quad[6] as number);
        py += Math.min(quad[1] as number, quad[3] as number, quad[5] as number, quad[7] as number);
      }
    }
    here = parent ? localRoot(page, parent) : null;
  }
  return [px, py];
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
