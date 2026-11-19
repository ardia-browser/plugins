import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { Cancelled, withSignal } from "../../src/browse/cdp/cancel.ts";
import { BrowseError, Gated, OutcomeUnknown, Usage } from "../../src/browse/daemon-errors.ts";
import { Result } from "../../src/browse/daemon/render.ts";
import { Ctx } from "../../src/browse/commands/ctx.ts";
import { dispatch, hooks, OWNERS, register, served } from "../../src/browse/commands/all.ts";
import { Element, Page, WORLD_NAME } from "../../src/browse/state/page.ts";
import { parseRef, PROBE_FANOUT } from "../../src/browse/state/state.ts";
import { cdpError, FakeBrowser, frameTree, LOADER, MAIN, stateWith, timeout } from "./core-helpers.ts";

const NEVER_ON_PAGES = ["Runtime.enable", "Debugger.enable", "Console.enable"];

function pageSessionEnables(browser: FakeBrowser): string[] {
  return browser.sent.filter((entry) => entry.session !== null && NEVER_ON_PAGES.includes(entry.method)).map((entry) => entry.method);
}

describe("attach (row 8)", () => {
  test("attaching enables Page and lifecycle, reads frames and never enables Runtime or Debugger", async () => {
    const browser = new FakeBrowser();
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    expect(page.sessionId).toBe("SESSION-1");
    expect(browser.methods("SESSION-1")).toEqual(["Inspector.enable", "Page.enable", "Page.setLifecycleEventsEnabled", "Target.setAutoAttach", "Page.getFrameTree", "Page.getLayoutMetrics"]);
    expect(page.mainFrame).toBe(MAIN);
    expect(page.needsEnable).toBe(false);
    expect(pageSessionEnables(browser)).toEqual([]);
  });

  test("the session is published only after Page.enable and the frame refresh", async () => {
    let seenDuringTree: string | null | undefined;
    let page: Page | null = null;
    const browser = new FakeBrowser((method) => {
      if (method === "Page.getFrameTree") {
        seenDuringTree = page?.sessionId;
        return frameTree();
      }
      return undefined;
    });
    const state = stateWith(browser);
    page = new Page(state, "TARGET");
    state.pages.set("TARGET", page);
    await page.attach(browser as never);
    expect(seenDuringTree).toBeNull();
    expect(page.sessionId).toBe("SESSION-1");
  });

  test("a failed attach detaches its session and publishes nothing", async () => {
    const browser = new FakeBrowser((method) => (method === "Page.getFrameTree" ? cdpError(method, "boom") : undefined));
    const state = stateWith(browser);
    const failure = await state.page("TARGET").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BrowseError);
    const page = state.pages.get("TARGET") as Page;
    expect(page.sessionId).toBeNull();
    expect(state.sessions.size).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(browser.sent.some((entry) => entry.method === "Target.detachFromTarget" && entry.params["sessionId"] === "SESSION-1")).toBe(true);
  });

  test("a crashed tab stays attached with Page not enabled until it is revived", async () => {
    const browser = new FakeBrowser((method) => (method === "Inspector.enable" ? new Gated(method) : undefined));
    const state = stateWith(browser);
    const page = new Page(state, "TARGET");
    page.crashed = true;
    state.pages.set("TARGET", page);
    await page.attach(browser as never);
    expect(page.sessionId).toBe("SESSION-1");
    expect(page.needsEnable).toBe(true);
    expect(browser.methods("SESSION-1")).toEqual(["Inspector.enable"]);
    const refused = await page.send("Page.getFrameTree").catch((error: unknown) => error);
    expect((refused as BrowseError).code).toBe("tab_crashed");
  });

  test("a policy refusal on attach says where Ardia has the tab only when it has a reason", async () => {
    const browser = new FakeBrowser((method) => (method === "Target.attachToTarget" ? new Gated(method) : undefined));
    const state = stateWith(browser);
    const failure = (await state.page("TARGET").catch((error: unknown) => error)) as Gated;
    expect(failure).toBeInstanceOf(Gated);
    expect(failure.code).toBe("policy_refused");
  });
});

