import "../libc-loaded.ts";
import { describe, expect, test } from "bun:test";
import { leaveOffscreen } from "../../src/browse/commands/core.ts";
import { Ctx } from "../../src/browse/commands/ctx.ts";
import { settledError } from "../../src/browse/daemon/server.ts";
import { BrowseError, ConnectionLost } from "../../src/browse/daemon-errors.ts";
import { State } from "../../src/browse/state/state.ts";
import { FakeBrowser, frameTree, MAIN, stateWith } from "./core-helpers.ts";

function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe("1: a fresh world handle is bound to the loader the frame tree reports", () => {
  test("a renderer swap whose frameNavigated is held back refuses the call before it runs", async () => {
    let generation = 1;
    const ran: number[] = [];
    const browser = new FakeBrowser((method) => {
      if (method === "Page.getFrameTree") return frameTree(MAIN, `LOADER-${generation}`);
      if (method === "Page.createIsolatedWorld") {
        generation += 1;
        return { executionContextId: 7 };
      }
      if (method === "Runtime.callFunctionOn") {
        ran.push(generation);
        return { result: { value: "ran" } };
      }
      return undefined;
    });
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    const error = (await failure(page.call("() => document.body.remove()"))) as BrowseError;
    expect(error.code).toBe("document_changed");
    expect(ran).toEqual([]);
    const after = browser.sent.map((entry) => entry.method);
    const handle = after.findIndex((method, index) => method === "Runtime.evaluate" && browser.sent[index]?.params["expression"] === "globalThis");
    expect(after[handle + 1]).toBe("Page.getFrameTree");
  });

  test("a world whose loader still matches by request is used", async () => {
    const browser = new FakeBrowser();
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    expect(await page.call("() => document.title", [], { read: true })).toBe("ok");
  });
});

function rollback(onClose: () => Record<string, unknown> | Error, reserve: (target: string) => boolean = () => true) {
  const browser = new FakeBrowser((method) => {
    if (method === "Target.createTarget") return { targetId: "FRESH" };
    if (method === "Page.navigate") return { errorText: "net::ERR_NAME_NOT_RESOLVED" };
    if (method === "Target.closeTarget") return onClose();
    if (method === "Target.getTargets") return { targetInfos: [{ targetId: "OLD", type: "page", url: "http://x/" }] };
    return undefined;
  });
  const state = stateWith(browser, ["OLD", "FRESH"]);
  state.current = "OLD";
  state.registry.reserveClose = reserve;
  return { browser, state };
}

describe("2: the rollback closes only through a close reservation", () => {
  test("a refused reservation leaves the replacement on the cleanup list, never closed directly", async () => {
    let allowed = false;
    const { browser, state } = rollback(() => ({ success: true }), () => allowed);
    const page = await state.page("OLD");
    page.url = "https://gone.example/";
    const error = (await failure(leaveOffscreen(new Ctx(state, {}, "/", {}, null, "set"), page))) as BrowseError;
    expect(error.code).toBe("navigation_failed");
    expect(state.mustClose.has("FRESH")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(browser.sent.some((entry) => entry.method === "Target.closeTarget")).toBe(false);
    allowed = true;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && state.mustClose.has("FRESH")) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(browser.sent.some((entry) => entry.method === "Target.closeTarget" && entry.params["targetId"] === "FRESH")).toBe(true);
    expect(state.mustClose.has("FRESH")).toBe(false);
    state.mustCloseTask?.stop.abort();
  });
});

describe("3: the command's own error survives a connection lost while rolling back", () => {
  test("the rollback close's ConnectionLost is the cause, and the daemon keeps the original error", async () => {
    let state: State | null = null;
    const { browser, state: made } = rollback(() => {
      (state as State & { browser: FakeBrowser }).browser.alive = false;
      return new ConnectionLost();
    });
    state = made;
    const page = await made.page("OLD");
    page.url = "https://gone.example/";
    const error = (await failure(leaveOffscreen(new Ctx(made, {}, "/", {}, null, "set"), page))) as BrowseError;
    expect(error.code).toBe("navigation_failed");
    expect(error.cause).toBeInstanceOf(ConnectionLost);
    const settled = settledError(error, browser);
    expect(settled.error).toBe(error);
    expect(settled.lost).toBe(true);
    made.mustCloseTask?.stop.abort();
  });

  test("an error with no cause from a dead link is still reported as the lost connection, as in Python", () => {
    const settled = settledError(new BrowseError("That tab was closed", null, "tab_detached"), { alive: false, closedByUs: false });
    expect(settled.error).toBeInstanceOf(ConnectionLost);
    expect(settled.lost).toBe(true);
    const alive = settledError(new BrowseError("x", null, "tab_detached"), { alive: true, closedByUs: false });
    expect(alive.lost).toBe(false);
  });
});
