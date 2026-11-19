import { BrowseError, CdpError } from "../daemon-errors.ts";
import { flag } from "../metrics.ts";
import type { Element, Page } from "./page.ts";
import { type Json, record } from "./records.ts";

export const MAX_ROOTS = 200;
const SEARCHED = new Set(["open", "closed"]);
const QUERY_ONE = "(s, ...roots) => { const found = roots.flatMap((root) => ardiaBrowse.queryAll(s, root)); return found.find((el) => ardiaBrowse.visible(el)) || found[0] || null; }";
const QUERY_ALL = "(s, ...roots) => roots.flatMap((root) => ardiaBrowse.queryAll(s, root))";
const COUNT_ALL = "(s, ...roots) => roots.flatMap((root) => ardiaBrowse.queryAll(s, root)).length";
const READ_ALL =
  "(s, ...roots) => { const found = roots.flatMap((root) => ardiaBrowse.queryAll(s, root)); return {matched: found.length, text: found.map((el) => ardiaBrowse.readable(el)).filter(Boolean).join('\\n\\n')}; }";

function hostDocument(node: Json, frame: string, top: boolean): Json | null {
  if (top) return node;
  const content = node["contentDocument"];
  if (node["frameId"] === frame && content && typeof content === "object") return record(content);
  for (const key of ["children", "shadowRoots"]) {
    const list = node[key];
    for (const child of Array.isArray(list) ? list : []) {
      const found = hostDocument(record(child), frame, false);
      if (found) return found;
    }
  }
  const inner = node["contentDocument"];
  return inner && typeof inner === "object" ? hostDocument(record(inner), frame, false) : null;
}

export function shadowBackends(document: Json): number[] {
  const out: number[] = [];
  const walk = (node: Json) => {
    const roots = node["shadowRoots"];
    for (const raw of Array.isArray(roots) ? roots : []) {
      const root = record(raw);
      if (SEARCHED.has(String(root["shadowRootType"])) && typeof root["backendNodeId"] === "number" && out.length < MAX_ROOTS) out.push(root["backendNodeId"]);
      walk(root);
    }
    const children = node["children"];
    for (const child of Array.isArray(children) ? children : []) walk(record(child));
  };
  walk(document);
  return out;
}

function topFrameOf(page: Page, frame: string): boolean {
  const session = page.frameSessions.get(frame);
  if (session === undefined) return frame === page.mainFrame;
  return page.oopifs.get(session)?.root === frame;
}

export async function shadowRoots(page: Page, frame: string): Promise<Element[]> {
  const session = page.sessionFor(frame);
  let root: Json;
  try {
    root = record((await page.send("DOM.getDocument", { depth: -1, pierce: true }, { session }))["root"]);
  } catch (error) {
    if (error instanceof CdpError) return [];
    throw error;
  }
  const document = hostDocument(root, frame, topFrameOf(page, frame));
  if (document === null) return [];
  const backends = shadowBackends(document);
  const roots: Element[] = [];
  for (const backend of backends) {
    const element = await page.resolveBackend(backend, frame, "shadow root");
    if (element !== null) roots.push(element);
  }
  return roots;
}

async function inRoots(page: Page, frame: string, fn: string, selector: string, byValue: boolean): Promise<[unknown, Element[]] | null> {
  const roots = await shadowRoots(page, frame);
  if (roots.length === 0) return null;
  try {
    return [await page.call(fn, [selector, ...roots], { frame, byValue, read: true }), roots];
  } catch (error) {
    if (error instanceof BrowseError && error.code === "page_script_error") return null;
    throw error;
  }
}

export async function queryOne(page: Page, frame: string, selector: string): Promise<Element | null> {
  const found = await inRoots(page, frame, QUERY_ONE, selector, false);
  if (found === null) return null;
  const element = await page.elementFrom(found[0], frame, selector);
  if (element !== null) flag("selector_in_shadow_root", true);
  return element;
}

export async function queryAll(page: Page, frame: string, selector: string, limit = 300): Promise<Element[]> {
  const found = await inRoots(page, frame, QUERY_ALL, selector, false);
  if (found === null) return [];
  const elements = await page.elementsFrom(found[0], frame, selector, limit);
  if (elements.length > 0) flag("selector_in_shadow_root", true);
  return elements;
}

export async function readAll(page: Page, frame: string, selector: string): Promise<{ matched: number; text: string } | null> {
  const found = await inRoots(page, frame, READ_ALL, selector, true);
  if (found === null) return null;
  const got = record(found[0]);
  const matched = Number(got["matched"]) || 0;
  if (matched === 0) return null;
  flag("selector_in_shadow_root", true);
  return { matched, text: typeof got["text"] === "string" ? got["text"] : "" };
}

export async function countAll(page: Page, frame: string, selector: string): Promise<number> {
  const found = await inRoots(page, frame, COUNT_ALL, selector, true);
  const count = found === null ? 0 : Number(found[0]) || 0;
  if (count > 0) flag("selector_in_shadow_root", true);
  return count;
}
