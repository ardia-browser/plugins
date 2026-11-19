import { formatG } from "../../../pylib/format.ts";
import { type Browser, type CdpResult, isMutation } from "../../cdp/browser.ts";
import { Cancelled, sleep } from "../../cdp/cancel.ts";
import { BrowseError, CdpError, CdpTimeout, Gated, OutcomeUnknown, PageBusy } from "../../daemon-errors.ts";
import { LIBRARY } from "../../js/index.ts";
import { flag } from "../../metrics.ts";
import type { StubState } from "./state.ts";

export const WORLD_NAME = "ardia-browse";
export const LIVE_WAIT = 0.5;
export const CRASH_PROBE = 5.0;
export const BUSY_PROBE = 3.0;
export const BUSY_MEMORY = 120.0;
export const DETACHED =
  "Ardia detached this tab from the ardia command while it was in use (the tab closed, crashed, went to sleep or moved to a window Ardia keeps for itself). Run the command again";
export const CRASHED = "This tab's page crashed. `ardia browse reload` brings it back; `ardia browse close` or `tab close` closes it";
const BUSY_WHY = (probe: number) =>
  `the page's own scripts are keeping its tab busy, so it isn't answering. While it stays that way, commands on this tab give up after ${formatG(probe)} s instead of waiting; \`ardia browse reload\` it, or work from a lighter page (search results, the site's own API, or \`read --http <url>\`)`;
const CRASH_SAFE = new Set(["Inspector.enable", "Page.reload", "Page.navigate"]);
const OTHER_WORLD = "same JavaScript world";
const STALE_CONTEXT = ["Cannot find context", "Execution context was destroyed", "Cannot find default execution context", "Inspected target navigated"];

export type Frame = { id: string; url: string; loader: string | null; parent: string | null; name: string; origin: string };
type Lifecycle = { loader: string | null; names: Set<string> };

