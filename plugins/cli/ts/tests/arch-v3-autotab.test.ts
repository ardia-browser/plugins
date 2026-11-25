import { describe, expect, test } from "bun:test";
import "./libc-loaded.ts";
import "../src/browse/commands/all.ts";
import { Ctx } from "../src/browse/commands/ctx.ts";
import { BrowseError } from "../src/browse/daemon-errors.ts";
import { begin } from "../src/browse/metrics.ts";
import { dropRepl } from "../src/browse/script/host.ts";
import { cmdScript } from "../src/browse/script/script.ts";
import { NO_PAGE, NO_SESSION_TAB, State } from "../src/browse/state/state.ts";

function fakeState(activeTab: string | null) {
  const state = new State({ session: "autotab", key: "", browseFd: null, noAutoDialog: false, pinTab: false }, () => Promise.reject(new Error("unused")));
  let takeCalls = 0;
  const fakePage = {
    targetId: "T1",
    url: "https://desk.test/",
    mainFrame: "F1",
    frames: new Map([["F1", { id: "F1", parent: null, url: "https://desk.test/", name: "", origin: "https://desk.test" }]]),
    frameSessions: new Map(),
    loader: () => "L1",
    refreshFrames: async () => undefined,
    call: async (fn: string) => {
      if (fn.includes("document.title")) return "Desk";
      return "Desk";
    },
  };
  state.connect = async () => {
    if (activeTab !== null) state.targetInfos.set(activeTab, { targetId: activeTab, type: "page", url: "https://desk.test/", title: "Desk" });
  };
  state.refreshTargets = async () => {
    if (activeTab !== null) state.targetInfos.set(activeTab, { targetId: activeTab, type: "page", url: "https://desk.test/", title: "Desk" });
    return [];
  };
  state.takeActive = async () => {
    takeCalls += 1;
    if (activeTab === null) throw new BrowseError(NO_PAGE, null, "no_tab");
    state.current = activeTab;
    state.attached = activeTab;
    return activeTab;
  };
  state.page = async () => {
    if (state.current === null && !state.hadTab) throw new BrowseError(NO_SESSION_TAB, null, "no_session_tab");
    state.hadTab = true;
    return fakePage as never;
  };
  return { state, takeCalls: () => takeCalls };
}

describe("REPL auto-tab adoption", () => {
  test("fresh --repl auto-adopts the user's active tab once even across concurrent calls", async () => {
    const { state, takeCalls } = fakeState("T1");
    try {
      const ctx = new Ctx(state, {}, process.cwd(), {}, "const [t, u, f] = await Promise.all([page.title(), page.url(), page.frames()]); [t, u, f.length]", "script");
      let autoTabFlag: unknown;
      const result = await begin({ argv: ["script", "--repl"] }, async (metrics) => {
        const out = await cmdScript(ctx, ["--repl"]);
        autoTabFlag = metrics.values.get("script_repl_auto_tab");
        return out;
      });
      expect((result.data as { value: unknown }).value).toEqual(["Desk", "https://desk.test/", 1]);
      expect(takeCalls()).toBe(1);
      expect(state.current).toBe("T1");
      expect(state.attached).toBe("T1");
      expect(autoTabFlag).toBe(true);
    } finally {
      dropRepl(state);
    }
  });

  test("non-repl script keeps no_session_tab refusal without calling takeActive", async () => {
    const { state, takeCalls } = fakeState("T1");
    const ctx = new Ctx(state, {}, process.cwd(), {}, "try { await page.frames(); return 'ok'; } catch (e) { return e.code; }", "script");
    const result = await cmdScript(ctx, []);
    expect((result.data as { value: unknown }).value).toBe("no_session_tab");
    expect(takeCalls()).toBe(0);
    expect(state.current).toBeNull();
  });

  test("fresh --repl reports no_tab cleanly when the user isn't on a web page", async () => {
    const { state, takeCalls } = fakeState(null);
    try {
      const ctx = new Ctx(state, {}, process.cwd(), {}, "try { await page.title(); return 'ok'; } catch (e) { return e.code; }", "script");
      const result = await cmdScript(ctx, ["--repl"]);
      expect((result.data as { value: unknown }).value).toBe("no_tab");
      expect(takeCalls()).toBe(1);
    } finally {
      dropRepl(state);
    }
  });

  test("fresh --repl tab management does not adopt the active tab", async () => {
    const { state, takeCalls } = fakeState("T1");
    try {
      const ctx = new Ctx(state, {}, process.cwd(), {}, "const tabs = await listTabs(); tabs.length", "script");
      const result = await cmdScript(ctx, ["--repl"]);
      expect((result.data as { value: unknown }).value).toBe(1);
      expect(takeCalls()).toBe(0);
      expect(state.current).toBeNull();
    } finally {
      dropRepl(state);
    }
  });
});
