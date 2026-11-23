import { describe, expect, test } from "bun:test";
import { Cancelled } from "../../src/browse/cdp/cancel.ts";
import { dispatch } from "../../src/browse/commands/all.ts";
import { Ctx } from "../../src/browse/commands/ctx.ts";
import { BrowseError, CdpError, ConnectionLost, Gated } from "../../src/browse/daemon-errors.ts";
import { READPAGES_EXTRACT, READPAGES_SETTLE_PROBE } from "../../src/browse/js/index.ts";
import { begin, type Metrics } from "../../src/browse/metrics.ts";
import { goto, readers } from "../../src/browse/read/pages.ts";
import { type Page } from "../../src/browse/state/page.ts";
import { State } from "../../src/browse/state/state.ts";

const START = "https://mine.example/start";
const DEST = "https://mine.example/dest";
const SECOND = "https://mine.example/second";

type Sent = [string, Record<string, unknown> | null, string | null];
type Options = { session?: string | null; signal?: AbortSignal | null };

class DetachingBrowser {
  readonly alive = true;
  readonly closedByUs = false;
  readonly sent: Sent[] = [];
  attached = 0;
  created = 0;
  readonly urls = new Map<string, string>([["T", START]]);
  readonly loaders = new Map<string, string>([["T", "L1"]]);
  readonly targets = new Map<string, string>();
  readonly dead = new Set<string>();
  answered: string[] = [];
  readonly after = new Map<string, (session: string | null) => void>();
  readonly during = new Map<string, () => void>();

  constructor(readonly state: State) {}

  async send(method: string, params: Record<string, unknown> | null = null, options: Options = {}): Promise<Record<string, unknown>> {
    const session = options.session ?? null;
    this.sent.push([method, params, session]);
    await new Promise((resolve) => setImmediate(resolve));
    if (session !== null && this.dead.has(session)) throw new CdpError(method, "Session with given id not found");
    const source = method === "Runtime.callFunctionOn" ? String(params?.["functionDeclaration"]) : "";
    const cut = this.during.get(`${method} ${session}`) ?? this.during.get(`${method} *`);
    if (cut) {
      this.during.delete(`${method} ${session}`);
      this.during.delete(`${method} *`);
      cut();
      await new Promise((resolve) => setImmediate(resolve));
      if (options.signal?.aborted) throw new Cancelled();
    }
    const result = this.answer(method, params, session, source);
    const hook = this.after.get(source === READPAGES_SETTLE_PROBE ? "probe" : method);
    if (hook) {
      this.after.delete(source === READPAGES_SETTLE_PROBE ? "probe" : method);
      setImmediate(() => hook(session));
    }
    return result;
  }

  answer(method: string, params: Record<string, unknown> | null, session: string | null, source: string): Record<string, unknown> {
    if (method === "Target.attachToTarget") {
      this.attached += 1;
      this.targets.set(`S${this.attached}`, String(params?.["targetId"] ?? "T"));
      return { sessionId: `S${this.attached}` };
    }
    if (method === "Target.createTarget") {
      this.created += 1;
      const targetId = `R${this.created}`;
      this.state.onEvent("Target.targetCreated", { targetInfo: { targetId, type: "page", url: "about:blank", title: "" } }, null);
      return { targetId };
    }
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F", url: this.urlOf(session), loaderId: this.loaderOf(session), securityOrigin: "https://mine.example" } } };
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
    if (method === "Runtime.evaluate" && params?.["expression"] === "globalThis") return { result: { type: "object", objectId: "WORLD-HANDLE" } };
    if (method === "Runtime.callFunctionOn") return { result: this.callResult(source, session) };
    if (method === "DOM.describeNode") return { node: { backendNodeId: 5, nodeName: "BUTTON" } };
    if (method === "DOM.getContentQuads") return { quads: [[10, 10, 110, 10, 110, 40, 10, 40]] };
    if (method === "Page.navigate") {
      const target = this.targetOf(session);
      const url = String(params?.["url"]);
      const loader = `L-${url}`;
      this.urls.set(target, url);
      this.loaders.set(target, loader);
      this.answered.push(String(session));
      setImmediate(() => this.loaded(session, loader));
      return { frameId: "F", loaderId: loader };
    }
    return {};
  }

  targetOf(session: string | null): string {
    return (session !== null && this.targets.get(session)) || "T";
  }

