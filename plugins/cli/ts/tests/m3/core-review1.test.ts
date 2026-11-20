import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Cancelled, withSignal } from "../../src/browse/cdp/cancel.ts";
import { dispatch } from "../../src/browse/commands/all.ts";
import { leaveOffscreen } from "../../src/browse/commands/core.ts";
import { Ctx } from "../../src/browse/commands/ctx.ts";
import { parse } from "../../src/browse/commands/parse.ts";
import { announce } from "../../src/browse/daemon/announce.ts";
import { BrowseError, ConnectionLost, OutcomeUnknown } from "../../src/browse/daemon-errors.ts";
import { controlCall } from "../../src/browse/state/apptabs.ts";
import { Element, Page } from "../../src/browse/state/page.ts";
import { Refs } from "../../src/browse/state/refs.ts";
import { State } from "../../src/browse/state/state.ts";
import "../libc-loaded.ts";
import { cdpError, FakeBrowser, frameTree, LOADER, MAIN, stateWith } from "./core-helpers.ts";

const PYTHON = process.env["ARDIA_TEST_PYTHON"] ?? "python3";
const CLI = new URL("../../..", import.meta.url).pathname;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  Refs.snapshots = null;
});

function navigateTo(state: State, session: string | null, loader: string): void {
  state.onEvent("Page.frameNavigated", { frame: { id: MAIN, loaderId: loader, url: `http://127.0.0.1/${loader}.html` } }, session);
}

function calls(browser: FakeBrowser, method: string): number {
  return browser.sent.filter((entry) => entry.method === method).length;
}

function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe("1: worlds stay with their document and frame", () => {
  test("a navigation while the world is created stops the call before it runs", async () => {
    let state: State | null = null;
    const browser = new FakeBrowser((method, _params, session) => {
      if (method === "Page.createIsolatedWorld") navigateTo(state as State, session, "LOADER-2");
      return undefined;
    });
    state = stateWith(browser);
    const page = await state.page("TARGET");
    const error = (await failure(page.call("() => document.body.remove()"))) as BrowseError;
    expect(error.code).toBe("document_changed");
    expect(calls(browser, "Runtime.callFunctionOn")).toBe(0);
  });

  test("a navigation while the library goes in stops the call before it runs", async () => {
    let state: State | null = null;
    const browser = new FakeBrowser((method, params, session) => {
      if (method === "Runtime.evaluate" && params["expression"] !== "1") navigateTo(state as State, session, "LOADER-2");
      return undefined;
    });
    state = stateWith(browser);
    const page = await state.page("TARGET");
    const error = (await failure(page.call("() => document.body.remove()"))) as BrowseError;
    expect(error.code).toBe("document_changed");
    expect(calls(browser, "Runtime.callFunctionOn")).toBe(0);
  });

  test("a navigation while the busy probe runs stops a call whose world was already known", async () => {
    let state: State | null = null;
    let navigate = false;
    const browser = new FakeBrowser((method, params, session) => {
      if (navigate && method === "Runtime.evaluate" && params["expression"] === "1") {
        navigate = false;
        navigateTo(state as State, session, "LOADER-2");
      }
      return undefined;
    });
    state = stateWith(browser);
    const page = await state.page("TARGET");
    await page.world(null);
    navigate = true;
    page.unansweredAt = performance.now() / 1000;
    const error = (await failure(page.call("() => document.body.remove()"))) as BrowseError;
    expect(error.code).toBe("document_changed");
    expect(calls(browser, "Runtime.callFunctionOn")).toBe(0);
  });

  test("an element from another frame is never re-homed into this frame's world", async () => {
    const browser = new FakeBrowser((method) =>
      method === "Runtime.callFunctionOn" ? cdpError(method, "Argument should belong to the same JavaScript world as target object") : undefined,
    );
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    const element = new Element("CHILD-FRAME", "OBJ", 9, "@e1");
    const error = (await failure(page.call("(el) => el.click()", [element], { frame: MAIN }))) as BrowseError;
    expect(error).toBeInstanceOf(BrowseError);
    expect(calls(browser, "DOM.resolveNode")).toBe(0);
    expect(calls(browser, "Runtime.callFunctionOn")).toBe(1);
  });
});