function monotonic(): number {
  return performance.now() / 1000;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function frameOf(frame: Record<string, unknown>, parent: string | null): Frame {
  return {
    id: String(frame["id"]),
    url: String(frame["url"] ?? "") + String(frame["urlFragment"] ?? ""),
    loader: typeof frame["loaderId"] === "string" ? frame["loaderId"] : null,
    parent,
    name: typeof frame["name"] === "string" && frame["name"] ? frame["name"] : "",
    origin: typeof frame["securityOrigin"] === "string" && frame["securityOrigin"] ? frame["securityOrigin"] : "",
  };
}

export class StubPage {
  sessionId: string | null = null;
  browser: Browser | null = null;
  frames = new Map<string, Frame>();
  mainFrame: string | null = null;
  readonly worlds = new Map<string, [string | null, number]>();
  readonly lifecycle = new Map<string, Lifecycle>();
  dialog: Record<string, unknown> | null = null;
  url = "";
  crashed = false;
  needsEnable = false;
  awake = false;
  attaches = 0;
  navigations = 0;
  unansweredAt = 0;
  private readonly calls = new Set<AbortController>();
  readonly input = { holding: false };

  constructor(
    readonly state: StubState,
    readonly targetId: string,
  ) {}

  async attach(browser: Browser): Promise<void> {
    this.browser = browser;
    this.worlds.clear();
    let result: CdpResult;
    try {
      result = await browser.send("Target.attachToTarget", { targetId: this.targetId, flatten: true });
    } catch (error) {
      if (error instanceof Gated) {
        flag("attach_refused", true);
        throw error.during(null, null);
      }
      throw error;
    }
    this.sessionId = String(result["sessionId"]);
    this.state.sessions.set(this.sessionId, this);
    this.attaches += 1;
    const known = this.crashed;
    this.crashed = false;
    try {
      await this.send("Inspector.enable", null, { timeout: CRASH_PROBE });
    } catch (error) {
      if (error instanceof Gated) this.crashed = known;
      else if (!(error instanceof BrowseError)) throw error;
    }
    if (this.crashed) {
      this.needsEnable = true;
      return;
    }
    await this.enablePage();
  }

  async enablePage(): Promise<void> {
    await this.send("Page.enable");
    await this.send("Page.setLifecycleEventsEnabled", { enabled: true });
    await this.refreshFrames();
    if (this.awake || this.state.opened.has(this.targetId)) await this.keepAwake();
    try {
      await this.send("Page.getLayoutMetrics");
    } catch (error) {
      if (!(error instanceof BrowseError)) throw error;
    }
    this.needsEnable = false;
  }

  async keepAwake(): Promise<void> {
    const endpoint = this.state.endpoint;
    if (endpoint === null || !endpoint.explicit) return;
    try {
      await this.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    } catch (error) {
      if (error instanceof BrowseError) return;
      throw error;
    }
    this.awake = true;
    flag("tab_kept_awake", true);
  }

  async stillBusy(method: string): Promise<void> {
    try {
      await (this.browser as Browser).send("Runtime.evaluate", { expression: "1", returnByValue: true }, { session: this.sessionId, timeout: BUSY_PROBE });
    } catch (error) {
      if (error instanceof CdpTimeout) {
        flag("page_busy_fast_fail", true);
        throw new PageBusy(method, BUSY_PROBE, BUSY_WHY(BUSY_PROBE));
      }
      if (!(error instanceof BrowseError)) throw error;
    }
    this.unansweredAt = 0;
  }

  markCrashed(): void {
    this.crashed = true;
    this.worlds.clear();
    for (const call of this.calls) call.abort(new Cancelled());
  }

  detach(): void {
    if (this.sessionId) this.state.sessions.delete(this.sessionId);
    this.sessionId = null;
    this.worlds.clear();
    for (const call of this.calls) call.abort(new Cancelled());
  }

  async send(method: string, params: CdpResult | null = null, options: { timeout?: number; mutation?: boolean; inputEvent?: boolean } = {}): Promise<CdpResult> {
    if (this.sessionId === null) throw new BrowseError(DETACHED, null, "tab_detached");
    if (this.crashed && !CRASH_SAFE.has(method)) throw new BrowseError(CRASHED, null, "tab_crashed");
    if (this.unansweredAt && monotonic() - this.unansweredAt < BUSY_MEMORY) await this.stillBusy(method);
    const timeout = options.timeout ?? 30;
    const dropped = new AbortController();
    this.calls.add(dropped);
    const unknown = Boolean(options.inputEvent || options.mutation || isMutation(method));
    try {
      const sending = (this.browser as Browser).send(method, params, { session: this.sessionId, timeout });
      return await new Promise<CdpResult>((resolve, reject) => {
        dropped.signal.addEventListener("abort", () => reject(dropped.signal.reason), { once: true });
        sending.then(resolve, reject);
      });
    } catch (error) {
      if (error instanceof Cancelled && dropped.signal.aborted) {
        if (unknown) throw new OutcomeUnknown(`\`${method}\``, `Ardia detached the tab before it answered ${method}`);
        if (this.crashed) throw new BrowseError(CRASHED, null, "tab_crashed");
        throw new BrowseError(DETACHED, null, "tab_detached");
      }
      if (error instanceof CdpTimeout) {
        this.unansweredAt = monotonic();
        if (unknown) throw new OutcomeUnknown(`\`${method}\``, `Ardia didn't answer ${method} in ${formatG(timeout)}s after it was sent`);
        throw new PageBusy(method, timeout, BUSY_WHY(BUSY_PROBE));
      }
      throw error;
    } finally {
      this.calls.delete(dropped);
    }
  }

  async refreshFrames(): Promise<Map<string, Frame>> {
    const tree = record((await this.send("Page.getFrameTree"))["frameTree"]);
    const frames = new Map<string, Frame>();
    const walk = (node: Record<string, unknown>, parent: string | null) => {
      const frame = frameOf(record(node["frame"]), parent);
      frames.set(frame.id, frame);
      const children = node["childFrames"];
      for (const child of Array.isArray(children) ? children : []) walk(record(child), frame.id);
    };
    walk(tree, null);
    this.frames = frames;
    this.mainFrame = String(record(tree["frame"])["id"]);
    this.url = frames.get(this.mainFrame)?.url ?? "";
    return frames;
  }

  loader(frameId: string | null): string | null {
    return frameId === null ? null : (this.frames.get(frameId)?.loader ?? null);
  }

  async world(frameId: string | null = null): Promise<number> {
    const frame = frameId ?? this.mainFrame;
    if (frame === null || !this.frames.has(frame)) {
      await this.refreshFrames();
      if (frame === null || !this.frames.has(frame)) throw new BrowseError("That frame is gone. Run `ardia browse frame main` or snapshot again", null, "frame_gone");
    }
    const loader = this.loader(frame);
    const cached = this.worlds.get(frame);
    if (cached && cached[0] === loader) return cached[1];
    const result = await this.send("Page.createIsolatedWorld", { frameId: frame, worldName: WORLD_NAME });
    const context = Number(result["executionContextId"]);
    await this.send("Runtime.evaluate", { expression: LIBRARY, contextId: context, returnByValue: true });
    this.worlds.set(frame, [loader, context]);
    return context;
  }

  async call(fn: string, args: unknown[] = [], options: { frame?: string | null; timeout?: number; read?: boolean } = {}): Promise<unknown> {
    const frame = options.frame ?? this.mainFrame;
    for (const attempt of [0, 1]) {
      const context = await this.world(frame);
      const params = {
        functionDeclaration: fn,
        executionContextId: context,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      };
      let result: CdpResult;
      try {
        result = await this.send("Runtime.callFunctionOn", params, { timeout: options.timeout ?? 30, mutation: !options.read });
      } catch (error) {
        if (!(error instanceof CdpError)) throw error;
        const message = error.cdpMessage;
        if (!message.includes(OTHER_WORLD) && !STALE_CONTEXT.some((marker) => message.includes(marker))) throw error;
        this.worlds.delete(frame ?? (this.mainFrame as string));
        if (options.read && attempt === 0) {
          await this.refreshFrames();
          continue;
        }
        if (!options.read && message.includes("destroyed")) throw new OutcomeUnknown("the page script", "the page changed document while it ran");
        throw new BrowseError("The page changed document before this could run, so it wasn't applied; snapshot again", null, "document_changed");
      }
      if (Object.hasOwn(result, "exceptionDetails")) {
        const details = record(result["exceptionDetails"]);
        const description = String(record(details["exception"])["description"] || details["text"] || "error");
        throw new BrowseError(description.split("\n    at ")[0] as string, null, "page_script_error");
      }
      return record(result["result"])["value"];
    }
    throw new BrowseError("the page navigated while reading it; try again", null, "page_navigated");
  }

  async hidden(): Promise<boolean> {
    try {
      return Boolean(await this.call("() => document.visibilityState === 'hidden'", [], { frame: this.mainFrame, read: true }));
    } catch (error) {
      if (error instanceof BrowseError) return false;
      throw error;
    }
  }

  async takesInput(): Promise<boolean> {
    if (!(await this.hidden())) return true;
    const deadline = monotonic() + LIVE_WAIT;
    while (monotonic() < deadline) {
      await sleep(0.05);
      if (!(await this.hidden())) {
        this.state.backgroundLive = true;
        return true;
      }
    }
    if (this.state.backgroundLive === null) this.state.backgroundLive = false;
    return false;
  }

  onEvent(method: string, params: Record<string, unknown>): void {
    if (method === "Page.lifecycleEvent") {
      const frame = String(params["frameId"]);
      const loader = typeof params["loaderId"] === "string" ? params["loaderId"] : null;
      const name = String(params["name"]);
      let current = this.lifecycle.get(frame);
      if (!current || current.loader !== loader || name === "init") {
        current = { loader, names: new Set() };
        this.lifecycle.set(frame, current);
      }
      current.names.add(name);
    } else if (method === "Page.frameNavigated") {
      const raw = record(params["frame"]);
      const frameId = raw["id"];
      if (typeof frameId === "string" && frameId) {
        const parent = typeof raw["parentId"] === "string" ? raw["parentId"] : null;
        this.frames.set(frameId, frameOf(raw, parent));
        this.worlds.delete(frameId);
        if (!raw["parentId"]) {
          this.crashed = false;
          this.mainFrame = frameId;
          this.url = this.frames.get(frameId)?.url ?? "";
          this.navigations += 1;
        }
      }
    } else if (method === "Page.navigatedWithinDocument") {
      const frameId = String(params["frameId"]);
      const frame = this.frames.get(frameId);
      if (frame) {
        frame.url = String(params["url"] ?? "");
        if (frameId === this.mainFrame) this.url = frame.url;
      }
    } else if (method === "Page.frameDetached") {
      const frameId = String(params["frameId"]);
      this.frames.delete(frameId);
      this.worlds.delete(frameId);
    } else if (method === "Page.javascriptDialogOpening") {
      this.dialog = { ...params };
      if (this.state.autoDialog && (params["type"] === "alert" || params["type"] === "beforeunload")) {
        this.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      }
    } else if (method === "Page.javascriptDialogClosed") {
      this.dialog = null;
    }
  }
}
