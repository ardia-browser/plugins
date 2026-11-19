import { addSecret } from "../../redact.ts";
import { Browser } from "../cdp/browser.ts";
import { shield } from "../cdp/cancel.ts";
import { BrowseError, ConnectionLost, StaleRef } from "../daemon-errors.ts";
import { type View } from "../changes/report.ts";
import { clock, flag, spent } from "../metrics.ts";
import { CREDENTIAL, withToken } from "./key.ts";
import { PluginLink, unavailable } from "./link.ts";
import { PluginPage } from "./page.ts";

export const PAGE_SCHEMES = ["http:", "https:", "about:", "data:", "blob:", "file:"];
export const LOADING_EVENTS = ["Page.frameStartedLoading", "Page.frameStoppedLoading"];
export const NO_TAB = "This plugin session has no tab yet: pick one first with `ardia browse tab <targetId>`";

export type Ref = { id: string; target: string; frame: string; loader: string; backend: number; role: string; name: string };
export type PluginConfig = { session: string; endpoint: string; credentialId: string; autoDialog: boolean };

export class ForeignRef extends BrowseError {
  override readonly exitCode: number = 77;

  constructor(id: string) {
    super(`@${id} is from another tab: a plugin step acts only on the tab it picked, so nothing was sent. Snapshot this tab and use its refs`, null, "stale_ref");
  }
}

export class PluginRefused extends BrowseError {
  override readonly exitCode: number = 77;

  constructor(text: string) {
    super(text, null, "plugin_refused");
  }
}

function isPage(info: Record<string, unknown>): boolean {
  return info["type"] === "page" && PAGE_SCHEMES.some((scheme) => String(info["url"] ?? "").startsWith(scheme));
}

export class PluginSession {
  readonly session: string;
  browser: Browser | null = null;
  link: PluginLink | null = null;
  instance: string | null = null;
  lost = false;
  restarted = false;
  notice: string | null = null;
  autoDialog: boolean;
  pinTab = false;
  credential: string | null = null;
  current: string | null = null;
  readonly pages = new Map<string, PluginPage>();
  readonly routes = new Map<string, PluginPage>();
  readonly tabIds = new Map<string, string>();
  targetInfos = new Map<string, Record<string, unknown>>();
  private nextTab = 1;
  readonly refs = new Map<string, Ref>();
  private readonly refKeys = new Map<string, string>();
  private issuedRefs = 0;
  currentRefs: string[] = [];
  readonly views = new Map<string, View>();
  readonly shown = new Map<string, string>();

  constructor(readonly config: PluginConfig) {
    this.session = config.session;
    this.autoDialog = config.autoDialog;
  }

  get connected(): boolean {
    return this.browser !== null && this.browser.alive;
  }

  get loader(): string | null {
    const page = this.current === null ? undefined : this.pages.get(this.current);
    return page?.sessionId ? page.loader : null;
  }

  useCredential(credential: string | null): void {
    if (credential !== null && CREDENTIAL.test(credential)) {
      addSecret(credential);
      this.credential = credential;
    } else this.credential = null;
  }

  async connect(): Promise<PluginLink> {
    if (this.connected && this.link !== null) return this.link;
    if (this.browser !== null && !this.browser.closedByUs) this.lost = true;
    if (this.lost) throw new ConnectionLost();
    if (this.credential === null) throw new PluginRefused("needs the activity's credential with every step, and this one came without it");
    const started = clock();
    flag("reconnected_after_idle", this.instance !== null);
    const endpoint = { ws: withToken(this.config.endpoint, this.credential), instance: this.config.endpoint };
    const browser = new Browser(endpoint, (method, params, session) => this.onEvent(method, params, session), () => "Ardia's plugin token server didn't take the connection (control is off, or the activity ended)");
    try {
      await browser.open();
    } catch (error) {
      await shield(() => browser.close());
      throw error;
    }
    for (const name of LOADING_EVENTS) browser.link?.on(name, (method, params, session) => this.onEvent(method, params, session));
    this.browser = browser;
    this.link = new PluginLink(browser);
    this.instance = this.config.endpoint;
    for (const page of this.pages.values()) page.detach();
    this.routes.clear();
    spent("connect_ms", started);
    return this.link;
  }

  async disconnect(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.link = null;
    for (const page of this.pages.values()) page.detach();
    this.routes.clear();
    if (browser !== null) await browser.close();
  }

  holding(): boolean {
    return false;
  }

  activeLeases(): Set<string> {
    return new Set();
  }

  onEvent(method: string, raw: unknown, sessionId: unknown): void {
    const params = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (typeof sessionId === "string" && sessionId) {
      this.routes.get(sessionId)?.onEvent(method, params);
      return;
    }
    if (method === "Target.targetDestroyed") this.forgetTarget(String(params["targetId"]));
    else if (method === "Target.detachedFromTarget") {
      const page = this.routes.get(String(params["sessionId"]));
      this.routes.delete(String(params["sessionId"]));
      page?.detach();
    }
  }