describe("2: a ref resolves only to its own backend node", () => {
  function snapshotsGiving(backend: number) {
    Refs.snapshots = {
      async collect() {
        return [{ ref: null, role: "button", name: "Go" }];
      },
      refsOf(state, page, nodes) {
        const id = state.refForNode(page, MAIN, backend);
        (nodes as { ref: string | null }[])[0]!.ref = id;
        return [{ id, instance: state.instance, target: page.targetId, frame: MAIN, loader: page.loader(MAIN) || "", generation: 0, backend, role: "button", name: "Go", unique: true, context: [] }];
      },
      walk(nodes) {
        return (nodes as { ref: string; role: string; name: string }[]).map((node) => node);
      },
    };
  }

  test("a ref from before a reload of the same address is stale, not followed to the new node", async () => {
    let loader = LOADER;
    const browser = new FakeBrowser((method, params) => {
      if (method === "Page.getFrameTree") return frameTree(MAIN, loader);
      if (method === "DOM.resolveNode") return { object: { objectId: `OBJ${String(params["backendNodeId"])}` } };
      if (method === "Runtime.callFunctionOn") return { result: { value: true } };
      return undefined;
    });
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    const id = state.addRef(page, new Element(MAIN, "OBJ", 5, "x"), "button", "Go");
    const ref = state.refs.get(id);
    if (ref) ref.unique = true;
    state.setRefs([ref as never], "snap", page);
    loader = "LOADER-2";
    state.onEvent("Page.frameNavigated", { frame: { id: MAIN, loaderId: loader, url: page.url } }, page.sessionId);
    state.setRefs([], null, page);
    snapshotsGiving(77);
    const error = (await failure(state.resolveRef(id))) as BrowseError;
    expect(error.code).toBe("stale_ref");
  });

  test("a redrawn element is stale even when its successor is unique", async () => {
    const browser = new FakeBrowser((method, params) => {
      if (method === "DOM.resolveNode" && params["backendNodeId"] === 5) return { object: { objectId: "OBJ5" } };
      if (method === "Runtime.callFunctionOn" && String(params["functionDeclaration"]).includes("isConnected")) return { result: { value: false } };
      return undefined;
    });
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    const id = state.addRef(page, new Element(MAIN, "OBJ", 5, "x"), "button", "Go");
    const ref = state.refs.get(id);
    if (ref) ref.unique = true;
    state.setRefs([ref as never], "snap", page);
    snapshotsGiving(77);
    const error = (await failure(state.resolveRef(id))) as BrowseError;
    expect(error.code).toBe("stale_ref");
    expect(error.text).toContain("is now @");
  });
});

describe("3: setup is restored all or nothing", () => {
  test("a cancel during the replay leaves it to be replayed from the start", async () => {
    const stop = new AbortController();
    const browser = new FakeBrowser((method, _params, session) => {
      if (method === "Emulation.setEmulatedMedia" && session === "SESSION-2" && !stop.signal.aborted) {
        stop.abort();
        return new Cancelled();
      }
      return undefined;
    });
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    page.overrides.set("Emulation.setEmulatedMedia", { media: "print" });
    page.overrides.set("Emulation.setTouchEmulationEnabled", { enabled: true });
    page.detach();
    expect(await failure(withSignal(stop.signal, () => state.page("TARGET")))).toBeInstanceOf(Cancelled);
    await state.page("TARGET");
    const replayed = browser.sent.filter((entry) => entry.method.startsWith("Emulation.set") && entry.method !== "Emulation.setFocusEmulationEnabled" && entry.session !== "SESSION-1");
    expect(replayed.map((entry) => entry.method)).toContain("Emulation.setTouchEmulationEnabled");
    expect(page.needsRestore).toBe(false);
    expect(page.overrides.size).toBe(2);
  });

  test("a lost connection at Fetch.enable is a lost connection, and the route claim is kept", async () => {
    const browser = new FakeBrowser((method, _params, session) => (method === "Fetch.enable" && session === "SESSION-2" ? new ConnectionLost() : undefined));
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    state.claims.add("TARGET", "route");
    page.detach();
    expect(await failure(state.page("TARGET"))).toBeInstanceOf(ConnectionLost);
    expect(state.claims.has("TARGET", "route")).toBe(true);
    expect(page.needsRestore).toBe(true);
  });
});