describe("busy probe (row 8)", () => {
  test("after a call goes unanswered, the next call probes in the isolated world, never the main world", async () => {
    let busy = true;
    const browser = new FakeBrowser((method) => {
      if (method === "Runtime.callFunctionOn" && busy) {
        busy = false;
        return timeout(method);
      }
      return undefined;
    });
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    const first = await page.call("() => document.title", [], { read: true }).catch((error: unknown) => error);
    expect((first as BrowseError).code).toBe("page_busy");
    expect(page.unansweredAt).toBeGreaterThan(0);
    await page.call("() => document.title", [], { read: true });
    const probes = browser.sent.filter((entry) => entry.method === "Runtime.evaluate" && entry.params["expression"] === "1");
    expect(probes).toHaveLength(1);
    expect(probes[0]?.params["contextId"]).toBe(7);
    expect(page.unansweredAt).toBe(0);
    expect(pageSessionEnables(browser)).toEqual([]);
  });

  test("the probe creates the isolated world when the current document has none, and a silent page fails fast", async () => {
    const browser = new FakeBrowser((method) => (method === "Page.createIsolatedWorld" && browser.sent.filter((e) => e.method === method).length > 0 ? timeout(method, 3) : undefined));
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    page.unansweredAt = performance.now() / 1000;
    const failure = (await page.send("DOM.getDocument").catch((error: unknown) => error)) as BrowseError;
    expect(failure.code).toBe("page_busy");
    expect(failure.text).toContain("DOM.getDocument got no answer in 3s");
    const created = browser.sent.filter((entry) => entry.method === "Page.createIsolatedWorld");
    expect(created.at(-1)?.params).toEqual({ frameId: MAIN, worldName: WORLD_NAME });
    expect(browser.sent.some((entry) => entry.method === "Runtime.evaluate" && entry.params["contextId"] === undefined)).toBe(false);
  });
});

describe("calls and worlds", () => {
  test("a world is made once per document and the library goes in before the first call", async () => {
    const browser = new FakeBrowser();
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    await page.call("() => 1", [], { read: true });
    await page.call("() => 2", [], { read: true });
    expect(browser.methods("SESSION-1").filter((method) => method === "Page.createIsolatedWorld")).toHaveLength(1);
    const library = browser.sent.find((entry) => entry.method === "Runtime.evaluate");
    expect(library?.params["contextId"]).toBe(7);
    page.onEvent("Page.frameNavigated", { frame: { id: MAIN, loaderId: "LOADER-2", url: "http://127.0.0.1/next.html" } });
    expect(page.navigations).toBe(1);
    await page.call("() => 3", [], { read: true });
    expect(browser.methods("SESSION-1").filter((method) => method === "Page.createIsolatedWorld")).toHaveLength(2);
  });

  test("a read retries once on a stale context; a write on a destroyed one is an unknown outcome", async () => {
    let failures = 1;
    const browser = new FakeBrowser((method) => {
      if (method === "Runtime.callFunctionOn" && failures > 0) {
        failures -= 1;
        return cdpError(method, "Execution context was destroyed.");
      }
      return undefined;
    });
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    expect(await page.call("() => 1", [], { read: true })).toBe("ok");
    failures = 1;
    const write = await page.call("() => 1").catch((error: unknown) => error);
    expect(write).toBeInstanceOf(OutcomeUnknown);
  });

  test("an element from another world is re-homed by its backend id", async () => {
    let first = true;
    const browser = new FakeBrowser((method) => {
      if (method === "Runtime.callFunctionOn" && first) {
        first = false;
        return cdpError(method, "Argument should belong to the same JavaScript world as target object");
      }
      if (method === "DOM.resolveNode") return { object: { objectId: "REHOMED" } };
      return undefined;
    });
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    const element = new Element(MAIN, "OLD", 42, "@e1");
    expect(await page.call("(el) => el.isConnected", [element])).toBe("ok");
    expect(element.objectId).toBe("REHOMED");
    const call = browser.sent.filter((entry) => entry.method === "Runtime.callFunctionOn").at(-1);
    expect(call?.params["arguments"]).toEqual([{ objectId: "REHOMED" }]);
  });

  test("a page exception is a page_script_error with the stack cut", async () => {
    const browser = new FakeBrowser((method) =>
      method === "Runtime.callFunctionOn" ? { exceptionDetails: { exception: { description: "TypeError: x is null\n    at foo" } } } : undefined,
    );
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    const failure = (await page.call("() => x.y", [], { read: true }).catch((error: unknown) => error)) as BrowseError;
    expect(failure.code).toBe("page_script_error");
    expect(failure.text).toBe("TypeError: x is null");
  });

  test("a frame chosen with `frame` that went away refuses rather than falling back", async () => {
    const browser = new FakeBrowser();
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    state.frames.set("TARGET", "GONE");
    const failure = (await page.call("() => 1", [], { read: true }).catch((error: unknown) => error)) as BrowseError;
    expect(failure.code).toBe("frame_gone");
  });
});

