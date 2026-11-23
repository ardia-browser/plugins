import { fixed } from "../../py.ts";
import { formatG } from "../../pylib/format.ts";
import { rng } from "../../pylib/random.ts";
import { shield, sleep } from "../cdp/cancel.ts";
import { BrowseError, CdpError, Gated } from "../daemon-errors.ts";
import { humanScroll } from "../input/mouse.ts";
import { inputOf } from "../input/input.ts";
import {
  ACTIONS_CENTER,
  ACTIONS_CLOSE_CONTROL,
  ACTIONS_DISABLED_STATE,
  ACTIONS_DOM_CLICK,
  ACTIONS_SCROLL_LOCK,
  ACTIONS_VISIBLE_CONTENT,
  ACTIONS_VISIBLE_LABEL,
} from "../js/index.ts";
import { flag } from "../metrics.ts";
import { localRootOffset, sendIn } from "../state/frames.ts";
import type { Element, Page } from "../state/page.ts";
import type { State } from "../state/state.ts";
import { monotonic } from "../state/wait.ts";
import { asRecord, type Counts, expectInput, mouseButton, poll, rect, viewport, type Viewport } from "./common.ts";

export const CLEANUP_TIMEOUT = 2.0;
export const LAYOUT_WAIT = 2.0;
export const SANE_VIEWPORT = { width: 1280, height: 800 };
export const ENABLE_WAIT = 1.5;
export const CLOSING_MODAL_WAIT = 0.5;
export const BOX_SETTLE_POLL = 0.05;
export const BOX_SETTLE_LIMIT = 1.0;
export const CONSENT_SETTLE = 0.5;
export const CONSENT_FADE = 0.8;
export const CONSENT_NAMES = /onetrust|consent|cookie|\bot-/iu;
export const MENU_NAMES = /^<?(ul|li)\b|menu|dropdown|listbox|popover|submenu|suggest|autocomplete/iu;

const temporaryMetrics = new WeakSet<Page>();

export type Box = [number, number, number, number];
export type Point = [number, number, Record<string, unknown>];

function notVisible(element: Element): BrowseError {
  return new BrowseError(`Element ${element.label} has no visible box (hidden or zero-size)`, null, "not_visible");
}

export async function scrollWheel(
  page: Page,
  distance: number,
  vertical: boolean,
  humanize: boolean,
  given: [number, number] | null = null,
  frame: string | null = null,
  element: Element | null = null,
): Promise<void> {
  const mouse = inputOf(page).pointer;
  const scripted = await page.hidden();
  let point = given;
  if (point === null) {
    const vp = await viewport(page);
    let [x, y] = mouse.position;
    if (!(8 <= x && x <= vp.width - 8 && 8 <= y && y <= vp.height - 8)) {
      x = vp.width * rng().uniform(0.35, 0.65);
      y = vp.height * rng().uniform(0.35, 0.65);
    }
    point = [x, y];
  }
  if (scripted) {
  } else if (humanize && Math.abs(mouse.position[0] - point[0]) + Math.abs(mouse.position[1] - point[1]) > 2) {
    await mouse.move(point[0], point[1], true);
  } else if (!humanize) {
    mouse.position = point;
  }
  if (distance === 0) return;
  const at = point;
  const wheel = async (dx: number, dy: number) => {
    if (scripted) {
      if (element !== null) await page.call("(el, x, y) => el.scrollBy(x, y)", [element, dx, dy], { frame: element.frame });
      else await page.call("(x, y) => scrollBy(x, y)", [dx, dy], { frame: frame || page.mainFrame });
      return;
    }
    await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: Math.trunc(at[0]), y: Math.trunc(at[1]), deltaX: dx, deltaY: dy }, { inputEvent: true });
  };
  if (humanize) {
    await humanScroll(wheel, Math.abs(distance), vertical, distance > 0 ? 1 : -1);
    return;
  }
  await wheel(vertical ? 0 : Math.trunc(distance), vertical ? Math.trunc(distance) : 0);
}