describe("4: open never navigates a borrowed tab", () => {
  test("a session using the user's tab opens its own", async () => {
    const browser = new FakeBrowser((method, params) => {
      if (method === "Target.createTarget") return { targetId: "OWN" };
      if (method === "Page.navigate") return { frameId: MAIN, loaderId: LOADER };
      if (method === "Runtime.callFunctionOn") {
        const source = String(params["functionDeclaration"]);
        return { result: { value: source.includes("readyState") ? "complete" : source.includes("visibilityState") ? false : "Own" } };
      }
      return undefined;
    });
    const state = stateWith(browser, ["TARGET", "OWN"]);
    state.current = "TARGET";
    state.attached = "TARGET";
    await state.page("TARGET");
    const navigateBefore = calls(browser, "Page.navigate");
    const result = await dispatch(new Ctx(state, {}, "/", {}, null, "open"), "open", ["http://127.0.0.1/x.html"]);
    expect(calls(browser, "Target.createTarget")).toBe(1);
    expect(state.current).toBe("OWN");
    expect((result.data as Record<string, unknown>)["left"]).toBe(state.tabId("TARGET"));
    expect(result.text).toContain("since this session uses your tab");
    expect(browser.sent.filter((entry) => entry.method === "Page.navigate" && entry.session === "SESSION-1")).toHaveLength(navigateBefore);
  });
});

describe("5: a lost connection is never read as an answer", () => {
  test("get title fails as connection_lost", async () => {
    let lose = false;
    const browser = new FakeBrowser((method) => (lose && method === "Runtime.callFunctionOn" ? new ConnectionLost() : undefined));
    const state = stateWith(browser);
    state.current = "TARGET";
    await state.page("TARGET");
    lose = true;
    expect(await failure(dispatch(new Ctx(state, {}, "/", {}, null, "get"), "get", ["title"]))).toBeInstanceOf(ConnectionLost);
  });

  test("hidden() and the busy probe pass a lost connection on", async () => {
    let lose = false;
    const browser = new FakeBrowser((method) => (lose && (method === "Runtime.callFunctionOn" || method === "Runtime.evaluate") ? new ConnectionLost() : undefined));
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    await page.world(null);
    lose = true;
    expect(await failure(page.hidden())).toBeInstanceOf(ConnectionLost);
    page.unansweredAt = performance.now() / 1000;
    expect(await failure(page.send("DOM.getDocument"))).toBeInstanceOf(ConnectionLost);
  });

  test("the active-tab probe passes a lost connection on", async () => {
    const browser = new FakeBrowser((method) => {
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "T0", type: "page", url: "http://x/" }] };
      if (method === "Page.getFrameTree") return new ConnectionLost();
      return undefined;
    });
    const state = stateWith(browser, ["T0"]);
    expect(await failure(state.shownTarget())).toBeInstanceOf(ConnectionLost);
  });
});

