import { formatG } from "../../pylib/format.ts";
import { type Browser, type CdpResult, DETACH_WAIT, isMutation } from "../cdp/browser.ts";
import { Cancelled, currentSignal, sleep } from "../cdp/cancel.ts";
import { BrowseError, CdpError, CdpTimeout, ConnectionLost, Gated, NotFocusable, OutcomeUnknown, PageBusy } from "../daemon-errors.ts";
import { LIBRARY, PAGE_FOCUS_INSIDE } from "../js/index.ts";
import { flag } from "../metrics.ts";
import { whereAppHas } from "./apptabs.ts";
import * as oopif from "./oopif.ts";
import { CONSOLE_LIMIT, consoleEntry, ERROR_LIMIT, errorEntry, type Json, NetworkLog, record, Ring } from "./records.ts";
import type { State } from "./state.ts";
import { monotonic, waitUntil } from "./wait.ts";

export const WORLD_NAME = "ardia-browse";
export const LIVE_WAIT = 0.5;
export const CRASH_PROBE = 5.0;
export const BUSY_PROBE = 3.0;
export const BUSY_MEMORY = 120.0;
export const HIDDEN_TAB =
  "[{tab}] is a background tab, and this Ardia doesn't deliver mouse or keyboard input to background tabs. use: ardia browse tab {tab} --show (or open <url> --show)";
export const DETACHED =
  "Ardia detached this tab from the ardia command while it was in use (the tab closed, crashed, went to sleep or moved to a window Ardia keeps for itself). Run the command again";
export const CRASHED = "This tab's page crashed. `ardia browse reload` brings it back; `ardia browse close` or `tab close` closes it";
export const SETUP_NAMES: Readonly<Record<string, string>> = {
  "Emulation.setDeviceMetricsOverride": "the viewport or device size",
  "Emulation.setTouchEmulationEnabled": "touch emulation",
  "Emulation.setUserAgentOverride": "the device user agent",
  "Emulation.setGeolocationOverride": "the geolocation",
  "Emulation.setEmulatedMedia": "the emulated media",
  "Network.emulateNetworkConditions": "offline mode",
  "Network.setExtraHTTPHeaders": "the extra headers",
};
export const ROUTE_PATTERNS = [{ urlPattern: "*", requestStage: "Request" }];
const BUSY_WHY = (probe: number) =>
  `the page's own scripts are keeping its tab busy, so it isn't answering. While it stays that way, commands on this tab give up after ${formatG(probe)} s instead of waiting; \`ardia browse reload\` it, or work from a lighter page (search results, the site's own API, or \`read --http <url>\`)`;
const CRASH_SAFE = new Set(["Inspector.enable", "Page.reload", "Page.navigate"]);
const OTHER_WORLD = "same JavaScript world";
const STALE_CONTEXT = ["Cannot find context", "Execution context was destroyed", "Cannot find default execution context", "Inspected target navigated"];

export type Frame = { id: string; url: string; loader: string | null; parent: string | null; name: string; origin: string };
export type Lifecycle = { loader: string | null; names: Set<string> };
export type Viewport = [number, number] | null;
export type SendOptions = { timeout?: number; mutation?: boolean; inputEvent?: boolean; guard?: () => void; session?: string | null };
export type CallOptions = { frame?: string | null; byValue?: boolean; awaitPromise?: boolean; timeout?: number; read?: boolean };

export interface PageInput {
  readonly holding: boolean;
  bind(viewport: Viewport): void;
}

class Unbound implements PageInput {
  readonly holding = false;
  viewport: Viewport = null;

  bind(viewport: Viewport): void {
    this.viewport = viewport;
  }
}

export class Element {
  constructor(
    readonly frame: string,
    public objectId: string,
    readonly backendId: number,
    public label: string,
  ) {}
}

function ignorable(error: unknown): boolean {
  return error instanceof BrowseError && !(error instanceof ConnectionLost) && error.code !== "tab_detached" && error.code !== "tab_crashed";
}

