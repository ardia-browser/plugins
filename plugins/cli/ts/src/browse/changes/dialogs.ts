import { headPoints } from "../../pylib/str.ts";
import { redact } from "../../redact.ts";
import { currentSignal, later, sleep, withSignal } from "../cdp/cancel.ts";
import { BrowseError } from "../daemon-errors.ts";
import { add, flag } from "../metrics.ts";
import type { Page } from "../state/page.ts";
import type { Json } from "../state/records.ts";
import { parseRef } from "../state/refs.ts";
import type { Listener, State } from "../state/state.ts";
import { monotonic } from "../state/wait.ts";

export const AUTO_HANDLED = new Set(["alert", "beforeunload"]);
export const AUTO_GRACE = 0.3;
export const CLEANUP_WAIT = 3.0;
export const DIALOG_POLL = 0.05;
export const MESSAGE_SHOWN = 200;
export const DOWNLOADS_KEPT = 8;

export type DialogSeen = { type: string; message: string; handled: "auto_accepted" | "open" | "closed" };
export type DownloadSeen = { guid: string; name: string; state: string };

function text(value: unknown): string {
  return headPoints(redact(String(value ?? "").replace(/\s+/gu, " ").trim()), MESSAGE_SHOWN);
}

export function autoHandled(state: Pick<State, "autoDialog">, type: unknown): boolean {
  return state.autoDialog && AUTO_HANDLED.has(String(type));
}

export function dialogAdvice(dialog: Json): string {
  const type = String(dialog["type"] ?? "dialog");
  const answer = type === "prompt" ? "`ardia browse dialog accept <text>`" : "`ardia browse dialog accept`";
  return `answer it with ${answer} or \`ardia browse dialog dismiss\`, then go on`;
}

export class DialogBlocked extends BrowseError {
  constructor(dialog: Json, action: string, landed: boolean) {
    const type = String(dialog["type"] ?? "dialog");
    const message = text(dialog["message"]);
    const shown = message ? ` saying "${message}"` : "";
    const lead = landed
      ? `${action} opened a JavaScript ${type} dialog${shown}, and the page is frozen until it's answered`
      : `A JavaScript ${type} dialog${shown} is open on this tab, and the page is frozen until it's answered, so ${action} wasn't sent`;
    super(
      `${lead}. Nothing answers it automatically: ${dialogAdvice(dialog)}`,
      { dialog: { type, message, defaultPrompt: dialog["defaultPrompt"] ?? null }, landed },
      "dialog_blocked",
    );
  }
}

function noteBlocked(): void {
  flag("dialog_blocked_action", true);
  add("dialog_blocked_actions");
}

export function blocking(page: Page): Json | null {
  return page.dialog ?? null;
}

export async function refuseIfDialog(page: Page, action: string): Promise<void> {
  let dialog = blocking(page);
  if (dialog === null) return;
  if (autoHandled(page.state, dialog["type"])) {
    const deadline = monotonic() + AUTO_GRACE;
    while (blocking(page) !== null && monotonic() < deadline) await sleep(DIALOG_POLL);
    dialog = blocking(page);
    if (dialog === null) return;
  }
  noteBlocked();
  throw new DialogBlocked(dialog, action, false);
}

export function pageForSelector(state: State, selector: string | null): Page | null {
  const id = selector === null ? null : parseRef(selector);
  const target = id !== null ? (state.refs.get(id)?.target ?? state.current) : state.current;
  return target === null ? null : (state.pages.get(target) ?? null);
}

export async function refuseIfDialogFor(state: State, selector: string | null, action: string): Promise<void> {
  const page = pageForSelector(state, selector);
  if (page !== null) await refuseIfDialog(page, action);
}

export function openDialog(state: State): Json | null {
  for (const page of state.pages?.values() ?? []) {
    const dialog = page.dialog;
    if (dialog !== null && !autoHandled(state, dialog["type"])) return dialog;
  }
  return null;
}

export type Outcome<T> = { value: T } | { error: unknown };