describe("crash and detach", () => {
  test("a crash drops calls in flight: reads say the tab crashed, writes say the outcome is unknown", async () => {
    const held: ((value: Record<string, unknown>) => void)[] = [];
    const browser = new FakeBrowser((method) =>
      method === "Runtime.callFunctionOn" || method === "Input.dispatchKeyEvent" ? () => new Promise((resolve) => held.push(resolve)) : undefined,
    );
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    await page.world(null);
    const read = page.call("() => 1", [], { read: true }).catch((error: unknown) => error);
    const write = page.send("Input.dispatchKeyEvent", { type: "keyDown" }).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 5));
    state.onEvent("Inspector.targetCrashed", {}, "SESSION-1");
    expect(((await read) as BrowseError).code).toBe("tab_crashed");
    expect(await write).toBeInstanceOf(OutcomeUnknown);
    for (const release of held) release({});
    state.onEvent("Inspector.targetReloadedAfterCrash", {}, "SESSION-1");
    expect(page.crashed).toBe(false);
  });

  test("a detach drops the session; the next page() attaches again and restores the setup", async () => {
    const browser = new FakeBrowser();
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    page.initScripts.set("SCRIPT-1", "tagged");
    page.scriptSources.set("SCRIPT-1", "window.x = 1");
    page.overrides.set("Emulation.setEmulatedMedia", { media: "print" });
    state.onEvent("Target.detachedFromTarget", { sessionId: "SESSION-1" }, null);
    expect(page.sessionId).toBeNull();
    const failure = (await page.send("Page.getFrameTree").catch((error: unknown) => error)) as BrowseError;
    expect(failure.code).toBe("tab_detached");
    const again = await state.page("TARGET");
    expect(again).toBe(page);
    expect(page.sessionId).toBe("SESSION-2");
    expect(browser.methods("SESSION-2")).toContain("Page.addScriptToEvaluateOnNewDocument");
    expect(browser.methods("SESSION-2")).toContain("Emulation.setEmulatedMedia");
    expect(pageSessionEnables(browser)).toEqual([]);
  });

  test("setup that can't be put back after a reattach is reported as setup_lost and dropped", async () => {
    const browser = new FakeBrowser((method, _params, session) =>
      method === "Emulation.setEmulatedMedia" && session === "SESSION-2" ? cdpError(method, "nope") : undefined,
    );
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    page.overrides.set("Emulation.setEmulatedMedia", { media: "print" });
    state.claims.add("TARGET", "route");
    page.detach();
    const failure = (await state.reattach(page).catch((error: unknown) => error)) as BrowseError;
    expect(failure.code).toBe("setup_lost");
    expect(failure.data).toEqual({ lost: ["the emulated media"] });
    expect(page.overrides.size).toBe(0);
    expect(page.sessionId).toBe("SESSION-2");
    expect(browser.methods("SESSION-2")).toContain("Fetch.enable");
  });

  test("a closed target is forgotten and its lost tab is remembered for the next command", async () => {
    const browser = new FakeBrowser();
    const state = stateWith(browser);
    state.current = "TARGET";
    state.opened.add("TARGET");
    await state.page();
    state.onEvent("Target.targetDestroyed", { targetId: "TARGET" }, null);
    expect(state.current).toBeNull();
    expect(state.lostTab?.opened).toBe(true);
    const failure = (await state.page().catch((error: unknown) => error)) as BrowseError;
    expect(failure.code).toBe("tab_gone");
  });

  test("cancellation during attach leaves no half-published session", async () => {
    const stop = new AbortController();
    const browser = new FakeBrowser((method) => {
      if (method === "Page.enable") stop.abort();
      return method === "Page.getFrameTree" ? new Cancelled() : undefined;
    });
    const state = stateWith(browser);
    const failure = await withSignal(stop.signal, () => state.page("TARGET")).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Cancelled);
    expect(state.pages.get("TARGET")?.sessionId).toBeNull();
    expect(state.sessions.size).toBe(0);
  });
});

