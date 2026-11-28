import { BrowseError, CdpError } from "../daemon-errors.ts";
import { flag } from "../metrics.ts";
import type { Element, Page } from "./page.ts";
import { type Json, record } from "./records.ts";

export const MAX_ROOTS = 200;
export const cadence = { locate: 5, read: 2 };
const SEARCHED = new Set(["open", "closed"]);
const FOUND = "(s, roots) => { const seen = new Set(); const out = []; for (const root of roots) for (const el of ardiaBrowse.queryAll(s, root)) if (!seen.has(el)) { seen.add(el); out.push(el); } return out; }";
const QUERY_ONE = `(s, ...roots) => { const found = (${FOUND})(s, roots); return found.find((el) => ardiaBrowse.visible(el)) || found[0] || null; }`;
const QUERY_ALL = `(s, ...roots) => (${FOUND})(s, roots)`;
const COUNT_ALL = `(s, ...roots) => (${FOUND})(s, roots).length`;
const TEXTS_ALL = `(s, ...roots) => (${FOUND})(s, roots).slice(0, 1000).map((el) => (el.innerText != null ? el.innerText : el.textContent || '').trim())`;
const READ_ALL = `(s, ...roots) => { const found = (${FOUND})(s, roots); return {matched: found.length, text: found.map((el) => ardiaBrowse.readable(el)).filter(Boolean).join('\\n\\n')}; }`;
const DOCUMENT = "() => document";

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

export async function shadowRoots(page: Page, frame: string): Promise<Element[]> {
  const remote = record(await page.call(DOCUMENT, [], { frame, byValue: false, read: true }));
  if (typeof remote["objectId"] !== "string") return [];
  let document: Json;
  try {
    document = record((await page.send("DOM.describeNode", { objectId: remote["objectId"], depth: -1, pierce: true }, { session: page.sessionFor(frame) }))["node"]);
  } catch (error) {
    if (error instanceof CdpError) return [];
    throw error;
  }
  const found = await Promise.all(shadowBackends(document).map((backend) => page.resolveBackend(backend, frame, "shadow root")));
  return found.filter((element): element is Element => element !== null);
}

async function inRoots(page: Page, frame: string, fn: string, selector: string, byValue: boolean): Promise<unknown> {
  const roots = await shadowRoots(page, frame);
  if (roots.length === 0) return null;
  try {
    return await page.call(fn, [selector, ...roots], { frame, byValue, read: true });
  } catch (error) {
    if (error instanceof BrowseError && error.code === "page_script_error") return null;
    throw error;
  }
}

export async function queryOne(page: Page, frame: string, selector: string): Promise<Element | null> {
  const found = await inRoots(page, frame, QUERY_ONE, selector, false);
  if (found === null) return null;
  const element = await page.elementFrom(found, frame, selector);
  if (element !== null) flag("selector_in_shadow_root", true);
  return element;
}

export async function queryAll(page: Page, frame: string, selector: string, limit = 300): Promise<Element[]> {
  const found = await inRoots(page, frame, QUERY_ALL, selector, false);
  if (found === null) return [];
  const elements = await page.elementsFrom(found, frame, selector, limit);
  if (elements.length > 0) flag("selector_in_shadow_root", true);
  return elements;
}

export async function countAll(page: Page, frame: string, selector: string): Promise<number> {
  const found = await inRoots(page, frame, COUNT_ALL, selector, true);
  const count = found === null ? 0 : Number(found) || 0;
  if (count > 0) flag("selector_in_shadow_root", true);
  return count;
}

export async function textsAll(page: Page, frame: string, selector: string): Promise<string[]> {
  const found = await inRoots(page, frame, TEXTS_ALL, selector, true);
  if (!Array.isArray(found) || found.length === 0) return [];
  flag("selector_in_shadow_root", true);
  return found.map((item) => String(item ?? ""));
}

export async function readAll(page: Page, frame: string, selector: string): Promise<{ matched: number; text: string } | null> {
  const found = await inRoots(page, frame, READ_ALL, selector, true);
  if (found === null) return null;
  const got = record(found);
  const matched = Number(got["matched"]) || 0;
  if (matched === 0) return null;
  flag("selector_in_shadow_root", true);
  return { matched, text: typeof got["text"] === "string" ? got["text"] : "" };
}

export const scripts = { QUERY_ALL, COUNT_ALL, READ_ALL, QUERY_ONE };
