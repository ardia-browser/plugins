import { describe, expect, test } from "bun:test";
import { Cancelled, withSignal } from "../../src/browse/cdp/cancel.ts";
import { BrowseError, ConnectionLost, Usage } from "../../src/browse/daemon-errors.ts";
import { begin } from "../../src/browse/metrics.ts";
import { monotonic } from "../../src/browse/state/wait.ts";
import { Ctx } from "../../src/browse/commands/ctx.ts";
import { dispatch, served } from "../../src/browse/commands/all.ts";
import { tabLine } from "../../src/browse/commands/tabs.ts";
import { Element, type Page } from "../../src/browse/state/page.ts";
import { type State } from "../../src/browse/state/state.ts";
import { cdpError, FakeBrowser, MAIN, stateWith } from "./core-helpers.ts";

function ctxOf(state: State, command: string, options: Record<string, unknown> = {}): Ctx {
  return new Ctx(state, options, "/", {}, null, command);
}

function stopRetries(state: State): void {
  state.mustCloseTask?.stop.abort();
}

async function failure(run: Promise<unknown>): Promise<BrowseError> {
  return (await run.catch((error: unknown) => error)) as BrowseError;
}

function openDialog(page: Page, type = "prompt"): void {
  page.onEvent("Page.javascriptDialogOpening", { type, message: "Your name?", defaultPrompt: "guest" });
}

describe("the command table", () => {
  test("tab, window, frame, dialog, back, forward, reload and pushstate are served", () => {
    for (const name of ["tab", "window", "frame", "dialog", "back", "forward", "reload", "pushstate"]) expect(served(name)).toBe(true);
  });
});

describe("dialog never stays open after a failure", () => {
  test("accept joins its words into the prompt text", async () => {
    const browser = new FakeBrowser();
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    state.current = "TARGET";
    openDialog(page);
    const result = await dispatch(ctxOf(state, "dialog"), "dialog", ["accept", "Ada", "Lovelace"]);
    expect(result.data).toEqual({ handled: "accept" });
    const sent = browser.sent.filter((entry) => entry.method === "Page.handleJavaScriptDialog");
    expect(sent.map((entry) => entry.params)).toEqual([{ accept: true, promptText: "Ada Lovelace" }]);
    expect(page.dialog).toBeNull();
  });

  test("an accept the browser rejects is followed by a dismiss, and the first error is reported", async () => {
    let refusals = 1;
    const browser = new FakeBrowser((method) => {
      if (method === "Page.handleJavaScriptDialog" && refusals > 0) {
        refusals -= 1;
        return cdpError(method, "Invalid prompt text");
      }
      return undefined;
    });
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    state.current = "TARGET";
    openDialog(page);
    const error = await failure(dispatch(ctxOf(state, "dialog"), "dialog", ["accept", "x"]));
    expect(error.text).toContain("Invalid prompt text");
    const sent = browser.sent.filter((entry) => entry.method === "Page.handleJavaScriptDialog").map((entry) => entry.params);
    expect(sent).toEqual([{ accept: true, promptText: "x" }, { accept: false }]);
    expect(page.dialog).toBeNull();
  });

  test("a lost connection skips the fallback dismiss and propagates", async () => {
    const browser = new FakeBrowser((method) => (method === "Page.handleJavaScriptDialog" ? new ConnectionLost() : undefined));
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    state.current = "TARGET";
    openDialog(page);
    const error = await failure(dispatch(ctxOf(state, "dialog"), "dialog", ["dismiss"]));
    expect(error).toBeInstanceOf(ConnectionLost);
    expect(browser.methods().filter((method) => method === "Page.handleJavaScriptDialog")).toHaveLength(1);
  });

  test("Ctrl-C while the answer is in flight still lets the dialog close", async () => {
    let release: (() => void) | null = null;
    const browser = new FakeBrowser((method) =>
      method === "Page.handleJavaScriptDialog"
        ? () =>
            new Promise<Record<string, unknown>>((resolve) => {
              release = () => resolve({});
            })
        : undefined,
    );
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    state.current = "TARGET";
    openDialog(page);
    const stop = new AbortController();
    const running = withSignal(stop.signal, () => dispatch(ctxOf(state, "dialog"), "dialog", ["accept"]));
    while (release === null) await new Promise((resolve) => setImmediate(resolve));
    stop.abort();
    (release as () => void)();
    await running.catch(() => {});
    expect(page.dialog).toBeNull();
    expect(browser.methods().filter((method) => method === "Page.handleJavaScriptDialog")).toHaveLength(1);
  });

  test("status reads the dialog without any page call, and a bad action is a usage error", async () => {
    const browser = new FakeBrowser();
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    state.current = "TARGET";
    openDialog(page, "confirm");
    const before = browser.sent.length;
    const status = await dispatch(ctxOf(state, "dialog"), "dialog", []);
    expect(status.text).toBe('Dialog open: confirm "Your name?"');
    expect(status.pageContent).toBe(true);
    expect(browser.sent.length).toBe(before);
    expect(await failure(dispatch(ctxOf(state, "dialog"), "dialog", ["close"]))).toBeInstanceOf(Usage);
    page.onEvent("Page.javascriptDialogClosed", {});
    expect((await failure(dispatch(ctxOf(state, "dialog"), "dialog", ["accept"]))).text).toBe("No dialog is currently open");
  });
});

