import { describe, expect, test } from "bun:test";
import { dispatch } from "../../src/browse/commands/all.ts";
import { Ctx } from "../../src/browse/commands/ctx.ts";
import { BrowseError, CdpError } from "../../src/browse/daemon-errors.ts";
import { begin, type Metrics } from "../../src/browse/metrics.ts";
import { State } from "../../src/browse/state/state.ts";

const START = "https://mine.example/start";
const DEST = "https://mine.example/dest";

type Sent = [string, Record<string, unknown> | null, string | null];

class DetachBrowser {
  readonly alive = true;
  readonly closedByUs = false;
  readonly sent: Sent[] = [];
  attached = 0;
  url = START;
  loader = "L1";
  afterLoad: ((session: string | null) => void) | null = null;
  refuseOnSecondSession = new Set<string>();

  constructor(readonly state: State) {}

  async send(method: string, params: Record<string, unknown> | null = null, options: { session?: string | null } = {}): Promise<Record<string, unknown>> {
    const session = options.session ?? null;
    this.sent.push([method, params, session]);
    await new Promise((resolve) => setImmediate(resolve));
    if (this.refuseOnSecondSession.has(method) && session !== "S1") throw new CdpError(method, "refused");
    if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "9" };
    if (method === "Target.attachToTarget") {
      this.attached += 1;
      return { sessionId: `S${this.attached}` };
    }
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F", url: this.url, loaderId: this.loader, securityOrigin: "https://mine.example" } } };
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
    if (method === "Runtime.callFunctionOn") {
      const source = String(params?.["functionDeclaration"]);
      return { result: { value: source.includes("document.title") ? "Destination" : source.includes("readyState") ? "complete" : false } };
    }
    if (method === "Page.navigate") {
      this.url = String(params?.["url"]);
      this.loader = "L2";
      setImmediate(() => this.loaded(session));
      return { frameId: "F", loaderId: "L2" };
    }
    return {};
  }

  loaded(session: string | null): void {
    this.state.onEvent("Page.frameNavigated", { frame: { id: "F", url: this.url, loaderId: "L2" } }, session);
    this.state.onEvent("Page.lifecycleEvent", { frameId: "F", loaderId: "L2", name: "load" }, session);
    this.afterLoad?.(session);
  }

  async close(): Promise<void> {}
}

function detachSetup(): { state: State; browser: DetachBrowser } {
  const state = new State({ session: "t", key: "", browseFd: null, noAutoDialog: false, pinTab: false }, () => Promise.reject(new Error("unused")));
  state.instance = "I";
  state.targetInfos = new Map([["T", { targetId: "T", url: START, type: "page" }]]);
  state.current = "T";
  const browser = new DetachBrowser(state);
  state.browser = browser as never;
  return { state, browser };
}

async function open(state: State): Promise<{ data: Record<string, unknown>; metrics: Metrics }> {
  return begin({ argv: ["open"] }, async (metrics) => {
    await state.page("T");
    const result = await dispatch(new Ctx(state, {}, "/", {}, null, "open"), "open", [DEST]);
    return { data: result.data as Record<string, unknown>, metrics };
  });
}

async function failedOpen(state: State): Promise<{ error: BrowseError; metrics: Metrics }> {
  return begin({ argv: ["open"] }, async (metrics) => {
    await state.page("T");
    const error = (await dispatch(new Ctx(state, {}, "/", {}, null, "open"), "open", [DEST]).catch((thrown: unknown) => thrown)) as BrowseError;
    return { error, metrics };
  });
}

function detachAfterLoad(state: State, browser: DetachBrowser): void {
  browser.afterLoad = (session) => state.onEvent("Target.detachedFromTarget", { sessionId: session, targetId: "T" }, null);
}

