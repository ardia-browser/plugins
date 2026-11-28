import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import "./libc-loaded.ts";
import "../src/browse/commands/all.ts";
import { replArgv } from "../src/browse/route.ts";
import { placeEndpointFlags } from "../src/endpoint-flags.ts";
import { scriptSource } from "../src/browse/local.ts";
import { printGuide } from "../src/skills.ts";
import { checkCommand } from "../src/skill-examples.ts";
import { dropRepl, Runner, takeRunner, whenReady } from "../src/browse/script/host.ts";
import { render, Result } from "../src/browse/daemon/render.ts";
import { Ctx } from "../src/browse/commands/ctx.ts";
import { cmdOpen } from "../src/browse/commands/core.ts";
import { cmdGet } from "../src/browse/commands/read.ts";
import { closeTab } from "../src/browse/commands/tabs.ts";
import { refuseOnBorrowed } from "../src/browse/commands/borrowed.ts";
import { hasPendingReaction, settleReaction, watchReaction } from "../src/browse/changes/observe.ts";
import { pageForSelector } from "../src/browse/changes/dialogs.ts";
import { COUNTS as DAEMON_COUNTS, FLAGS as DAEMON_FLAGS } from "../src/browse/metrics.ts";
import { isMetricCount, isMetricFlag } from "../src/command-metrics.ts";
import { cmdScript, RunSemaphore } from "../src/browse/script/script.ts";
import { activeTarget, State, withTarget } from "../src/browse/state/state.ts";
import { BrowseError } from "../src/browse/daemon-errors.ts";

async function runMock(source: string, handler: (request: Record<string, unknown>) => Record<string, unknown>, repl = true) {
  const { runner } = takeRunner();
  const requests: Record<string, unknown>[] = [];
  try {
    expect(await whenReady(runner)).toBeGreaterThanOrEqual(0);
    runner.send({ type: "start", source, state: "{}", readBatch: 100, stateLimit: 1024 * 1024, ...(repl ? { repl: true, spill: 0 } : {}) });
    for (;;) {
      const event = await runner.next();
      if (event.type === "request") {
        const request = JSON.parse(event.request) as Record<string, unknown>;
        requests.push(request);
        runner.send({ type: "reply", id: request["id"] as number, answer: JSON.stringify(handler(request)) });
      } else if (event.type === "done") {
        return { requests, result: JSON.parse(event.result) as Record<string, unknown> };
      } else if (event.type === "exit") {
        throw new Error(`runner exited early: ${String(event.code ?? event.signal)}`);
      }
    }
  } finally {
    runner.kill();
  }
}

