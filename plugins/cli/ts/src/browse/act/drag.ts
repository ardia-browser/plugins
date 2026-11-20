import { Cancelled, shield, untilCancelled } from "../cdp/cancel.ts";
import { TimedOut, within } from "../changes/observe.ts";
import { BrowseError, Gated, OutcomeUnknown } from "../daemon-errors.ts";
import { inputOf } from "../input/input.ts";
import { roundCoordinate } from "../input/human.ts";
import { ACTIONS_LIST_AFTER, ACTIONS_LIST_BEFORE } from "../js/index.ts";
import { flag } from "../metrics.ts";
import type { Element, Page } from "../state/page.ts";
import { asRecord, type Counts, expectInput, inputCounts } from "./common.ts";
import { type Box, CLEANUP_TIMEOUT, elementBox, targetPoint } from "./pointer.ts";

export const INTERCEPT_TIMEOUT = 1.5;
export const DRAG_FAR_SHARE = 0.75;
export const DRAG_GATED = "the source is an HTML5 draggable, and without drag interception a synthetic drag would start a real macOS drag session";
export const CLEANUPS = new Set<Promise<void>>();
export const CLEANUPS_WAIT = 2 * CLEANUP_TIMEOUT + INTERCEPT_TIMEOUT;

export async function drainCleanups(seconds = CLEANUPS_WAIT): Promise<boolean> {
  if (CLEANUPS.size === 0) return true;
  try {
    await within(Promise.allSettled([...CLEANUPS]), seconds);
    return true;
  } catch (error) {
    if (error instanceof TimedOut) return false;
    throw error;
  }
}


export class DragInterception {
  private intercepted: Promise<Record<string, unknown>> | null = null;
  private interceptedData: Record<string, unknown> | null = null;
  data: Record<string, unknown> | null = null;
  ended = false;
  position: [number, number] = [0, 0];
  before: Counts = {};
  beforeSource: Counts = {};
  cleanup: Promise<void> | null = null;
  cleaned = true;
  private waiter: ((data: Record<string, unknown>) => void) | null = null;

  constructor(
    readonly page: Page,
    readonly sourceFrame: string,
    readonly targetFrame: string,
  ) {}

  private get done(): boolean {
    return this.interceptedData !== null;
  }

  async start(): Promise<void> {
    this.before = await inputCounts(this.page, this.targetFrame);
    this.beforeSource = this.sourceFrame === this.targetFrame ? this.before : await inputCounts(this.page, this.sourceFrame);
    this.intercepted = new Promise((resolve) => {
      this.waiter = (data) => {
        this.interceptedData = data;
        resolve(data);
      };
    });
    this.page.dragIntercepted = this.waiter;
    this.cleaned = false;
    try {
      await this.page.send("Input.setInterceptDrags", { enabled: true });
    } catch (error) {
      if (error instanceof Gated) {
        this.page.dragIntercepted = null;
        this.cleaned = true;
        throw error.during("drag", DRAG_GATED);
      }
      await this.finish();
      throw error;
    }
    inputOf(this.page).pointer.interception = this;
  }

  async dispatch(kind: string, x: number, y: number, timeout = 30): Promise<void> {
    await this.page.send(
      "Input.dispatchDragEvent",
      { type: kind, x: roundCoordinate(x), y: roundCoordinate(y), data: this.data, modifiers: 0 },
      { inputEvent: true, timeout },
    );
  }

  async pageStartedDrag(): Promise<boolean> {
    let now: Record<string, unknown>;
    try {
      now = asRecord(await this.page.call("() => ardiaBrowse.inputWatch()", [], { frame: this.sourceFrame, timeout: CLEANUP_TIMEOUT }));
    } catch (error) {
      if (error instanceof BrowseError) return false;
      throw error;
    }
    return Number(now["dragstart"] ?? 0) > Number(this.beforeSource["dragstart"] ?? 0);
  }

  async handedOver(): Promise<Record<string, unknown>> {
    try {
      return await within(this.intercepted as Promise<Record<string, unknown>>, INTERCEPT_TIMEOUT);
    } catch (error) {
      if (error instanceof TimedOut) throw new OutcomeUnknown("drag", "the page started an HTML5 drag, but Ardia didn't hand it over in time");
      throw error;
    }
  }

  async moved(x: number, y: number): Promise<void> {
    this.position = [x, y];
    if (this.data === null && this.done) {
      this.data = this.interceptedData;
      await this.dispatch("dragEnter", x, y);
    }
  }

  async over(x: number, y: number): Promise<void> {
    this.position = [x, y];
    await this.dispatch("dragOver", x, y);
  }

  async release(x: number, y: number): Promise<void> {
    this.position = [x, y];
    if (this.ended) return;
    if (this.data === null) {
      if (!this.done && !(await this.pageStartedDrag())) return;
      this.data = await this.handedOver();
      await this.dispatch("dragEnter", x, y);
    }
    await this.dispatch("dragOver", x, y);
    await this.dispatch("drop", x, y);
    this.ended = true;
  }

