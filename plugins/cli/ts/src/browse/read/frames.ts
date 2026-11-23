import { BrowseError, ConnectionLost } from "../daemon-errors.ts";
import { flag } from "../metrics.ts";
import { noteNav } from "./pages.ts";
import type { Page } from "../state/page.ts";
import { quiet } from "../state/page.ts";
import { record } from "../state/records.ts";

export const MAX_FRAME_DEPTH = 3;
const OWNER_FACTS =
  "(el) => { const box = el.getBoundingClientRect(); const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim(); " +
  "return { width: box.width, height: box.height, title: norm(el.getAttribute('title') || el.getAttribute('name') || '') || 'frame', " +
  "id: el.id || '', className: typeof el.className === 'string' ? el.className : '', src: el.getAttribute('src') || '', " +
  "inContent: (() => { for (let n = el; n; n = n.assignedSlot || n.parentElement || n.getRootNode().host || n.ownerDocument.defaultView.frameElement || null) if (n.matches('main, article, [role~=main i], [role~=article i]')) return true; return false; })() }; }";
const NOT_CONTENT = /(^|[^a-z])(ads?|advert\w*|sponsored|doubleclick|googlesyndication|adservice|recaptcha|captcha)([^a-z]|$)|3rd party ad/iu;

function depthBelow(page: Page, frame: string, top: string): number | null {
  let depth = 0;
  for (let here: string | null | undefined = frame; here; here = page.frames.get(here)?.parent) {
    if (here === top) return depth;
    depth += 1;
  }
  return null;
}

async function ownerFacts(page: Page, root: string): Promise<Record<string, unknown> | null> {
  const session = page.oopifs.get(page.frameSessions.get(root) ?? "")?.parentSession;
  const parent = page.frames.get(root)?.parent;
  if (!session || !parent) return null;
  const owner = await page.send("DOM.getFrameOwner", { frameId: root }, { session });
  const element = await page.resolveBackend(Number(owner["backendNodeId"]), parent, "frame");
  if (element === null) return null;
  return record(await page.call(OWNER_FACTS, [element], { frame: parent, read: true }));
}

function inContentFrame(page: Page, root: string, frame: string, content: ReadonlySet<string>): boolean {
  for (let here = page.frames.get(root)?.parent; here && here !== frame; here = page.frames.get(here)?.parent) if (content.has(here)) return true;
  return false;
}

export async function oopifText(page: Page, frame: string, nav = false): Promise<string> {
  const blocks: string[] = [];
  const readable: { root: string; title: string; depth: number; inContent: boolean }[] = [];
  for (const oopif of page.oopifs.values()) {
    const root = oopif.root;
    const depth = depthBelow(page, root, frame);
    if (depth === null || depth === 0 || depth > MAX_FRAME_DEPTH || !page.frames.has(root)) continue;
    try {
      const facts = await ownerFacts(page, root);
      if (facts === null || Number(facts["width"]) < 120 || Number(facts["height"]) < 80) continue;
      const title = String(facts["title"]);
      if (NOT_CONTENT.test(`${title} ${facts["id"]} ${facts["className"]} ${facts["src"]}`)) continue;
      readable.push({ root, title, depth, inContent: facts["inContent"] === true });
    } catch (error) {
      if (!quiet(error)) throw error;
    }
  }
  const content = new Set<string>();
  for (const one of [...readable].sort((a, b) => a.depth - b.depth)) {
    if (one.inContent || inContentFrame(page, one.root, frame, content)) content.add(one.root);
  }
  for (const { root, title } of readable) {
    try {
      const read = record(await page.call("(nav) => ardiaBrowse.readPage(nav)", [nav || content.has(root)], { frame: root, read: true }));
      const text = String(read["text"] ?? "");
      if (!text.trim()) continue;
      noteNav(read);
      blocks.push(`[frame "${title}"]\n${text}\n[end of frame "${title}"]`);
    } catch (error) {
      if (!quiet(error)) throw error;
    }
  }
  if (blocks.length) flag("read_oopif_frames", true);
  return blocks.join("\n\n");
}