describe("6: nothing is marked ready early", () => {
  test("a tab that crashed before the attach keeps its session apart from a ready one", async () => {
    let state: State | null = null;
    const browser = new FakeBrowser((method, _params, session) => {
      if (method === "Inspector.enable") (state as State).onEvent("Inspector.targetCrashed", {}, session);
      return undefined;
    });
    state = stateWith(browser);
    const page = await state.page("TARGET");
    expect(page.crashed).toBe(true);
    expect(page.sessionId).toBeNull();
    expect(page.session).toBe("SESSION-1");
  });

  test("a connect cancelled during discovery isn't connected, and the next one discovers again", async () => {
    const stop = new AbortController();
    const made: FakeBrowser[] = [];
    class Opening extends FakeBrowser {
      async open(): Promise<void> {}
    }
    const state = new State({ session: "s", key: "", browseFd: null, noAutoDialog: false, pinTab: false }, async () => ({
      ws: "ws://127.0.0.1:1/devtools/browser/x",
      source: "--port 1",
      explicit: true,
      active: null,
      instance: "instance",
    }));
    state.makeBrowser = () => {
      const browser = new Opening((method) => {
        if (method === "Target.getTargets" && made.length === 1) {
          stop.abort();
          return new Cancelled();
        }
        return undefined;
      });
      made.push(browser);
      return browser as never;
    };
    expect(await failure(withSignal(stop.signal, () => state.connect()))).toBeInstanceOf(Cancelled);
    expect(state.connected).toBe(false);
    await state.connect();
    expect(state.connected).toBe(true);
    expect(made).toHaveLength(2);
    expect(made[1]?.methods()).toContain("Target.getTargets");
  });
});

function socketServer(onConnection: (socket: net.Socket) => void): Promise<{ file: string; closed: Promise<void> }> {
  const file = path.join("/tmp", `d3r-${process.pid}-${Math.random().toString(16).slice(2, 8)}.sock`);
  let markClosed = () => {};
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  const server = net.createServer((socket) => {
    socket.on("close", () => markClosed());
    onConnection(socket);
  });
  cleanups.push(() => {
    server.close();
    fs.rmSync(file, { force: true });
  });
  return new Promise((resolve) => server.listen(file, () => resolve({ file, closed })));
}

describe("7: cancellation reaches every wait", () => {
  test("a cancelled announce closes its socket at once", async () => {
    const { file, closed } = await socketServer(() => {});
    const stop = new AbortController();
    const started = performance.now();
    const done = announce(file, { name: "tester", app: null }, 5, stop.signal);
    setTimeout(() => stop.abort(), 30);
    await done;
    await closed;
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a detach cancels the CDP wait under a page call", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const browser = new FakeBrowser();
    const send = browser.send.bind(browser);
    browser.send = async (method, params, options = {}) => {
      if (method === "DOM.getDocument") {
        seen.push((options as { signal?: AbortSignal | null }).signal);
        return new Promise(() => {});
      }
      return send(method, params, options);
    };
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    const pending = failure(page.send("DOM.getDocument"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    page.detach();
    expect(((await pending) as BrowseError).code).toBe("tab_detached");
    expect(seen[0]?.aborted).toBe(true);
  });

  test("a cancelled control-socket call closes its socket", async () => {
    const { file, closed } = await socketServer((socket) => {
      socket.once("data", () => socket.write(`${JSON.stringify({ id: 1, result: { app: "Ardia" } })}\n`));
    });
    const stop = new AbortController();
    const pending = failure(withSignal(stop.signal, () => controlCall(file, null, "windows", null, 5)));
    setTimeout(() => stop.abort(), 50);
    expect(await pending).toBeInstanceOf(Cancelled);
    await closed;
  });
});

describe("8: a failed offscreen handoff puts the session back", () => {
  test("the replacement is closed and the old tab and its label are current again", async () => {
    const browser = new FakeBrowser((method) => {
      if (method === "Target.createTarget") return { targetId: "FRESH" };
      if (method === "Page.navigate") return { errorText: "net::ERR_NAME_NOT_RESOLVED" };
      return undefined;
    });
    const state = stateWith(browser, ["OLD", "FRESH"]);
    state.current = "OLD";
    state.labels.set("work", "OLD");
    const page = await state.page("OLD");
    page.url = "https://gone.example/";
    const error = (await failure(leaveOffscreen(new Ctx(state, {}, "/", {}, null, "open"), page))) as BrowseError;
    expect(error.code).toBe("navigation_failed");
    expect(state.current).toBe("OLD");
    expect(state.labels.get("work")).toBe("OLD");
    expect(browser.sent.some((entry) => entry.method === "Target.closeTarget" && entry.params["targetId"] === "FRESH")).toBe(true);
    expect(browser.sent.some((entry) => entry.method === "Target.closeTarget" && entry.params["targetId"] === "OLD")).toBe(false);
  });
});

describe("9: control-socket answers are decoded as whole UTF-8", () => {
  test("an é split across two reads arrives whole", async () => {
    const { file } = await socketServer((socket) => {
      let stage = 0;
      socket.on("data", () => {
        stage += 1;
        if (stage === 1) socket.write(`${JSON.stringify({ id: 1, result: { app: "Ardia" } })}\n`);
        else {
          const bytes = Buffer.from(`${JSON.stringify({ id: 2, result: [{ tabs: [{ id: "tab-1", title: "café" }] }] })}\n`, "utf8");
          const cut = bytes.indexOf(0xc3) + 1;
          socket.write(bytes.subarray(0, cut));
          setTimeout(() => socket.write(bytes.subarray(cut)), 20);
        }
      });
    });
    const windows = (await controlCall(file, null, "windows", null, 5)) as { tabs: { title: string }[] }[];
    expect(windows[0]?.tabs[0]?.title).toBe("café");
  });
});

describe("10: paths resolve like Path.resolve", () => {
  test("link/../out goes through the link", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "d3-path-")));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "real", "deep"), { recursive: true });
    fs.symlinkSync(path.join(root, "real", "deep"), path.join(root, "link"));
    const ctx = new Ctx(stateWith(new FakeBrowser()), {}, root, {}, null);
    const python = spawnSync(PYTHON, ["-c", "import sys; from pathlib import Path; print(Path(sys.argv[1], sys.argv[2]).resolve())", root, "link/../out"], { encoding: "utf8" });
    expect(python.status).toBe(0);
    expect(ctx.path("link/../out")).toBe(python.stdout.trim());
    expect(ctx.path("link/../out")).toBe(path.join(root, "real", "out"));
  });
});

