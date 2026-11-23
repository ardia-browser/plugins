import http from "node:http";
import { formatG } from "../../pylib/format.ts";
import { Browser } from "../cdp/browser.ts";
import { Cancelled, currentSignal, shield, sleep, untilCancelled, withSignal } from "../cdp/cancel.ts";
import { envelopeGone } from "../cdp/raw.ts";
import { BrowseError, CdpError, ConnectionLost } from "../daemon-errors.ts";
import { announce, announcePath, type Caller, sameCaller } from "../daemon/announce.ts";
import { release as releaseClaims } from "../daemon/claims.ts";
import { type Endpoint, unreachableMessage } from "../endpoint.ts";
import { clock, flag, spent } from "../metrics.ts";
import { wallSeconds } from "../tokens.ts";
import { APP_TAB, appTabError, appTabMap, appTabTarget } from "./apptabs.ts";
import { detachedError, type Element, Page, quiet, WORLD_NAME } from "./page.ts";
import * as pierce from "./pierce.ts";
import { type Json, record } from "./records.ts";
import { isBareRef, parseRef, Refs } from "./refs.ts";
import { MAX_SESSION_TABS, Registry, type SessionTab } from "./registry.ts";
import * as temptabs from "./temptabs.ts";
import { monotonic } from "./wait.ts";

export { parseRef, type Ref } from "./refs.ts";

export const PAGE_SCHEMES = ["http:", "https:", "about:", "data:", "blob:", "file:", "chrome:", "chrome-extension:", "chrome-untrusted:", "devtools:", "view-source:"];
export const ACTIVE_TIMEOUT = 3.0;
export const APPEAR_POLL = 0.15;
export const PROBE_TIMEOUT = 3.0;
export const PROBE_FANOUT = 8;
export const PROBE_PASSES = 3;
export const PROBE_BACKOFF = 0.25;
export const REATTACH_TRIES = 3;
export const PAIR_TRIES = 5;
export const PAIR_WAIT = 1.0;
export const CLOSE_PAIR_TIMEOUT = 2.0;
export const TOUCH_AFTER = 3600;
const ENDED_SESSIONS_KEPT = 64;

function rememberEnded(ended: Set<string>, session: string): void {
  ended.add(session);
  if (ended.size > ENDED_SESSIONS_KEPT) ended.delete(ended.values().next().value as string);
}
const NTH_SUFFIX = /(?:>>)\s*nth=-?\d+\s*$/u;
export const UNKNOWN = Symbol("unknown");
export const NO_PAGE =
  "The user isn't on a web page right now (New Tab or another Ardia view). " +
  "Open a tab of this session's own with `ardia browse open <url>`, or pick one with `ardia browse tab list` and `ardia browse tab <id>`";
export const NO_SESSION_TAB =
  "This session has no tab yet, and it never takes the user's tab on its own. `ardia browse open <url>` opens a " +
  "background tab of its own; to work in the tab the user is looking at, pick it first with `ardia browse tab active`";

export class RestartedBrowser extends BrowseError {
  override readonly exitCode: number = 2;
}

export type StateConfig = {
  session: string;
  key: string;
  owner?: string;
  browseFd: number | null;
  noAutoDialog: boolean;
  pinTab: boolean;
  dataDir?: string | null;
  dataRoot?: string | null;
};

export type LostTab = { target: string; app: string | undefined; tab: string | undefined; generation: unknown; opened: boolean; borrowed: boolean };
export type Listener = (page: Page | null, method: string, params: Json) => void;
export type Probe = [boolean, boolean];
export type TabRow = Record<string, unknown> & { tabId: string };

export class ClaimSet {
  private readonly held = new Set<string>();

  private static key(target: string, kind: string): string {
    return `${kind}\u0000${target}`;
  }

  has(target: string, kind: string): boolean {
    return this.held.has(ClaimSet.key(target, kind));
  }

  add(target: string, kind: string): void {
    this.held.add(ClaimSet.key(target, kind));
  }

  delete(target: string, kind: string): void {
    this.held.delete(ClaimSet.key(target, kind));
  }

