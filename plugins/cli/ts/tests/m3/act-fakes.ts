import { Cancelled, sleep } from "../../src/browse/cdp/cancel.ts";
import { BrowseError, CdpError, Gated } from "../../src/browse/daemon-errors.ts";
import { Input } from "../../src/browse/input/input.ts";
import { Element, type Page } from "../../src/browse/state/page.ts";

export const QUADS: Record<number, number[]> = { 1: [10, 10, 110, 10, 110, 40, 10, 40], 2: [10, 200, 110, 200, 110, 230, 10, 230] };

type Options = {
  draggable?: boolean;
  startsDrag?: boolean;
  refused?: string[];
  failing?: string[];
  delays?: Record<string, number>;
  hidden?: boolean;
};

export class FakeRenderer {
  readonly mainFrame = "F";
  readonly frames = new Map([["F", { id: "F", url: "", loader: "L", parent: null, name: "", origin: "" }]]);
  readonly sent: [string, unknown][] = [];
  readonly params: [string, Record<string, unknown>][] = [];
  readonly counts: Record<string, number> = { mousedown: 0, mouseup: 0, mousemove: 0, dragstart: 0, dragend: 0, drop: 0, keydown: 0, keyup: 0 };
  readonly draggable: boolean;
  readonly startsDrag: boolean;
  readonly refused: Set<string>;
  readonly failing: Set<string>;
  readonly delays: Record<string, number>;
  dragIntercepted: ((data: Record<string, unknown>) => void) | null = null;
  dragging = false;
  hiddenTab: boolean;
  sessionId = "S";
  readonly session = "S";
  readonly input: Input;
  readonly browser = { alive: true, send: (method: string, params: Record<string, unknown> | null) => this.send(method, params) };
  readonly state = { leases: new Set<string>(), tabId: () => "t3", consentDismissed: null, clickNote: null, refForNode: () => "e9" };

  constructor(options: Options = {}) {
    this.draggable = options.draggable ?? true;
    this.startsDrag = options.startsDrag ?? true;
    this.refused = new Set(options.refused ?? []);
    this.failing = new Set(options.failing ?? []);
    this.delays = options.delays ?? {};
    this.hiddenTab = options.hidden ?? false;
    this.input = new Input(this as unknown as Page);
    this.input.bind(null);
    this.input.pointer.position = [300, 300];
  }

  get page(): Page {
    return this as unknown as Page;
  }

  loader(frame: string | null): string | null {
    return frame === null ? null : (this.frames.get(frame)?.loader ?? null);
  }

  async refreshFrames(): Promise<unknown> {
    return this.frames;
  }

  async requireVisible(): Promise<void> {
    if (this.hiddenTab) throw new BrowseError("hidden", null, "tab_hidden");
  }

  async hidden(): Promise<boolean> {
    return false;
  }

  async takesInput(): Promise<boolean> {
    return true;
  }

  async focusElement(): Promise<void> {
    this.sent.push(["DOM.focus", null]);
  }

  async call(fn: string, args: unknown[] = []): Promise<unknown> {
    if (fn.includes("inputWatch")) return { ...this.counts, activeFrame: false };
    if (fn.includes("draggable")) return this.draggable;
    if (fn.includes("ardiaBrowse.info")) return { connected: true };
    if (fn.includes("ardiaBrowse.rect")) {
      const quad = QUADS[(args[0] as Element).backendId] as number[];
      return { x: quad[0], y: quad[1], width: (quad[2] as number) - (quad[0] as number), height: (quad[5] as number) - (quad[1] as number) };
    }
    if (fn.includes("ardiaBrowse.viewport")) return { width: 1280, height: 800, scrollX: 0, scrollY: 0, docWidth: 1280, docHeight: 800 };
    return null;
  }

  async send(method: string, given: Record<string, unknown> | null = null): Promise<Record<string, unknown>> {
    const params = { ...(given ?? {}) };
    const kind = params["type"];
    const key = `${method} ${String(kind ?? params["enabled"])}`;
    const delay = this.delays[key];
    if (delay !== undefined) await sleep(delay);
    if (this.failing.has(key)) throw new CdpError(method, "boom");
    if (this.refused.has(method)) throw new Gated(method);
    this.sent.push([method, kind !== undefined ? kind : params["enabled"]]);
    this.params.push([method, params]);
    if (method === "DOM.getContentQuads") return { quads: [QUADS[params["backendNodeId"] as number]] };
    if (method === "Input.dispatchKeyEvent") {
      if (kind === "keyDown" || kind === "rawKeyDown") this.counts["keydown"] = (this.counts["keydown"] as number) + 1;
      if (kind === "keyUp") this.counts["keyup"] = (this.counts["keyup"] as number) + 1;
    }
    if (method === "Input.dispatchMouseEvent") {
      if (kind === "mousePressed") this.counts["mousedown"] = (this.counts["mousedown"] as number) + 1;
      else if (kind === "mouseMoved" && params["buttons"] && !this.dragging) {
        if (this.draggable && this.startsDrag) {
          this.dragging = true;
          this.counts["dragstart"] = (this.counts["dragstart"] as number) + 1;
          const waiter = this.dragIntercepted;
          if (waiter !== null) {
            this.dragIntercepted = null;
            waiter({ items: [{ mimeType: "text/plain", data: "a" }], dragOperationsMask: 16 });
          }
        }
      } else if (kind === "mouseReleased" && !this.dragging) this.counts["mouseup"] = (this.counts["mouseup"] as number) + 1;
    }
    if (method === "Input.dispatchDragEvent" && (kind === "drop" || kind === "dragCancel")) {
      this.dragging = false;
      this.counts["dragend"] = (this.counts["dragend"] as number) + 1;
      if (kind === "drop") this.counts["drop"] = (this.counts["drop"] as number) + 1;
    }
    return {};
  }

  calls(): [string, unknown][] {
    return this.sent.filter(([method]) => method.startsWith("Input."));
  }
}

export function ends(): [Element, Element] {
  return [new Element("F", "S", 1, "@e1"), new Element("F", "T", 2, "@e2")];
}

export async function cancelAfter<T>(work: (signal: AbortSignal) => Promise<T>, until: () => boolean, extra = 0.05): Promise<unknown> {
  const controller = new AbortController();
  const running = work(controller.signal).then(
    () => null,
    (error: unknown) => error,
  );
  for (let round = 0; round < 500 && !until(); round += 1) await sleep(0.01, null);
  await sleep(extra, null);
  controller.abort(new Cancelled());
  return running;
}
