import "../libc-loaded.ts";
import { describe, expect, test } from "bun:test";
import { leaveOffscreen } from "../../src/browse/commands/core.ts";
import { Ctx } from "../../src/browse/commands/ctx.ts";
import { BrowseError, CdpError } from "../../src/browse/daemon-errors.ts";
import { begin } from "../../src/browse/metrics.ts";
import * as temptabs from "../../src/browse/state/temptabs.ts";
import { FakeBrowser, stateWith } from "./core-helpers.ts";

function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe("1: a stale context while a world is made", () => {
  for (const message of ["Cannot find context with specified id", "Could not find object with given id"]) {
    test(`"${message}" from the handle evaluate retries a read once and refuses a mutation as document_changed`, async () => {
      let refusals = 1;
      const browser = new FakeBrowser((method, params) => {
        if (method === "Runtime.evaluate" && params["expression"] === "globalThis" && refusals > 0) {
          refusals -= 1;
          return new CdpError(method, message);
        }
        return undefined;
      });
      const state = stateWith(browser);
      const page = await state.page("TARGET");
      expect(await page.call("() => document.title", [], { read: true })).toBe("ok");
      refusals = 1;
      page.worlds.clear();
      const error = (await failure(page.call("() => document.body.remove()"))) as BrowseError;
      expect(error).not.toBeInstanceOf(CdpError);
      expect(error.code).toBe("document_changed");
    });
  }
});

describe("2: a target that's already gone counts as closed", () => {
  function setup(closeError: Error) {
    const browser = new FakeBrowser((method) => {
      if (method === "Target.createTarget") return { targetId: "FRESH" };
      if (method === "Page.navigate") return { errorText: "net::ERR_NAME_NOT_RESOLVED" };
      if (method === "Target.closeTarget") return closeError;
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "OLD", type: "page", url: "http://x/" }] };
      return undefined;
    });
    const state = stateWith(browser, ["OLD", "FRESH"]);
    state.current = "OLD";
    return { browser, state };
  }

  test("the rollback's close of a vanished replacement is a close, and is counted", async () => {
    const { state } = setup(new CdpError("Target.closeTarget", "No target with given id found"));
    const page = await state.page("OLD");
    page.url = "https://gone.example/";
    const outcome = await begin({ argv: ["set"] }, async (metrics) => ({
      error: await failure(leaveOffscreen(new Ctx(state, {}, "/", {}, null, "set"), page)),
      flags: metrics.values,
    }));
    expect((outcome.error as BrowseError).code).toBe("navigation_failed");
    expect(state.mustClose.has("FRESH")).toBe(false);
    expect(outcome.flags.get("offscreen_handoff_rolled_back")).toBe(true);
  });

  test("closeUntracked and closeOne treat a vanished target as closed", async () => {
    const { state } = setup(new CdpError("Target.closeTarget", "No target with given id found"));
    expect(await temptabs.closeUntracked(state, "FRESH")).toBe(true);
    let finished = false;
    state.registry.finishClose = () => {
      finished = true;
    };
    await temptabs.closeOne(state, "FRESH");
    expect(finished).toBe(true);
  });
});

describe("5: concurrent first calls share one world", () => {
  test("two calls on a frame with no world make it once", async () => {
    const browser = new FakeBrowser();
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    await Promise.all([page.call("() => 1", [], { read: true }), page.call("() => 2", [], { read: true }), page.call("() => 3")]);
    expect(browser.sent.filter((entry) => entry.method === "Page.createIsolatedWorld")).toHaveLength(1);
    expect(browser.sent.filter((entry) => entry.method === "Runtime.evaluate" && entry.params["expression"] === "globalThis")).toHaveLength(1);
  });
});