  get size(): number {
    return this.held.size;
  }

  targetsOf(kind: string): string[] {
    const prefix = `${kind}\u0000`;
    return [...this.held].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  }
}

function isPageInfo(info: Json): boolean {
  return info["type"] === "page" && PAGE_SCHEMES.some((scheme) => String(info["url"] ?? "").startsWith(scheme));
}

function fetchActive(url: string, signal: AbortSignal | null): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(new Cancelled());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", cancel);
      if (error === null) resolve(value);
      else {
        request.destroy();
        reject(error);
      }
    };
    const cancel = () => finish(new Cancelled());
    const request = http.get(url, { timeout: ACTIVE_TIMEOUT * 1000, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        if (size < 64 * 1024) chunks.push(chunk);
        size += chunk.length;
      });
      response.on("end", () => {
        if ((response.statusCode ?? 0) >= 400) {
          finish(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        try {
          finish(null, JSON.parse(Buffer.concat(chunks).subarray(0, 64 * 1024).toString("utf8")));
        } catch (error) {
          finish(error);
        }
      });
      response.on("error", (error) => finish(error));
    });
    const deadline = setTimeout(() => finish(new Error("timed out")), (ACTIVE_TIMEOUT + 1) * 1000);
    signal?.addEventListener("abort", cancel, { once: true });
    request.on("timeout", () => finish(new Error("timed out")));
    request.on("error", (error) => finish(error));
  });
}

async function gate<T>(work: (() => Promise<T>)[], width: number): Promise<T[]> {
  const results = new Array<T>(work.length);
  let next = 0;
  const lane = async () => {
    while (next < work.length) {
      const index = next;
      next += 1;
      results[index] = await (work[index] as () => Promise<T>)();
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, work.length) }, lane));
  return results;
}

export class State extends Refs implements temptabs.TempTabState {
  readonly session: string;
  browser: Browser | null = null;
  instance: string | null = null;
  endpoint: Endpoint | null = null;
  readonly pages = new Map<string, Page>();
  readonly sessions = new Map<string, Page>();
  readonly endedSessions = new Set<string>();
  private readonly attachesInFlight = new Map<Page, Promise<boolean>>();
  readonly tabIds = new Map<string, string>();
  nextTab = 1;
  readonly labels = new Map<string, string>();
  readonly registry: Registry;
  readonly appTabs = new Map<string, string>();
  readonly usedAt = new Map<string, number>();
  readonly appGenerations = new Map<string, unknown>();
  readonly opened = new Set<string>();
  readonly frames = new Map<string, string>();
  readonly leases = new Set<string>();
  readonly claims = new ClaimSet();
  readonly offscreen = new Set<string>();
  readonly views = new Map<string, unknown>();
  readonly snapshotsShown = new Map<string, unknown>();
  pendingShown: Map<string, unknown | null> | null = null;
  scriptsRunning = 0;
  commandsRun = 0;
  readonly failedNavigations = new Map<string, number>();
  readonly initSources = new Map<string, string>();
  readonly listeners: Listener[] = [];
  targetInfos = new Map<string, Json>();
  credentials: unknown = null;
  pendingReaction: unknown = null;
  consentDismissed: string | null = null;
  clickNote: string | null = null;
  loadNote: string | null = null;
  leftOffscreen: string | null = null;
  scriptState = "{}";
  topCommand: string | null = null;
  lost = false;
  restarted = false;
  autoDialog: boolean;
  pinTab: boolean;
  backgroundLive: boolean | null = null;
  hadTab = false;
  attached: string | null = null;
  lostTab: LostTab | null = null;
  notice: string | null = null;
  pinnedTarget: string | null = null;
  mustClose = new Set<string>();
  readonly reservedCloses = new Set<string>();
  mustCloseTask: temptabs.TempTabState["mustCloseTask"] = null;
  caller: Caller | null = null;
  announced: Caller | null = null;
  private currentTarget: string | null = null;
  private discovering = false;

