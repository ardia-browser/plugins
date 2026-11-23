import { roundHalfEven } from "../../pylib/format.ts";
import { sleep } from "../cdp/cancel.ts";
import { BrowseError, CdpError, ConnectionLost, OutcomeUnknown } from "../daemon-errors.ts";
import { ACTIONS_FOCUSED_FIELD, ACTIONS_FOCUSED_HERE, ACTIONS_INPUT_WATCH } from "../js/index.ts";
import { flag } from "../metrics.ts";
import type { Element, Page } from "../state/page.ts";
import { record } from "../state/records.ts";
import { monotonic } from "../state/wait.ts";
import { budget } from "../changes/throttle.ts";

export const DELIVERY_TIMEOUT = 1.5;
export const POLL = 0.05;
export const MAX_FOCUS_PROBES = 24;
export const FRAME_OWNERS = new Set(["IFRAME", "FRAME", "EMBED", "OBJECT"]);
export const KEY_EVENTS = ["keydown", "keyup", "input"];
export const NOT_DELIVERED =
  "{action} was sent, but the page received none of its {missing} events. Something may have caught them first (an overlay, " +
  "or a frame this check can't see into), or the tab may have just been switched away from; take a screenshot to see what's " +
  "at that point, or show the tab (`ardia browse tab <id> --show`), before trying again";
export const TARGET_REPLACED =
  "{action} didn't land: {target} was removed from the page before it arrived (the page redrew it, as a list does after " +
  "a search or filter changes), so nothing was entered. Find the element again (snapshot -i) and retry";
export const PARTLY_DELIVERED = "the page received only part of it (no {missing} event arrived), so it may have had an effect";

export type Counts = Record<string, number | boolean | null | undefined>;
export type Viewport = { width: number; height: number; scrollX: number; scrollY: number; docWidth: number; docHeight: number };

export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) => (Object.hasOwn(values, name) ? (values[name] as string) : whole));
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export const LOST_KINDS: readonly [string, readonly string[]][] = [
  ["pointer", ["mousedown", "mouseup", "pointerdown", "pointerup", "click", "mousemove"]],
  ["keys", ["keydown", "keyup"]],
  ["text", ["beforeinput", "input"]],
  ["wheel", ["wheel"]],
  ["drag", ["dragstart", "dragend", "drop"]],
];

export async function inputCounts(page: Page, frame: string | null): Promise<Counts> {
  return asRecord(await page.call(ACTIONS_INPUT_WATCH, [], { frame })) as Counts;
}

export function delivered(now: Counts, before: Counts, name: string): number {
  return Math.max(...name.split("|").map((part) => Number(now[part] ?? 0) - Number(before[part] ?? 0)));
}

export type Postcondition = { prepare: () => Promise<void>; landed: () => Promise<boolean> };

export function textInserted(page: Page, frame: string | null, text: string): Postcondition {
  let ready = false;
  const probe = async (after: boolean): Promise<boolean> => {
    try {
      return Boolean(await page.call(ACTIONS_FOCUSED_FIELD, [text, after], { frame, read: true }));
    } catch (error) {
      if (error instanceof BrowseError && !(error instanceof ConnectionLost)) return false;
      throw error;
    }
  };
  return {
    prepare: async () => {
      ready = await probe(false);
    },
    landed: async () => ready && (await probe(true)),
  };
}

export function flagLost(needs: Needs): void {
  const parts = new Set(Object.keys(needs).flatMap((name) => name.split("|")));
  for (const [kind, events] of LOST_KINDS) if (events.some((event) => parts.has(event))) flag(`input_lost_${kind}`, true);
}

export function leftDocument(error: BrowseError): boolean {
  return error.code === "document_changed" || (error.code === "outcome_unknown" && error.message.includes("changed document"));
}

export async function stillAttached(page: Page, element: Element): Promise<boolean> {
  try {
    return Boolean(await page.call("(el) => el.isConnected", [element], { frame: element.frame, read: true }));
  } catch (error) {
    if (error instanceof BrowseError) return false;
    throw error;
  }
}

export async function focusInOtherFrame(page: Page, frame: string): Promise<boolean> {
  const focused = new Set<string>();
  for (const other of [...page.frames.keys()].slice(0, MAX_FOCUS_PROBES)) {
    try {
      if (await page.call(ACTIONS_FOCUSED_HERE, [], { frame: other, read: true, timeout: 2 })) focused.add(other);
    } catch (error) {
      if (!(error instanceof BrowseError)) throw error;
    }
  }
  const parents = new Set([...focused].filter((other) => page.frames.has(other)).map((other) => page.frames.get(other)?.parent ?? null));
  const leaves = [...focused].filter((other) => !parents.has(other));
  if (leaves.length > 0 && !leaves.includes(frame)) {
    flag("input_in_inner_frame", true);
    return true;
  }
  return false;
}

export type Needs = Record<string, number>;

