import { CdpError, Gated } from "../daemon-errors.ts";
import { flag } from "../metrics.ts";
import type { Page } from "../state/page.ts";
import { record } from "../state/records.ts";

export const SNAPSHOT_FROM = 16;

export const FRESH_KEYS = `(limit) => {
  const fresh = (globalThis.ardiaBrowseFresh || []).slice(0, limit);
  const all = document.getElementsByTagName("*");
  const order = new Map();
  let index = 0;
  for (const el of all) order.set(el, index++);
  if (globalThis.ardiaBrowseOrderWatch) globalThis.ardiaBrowseOrderWatch.disconnect();
  const watch = new MutationObserver(() => {
    watch.moved = true;
  });
  watch.moved = false;
  watch.observe(document, { childList: true, subtree: true });
  globalThis.ardiaBrowseOrderWatch = watch;
  setTimeout(() => {
    watch.disconnect();
    if (globalThis.ardiaBrowseOrderWatch === watch) globalThis.ardiaBrowseOrderWatch = null;
  }, 5000);
  return { count: all.length, keys: fresh.map((el) => [el && order.has(el) ? order.get(el) : -1, el ? el.nodeName : "", el && el.id ? el.id : ""]) };
}`;

export const KEEP_BY_INDEX = `(ids, indexes, count) => {
  const fresh = globalThis.ardiaBrowseFresh || [];
  const watch = globalThis.ardiaBrowseOrderWatch;
  globalThis.ardiaBrowseOrderWatch = null;
  if (!watch) return false;
  const moved = watch.takeRecords().length > 0 || watch.moved;
  watch.disconnect();
  if (moved) return false;
  const all = document.getElementsByTagName("*");
  if (all.length !== count || ids.length > fresh.length) return false;
  const order = new Map();
  let index = 0;
  for (const el of all) order.set(el, index++);
  if (ids.some((id, at) => !fresh[at] || order.get(fresh[at]) !== indexes[at])) return false;
  ids.forEach((id, at) => globalThis.ardiaBrowseBackends.set(fresh[at], id));
  globalThis.ardiaBrowseFresh = null;
  return true;
}`;

const refused = new WeakMap<object, true>();

export function snapshotRefused(page: Page): boolean {
  return refused.has(page.state);
}

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.map((item) => (typeof item === "number" ? item : -1)) : [];
}

function rare(value: unknown): Set<number> {
  return new Set(numbers(record(value)["index"]));
}

type Light = { backend: number; name: string; id: string };

function lightElements(snapshot: Record<string, unknown>, frame: string): Light[] | null {
  const strings = Array.isArray(snapshot["strings"]) ? (snapshot["strings"] as unknown[]).map(String) : [];
  const documents = Array.isArray(snapshot["documents"]) ? (snapshot["documents"] as unknown[]).map(record) : [];
  const document = documents.find((entry) => strings[Number(entry["frameId"])] === frame);
  if (document === undefined) return null;
  const nodes = record(document["nodes"]);
  const parents = numbers(nodes["parentIndex"]);
  const types = numbers(nodes["nodeType"]);
  const names = numbers(nodes["nodeName"]);
  const backends = numbers(nodes["backendNodeId"]);
  const attributes = Array.isArray(nodes["attributes"]) ? (nodes["attributes"] as unknown[]) : [];
  const pseudo = rare(nodes["pseudoType"]);
  const outside = new Array<boolean>(types.length).fill(false);
  const light: Light[] = [];
  for (let index = 0; index < types.length; index += 1) {
    const parent = parents[index] ?? -1;
    outside[index] = (parent >= 0 && Boolean(outside[parent])) || types[index] === 11 || pseudo.has(index);
    if (outside[index] || types[index] !== 1) continue;
    const pairs = numbers(attributes[index]);
    let id = "";
    for (let at = 0; at + 1 < pairs.length; at += 2) if (strings[pairs[at] as number] === "id") id = strings[pairs[at + 1] as number] ?? "";
    light.push({ backend: backends[index] ?? 0, name: strings[names[index] as number] ?? "", id });
  }
  return light;
}

const DROP_WATCH = "() => { const watch = globalThis.ardiaBrowseOrderWatch; globalThis.ardiaBrowseOrderWatch = null; if (watch) watch.disconnect(); return true; }";

export async function snapshotBackends(page: Page, frame: string, limit: number): Promise<number[] | null> {
  if (refused.has(page.state)) return null;
  const found = record(await page.call(FRESH_KEYS, [limit], { frame, read: true }));
  let kept = false;
  try {
    const ids = await mapped(page, frame, found);
    if (ids === null) return null;
    const indexes = (found["keys"] as unknown[]).map((key) => (Array.isArray(key) ? key[0] : -1));
    kept = Boolean(await page.call(KEEP_BY_INDEX, [ids, indexes, Number(found["count"])], { frame, read: true }));
    if (!kept) return null;
    flag("dom_snapshot_used", true);
    return ids;
  } finally {
    if (!kept) await page.call(DROP_WATCH, [], { frame, read: true }).catch(() => {});
  }
}

async function mapped(page: Page, frame: string, found: Record<string, unknown>): Promise<number[] | null> {
  const keys = found["keys"];
  const count = Number(found["count"]);
  let snapshot: Record<string, unknown>;
  try {
    snapshot = await page.send("DOMSnapshot.captureSnapshot", { computedStyles: [] }, { session: page.sessionFor(frame) });
  } catch (error) {
    if (!(error instanceof Gated) && !(error instanceof CdpError)) throw error;
    refused.set(page.state, true);
    flag("dom_snapshot_refused", true);
    return null;
  }
  const light = lightElements(snapshot, frame);
  if (light === null || !Array.isArray(keys) || light.length !== count) return null;
  const ids = keys.map((key) => {
    const [index, name, id] = Array.isArray(key) ? key : [-1, "", ""];
    const match = typeof index === "number" && index >= 0 ? light[index] : undefined;
    return match !== undefined && match.name === name && match.id === id && match.backend > 0 ? match.backend : 0;
  });
  return ids.length === 0 || ids.some((id) => id === 0) ? null : ids;
}
