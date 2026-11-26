import { untilCancelled } from "../cdp/cancel.ts";
import { BrowseError, OutcomeUnknown } from "../daemon-errors.ts";
import { flag } from "../metrics.ts";
import { appCall, appTabMap, controlCall, ControlRefused, controlSocket, MethodUnknown, NotConnected, WINDOWS_TIMEOUT } from "./apptabs.ts";
import { DOCUMENT_CHANGED, type Page } from "./page.ts";
import { record } from "./records.ts";
import type { State } from "./state.ts";

export const TAB_DIAGNOSTICS_METHOD = "tabs.diagnostics";
export const TAB_INPUT_METHOD = "tabs.input";
export const MAX_DIAGNOSTICS_LIMIT = 500;
export const MAX_DIAGNOSTICS_PAGES = 10;
export const MAX_NATIVE_COORDINATE = 100_000;
export const MAX_NATIVE_WHEEL_DELTA = 10_000;
export const MAX_NATIVE_TEXT_LENGTH = 4096;
const DIAGNOSTICS_TIMEOUT = 10;
const INPUT_TIMEOUT = 15;
const ENGINE_MISSING = "This Ardia's engine can't do that yet; update Ardia.";
const PAGE_CHANGED = "The tab's page or focused frame changed after prime, so nothing was sent.";
const EXACT_PRE_DISPATCH_FAILED = new Set([
  ENGINE_MISSING,
  "Too many inputs are waiting for this tab; try again.",
  "A press or release is still reaching this tab; wait for its answer and send this again.",
  "That tab has no page loaded.",
  "That tab's page isn't loaded or has no size yet.",
  "The tab's page didn't draw a frame within 1 s, so it can't take input yet; try again.",
  "The tab's page stopped drawing after prime, so nothing was sent; try again.",
]);
const KEY_NAME = /^[A-Z][A-Za-z0-9]{1,31}$/u;
const CODE_NAME = /^[A-Z][A-Za-z0-9]{1,31}$/u;
const NATIVE_BUTTONS = new Set(["left", "middle"]);

export type TabCapabilities = { diagnostics: boolean; input: boolean };

export type DiagnosticConsoleRow = {
  seq: number;
  time: number;
  level: string;
  kind: string;
  message: string;
  source: string;
  line: number;
  frame: string;
  clipped?: boolean;
};

export type DiagnosticNetworkRow = {
  seq: number;
  time: number;
  method: string;
  url: string;
  status: number;
  type: string;
  frame: string;
  durationMs?: number;
  error?: string;
  failed: boolean;
  cached?: boolean;
};

export type TabDiagnostics = {
  tab: string;
  nextSeq: number;
  cleared?: boolean;
  console: DiagnosticConsoleRow[];
  network: DiagnosticNetworkRow[];
  dropped: number;
  more: boolean;
};

export type DiagnosticsQuery = {
  since?: number;
  kind?: "all" | "console" | "network";
  onlyErrors?: boolean;
  limit?: number;
  clear?: boolean;
};

export type PageWatermarks = {
  consoleSince: number;
  consoleClearedAt: number | null;
  cdpClearedAt: number | null;
  networkSince: number;
};

const resolvedCaps = new WeakMap<State, TabCapabilities>();
const inflightCaps = new WeakMap<State, Promise<TabCapabilities | null>>();
const disabled = new WeakMap<State, Set<"diagnostics" | "input">>();
const watermarks = new WeakMap<Page, PageWatermarks>();

export function watermarksOf(page: Page): PageWatermarks {
  let entry = watermarks.get(page);
  if (entry === undefined) {
    entry = { consoleSince: 0, consoleClearedAt: null, cdpClearedAt: null, networkSince: 0 };
    watermarks.set(page, entry);
  }
  return entry;
}

export function disableTabTool(state: State, tool: "diagnostics" | "input"): void {
  let set = disabled.get(state);
  if (set === undefined) {
    set = new Set();
    disabled.set(state, set);
  }
  set.add(tool);
}

function isDisabled(state: State, tool: "diagnostics" | "input"): boolean {
  return disabled.get(state)?.has(tool) ?? false;
}

function unsupported(error: unknown): boolean {
  if (error instanceof MethodUnknown) return true;
  return error instanceof ControlRefused && error.code === "failed" && error.message.trim() === ENGINE_MISSING;
}

function preDispatchRefusal(error: ControlRefused): boolean {
  if (error instanceof NotConnected || error instanceof MethodUnknown) return true;
  if (error.code === "unsafe" || error.code === "refused" || error.code === "bad_request") return true;
  return error.code === "failed" && EXACT_PRE_DISPATCH_FAILED.has(error.message.trim());
}

