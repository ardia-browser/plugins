import { roundHalfEven } from "../../pylib/format.ts";
import { flag } from "../metrics.ts";
import { type Page, quiet } from "../state/page.ts";
import { frameOffset, localRoot } from "../state/offsets.ts";
import { record } from "../state/records.ts";
import type { Ref } from "../state/refs.ts";
import { capturePng } from "./commands.ts";

export const PAIR_TRIES = 2;
export const WATCH_START = `() => {
  if (globalThis.ardiaPairWatch) globalThis.ardiaPairWatch.disconnect();
  const watch = new MutationObserver(() => { watch.changed = true; });
  watch.changed = false;
  watch.observe(document, { childList: true, subtree: true, characterData: true });
  globalThis.ardiaPairWatch = watch;
  return true;
}`;
export const WATCH_END = `() => {
  const watch = globalThis.ardiaPairWatch;
  globalThis.ardiaPairWatch = null;
  if (!watch) return false;
  const changed = watch.takeRecords().length > 0 || watch.changed;
  watch.disconnect();
  return !changed;
}`;

export type Box = { x: number; y: number; width: number; height: number };
export type Boxed = { ref: string; role: string; name?: string } & Box;
export type Paired<T> = { taken: T; png: Uint8Array; boxes: Boxed[]; width: number; height: number; scale: number; stable: boolean; tries: number };

export function pngSize(png: Uint8Array): [number, number] {
  if (png.length < 24) return [0, 0];
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

export function boxOfQuad(quad: readonly number[], offset: readonly [number, number], scale: number): Box {
  const xs = quad.filter((_, index) => index % 2 === 0).map((value) => (value + offset[0]) * scale);
  const ys = quad.filter((_, index) => index % 2 === 1).map((value) => (value + offset[1]) * scale);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: roundHalfEven(left), y: roundHalfEven(top), width: roundHalfEven(Math.max(...xs) - left), height: roundHalfEven(Math.max(...ys) - top) };
}

export function clipToImage(box: Box, width: number, height: number): Box | null {
  const left = Math.max(box.x, 0);
  const top = Math.max(box.y, 0);
  const right = Math.min(box.x + box.width, width);
  const bottom = Math.min(box.y + box.height, height);
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

async function offsetOf(page: Page, frame: string, cache: Map<string, Promise<[number, number]>>): Promise<[number, number]> {
  if (!page.frameSessions.has(frame)) return [0, 0];
  const root = localRoot(page, frame) ?? frame;
  let known = cache.get(root);
  if (known === undefined) {
    known = frameOffset(page, root);
    cache.set(root, known);
  }
  return known;
}

export type CssBox = { ref: Ref; quad: number[]; offset: [number, number] };

export async function quadsOf(page: Page, refs: readonly Ref[]): Promise<CssBox[]> {
  const offsets = new Map<string, Promise<[number, number]>>();
  const found = await Promise.all(
    refs.map(async (ref): Promise<CssBox | null> => {
      try {
        const quads = (await page.send("DOM.getContentQuads", { backendNodeId: ref.backend }, { session: page.sessionFor(ref.frame) }))["quads"];
        if (!Array.isArray(quads) || !Array.isArray(quads[0])) return null;
        return { ref, quad: (quads[0] as unknown[]).map(Number), offset: await offsetOf(page, ref.frame, offsets) };
      } catch (error) {
        if (quiet(error)) return null;
        throw error;
      }
    }),
  );
  return found.filter((box): box is CssBox => box !== null);
}

export function inImage(found: readonly CssBox[], scale: number, width: number, height: number): Boxed[] {
  const out: Boxed[] = [];
  for (const { ref, quad, offset } of found) {
    const box = clipToImage(boxOfQuad(quad, offset, scale), width, height);
    if (box !== null) out.push({ ref: ref.id, role: ref.role, ...(ref.name ? { name: ref.name } : {}), ...box });
  }
  return out;
}

async function watched(page: Page, fn: string): Promise<boolean> {
  try {
    return Boolean(await page.call(fn, [], { frame: page.mainFrame, read: true }));
  } catch (error) {
    if (quiet(error)) return false;
    throw error;
  }
}

export async function pairedCapture<T extends { refs: readonly Ref[] }>(page: Page, take: () => Promise<T>): Promise<Paired<T>> {
  let last: Paired<T> | null = null;
  for (let attempt = 1; attempt <= PAIR_TRIES; attempt += 1) {
    const loader = page.loader(page.mainFrame);
    await watched(page, WATCH_START);
    const taken = await take();
    const quads = await quadsOf(page, taken.refs);
    const metrics = await page.send("Page.getLayoutMetrics");
    const viewport = record(metrics["cssVisualViewport"]);
    const png = await capturePng(page, false);
    const stable = (await watched(page, WATCH_END)) && page.loader(page.mainFrame) === loader;
    const [width, height] = pngSize(png);
    const cssWidth = Number(viewport["clientWidth"]) || width;
    const scale = cssWidth > 0 && width > 0 ? width / cssWidth : 1;
    const boxes = inImage(quads, scale, width, height);
    last = { taken, png, boxes, width, height, scale, stable, tries: attempt };
    if (stable) break;
  }
  const done = last as Paired<T>;
  flag("snapshot_paired", true);
  if (!done.stable) flag("snapshot_paired_unstable", true);
  return done;
}

export function pairedData<T>(shown: string, paired: Paired<T>): Record<string, unknown> {
  return { path: shown, width: paired.width, height: paired.height, scale: paired.scale, stable: paired.stable, boxes: paired.boxes };
}

export type PairedForm = "full" | "short";

export function pairedLine<T>(shown: string, paired: Pick<Paired<T>, "width" | "height" | "boxes" | "stable">, form: PairedForm = "full"): string {
  const steady = paired.stable ? "" : "; the page kept changing, so the boxes may be off by what moved";
  const where = form === "full" ? ` to ${shown}` : "";
  return `✓ Screenshot saved${where} (${paired.width}×${paired.height} px, ${paired.boxes.length} ref box${paired.boxes.length === 1 ? "" : "es"} in image pixels${steady})`;
}

export function pairedChoice<T>(shown: string, limit: number, paired: Pick<Paired<T>, "width" | "height" | "boxes" | "stable">): { form: PairedForm | null; room: number } {
  if (limit <= 0) return { form: "full", room: 0 };
  for (const form of ["full", "short"] as const) {
    const room = [...pairedLine(shown, paired, form)].length + 1;
    if (room <= limit) return { form, room };
  }
  return { form: null, room: 0 };
}