describe("the active tab (plugins#11's probe rules)", () => {
  function many(count: number): string[] {
    return Array.from({ length: count }, (_, index) => `T${index}`);
  }

  test("probes run at most 8 at a time and the focused visible tab wins", async () => {
    const targets = many(20);
    const browser = new FakeBrowser((method, params, session) => {
      if (method === "Target.getTargets") return { targetInfos: targets.map((targetId) => ({ targetId, type: "page", url: `http://x/${targetId}` })) };
      if (method === "Target.attachToTarget") return { sessionId: `S-${String(params["targetId"])}` };
      if (method === "Runtime.evaluate") return { result: { value: [session === "S-T13", session === "S-T13"] } };
      return undefined;
    });
    const state = stateWith(browser, targets);
    expect(await state.shownTarget()).toBe("T13");
    const attaches = browser.sent.filter((entry) => entry.method === "Target.attachToTarget");
    expect(attaches).toHaveLength(20);
    expect(browser.peak).toBeLessThanOrEqual(PROBE_FANOUT * 2);
    expect(browser.methods().filter((method) => method === "Target.detachFromTarget")).toHaveLength(20);
  });

  test("a probe refused at the attach cap is retried, not read as inactive", async () => {
    const refused = new Set(["T1", "T2"]);
    const browser = new FakeBrowser((method, params, session) => {
      if (method === "Target.getTargets") return { targetInfos: many(3).map((targetId) => ({ targetId, type: "page", url: `http://x/${targetId}` })) };
      if (method === "Target.attachToTarget") {
        const target = String(params["targetId"]);
        if (refused.delete(target)) return new BrowseError("cap", null, "attaches_unanswered");
        return { sessionId: `S-${target}` };
      }
      if (method === "Runtime.evaluate") return { result: { value: [session === "S-T2", false] } };
      return undefined;
    });
    const state = stateWith(browser, many(3));
    expect(await state.shownTarget()).toBe("T2");
    expect(browser.sent.filter((entry) => entry.method === "Target.attachToTarget" && entry.params["targetId"] === "T2")).toHaveLength(2);
  });

  test("tabs still unprobed after three passes give attaches_unanswered, not no_tab", async () => {
    const browser = new FakeBrowser((method) => {
      if (method === "Target.getTargets") return { targetInfos: many(2).map((targetId) => ({ targetId, type: "page", url: `http://x/${targetId}` })) };
      if (method === "Target.attachToTarget") return new BrowseError("cap", null, "attaches_unanswered");
      return undefined;
    });
    const state = stateWith(browser, many(2));
    const started = performance.now();
    const failure = (await state.shownTarget().catch((error: unknown) => error)) as BrowseError;
    expect(failure.code).toBe("attaches_unanswered");
    expect(failure.text).toContain("2 tabs weren't probed");
    expect(browser.sent.filter((entry) => entry.method === "Target.attachToTarget")).toHaveLength(6);
    expect(performance.now() - started).toBeGreaterThanOrEqual(700);
  });

  test("an attach that fails for another reason counts as an inactive tab", async () => {
    const browser = new FakeBrowser((method) => {
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "T0", type: "page", url: "http://x/" }] };
      if (method === "Target.attachToTarget") return cdpError(method, "No target with given id");
      return undefined;
    });
    const state = stateWith(browser, ["T0"]);
    expect(await state.shownTarget()).toBeNull();
    expect(browser.sent.filter((entry) => entry.method === "Target.attachToTarget")).toHaveLength(1);
  });
});

