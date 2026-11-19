import { Browser } from "../../cdp/browser.ts";
import { shield } from "../../cdp/cancel.ts";
import { BrowseError, ConnectionLost } from "../../daemon-errors.ts";
import { type Endpoint, unreachableMessage } from "../../endpoint.ts";
import { clock, flag, spent } from "../../metrics.ts";
import { Registry } from "../../state/registry.ts";
import * as temptabs from "../../state/temptabs.ts";
import { wallSeconds } from "../../tokens.ts";
import { StubPage } from "./page.ts";

export const PAGE_SCHEMES = ["http:", "https:", "about:", "data:", "blob:", "file:"];
export const NO_SESSION_TAB =
  "This session has no tab yet, and it never takes the user's tab on its own. `ardia browse open <url>` opens a " +
  "background tab of its own; to work in the tab the user is looking at, pick it first with `ardia browse tab active`";

export class RestartedBrowser extends BrowseError {
  override readonly exitCode: number = 2;
}

export type StubConfig = {
  session: string;
  key: string;
  browseFd: number | null;
  noAutoDialog: boolean;
  pinTab: boolean;
};

export type Lost = { target: string; tab: string | undefined; opened: boolean };

function isPageInfo(info: Record<string, unknown>): boolean {
  return info["type"] === "page" && PAGE_SCHEMES.some((scheme) => String(info["url"] ?? "").startsWith(scheme));
}

export class StubState implements temptabs.TempTabState {
  readonly session: string;
  browser: Browser | null = null;
  instance: string | null = null;
  endpoint: Endpoint | null = null;
  readonly pages = new Map<string, StubPage>();
  readonly sessions = new Map<string, StubPage>();
  readonly tabIds = new Map<string, string>();
  nextTab = 1;
  readonly labels = new Map<string, string>();
  readonly registry: Registry;
  readonly opened = new Set<string>();
  readonly leases = new Set<string>();
  readonly failedNavigations = new Map<string, number>();
  targetInfos = new Map<string, Record<string, unknown>>();
  lost = false;
  restarted = false;
  autoDialog: boolean;
  pinTab: boolean;
  backgroundLive: boolean | null = null;
  hadTab = false;
  lostTab: Lost | null = null;
  notice: string | null = null;
  loadNote: string | null = null;
  pinnedTarget: string | null = null;
  mustClose = new Set<string>();
  mustCloseTask: temptabs.TempTabState["mustCloseTask"] = null;
  private currentTarget: string | null = null;

  constructor(
    readonly config: StubConfig,
    readonly resolveEndpoint: () => Promise<Endpoint>,
  ) {
    this.session = config.session;
    this.registry = new Registry(config.browseFd, config.key, config.session);
    this.autoDialog = !config.noAutoDialog;
    this.pinTab = config.pinTab;
  }

  get current(): string | null {
    return this.currentTarget;
  }

  set current(targetId: string | null) {
    if (targetId !== this.currentTarget) this.registry.noteUsing(this.instance, targetId);
    this.currentTarget = targetId;
  }

  get connected(): boolean {
    return this.browser !== null && this.browser.alive;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const started = clock();
    flag("reconnected_after_idle", this.instance !== null);
    if (this.browser !== null && !this.browser.closedByUs) this.lost = true;
    if (this.lost) throw new ConnectionLost();
    const endpoint = await this.resolveEndpoint();
    if (this.instance !== null && endpoint.instance !== this.instance) {
      this.restarted = true;
      throw new RestartedBrowser(
        "Ardia restarted (or control was turned off and on) since this session started, so its tabs and refs are gone. " +
          "Start over with `ardia browse open <url>`",
        null,
        "browser_restarted",
      );
    }
    const browser = new Browser(endpoint, (method, params, session) => this.onEvent(method, params, session), (error) => unreachableMessage(endpoint, error));
    try {
      await browser.open();
    } catch (error) {
      await shield(() => browser.close());
      throw error;
    }
    this.browser = browser;
    this.endpoint = endpoint;
    this.instance = endpoint.instance;
    for (const page of this.pages.values()) page.detach();
    this.sessions.clear();
    try {
      await browser.send("Target.setDiscoverTargets", { discover: true });
    } catch (error) {
      if (!(error instanceof BrowseError)) throw error;
    }
    await this.refreshTargets();
    await temptabs.sweep(this);
    spent("connect_ms", started);
  }

  async disconnect(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    for (const page of this.pages.values()) page.detach();
    this.sessions.clear();
    if (browser !== null) await browser.close();
  }