  urlOf(session: string | null): string {
    return this.urls.get(this.targetOf(session)) ?? "about:blank";
  }

  loaderOf(session: string | null): string {
    return this.loaders.get(this.targetOf(session)) ?? "L0";
  }

  callResult(source: string, session: string | null): Record<string, unknown> {
    if (source === READPAGES_SETTLE_PROBE) return { value: ["complete", "fingerprint", false] };
    if (source === READPAGES_EXTRACT) return { value: { title: `Title of ${this.urlOf(session)}`, text: `The text of ${this.urlOf(session)} `.repeat(20), status: 200, matched: true } };
    if (source.includes("ardiaBrowse.query")) return { type: "object", subtype: "node", objectId: "BUTTON" };
    if (source.includes("ardiaBrowse.info")) return { value: { connected: true } };
    if (source.includes("ardiaBrowse.viewport")) return { value: { width: 1280, height: 800, scrollX: 0, scrollY: 0, docWidth: 1280, docHeight: 800 } };
    if (source.includes("document.contentType")) return { value: "text/html" };
    if (source.includes("document.title")) return { value: "Destination" };
    if (source.includes("readyState")) return { value: "complete" };
    return { value: null };
  }

  loaded(session: string | null, loader: string): void {
    this.state.onEvent("Page.frameNavigated", { frame: { id: "F", url: this.urlOf(session), loaderId: loader } }, session);
    this.state.onEvent("Page.lifecycleEvent", { frameId: "F", loaderId: loader, name: "DOMContentLoaded" }, session);
    this.state.onEvent("Page.lifecycleEvent", { frameId: "F", loaderId: loader, name: "load" }, session);
  }

  navigations(): (string | null)[] {
    return this.sent.filter(([method]) => method === "Page.navigate").map(([, , session]) => session);
  }

  calls(method: string, type: string | null = null): (string | null)[] {
    return this.sent.filter(([sent, params]) => sent === method && (type === null || params?.["type"] === type)).map(([, , session]) => session);
  }

  async close(): Promise<void> {}
}

function setup(): { state: State; browser: DetachingBrowser } {
  const state = new State({ session: "t", key: "", browseFd: null, noAutoDialog: false, pinTab: false }, () => Promise.reject(new Error("unused")));
  state.instance = "I";
  state.targetInfos = new Map([["T", { targetId: "T", url: START, type: "page" }]]);
  state.current = "T";
  const browser = new DetachingBrowser(state);
  state.browser = browser as never;
  return { state, browser };
}

function detach(state: State, session: string | null = "S1"): void {
  if (session !== null) (state.browser as unknown as DetachingBrowser).dead.add(session);
  state.onEvent("Target.detachedFromTarget", { sessionId: session, targetId: "T" }, null);
}

function closeTab(state: State): void {
  state.onEvent("Target.targetDestroyed", { targetId: "T" }, null);
}

async function run(state: State, command: string, args: string[]): Promise<{ data: Record<string, unknown> | null; error: BrowseError | null; metrics: Metrics }> {
  return begin({ argv: [command] }, async (metrics) => {
    await state.page("T");
    try {
      const result = await dispatch(new Ctx(state, {}, "/", {}, null, command), command, args);
      return { data: result.data as Record<string, unknown>, error: null, metrics };
    } catch (error) {
      if (!(error instanceof BrowseError)) throw error;
      return { data: null, error, metrics };
    }
  });
}

async function gotoOn(state: State, before: (() => void) | null = null): Promise<{ page: Page; metrics: Metrics }> {
  return begin({ argv: ["read"] }, async (metrics) => {
    const page = await state.page("T");
    before?.();
    await goto(page, DEST, 5);
    return { page, metrics };
  });
}

