import "../libc-loaded.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Cancelled, withSignal } from "../../src/browse/cdp/cancel.ts";
import { leaveOffscreen } from "../../src/browse/commands/core.ts";
import { Ctx } from "../../src/browse/commands/ctx.ts";
import { normalizeUrl, parse } from "../../src/browse/commands/parse.ts";
import { BrowseError, CdpError, ConnectionLost, OutcomeUnknown, Usage } from "../../src/browse/daemon-errors.ts";
import { begin } from "../../src/browse/metrics.ts";
import { State } from "../../src/browse/state/state.ts";
import { FakeBrowser, frameTree, MAIN, stateWith } from "./core-helpers.ts";

const PYTHON = process.env["ARDIA_TEST_PYTHON"] ?? "python3";
const CLI = new URL("../../..", import.meta.url).pathname;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

function python(code: string, ...args: string[]): string {
  const done = spawnSync(PYTHON, ["-c", code, ...args], { cwd: CLI, encoding: "utf8" });
  expect(done.stderr).toBe("");
  expect(done.status).toBe(0);
  return done.stdout.trim();
}

describe("1: every page call is bound to its world's handle", () => {
  test("a document swapped as the call arrives refuses the stale handle, and nothing runs in the new document", async () => {
    let generation = 1;
    const ran: number[] = [];
    let state: State | null = null;
    const browser = new FakeBrowser((method, params, session) => {
      if (method === "Page.getFrameTree") return frameTree(MAIN, `LOADER-${generation}`);
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Runtime.evaluate" && params["expression"] === "globalThis") return { result: { type: "object", objectId: `WORLD-${generation}` } };
      if (method === "Runtime.callFunctionOn") {
        generation += 1;
        (state as State).onEvent("Page.frameNavigated", { frame: { id: MAIN, loaderId: `LOADER-${generation}`, url: "http://127.0.0.1/new.html" } }, session);
        const handle = params["objectId"];
        if (handle !== undefined && handle !== `WORLD-${generation}`) return new CdpError(method, "Could not find object with given id");
        ran.push(generation);
        return { result: { value: "ran" } };
      }
      return undefined;
    });
    state = stateWith(browser);
    const page = await state.page("TARGET");
    const error = (await failure(page.call("() => document.body.remove()"))) as BrowseError;
    expect(error.code).toBe("document_changed");
    expect(ran).toEqual([]);
    const callsWithContext = browser.sent.filter((entry) => entry.method === "Runtime.callFunctionOn" && entry.params["executionContextId"] !== undefined);
    expect(callsWithContext).toEqual([]);
  });

  test("a read whose handle went stale is retried once in a fresh world", async () => {
    let stale = true;
    const browser = new FakeBrowser((method, params) => {
      if (method === "Runtime.evaluate" && params["expression"] === "globalThis") return { result: { type: "object", objectId: `WORLD-${stale ? 1 : 2}` } };
      if (method === "Runtime.callFunctionOn" && params["objectId"] === "WORLD-1") {
        stale = false;
        return new CdpError(method, "Could not find object with given id");
      }
      return undefined;
    });
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    expect(await page.call("() => document.title", [], { read: true })).toBe("ok");
    expect(browser.sent.filter((entry) => entry.method === "Runtime.callFunctionOn").map((entry) => entry.params["objectId"])).toEqual(["WORLD-1", "WORLD-2"]);
  });
});

describe("2: an init script whose registration is ambiguous drops the session", () => {
  for (const [label, ambiguous] of [
    ["timed out", () => new OutcomeUnknown("`Page.addScriptToEvaluateOnNewDocument`", "Ardia didn't answer Page.addScriptToEvaluateOnNewDocument in 30s after it was sent")],
    ["cancelled", () => new Cancelled()],
  ] as const) {
    test(`a registration that ${label} detaches the session and the next use replays everything once`, async () => {
      const stop = new AbortController();
      let first = true;
      const browser = new FakeBrowser((method, _params, session) => {
        if (method === "Page.addScriptToEvaluateOnNewDocument" && session === "SESSION-2" && first) {
          first = false;
          if (label === "cancelled") stop.abort();
          return ambiguous();
        }
        if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "9" };
        return undefined;
      });
      const state = stateWith(browser);
      const page = await state.page("TARGET");
      page.initScripts.set("1", "window.hooked = 1");
      page.scriptSources.set("1", "window.hooked = 1");
      page.detach();
      const error = await failure(withSignal(stop.signal, () => state.page("TARGET")));
      expect(error).not.toBeNull();
      expect((error as BrowseError).code).not.toBe("setup_lost");
      expect(browser.sent.some((entry) => entry.method === "Target.detachFromTarget" && entry.params["sessionId"] === "SESSION-2")).toBe(true);
      expect(page.initScripts.has("1")).toBe(true);
      await state.page("TARGET");
      expect(page.sessionId).toBe("SESSION-3");
      expect(browser.sent.filter((entry) => entry.method === "Page.addScriptToEvaluateOnNewDocument" && entry.session === "SESSION-3")).toHaveLength(1);
      expect(Object.fromEntries(page.scriptIds)).toEqual({ "1": "9" });
    });
  }
});

