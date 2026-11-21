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
import { frameOffset, localRootOffset, sendIn } from "../state/frames.ts";
import type { Element, Page } from "../state/page.ts";
import type { State } from "../state/state.ts";
import { monotonic } from "../state/wait.ts";
import { asRecord, expectInput, mouseButton, poll, rect, viewport, type Viewport } from "./common.ts";

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

export async function settledBox(page: Page, element: Element): Promise<Box | null> {
  let box = await elementBox(page, element);
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

export const SHADOW_HIT = `(el, x, y) => {
  const root = el.getRootNode();
  if (!(root instanceof ShadowRoot)) return false;
  const inner = root.elementFromPoint(x, y);
  if (!inner || !(inner === el || el.contains(inner))) return false;
  for (let host = root.host; host; ) {
    const outer = host.getRootNode();
    const hit = outer.elementFromPoint(x, y);
    if (hit !== host && !(hit && host.contains(hit))) return false;
    host = outer instanceof ShadowRoot ? outer.host : null;
  }
  return true;
}`;

async function hitTest(page: Page, element: Element, x: number, y: number): Promise<string | null> {
  const cover = await page.call("(el, x, y) => ardiaBrowse.hitTest(el, x, y)", [element, x, y], { frame: element.frame });
  if (typeof cover !== "string" || !cover) return null;
  if (!cover.startsWith("nothing") && (await page.call(SHADOW_HIT, [element, x, y], { frame: element.frame, read: true }))) return null;
  return cover;
}

export async function targetPoint(page: Page, element: Element, humanize: boolean, checkCover = true): Promise<Point> {
  const info = asRecord(await page.call("(el) => ardiaBrowse.info(el)", [element], { frame: element.frame }));
  if (!info["connected"]) throw new BrowseError(`Element ${element.label} was removed from the page`);
  await laidOut(page);
  await scrollIntoView(page, element, humanize);
  const tried = new Set<string>();
  let cx = 0;
  let cy = 0;
  let ox = 0;
  let oy = 0;
  let cover: string | null = null;
  for (let round = 0; round < 4; round += 1) {
    const box = await settledBox(page, element);
    if (box === null) throw notVisible(element);
    const [left, top, right, bottom] = box;
    cx = (left + right) / 2;
    cy = (top + bottom) / 2;
    if (humanize) {
      cx += rng().uniform(-0.2, 0.2) * (right - left);
      cy += rng().uniform(-0.2, 0.2) * (bottom - top);
    }
    if (!checkCover) return [cx, cy, info];
    [ox, oy] = await frameOffset(page, element.frame);
    cover = await hitTest(page, element, cx - ox, cy - oy);
    if (cover && humanize) {
      cx = (left + right) / 2;
      cy = (top + bottom) / 2;
      cover = await hitTest(page, element, cx - ox, cy - oy);
    }
    if (!cover) break;
    if (!tried.has(`consent ${cover}`) && !cover.startsWith("nothing")) {
      tried.add(`consent ${cover}`);
      if (await dismissedConsent(page, element, cx - ox, cy - oy)) continue;
      if (CONSENT_NAMES.test(cover) && !tried.has("consent again")) {
        tried.add("consent again");
        await sleep(CONSENT_FADE);
        if (await dismissedConsent(page, element, cx - ox, cy - oy)) continue;
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
  if (checkCover) {
    if (cover && cover.startsWith("nothing")) {
      const vp = await viewport(page);
      const where = `${element.label} is outside the visible page (its middle is at ${fixed(cx - ox, 0)},${fixed(cy - oy, 0)} in a ${vp.width}×${vp.height} viewport)`;
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
      const closer = await closeControl(page, element, cx - ox, cy - oy);
      const first = closer ? (closer.split(" ")[0] as string) : null;
      const way = closer ? `; its close control is ${closer} (\`click ${first}\`), then retry` : "; interact with that element first, snapshot again, then retry";
      throw new BrowseError(`Element ${element.label} is covered by ${cover}${way}`, { coveredBy: cover, closeRef: first }, "covered");
    }
  }
  return [cx, cy, info];
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

export async function click(page: Page, element: Element, humanize: boolean, count = 1, button = "left"): Promise<void> {
  await waitEnabled(page, element, false);
  let x: number;
  let y: number;
  try {
    [x, y] = await targetPoint(page, element, humanize);
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
    if (humanize || count === 1) {
      await mouse.click(x, y, which, count, humanize);
      return;
    }
    for (let number = 1; number <= count; number += 1) await mouse.click(x, y, which, number, false);
  };
  await expectInput(page, element.frame, () => input.gesture("click", press), { mousedown: count, mouseup: count }, "The click", element);
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