export function quiet(error: unknown): boolean {
  return error instanceof BrowseError && !(error instanceof ConnectionLost);
}

export const DOCUMENT_CHANGED = "The page changed document before this could run, so it wasn't applied; snapshot again";

class StaleWorld extends BrowseError {
  constructor() {
    super(DOCUMENT_CHANGED, null, "document_changed");
  }
}

function frameOf(frame: Json, parent: string | null): Frame {
  return {
    id: String(frame["id"]),
    url: String(frame["url"] ?? "") + String(frame["urlFragment"] ?? ""),
    loader: typeof frame["loaderId"] === "string" ? frame["loaderId"] : null,
    parent,
    name: typeof frame["name"] === "string" ? frame["name"] : "",
    origin: typeof frame["securityOrigin"] === "string" ? frame["securityOrigin"] : "",
  };
}

export class Page {
  static makeInput: (page: Page) => PageInput = () => new Unbound();

  sessionId: string | null = null;
  attaching: string | null = null;
  browser: Browser | null = null;
  frames = new Map<string, Frame>();
  mainFrame: string | null = null;
  readonly worlds = new Map<string, [string | null, number]>();
  readonly frameSessions = new Map<string, string>();
  readonly oopifs = new Map<string, oopif.Oopif>();
  readonly lifecycle = new Map<string, Lifecycle>();
  dialog: Json | null = null;
  readonly console = new Ring(CONSOLE_LIMIT);
  readonly errors = new Ring(ERROR_LIMIT);
  readonly network = new NetworkLog();
  runtimeOn = false;
  networkOn = false;
  readonly input: PageInput;
  navigations = 0;
  readonly initScripts = new Map<string, string>();
  readonly scriptSources = new Map<string, string>();
  readonly scriptIds = new Map<string, string>();
  readonly overrides = new Map<string, CdpResult | null>();
  attaches = 0;
  needsRestore = false;
  url = "";
  title = "";
  dragIntercepted: ((data: Json) => void) | null = null;
  crashed = false;
  needsEnable = false;
  awake = false;
  unansweredAt = 0;
  private readonly calls = new Set<AbortController>();
  private restoring: { session: string; done: Set<string> } | null = null;

  constructor(
    readonly state: State,
    readonly targetId: string,
  ) {
    this.input = Page.makeInput(this);
  }

  get session(): string | null {
    return this.sessionId ?? this.attaching;
  }

  sessionFor(frame: string | null | undefined): string | null {
    return (frame ? this.frameSessions.get(frame) : undefined) ?? this.session;
  }

  async attach(browser: Browser): Promise<void> {
    if (this.sessionId !== null) this.state.sessions.delete(this.sessionId);
    if (this.attaching !== null) this.state.sessions.delete(this.attaching);
    this.sessionId = null;
    this.attaching = null;
    this.browser = browser;
    this.worlds.clear();
    oopif.forgetAll(this);
    let result: CdpResult;
    try {
      result = await browser.send("Target.attachToTarget", { targetId: this.targetId, flatten: true });
    } catch (error) {
      if (error instanceof Gated) {
        flag("attach_refused", true);
        throw error.during(null, error.reason ? await whereAppHas(this.state, this.targetId) : null);
      }
      throw error;
    }
    const session = String(result["sessionId"]);
    this.attaching = session;
    this.state.sessions.set(session, this);
    this.attaches += 1;
    this.needsRestore = this.needsRestore || this.attaches > 1;
    try {
      const known = this.crashed;
      this.crashed = false;
      try {
        await this.send("Inspector.enable", null, { timeout: CRASH_PROBE });
      } catch (error) {
        if (error instanceof Gated) this.crashed = known;
        else if (!(error instanceof BrowseError) || error instanceof ConnectionLost) throw error;
      }
      if (this.crashed) {
        this.needsEnable = true;
        if (this.attaching !== session) throw new BrowseError(DETACHED, null, "tab_detached");
        if (!browser.alive) throw new ConnectionLost();
        return;
      }
      await this.enablePage();
      if (this.sessionId !== session) throw new BrowseError(DETACHED, null, "tab_detached");
      if (!browser.alive) throw new ConnectionLost();
    } catch (error) {
      if (this.attaching === session) {
        this.attaching = null;
        this.state.sessions.delete(session);
        this.needsEnable = true;
        browser.send("Target.detachFromTarget", { sessionId: session }, { timeout: DETACH_WAIT, signal: null }).catch(() => {});
      }
      throw error;
    }
  }

