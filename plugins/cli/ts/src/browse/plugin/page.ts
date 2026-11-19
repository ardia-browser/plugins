import { type CdpResult } from "../cdp/browser.ts";
import { shield } from "../cdp/cancel.ts";
import { BrowseError } from "../daemon-errors.ts";
import { log } from "../daemon/log.ts";
import { type PluginLink } from "./link.ts";

export type Frame = { loader: string; url: string; parent: string | null; origin: string };
type Queued = [string, Record<string, unknown>];

function monotonic(): number {
  return performance.now() / 1000;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export class PluginPage {
  sessionId: string | null = null;
  link: PluginLink | null = null;
  mainFrame: string | null = null;
  readonly frames = new Map<string, Frame>();
  readonly lifecycle = new Map<string, { loader: string; names: Set<string> }>();
  dialog: Record<string, unknown> | null = null;
  navigations = 0;
  loading = false;
  lastActivity = monotonic();
  crashed = false;
  private staged: Queued[] | null = null;

  constructor(
    readonly targetId: string,
    readonly autoDialog: () => boolean,
  ) {}

  get loader(): string | null {
    return this.mainFrame === null ? null : (this.frames.get(this.mainFrame)?.loader ?? null);
  }

  get url(): string {
    return this.mainFrame === null ? "" : (this.frames.get(this.mainFrame)?.url ?? "");
  }

  get origin(): string {
    return this.mainFrame === null ? "" : (this.frames.get(this.mainFrame)?.origin ?? "");
  }

  async attach(link: PluginLink, route: (sessionId: string, page: PluginPage | null) => void): Promise<void> {
    this.detach();
    const attached = await link.send("Target.attachToTarget", { targetId: this.targetId, flatten: true });
    const sessionId = text(attached["sessionId"]);
    if (!sessionId) throw new BrowseError("Ardia didn't attach that tab", { targetId: this.targetId }, "tab_detached");
    this.staged = [];
    route(sessionId, this);
    let ready = false;
    try {
      await link.send("Page.enable", {}, sessionId);
      await link.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);
      await this.refreshFrames(link, sessionId);
      if (this.staged === null || !link.browser.alive) {
        throw new BrowseError("Ardia detached this tab while it was being attached (it closed, crashed or moved); run the step again", { targetId: this.targetId }, "tab_detached");
      }
      ready = true;
    } finally {
      if (!ready) {
        this.staged = null;
        route(sessionId, null);
        void shield(() => link.send("Target.detachFromTarget", { sessionId }, null, 5)).catch(() => {});
      }
    }
    const staged = this.staged ?? [];
    this.staged = null;
    this.link = link;
    this.sessionId = sessionId;
    for (const [method, params] of staged) this.apply(method, params);
  }

  detach(): void {
    this.sessionId = null;
    this.link = null;
    this.staged = null;
  }

  async send(method: string, params: CdpResult = {}, timeout = 30): Promise<CdpResult> {
    if (this.link === null || this.sessionId === null) throw new BrowseError("This tab was detached; run the step again", null, "tab_detached");
    return this.link.send(method, params, this.sessionId, timeout);
  }

  async refreshFrames(link: PluginLink | null = this.link, sessionId: string | null = this.sessionId): Promise<void> {
    if (link === null || sessionId === null) throw new BrowseError("This tab was detached; run the step again", null, "tab_detached");
    const tree = (await link.send("Page.getFrameTree", {}, sessionId))["frameTree"];
    this.frames.clear();
    const visit = (node: unknown, parent: string | null) => {
      if (node === null || typeof node !== "object") return;
      const frame = (node as Record<string, unknown>)["frame"] as Record<string, unknown> | undefined;
      if (!frame) return;
      const id = text(frame["id"]);
      this.frames.set(id, { loader: text(frame["loaderId"]), url: text(frame["url"]), parent, origin: text(frame["securityOrigin"]) });
      if (parent === null) this.mainFrame = id;
      const children = (node as Record<string, unknown>)["childFrames"];
      if (Array.isArray(children)) for (const child of children) visit(child, id);
    };
    visit(tree, null);
  }

  onEvent(method: string, params: Record<string, unknown>): void {
    if (this.staged !== null) {
      this.staged.push([method, params]);
      return;
    }
    this.apply(method, params);
  }

  private apply(method: string, params: Record<string, unknown>): void {
    this.lastActivity = monotonic();
    if (method === "Page.frameNavigated") {
      const frame = (params["frame"] ?? {}) as Record<string, unknown>;
      const id = text(frame["id"]);
      const parent = text(frame["parentId"]) || null;
      this.frames.set(id, { loader: text(frame["loaderId"]), url: text(frame["url"]), parent, origin: text(frame["securityOrigin"]) });
      if (parent === null) {
        this.mainFrame = id;
        this.navigations += 1;
      }
    } else if (method === "Page.frameStartedLoading" || method === "Page.frameStoppedLoading") {
      if (text(params["frameId"]) === this.mainFrame) this.loading = method === "Page.frameStartedLoading";
    } else if (method === "Page.navigatedWithinDocument") {
      const known = this.frames.get(text(params["frameId"]));
      if (known) known.url = text(params["url"]);
    } else if (method === "Page.frameDetached") {
      this.frames.delete(text(params["frameId"]));
    } else if (method === "Page.lifecycleEvent") {
      const frame = text(params["frameId"]);
      const loader = text(params["loaderId"]);
      const name = text(params["name"]);
      const known = this.lifecycle.get(frame);
      if (name === "init" || !known || known.loader !== loader) this.lifecycle.set(frame, { loader, names: new Set([name]) });
      else known.names.add(name);
    } else if (method === "Page.javascriptDialogOpening") {
      this.dialog = { ...params };
      const kind = params["type"];
      if (this.autoDialog() && (kind === "alert" || kind === "beforeunload")) {
        void shield(() => this.send("Page.handleJavaScriptDialog", { accept: true })).then(
          () => {
            this.dialog = null;
          },
          (error: unknown) => log.exception("auto-accepting a dialog failed", error),
        );
      }
    } else if (method === "Page.javascriptDialogClosed") {
      this.dialog = null;
    } else if (method === "Inspector.targetCrashed") {
      this.crashed = true;
    }
  }

  reached(name: string, loader: string | null = this.loader): boolean {
    if (this.mainFrame === null) return false;
    const known = this.lifecycle.get(this.mainFrame);
    return known !== undefined && (loader === null || known.loader === loader) && known.names.has(name);
  }

  quietFor(): number {
    return monotonic() - this.lastActivity;
  }
}
