import { describe, expect, test } from "bun:test";
import { Cancelled, withSignal } from "../../src/browse/cdp/cancel.ts";
import { State } from "../../src/browse/state/state.ts";
import "../libc-loaded.ts";
import { FakeBrowser } from "./core-helpers.ts";

class Opening extends FakeBrowser {
  async open(): Promise<void> {}
}

function freshState(): State {
  return new State({ session: "s", key: "", browseFd: null, noAutoDialog: false, pinTab: false }, async () => ({
    ws: "ws://127.0.0.1:1/devtools/browser/x",
    source: "--port 1",
    explicit: true,
    active: null,
    instance: "instance",
  }));
}

async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return null;
}

describe("concurrent connects share one attempt", () => {
  test("calls that connect at once open one browser and none marks the session lost", async () => {
    const made: Opening[] = [];
    const state = freshState();
    state.makeBrowser = () => {
      const browser = new Opening((method) => (method === "Target.getTargets" ? async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { targetInfos: [] };
      } : undefined));
      made.push(browser);
      return browser as never;
    };
    await Promise.all([state.connect(), state.connect(), state.connect()]);
    expect(made).toHaveLength(1);
    expect(state.connected).toBe(true);
    expect(state.lost).toBe(false);
  });

  test("a caller waiting on an attempt someone else cancelled connects on its own", async () => {
    const stop = new AbortController();
    const made: Opening[] = [];
    const state = freshState();
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
    const first = failure(withSignal(stop.signal, () => state.connect()));
    const second = state.connect();
    expect(await first).toBeInstanceOf(Cancelled);
    await second;
    expect(state.connected).toBe(true);
    expect(made).toHaveLength(2);
  });
});