function settle<T>(work: Promise<T>): Promise<Outcome<T>> {
  return work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

export async function cleanupWithin(outcome: Promise<unknown>, seconds: number): Promise<boolean> {
  let stop = () => {};
  const timer = new Promise<boolean>((resolve) => {
    stop = later(seconds * 1000, () => resolve(false));
  });
  try {
    return await Promise.race([outcome.then(() => true), timer]);
  } finally {
    stop();
  }
}

export async function raceDialog<T>(page: Page, run: () => Promise<T>, action: string, landed = true): Promise<T> {
  const parent = currentSignal();
  const child = new AbortController();
  const forward = () => child.abort();
  if (parent !== null) {
    if (parent.aborted) child.abort();
    else parent.addEventListener("abort", forward, { once: true });
  }
  let latched: Json | null = null;
  let trip: () => void = () => {};
  const tripped = new Promise<null>((resolve) => {
    trip = () => resolve(null);
  });
  const latch = (dialog: Json | null) => {
    if (latched !== null || dialog === null || dialog === undefined || autoHandled(page.state, dialog["type"])) return;
    latched = { ...dialog };
    child.abort();
    trip();
  };
  const listener: Listener = (eventPage, method, params) => {
    if (eventPage === page && method === "Page.javascriptDialogOpening") latch(params);
  };
  const listeners = page.state?.listeners ?? [];
  listeners.push(listener);
  const poll = setInterval(() => latch(blocking(page)), DIALOG_POLL * 1000);
  try {
    const outcome = settle(withSignal(child.signal, run));
    const first = await Promise.race([outcome, tripped]);
    if (latched === null && first !== null) {
      if ("error" in first) throw first.error;
      return first.value;
    }
    if (!(await cleanupWithin(outcome, CLEANUP_WAIT))) flag("dialog_cleanup_unconfirmed", true);
    noteBlocked();
    throw new DialogBlocked(latched as unknown as Json, action, landed);
  } finally {
    clearInterval(poll);
    const at = listeners.indexOf(listener);
    if (at >= 0) listeners.splice(at, 1);
    parent?.removeEventListener("abort", forward);
  }
}

export class ReceiptWatch {
  readonly dialogs: DialogSeen[] = [];
  readonly downloads = new Map<string, DownloadSeen>();
  readonly listener: Listener = (eventPage, method, params) => this.onEvent(eventPage, method, params);
  private attached = false;

  constructor(readonly page: Page) {}

  private mine(eventPage: Page | null, params: Json): boolean {
    if (eventPage === this.page) return true;
    if (eventPage !== null) return false;
    const frame = params["frameId"];
    return typeof frame === "string" && this.page.frames.has(frame);
  }

  private onEvent(eventPage: Page | null, method: string, params: Json): void {
    if (method === "Page.javascriptDialogOpening" && eventPage === this.page) {
      const type = String(params["type"] ?? "dialog");
      this.dialogs.push({ type, message: text(params["message"]), handled: autoHandled(this.page.state, type) ? "auto_accepted" : "open" });
      return;
    }
    if (method === "Page.javascriptDialogClosed" && eventPage === this.page) {
      const last = this.dialogs.at(-1);
      if (last !== undefined && last.handled === "open") last.handled = "closed";
      return;
    }
    if ((method === "Browser.downloadWillBegin" || method === "Page.downloadWillBegin") && this.mine(eventPage, params)) {
      const guid = String(params["guid"] ?? "");
      if (guid && this.downloads.size < DOWNLOADS_KEPT) this.downloads.set(guid, { guid, name: text(params["suggestedFilename"] || "download"), state: "inProgress" });
      return;
    }
    if (method === "Browser.downloadProgress" || method === "Page.downloadProgress") {
      const seen = this.downloads.get(String(params["guid"] ?? ""));
      if (seen !== undefined && typeof params["state"] === "string") seen.state = params["state"];
    }
  }

  start(): void {
    if (this.attached) return;
    this.attached = true;
    this.page.state.listeners.push(this.listener);
  }

  stop(): void {
    if (!this.attached) return;
    this.attached = false;
    const listeners = this.page.state.listeners;
    const at = listeners.indexOf(this.listener);
    if (at >= 0) listeners.splice(at, 1);
  }

  receipt(): { dialogs: DialogSeen[]; downloads: DownloadSeen[] } {
    const dialogs = this.dialogs.map((seen) => ({ ...seen }));
    const open = this.page.dialog;
    if (open !== null && !dialogs.some((seen) => seen.handled === "open")) {
      dialogs.push({ type: String(open["type"] ?? "dialog"), message: text(open["message"]), handled: "open" });
    }
    if (dialogs.length > 0) flag("dialog_in_receipt", true);
    if (this.downloads.size > 0) flag("download_in_receipt", true);
    return { dialogs, downloads: [...this.downloads.values()].map((seen) => ({ ...seen })) };
  }
}

export function dialogLine(seen: DialogSeen): string {
  const said = seen.message ? ` "${seen.message}"` : "";
  if (seen.handled === "auto_accepted") return `! ${seen.type} dialog${said} (accepted automatically; --no-auto-dialog leaves these for you to answer)`;
  if (seen.handled === "closed") return `! ${seen.type} dialog${said} (opened and was closed)`;
  return `! ${seen.type} dialog${said} is open: ${dialogAdvice({ type: seen.type })}`;
}

export function downloadLine(seen: DownloadSeen): string {
  const state = seen.state === "inProgress" ? "in progress" : seen.state;
  return `↓ download "${seen.name}" (${state})`;
}