function outside(r: { x: number; y: number; width: number; height: number }, vp: Viewport, margin = 4): boolean {
  return r.y < margin || r.y + Math.min(r.height, vp.height * 0.8) > vp.height - margin || r.x < 0 || r.x + Math.min(r.width, vp.width) > vp.width;
}

export async function laidOut(page: Page): Promise<void> {
  let vp = await viewport(page);
  if (vp.width >= 1 && vp.height >= 1) return;
  const deadline = monotonic() + LAYOUT_WAIT;
  while (monotonic() < deadline) {
    await sleep(0.1);
    vp = await viewport(page);
    if (vp.width >= 1 && vp.height >= 1) return;
  }
  if (!page.state.leases.has("emulation") && !page.state.leases.has("offscreen")) {
    let set = true;
    try {
      await page.send("Emulation.setDeviceMetricsOverride", { ...SANE_VIEWPORT, deviceScaleFactor: 0, mobile: false });
    } catch (error) {
      if (!(error instanceof Gated) && !(error instanceof CdpError)) throw error;
      set = false;
    }
    if (set) {
      temporaryMetrics.add(page);
      vp = await viewport(page);
      if (vp.width >= 1 && vp.height >= 1) return;
    }
  }
  throw new BrowseError(
    `This tab has no size yet (${vp.width}×${vp.height}: Ardia hasn't laid it out), so there's nowhere to click. Show it with ` +
      `\`ardia browse tab ${page.state.tabId(page.targetId)} --show\`, or wait a moment and retry`,
    null,
    "no_viewport",
  );
}

export async function restoreMetrics(page: Page): Promise<void> {
  if (!temporaryMetrics.has(page)) return;
  temporaryMetrics.delete(page);
  try {
    await page.send("Emulation.clearDeviceMetricsOverride", null, { timeout: CLEANUP_TIMEOUT });
  } catch (error) {
    if (!(error instanceof BrowseError)) throw error;
  }
}

export async function restoreAllMetrics(state: State): Promise<void> {
  for (const page of [...state.pages.values()]) {
    if (temporaryMetrics.has(page) && page.sessionId && state.connected) await shield(() => restoreMetrics(page));
  }
}

async function scrollIntoViewIfNeeded(page: Page, element: Element): Promise<void> {
  try {
    await sendIn(page, element.frame, "DOM.scrollIntoViewIfNeeded", { backendNodeId: element.backendId });
  } catch (error) {
    if (!(error instanceof CdpError) || !error.cdpMessage.includes("layout object")) throw error;
    throw notVisible(element);
  }
}

export async function scrollIntoView(page: Page, element: Element, humanize: boolean): Promise<void> {
  if (!humanize || element.frame !== page.mainFrame) {
    await scrollIntoViewIfNeeded(page, element);
    return;
  }
  for (let round = 0; round < 5; round += 1) {
    const r = await rect(page, element);
    const vp = await viewport(page);
    if (r.width === 0 && r.height === 0) break;
    if (!outside(r, vp)) return;
    let dy = r.y + r.height / 2 - vp.height / 2;
    dy = Math.max(-vp.scrollY, Math.min(dy, vp.docHeight - vp.height - vp.scrollY));
    let dx = 0;
    if (r.x < 0 || r.x + Math.min(r.width, vp.width) > vp.width) {
      dx = r.x + r.width / 2 - vp.width / 2;
      dx = Math.max(-vp.scrollX, Math.min(dx, vp.docWidth - vp.width - vp.scrollX));
    }
    if (Math.abs(dy) < 2 && Math.abs(dx) < 2) break;
    if (Math.abs(dy) >= 2) await scrollWheel(page, dy, true, true);
    if (Math.abs(dx) >= 2) await scrollWheel(page, dx, false, true);
    await sleep(0.15);
  }
  const r = await rect(page, element);
  const vp = await viewport(page);
  if (outside(r, vp)) await scrollIntoViewIfNeeded(page, element);
}