describe("3: the offscreen rollback closes what it made", () => {
  function setup(onSend: (method: string, params: Record<string, unknown>) => unknown) {
    const browser = new FakeBrowser((method, params) => {
      const answer = onSend(method, params);
      if (answer !== undefined) return answer as never;
      if (method === "Page.navigate") return { errorText: "net::ERR_NAME_NOT_RESOLVED" };
      return undefined;
    });
    const state = stateWith(browser, ["OLD", "FRESH"]);
    state.current = "OLD";
    return { browser, state };
  }

  test("a createTarget answered after a cancel is closed by its own target id", async () => {
    const stop = new AbortController();
    let answer: (value: Record<string, unknown>) => void = () => {};
    const { browser, state } = setup((method) => {
      if (method === "Target.createTarget") {
        stop.abort();
        return () => new Promise<Record<string, unknown>>((resolve) => (answer = resolve));
      }
      return undefined;
    });
    const page = await state.page("OLD");
    page.url = "https://gone.example/";
    expect(await failure(withSignal(stop.signal, () => leaveOffscreen(new Ctx(state, {}, "/", {}, null, "open"), page)))).toBeInstanceOf(Cancelled);
    answer({ targetId: "FRESH" });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !browser.sent.some((entry) => entry.method === "Target.closeTarget" && entry.params["targetId"] === "FRESH")) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(browser.sent.some((entry) => entry.method === "Target.closeTarget" && entry.params["targetId"] === "FRESH")).toBe(true);
    expect(state.current).toBe("OLD");
  });

  test("a replacement Chromium won't close goes on the cleanup list and isn't counted as rolled back", async () => {
    const { state } = setup((method) => {
      if (method === "Target.createTarget") return { targetId: "FRESH" };
      if (method === "Target.closeTarget") return { success: false };
      return undefined;
    });
    const page = await state.page("OLD");
    page.url = "https://gone.example/";
    const outcome = await begin({ argv: ["set"] }, async (metrics) => ({
      error: await failure(leaveOffscreen(new Ctx(state, {}, "/", {}, null, "set"), page)),
      flags: metrics.values,
    }));
    expect((outcome.error as BrowseError).code).toBe("navigation_failed");
    expect(state.mustClose.has("FRESH")).toBe(true);
    expect(outcome.flags.has("offscreen_handoff_rolled_back")).toBe(false);
    state.mustCloseTask?.stop.abort();
  });

  test("a lost connection while closing the replacement doesn't hide the original failure", async () => {
    const { state } = setup((method) => {
      if (method === "Target.createTarget") return { targetId: "FRESH" };
      if (method === "Target.closeTarget") return new ConnectionLost();
      return undefined;
    });
    const page = await state.page("OLD");
    page.url = "https://gone.example/";
    const error = (await failure(leaveOffscreen(new Ctx(state, {}, "/", {}, null, "set"), page))) as BrowseError;
    expect(error.code).toBe("navigation_failed");
    expect(error.cause).toBeInstanceOf(ConnectionLost);
    state.mustCloseTask?.stop.abort();
  });
});

function socketDir(): string {
  const dir = fs.mkdtempSync(path.join("/tmp", "d3a-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("4: the caller counts as announced only after the handshake", () => {
  test("a cancelled announce is tried again by the next command", async () => {
    const dir = socketDir();
    let answering = false;
    const server = net.createServer((socket) => {
      socket.on("data", (chunk) => {
        if (!answering) return;
        for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
          const id = JSON.parse(line)["id"];
          socket.write(`${JSON.stringify(id === 1 ? { id, result: { app: "Ardia" } } : { id, result: {} })}\n`);
        }
      });
    });
    cleanups.push(() => server.close());
    await new Promise<void>((resolve) => server.listen(path.join(dir, "ArdiaControl.sock"), () => resolve()));
    const state = stateWith(new FakeBrowser());
    state.caller = { name: "tester", app: null };
    const endpoint = { ws: "ws://x/devtools/browser/y", source: path.join(dir, "Chromium", "ArdiaControl.json"), explicit: false, active: null, instance: "i" };
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    await withSignal(stop.signal, () => state.announceCaller(endpoint));
    expect(state.announced).toBeNull();
    answering = true;
    await state.announceCaller(endpoint);
    expect(state.announced).toEqual({ name: "tester", app: null });
  });
});

