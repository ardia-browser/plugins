import { BrowseError, ConnectionLost } from "../daemon-errors.ts";
import { currentIdentity } from "./drift.ts";
import { add, flag } from "../metrics.ts";
import type { Element, Page } from "../state/page.ts";
import { asRecord } from "./common.ts";
import { OBSTRUCTION_KINDS } from "./precision-metrics.ts";

export type Obstruction = (typeof OBSTRUCTION_KINDS)[number];

export type Layer = { top: number; bottom: number; left: number; right: number };

export type BlockerFacts = {
  offscreen?: boolean;
  clipped?: boolean;
  frameOwner?: boolean;
  modal?: boolean;
  position?: string;
  layer?: Layer | null;
  width?: number;
  height?: number;
  found?: boolean;
  role?: string;
  name?: string;
};

export type Blocker = { kind: Obstruction; ref: string | null; role: string; name: string };

export const EDGE = 2;
export const HEADER_SHARE = 0.35;
export const BAND_WIDTH = 0.5;
export const OVERLAY_AREA = 0.5;

export const OBSTRUCTION_WORDS: Readonly<Record<Obstruction, string>> = {
  modal: "a modal dialog",
  fixed_header: "a fixed header or footer",
  iframe: "an embedded frame",
  clipped_scroll: "its scroll container, which clips it",
  overlay: "an overlay",
  offscreen: "nothing: it's off-screen",
  sibling: "another element on top of it",
};

export const BLOCKER_AT = `(el, x, y, pick, given) => {
  const doc = el.ownerDocument;
  const view = doc.defaultView || window;
  const width = view.innerWidth;
  const height = view.innerHeight;
  const up = (node) => node.assignedSlot || node.parentElement || (node.parentNode && node.parentNode.host) || null;
  const facts = { offscreen: !given && (x < 0 || y < 0 || x > width || y > height), clipped: false, frameOwner: false, modal: false, position: "static", layer: null, width, height, found: false, role: "", name: "" };
  for (let node = given ? null : up(el); node && node !== doc.documentElement && node !== doc.body; node = up(node)) {
    if (node.nodeType !== 1) continue;
    const style = view.getComputedStyle(node);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const box = node.getBoundingClientRect();
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) {
      facts.clipped = true;
      break;
    }
  }
  let hit = given || doc.elementFromPoint(x, y);
  while (!given && hit && hit.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (!hit) return pick ? null : facts;
  facts.found = true;
  facts.frameOwner = ["IFRAME", "FRAME", "EMBED", "OBJECT"].includes(hit.tagName);
  let modal = null;
  let pinned = null;
  let floating = null;
  for (let node = hit; node && node.nodeType === 1; node = up(node)) {
    const role = (node.getAttribute("role") || "").toLowerCase();
    if (!modal && ((node.tagName === "DIALOG" && node.open) || node.getAttribute("aria-modal") === "true" || role === "dialog" || role === "alertdialog")) modal = node;
    const position = view.getComputedStyle(node).position;
    if (!pinned && (position === "fixed" || position === "sticky")) pinned = node;
    if (!floating && position === "absolute") floating = node;
  }
  const layer = pinned || floating;
  facts.modal = !!modal;
  if (layer) {
    const box = layer.getBoundingClientRect();
    facts.position = view.getComputedStyle(layer).position;
    facts.layer = { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
  }
  const chosen = facts.frameOwner ? hit : modal || layer || hit;
  if (pick) return chosen;
  facts.role = (chosen.getAttribute("role") || chosen.tagName).toLowerCase();
  facts.name = (globalThis.ardiaBrowse ? ardiaBrowse.accessibleText(chosen) : chosen.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 60);
  return facts;
}`;

export function classify(facts: BlockerFacts): Obstruction {
  if (facts.offscreen || !facts.found) return "offscreen";
  if (facts.clipped) return "clipped_scroll";
  if (facts.frameOwner) return "iframe";
  if (facts.modal) return "modal";
  const layer = facts.layer ?? null;
  const width = facts.width ?? 0;
  const height = facts.height ?? 0;
  if (layer !== null && (facts.position === "fixed" || facts.position === "sticky")) {
    const tall = layer.bottom - layer.top;
    const wide = layer.right - layer.left;
    const atEdge = layer.top <= EDGE || layer.bottom >= height - EDGE;
    if (atEdge && tall <= height * HEADER_SHARE && wide >= width * BAND_WIDTH) return "fixed_header";
    return "overlay";
  }
  if (layer !== null && facts.position === "absolute") {
    const area = Math.max(0, layer.bottom - layer.top) * Math.max(0, layer.right - layer.left);
    if (width > 0 && height > 0 && area >= width * height * OVERLAY_AREA) return "overlay";
  }
  return "sibling";
}

export function blockerPhrase(blocker: Blocker): string {
  const named = blocker.name ? ` "${blocker.name}"` : "";
  const ref = blocker.ref ? `@${blocker.ref} ` : "";
  return `${OBSTRUCTION_WORDS[blocker.kind]} (${ref}${blocker.role}${named})`;
}

export function noteObstruction(kind: Obstruction): void {
  flag(`click_obstructed_${kind}`, true);
  add("obstruction_refusals");
}

export type CoverAt = { frame: string; backend: number };

async function refFor(page: Page, node: Element): Promise<string | null> {
  const known = page.state.knownRef(page, node.frame, node.backendId);
  if (known !== null) return known.id;
  const seen = await currentIdentity(page, node);
  if (seen === null || seen === "ignored" || !seen.role) return null;
  return page.state.addRef(page, node, seen.role, seen.name);
}

export async function findBlocker(page: Page, element: Element, x: number, y: number, at: CoverAt | null = null): Promise<Blocker | null> {
  let probe = element;
  if (at !== null) {
    const owner = await page.resolveBackend(at.backend, at.frame, "the element in the way");
    if (owner === null) return null;
    probe = owner;
  }
  const given = at !== null ? probe : null;
  let facts: BlockerFacts;
  try {
    facts = asRecord(await page.call(BLOCKER_AT, [probe, x, y, false, given], { frame: probe.frame, read: true })) as BlockerFacts;
  } catch (error) {
    if (error instanceof BrowseError) return null;
    throw error;
  }
  const kind = classify(facts);
  if (kind === "offscreen") return { kind, ref: null, role: "", name: "" };
  let ref: string | null = null;
  try {
    const remote = await page.call(BLOCKER_AT, [probe, x, y, true, given], { frame: probe.frame, byValue: false, read: true });
    const node = await page.elementFrom(remote, probe.frame, "the element in the way");
    if (node !== null && (node.backendId !== element.backendId || node.frame !== element.frame)) {
      ref = await refFor(page, node);
      if (ref !== null) flag("click_blocker_ref", true);
    }
  } catch (error) {
    if (!(error instanceof BrowseError) || error instanceof ConnectionLost) throw error;
  }
  return { kind, ref, role: facts.role ?? "", name: facts.name ?? "" };
}