  private publish(session: string): void {
    if (this.attaching !== session) throw new BrowseError(DETACHED, null, "tab_detached");
    if (!this.browser?.alive) throw new ConnectionLost();
    this.sessionId = session;
    this.attaching = null;
  }

  async enablePage(): Promise<void> {
    const pending = this.attaching;
    this.needsEnable = true;
    await this.send("Page.enable");
    await this.send("Page.setLifecycleEventsEnabled", { enabled: true });
    await oopif.autoAttach(this, this.session);
    await this.refreshFrames();
    if (pending !== null) this.publish(pending);
    if (this.runtimeOn) {
      this.runtimeOn = false;
      await this.enableRuntime();
    }
    if (this.networkOn) {
      this.networkOn = false;
      await this.enableNetwork();
    }
    if (this.needsRestore) await this.restoreSetup();
    if (this.awake || this.state.opened.has(this.targetId)) await this.keepAwake();
    let viewport: Viewport = null;
    try {
      const css = record((await this.send("Page.getLayoutMetrics"))["cssVisualViewport"]);
      viewport = [Number(css["clientWidth"]) || 1280, Number(css["clientHeight"]) || 800];
    } catch (error) {
      if (!ignorable(error)) throw error;
    }
    this.input.bind(viewport);
    this.needsEnable = false;
  }

  async stillBusy(method: string): Promise<void> {
    const browser = this.browser as Browser;
    const session = this.session;
    const deadline = monotonic() + BUSY_PROBE;
    const left = () => Math.max(0.001, deadline - monotonic());
    try {
      let main = this.mainFrame;
      if (main === null) {
        const tree = await browser.send("Page.getFrameTree", null, { session, timeout: left() });
        const found = record(record(tree["frameTree"])["frame"])["id"];
        main = typeof found === "string" ? found : null;
      }
      if (main !== null) {
        const cached = this.worlds.get(main);
        const context =
          cached && cached[0] === this.loader(main)
            ? cached[1]
            : Number((await browser.send("Page.createIsolatedWorld", { frameId: main, worldName: WORLD_NAME }, { session, timeout: left() }))["executionContextId"]);
        await browser.send("Runtime.evaluate", { expression: "1", contextId: context, returnByValue: true }, { session, timeout: left() });
      }
    } catch (error) {
      if (error instanceof CdpTimeout) {
        flag("page_busy_fast_fail", true);
        throw new PageBusy(method, BUSY_PROBE, BUSY_WHY(BUSY_PROBE));
      }
      if (!quiet(error)) throw error;
    }
    this.unansweredAt = 0;
  }

  async keepAwake(): Promise<void> {
    const endpoint = this.state.endpoint;
    if (endpoint === null || !endpoint.explicit) return;
    try {
      await this.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    } catch (error) {
      if (ignorable(error)) return;
      throw error;
    }
    this.awake = true;
    flag("tab_kept_awake", true);
  }