export async function tabCapabilities(state: State): Promise<TabCapabilities> {
  const file = controlSocket(state);
  if (file === null) return { diagnostics: false, input: false };
  let found = resolvedCaps.get(state);
  if (found === undefined) {
    let pending = inflightCaps.get(state);
    if (pending === undefined) {
      pending = (async () => {
        try {
          const listed = await controlCall(file, state.caller, "methods", null, WINDOWS_TIMEOUT, null);
          if (!Array.isArray(listed)) return null;
          const names = new Set<string>();
          for (const item of listed) {
            const name = record(item)["name"];
            if (typeof name === "string") names.add(name);
          }
          const caps = { diagnostics: names.has(TAB_DIAGNOSTICS_METHOD), input: names.has(TAB_INPUT_METHOD) };
          resolvedCaps.set(state, caps);
          return caps;
        } catch (error) {
          if (error instanceof MethodUnknown) {
            const none = { diagnostics: false, input: false };
            resolvedCaps.set(state, none);
            return none;
          }
          if (error instanceof ControlRefused) return null;
          throw error;
        } finally {
          if (inflightCaps.get(state) === pending) inflightCaps.delete(state);
        }
      })();
      inflightCaps.set(state, pending);
    }
    const probed = await untilCancelled(pending);
    if (probed === null) return { diagnostics: false, input: false };
    found = probed;
  }
  return {
    diagnostics: found.diagnostics && !isDisabled(state, "diagnostics"),
    input: found.input && !isDisabled(state, "input"),
  };
}

export async function appTabOf(state: State, page: Page): Promise<string | null> {
  if (!state.targetInfos.has(page.targetId)) return null;
  const known = state.appTabOf(page.targetId);
  if (known) return known;
  try {
    return (await appTabMap(state)).get(page.targetId) ?? null;
  } catch (error) {
    if (error instanceof ControlRefused) return null;
    throw error;
  }
}

export async function canUseNativeInput(page: Page): Promise<boolean> {
  if (page.crashed) return false;
  const caps = await tabCapabilities(page.state);
  if (!caps.input) return false;
  return (await appTabOf(page.state, page)) !== null;
}

export async function readTabDiagnostics(state: State, page: Page, query: DiagnosticsQuery = {}): Promise<TabDiagnostics | null> {
  const caps = await tabCapabilities(state);
  if (!caps.diagnostics) return null;
  const tab = await appTabOf(state, page);
  if (tab === null) return null;
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? MAX_DIAGNOSTICS_LIMIT), 1), MAX_DIAGNOSTICS_LIMIT);
  const consoleRows: DiagnosticConsoleRow[] = [];
  const networkRows: DiagnosticNetworkRow[] = [];
  let cursor = query.since !== undefined && query.since > 0 ? query.since : 0;
  let nextSeq = cursor;
  let dropped = 0;
  let more = false;
  let resolvedTab = tab;
  try {
    for (let round = 0; round < MAX_DIAGNOSTICS_PAGES; round += 1) {
      const params: Record<string, unknown> = { tab, limit };
      if (cursor > 0) params["since"] = cursor;
      if (query.kind !== undefined) params["kind"] = query.kind;
      if (query.onlyErrors === true) params["onlyErrors"] = true;
      const raw = record(await appCall(state, TAB_DIAGNOSTICS_METHOD, params, DIAGNOSTICS_TIMEOUT));
      if (typeof raw["tab"] === "string") resolvedTab = raw["tab"];
      if (Array.isArray(raw["console"])) consoleRows.push(...(raw["console"] as DiagnosticConsoleRow[]));
      if (Array.isArray(raw["network"])) networkRows.push(...(raw["network"] as DiagnosticNetworkRow[]));
      if (typeof raw["dropped"] === "number") dropped += raw["dropped"];
      const advanced = typeof raw["nextSeq"] === "number" ? raw["nextSeq"] : nextSeq;
      more = raw["more"] === true;
      nextSeq = Math.max(nextSeq, advanced);
      if (!more || advanced <= cursor) break;
      cursor = advanced;
    }
    flag("tab_diagnostics_used", true);
    return { tab: resolvedTab, nextSeq, console: consoleRows, network: networkRows, dropped, more };
  } catch (error) {
    if (unsupported(error)) {
      disableTabTool(state, "diagnostics");
      return null;
    }
    if (error instanceof ControlRefused) return null;
    throw error;
  }
}