async function setUpSession(state: State): Promise<void> {
  const page = await state.page("T");
  page.initScripts.set("1", "window.hooked = 1");
  page.scriptSources.set("1", "window.hooked = 1");
  page.overrides.set("Emulation.setGeolocationOverride", { latitude: 1.0, longitude: 2.0, accuracy: 10 });
  state.claims.add("T", "route");
  state.credentials = { username: "u", password: "p" };
}

describe("test_browse_detach.OpenAfterDetach", () => {
  test("test_an_open_whose_session_ardia_ended_while_the_tab_stayed_open_attaches_again_and_finishes", async () => {
    const { state, browser } = detachSetup();
    detachAfterLoad(state, browser);
    const { data, metrics } = await open(state);
    expect(data["url"]).toBe(DEST);
    expect(data["title"]).toBe("Destination");
    expect(browser.attached).toBe(2);
    expect(state.pages.get("T")?.sessionId).toBe("S2");
    expect(metrics.values.get("reattached_after_detach")).toBe(true);
  });

  test("test_a_renderer_that_exits_keeps_the_session_and_opens_no_other", async () => {
    const { state, browser } = detachSetup();
    browser.afterLoad = (session) => {
      for (let index = 0; index < 3; index += 1) state.onEvent("Inspector.detached", { reason: "Render process gone." }, session);
    };
    const { data, metrics } = await open(state);
    expect(data["title"]).toBe("Destination");
    expect(browser.attached).toBe(1);
    expect(browser.sent.map(([method]) => method)).not.toContain("Target.detachFromTarget");
    expect(state.pages.get("T")?.sessionId).toBe("S1");
    expect(metrics.values.get("renderer_exit_kept_session")).toBe(true);
    expect(metrics.values.has("reattached_after_detach")).toBe(false);
  });

  test("test_a_reattach_puts_back_init_scripts_overrides_and_routes", async () => {
    const { state, browser } = detachSetup();
    await setUpSession(state);
    detachAfterLoad(state, browser);
    const { data, metrics } = await open(state);
    expect(data["title"]).toBe("Destination");
    const again = browser.sent.filter(([, , session]) => session === "S2").map(([method, params]) => [method, params]);
    expect(again).toContainEqual(["Page.addScriptToEvaluateOnNewDocument", { source: "window.hooked = 1" }]);
    expect(again).toContainEqual(["Emulation.setGeolocationOverride", { latitude: 1.0, longitude: 2.0, accuracy: 10 }]);
    expect(again).toContainEqual(["Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }], handleAuthRequests: true }]);
    expect(Object.fromEntries(state.pages.get("T")?.scriptIds ?? [])).toEqual({ "1": "9" });
    expect(metrics.values.get("setup_restored")).toBe(true);
  });

  test("test_a_reattach_that_cant_put_back_its_setup_fails_and_names_what_was_lost", async () => {
    const { state, browser } = detachSetup();
    await setUpSession(state);
    browser.refuseOnSecondSession = new Set(["Emulation.setGeolocationOverride", "Page.addScriptToEvaluateOnNewDocument"]);
    detachAfterLoad(state, browser);
    const { error, metrics } = await failedOpen(state);
    expect(error.code).toBe("setup_lost");
    expect(error.text).toContain("init script 1");
    expect(error.text).toContain("the geolocation");
    const page = state.pages.get("T");
    expect([page?.initScripts.size, page?.overrides.size]).toEqual([0, 0]);
    expect(metrics.values.get("setup_restore_failed")).toBe(true);
  });

  test("test_an_open_whose_tab_closed_still_fails_as_detached", async () => {
    const { state, browser } = detachSetup();
    browser.afterLoad = () => state.onEvent("Target.targetDestroyed", { targetId: "T" }, null);
    const { error, metrics } = await failedOpen(state);
    expect(error.code).toBe("tab_detached");
    expect(browser.attached).toBe(1);
    expect(metrics.values.has("reattached_after_detach")).toBe(false);
  });
});

class CrashBrowser {
  readonly alive = true;
  readonly closedByUs = false;
  crashed = true;
  readonly sent: string[] = [];
  hang = false;
  crashDuringEnable = false;

  constructor(readonly state: State) {}

  async send(method: string, _params: unknown = null, options: { session?: string | null } = {}): Promise<Record<string, unknown>> {
    this.sent.push(method);
    if (this.hang) return new Promise(() => {});
    if (this.crashDuringEnable && method === "Page.enable") throw new BrowseError("The tab's page crashed", null, "tab_crashed");
    if (method === "Target.attachToTarget") return { sessionId: "S" };
    if (method === "Inspector.enable" && this.crashed) {
      this.state.onEvent("Inspector.targetCrashed", {}, options.session ?? null);
      await new Promise((resolve) => setImmediate(resolve));
      return {};
    }
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F", url: "https://mine.example/", loaderId: "L", securityOrigin: "https://mine.example" } } };
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
    return {};
  }

  async close(): Promise<void> {}
}

function crashSetup(): { state: State; browser: CrashBrowser } {
  const state = new State({ session: "t", key: "", browseFd: null, noAutoDialog: false, pinTab: false }, () => Promise.reject(new Error("unused")));
  state.instance = "I";
  state.targetInfos = new Map([["T", { targetId: "T", url: "https://mine.example/", type: "page" }]]);
  const browser = new CrashBrowser(state);
  state.browser = browser as never;
  return { state, browser };
}

describe("test_browse_crash.CrashedTab", () => {
  test("test_a_tab_that_crashed_before_the_session_attached_waits_for_a_reload_then_enables_its_page", async () => {
    const { state, browser } = crashSetup();
    const page = await state.page("T");
    expect(page.crashed).toBe(true);
    expect(page.needsEnable).toBe(true);
    expect(browser.sent).toEqual(["Target.attachToTarget", "Inspector.enable"]);
    const refused = (await page.send("Runtime.evaluate", { expression: "1" }).catch((error: unknown) => error)) as BrowseError;
    expect(refused.code).toBe("tab_crashed");
    await state.page("T");
    expect(browser.sent).not.toContain("Page.enable");
    browser.crashed = false;
    state.onEvent("Inspector.targetReloadedAfterCrash", {}, "S");
    expect(page.crashed).toBe(false);
    const again = await state.page("T");
    expect(again).toBe(page);
    expect(page.needsEnable).toBe(false);
    expect(browser.sent).toContain("Page.enable");
    expect(browser.sent).toContain("Page.setLifecycleEventsEnabled");
    expect(page.mainFrame).toBe("F");
  });

  test("test_a_crash_while_attached_fails_the_waiting_calls_as_crashed", async () => {
    const { state, browser } = crashSetup();
    browser.crashed = false;
    const page = await state.page("T");
    expect(page.crashed).toBe(false);
    browser.hang = true;
    const waiting = page.send("Runtime.evaluate", { expression: "1" }).catch((error: unknown) => error);
    await new Promise((resolve) => setImmediate(resolve));
    state.onEvent("Inspector.targetCrashed", {}, "S");
    expect(((await waiting) as BrowseError).code).toBe("tab_crashed");
    expect(page.sessionId).toBe("S");
  });

  test("test_a_page_setup_cut_short_by_a_second_crash_is_retried_after_the_next_reload", async () => {
    const { state, browser } = crashSetup();
    const page = await state.page("T");
    expect(page.needsEnable).toBe(true);
    browser.crashed = false;
    state.onEvent("Inspector.targetReloadedAfterCrash", {}, "S");
    browser.crashDuringEnable = true;
    expect(await state.page("T").catch((error: unknown) => error)).toBeInstanceOf(BrowseError);
    expect(page.needsEnable).toBe(true);
    browser.crashDuringEnable = false;
    await state.page("T");
    expect(page.needsEnable).toBe(false);
    expect(page.mainFrame).toBe("F");
  });
});