export async function elementBox(page: Page, element: Element): Promise<Box | null> {
  let quads: number[][];
  try {
    const found = await sendIn(page, element.frame, "DOM.getContentQuads", { backendNodeId: element.backendId });
    quads = Array.isArray(found["quads"]) ? (found["quads"] as number[][]) : [];
  } catch (error) {
    if (!(error instanceof CdpError) || !error.cdpMessage.includes("content quads")) throw error;
    return null;
  }
  let best: [number, number, number, number, number] | null = null;
  for (const quad of quads) {
    const xs = quad.filter((_, index) => index % 2 === 0);
    const ys = quad.filter((_, index) => index % 2 === 1);
    const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    if (area > 1 && (best === null || area > best[0])) best = [area, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  if (best === null) return null;
  const [rootX, rootY] = await localRootOffset(page, element.frame);
  return [best[1] + rootX, best[2] + rootY, best[3] + rootX, best[4] + rootY];
}

export async function settledBox(page: Page, element: Element, first: Box | null = null): Promise<Box | null> {
  let box = first ?? (await elementBox(page, element));
  const deadline = monotonic() + BOX_SETTLE_LIMIT;
  while (box !== null && monotonic() < deadline) {
    await sleep(BOX_SETTLE_POLL);
    const now = await elementBox(page, element);
    if (now === null || Math.max(...box.map((before, index) => Math.abs(before - (now[index] as number)))) <= 1) return now;
    flag("waited_for_box_to_settle", true);
    box = now;
  }
  return box;
}

export const PREPARE_ACTION = `(el, fx, fy, scroll, watch) => {
  if (!el.isConnected) return { connected: false };
  const facts = {
    connected: true,
    native: el.matches(":disabled") || !!(el.closest && el.closest("button:disabled, fieldset:disabled")),
    aria: el.getAttribute("aria-disabled") === "true",
    shown: document.visibilityState !== "hidden",
    width: innerWidth,
    height: innerHeight,
    moved: false,
    animating: false,
    box: false,
    cover: null,
    x: 0,
    y: 0,
  };
  const largest = () => {
    let best = null;
    for (const r of el.getClientRects()) if (r.width * r.height > 1 && (!best || r.width * r.height > best.width * best.height)) best = r;
    return best;
  };
  let rect = largest();
  if (!rect) return facts;
  if (scroll) {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let hidden = rect.top < 0 || rect.left < 0 || rect.bottom > innerHeight || rect.right > innerWidth;
    for (let p = el.parentElement; p && !hidden; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const c = p.getBoundingClientRect();
      hidden = cx < c.left || cx > c.right || cy < c.top || cy > c.bottom;
    }
    if (hidden) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const after = largest();
      facts.moved = !after || Math.abs(after.top - rect.top) + Math.abs(after.left - rect.left) > 1;
      if (!after) return facts;
      rect = after;
    }
  }
  const chain = new Set();
  for (let node = el; node; node = node.parentNode || node.host) chain.add(node);
  facts.animating = document.getAnimations().some((a) => a.playState === "running" && a.effect && chain.has(a.effect.target));
  facts.box = true;
  const x = rect.left + fx * rect.width;
  const y = rect.top + fy * rect.height;
  facts.x = x;
  facts.y = y;
  let cover = ardiaBrowse.hitTest(el, x, y);
  if (cover && !cover.startsWith("nothing")) {
    const root = el.getRootNode();
    if (root instanceof ShadowRoot) {
      const inner = root.elementFromPoint(x, y);
      let through = !!inner && (inner === el || el.contains(inner));
      for (let host = root.host; host && through; ) {
        const outer = host.getRootNode();
        const hit = outer.elementFromPoint(x, y);
        through = hit === host || (!!hit && host.contains(hit));
        host = outer instanceof ShadowRoot ? outer.host : null;
      }
      if (through) cover = null;
    }
  }
  facts.cover = cover || null;
  let top = [x, y];
  try {
    for (let win = window; top; win = win.parent) {
      if (win === win.top) {
        const visual = win.visualViewport;
        if (visual && (Math.abs(visual.scale - 1) > 0.001 || visual.offsetLeft || visual.offsetTop)) top = null;
        break;
      }
      const owner = win.frameElement;
      if (!owner || !owner.offsetWidth || !owner.offsetHeight || !win.innerWidth) {
        top = null;
        break;
      }
      const up = (node) => node.assignedSlot || node.parentElement || (node.parentNode && node.parentNode.host) || null;
      for (let node = owner; node && top; node = up(node)) {
        const style = getComputedStyle(node);
        if ((style.rotate && style.rotate !== "none") || (style.scale && style.scale !== "none")) {
          top = null;
          break;
        }
        if (!style.transform || style.transform === "none") continue;
        const matrix = new DOMMatrixReadOnly(style.transform);
        if (!matrix.is2D || Math.abs(matrix.b) > 0.000001 || Math.abs(matrix.c) > 0.000001 || matrix.a <= 0 || matrix.d <= 0) top = null;
      }
      if (!top) break;
      const box = owner.getBoundingClientRect();
      const style = getComputedStyle(owner);
      const sx = box.width / owner.offsetWidth;
      const sy = box.height / owner.offsetHeight;
      const padLeft = parseFloat(style.paddingLeft) || 0;
      const padTop = parseFloat(style.paddingTop) || 0;
      const inner = (owner.clientWidth - padLeft - (parseFloat(style.paddingRight) || 0)) / win.innerWidth;
      top = [box.left + (owner.clientLeft + padLeft) * sx + top[0] * sx * inner, box.top + (owner.clientTop + padTop) * sy + top[1] * sy * inner];
    }
  } catch (error) {
    top = null;
  }
  facts.top = top;
  if (watch) facts.counts = ardiaBrowse.inputWatch();
  return facts;
}`;

type Facts = {
  connected?: boolean;
  native?: boolean;
  aria?: boolean;
  shown?: boolean;
  width?: number;
  height?: number;
  moved?: boolean;
  animating?: boolean;
  box?: boolean;
  cover?: string | null;
  x?: number;
  y?: number;
  top?: [number, number] | null;
  counts?: Counts;
};

async function prepareAction(page: Page, element: Element, fx: number, fy: number, scroll: boolean, watch = false): Promise<Facts> {
  const facts = asRecord(await page.call(PREPARE_ACTION, [element, fx, fy, scroll, watch], { frame: element.frame, read: !scroll })) as Facts;
  if (!facts.connected) throw new BrowseError(`Element ${element.label} was removed from the page`);
  if (facts.shown) page.shownAt = monotonic();
  return facts;
}

function directPoint(facts: Facts): [number, number] | null {
  const top = facts.top;
  return Array.isArray(top) && Number.isFinite(top[0]) && Number.isFinite(top[1]) ? [top[0], top[1]] : null;
}

function pointIn(box: Box | null, facts: Facts, fx: number, fy: number): [number, number] | null {
  const direct = directPoint(facts);
  if (direct !== null) return direct;
  if (box === null) return null;
  const [left, upper, right, bottom] = box;
  return [left + fx * (right - left), upper + fy * (bottom - upper)];
}

async function aimAt(page: Page, element: Element, box: Box | null, facts: Facts, fx: number, fy: number): Promise<[[number, number], Box | null]> {
  if (!facts.box) throw notVisible(element);
  const point = pointIn(box, facts, fx, fy);
  if (point !== null) return [point, box];
  const measured = await elementBox(page, element);
  if (measured === null) throw notVisible(element);
  return [pointIn(measured, facts, fx, fy) as [number, number], measured];
}

function outsideMain([x, y]: [number, number], vp: Viewport): boolean {
  return x < 0 || y < 0 || x > vp.width || y > vp.height;
}

const HOLDS_HIT = "(el, hit) => el === hit || el.contains(hit) || (!!el.labels && Array.from(el.labels).some((label) => label === hit || label.contains(hit)))";

async function outsideItsFrame(page: Page, element: Element, x: number, y: number): Promise<string | null> {
  if (page.sessionFor(element.frame) !== page.session) return null;
  let hit: Record<string, unknown>;
  try {
    hit = await page.send("DOM.getNodeForLocation", { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: true });
  } catch (error) {
    if (error instanceof CdpError || error instanceof Gated) return null;
    throw error;
  }
  const where = `the point ${Math.round(x)},${Math.round(y)}, which isn't on it in the page around its frame`;
  const frame = hit["frameId"];
  const backend = hit["backendNodeId"];
  if (typeof frame === "string" && frame && frame !== element.frame) {
    flag("frame_point_unconfirmed", true);
    return where;
  }
  if (typeof backend !== "number" || backend === element.backendId) return null;
  const node = await page.resolveBackend(backend, element.frame, "the node at the click point");
  if (node === null || (await page.call(HOLDS_HIT, [element, node], { frame: element.frame, read: true }))) return null;
  flag("frame_point_unconfirmed", true);
  return where;
}

export async function targetPoint(page: Page, element: Element, humanize: boolean, checkCover = true, waitForEnabled = false): Promise<Point> {
  let fx = humanize ? 0.5 + rng().uniform(-0.2, 0.2) : 0.5;
  let fy = humanize ? 0.5 + rng().uniform(-0.2, 0.2) : 0.5;
  const humanScroll = humanize && element.frame === page.mainFrame;
  let facts = await prepareAction(page, element, fx, fy, !humanScroll, true);
  if (waitForEnabled && (facts.native || facts.aria)) {
    await waitEnabled(page, element, false);
    facts = await prepareAction(page, element, fx, fy, !humanScroll, true);
  }
  const inMain = element.frame === page.mainFrame;
  if (inMain && !((facts.width ?? 0) >= 1 && (facts.height ?? 0) >= 1)) {
    await laidOut(page);
    facts = await prepareAction(page, element, fx, fy, !humanScroll, true);
  }
  let stale = Boolean(facts.moved || facts.animating);
  if (humanScroll) {
    await scrollIntoView(page, element, true);
    stale = true;
  }
  if (!facts.box && !humanScroll) throw notVisible(element);
  let box: Box | null = null;
  if (stale) {
    box = await elementBox(page, element);
    if (box === null) throw notVisible(element);
  }
  if (!inMain) {
    const vp = await viewport(page);
    if (!(vp.width >= 1 && vp.height >= 1)) await laidOut(page);
    let point: [number, number];
    [point, box] = await aimAt(page, element, box, facts, fx, fy);
    if (outsideMain(point, vp)) {
      await scrollIntoViewIfNeeded(page, element);
      stale = true;
    }
  }
  if (stale) {
    box = await settledBox(page, element, box);
    if (box === null) throw notVisible(element);
  }
  const tried = new Set<string>();
  let cx = 0;
  let cy = 0;
  let cover: string | null = null;
  for (let round = 0; round < 4; round += 1) {
    if (round > 0) {
      box = await settledBox(page, element);
      if (box === null) throw notVisible(element);
    }
    if (round > 0 || stale) facts = await prepareAction(page, element, fx, fy, false, true);
    [[cx, cy], box] = await aimAt(page, element, box, facts, fx, fy);
    if (!checkCover) return [cx, cy, { connected: true, counts: facts.counts ?? null }];
    cover = facts.cover ?? null;
    if (cover && humanize && (fx !== 0.5 || fy !== 0.5)) {
      fx = 0.5;
      fy = 0.5;
      facts = await prepareAction(page, element, fx, fy, false, true);
      [[cx, cy], box] = await aimAt(page, element, box, facts, fx, fy);
      cover = facts.cover ?? null;
    }
    if (!cover && !inMain && directPoint(facts) === null) cover = await outsideItsFrame(page, element, cx, cy);
    if (!cover) break;
    const [hx, hy] = [facts.x ?? 0, facts.y ?? 0];
    if (!tried.has(`consent ${cover}`) && !cover.startsWith("nothing")) {
      tried.add(`consent ${cover}`);
      if (await dismissedConsent(page, element, hx, hy)) continue;
      if (CONSENT_NAMES.test(cover) && !tried.has("consent again")) {
        tried.add("consent again");
        await sleep(CONSENT_FADE);
        if (await dismissedConsent(page, element, hx, hy)) continue;
      }
    }
    if (MENU_NAMES.test(cover) && !tried.has("escape")) {
      tried.add("escape");
      if (await closedMenu(page, cover)) continue;
    }
    if (!tried.has("center")) {
      tried.add("center");
      if (await centered(page, element)) continue;
    }
    break;
  }
  const hx = facts.x ?? 0;
  const hy = facts.y ?? 0;
  if (checkCover) {
    if (cover && cover.startsWith("nothing")) {
      const vp = await viewport(page, element.frame);
      const where = `${element.label} is outside the visible page (its middle is at ${fixed(hx, 0)},${fixed(hy, 0)} in a ${vp.width}×${vp.height} viewport)`;
      const lock = await scrollLock(page, element);
      if (lock) {
        flag("click_scroll_locked", true);
        throw new BrowseError(
          `Element ${where}, and the page won't scroll to it: ${lock}. Close that first (press Escape, or its close button), then retry`,
          { point: [cx, cy], viewport: [vp.width, vp.height], scrollLock: lock },
          "outside_viewport",
        );
      }
      throw new BrowseError(
        `Element ${where}, so a click there would land on nothing. Scroll it into view (scrollintoview), or snapshot again if the page moved`,
        { point: [cx, cy], viewport: [vp.width, vp.height] },
        "outside_viewport",
      );
    }
    if (cover) {
      const closer = await closeControl(page, element, hx, hy);
      const first = closer ? (closer.split(" ")[0] as string) : null;
      const way = closer ? `; its close control is ${closer} (\`click ${first}\`), then retry` : "; interact with that element first, snapshot again, then retry";
      throw new BrowseError(`Element ${element.label} is covered by ${cover}${way}`, { coveredBy: cover, closeRef: first }, "covered");
    }
  }
  return [cx, cy, { connected: true, counts: facts.counts ?? null }];
}

export async function closeControl(page: Page, element: Element, x: number, y: number): Promise<string | null> {
  let found: Element[];
  try {
    const remote = await page.call(ACTIONS_CLOSE_CONTROL, [x, y], { frame: element.frame, byValue: false, read: true });
    found = await page.elementsFrom(remote, element.frame, "close control", 1);
  } catch (error) {
    if (error instanceof BrowseError) return null;
    throw error;
  }
  const control = found[0];
  if (control === undefined) return null;
  let name: unknown;
  try {
    name = await page.call(
      "(el) => ((el.innerText || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title') || 'close').replace(/\\s+/g, ' ').slice(0, 40)",
      [control],
      { frame: element.frame, read: true },
    );
  } catch (error) {
    if (!(error instanceof BrowseError)) throw error;
    name = "close";
  }
  flag("covered_close_ref", true);
  return `@${page.state.refForNode(page, element.frame, control.backendId)} "${String(name)}"`;
}

export async function dismissedConsent(page: Page, element: Element, x: number, y: number): Promise<boolean> {
  let done: unknown;
  try {
    done = await page.call("(x, y) => ardiaBrowse.dismissConsent(x, y)", [x, y], { frame: element.frame });
  } catch (error) {
    if (error instanceof BrowseError) return false;
    throw error;
  }
  if (!done) return false;
  const facts = asRecord(done);
  const kind = facts["kind"];
  flag(kind === "popup" ? "popup_dismissed" : kind === "modal" ? "modal_dismissed" : "consent_dismissed", true);
  const what = kind === "popup" ? "A signup popup" : kind === "modal" ? "A popup" : "A consent banner";
  page.state.consentDismissed = `${what} was in the way: ${String(facts["layer"])} covered ${element.label}, so its "${String(facts["name"])}" button was clicked (${String(facts["choice"])})`;
  await sleep(CONSENT_SETTLE);
  return true;
}

export async function closedMenu(page: Page, cover: string): Promise<boolean> {
  try {
    for (const kind of ["keyDown", "keyUp"]) {
      await page.send("Input.dispatchKeyEvent", { type: kind, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, { inputEvent: true });
    }
  } catch (error) {
    if (error instanceof BrowseError) return false;
    throw error;
  }
  flag("menu_closed_for_click", true);
  page.state.consentDismissed = `An open menu or list (${cover}) was in the way, so Escape was pressed to close it before the click`;
  await sleep(CONSENT_SETTLE);
  return true;
}

export async function centered(page: Page, element: Element): Promise<boolean> {
  let moved: unknown;
  try {
    moved = await page.call(ACTIONS_CENTER, [element], { frame: element.frame });
  } catch (error) {
    if (error instanceof BrowseError) return false;
    throw error;
  }
  if (moved) {
    flag("click_recentered", true);
    await sleep(0.1);
  }
  return Boolean(moved);
}

export async function disabledState(page: Page, element: Element): Promise<Record<string, unknown>> {
  return asRecord(await page.call(ACTIONS_DISABLED_STATE, [element], { frame: element.frame, read: true }));
}

export async function waitEnabled(page: Page, element: Element, strict = true): Promise<void> {
  let state = await disabledState(page, element);
  if (!(state["native"] || state["aria"])) return;
  flag("waited_for_enabled", true);
  const deadline = monotonic() + ENABLE_WAIT;
  while (monotonic() < deadline) {
    await sleep(0.05);
    state = await disabledState(page, element);
    if (!(state["native"] || state["aria"])) return;
  }
  if (state["native"] || strict) {
    throw new BrowseError(
      `Element ${element.label} is disabled, and it stayed disabled for ${formatG(ENABLE_WAIT)} s. Do what enables it first ` +
        "(it usually depends on another field: To after From); in a batch, put that line before this one",
      null,
      "disabled",
    );
  }
}

export async function visibleLabel(page: Page, element: Element): Promise<Element | null> {
  const remote = await page.call(ACTIONS_VISIBLE_LABEL, [element], { frame: element.frame, byValue: false });
  return page.elementFrom(remote, element.frame, `the label of ${element.label}`);
}

export async function visibleContent(page: Page, element: Element): Promise<Element | null> {
  const remote = await page.call(ACTIONS_VISIBLE_CONTENT, [element], { frame: element.frame, byValue: false });
  return page.elementFrom(remote, element.frame, `the visible content of ${element.label}`);
}

export async function scrollLock(page: Page, element: Element): Promise<string | null> {
  try {
    const lock = await page.call(ACTIONS_SCROLL_LOCK, [element], { frame: element.frame });
    return typeof lock === "string" && lock ? lock : null;
  } catch (error) {
    if (error instanceof BrowseError) return null;
    throw error;
  }
}

function isDict(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function domClick(page: Page, element: Element, error: BrowseError): Promise<void> {
  let clicked = await page.call(ACTIONS_DOM_CLICK, [element], { frame: element.frame });
  if (isDict(clicked)) {
    const unblocked = async () => {
      clicked = await page.call(ACTIONS_DOM_CLICK, [element], { frame: element.frame });
      return !isDict(clicked);
    };
    if ((await poll(unblocked, CLOSING_MODAL_WAIT)) && clicked) flag("dom_click_waited_for_modal", true);
  }
  if (isDict(clicked)) {
    flag("dom_click_behind_modal", true);
    const name = asRecord(clicked)["modal"];
    const lock = name ? `the modal dialog "${String(name)}" is open over it` : "a modal dialog is open over it";
    throw new BrowseError(
      `Element ${element.label} is outside the visible page, and ${lock}. Close that first (press Escape, or its close button), then retry`,
      { ...(error.data ?? {}), scrollLock: lock },
      "outside_viewport",
    );
  }
  if (!clicked) throw error;
  flag("dom_click_fallback", true);
  const point = (error.data?.["point"] as unknown[] | undefined) ?? ["?", "?"];
  page.state.clickNote =
    typeof point[0] === "number"
      ? `${element.label} sits outside the page (at ${fixed(point[0], 0)},${fixed(point[1] as number, 0)}) where scrolling can't reach, so it got a DOM click instead of a pointer click`
      : `${element.label} sits outside the page, so it got a DOM click instead of a pointer click`;
}

export async function click(page: Page, element: Element, humanize: boolean, count = 1, button = "left", beforePress: (() => Promise<void>) | null = null): Promise<void> {
  let x: number;
  let y: number;
  let primed: Counts | null;
  try {
    let facts: Record<string, unknown>;
    [x, y, facts] = await targetPoint(page, element, humanize, true, true);
    primed = (facts["counts"] as Counts | null | undefined) ?? null;
  } catch (error) {
    if (!(error instanceof BrowseError)) throw error;
    if (error.code === "not_visible") {
      let standIn = await visibleLabel(page, element);
      if (standIn !== null) {
        flag("clicked_label_of_hidden_input", true);
        await click(page, standIn, humanize, count, button);
        page.state.clickNote = `${element.label} is hidden and drawn by its label, so the click went to the label`;
        return;
      }
      standIn = await visibleContent(page, element);
      if (standIn === null) throw error;
      flag("clicked_visible_content", true);
      await click(page, standIn, humanize, count, button);
      page.state.clickNote = `${element.label} has no box of its own, so the click went to its visible content`;
      return;
    }
    if (error.code !== "outside_viewport" || count !== 1 || button !== "left") throw error;
    await domClick(page, element, error);
    return;
  }
  const input = inputOf(page);
  const mouse = input.pointer;
  const which = mouseButton(button);
  const press = async () => {
    if (beforePress !== null) {
      await mouse.move(x, y, humanize);
      await beforePress();
      await mouse.down(which);
      await mouse.up(which);
      return;
    }
    if (humanize || count === 1) {
      await mouse.click(x, y, which, count, humanize);
      return;
    }
    for (let number = 1; number <= count; number += 1) await mouse.click(x, y, which, number, false);
  };
  await expectInput(page, element.frame, () => input.gesture("click", press), { mousedown: count, mouseup: count }, "The click", element, primed);
}

export async function hover(page: Page, element: Element, humanize: boolean): Promise<void> {
  const [x, y] = await targetPoint(page, element, humanize, false);
  const input = inputOf(page);
  await expectInput(page, element.frame, () => input.gesture("hover", () => input.pointer.move(x, y, humanize)), { mousemove: 1 }, "The hover");
}

export const TOUCH_PROBE = "() => navigator.maxTouchPoints > 0 && 'ontouchstart' in window";
export const TOUCH_OFF =
  "touch isn't emulated in this tab (navigator.maxTouchPoints is 0), so it got a mouse click: a touch event there would give the page a " +
  "touch it can't explain. `set device <phone>` turns touch on";

export async function touchEmulated(page: Page, frame: string | null): Promise<boolean> {
  try {
    return Boolean(await page.call(TOUCH_PROBE, [], { frame: frame || page.mainFrame, read: true }));
  } catch (error) {
    if (error instanceof BrowseError) return false;
    throw error;
  }
}

export async function tap(page: Page, element: Element, humanize: boolean): Promise<boolean> {
  if (!(await touchEmulated(page, element.frame))) {
    await click(page, element, humanize);
    return false;
  }
  const [x, y] = await targetPoint(page, element, humanize);
  const input = inputOf(page);
  const point = { x: hundredths(x), y: hundredths(y), id: 1 };
  await input.gesture("tap", async () => {
    input.heldTouch = point;
    await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] }, { inputEvent: true });
    if (humanize) await sleep(rng().uniform(0.05, 0.15));
    await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, { inputEvent: true });
    input.heldTouch = null;
  });
  input.pointer.position = [x, y];
  return true;
}

function hundredths(value: number): number {
  return Math.round(value * 100) / 100;
}