  async refreshTargets(): Promise<Record<string, unknown>[]> {
    const link = await this.connect();
    const raw = (await link.send("Target.getTargets"))["targetInfos"];
    const pages = (Array.isArray(raw) ? raw : []).filter((info): info is Record<string, unknown> => info !== null && typeof info === "object" && isPage(info));
    this.targetInfos = new Map(pages.map((info) => [String(info["targetId"]), info]));
    for (const targetId of [...this.pages.keys()]) if (!this.targetInfos.has(targetId)) this.forgetTarget(targetId);
    for (const info of pages) this.tabId(String(info["targetId"]));
    return pages;
  }

  forgetTarget(targetId: string): void {
    const page = this.pages.get(targetId);
    this.pages.delete(targetId);
    if (page?.sessionId) this.routes.delete(page.sessionId);
    page?.detach();
    this.targetInfos.delete(targetId);
  }

  tabId(targetId: string): string {
    let tab = this.tabIds.get(targetId);
    if (tab === undefined) {
      tab = `t${this.nextTab}`;
      this.nextTab += 1;
      this.tabIds.set(targetId, tab);
    }
    return tab;
  }

  async findTab(given: string): Promise<string> {
    await this.refreshTargets();
    if (this.targetInfos.has(given)) return given;
    for (const [target, tab] of this.tabIds) if (tab === given && this.targetInfos.has(target)) return target;
    const upper = given.toUpperCase();
    if (this.targetInfos.has(upper)) return upper;
    throw new BrowseError(`Tab ${given} not found; run \`ardia browse tab\` to list open tabs`, null, "tab_not_found");
  }

  async page(target: string | null = null): Promise<PluginPage> {
    const link = await this.connect();
    const started = clock();
    const targetId = target ?? this.current;
    if (targetId === null) throw new BrowseError(NO_TAB, null, "no_session_tab");
    if (!this.targetInfos.has(targetId)) {
      await this.refreshTargets();
      if (!this.targetInfos.has(targetId)) {
        this.forgetTarget(targetId);
        throw new BrowseError("That tab was closed (or moved where this activity can't reach it); pick a tab again", { targetId }, "tab_gone");
      }
    }
    let page = this.pages.get(targetId);
    if (page === undefined) {
      page = new PluginPage(targetId, () => this.autoDialog);
      this.pages.set(targetId, page);
    }
    if (page.sessionId === null || page.link !== link) {
      await page.attach(link, (sessionId, routed) => {
        if (routed === null) this.routes.delete(sessionId);
        else this.routes.set(sessionId, routed);
      });
    }
    spent("attach_ms", started);
    return page;
  }

  async title(page: PluginPage): Promise<string> {
    const link = await this.connect();
    try {
      const info = (await link.send("Target.getTargetInfo", { targetId: page.targetId }))["targetInfo"] as Record<string, unknown> | undefined;
      if (info) this.targetInfos.set(page.targetId, info);
      return typeof info?.["title"] === "string" ? info["title"] : "";
    } catch (error) {
      if (unavailable(error)) return "";
      throw error;
    }
  }

  refFor(page: PluginPage, frame: string, backend: number): string {
    const key = JSON.stringify([this.instance, page.targetId, frame, page.frames.get(frame)?.loader ?? "", backend]);
    let id = this.refKeys.get(key);
    if (id === undefined) {
      this.issuedRefs += 1;
      id = `e${this.issuedRefs}`;
      this.refKeys.set(key, id);
    }
    return id;
  }

  keepRef(ref: Ref): void {
    this.refs.set(ref.id, ref);
  }

  refsJson(): Record<string, { name: string; role: string }> {
    const out: Record<string, { name: string; role: string }> = {};
    for (const id of this.currentRefs) {
      const ref = this.refs.get(id);
      if (ref) out[id] = { name: ref.name, role: ref.role };
    }
    return out;
  }

  async resolveRef(id: string): Promise<{ page: PluginPage; ref: Ref }> {
    const ref = this.refs.get(id);
    if (ref === undefined) {
      if (/^e[0-9]+$/u.test(id) && Number(id.slice(1)) <= this.issuedRefs) throw new StaleRef(id, "it came from an earlier snapshot, and refs are never reused");
      throw new BrowseError(`Unknown ref: ${id}`, null, "unknown_ref");
    }
    if (ref.target !== this.current) throw new ForeignRef(id);
    let page: PluginPage;
    try {
      page = await this.page(ref.target);
    } catch (error) {
      if (error instanceof BrowseError && error.code === "tab_gone") throw new StaleRef(id, "its tab was closed");
      throw error;
    }
    await page.refreshFrames();
    const frame = page.frames.get(ref.frame);
    if (frame === undefined) throw new StaleRef(id, "its frame is gone");
    if (frame.loader !== ref.loader) {
      flag("stale_ref_after_navigation", true);
      throw new StaleRef(id, "the page navigated since that snapshot");
    }
    return { page, ref };
  }
}