  constructor(
    readonly config: StateConfig,
    readonly resolveEndpoint: () => Promise<Endpoint>,
  ) {
    super();
    this.session = config.session;
    this.registry = new Registry(config.browseFd, config.key, config.session, config.owner ?? config.key);
    this.autoDialog = !config.noAutoDialog;
    this.pinTab = config.pinTab;
  }

  get dataDir(): string | null {
    return this.config.dataDir ?? null;
  }

  get dataRoot(): string | null {
    return this.config.dataRoot ?? null;
  }

  get current(): string | null {
    return this.currentTarget;
  }

  set current(targetId: string | null) {
    if (targetId !== this.currentTarget) this.registry.noteUsing(this.instance, targetId);
    this.currentTarget = targetId;
  }

  private connecting: Promise<void> | null = null;

  get connected(): boolean {
    return this.browser !== null && this.browser.alive && !this.discovering;
  }

  makeBrowser(endpoint: Endpoint): Browser {
    return new Browser(endpoint, (method, params, session) => this.onEvent(method, params, session), (error) => unreachableMessage(endpoint, error));
  }

  addNotice(notice: string): void {
    this.notice = [this.notice, notice].filter((part) => part).join("\n");
  }

  async connect(): Promise<void> {
    for (;;) {
      if (this.connected) return;
      const pending = this.connecting;
      if (pending === null) {
        const attempt = this.connectOnce();
        this.connecting = attempt;
        try {
          return await attempt;
        } finally {
          if (this.connecting === attempt) this.connecting = null;
        }
      }
      try {
        await untilCancelled(pending);
      } catch (error) {
        if (!(error instanceof Cancelled) || currentSignal()?.aborted) throw error;
      }
    }
  }

  private async connectOnce(): Promise<void> {
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
    const browser = this.makeBrowser(endpoint);
    this.announced = null;
    const announcing = this.announceCaller(endpoint);
    try {
      await browser.open();
    } catch (error) {
      await shield(() => browser.close());
      throw error;
    } finally {
      await announcing;
    }
    this.browser = browser;
    this.endpoint = endpoint;
    this.instance = endpoint.instance;
    for (const page of this.pages.values()) page.detach();
    this.sessions.clear();
    this.discovering = true;
    try {
      await this.watchTargets(browser);
      await this.refreshTargets();
    } catch (error) {
      if (browser.alive) {
        this.browser = null;
        for (const page of this.pages.values()) page.detach();
        this.sessions.clear();
        await shield(() => browser.close());
      }
      throw error;
    } finally {
      this.discovering = false;
    }
    await temptabs.sweep(this);
    spent("connect_ms", started);
  }

  async watchTargets(browser: Browser): Promise<void> {
    try {
      await browser.send("Target.setDiscoverTargets", { discover: true });
    } catch (error) {
      if (!quiet(error)) throw error;
    }
  }

  async announceCaller(endpoint: Endpoint | null): Promise<void> {
    const caller = this.caller;
    if (caller === null || sameCaller(caller, this.announced) || endpoint === null || endpoint.explicit) return;
    if (await announce(announcePath(endpoint.source), caller, undefined, currentSignal())) this.announced = caller;
  }

  async disconnect(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    for (const page of this.pages.values()) page.detach();
    this.sessions.clear();
    if (browser !== null) await browser.close();
  }

  async refreshTargets(): Promise<Json[]> {
    const takenAt = wallSeconds();
    const raw = (await (this.browser as Browser).send("Target.getTargets"))["targetInfos"];
    const infos = (Array.isArray(raw) ? raw : []).map(record);
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
    this.usedAt.delete(targetId);
    const page = this.pages.get(targetId);
    this.pages.delete(targetId);
    page?.detach();
    const wasOpened = this.opened.has(targetId);
    this.opened.delete(targetId);
    this.frames.delete(targetId);
    this.targetInfos.delete(targetId);
    this.views.delete(targetId);
    this.snapshotsShown.delete(targetId);
    this.pendingShown?.delete(targetId);
    this.setOffscreen(targetId, false);
    for (const [label, owner] of [...this.labels]) if (owner === targetId) this.labels.delete(label);
    if (this.current === targetId && !this.pinTab) {
      this.lostTab = {
        target: targetId,
        app: this.appTabs.get(targetId),
        tab: this.tabIds.get(targetId),
        generation: this.appGenerations.get(targetId) ?? null,
        opened: wasOpened,
        borrowed: this.attached === targetId,
      };
      this.current = null;
    }
    this.appTabs.delete(targetId);
    this.appGenerations.delete(targetId);
  }