describe("dialog review fixes", () => {
  test("a dialog answer skips the busy probe that an open dialog can't answer", async () => {
    const browser = new FakeBrowser((method, params) => {
      if (method === "Runtime.evaluate" && params["expression"] === "1") return () => new Promise(() => {});
      return undefined;
    });
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    state.current = "TARGET";
    openDialog(page);
    page.unansweredAt = monotonic();
    const result = await begin({ argv: ["dialog"] }, () => dispatch(ctxOf(state, "dialog"), "dialog", ["accept", "Ada"]));
    expect(result.data).toEqual({ handled: "accept" });
    expect(browser.sent.filter((entry) => entry.method === "Runtime.evaluate" && entry.params["expression"] === "1")).toEqual([]);
    expect(page.dialog).toBeNull();
  });

  test("the fallback flag counts only a dismiss that went through", async () => {
    const refusing = new FakeBrowser((method) => (method === "Page.handleJavaScriptDialog" ? cdpError(method, "No dialog is showing") : undefined));
    const state = stateWith(refusing);
    const page = await state.page("TARGET");
    state.current = "TARGET";
    openDialog(page);
    const flags = await begin({ argv: ["dialog"] }, async (metrics) => {
      await dispatch(ctxOf(state, "dialog"), "dialog", ["accept"]).catch(() => null);
      return metrics.values.get("dialog_dismissed_after_failure");
    });
    expect(flags).toBeUndefined();
    expect(page.dialog).not.toBeNull();
    let first = true;
    const once = new FakeBrowser((method) => {
      if (method === "Page.handleJavaScriptDialog" && first) {
        first = false;
        return cdpError(method, "Invalid prompt text");
      }
      return undefined;
    });
    const other = stateWith(once);
    const otherPage = await other.page("TARGET");
    other.current = "TARGET";
    openDialog(otherPage);
    const counted = await begin({ argv: ["dialog"] }, async (metrics) => {
      await dispatch(ctxOf(other, "dialog"), "dialog", ["accept", "x"]).catch(() => null);
      return metrics.values.get("dialog_dismissed_after_failure");
    });
    expect(counted).toBe(true);
  });

  test("a fallback dismiss that throws a non-browse error keeps the original error", async () => {
    let calls = 0;
    const browser = new FakeBrowser((method) => {
      if (method !== "Page.handleJavaScriptDialog") return undefined;
      calls += 1;
      return calls === 1 ? cdpError(method, "Invalid prompt text") : new TypeError("boom");
    });
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    state.current = "TARGET";
    openDialog(page);
    const error = await failure(dispatch(ctxOf(state, "dialog"), "dialog", ["accept", "x"]));
    expect(error.text).toContain("Invalid prompt text");
  });
});