  private async clean(): Promise<void> {
    const page = this.page;
    const input = inputOf(page);
    if (input.mouse !== null) input.mouse.interception = null;
    try {
      try {
        if (this.data === null && !this.ended) {
          if (this.done) this.data = this.interceptedData;
          else if (await this.pageStartedDrag()) {
            try {
              this.data = await within(this.intercepted as Promise<Record<string, unknown>>, INTERCEPT_TIMEOUT);
            } catch (error) {
              if (!(error instanceof TimedOut)) throw error;
            }
          }
        }
        if (this.data !== null && !this.ended) {
          await this.dispatch("dragCancel", this.position[0], this.position[1], CLEANUP_TIMEOUT);
          this.ended = true;
        }
      } finally {
        await input.releaseHeld();
      }
    } finally {
      if (page.dragIntercepted === this.waiter) page.dragIntercepted = null;
      await page.send("Input.setInterceptDrags", { enabled: false }, { timeout: CLEANUP_TIMEOUT });
      this.cleaned = true;
    }
  }

  async finish(): Promise<void> {
    if (this.cleanup === null) {
      const cleanup = shield(() => this.clean());
      this.cleanup = cleanup;
      CLEANUPS.add(cleanup);
      cleanup.then(
        () => CLEANUPS.delete(cleanup),
        () => CLEANUPS.delete(cleanup),
      );
    }
    const cleanup = this.cleanup;
    try {
      await untilCancelled(cleanup);
    } catch (error) {
      if (error instanceof Cancelled) {
        await cleanup.catch(() => {});
        throw error;
      }
    }
  }

  async dropped(): Promise<boolean | null> {
    let now: Counts;
    try {
      now = await inputCounts(this.page, this.targetFrame);
    } catch (error) {
      if (error instanceof BrowseError) return null;
      throw error;
    }
    return Number(now["drop"] ?? 0) > Number(this.before["drop"] ?? 0);
  }
}

export async function draggable(page: Page, element: Element): Promise<boolean> {
  return Boolean(
    await page.call(
      "(el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) if (n.draggable || n.getAttribute('draggable') === 'true') return true; return false; }",
      [element],
      { frame: element.frame, read: true },
    ),
  );
}

export function interruptedDrag(error: BrowseError): BrowseError {
  if (["input_not_delivered", "input_unconfirmable", "tab_hidden", "policy_refused"].includes(error.code ?? "")) return error;
  return new OutcomeUnknown("drag", `the drag was interrupted (${error.message}); any held button was released at the last position`);
}

export function dropPoint(box: Box, source: readonly [number, number], side: string | null): [number, number] {
  const [left, top, right, bottom] = box;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const vertical = Math.abs(cy - source[1]) >= Math.abs(cx - source[0]);
  const forward = vertical ? cy > source[1] : cx > source[0];
  const after = side === null ? forward : side === "after";
  const share = after ? DRAG_FAR_SHARE : 1 - DRAG_FAR_SHARE;
  if (vertical) return [cx, top + (bottom - top) * share];
  return [left + (right - left) * share, cy];
}

export type ListPlace = { from: number; count: number };

export async function listBefore(page: Page, source: Element, target: Element): Promise<ListPlace | null> {
  if (source.frame !== target.frame) return null;
  const found = await page.call(ACTIONS_LIST_BEFORE, [source, target], { frame: source.frame });
  return found !== null && typeof found === "object" && !Array.isArray(found) ? (found as ListPlace) : null;
}

export async function listAfter(page: Page, frame: string, before: ListPlace): Promise<Record<string, unknown> | null> {
  let found: unknown;
  try {
    found = await page.call(ACTIONS_LIST_AFTER, [], { frame, read: true });
  } catch (error) {
    if (error instanceof BrowseError) return null;
    throw error;
  }
  if (found === null || typeof found !== "object" || Array.isArray(found)) return null;
  flag("drag_list_position", true);
  const after = found as Record<string, unknown>;
  return { from: before.from, to: after["to"], count: after["count"] };
}

export async function drag(page: Page, source: Element, target: Element, humanize: boolean, side: string | null = null): Promise<Record<string, unknown>> {
  const interception = (await draggable(page, source)) ? new DragInterception(page, source.frame, target.frame) : null;
  if (interception !== null) await interception.start();
  const input = inputOf(page);
  const mouse = input.pointer;
  try {
    const [x1, y1] = await targetPoint(page, source, humanize);
    let [x2, y2] = await targetPoint(page, target, humanize, false);
    const box = await elementBox(page, target);
    if (box !== null) [x2, y2] = dropPoint(box, [x1, y1], side);
    const run = async () => {
      try {
        await mouse.drag(x1, y1, x2, y2, humanize);
      } finally {
        if (interception !== null) await interception.finish();
      }
    };
    const needs = interception === null ? { mousedown: 1, mouseup: 1 } : { mousedown: 1, "dragend|mouseup": 1 };
    try {
      await expectInput(page, source.frame, () => input.gesture("drag", run), needs, "The drag");
    } catch (error) {
      if (error instanceof Cancelled || error instanceof OutcomeUnknown || !(error instanceof BrowseError)) throw error;
      throw interruptedDrag(error);
    }
  } finally {
    if (interception !== null) await interception.finish();
  }
  if (interception === null) return { html5: false };
  const started = interception.data !== null;
  const outcome: Record<string, unknown> = { html5: true, started, dropped: started ? await interception.dropped() : false };
  if (!interception.cleaned) outcome["interceptionLeftOn"] = true;
  return outcome;
}