  get run(): string {
    const instance = this.instance ?? "";
    const pid = /^([0-9]+):/u.exec(instance);
    return pid ? `pid:${pid[1]}` : instance;
  }

  noteAppTabs(paired: ReadonlyMap<string, string>, present: ReadonlySet<string> | null = null): void {
    try {
      const run = this.run;
      const owned = this.registry.sessionTabs();
      const put = new Map<string, { run: string; target: string }>();
      let readopted = false;
      for (const [target, app] of paired) {
        const entry = owned.get(app);
        if (this.opened.has(target)) {
          if (entry === undefined || entry.target !== target || entry.run !== run) put.set(app, { run, target });
        } else if (entry !== undefined && run !== "" && (entry.target === target || entry.run !== run)) {
          this.opened.add(target);
          this.registry.noteOpened(this.instance, target);
          put.set(app, { run, target });
          readopted = true;
        }
      }
      const stale = owned.size + put.size >= MAX_SESSION_TABS ? Number.POSITIVE_INFINITY : wallSeconds() - TOUCH_AFTER;
      const touch = present === null ? [] : [...owned].filter(([app, entry]) => present.has(app) && !put.has(app) && entry.at < stale).map(([app]) => app);
      this.registry.updateSessionTabs(put, [], touch);
      if (readopted) flag("tab_readopted_after_restart", true);
    } catch {}
  }

  dropRecorded(app: string | undefined): void {
    if (app === undefined) return;
    try {
      this.registry.updateSessionTabs(new Map(), [app]);
    } catch {}
  }

  private recordedTabs(): Map<string, SessionTab> | null {
    try {
      return this.registry.sessionTabs();
    } catch {
      return null;
    }
  }

  ownsSessionTabs(): boolean {
    return (this.recordedTabs()?.size ?? 0) > 0;
  }

  recorded(targetId: string): boolean {
    const app = this.appTabs.get(targetId);
    return app !== undefined && this.recordedTabs()?.get(app)?.target === targetId;
  }

  pairOpenedLater(targetId: string): void {
    withSignal(null, () => {
      void (async () => {
        for (let attempt = 0; attempt < PAIR_TRIES; attempt += 1) {
          if (attempt > 0) await sleep(PAIR_WAIT);
          if (!this.opened.has(targetId) || this.endpoint === null || this.recorded(targetId)) return;
          await appTabMap(this).catch(() => undefined);
        }
      })().catch(() => {});
    });
  }

  needsPairingBeforeClose(): boolean {
    const owned = this.recordedTabs() ?? new Map<string, SessionTab>();
    const liveApps = new Set([...this.appTabs].filter(([target]) => this.targetInfos.has(target)).map(([, app]) => app));
    const unrecorded = [...this.opened].some((target) => this.targetInfos.has(target) && owned.get(this.appTabs.get(target) ?? "")?.target !== target);
    return unrecorded || [...owned.keys()].some((app) => !liveApps.has(app));
  }

  async pairBeforeClosing(): Promise<void> {
    if (this.needsPairingBeforeClose()) await appTabMap(this, CLOSE_PAIR_TIMEOUT).catch(() => undefined);
  }

  async readoptOpenedTabs(): Promise<void> {
    if (this.ownsSessionTabs()) await appTabMap(this).catch(() => undefined);
  }

  setOffscreen(targetId: string, offscreen: boolean): void {
    if (offscreen) this.offscreen.add(targetId);
    else this.offscreen.delete(targetId);
    if (this.offscreen.size > 0) this.leases.add("offscreen");
    else this.leases.delete("offscreen");
  }