  async restoreSetup(): Promise<void> {
    const session = this.session as string;
    if (this.restoring?.session !== session) this.restoring = { session, done: new Set() };
    const done = this.restoring.done;
    const lost: string[] = [];
    let restored = 0;
    for (const visible of [...this.initScripts.keys()]) {
      const step = `script\u0000${visible}`;
      if (done.has(step)) continue;
      const source = this.scriptSources.get(visible);
      try {
        if (source === undefined) throw new BrowseError("no source kept");
        const result = await this.send("Page.addScriptToEvaluateOnNewDocument", { source });
        this.scriptIds.set(visible, String(result["identifier"]));
        restored += 1;
      } catch (error) {
        if (!ignorable(error)) throw error;
        lost.push(`init script ${visible}`);
        this.initScripts.delete(visible);
        this.scriptSources.delete(visible);
        this.scriptIds.delete(visible);
      }
      done.add(step);
    }
    for (const [method, params] of [...this.overrides]) {
      const step = `override\u0000${method}`;
      if (done.has(step)) continue;
      try {
        await this.send(method, params);
        restored += 1;
      } catch (error) {
        if (!ignorable(error)) throw error;
        lost.push(SETUP_NAMES[method] ?? method);
        this.overrides.delete(method);
      }
      done.add(step);
    }
    if (this.state.claims.has(this.targetId, "route") && !done.has("route")) {
      const params: CdpResult = { patterns: ROUTE_PATTERNS };
      if (this.state.credentials) params["handleAuthRequests"] = true;
      try {
        await this.send("Fetch.enable", params);
        restored += 1;
      } catch (error) {
        if (!ignorable(error)) throw error;
        lost.push("network routes and HTTP credentials");
        this.state.claims.delete(this.targetId, "route");
        this.state.releaseClaim(this.targetId, "route");
      }
      done.add("route");
    }
    this.needsRestore = false;
    this.restoring = null;
    if (lost.length > 0) {
      flag("setup_restore_failed", true);
      throw new BrowseError(
        `Ardia detached this tab from the ardia command and it was attached again, but ${lost.join(", ")} couldn't be put back, ` +
          "so they are off now. Set them again (addinitscript, set …, network route) and run the command again",
        { lost },
        "setup_lost",
      );
    }
    if (restored) flag("setup_restored", true);
  }

  markCrashed(): void {
    this.crashed = true;
    this.worlds.clear();
    for (const call of this.calls) call.abort(new Cancelled());
  }

  async revive(timeout: number): Promise<void> {
    await this.send("Page.reload", {});
    await this.recovered(timeout);
  }

  async recovered(timeout: number): Promise<void> {
    flag("crashed_reloaded", true);
    this.crashed = false;
    await this.enablePage();
    await waitUntil(async () => (await this.call("() => document.readyState", [], { frame: this.mainFrame })) === "complete", timeout, 0.1, "the crashed page to reload");
  }

  detach(): void {
    if (this.sessionId) this.state.sessions.delete(this.sessionId);
    if (this.attaching) this.state.sessions.delete(this.attaching);
    this.sessionId = null;
    this.attaching = null;
    this.worlds.clear();
    oopif.forgetAll(this);
    for (const call of this.calls) call.abort(new Cancelled());
  }