describe("top-level repl and guide routing", () => {
  test("replArgv hoists shared flags and forwards --timeout to script", () => {
    expect(replArgv(["repl", "return 1"])).toEqual({ hoisted: [], rest: ["return 1"] });
    expect(replArgv(["--port", "9444", "--json", "repl", "--close", "return 1"])).toEqual({
      hoisted: ["--port", "9444", "--json"],
      rest: ["--close", "return 1"],
    });
    expect(replArgv(["--timeout", "3m", "repl", "-e", "return 1"])).toEqual({
      hoisted: [],
      rest: ["--timeout", "3m", "-e", "return 1"],
    });
    expect(replArgv(["browse", "open", "https://example.com"])).toBeUndefined();
  });

  test("placeEndpointFlags keeps --port and moves --session after repl", () => {
    expect(placeEndpointFlags(["--session", "demo", "--port", "9444", "repl", "return 1"])).toEqual({
      argv: ["--port", "9444", "repl", "--session", "demo", "return 1"],
      dropped: [],
    });
  });

  test("scriptSource supports -e, -f, --close, and inline code", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ardia-repl-src-"));
    try {
      const file = path.join(dir, "job.js");
      writeFileSync(file, "return 42;");
      expect(scriptSource(["-e", "return 1 + 1", "--close"], dir, (p) => p)).toBe("return 1 + 1");
      expect(scriptSource(["-c", "return 2 + 2", "--ephemeral"], dir, (p) => p)).toBe("return 2 + 2");
      expect(scriptSource(["-f", file, "--cleanup"], dir, (p) => p)).toBe("return 42;");
      expect(scriptSource(["--reset"], dir, (p) => p)).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("printGuide serves SKILL.md, repl reference, and lists topics on unknown name", () => {
    const overview = printGuide(undefined);
    expect(overview.status).toBe(0);
    expect(overview.raw).toContain("ardia repl");
    const replDoc = printGuide("repl");
    expect(replDoc.status).toBe(0);
    expect(replDoc.raw).toContain("withTabs");
    expect(printGuide("script").raw).toBe(replDoc.raw);
    const bad = printGuide("nonexistent-topic");
    expect(bad.status).toBe(1);
    expect(bad.out[0]).toContain("Available topics:");
  });

  test("skill example checker validates ardia repl and ardia guide", () => {
    expect(checkCommand("ardia repl --close -e 'return 1'")).toEqual([]);
    expect(checkCommand("ardia repl -f task.js --timeout 3m")).toEqual([]);
    expect(checkCommand("ardia guide repl")).toEqual([]);
    expect(checkCommand("ardia repl --bogus-flag")[0]).toContain("doesn't take --bogus-flag");
  });

  test("compact_boundaries renders compact page-data fence", () => {
    const [, out] = render({ content_boundaries: true, compact_boundaries: true }, new Result({ value: 4 }, "4", true), null, "script");
    expect(out).toMatch(/^<page-data nonce="[0-9a-f]{16}">\n4\n<\/page-data>\n$/);
  });
});

describe("target-bound Page handles, multi-tab helpers, fast allTexts and snapshot diffing", () => {
  test("openTabs and withTabs bind requests to distinct targets and close on exit", async () => {
    let nextTarget = 1;
    const { requests, result } = await runMock(
      `
        const out = await withTabs(['https://a.test', 'https://b.test'], async ([a, b]) => {
          const [ta, tb] = await Promise.all([a.title(), b.title()]);
          const textsA = await a.locator('li').allTexts();
          return { ua: a.url(), ub: b.url(), ta, tb, textsA, liveCount: tabs.length };
        });
        return { out, afterCount: tabs.length };
      `,
      (request) => {
        const argv = (request["argv"] as string[]) ?? [];
        if (argv[0] === "tab" && argv[1] === "new") {
          const n = nextTarget++;
          return { ok: true, text: argv[2] ?? "", data: { tabId: `t${n}`, targetId: `T${n}`, url: argv[2] ?? "", owned: true } };
        }
        if (argv[0] === "tab" && argv[1] === "close") {
          return { ok: true, text: "closed", data: { closed: argv[2] } };
        }
        if (argv[0] === "get" && argv[1] === "title") {
          return { ok: true, text: `Title ${request["target"]}`, data: { title: `Title ${request["target"]}` } };
        }
        if (argv[0] === "get" && argv[1] === "texts") {
          return { ok: true, text: "one\ntwo", data: { texts: ["one", "two"] } };
        }
        return { ok: true, text: "ok", data: {} };
      },
    );
    expect(result["kind"]).toBe("done");
    expect(result["value"]).toEqual({
      out: { ua: "https://a.test", ub: "https://b.test", ta: "Title T1", tb: "Title T2", textsA: ["one", "two"], liveCount: 2 },
      afterCount: 0,
    });
    const opens = requests.filter((r) => Array.isArray(r["argv"]) && r["argv"][0] === "tab" && r["argv"][1] === "new");
    expect(opens.every((r) => r["parallelTab"] === true)).toBe(true);
    const closes = requests.filter((r) => Array.isArray(r["argv"]) && r["argv"][0] === "tab" && r["argv"][1] === "close");
    expect(closes).toHaveLength(2);
    expect(closes.every((r) => r["detachBorrowed"] === true)).toBe(true);
  });

  test("withTab closes the tab even when callback throws", async () => {
    const { requests, result } = await runMock(
      `
        let caught = null;
        try {
          await withTab('https://err.test', async () => { throw new Error('boom'); });
        } catch (err) {
          caught = err.message;
        }
        return { caught, remaining: tabs.length };
      `,
      (request) => {
        const argv = (request["argv"] as string[]) ?? [];
        if (argv[0] === "tab" && argv[1] === "new") return { ok: true, text: "", data: { tabId: "t1", targetId: "T1", url: "https://err.test", owned: true } };
        if (argv[0] === "tab" && argv[1] === "close") return { ok: true, text: "", data: { closed: "T1" } };
        return { ok: true, text: "", data: {} };
      },
    );
    expect(result["value"]).toEqual({ caught: "boom", remaining: 0 });
    expect(requests.some((r) => Array.isArray(r["argv"]) && r["argv"][0] === "tab" && r["argv"][1] === "close" && r["argv"][2] === "T1")).toBe(true);
  });

  test("snapshot auto-diffs across calls and serializes compact text", async () => {
    const trees = [
      "heading 'Home'\nbutton 'One' [@e1]\nbutton 'Two' [@e2]\nbutton 'Three' [@e3]\nbutton 'Four' [@e4]\nbutton 'Five' [@e5]",
      "heading 'Home'\nbutton 'One' [@e1]\nbutton 'Two' [@e2]\nbutton 'Three' [@e3]\nbutton 'Four' [@e4]\nbutton 'Five' [@e5]",
      "heading 'Home'\nbutton 'One' [@e1]\nbutton 'Two' [@e2]\nbutton 'Three' [@e3]\nbutton 'Four' [@e4]\nbutton 'Six' [@e6]",
    ];
    let step = 0;
    const { result } = await runMock(
      `
        const p = await openTab('https://snap.test');
        const s1 = await snapshot(p, { interactive: true });
        const s2 = await snapshot(p, { interactive: true });
        const s3 = await snapshot(p, { interactive: true });
        const s4 = await snapshot(p, { interactive: true, diff: false });
        return {
          d1: s1.diff,
          d2: s2.diff,
          d3: s3.diff,
          d4: s4.diff,
          serialized: JSON.parse(JSON.stringify(s3)),
        };
      `,
      (request) => {
        const argv = (request["argv"] as string[]) ?? [];
        if (argv[0] === "tab" && argv[1] === "new") return { ok: true, text: "", data: { tabId: "t1", targetId: "T1", url: "https://snap.test", owned: true } };
        if (argv[0] === "snapshot") return { ok: true, text: trees[Math.min(step++, trees.length - 1)], data: {} };
        return { ok: true, text: "", data: {} };
      },
    );
    const value = result["value"] as Record<string, unknown>;
    expect(value["d1"]).toBeNull();
    expect(value["d2"]).toBe("(no changes)");
    expect(value["d3"]).toBe("- button 'Five' [@e5]\n+ button 'Six' [@e6]");
    expect(value["d4"]).toBeNull();
    expect(value["serialized"]).toBe("- button 'Five' [@e5]\n+ button 'Six' [@e6]");
  });

  test("selectOption unwraps Playwright option objects, getByRole matches labels, refs normalize, and readUrls falls back when no tab is open", async () => {
    const { requests, result } = await runMock(
      `
        await page.selectOption('#start', { label: '2:00 PM' });
        await page.locator('[ref=e12]').click();
        const roleSel = page.getByRole('textbox', { name: /Annual total/ }).selector;
        const pages = await readUrls(['https://docs.test/a']);
        return { roleSel, pages };
      `,
      (request) => {
        const argv = (request["argv"] as string[]) ?? [];
        if (argv[0] === "read-urls") return { ok: false, error: "The user isn't on a web page right now", code: "not_web_page" };
        if (argv[0] === "read") return { ok: true, text: "doc", data: { pages: [{ url: "https://docs.test/a", text: "ok" }] } };
        return { ok: true, text: "ok", data: {} };
      },
    );
    expect(result["kind"]).toBe("done");
    const value = result["value"] as Record<string, unknown>;
    expect(String(value["roleSel"])).toContain("//label[");
    expect(String(value["roleSel"])).toContain("ancestor::label[");
    expect(value["pages"]).toEqual([
      { url: "https://docs.test/a", finalUrl: "https://docs.test/a", ok: true, title: "", content: "ok", text: "ok", chars: 2, truncated: false, error: null },
    ]);
    const argvs = requests.map((r) => r["argv"]);
    expect(argvs).toContainEqual(["select", "#start", "2:00 PM"]);
    expect(argvs).toContainEqual(["click", "@e12"]);
  });

  test("const tabs persists across REPL calls, withTabs cleans partial opens, attachTab enforces exact/unambiguous matching, and selectOption({index}) resolves by index", async () => {
    const runner = new Runner();
    try {
      expect(await whenReady(runner)).toBeGreaterThanOrEqual(0);
      const runTurn = async (source: string, handler: (request: Record<string, unknown>) => Record<string, unknown>) => {
        const requests: Record<string, unknown>[] = [];
        runner.send({ type: "start", source, state: "{}", readBatch: 100, stateLimit: 1024 * 1024, repl: true, spill: 0 });
        for (;;) {
          const event = await runner.next();
          if (event.type === "request") {
            const request = JSON.parse(event.request) as Record<string, unknown>;
            requests.push(request);
            runner.send({ type: "reply", id: request["id"] as number, answer: JSON.stringify(handler(request)) });
          } else if (event.type === "done") {
            return { requests, result: JSON.parse(event.result) as Record<string, unknown> };
          }
        }
      };

      const t1 = await runTurn("const tabs = await listTabs(); return tabs.length;", () => ({
        ok: true,
        text: "",
        data: { tabs: [{ tabId: "t1", targetId: "T1", url: "https://a.test", title: "Alpha", openedBySession: true }] },
      }));
      expect(t1.result["value"]).toBe(1);
      const t2 = await runTurn("return [Array.isArray(tabs), tabs[0].tabId];", () => ({ ok: true, text: "", data: {} }));
      expect(t2.result["value"]).toEqual([true, "t1"]);

      const t3 = await runTurn(
        `
          let emptyErr = null, ambigErr = null, partialErr = null;
          try { await attachTab(""); } catch (e) { emptyErr = e.name; }
          try { await attachTab("shared"); } catch (e) { ambigErr = e.message; }
          const owned = await attachTab("t1");
          await page.selectOption("#pick", { index: 1 });
          try {
            await withTabs(["https://ok.test", "https://fail.test"], async () => "never");
          } catch (e) {
            partialErr = e.message;
          }
          const fallback = await readUrls(["https://docs.test/a"], { maxChars: 4 });
          return { emptyErr, ambigErr, ownedFlag: owned.owned, partialErr, fallback };
        `,
        (request) => {
          if (request["op"] === "$eval") return { ok: true, text: "", data: { result: "opt-b" } };
          const argv = (request["argv"] as string[]) ?? [];
          if (argv[0] === "tab" && argv[1] === "list") {
            return {
              ok: true,
              text: "",
              data: {
                tabs: [
                  { tabId: "t1", targetId: "T1", url: "https://shared.test/1", title: "One", openedBySession: true },
                  { tabId: "t2", targetId: "T2", url: "https://shared.test/2", title: "Two", openedBySession: false },
                ],
              },
            };
          }
          if (argv[0] === "tab" && argv[1] === "new") {
            if (argv[2] === "https://fail.test") return { ok: false, error: "navigation failed", code: "navigation_failed" };
            return { ok: true, text: "", data: { tabId: "t9", targetId: "T9", url: argv[2], openedBySession: true } };
          }
          if (argv[0] === "tab" && argv[1] === "close") return { ok: true, text: "", data: { closed: argv[2] } };
          if (argv[0] === "read-urls") return { ok: false, error: "isn't on a web page", code: "not_web_page" };
          if (argv[0] === "read") return { ok: true, text: "", data: { pages: [{ url: "https://docs.test/a", title: "Doc", text: "abcdef" }] } };
          return { ok: true, text: "ok", data: {} };
        },
      );
      const val = t3.result["value"] as Record<string, unknown>;
      expect(val["emptyErr"]).toBe("TypeError");
      expect(String(val["ambigErr"])).toContain("Multiple tabs matched");
      expect(val["ownedFlag"]).toBe(true);
      expect(val["partialErr"]).toBe("navigation failed");
      expect(val["fallback"]).toEqual([
        { url: "https://docs.test/a", finalUrl: "https://docs.test/a", ok: true, title: "Doc", content: "abcd", text: "abcd", chars: 6, truncated: true, error: null },
      ]);
      expect(t3.requests.some((r) => Array.isArray(r["argv"]) && r["argv"][0] === "select" && r["argv"][2] === "opt-b")).toBe(true);
      expect(t3.requests.some((r) => Array.isArray(r["argv"]) && r["argv"][0] === "tab" && r["argv"][1] === "close" && r["argv"][2] === "T9")).toBe(true);

      runner.send({ type: "closed", targets: ["T1"] });
      const t4 = await runTurn("return await getTabByTargetId('T1').then(() => 'reattached');", () => ({
        ok: true,
        text: "",
        data: { tabs: [{ tabId: "t1", targetId: "T1", url: "https://shared.test/1", title: "One", openedBySession: true }] },
      }));
      expect(t4.requests.some((r) => Array.isArray(r["argv"]) && r["argv"][0] === "tab" && r["argv"][1] === "list")).toBe(true);
      expect(t4.result["value"]).toBe("reattached");
    } finally {
      runner.kill();
    }
  });
});

function serverTestState() {
  const state = new State({ session: "srv-test", key: "", browseFd: null, noAutoDialog: false, pinTab: false }, () => Promise.reject(new Error("unused")));
  const closedTargets: string[] = [];
  let failCloseFor: string | null = null;
  let nextCreated = 10;
  const makeFakePage = (targetId: string, url: string) => ({
    targetId,
    url,
    crashed: false,
    dialog: null,
    mainFrame: `F-${targetId}`,
    frames: new Map([[`F-${targetId}`, { id: `F-${targetId}`, parent: null, url, name: "", origin: new URL(url).origin, loader: `L-${targetId}` }]]),
    frameSessions: new Map(),
    sessionFor: () => null,
    loader: () => `L-${targetId}`,
    detach: () => undefined,
    refreshFrames: async () => undefined,
    resolveBackend: async (backendId: number, frame: string) => ({ backendId, frame, objectId: `obj-${backendId}` }),
    call: async (fn: string) => {
      if (fn.includes("isConnected")) return true;
      if (fn.includes("document.title")) return `Title-${targetId}`;
      if (fn.includes("queryAll(s).slice")) return targetId === "T_SHADOW" ? [] : ["Alpha", "Beta"];
      if (fn.includes("() => document")) return { objectId: "doc-1" };
      if (fn.includes("ardiaBrowse.queryAll(s, root)")) return ["ShadowOne", "ShadowTwo"];
      if (fn.includes("WATCH_REACTION") || fn.includes("watchId") || fn.includes("mutation")) return true;
      return {};
    },
    send: async (method: string) => {
      if (method === "DOM.describeNode") return { node: { shadowRoots: [{ shadowRootType: "open", backendNodeId: 77 }], children: [] } };
      return {};
    },
  });
  const pages = new Map<string, ReturnType<typeof makeFakePage>>([
    ["T_USER", makeFakePage("T_USER", "https://user.test/")],
    ["T_USER_BG", makeFakePage("T_USER_BG", "https://user-bg.test/")],
    ["T_OWN", makeFakePage("T_OWN", "https://own.test/")],
    ["T_SHADOW", makeFakePage("T_SHADOW", "https://shadow.test/")],
  ]);
  for (const [id, page] of pages) {
    state.targetInfos.set(id, { targetId: id, type: "page", url: page.url, title: `Title-${id}` });
    state.pages.set(id, page as never);
    state.tabId(id);
  }
  state.opened.add("T_OWN");
  state.opened.add("T_SHADOW");
  state.created.add("T_OWN");
  state.attached = "T_USER";
  state.current = "T_OWN";
  state.hadTab = true;
  state.browser = {
    alive: true,
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method === "Target.createTarget") {
        const id = `T_NEW_${nextCreated++}`;
        const p = makeFakePage(id, "https://new.test/");
        pages.set(id, p);
        state.targetInfos.set(id, { targetId: id, type: "page", url: p.url, title: `Title-${id}` });
        state.pages.set(id, p as never);
        return { targetId: id };
      }
      if (method === "Target.getTargets") {
        return { targetInfos: [...state.targetInfos.values()] };
      }
      if (method === "Target.closeTarget") {
        const id = String(params?.["targetId"] ?? "");
        if (failCloseFor === id) throw new Error("close failed");
        closedTargets.push(id);
        state.targetInfos.delete(id);
        return { success: true };
      }
      return {};
    },
  } as never;
  state.connect = async () => undefined;
  state.refreshTargets = async () => [...state.targetInfos.values()];
  state.readoptOpenedTabs = async () => undefined;
  state.reattach = async (p) => p;
  state.page = async (target: string | null = null) => {
    const id = target ?? activeTarget(state);
    if (!id || !pages.has(id)) throw new BrowseError("That tab was closed", { targetId: id }, "tab_gone");
    return pages.get(id) as never;
  };
  return {
    state,
    pages,
    closedTargets,
    setFailClose: (id: string | null) => {
      failCloseFor = id;
    },
  };
}