describe("5: a cancelled active-tab lookup ends its HTTP request", () => {
  test("the request's socket closes when the command is cancelled", async () => {
    let closed = false;
    const server = http.createServer((request) => request.socket.on("close", () => (closed = true)));
    cleanups.push(() => server.close());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    const state = stateWith(new FakeBrowser());
    state.endpoint = { ws: "ws://x/devtools/browser/y", source: "--port 1", explicit: true, active: `http://127.0.0.1:${port}/ardia/active`, instance: "i" };
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    expect(await failure(withSignal(stop.signal, () => state.activeTarget()))).toBeInstanceOf(Cancelled);
    const deadline = Date.now() + 1000;
    while (!closed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(true);
  });
});

describe("6: paths resolve exactly like CPython 3.13's realpath", () => {
  test("a loop then a link: loop/../link/out", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "d3-loop-")));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "realdir", "deep"), { recursive: true });
    fs.symlinkSync("loop", path.join(root, "loop"));
    fs.symlinkSync(path.join(root, "realdir", "deep"), path.join(root, "link"));
    fs.symlinkSync("../realdir", path.join(root, "realdir", "back"));
    const ctx = new Ctx(stateWith(new FakeBrowser()), {}, root, {}, null);
    for (const given of ["loop/../link/out", "link/../out", "loop/x/../y", "realdir/back/back/deep/../z", "missing/../link/./out/", "/../..//link"]) {
      const expected = python("import sys; from pathlib import Path; print(Path(sys.argv[1], sys.argv[2]).resolve())", root, given);
      expect([given, ctx.path(given)]).toEqual([given, expected]);
    }
  });
});

describe("7: with no frame known, the busy probe is Python's", () => {
  test("it evaluates 1 in the default context and reads no frame tree", async () => {
    const browser = new FakeBrowser();
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    page.mainFrame = null;
    page.worlds.clear();
    page.unansweredAt = performance.now() / 1000;
    const before = browser.sent.length;
    await page.send("DOM.getDocument");
    expect(browser.sent.slice(before).map((entry) => [entry.method, entry.params])).toEqual([
      ["Runtime.evaluate", { expression: "1", returnByValue: true }],
      ["DOM.getDocument", {}],
    ]);
  });
});

describe("8: target discovery", () => {
  test("a refused Target.setDiscoverTargets still connects, without a retry, as in Python", async () => {
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
      const browser = new Opening((method) => (method === "Target.setDiscoverTargets" ? new CdpError(method, "refused") : undefined));
      made.push(browser);
      return browser as never;
    };
    await state.connect();
    expect(state.connected).toBe(true);
    expect(made).toHaveLength(1);
    expect(made[0]?.methods().filter((method) => method.startsWith("Target."))).toEqual(["Target.setDiscoverTargets", "Target.getTargets"]);
  });
});

describe("9: digits follow the pinned Python's Unicode tables", () => {
  test("U+1E5F1 isn't a digit to Python 3.13; Arabic-Indic digits are", () => {
    const newer = String.fromCodePoint(0x1e5f1);
    const arabic = "٣";
    const expected = JSON.parse(
      python(
        "import json, sys\nfrom ardia_cli.browse import commands\nout = []\nfor token in sys.argv[1:]:\n    try:\n        out.append(['ok', commands.parse([token])[1]])\n    except Exception as error:\n        out.append(['usage', str(error)])\nout.append(commands.normalize_url('127.0.0.1:' + sys.argv[1][1:]))\nout.append(commands.normalize_url('127.0.0.1:' + sys.argv[2][1:]))\nprint(json.dumps(out))",
        `-${newer}`,
        `-${arabic}`,
      ),
    );
    const got: unknown[] = [];
    for (const token of [`-${newer}`, `-${arabic}`]) {
      try {
        got.push(["ok", parse([token])[1]]);
      } catch (error) {
        if (!(error instanceof Usage)) throw error;
        got.push(["usage", error.text]);
      }
    }
    got.push(normalizeUrl(`127.0.0.1:${newer}`), normalizeUrl(`127.0.0.1:${arabic}`));
    expect(got).toEqual(expected);
    expect((got[0] as unknown[])[0]).toBe("usage");
  });
});