describe("open keeps its tab when Ardia ends the session", () => {
  test("a session ended while open waits for the load attaches again and finishes without navigating twice", async () => {
    const { state, browser } = setup();
    browser.after.set("Page.navigate", (session) => detach(state, session));
    const { data, error, metrics } = await run(state, "open", [DEST]);
    expect(error).toBeNull();
    expect(data?.["url"]).toBe(DEST);
    expect(data?.["title"]).toBe("Destination");
    expect(browser.navigations()).toEqual(["S1"]);
    expect(state.pages.get("T")?.sessionId).toBe("S2");
    expect(metrics.values.get("reattached_after_detach")).toBe(true);
  });

  test("a session ended before the navigation was sent attaches again and sends it once, on the new session", async () => {
    const { state, browser } = setup();
    const original = browser.answer.bind(browser);
    let cut = false;
    browser.answer = (method, params, session, source) => {
      const answer = original(method, params, session, source);
      if (method === "Network.enable" && !cut) {
        cut = true;
        detach(state, session);
      }
      return answer;
    };
    const { data, error, metrics } = await run(state, "open", [DEST]);
    expect(error).toBeNull();
    expect(data?.["url"]).toBe(DEST);
    expect(browser.answered).toEqual(["S2"]);
    expect(metrics.values.get("reattached_after_detach")).toBe(true);
  });

  test("a new session ended while it is set up is attached again", async () => {
    const { state, browser } = setup();
    browser.after.set("Page.navigate", (session) => detach(state, session));
    browser.during.set("Page.getFrameTree S2", () => detach(state, "S2"));
    const { data, error } = await run(state, "open", [DEST]);
    expect(error).toBeNull();
    expect(data?.["title"]).toBe("Destination");
    expect(browser.attached).toBe(3);
    expect(state.pages.get("T")?.sessionId).toBe("S3");
    expect(browser.navigations()).toEqual(["S1"]);
  });

  test("network capture cut off on the new session is enabled again on the next one", async () => {
    const { state, browser } = setup();
    await (await state.page("T")).enableNetwork();
    browser.after.set("Page.navigate", (session) => detach(state, session));
    browser.during.set("Network.enable S2", () => detach(state, "S2"));
    const { error } = await run(state, "open", [DEST]);
    expect(error).toBeNull();
    expect(browser.calls("Network.enable").filter((session) => session !== "S1").slice(0, 2)).toEqual(["S2", "S3"]);
    expect(state.pages.get("T")?.networkOn).toBe(true);
  });

  test("the runtime cut off on the new session is enabled again on the next one", async () => {
    const { state, browser } = setup();
    await (await state.page("T")).enableRuntime();
    browser.after.set("Page.navigate", (session) => detach(state, session));
    browser.during.set("Runtime.enable S2", () => detach(state, "S2"));
    const { error } = await run(state, "open", [DEST]);
    expect(error).toBeNull();
    expect(browser.calls("Runtime.enable")).toEqual(["S1", "S2", "S3"]);
    expect(state.pages.get("T")?.runtimeOn).toBe(true);
  });

  test("a navigation the detach cut off after it took is not sent again and the open finishes", async () => {
    const { state, browser } = setup();
    browser.during.set("Page.navigate S1", () => {
      browser.urls.set("T", DEST);
      browser.loaders.set("T", "L-took");
      detach(state);
    });
    const { data, error, metrics } = await run(state, "open", [DEST]);
    expect(error).toBeNull();
    expect(data?.["url"]).toBe(DEST);
    expect(browser.navigations()).toEqual(["S1"]);
    expect(browser.attached).toBe(2);
    expect(metrics.values.get("reattached_after_detach")).toBe(true);
  });

  test("a navigation the detach cut off before it took stays an unknown outcome and is not sent again", async () => {
    const { state, browser } = setup();
    browser.during.set("Page.navigate S1", () => detach(state));
    const { error } = await run(state, "open", [DEST]);
    expect(error?.code).toBe("outcome_unknown");
    expect(browser.navigations()).toEqual(["S1"]);
  });

  test("a tab that closes while it is attached again fails as detached and names the page", async () => {
    const { state, browser } = setup();
    browser.after.set("Page.navigate", (session) => detach(state, session));
    browser.during.set("Page.getFrameTree S2", () => closeTab(state));
    const { error, metrics } = await run(state, "open", [DEST]);
    expect(error?.code).toBe("tab_detached");
    expect(error?.text).toContain(DEST);
    expect(browser.attached).toBe(2);
    expect(metrics.values.has("reattached_after_detach")).toBe(false);
  });

  test("a blank tab that closed names the page open was opening", async () => {
    const { state, browser } = setup();
    browser.urls.set("T", "about:blank");
    state.targetInfos.set("T", { targetId: "T", url: "about:blank", type: "page" });
    const page = await state.page("T");
    detach(state);
    closeTab(state);
    const failure = await state.reattach(page, DEST).catch((error: unknown) => error);
    expect((failure as BrowseError).code).toBe("tab_detached");
    expect((failure as BrowseError).text).toContain(`(${DEST})`);
  });

  test("a tab that closes while the navigation is in flight stays an unknown outcome and names the page", async () => {
    const { state, browser } = setup();
    browser.urls.set("T", "about:blank");
    state.targetInfos.set("T", { targetId: "T", url: "about:blank", type: "page" });
    browser.after.set("Network.enable", () => closeTab(state));
    const { error } = await run(state, "open", [DEST]);
    expect(error?.code).toBe("outcome_unknown");
    expect(error?.text).toContain(DEST);
  });
});