describe("tabs this session opens are closed through the registry", () => {
  test("a tab of the user's is never closed", async () => {
    const browser = new FakeBrowser();
    const state = stateWith(browser);
    state.current = "TARGET";
    const error = await failure(dispatch(ctxOf(state, "tab"), "tab", ["close"]));
    expect(error.text).toContain("is one of the user's tabs");
    expect(browser.methods()).not.toContain("Target.closeTarget");
  });

  test("Ctrl-C during the close gives the reservation back and queues the tab to be closed", async () => {
    const browser = new FakeBrowser((method) => (method === "Target.closeTarget" ? new Cancelled() : undefined));
    const state = stateWith(browser);
    state.current = "TARGET";
    state.opened.add("TARGET");
    const error = await failure(dispatch(ctxOf(state, "tab"), "tab", ["close"]));
    expect(error).toBeInstanceOf(Cancelled);
    expect(state.mustClose.has("TARGET")).toBe(true);
    expect(state.reservedCloses.has("TARGET")).toBe(true);
    expect(state.current).toBeNull();
    state.tabIds.set("TARGET", "t1");
    const again = await failure(dispatch(ctxOf(state, "tab"), "tab", ["close", "t1"]));
    expect(again.code).toBe("tab_closing");
    expect(again.text).toBe("Tab [t1] is already being closed (an earlier `tab close` was interrupted)");
    stopRetries(state);
  });

  test("a tab created after Ctrl-C is queued to be closed, not leaked", async () => {
    let answer: ((value: Record<string, unknown>) => void) | null = null;
    const browser = new FakeBrowser((method) =>
      method === "Target.createTarget"
        ? () =>
            new Promise<Record<string, unknown>>((resolve) => {
              answer = resolve;
            })
        : undefined,
    );
    const state = stateWith(browser);
    const stop = new AbortController();
    const running = withSignal(stop.signal, () => dispatch(ctxOf(state, "tab"), "tab", ["new"]));
    while (answer === null) await new Promise((resolve) => setImmediate(resolve));
    stop.abort();
    expect(await failure(running)).toBeInstanceOf(Cancelled);
    (answer as (value: Record<string, unknown>) => void)({ targetId: "LATE" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.mustClose.has("LATE")).toBe(true);
    stopRetries(state);
  });

  test("picking a tab by id ends a borrowed tab", async () => {
    const browser = new FakeBrowser();
    const state = stateWith(browser);
    state.current = "TARGET";
    state.attached = "TARGET";
    state.tabIds.set("TARGET", "t1");
    const result = await dispatch(ctxOf(state, "tab"), "tab", ["t1"]);
    expect((result.data as Record<string, unknown>)["tabId"]).toBe("t1");
    expect(state.attached).toBeNull();
  });

  test("a tab line names who opened and uses it", () => {
    const line = tabLine(
      { tabId: "t2", appTabId: "tab-a", title: "", url: "http://x/", active: true, openedBySession: false, openedBy: "other", usedBy: ["other", "third"] },
      "s",
    );
    expect(line).toBe("→ [t2] tab-a  http://x/ - http://x/ (opened by session other; in use by session third)");
  });
});

describe("navigation", () => {
  for (const [command, argv, what] of [
    ["back", [], "go back in"],
    ["forward", [], "go forward in"],
    ["reload", [], "reload"],
    ["pushstate", ["/x"], "change the address of"],
  ] as const) {
    test(`${command} refuses a borrowed tab without touching it`, async () => {
      const browser = new FakeBrowser();
      const state = stateWith(browser);
      state.current = "TARGET";
      state.attached = "TARGET";
      const error = await failure(dispatch(ctxOf(state, command), command, [...argv]));
      expect(error.code).toBe("borrowed_tab");
      expect(error.text).toContain(`so it won't ${what} it`);
      expect(browser.methods().filter((method) => ["Page.getNavigationHistory", "Page.reload", "Runtime.callFunctionOn"].includes(method))).toEqual([]);
    });
  }

  test("back on a tab this session opened stops at its first page instead of about:blank", async () => {
    const browser = new FakeBrowser((method) =>
      method === "Page.getNavigationHistory" ? { currentIndex: 1, entries: [{ url: "about:blank" }, { url: "http://127.0.0.1/page.html" }] } : undefined,
    );
    const state = stateWith(browser);
    state.current = "TARGET";
    state.opened.add("TARGET");
    const page = await state.page("TARGET");
    const calls = browser.methods().filter((method) => method === "Runtime.callFunctionOn").length;
    const result = await dispatch(ctxOf(state, "back"), "back", []);
    expect(result.text).toBe(page.url);
    expect(browser.methods().filter((method) => method === "Runtime.callFunctionOn").length).toBe(calls);
  });

  test("a reload loads a new document, and refs from the old one are stale", async () => {
    let page: Page | null = null;
    const browser = new FakeBrowser((method) => {
      if (method === "Page.reload") {
        setImmediate(() => {
          const reloaded = page as Page;
          reloaded.onEvent("Page.frameNavigated", { frame: { id: MAIN, loaderId: "LOADER-2", url: "http://127.0.0.1/page.html" } });
          reloaded.onEvent("Page.lifecycleEvent", { frameId: MAIN, loaderId: "LOADER-2", name: "load" });
        });
        return {};
      }
      if (method === "Page.getFrameTree" && page !== null && page.navigations > 0) {
        return { frameTree: { frame: { id: MAIN, loaderId: "LOADER-2", url: "http://127.0.0.1/page.html", name: "" }, childFrames: [] } };
      }
      return undefined;
    });
    const state = stateWith(browser);
    state.current = "TARGET";
    page = await state.page("TARGET");
    const ref = state.addRef(page, new Element(MAIN, "OBJ", 5, "x"), "button", "Go");
    state.setRefs([state.refs.get(ref) as never], "snap", page);
    const result = await dispatch(ctxOf(state, "reload"), "reload", []);
    expect(result.data).toEqual({ url: "http://127.0.0.1/page.html" });
    expect(page.loader(MAIN)).toBe("LOADER-2");
    const stale = await failure(state.resolveRef(ref));
    expect(stale.code).toBe("stale_ref");
  });
});

describe("test_browse_borrowed, ported", () => {
  function borrowedState(): [FakeBrowser, State] {
    const browser = new FakeBrowser((method, params) => {
      if (method === "Target.createTarget") return { targetId: "MINE" };
      if (method === "Target.getTargets") {
        return {
          targetInfos: [
            { targetId: "USER", type: "page", url: "http://127.0.0.1/page.html", title: "Draft" },
            ...(params["filter"] === undefined ? [{ targetId: "MINE", type: "page", url: "about:blank", title: "" }] : []),
          ],
        };
      }
      return undefined;
    });
    const state = stateWith(browser, ["USER"]);
    state.tabIds.set("USER", "t1");
    return [browser, state];
  }

  test("test_back_forward_reload_and_pushstate_refuse_a_borrowed_tab", async () => {
    const [, state] = borrowedState();
    state.current = "USER";
    state.attached = "USER";
    for (const [name, argv] of [["back", []], ["forward", []], ["reload", []], ["pushstate", ["/x"]]] as const) {
      const error = await failure(dispatch(ctxOf(state, name), name, [...argv]));
      expect(error.code).toBe("borrowed_tab");
      expect(error.text).toContain("ardia browse tab t");
    }
  });

  test("test_tab_active_takes_the_users_tab_without_letting_open_navigate_it", async () => {
    const [browser, state] = borrowedState();
    state.takeActive = async () => {
      state.current = "USER";
      state.attached = "USER";
      return "USER";
    };
    const result = await dispatch(ctxOf(state, "tab"), "tab", ["active"]);
    expect([(result.data as Record<string, unknown>)["targetId"], state.current, state.attached]).toEqual(["USER", "USER", "USER"]);
    const userSession = browser.sent.find((entry) => entry.method === "Target.attachToTarget" && entry.params["targetId"] === "USER");
    expect(userSession).toBeDefined();
    await dispatch(ctxOf(state, "open", { no_changes: true, timeout_ms: 200 }), "open", ["about:blank"]).catch(() => null);
    expect(browser.methods()).toContain("Target.createTarget");
    expect(browser.sent.filter((entry) => entry.method === "Page.navigate" && entry.session === "SESSION-1")).toEqual([]);
    expect(state.current).toBe("MINE");
  });

  test("test_tab_by_id_drives_the_users_tab", async () => {
    const [, state] = borrowedState();
    state.attached = "USER";
    await dispatch(ctxOf(state, "tab"), "tab", ["t1"]);
    expect(state.attached).toBeNull();
    expect(state.current).toBe("USER");
    const page = await state.page();
    expect(page.targetId).toBe("USER");
  });
});