  releaseClaim(targetId: string, kind: string): void {
    const fd = this.config.browseFd;
    if (fd === null || !this.config.key) return;
    try {
      releaseClaims(fd, this.config.key, targetId, kind);
    } catch (error) {
      if (!(error instanceof BrowseError) && !(error instanceof Error && "code" in error)) throw error;
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
    const params = record(raw);
    if (typeof sessionId === "string" && sessionId) {
      const page = this.sessions.get(sessionId);
      if (page === undefined) return;
      if (page.oopifs.has(sessionId)) {
        page.onChildEvent(sessionId, method, params);
        return;
      }
      if (method === "Inspector.detached") {
        flag("renderer_exit_kept_session", true);
        return;
      }
      if (method === "Inspector.targetCrashed") {
        page.framesChanged();
        page.markCrashed();
        return;
      }
      if (method === "Inspector.targetReloadedAfterCrash") {
        page.framesChanged();
        page.crashed = false;
        return;
      }
      page.onEvent(method, params);
      return;
    }
    if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
      const info = record(params["targetInfo"]);
      if (isPageInfo(info)) this.targetInfos.set(String(info["targetId"]), info);
    } else if (method === "Target.targetDestroyed") {
      this.forgetTarget(String(params["targetId"]));
    } else if (method === "Target.detachedFromTarget") {
      const session = String(params["sessionId"]);
      const owner = this.sessions.get(session);
      if (owner !== undefined) owner.endSession(session);
      else rememberEnded(this.endedSessions, session);
    }
    for (const listener of [...this.listeners]) listener(null, method, params);
  }

  onPageEvent(page: Page, method: string, params: Json): void {
    for (const listener of [...this.listeners]) listener(page, method, params);
  }

  noteUsed(targetId: string): void {
    this.usedAt.set(targetId, monotonic());
  }