  async send(method: string, params: CdpResult | null = null, options: SendOptions = {}): Promise<CdpResult> {
    const top = this.session;
    const session = options.session ?? top;
    if (session === null || top === null) throw new BrowseError(DETACHED, null, "tab_detached");
    if (this.crashed && !CRASH_SAFE.has(method)) throw new BrowseError(CRASHED, null, "tab_crashed");
    if (this.unansweredAt && monotonic() - this.unansweredAt < BUSY_MEMORY) await this.stillBusy(method);
    options.guard?.();
    if (this.session !== top || (session !== top && !this.oopifs.has(session))) throw new BrowseError(DETACHED, null, "tab_detached");
    const timeout = options.timeout ?? 30;
    const dropped = new AbortController();
    this.calls.add(dropped);
    const unknown = Boolean(options.inputEvent || options.mutation || isMutation(method));
    const outer = currentSignal();
    const signal = outer === null ? dropped.signal : AbortSignal.any([outer, dropped.signal]);
    try {
      const sending = (this.browser as Browser).send(method, params, { session, timeout, signal });
      return await new Promise<CdpResult>((resolve, reject) => {
        dropped.signal.addEventListener("abort", () => reject(new Cancelled()), { once: true });
        sending.then(resolve, reject);
      });
    } catch (error) {
      if (error instanceof Cancelled && dropped.signal.aborted && !outer?.aborted) {
        if (unknown) throw new OutcomeUnknown(`\`${method}\``, `Ardia detached the tab before it answered ${method}`);
        if (this.crashed) throw new BrowseError(CRASHED, null, "tab_crashed");
        throw new BrowseError(DETACHED, null, "tab_detached");
      }
      if (error instanceof CdpTimeout) {
        this.unansweredAt = monotonic();
        if (unknown) throw new OutcomeUnknown(`\`${method}\``, `Ardia didn't answer ${method} in ${formatG(timeout)}s after it was sent`);
        throw new PageBusy(method, timeout, BUSY_WHY(BUSY_PROBE));
      }
      if (error instanceof OutcomeUnknown && error.text.includes(`didn't answer ${method} in `)) this.unansweredAt = monotonic();
      throw error;
    } finally {
      this.calls.delete(dropped);
    }
  }

  async refreshFrames(): Promise<Map<string, Frame>> {
    const tree = record((await this.send("Page.getFrameTree"))["frameTree"]);
    const frames = new Map<string, Frame>();
    const walk = (node: Json, parent: string | null) => {
      const frame = frameOf(record(node["frame"]), parent);
      frames.set(frame.id, frame);
      const children = node["childFrames"];
      for (const child of Array.isArray(children) ? children : []) walk(record(child), frame.id);
    };
    walk(tree, null);
    if (this.oopifs.size > 0) await oopif.childFrames(this, frames, frameOf);
    this.frames = frames;
    this.mainFrame = String(record(tree["frame"])["id"]);
    this.url = frames.get(this.mainFrame)?.url ?? "";
    return frames;
  }

  loader(frameId: string | null): string | null {
    return frameId === null ? null : (this.frames.get(frameId)?.loader ?? null);
  }

  async world(frameId: string | null = null): Promise<number> {
    return (await this.worldOf(frameId)).context;
  }

  private stillCurrent(frame: string, loader: string | null, context: number): boolean {
    return this.frames.has(frame) && this.loader(frame) === loader && this.worlds.get(frame)?.[1] === context;
  }

  async worldOf(frameId: string | null = null): Promise<{ frame: string; loader: string | null; context: number }> {
    const frame = frameId || this.mainFrame;
    if (frame === null || !this.frames.has(frame)) {
      await this.refreshFrames();
      if (frame === null || !this.frames.has(frame)) throw new BrowseError("That frame is gone. Run `ardia browse frame main` or snapshot again", null, "frame_gone");
    }
    const loader = this.loader(frame);
    const cached = this.worlds.get(frame);
    if (cached && cached[0] === loader) return { frame, loader, context: cached[1] };
    const session = this.sessionFor(frame);
    const result = await this.send("Page.createIsolatedWorld", { frameId: frame, worldName: WORLD_NAME }, { session });
    const context = Number(result["executionContextId"]);
    const fresh = () => this.frames.has(frame) && this.loader(frame) === loader;
    if (!fresh()) throw new StaleWorld();
    await this.send("Runtime.evaluate", { expression: LIBRARY, contextId: context, returnByValue: true }, { session, guard: () => { if (!fresh()) throw new StaleWorld(); } });
    if (!fresh()) throw new StaleWorld();
    this.worlds.set(frame, [loader, context]);
    return { frame, loader, context };
  }