describe("read keeps its tab when Ardia ends the session", () => {
  test("a session ended before the read navigates attaches again and sends the navigation once", async () => {
    const { state, browser } = setup();
    const { page } = await gotoOn(state, () => detach(state));
    expect(page.url).toBe(DEST);
    expect(page.sessionId).toBe("S2");
    expect(browser.answered).toEqual(["S2"]);
  });

  test("a session ended while the page settles attaches again and finishes", async () => {
    const { state, browser } = setup();
    browser.after.set("probe", (session) => detach(state, session));
    const { page, metrics } = await gotoOn(state);
    expect(page.url).toBe(DEST);
    expect(page.sessionId).toBe("S2");
    expect(browser.navigations()).toEqual(["S1"]);
    expect(metrics.values.get("reattached_after_detach")).toBe(true);
  });

  test("a read of a tab that closed fails as detached and names the page", async () => {
    const { state } = setup();
    const failure = await gotoOn(state, () => closeTab(state)).catch((error: unknown) => error);
    expect((failure as BrowseError).code).toBe("tab_detached");
    expect((failure as BrowseError).text).toContain(DEST);
  });

  test("a multi-page read whose reading tab loses its session mid-load reads every page in the same tabs", async () => {
    const { state, browser } = setup();
    let cut = false;
    const readIn = readers.readIn;
    readers.readIn = async (page, url, selector, timeout, options) => {
      if (!cut && url === SECOND) {
        cut = true;
        browser.after.set("Page.navigate", (session) => {
          if (session !== null) browser.dead.add(session);
          state.onEvent("Target.detachedFromTarget", { sessionId: session, targetId: page.targetId }, null);
        });
      }
      return readIn(page, url, selector, timeout, options);
    };
    try {
      const { data, error, metrics } = await run(state, "read", [DEST, SECOND]);
      expect(error).toBeNull();
      const pages = (data?.["pages"] ?? data?.["results"] ?? data) as unknown;
      const text = JSON.stringify(pages);
      expect(text).toContain(`Title of ${DEST}`);
      expect(text).toContain(`Title of ${SECOND}`);
      expect(text).not.toContain("detached");
      expect(browser.navigations().filter((session) => session !== null)).toHaveLength(2);
      expect(metrics.values.get("reattached_after_detach")).toBe(true);
      expect(metrics.values.has("read_tabs_reopened")).toBe(false);
    } finally {
      readers.readIn = readIn;
    }
  });
});

describe("a detach during an action is never retried", () => {
  test("a detach while click presses the mouse fails as an unknown outcome and doesn't click again", async () => {
    const { state, browser } = setup();
    const original = browser.answer.bind(browser);
    let pressed = 0;
    browser.answer = (method, params, session, source) => {
      if (method === "Input.dispatchMouseEvent" && params?.["type"] === "mousePressed" && pressed++ === 0) detach(state, session);
      return original(method, params, session, source);
    };
    const { error } = await run(state, "click", ["#go"]);
    expect(error?.code).toBe("outcome_unknown");
    expect(browser.calls("Input.dispatchMouseEvent", "mousePressed")).toEqual(["S1"]);
    expect(browser.calls("Input.dispatchMouseEvent", "mouseReleased")).toEqual([]);
    expect(browser.navigations()).toEqual([]);
  });
});