  async page(target: string | null = null): Promise<Page> {
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
      targetId = await this.followLostTab();
    }
    if (!this.targetInfos.has(targetId)) {
      await this.refreshTargets();
      if (!this.targetInfos.has(targetId)) {
        this.forgetTarget(targetId);
        if (!explicit && targetId === this.lostTab?.target) return this.page();
        throw new BrowseError("That tab was closed", { targetId }, "tab_gone");
      }
    }
    this.noteUsed(targetId);
    let page = this.pages.get(targetId);
    if (page === undefined) {
      page = new Page(this, targetId);
      this.pages.set(targetId, page);
    }
    if (this.attachesInFlight.has(page) || !this.attachedFully(page)) {
      const before = page.attaches;
      if ((await this.attachShared(page)) || before > 0) flag("reattached_after_detach", true);
    }
    if (page.needsEnable && !page.crashed) await page.enablePage();
    this.hadTab = true;
    spent("attach_ms", started);
    return page;
  }

  attachedFully(page: Page): boolean {
    return (page.sessionId !== null || (page.crashed && page.attaching !== null)) && page.browser === this.browser;
  }

  async reattach(page: Page, url: string | null = null): Promise<Page> {
    if (!this.attachesInFlight.has(page) && this.attachedFully(page)) return page;
    let recovered: boolean;
    try {
      recovered = await this.attachShared(page);
    } catch (error) {
      if (error instanceof CdpError || (error instanceof BrowseError && !(error instanceof ConnectionLost) && error.code === "tab_detached")) throw detachedError(url ?? page.url);
      throw error;
    }
    if (recovered || page.attaches > 1) flag("reattached_after_detach", true);
    return page;
  }

  private async attachShared(page: Page): Promise<boolean> {
    let recovered = false;
    for (let round = 1; ; round += 1) {
      const running = this.attachesInFlight.get(page);
      if (running !== undefined) recovered = (await running) || recovered;
      else if (!this.attachedFully(page)) {
        const attempt = this.attachBounded(page);
        this.attachesInFlight.set(page, attempt);
        try {
          recovered = (await attempt) || recovered;
        } finally {
          if (this.attachesInFlight.get(page) === attempt) this.attachesInFlight.delete(page);
        }
      }
      if (this.attachedFully(page)) return recovered || round > 1;
      if (round >= REATTACH_TRIES) throw detachedError(page.url);
    }
  }

  private async attachBounded(page: Page): Promise<boolean> {
    for (let attempt = 1; ; attempt += 1) {
      if (this.pages.get(page.targetId) !== page || !this.targetInfos.has(page.targetId)) throw detachedError(page.url);
      try {
        await page.attach(this.browser as Browser);
        return attempt > 1;
      } catch (error) {
        const ended = error instanceof CdpError && envelopeGone(error);
        if (error instanceof CdpError && !ended) throw error;
        if (!ended && (!(error instanceof BrowseError) || error instanceof ConnectionLost || error.code !== "tab_detached")) throw error;
        if (attempt >= REATTACH_TRIES) throw detachedError(page.url);
      }
    }
  }

  async followLostTab(): Promise<string> {
    const lost = this.lostTab;
    const gone = lost?.tab ? ` [${lost.tab}]` : "";
    const fix = "Pick one with `ardia browse tab active` or `ardia browse tab <id>`, or open one with `ardia browse open <url>`";
    const appTab = lost?.app;
    if (lost && appTab) {
      await this.refreshTargets();
      const found = await appTabTarget(this, appTab);
      if (found.target) {
        const targetId = found.target;
        this.current = targetId;
        this.appTabs.set(targetId, appTab);
        this.lostTab = null;
        if (lost.borrowed) this.attached = targetId;
        if (lost.opened) {
          this.opened.add(targetId);
          this.registry.noteOpened(this.instance, targetId);
        }
        if (this.pinTab && this.pinnedTarget === lost.target) this.pinnedTarget = targetId;
        this.notice =
          `→ Ardia replaced the page of this session's tab${gone} (${appTab}), so the session follows it: ` +
          `[${this.tabId(targetId)}] ${String(found.title || found.url || "")}`;
        return targetId;
      }
      if (found.asleep) {
        throw new BrowseError(
          `This session's tab${gone} (${appTab}) is still open in Ardia, but Ardia unloaded its page, so there is ` +
            `nothing to drive until it loads again (click it in Ardia, or \`ardia browse open <url>\` for a copy). ${fix}`,
          { appTabId: appTab },
          "tab_asleep",
        );
      }
    }
    throw new BrowseError(`This session's tab${gone} is gone (closed, or Ardia replaced its page and didn't say which page took over). ${fix}`, null, "tab_gone");
  }

  async takeActive(): Promise<string> {
    let targetId = await this.activeTarget();
    if (targetId === UNKNOWN) targetId = await this.shownTarget();
    if (!targetId) throw new BrowseError(NO_PAGE, null, "no_tab");
    await this.refreshTargets();
    if (!this.targetInfos.has(targetId)) throw new BrowseError(NO_PAGE, null, "no_tab");
    this.current = targetId;
    this.attached = targetId;
    if (this.pinTab) this.pinnedTarget = targetId;
    return targetId;
  }

  async activeTarget(): Promise<string | null | typeof UNKNOWN> {
    const active = this.endpoint?.active;
    if (!active) return UNKNOWN;
    let answer: unknown;
    try {
      answer = await fetchActive(active, currentSignal());
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      return UNKNOWN;
    }
    if (answer === null) return null;
    if (typeof answer !== "object" || Array.isArray(answer)) return UNKNOWN;
    const targetId = (answer as Json)["targetId"];
    if (targetId === undefined || targetId === null) return null;
    return typeof targetId === "string" ? targetId : UNKNOWN;
  }

  async shownTarget(): Promise<string | null> {
    await this.refreshTargets();
    const candidates = [...this.targetInfos].filter(([, info]) => info["url"] !== "about:blank").map(([targetId]) => targetId);
    const found = new Map<string, Probe>();
    let skipped = candidates;
    for (let attempt = 0; attempt < PROBE_PASSES; attempt += 1) {
      if (attempt) await sleep(PROBE_BACKOFF * attempt);
      const probes = await gate(
        skipped.map((targetId) => () => this.probe(targetId)),
        PROBE_FANOUT,
      );
      skipped.forEach((targetId, index) => {
        const probed = probes[index];
        if (probed !== null && probed !== undefined) found.set(targetId, probed);
      });
      skipped = skipped.filter((_, index) => probes[index] === null);
      if (skipped.length === 0 || [...found.values()].some(([visible, focused]) => visible && focused)) break;
    }
    const focused = candidates.filter((targetId) => {
      const probed = found.get(targetId);
      return probed !== undefined && probed[0] && probed[1];
    });
    const visible = candidates.filter((targetId) => found.get(targetId)?.[0] === true);
    if (focused.length > 0 || visible.length > 0) return (focused[0] ?? visible[0]) as string;
    if (skipped.length > 0) {
      throw new BrowseError(
        `Couldn't check which tab is active: ${skipped.length} tabs weren't probed because DevTools attaches on this connection ` +
          "haven't been answered. Try again once Ardia catches up, or `ardia browse close` this session to start its connection over",
        null,
        "attaches_unanswered",
      );
    }
    return null;
  }

  async probe(targetId: string): Promise<Probe | null> {
    const browser = this.browser as Browser;
    let attached: Json;
    try {
      attached = await browser.send("Target.attachToTarget", { targetId, flatten: true }, { timeout: PROBE_TIMEOUT });
    } catch (error) {
      if (!quiet(error)) throw error;
      return (error as BrowseError).code === "attaches_unanswered" ? null : [false, false];
    }
    const session = String(attached["sessionId"]);
    try {
      const tree = await browser.send("Page.getFrameTree", null, { session, timeout: PROBE_TIMEOUT });
      const frame = record(record(tree["frameTree"])["frame"])["id"];
      if (typeof frame !== "string") return [false, false];
      const world = await browser.send("Page.createIsolatedWorld", { frameId: frame, worldName: WORLD_NAME }, { session, timeout: PROBE_TIMEOUT });
      const result = await browser.send(
        "Runtime.evaluate",
        { expression: "[document.visibilityState === 'visible', document.hasFocus()]", contextId: world["executionContextId"], returnByValue: true },
        { session, timeout: PROBE_TIMEOUT },
      );
      const value = record(result["result"])["value"];
      if (!Array.isArray(value) || value.length !== 2) return [false, false];
      return [Boolean(value[0]), Boolean(value[1])];
    } catch (error) {
      if (quiet(error)) return [false, false];
      throw error;
    } finally {
      await shield(() => browser.send("Target.detachFromTarget", { sessionId: session }, { timeout: PROBE_TIMEOUT, signal: null }).catch(() => ({})));
    }
  }

  frameFor(page: Page): string | null {
    const frame = this.frames.get(page.targetId);
    if (frame && !page.frames.has(frame)) {
      throw new BrowseError(
        "The frame chosen with `ardia browse frame` is gone, so commands won't fall back to another document. " +
          "Run `ardia browse frame main` or choose another frame",
        null,
        "frame_gone",
      );
    }
    return frame ?? null;
  }

  async resolveBareRef(ref: string): Promise<[Page, Element]> {
    try {
      return await this.resolveRef(ref);
    } catch (error) {
      if (!(error instanceof BrowseError) || error.code !== "unknown_ref") throw error;
      throw new BrowseError(
        `Unknown ref: ${ref}. A bare ${ref} is read as the ref @${ref}, and no snapshot in this session gave it; use an @eN ref from the latest \`ardia browse snapshot -i\``,
        null,
        "unknown_ref",
      );
    }
  }

  async locate(selector: string, page: Page | null = null, wait = 0): Promise<[Page, Element]> {
    const ref = parseRef(selector);
    if (ref) return isBareRef(selector) ? this.resolveBareRef(ref) : this.resolveRef(ref);
    const here = page ?? (await this.page());
    if (NTH_SUFFIX.test(selector)) flag("selector_nth", true);
    const deadline = monotonic() + wait;
    let polled = false;
    let tries = 0;
    for (;;) {
      const frame = (this.frameFor(here) || here.mainFrame) as string;
      let remote: unknown;
      try {
        remote = await here.call("(s) => ardiaBrowse.query(s)", [selector], { frame, byValue: false, read: true });
      } catch (error) {
        if (!(error instanceof BrowseError)) throw error;
        if (["document_changed", "page_navigated", "frame_gone"].includes(error.code ?? "") && monotonic() + APPEAR_POLL < deadline) {
          polled = true;
          await sleep(APPEAR_POLL);
          continue;
        }
        if (error.code !== "page_script_error") throw error;
        throw new BrowseError(`Invalid selector ${selector}: ${error.text}`);
      }
      const pierced = tries % pierce.cadence.locate === 0 || monotonic() + APPEAR_POLL > deadline;
      tries += 1;
      const element = (await here.elementFrom(remote, frame, selector)) ?? (pierced ? await pierce.queryOne(here, frame, selector) : null);
      if (element !== null) {
        if (polled) flag("waited_for_element", true);
        return [here, element];
      }
      if (monotonic() + APPEAR_POLL > deadline) break;
      polled = true;
      await sleep(APPEAR_POLL);
    }
    const waited = wait ? ` (waited ${formatG(wait)} s for it to appear)` : "";
    throw new BrowseError(
      `Element not found: ${selector}${waited}. Verify the selector, role, or name is correct and the element exists in the DOM.`,
      null,
      "not_found",
    );
  }

  describeTabs(appTabs: ReadonlyMap<string, string> | null = null): TabRow[] {
    const [openedElsewhere, usedElsewhere] = this.registry.others(this.instance);
    const hidden = this.registry.hidden(this.instance);
    if (this.current !== null) hidden.delete(this.current);
    const rows: TabRow[] = [];
    for (const [targetId, info] of this.targetInfos) {
      if ((info["url"] === "about:blank" && !this.opened.has(targetId) && targetId !== this.current) || hidden.has(targetId)) continue;
      rows.push({
        tabId: this.tabId(targetId),
        appTabId: appTabs?.get(targetId) || this.appTabs.get(targetId) || null,
        label: [...this.labels].find(([, owner]) => owner === targetId)?.[0] ?? null,
        targetId,
        title: info["title"] || "",
        url: info["url"] || "",
        type: "page",
        active: targetId === this.current,
        openedBySession: this.opened.has(targetId),
        openedBy: this.opened.has(targetId) ? this.session : (openedElsewhere.get(targetId) ?? null),
        usedBy: usedElsewhere.get(targetId) ?? [],
      });
    }
    const order = (row: TabRow) => (/^[0-9]+$/u.test(row.tabId.slice(1)) ? Number(row.tabId.slice(1)) : 0);
    return rows.sort((a, b) => order(a) - order(b));
  }

  async findTab(ref: string): Promise<string> {
    const labelled = this.labels.get(ref);
    if (labelled !== undefined) return labelled;
    for (const [targetId, tab] of this.tabIds) if (tab === ref && this.targetInfos.has(targetId)) return targetId;
    const shared = this.registry.targetOf(this.instance, ref);
    if (shared !== null && this.targetInfos.has(shared)) return shared;
    if (this.targetInfos.has(ref)) return ref;
    const upper = ref.toUpperCase();
    const matches = [...this.targetInfos.keys()].filter((targetId) => targetId.startsWith(upper) && [...ref].length >= 6);
    if (matches.length === 1) return matches[0] as string;
    if (/^[0-9]+$/u.test(ref)) throw new BrowseError(`Tab ids look like t${ref}, not ${ref}; run \`ardia browse tab\` to list open tabs`);
    if (APP_TAB.test(ref)) {
      const found = await appTabTarget(this, ref);
      if (found.target) {
        this.appTabs.set(found.target, ref);
        return found.target;
      }
      throw appTabError(found, ref);
    }
    throw new BrowseError(`Tab ${ref} not found; run \`ardia browse tab\` to list open tabs`, null, "tab_not_found");
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