  async call(fn: string, args: unknown[] = [], options: CallOptions = {}): Promise<unknown> {
    const wanted = options.frame || this.state.frameFor(this);
    const byValue = options.byValue ?? true;
    const read = options.read ?? false;
    const elements = args.some((arg) => arg instanceof Element);
    for (const attempt of [0, 1]) {
      let world: { frame: string; loader: string | null; context: number } | undefined;
      let result: CdpResult;
      try {
        world = await this.worldOf(wanted);
        const { frame, loader, context } = world;
        const params = {
          functionDeclaration: fn,
          executionContextId: context,
          arguments: args.map((arg) => (arg instanceof Element ? { objectId: arg.objectId } : { value: arg })),
          returnByValue: byValue,
          awaitPromise: options.awaitPromise ?? true,
        };
        result = await this.send("Runtime.callFunctionOn", params, {
          timeout: options.timeout ?? 30,
          mutation: !read,
          session: this.sessionFor(frame),
          guard: () => {
            if (!this.stillCurrent(frame, loader, context)) throw new StaleWorld();
          },
        });
      } catch (error) {
        if (error instanceof StaleWorld) {
          if (read && attempt === 0 && !elements) {
            await this.refreshFrames();
            continue;
          }
          throw error;
        }
        if (!(error instanceof CdpError) || world === undefined) throw error;
        const message = error.cdpMessage;
        const { frame, context } = world;
        if (message.includes(OTHER_WORLD) && attempt === 0 && (await this.rehome(args, context, frame))) continue;
        if (!message.includes(OTHER_WORLD) && !STALE_CONTEXT.some((marker) => message.includes(marker))) throw error;
        this.worlds.delete(frame);
        if (read && attempt === 0 && !elements) {
          await this.refreshFrames();
          continue;
        }
        if (!read && message.includes("destroyed")) throw new OutcomeUnknown("the page script", "the page changed document while it ran");
        throw new BrowseError(DOCUMENT_CHANGED, null, "document_changed");
      }
      if (Object.hasOwn(result, "exceptionDetails")) {
        const details = record(result["exceptionDetails"]);
        const description = String(record(details["exception"])["description"] || details["text"] || "error");
        throw new BrowseError(description.split("\n    at ")[0] as string, null, "page_script_error");
      }
      const remote = record(result["result"]);
      return byValue ? remote["value"] : remote;
    }
    throw new BrowseError("the page navigated while reading it; try again", null, "page_navigated");
  }

  async rehome(args: unknown[], context: number, frame: string): Promise<boolean> {
    const elements = args.filter((arg): arg is Element => arg instanceof Element);
    if (elements.length === 0 || elements.some((element) => element.frame !== frame)) return false;
    for (const element of elements) {
      let result: CdpResult;
      try {
        result = await this.send("DOM.resolveNode", { backendNodeId: element.backendId, executionContextId: context }, { session: this.sessionFor(element.frame) });
      } catch (error) {
        if (error instanceof CdpError) return false;
        throw error;
      }
      const remote = record(result["object"]);
      if (typeof remote["objectId"] !== "string") return false;
      element.objectId = remote["objectId"];
    }
    flag("element_rehomed", true);
    return true;
  }

  async elementFrom(remote: unknown, frame: string, label: string): Promise<Element | null> {
    const found = record(remote);
    if (found["subtype"] === "null" || found["type"] === "undefined" || typeof found["objectId"] !== "string") return null;
    const node = record((await this.send("DOM.describeNode", { objectId: found["objectId"] }, { session: this.sessionFor(frame) }))["node"]);
    return new Element(frame, found["objectId"], Number(node["backendNodeId"]), label);
  }

  async elementsFrom(remote: unknown, frame: string, label: string, limit = 300): Promise<Element[]> {
    const found = record(remote);
    if (typeof found["objectId"] !== "string") return [];
    const session = this.sessionFor(frame);
    const props = await this.send("Runtime.getProperties", { objectId: found["objectId"], ownProperties: true }, { session });
    const indexed: [number, string][] = [];
    for (const prop of Array.isArray(props["result"]) ? props["result"] : []) {
      const name = String(record(prop)["name"] ?? "");
      const objectId = record(record(prop)["value"])["objectId"];
      if (/^[0-9]+$/u.test(name) && typeof objectId === "string" && objectId) indexed.push([Number(name), objectId]);
    }
    indexed.sort((a, b) => a[0] - b[0]);
    const kept = indexed.slice(0, limit);
    const described = await Promise.all(kept.map(([, objectId]) => this.send("DOM.describeNode", { objectId }, { session })));
    return kept.map(([, objectId], index) => new Element(frame, objectId, Number(record(record(described[index])["node"])["backendNodeId"]), label));
  }