function validCoordinate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_NATIVE_COORDINATE;
}

function validKeyName(key: string): boolean {
  if (!key || key.length > 32 || !key.isWellFormed()) return false;
  const points = [...key];
  if (points.length === 1) {
    const point = points[0]!.codePointAt(0)!;
    return point >= 0x20 && point !== 0x7f && !(point >= 0x80 && point <= 0x9f) && point !== 0x2028 && point !== 0x2029 && point !== 0xfeff;
  }
  return KEY_NAME.test(key);
}

async function pinchZoomed(page: Page): Promise<boolean> {
  if (page.session === null) return true;
  try {
    const scale = await page.call("() => (window.visualViewport ? window.visualViewport.scale : null)", [], { frame: page.mainFrame, read: true });
    return typeof scale !== "number" || !Number.isFinite(scale) || scale !== 1;
  } catch {
    return true;
  }
}

async function sendTabInput(page: Page, actionLabel: string, params: Record<string, unknown>, expectSent = false): Promise<boolean> {
  if (page.crashed) return false;
  const caps = await tabCapabilities(page.state);
  if (!caps.input) return false;
  const tab = await appTabOf(page.state, page);
  if (tab === null) return false;
  try {
    const reply = record(await appCall(page.state, TAB_INPUT_METHOD, { tab, ...params }, INPUT_TIMEOUT));
    const ok = expectSent ? reply["sent"] === true : reply["acked"] === true;
    if (ok) {
      flag("tab_input_used", true);
      return true;
    }
    throw new OutcomeUnknown(actionLabel, `Ardia sent the ${actionLabel}, but the renderer didn't acknowledge it in time`);
  } catch (error) {
    if (unsupported(error)) {
      disableTabTool(page.state, "input");
      return false;
    }
    if (error instanceof ControlRefused) {
      if (error.code === "failed" && error.message.trim() === PAGE_CHANGED) {
        throw new BrowseError(DOCUMENT_CHANGED, null, "document_changed");
      }
      if (preDispatchRefusal(error)) return false;
      throw new OutcomeUnknown(actionLabel, error.message);
    }
    throw error;
  }
}

export async function nativeMouseClick(page: Page, x: number, y: number, button: string, clickCount = 1): Promise<boolean> {
  if (page.frameSessions.size > 0) return false;
  if (!validCoordinate(x) || !validCoordinate(y) || !NATIVE_BUTTONS.has(button) || (clickCount !== 1 && clickCount !== 2)) return false;
  if (!(await canUseNativeInput(page))) return false;
  if (await pinchZoomed(page)) return false;
  const action = clickCount === 2 ? "dblclick" : "click";
  return sendTabInput(page, action, { action, x, y, button });
}

export async function nativeMouseMove(page: Page, x: number, y: number): Promise<boolean> {
  if (page.frameSessions.size > 0) return false;
  if (!validCoordinate(x) || !validCoordinate(y)) return false;
  if (!(await canUseNativeInput(page))) return false;
  if (await pinchZoomed(page)) return false;
  return sendTabInput(page, "mouse move", { action: "move", x, y });
}

export async function nativeWheel(page: Page, x: number, y: number, deltaX: number, deltaY: number): Promise<boolean> {
  if (page.frameSessions.size > 0) return false;
  if (!validCoordinate(x) || !validCoordinate(y)) return false;
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || (deltaX === 0 && deltaY === 0)) return false;
  if (Math.abs(deltaX) > MAX_NATIVE_WHEEL_DELTA || Math.abs(deltaY) > MAX_NATIVE_WHEEL_DELTA) return false;
  if (!(await canUseNativeInput(page))) return false;
  if (await pinchZoomed(page)) return false;
  return sendTabInput(page, "wheel scroll", { action: "wheel", x, y, deltaX, deltaY });
}

export async function nativeKey(page: Page, key: string, code?: string): Promise<boolean> {
  if (!validKeyName(key)) return false;
  if (key === "ContextMenu" || code === "ContextMenu") return false;
  const cleanCode = code !== undefined && CODE_NAME.test(code) ? code : undefined;
  return sendTabInput(page, "key press", { action: "key", key, ...(cleanCode !== undefined ? { code: cleanCode } : {}) });
}

export async function nativeText(page: Page, text: string): Promise<boolean> {
  if (!text || text.length > MAX_NATIVE_TEXT_LENGTH || !text.isWellFormed() || text.includes("\0")) return false;
  return sendTabInput(page, "text insert", { action: "text", text }, true);
}