describe("server-side target isolation, borrowed tab safety, reactions, get texts and --close", () => {
  test("withTarget isolates ref resolution, dialog lookup, and borrowed-tab protections", async () => {
    const { state, pages } = serverTestState();
    const userPage = pages.get("T_USER")!;
    const ownPage = pages.get("T_OWN")!;
    const refId = state.addRef(ownPage as never, { backendId: 5, frame: ownPage.mainFrame, objectId: "obj-5" } as never, "button", "Save");

    const [resolvedPage] = await withTarget("T_OWN", () => state.locate(`@${refId}`));
    expect(resolvedPage.targetId).toBe("T_OWN");

    await expect(withTarget("T_USER", () => state.locate(`@${refId}`))).rejects.toThrow("different tab");

    await expect(withTarget("T_USER", async () => pageForSelector(state, null)?.targetId)).resolves.toBe("T_USER");

    const ctx = new Ctx(state, {}, process.cwd(), {}, null, "open");
    await expect(withTarget("T_USER", () => cmdOpen(ctx, ["https://evil.test/"]))).rejects.toThrow("using your tab");
    expect(() => refuseOnBorrowed(ctx, userPage as never, "reload")).toThrow("using your tab");

    const bgUser = pages.get("T_USER_BG")!;
    await expect(withTarget("T_USER_BG", () => cmdOpen(ctx, ["https://evil.test/"]))).rejects.toThrow("using your tab");
    await expect(withTarget("T_USER_BG", async () => refuseOnBorrowed(ctx, bgUser as never, "reload"))).rejects.toThrow("using your tab");

    const [plainResolved] = await state.locate(`@${refId}`, userPage as never);
    expect(plainResolved.targetId).toBe("T_OWN");
  });

  test("closeTab detaches borrowed user tabs, closes owned tabs, and rejects unknown ids", async () => {
    const { state, closedTargets } = serverTestState();
    const ctx = new Ctx(state, {}, process.cwd(), {}, null, "tab");

    const detached = await closeTab(ctx, "T_USER", { detachBorrowed: true });
    expect((detached.data as Record<string, unknown>)["detached"]).toBeDefined();
    expect(closedTargets).not.toContain("T_USER");
    expect(state.attached).toBeNull();

    const closed = await closeTab(ctx, "T_OWN", { detachBorrowed: true });
    expect((closed.data as Record<string, unknown>)["closed"]).toBeDefined();
    expect(closedTargets).toContain("T_OWN");

    await expect(closeTab(ctx, "nonexistent-tab-typo", { detachBorrowed: true })).rejects.toThrow();
  });

  test("get texts reads light DOM in one call and falls back to shadow DOM pierce", async () => {
    const { state } = serverTestState();
    const ctx = new Ctx(state, {}, process.cwd(), {}, null, "get");

    const light = await withTarget("T_OWN", () => cmdGet(ctx, ["texts", "li"]));
    expect((light.data as Record<string, unknown>)["texts"]).toEqual(["Alpha", "Beta"]);

    const shadow = await withTarget("T_SHADOW", () => cmdGet(ctx, ["texts", "ytd-item"]));
    expect((shadow.data as Record<string, unknown>)["texts"]).toEqual(["ShadowOne", "ShadowTwo"]);
  });

  test("pending reactions are isolated per target", async () => {
    const { state, pages } = serverTestState();
    await watchReaction(state, pages.get("T_OWN") as never, [null, "F-T_OWN"]);
    await watchReaction(state, pages.get("T_SHADOW") as never, [null, "F-T_SHADOW"]);
    expect(hasPendingReaction(state, "T_OWN")).toBe(true);
    expect(hasPendingReaction(state, "T_SHADOW")).toBe(true);

    await settleReaction(state, "get", ["text"], "T_SHADOW");
    expect(hasPendingReaction(state, "T_SHADOW")).toBe(false);
    expect(hasPendingReaction(state, "T_OWN")).toBe(true);
  });

  test("--close tracks tabs opened via openTab/tab new and preserves ownership if close fails", async () => {
    const { state, closedTargets, setFailClose } = serverTestState();
    try {
      const ctx = new Ctx(state, {}, process.cwd(), {}, "const p = await openTab(); return p.targetId;", "script");
      const res = await cmdScript(ctx, ["--repl", "--close"]);
      const createdId = (res.data as { value: string }).value;
      expect(closedTargets).toContain(createdId);
      expect(state.targetInfos.has(createdId)).toBe(false);

      const failId = "T_NEW_11";
      setFailClose(failId);
      const ctx2 = new Ctx(state, {}, process.cwd(), {}, "const p = await openTab(); return p.targetId;", "script");
      const res2 = await cmdScript(ctx2, ["--repl", "--close"]);
      expect((res2.data as { value: string }).value).toBe(failId);
      expect(state.mustClose.has(failId)).toBe(true);
      expect(state.targetInfos.has(failId)).toBe(true);
    } finally {
      state.mustCloseTask?.stop.abort();
      dropRepl(state);
    }
  });

  test("withTab keeps original state.current, failed openTab closes leaked tab without --close, RunSemaphore caps concurrency, and telemetry metrics pass both allowlists", async () => {
    const { state, closedTargets } = serverTestState();
    state.labels.set("taken", "T_OWN");
    try {
      const ctx = new Ctx(
        state,
        {},
        process.cwd(),
        {},
        `
          const inner = await withTab(undefined, async (t) => await t.title());
          const after = await page.title();
          let failedMsg = null;
          try {
            await openTab(undefined, { label: "taken" });
          } catch (e) {
            failedMsg = e.message;
          }
          return { inner, after, failedMsg };
        `,
        "script",
      );
      const res = await cmdScript(ctx, ["--repl"]);
      const out = (res.data as { value: Record<string, unknown> }).value;
      expect(out["inner"]).toBe("Title-T_NEW_10");
      expect(out["after"]).toBe("Title-T_OWN");
      expect(state.current).toBe("T_OWN");
      expect(String(out["failedMsg"])).toContain("taken");
      expect(closedTargets).toContain("T_NEW_10");
      expect(closedTargets).toContain("T_NEW_11");
      expect(state.targetInfos.has("T_NEW_11")).toBe(false);
    } finally {
      dropRepl(state);
    }

    const sem = new RunSemaphore(3);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 24 }, (_, idx) =>
        sem.run(async () => {
          active += 1;
          if (active > peak) peak = active;
          await new Promise((r) => setTimeout(r, idx % 3 === 0 ? 4 : 1));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(active).toBe(0);

    for (const flagName of ["script_repl_autoclose", "script_tab_detached"]) {
      expect(DAEMON_FLAGS.has(flagName)).toBe(true);
      expect(isMetricFlag(flagName)).toBe(true);
    }
    expect(DAEMON_COUNTS.has("script_repl_autoclosed")).toBe(true);
    expect(isMetricCount("script_repl_autoclosed")).toBe(true);
  });
});