describe("a detach is settled by what Chrome did, never by sending again", () => {
  test("a read whose tab closes after its navigation was sent doesn't navigate again in a new tab", async () => {
    const { state, browser } = setup();
    const original = browser.answer.bind(browser);
    let acted = 0;
    browser.answer = (method, params, session, source) => {
      const result = original(method, params, session, source);
      if (method === "Page.navigate" && params?.["url"] === DEST && ++acted === 1) {
        state.onEvent("Target.targetDestroyed", { targetId: browser.targetOf(session) }, null);
      }
      return result;
    };
    const { error } = await run(state, "read", [DEST, SECOND]);
    expect(error).toBeNull();
    expect(acted).toBe(1);
  });

  test("another page arriving while the navigation was cut off stays an unknown outcome", async () => {
    const { state, browser } = setup();
    browser.during.set("Page.navigate S1", () => {
      browser.urls.set("T", SECOND);
      browser.loaders.set("T", "L-unrelated");
      detach(state);
    });
    const { error } = await run(state, "open", [DEST]);
    expect(error?.code).toBe("outcome_unknown");
  });

  test("a dead session answered during setup, before its detach event, is attached again", async () => {
    const { state, browser } = setup();
    const page = await state.page("T");
    await page.enableNetwork();
    detach(state);
    const original = browser.send.bind(browser);
    browser.send = async (method, params, options) => {
      if (method === "Network.enable" && options?.session === "S2") {
        browser.dead.add("S2");
        throw new CdpError(method, "Session with given id not found.", null, -32001);
      }
      return original(method, params, options);
    };
    const failure = await state.reattach(page, DEST).catch((error: unknown) => error);
    expect(failure).toBe(page);
    expect(page.sessionId).toBe("S3");
  });

  test("a detach during the second send is settled like the first", async () => {
    const { state, browser } = setup();
    await state.page("T");
    const original = browser.send.bind(browser);
    browser.send = async (method, params, options) => {
      if (method === "Page.navigate" && options?.session === "S1") browser.dead.add("S1");
      return original(method, params, options);
    };
    browser.during.set("Page.navigate S2", () => {
      browser.urls.set("T", DEST);
      browser.loaders.set("T", "L-took");
      detach(state, "S2");
    });
    const { error } = await run(state, "open", [DEST]);
    expect(error).toBeNull();
    expect(browser.navigations()).toEqual(["S1", "S2"]);
  });

  test("a detach that arrives before the new session is registered is attached again", async () => {
    const { state, browser } = setup();
    const page = await state.page("T");
    detach(state);
    const original = browser.send.bind(browser);
    browser.send = async (method, params, options) => {
      const result = await original(method, params, options);
      if (method === "Target.attachToTarget" && result["sessionId"] === "S2") detach(state, "S2");
      return result;
    };
    const result = await state.reattach(page, DEST).catch((error: unknown) => error);
    expect(result instanceof BrowseError ? result.code : page.sessionId).toBe("S3");
  });

  test("a reading tab whose session ends while it is set up recovers before it navigates", async () => {
    const { state, browser } = setup();
    browser.during.set("Network.enable *", () => {
      const session = browser.calls("Network.enable").at(-1) ?? null;
      detach(state, session);
    });
    const { error } = await run(state, "read", [DEST]);
    expect(error?.code ?? null).toBeNull();
  });

  test("a refused attach isn't reported as an unsupported page", async () => {
    const { state, browser } = setup();
    await state.page("T");
    browser.dead.add("S1");
    const original = browser.send.bind(browser);
    browser.send = async (method, params, options) => {
      if (method === "Target.attachToTarget") throw new Gated(method, null, null, "to that target");
      return original(method, params, options);
    };
    const { error } = await run(state, "open", [DEST]);
    expect(error?.text).toContain("Target.attachToTarget");
  });

  test("a fresh tab whose first session ends during setup is attached again, and says so in telemetry", async () => {
    const { state, browser } = setup();
    state.current = null;
    browser.during.set("Page.getFrameTree S1", () => detach(state, "S1"));
    const { error, metrics } = await begin({ argv: ["open"] }, async (metrics) => {
      const ctx = new Ctx(state, {}, "/", {}, null, "open");
      const error = await dispatch(ctx, "open", [DEST]).catch((error: unknown) => error);
      return { error, metrics };
    });
    expect(error instanceof BrowseError ? error.code : "ok").toBe("ok");
    expect(metrics.values.get("reattached_after_detach")).toBe(true);
  });

  test("a caller arriving while a published session is still being set up waits for the setup", async () => {
    const { state, browser } = setup();
    const page = await state.page("T");
    await page.enableNetwork();
    detach(state);
    let setupStarted!: () => void;
    let releaseSetup!: () => void;
    const started = new Promise<void>((resolve) => {
      setupStarted = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    const original = browser.send.bind(browser);
    browser.send = async (method, params, options) => {
      if (method === "Network.enable" && options?.session === "S2") {
        setupStarted();
        await pause;
      }
      return original(method, params, options);
    };
    const first = state.reattach(page);
    await started;
    expect(page.sessionId).toBe("S2");
    const second = state.page("T");
    setImmediate(releaseSetup);
    await Promise.all([first, second]);
    expect(browser.calls("Page.enable").filter((session) => session === "S2")).toEqual(["S2"]);
  });

  test("a connection lost while the history is checked stays a lost connection", async () => {
    const { state, browser } = setup();
    const original = browser.answer.bind(browser);
    browser.answer = (method, params, session, source) => {
      if (method === "Page.getNavigationHistory") throw new ConnectionLost();
      return original(method, params, session, source);
    };
    browser.during.set("Page.navigate S1", () => {
      browser.urls.set("T", SECOND);
      browser.loaders.set("T", "L-unrelated");
      detach(state);
    });
    const { error } = await run(state, "open", [DEST]);
    expect(error?.code).toBe("connection_lost");
  });

  test("another hash route arriving while the navigation was cut off stays an unknown outcome", async () => {
    const { state, browser } = setup();
    const requested = DEST + "#/requested";
    const competing = DEST + "#/competing";
    browser.during.set("Page.navigate S1", () => {
      browser.urls.set("T", competing);
      browser.loaders.set("T", "L-unrelated");
      detach(state);
    });
    const { data, error } = await run(state, "open", [requested]);
    expect(error?.code ?? data?.["url"]).toBe("outcome_unknown");
  });

  test("history counts only when it describes the document that loaded", async () => {
    const { state, browser } = setup();
    const original = browser.answer.bind(browser);
    browser.answer = (method, params, session, source) => {
      if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{ url: START, transitionType: "typed", userTypedURL: DEST }] };
      return original(method, params, session, source);
    };
    browser.during.set("Page.navigate S1", () => {
      browser.urls.set("T", SECOND);
      browser.loaders.set("T", "L-unrelated");
      detach(state);
    });
    const { data, error } = await run(state, "open", [DEST]);
    expect(error?.code ?? data?.["url"]).toBe("outcome_unknown");
  });

  test("a tab that closes after a cut-off navigation keeps the outcome unknown", async () => {
    const { state, browser } = setup();
    browser.during.set("Page.navigate S1", () => {
      browser.urls.set("T", DEST);
      browser.loaders.set("T", "L-took");
      closeTab(state);
    });
    const { error } = await run(state, "open", [DEST]);
    expect(error?.code).toBe("outcome_unknown");
  });

  test("a second reattach joins the one already running", async () => {
    const { state, browser } = setup();
    const page = await state.page("T");
    detach(state);
    let setupStarted!: () => void;
    let releaseSetup!: () => void;
    const started = new Promise<void>((resolve) => { setupStarted = resolve; });
    const pause = new Promise<void>((resolve) => { releaseSetup = resolve; });
    const original = browser.send.bind(browser);
    browser.send = async (method, params, options) => {
      if (method === "Page.getFrameTree" && options?.session === "S2") {
        setupStarted();
        await pause;
      }
      return original(method, params, options);
    };
    const first = state.reattach(page).catch((error: unknown) => error);
    await started;
    const second = state.reattach(page).catch((error: unknown) => error);
    setImmediate(releaseSetup);
    const answers = await Promise.all([first, second]);
    expect(answers.every((answer) => answer === page)).toBe(true);
    expect(browser.attached).toBe(2);
  });

  test("a reply about a gone child session leaves the parent's session alone", async () => {
    const { state, browser } = setup();
    const page = await state.page("T");
    const original = browser.send.bind(browser);
    browser.send = async (method, params, options) => {
      if (method === "Target.detachFromTarget" && options?.session === "S1") {
        throw new CdpError(method, "No session with given id", null, -32602);
      }
      return original(method, params, options);
    };
    await page.send("Target.detachFromTarget", { sessionId: "already-gone-child" }, { session: "S1" }).catch(() => {});
    expect(page.sessionId).toBe("S1");
  });

  test("the caller that starts an attach never gets back a page whose session ended", async () => {
    const { state, browser } = setup();
    const page = await state.page("T");
    detach(state);
    const real = page.attach.bind(page);
    page.attach = (connection) => {
      const attaching = real(connection);
      if (browser.attached === 1) {
        attaching.then(() => queueMicrotask(() => detach(state, "S2")));
      } else {
        attaching.then(() => queueMicrotask(() => detach(state, "S2")));
      }
      return attaching;
    };
    await state.reattach(page);
    expect(page.sessionId).not.toBeNull();
  });

  test("a multi-page read reads a page again when the session ends during extraction", async () => {
    const { state, browser } = setup();
    let cut = false;
    const send = browser.send.bind(browser);
    browser.send = async (method, params, options) => {
      if (!cut && method === "Runtime.callFunctionOn" && params?.["functionDeclaration"] === READPAGES_EXTRACT) {
        cut = true;
        detach(state, options?.session);
      }
      return send(method, params, options);
    };
    const { data, error } = await run(state, "read", [DEST, SECOND]);
    expect(cut).toBe(true);
    expect(error).toBeNull();
    expect(browser.navigations()).toHaveLength(2);
    expect(JSON.stringify(data)).not.toContain("detached");
  });

  test("two rejected navigation sends name the page being opened", async () => {
    const { state, browser } = setup();
    const send = browser.send.bind(browser);
    browser.send = async (method, params, options) => {
      if (method === "Page.navigate") throw new CdpError(method, "Session with given id not found.", null, -32001);
      return send(method, params, options);
    };
    const { error } = await run(state, "open", [DEST]);
    expect(error?.code).toBe("tab_detached");
    expect(error?.text).toContain(DEST);
  });

  test("open --here --read reads only the picked tab", async () => {
    const { state, browser } = setup();
    const target = await state.page("T");
    state.attached = "T";
    state.targetInfos.set("OTHER", { targetId: "OTHER", url: SECOND, type: "page" });
    browser.urls.set("OTHER", SECOND);
    browser.loaders.set("OTHER", "L-other");
    const original = browser.callResult.bind(browser);
    browser.callResult = (source, session) => {
      if (source.includes("ardiaBrowse.readable")) return { value: "Read body from " + browser.urlOf(session) };
      return original(source, session);
    };
    state.followLostTab = async () => {
      state.current = "OTHER";
      return "OTHER";
    };
    const call = target.call.bind(target);
    target.call = async (...args) => {
      const result = await call(...args);
      if (args[0].includes("document.title")) closeTab(state);
      return result;
    };
    const { data, error } = await run(state, "open", ["--here", "--read", DEST]);
    expect((data?.["read"] as { finalUrl?: string } | undefined)?.finalUrl ?? error?.code).toBe("tab_gone");
  });

  test("a failed open --show leaves no handoff note for the next command", async () => {
    const { state, browser } = setup();
    state.setOffscreen("T", true);
    const send = browser.send.bind(browser);
    browser.send = async (method, params, options) => {
      if (method === "Target.activateTarget") throw new Gated(method);
      return send(method, params, options);
    };
    const first = await run(state, "open", [DEST, "--show"]);
    expect(first.error?.code).toBe("policy_refused");
    state.takeActive = async () => "R1";
    const result = await dispatch(new Ctx(state, {}, "/", {}, null, "tab"), "tab", ["active"]);
    expect(result.text).not.toContain("The viewport ended");
  });

  test("a tab attached again on first try still counts as recovered", async () => {
    const { state } = setup();
    await state.page("T");
    detach(state);
    await begin({ argv: ["read"] }, async (metrics) => {
      const page = await state.page("T");
      expect(page.sessionId).toBe("S2");
      expect(metrics.values.get("reattached_after_detach")).toBe(true);
    });
  });

  test("an unknown navigation outcome in a multi-page read stops a batch as outcome_unknown", async () => {
    const { state, browser } = setup();
    browser.during.set("Page.navigate *", () => {
      const last = browser.sent.findLast(([method]) => method === "Page.navigate");
      detach(state, last?.[2] ?? null);
    });
    const result = await begin({argv:["batch"]}, async (metrics) => {
      const result = await dispatch(new Ctx(state, {no_changes:true}, "/tmp", {}, null, "batch"), "batch", [JSON.stringify(["read", DEST, SECOND]), JSON.stringify(["open", START])]);
      return {rows:result.batch, code:metrics.errorCode};
    });
    expect(result.code).toBe("outcome_unknown");
  });
});