describe("11 and 12: unanswered calls and the busy probe", () => {
  test("a mutation that times out marks the tab as not answering", async () => {
    const browser = new FakeBrowser((method) =>
      method === "Input.dispatchKeyEvent" ? new OutcomeUnknown("`Input.dispatchKeyEvent`", "Ardia didn't answer Input.dispatchKeyEvent in 30s after it was sent") : undefined,
    );
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    expect(await failure(page.send("Input.dispatchKeyEvent", { type: "keyDown" }))).toBeInstanceOf(OutcomeUnknown);
    expect(page.unansweredAt).toBeGreaterThan(0);
  });

  test("with no frame known yet, the probe evaluates 1 as Python does (round 2 of the review)", async () => {
    const browser = new FakeBrowser();
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    page.mainFrame = null;
    page.worlds.clear();
    page.unansweredAt = performance.now() / 1000;
    const before = browser.sent.length;
    await page.send("DOM.getDocument");
    expect(browser.sent.slice(before).map((entry) => entry.method)).toEqual(["Runtime.evaluate", "DOM.getDocument"]);
  });

});

describe("parser nits", () => {
  test("a long -- tail and repeated values parse without spreading, and digits follow the pinned Python", () => {
    const tail = Array.from({ length: 200_000 }, (_, index) => `a${index}`);
    const [, positionals] = parse(["--", ...tail]);
    expect(positionals).toHaveLength(200_000);
    const repeated = Array.from({ length: 2_000 }, () => ["--x", "v"]).flat();
    const [options] = parse(repeated, { "--x": "multi" });
    expect((options["x"] as string[]).length).toBe(2_000);
    const python = spawnSync(PYTHON, ["-c", "import json; from ardia_cli.browse import commands; print(json.dumps(commands.parse(['-١', '-1'])[1]))"], { cwd: CLI, encoding: "utf8" });
    expect(python.status).toBe(0);
    expect(parse(["-١", "-1"])[1]).toEqual(JSON.parse(python.stdout));
  });
});