  async refreshTargets(): Promise<Record<string, unknown>[]> {
    const takenAt = wallSeconds();
    const raw = (await (this.browser as Browser).send("Target.getTargets"))["targetInfos"];
    const infos = (Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
    const pages = infos.filter(isPageInfo);
    this.targetInfos = new Map(pages.map((info) => [String(info["targetId"]), info]));
    for (const targetId of [...this.pages.keys(), ...(this.current ? [this.current] : [])]) {
      if (!this.targetInfos.has(targetId)) this.forgetTarget(targetId);
    }
    const every = infos.map((info) => info["targetId"]).filter((id): id is string => typeof id === "string" && id !== "");
    for (const [target, tab] of this.registry.numbers(this.instance, this.targetInfos.keys(), every, takenAt)) this.tabIds.set(target, tab);
    return pages;
  }

  forgetTarget(targetId: string): void {
    const page = this.pages.get(targetId);
    this.pages.delete(targetId);
    page?.detach();
    const wasOpened = this.opened.has(targetId);
    this.opened.delete(targetId);
    this.targetInfos.delete(targetId);
    for (const [label, owner] of [...this.labels]) if (owner === targetId) this.labels.delete(label);
    if (this.current === targetId && !this.pinTab) {
      this.lostTab = { target: targetId, tab: this.tabIds.get(targetId), opened: wasOpened };
      this.current = null;
    }
  }

  tabId(targetId: string): string {
    let tab = this.tabIds.get(targetId);
    if (tab === undefined) {
      tab = this.registry.numbers(this.instance, [targetId]).get(targetId);
      if (tab === undefined) {
        tab = `t${this.nextTab}`;
        this.nextTab += 1;
      }
      this.tabIds.set(targetId, tab);
    }
    return tab;
  }

  onEvent(method: string, raw: unknown, sessionId: unknown): void {
    const params = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (typeof sessionId === "string" && sessionId) {
      const page = this.sessions.get(sessionId);
      if (page === undefined) return;
      if (method === "Inspector.detached") {
        flag("renderer_exit_kept_session", true);
        return;
      }
      if (method === "Inspector.targetCrashed") {
        page.markCrashed();
        return;
      }
      if (method === "Inspector.targetReloadedAfterCrash") {
        page.crashed = false;
        return;
      }
      page.onEvent(method, params);
      return;
    }
    if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
      const info = (params["targetInfo"] ?? {}) as Record<string, unknown>;
      if (isPageInfo(info)) this.targetInfos.set(String(info["targetId"]), info);
    } else if (method === "Target.targetDestroyed") {
      this.forgetTarget(String(params["targetId"]));
    } else if (method === "Target.detachedFromTarget") {
      this.sessions.get(String(params["sessionId"]))?.detach();
    }
  }

  async page(target: string | null = null): Promise<StubPage> {
    await this.connect();
    const started = clock();
    const explicit = target !== null;
    let targetId = target ?? this.current;
    if (targetId === null) {
      if (this.pinTab && this.pinnedTarget) {
        throw new BrowseError(
          "The session's pinned tab was closed. Recover with `ardia browse tab new <url>` or pick one from `ardia browse tab list`",
          { targetId: this.pinnedTarget },
          "tab_gone",
        );
      }
      if (!this.hadTab) throw new BrowseError(NO_SESSION_TAB, null, "no_session_tab");
      const gone = this.lostTab?.tab ? ` [${this.lostTab.tab}]` : "";
      throw new BrowseError(
        `This session's tab${gone} is gone (closed, or Ardia replaced its page and didn't say which page took over). ` +
          "Pick one with `ardia browse tab active` or `ardia browse tab <id>`, or open one with `ardia browse open <url>`",
        null,
        "tab_gone",
      );
    }
    if (!this.targetInfos.has(targetId)) {
      await this.refreshTargets();
      if (!this.targetInfos.has(targetId)) {
        this.forgetTarget(targetId);
        if (!explicit && targetId === this.lostTab?.target) return this.page();
        throw new BrowseError("That tab was closed", { targetId }, "tab_gone");
      }
    }
    let page = this.pages.get(targetId);
    if (page === undefined) {
      page = new StubPage(this, targetId);
      this.pages.set(targetId, page);
    }
    if (page.sessionId === null || page.browser !== this.browser) await page.attach(this.browser as Browser);
    if (page.needsEnable && !page.crashed) await page.enablePage();
    this.hadTab = true;
    spent("attach_ms", started);
    return page;
  }

  async reattach(page: StubPage): Promise<StubPage> {
    if (page.sessionId !== null && page.browser === this.browser) return page;
    if (this.pages.get(page.targetId) !== page || !this.targetInfos.has(page.targetId)) {
      throw new BrowseError(
        "Ardia detached this tab from the ardia command while it was in use (the tab closed, crashed, went to sleep or moved to a window Ardia keeps for itself). Run the command again",
        null,
        "tab_detached",
      );
    }
    await page.attach(this.browser as Browser);
    flag("reattached_after_detach", true);
    return page;
  }

  holding(): boolean {
    return [...this.pages.values()].some((page) => page.input.holding);
  }

  activeLeases(): Set<string> {
    const active = new Set(this.leases);
    active.delete("console");
    active.delete("network");
    return active;
  }
}