  async resolveBackend(backendId: number, frame: string, label: string): Promise<Element | null> {
    const context = await this.world(frame);
    let result: CdpResult;
    try {
      result = await this.send("DOM.resolveNode", { backendNodeId: backendId, executionContextId: context }, { session: this.sessionFor(frame) });
    } catch (error) {
      if (error instanceof CdpError) return null;
      throw error;
    }
    const remote = record(result["object"]);
    return typeof remote["objectId"] === "string" ? new Element(frame, remote["objectId"], backendId, label) : null;
  }

  async hidden(): Promise<boolean> {
    try {
      return Boolean(await this.call("() => document.visibilityState === 'hidden'", [], { frame: this.mainFrame, read: true }));
    } catch (error) {
      if (quiet(error)) return false;
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

  showHint(): string {
    return HIDDEN_TAB.replaceAll("{tab}", this.state.tabId(this.targetId));
  }

  async requireVisible(): Promise<void> {
    if (await this.takesInput()) return;
    const tab = this.state.tabId(this.targetId);
    throw new BrowseError(this.showHint(), { tabId: tab, use: `ardia browse tab ${tab} --show` }, "tab_hidden");
  }

  async focusElement(element: Element): Promise<void> {
    try {
      await this.send("DOM.focus", { backendNodeId: element.backendId }, { session: this.sessionFor(element.frame) });
    } catch (error) {
      if (!(error instanceof CdpError) || !error.cdpMessage.includes("focusable")) throw error;
      let landed: unknown = false;
      try {
        landed = await this.call(PAGE_FOCUS_INSIDE, [element], { frame: element.frame });
      } catch (inner) {
        if (!quiet(inner)) throw inner;
      }
      if (!landed) throw new NotFocusable(element.label);
      flag("focused_inner_field", true);
    }
  }

  async enableRuntime(): Promise<void> {
    if (this.runtimeOn) return;
    await this.send("Runtime.enable");
    this.runtimeOn = true;
  }

  async enableNetwork(): Promise<void> {
    if (this.networkOn) return;
    await this.send("Network.enable", { maxTotalBufferSize: 50 * 1024 * 1024, maxResourceBufferSize: 10 * 1024 * 1024 });
    this.networkOn = true;
  }

  onChildEvent(session: string, method: string, params: Json): void {
    oopif.childEvent(this, session, method, params);
  }

  onEvent(method: string, params: Json): void {
    if (method === "Target.attachedToTarget" || method === "Target.detachedFromTarget") {
      if (this.session !== null) oopif.childEvent(this, this.session, method, params);
    } else if (method === "Page.lifecycleEvent") {
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
        const parent = typeof raw["parentId"] === "string" && raw["parentId"] ? raw["parentId"] : null;
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
      const frame = this.frames.get(String(params["frameId"]));
      if (frame) {
        frame.url = String(params["url"] ?? "");
        if (frame.id === this.mainFrame) this.url = frame.url;
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
    } else if (method === "Input.dragIntercepted") {
      const waiter = this.dragIntercepted;
      this.dragIntercepted = null;
      waiter?.(record(params["data"]));
    } else if (method === "Runtime.consoleAPICalled") {
      this.console.add(consoleEntry(params));
    } else if (method === "Runtime.exceptionThrown") {
      this.errors.add(errorEntry(params));
    } else if (method.startsWith("Network.") && this.networkOn) {
      this.network.onEvent(method, params);
    }
    this.state.onPageEvent(this, method, params);
  }
}