export async function expectInput<T>(
  page: Page,
  given: string | null,
  run: () => Promise<T>,
  needs: Needs,
  action: string,
  element: Element | null = null,
  primed: Counts | null = null,
  postcondition: Postcondition | null = null,
): Promise<T> {
  const frame = given || page.mainFrame;
  const loader = page.loader(frame);
  let before: Counts;
  try {
    before = primed ?? (await inputCounts(page, frame));
    if (postcondition !== null) await postcondition.prepare();
  } catch (error) {
    if (error instanceof ConnectionLost || !(error instanceof BrowseError)) throw error;
    throw new BrowseError(`Couldn't watch this frame for input, so ${action.toLowerCase()} wasn't sent (${error.message})`, null, "input_unconfirmable");
  }
  const result = await run();
  const names = Object.keys(needs);
  if (names.length === 0 || (before["activeFrame"] && names.some((name) => KEY_EVENTS.some((key) => name.includes(key))))) return result;
  const deadline = monotonic() + budget(page, DELIVERY_TIMEOUT);
  for (;;) {
    let now: Counts;
    try {
      await page.refreshFrames();
      if (frame === null || !page.frames.has(frame) || page.loader(frame) !== loader) return result;
      now = await inputCounts(page, frame);
    } catch (error) {
      if (error instanceof ConnectionLost || !(error instanceof BrowseError)) throw error;
      if (leftDocument(error)) return result;
      throw new OutcomeUnknown(action.toLowerCase(), `it was sent, but confirming it reached the page failed (${error.message})`);
    }
    const missing = names.filter((name) => delivered(now, before, name) < (needs[name] as number));
    if (missing.length === 0) {
      if (delivered(now, before, "mousedown") < delivered(now, before, "pointerdown")) flag("input_mouse_events_cancelled", true);
      return result;
    }
    if (monotonic() >= deadline) {
      const listed = missing.flatMap((name) => name.split("|")).join(" or ");
      if (names.every((name) => delivered(now, before, name) === 0)) {
        if (names.some((name) => KEY_EVENTS.some((key) => name.includes(key))) && (await focusInOtherFrame(page, frame))) return result;
        if (postcondition !== null && (await postcondition.landed())) {
          flag("input_confirmed_by_text", true);
          return result;
        }
        if (element !== null && !(await stillAttached(page, element))) {
          throw new BrowseError(fill(TARGET_REPLACED, { action, target: element.label }), null, "target_replaced");
        }
        flagLost(needs);
        throw new BrowseError(fill(NOT_DELIVERED, { action, missing: names.join("/").replaceAll("|", "/") }), { missing }, "input_not_delivered");
      }
      throw new OutcomeUnknown(action.toLowerCase(), fill(PARTLY_DELIVERED, { missing: listed }));
    }
    await sleep(POLL);
  }
}

export function mouseButton(name: string | null | undefined): string {
  const button = (name || "left").toLowerCase();
  if (!["left", "right", "middle"].includes(button)) throw new BrowseError(`Unknown mouse button: ${button} (left, right or middle)`);
  return button;
}

export async function viewport(page: Page, frame: string | null = null): Promise<Viewport> {
  return asRecord(await page.call("() => ardiaBrowse.viewport()", [], { frame: frame || page.mainFrame, read: true })) as unknown as Viewport;
}

export type Rect = { x: number; y: number; width: number; height: number };

export async function rect(page: Page, element: Element): Promise<Rect> {
  return asRecord(await page.call("(el) => ardiaBrowse.rect(el)", [element], { frame: element.frame })) as unknown as Rect;
}

export async function overFrame(page: Page, x: number, y: number): Promise<boolean> {
  let node: Record<string, unknown>;
  try {
    const hit = await page.send("DOM.getNodeForLocation", { x: roundHalfEven(x), y: roundHalfEven(y), includeUserAgentShadowDOM: false });
    if (hit["frameId"] && hit["frameId"] !== page.mainFrame) {
      flag("input_in_inner_frame", true);
      return true;
    }
    if (!Object.hasOwn(hit, "backendNodeId")) throw new KeyMissing();
    node = record((await page.send("DOM.describeNode", { backendNodeId: hit["backendNodeId"] }))["node"]);
  } catch (error) {
    if (!(error instanceof CdpError) && !(error instanceof KeyMissing)) throw error;
    return Boolean(await page.call("(x, y) => ardiaBrowse.overFrame(x, y)", [x, y], { frame: page.mainFrame, read: true }));
  }
  if (FRAME_OWNERS.has(String(node["nodeName"]))) {
    flag("input_in_inner_frame", true);
    return true;
  }
  return false;
}

class KeyMissing extends Error {}

export async function poll<T>(check: () => Promise<T>, timeout: number): Promise<T> {
  const deadline = monotonic() + timeout;
  for (;;) {
    const found = await check();
    if (found || monotonic() >= deadline) return found;
    await sleep(POLL);
  }
}

export async function pollTimes<T>(check: () => Promise<T>, checks: number): Promise<T> {
  for (let round = 1; ; round += 1) {
    const found = await check();
    if (found || round >= checks) return found;
    await sleep(POLL);
  }
}

export function pyInt(value: number): number {
  return Math.trunc(value);
}