describe("refs", () => {
  test("parseRef takes @eN, ref=eN and [ref=eN] only", () => {
    expect(parseRef("@e12")).toBe("e12");
    expect(parseRef("ref=e3")).toBe("e3");
    expect(parseRef("[ref=e7]")).toBe("e7");
    for (const text of ["@e", "e1", "@x1", "@e1a", "[ref=e1", "ref=e", "@e١"]) expect(parseRef(text)).toBeNull();
  });

  test("refs are never reused, and a navigation turns them stale", async () => {
    const browser = new FakeBrowser();
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    const element = new Element(MAIN, "OBJ", 5, "x");
    const id = state.addRef(page, element, "button", "Go");
    expect(id).toBe("e1");
    expect(state.addRef(page, element)).toBe("e1");
    state.setRefs([state.refs.get(id) as never], "snap", page);
    (page.frames.get(MAIN) as { loader: string | null }).loader = "LOADER-2";
    state.setRefs([], null, page);
    expect(state.refs.has(id)).toBe(false);
    expect(state.navigatedRefs.has(id)).toBe(true);
    const stale = (await state.resolveRef(id).catch((error: unknown) => error)) as BrowseError;
    expect(stale.code).toBe("stale_ref");
    expect(stale.text).toContain("the page navigated since that snapshot");
    const unknown = (await state.resolveRef("e99").catch((error: unknown) => error)) as BrowseError;
    expect(unknown.code).toBe("unknown_ref");
    expect(LOADER).toBe("LOADER-1");
  });
});

describe("the command table", () => {
  const ctx = () => new Ctx(stateWith(new FakeBrowser()), {}, "/", {}, null);

  test("every Python command is in the table; served ones run, the rest answer unsupported", async () => {
    const python = process.env["ARDIA_TEST_PYTHON"] ?? "python3";
    const listed = spawnSync(python, ["-c", "from ardia_cli.browse import commands, capture, audit, flows, react, media; print('\\n'.join(sorted(commands.COMMANDS)))"], {
      cwd: new URL("../../..", import.meta.url).pathname,
      encoding: "utf8",
    });
    expect(listed.status).toBe(0);
    expect(Object.keys(OWNERS).sort()).toEqual([...listed.stdout.trim().split("\n"), "auth"].sort());
    for (const name of ["open", "get", "wait", "session"]) expect(served(name)).toBe(true);
    const failure = (await dispatch(ctx(), "click", ["@e1"]).catch((error: unknown) => error)) as BrowseError;
    expect(failure.code).toBe("unsupported");
    expect(failure.text).toContain("isn't served by the TypeScript daemon yet");
  });

  test("unknown and skipped commands answer like Python", async () => {
    const unknown = await dispatch(ctx(), "frobnicate", []).catch((error: unknown) => error);
    expect(unknown).toBeInstanceOf(Usage);
    expect((unknown as Usage).text).toBe("Unknown command: frobnicate. Run `ardia browse --help`");
    const skipped = (await dispatch(ctx(), "chat", []).catch((error: unknown) => error)) as BrowseError;
    expect(skipped.text).toBe("`chat` isn't part of ardia browse: Ardia has no AI features, by the owner's decision");
    const auth = await dispatch(ctx(), "auth", ["save"]).catch((error: unknown) => error);
    expect((auth as Usage).text).toBe("auth save|list|show|delete run without the daemon");
  });

  test("register refuses a name outside the table and a second registration", () => {
    expect(() => register("frobnicate", async () => new Result())).toThrow("isn't a command");
    expect(() => register("open", async () => new Result())).toThrow("registered twice");
  });

  test("dispatch runs the hooks around a command, and skips the reaction hook for batch", async () => {
    const seen: string[] = [];
    hooks.before = async (_ctx, name) => void seen.push(`before ${name}`);
    hooks.begin = async (_ctx, name) => {
      seen.push(`begin ${name}`);
      return name;
    };
    hooks.end = async (_ctx, step, error) => void seen.push(`end ${String(step)} ${error ? error.code : "ok"}`);
    try {
      await dispatch(ctx(), "session", []);
      await dispatch(ctx(), "batch", []).catch(() => {});
    } finally {
      delete hooks.before;
      delete hooks.begin;
      delete hooks.end;
    }
    expect(seen).toEqual(["before session", "begin session", "end session ok"]);
  });
});
