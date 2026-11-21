import { describe, expect, test } from "bun:test";
import { CLEANUPS, drainCleanups, dropPoint, drag } from "../../src/browse/act/drag.ts";
import { frameOffset, localRootOffset } from "../../src/browse/state/frames.ts";
import { insertsAtOnce, pickOption } from "../../src/browse/act/fields.ts";
import { tap, waitEnabled } from "../../src/browse/act/pointer.ts";
import { Cancelled, sleep, withSignal } from "../../src/browse/cdp/cancel.ts";
import { dragText, filledResult } from "../../src/browse/commands/act.ts";
import "../../src/browse/commands/all.ts";
import { dispatch } from "../../src/browse/commands/index.ts";
import { NetworkWatch, SETTLE_LIMIT } from "../../src/browse/changes/observe.ts";
import { editingCommands } from "../../src/browse/input/input.ts";
import { Ctx } from "../../src/browse/commands/ctx.ts";
import { BrowseError, Gated, OutcomeUnknown, Usage } from "../../src/browse/daemon-errors.ts";
import { ACTIONS_DISABLED_STATE } from "../../src/browse/js/index.ts";
import { begin } from "../../src/browse/metrics.ts";
import { Element, type Page } from "../../src/browse/state/page.ts";
import type { State } from "../../src/browse/state/state.ts";
import { cancelAfter, ends, FakeRenderer } from "./act-fakes.ts";

const BOX: [number, number, number, number] = [10, 200, 110, 240];

describe("DropPoint", () => {
  test("moving down drops on the lower quarter and up on the upper", () => {
    expect(dropPoint(BOX, [60, 20], null)).toEqual([60, 230]);
    expect(dropPoint(BOX, [60, 500], null)).toEqual([60, 210]);
  });

  test("before and after pick the side whatever the direction", () => {
    expect(dropPoint(BOX, [60, 20], "before")).toEqual([60, 210]);
    expect(dropPoint(BOX, [60, 500], "after")).toEqual([60, 230]);
  });

  test("a row of items uses the width", () => {
    expect(dropPoint(BOX, [-400, 220], null)).toEqual([85, 220]);
    expect(dropPoint(BOX, [900, 220], null)).toEqual([35, 220]);
  });
});

describe("DragAnswer", () => {
  test("names the new place or an unchanged order", () => {
    expect(dragText({ html5: true, started: true, dropped: true, position: { from: 4, to: 5, count: 5 } })).toBe("✓ Done (HTML5 drag and drop)\nmoved to 5 of 5 (was 4)");
    expect(dragText({ html5: false, position: { from: 2, to: 2, count: 3 } })).toBe("✓ Done\nthe order didn't change: still 2 of 3");
  });

  test("before and after are exclusive", async () => {
    const ctx = new Ctx(null as unknown as State, {}, "/", {}, null, "drag");
    const error = await dispatch(ctx, "drag", ["@e1", "@e2", "--before", "--after"]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Usage);
  });
});

describe("InsertOrType", () => {
  test("plain inputs get one insert unless humanized, guarded or secret", () => {
    const text = { tag: "input", type: "text", editable: true };
    expect(insertsAtOnce(text, false, null)).toBe(true);
    expect(insertsAtOnce({ ...text, type: "email" }, false, null)).toBe(true);
    expect(insertsAtOnce({ ...text, type: "password" }, false, null)).toBe(false);
    expect(insertsAtOnce(text, true, null)).toBe(false);
    expect(insertsAtOnce(text, false, async () => {})).toBe(false);
    expect(insertsAtOnce({ tag: "textarea", editable: true }, false, null)).toBe(true);
  });
});

class Disabling {
  checks = 0;
  constructor(
    readonly enabledAfter: number | null = null,
    readonly aria = false,
  ) {}

  async call(fn: string): Promise<unknown> {
    if (fn === ACTIONS_DISABLED_STATE) {
      this.checks += 1;
      const off = this.enabledAfter !== null && this.checks > this.enabledAfter;
      return { native: !off && !this.aria, aria: !off && this.aria };
    }
    return null;
  }
}

describe("WaitForEnabled", () => {
  test("returns once the target is enabled", async () => {
    const page = new Disabling(3);
    await waitEnabled(page as unknown as Page, new Element("F", "O", 1, "@e4"));
    expect(page.checks).toBe(4);
  });

  test("a target that stays disabled fails after the wait", async () => {
    const error = (await waitEnabled(new Disabling() as unknown as Page, new Element("F", "O", 1, "@e4")).catch((caught: unknown) => caught)) as BrowseError;
    expect(error.code).toBe("disabled");
    expect(error.message).toContain("@e4 is disabled");
  });

  test("aria-disabled is clicked anyway after the wait", async () => {
    await waitEnabled(new Disabling(null, true) as unknown as Page, new Element("F", "O", 1, "@e4"), false);
  });

  test("the wait is counted", async () => {
    const values = await begin({ argv: ["click"], telemetry: true }, async (metrics) => {
      await waitEnabled(new Disabling(1) as unknown as Page, new Element("F", "O", 1, "@e4"));
      return metrics.values;
    });
    expect(values.get("waited_for_enabled")).toBe(true);
  });
});

describe("FillOnSelect", () => {
  test("picks by label or value and reports the label", async () => {
    const picked: unknown[] = [];
    const page = {
      async call(fn: string, args: unknown[]) {
        if (fn.includes("el.options")) return [{ text: "Alpha", exact: ["a"] }, { text: "Beta", exact: ["b"] }];
        if (fn.includes("selectOptions")) picked.push(args[1]);
        return null;
      },
      async focusElement() {},
    } as unknown as Page;
    expect(await pickOption(page, new Element("F", "O", 1, "@e2"), "beta")).toBe("Beta");
    expect(await pickOption(page, new Element("F", "O", 1, "@e2"), "a")).toBe("Alpha");
    const error = (await pickOption(page, new Element("F", "O", 1, "@e2"), "Gamma").catch((caught: unknown) => caught)) as BrowseError;
    expect(picked).toEqual([["b"], ["a"]]);
    expect(error.message).toContain("None of the options");
  });
});

describe("CellAnswer", () => {
  test("a cell edit prints its name, new value and old one", () => {
    const result = filledResult("filled", "#c-2356-reorder", false, "250", { cell: "Reorder level, FAS-53565 Reno", value: "250", was: "150" });
    expect(result.text).toBe('✓ Done\n~ gridcell "Reorder level, FAS-53565 Reno": 250 (was 150)');
    expect((result.data as Record<string, unknown>)["was"]).toBe("150");
    const empty = filledResult("filled", "#c", false, "", { cell: "Bin, new row", value: "", was: "" });
    expect(empty.text).toBe('✓ Done\n~ gridcell "Bin, new row": empty (was empty)');
  });
});

describe("HtmlDragTest", () => {
  test("draggable source goes through interception in order", async () => {
    const page = new FakeRenderer();
    const outcome = await drag(page.page, ...ends(), false);
    expect(outcome).toEqual({ html5: true, started: true, dropped: true });
    expect(page.calls()).toEqual([
      ["Input.setInterceptDrags", true],
      ["Input.dispatchMouseEvent", "mouseMoved"],
      ["Input.dispatchMouseEvent", "mousePressed"],
      ["Input.dispatchMouseEvent", "mouseMoved"],
      ["Input.dispatchDragEvent", "dragEnter"],
      ["Input.dispatchDragEvent", "dragOver"],
      ["Input.dispatchDragEvent", "drop"],
      ["Input.dispatchMouseEvent", "mouseReleased"],
      ["Input.setInterceptDrags", false],
    ]);
    expect(page.dragIntercepted).toBeNull();
    expect(page.input.pointer.interception).toBeNull();
    expect(page.input.holding).toBe(false);
  });

  test("humanized drag keeps a curved path of drag overs", async () => {
    const page = new FakeRenderer();
    const outcome = await drag(page.page, ...ends(), true);
    expect(outcome["dropped"]).toBe(true);
    const kinds = page.calls().map(([, kind]) => kind);
    expect(kinds[0]).toBe(true);
    expect(kinds.at(-1)).toBe(false);
    expect(kinds.filter((kind) => kind === "dragOver").length).toBeGreaterThan(3);
    expect(kinds.filter((kind) => kind === "drop").length).toBe(1);
    expect(kinds.indexOf("dragEnter")).toBeLessThan(kinds.indexOf("drop"));
    expect(kinds.indexOf("drop")).toBeLessThan(kinds.indexOf("mouseReleased"));
  });

  test("refused interception fails before any input", async () => {
    const page = new FakeRenderer({ refused: ["Input.setInterceptDrags"] });
    const error = (await drag(page.page, ...ends(), false).catch((caught: unknown) => caught)) as Gated;
    expect(error).toBeInstanceOf(Gated);
    expect(error.method).toBe("Input.setInterceptDrags");
    expect(error.message).toContain("HTML5 draggable");
    expect(page.calls()).toEqual([]);
    expect(page.dragIntercepted).toBeNull();
  });

  test("failure after interception cancels, releases, then disables", async () => {
    const page = new FakeRenderer({ failing: ["Input.dispatchDragEvent dragOver"] });
    expect(await drag(page.page, ...ends(), false).catch((caught: unknown) => caught)).toBeInstanceOf(OutcomeUnknown);
    const kinds = page.calls().map(([, kind]) => kind);
    expect(kinds).not.toContain("drop");
    expect(kinds.indexOf("dragCancel")).toBeLessThan(kinds.indexOf("mouseReleased"));
    expect(kinds.at(-1)).toBe(false);
    expect(page.input.holding).toBe(false);
  });

  test("cleanup is done before the drag returns", async () => {
    const page = new FakeRenderer({
      failing: ["Input.dispatchDragEvent dragOver"],
      delays: { "Input.dispatchDragEvent dragCancel": 0.25, "Input.dispatchMouseEvent mouseReleased": 0.1 },
    });
    expect(await drag(page.page, ...ends(), false).catch((caught: unknown) => caught)).toBeInstanceOf(OutcomeUnknown);
    const settled = [...page.calls()];
    page.input.pointer.held = "left";
    page.input.pointer.pressedButton = "left";
    await sleep(0.4);
    expect(page.input.pointer.held).toBe("left");
    expect(page.calls()).toEqual(settled);
    const kinds = settled.map(([, kind]) => kind);
    expect(kinds.indexOf("dragCancel")).toBeLessThan(kinds.indexOf("mouseReleased"));
    expect(kinds.at(-1)).toBe(false);
  });

  test("failed drop is cancelled before the release", async () => {
    const page = new FakeRenderer({ failing: ["Input.dispatchDragEvent drop"] });
    expect(await drag(page.page, ...ends(), false).catch((caught: unknown) => caught)).toBeInstanceOf(OutcomeUnknown);
    const kinds = page.calls().map(([, kind]) => kind);
    expect(kinds).toContain("dragCancel");
    expect(kinds.indexOf("dragCancel")).toBeLessThan(kinds.indexOf("mouseReleased"));
    expect(kinds.at(-1)).toBe(false);
  });

  test("failed cancel still releases before disabling", async () => {
    const page = new FakeRenderer({ failing: ["Input.dispatchDragEvent dragOver", "Input.dispatchDragEvent dragCancel"] });
    expect(await drag(page.page, ...ends(), false).catch((caught: unknown) => caught)).toBeInstanceOf(OutcomeUnknown);
    const kinds = page.calls().map(([, kind]) => kind);
    expect(kinds.slice(-2)).toEqual(["mouseReleased", false]);
    expect(page.input.holding).toBe(false);
  });

  test("cancelled drag still cleans up", async () => {
    const page = new FakeRenderer();
    const outcome = await cancelAfter((signal) => withSignal(signal, () => drag(page.page, ...ends(), true)), () => page.dragging);
    expect(outcome).toBeInstanceOf(Cancelled);
    await sleep(0.2, null);
    const kinds = page.calls().map(([, kind]) => kind);
    expect(kinds).not.toContain("drop");
    expect(kinds).toContain("dragCancel");
    expect(kinds.at(-1)).toBe(false);
    expect(page.input.holding).toBe(false);
  });

  test("drag the page refuses to start stays a mouse drag", async () => {
    const page = new FakeRenderer({ startsDrag: false });
    expect(await drag(page.page, ...ends(), false)).toEqual({ html5: true, started: false, dropped: false });
    const kinds = page.calls().map(([, kind]) => kind);
    expect(kinds).not.toContain("dragEnter");
    expect(kinds.slice(-2)).toEqual(["mouseReleased", false]);
  });

  test("interception that cannot be turned off is reported", async () => {
    const page = new FakeRenderer({ failing: ["Input.setInterceptDrags false"] });
    const outcome = await drag(page.page, ...ends(), false);
    expect(outcome["interceptionLeftOn"]).toBe(true);
    expect(dragText(outcome)).toContain("didn't confirm drag interception was turned off");
  });

  test("plain source never touches interception", async () => {
    const page = new FakeRenderer({ draggable: false });
    expect(await drag(page.page, ...ends(), false)).toEqual({ html5: false });
    expect(new Set(page.calls().map(([method]) => method))).toEqual(new Set(["Input.dispatchMouseEvent"]));
  });

  test("hidden tab is refused and interception turned off", async () => {
    const page = new FakeRenderer({ hidden: true });
    const error = (await drag(page.page, ...ends(), false).catch((caught: unknown) => caught)) as BrowseError;
    expect(error.code).toBe("tab_hidden");
    expect(page.calls()).toEqual([
      ["Input.setInterceptDrags", true],
      ["Input.setInterceptDrags", false],
    ]);
  });

  test("drag text says what happened", () => {
    expect(dragText({ html5: false })).toBe("✓ Done");
    expect(dragText({ html5: true, started: false, dropped: false })).toContain("plain mouse drag");
    expect(dragText({ html5: true, started: true, dropped: false })).toContain("didn't accept the drop");
    expect(dragText({ html5: true, started: true, dropped: true })).toBe("✓ Done (HTML5 drag and drop)");
  });
});

describe("HeldInputTest", () => {
  test("keydown held across commands then released", async () => {
    const page = new FakeRenderer();
    const input = page.input;
    await input.gesture("keydown", () => input.pressCombo("Shift", false, true), { keepHeld: true });
    expect(input.holding).toBe(true);
    await input.releaseAll();
    expect(input.holding).toBe(false);
    expect(page.params.map(([, params]) => params["type"])).toEqual(["rawKeyDown", "keyUp"]);
  });

  test("interrupted press releases keys and modifiers", async () => {
    const page = new FakeRenderer();
    const input = page.input;
    const slowPress = async () => {
      await input.pressCombo("Shift", false, true);
      await input.pressCombo("a", false, true);
      await sleep(10);
    };
    const outcome = await cancelAfter((signal) => withSignal(signal, () => input.gesture("press", slowPress)), () => input.heldKeys.size === 2, 0);
    expect(outcome).toBeInstanceOf(Cancelled);
    const released = page.params.filter(([, params]) => params["type"] === "keyUp").map(([, params]) => params["key"]);
    expect([...released].sort()).toEqual(["Shift", "a"]);
    expect(input.holding).toBe(false);
  });

  test("hidden tab refuses input before dispatch", async () => {
    const page = new FakeRenderer({ hidden: true });
    expect(await page.input.gesture("click", () => page.input.pressCombo("Enter", false)).catch((caught: unknown) => caught)).toBeInstanceOf(BrowseError);
    expect(page.sent).toEqual([]);
  });

  test("mouse button released when gesture breaks", async () => {
    const page = new FakeRenderer();
    const mouse = page.input.pointer;
    mouse.held = "left";
    mouse.pressedButton = "left";
    mouse.position = [10, 20];
    expect(await page.input.gesture("drag", async () => Promise.reject(new BrowseError("boom"))).catch((caught: unknown) => caught)).toBeInstanceOf(BrowseError);
    const last = page.params.at(-1)?.[1] as Record<string, unknown>;
    expect(last["type"]).toBe("mouseReleased");
    expect([last["x"], last["y"]]).toEqual([10, 20]);
  });

  test("human mouse marks the button held before dispatch", async () => {
    const page = new FakeRenderer();
    const mouse = page.input.pointer;
    const seen: unknown[] = [];
    const send = page.send.bind(page);
    page.send = async (method: string, params: Record<string, unknown> | null = null) => {
      seen.push(mouse.held);
      return send(method, params);
    };
    await mouse.dispatchButton("mousePressed", "left");
    expect(seen).toEqual(["left"]);
    await mouse.dispatchButton("mouseReleased", "left");
    expect(mouse.held).toBeNull();
  });
});

class WatchPage {
  readonly state = { listeners: [] as unknown[] };
  sessionId: string | null = "S";
  readonly sent: string[] = [];
  enabled = false;
  constructor(public networkOn = false) {}

  async send(method: string): Promise<Record<string, unknown>> {
    this.sent.push(method);
    return {};
  }

  get page(): Page {
    return this as unknown as Page;
  }
}

function events(watch: NetworkWatch, page: Page): void {
  const fire = (target: Page, method: string, params: Record<string, unknown>) => watch.listener(target, method, params);
  fire(page, "Network.requestWillBeSent", { requestId: "1", type: "Fetch", request: { method: "post", url: "http://x/api?token=t" } });
  fire(page, "Network.responseReceived", { requestId: "1", response: { status: 201 } });
  fire(page, "Network.requestWillBeSent", { requestId: "2", type: "XHR", request: { method: "GET", url: "http://x/list" } });
  fire(page, "Network.requestWillBeSent", { requestId: "3", type: "Document", request: { method: "POST", url: "http://x/form" } });
  fire(page, "Network.requestWillBeSent", { requestId: "3", type: "Document", request: { method: "GET", url: "http://x/done" }, redirectResponse: { status: 303 } });
  fire(page, "Network.responseReceived", { requestId: "3", response: { status: 200 } });
  fire(page, "Network.loadingFinished", { requestId: "3" });
  fire(new WatchPage().page, "Network.requestWillBeSent", { requestId: "9", request: { method: "POST", url: "http://other/" } });
}

describe("NetworkWatchTest", () => {
  test("writes are the non-GET requests of this page", async () => {
    const page = new WatchPage();
    const watch = new NetworkWatch(page.page);
    await watch.start();
    events(watch, page.page);
    expect(watch.busy()).toBe(true);
    watch.listener(page.page, "Network.loadingFailed", { requestId: "2", errorText: "net::ERR_ABORTED" });
    expect(watch.busy()).toBe(false);
    await watch.stop();
    expect(page.sent).toEqual(["Network.enable", "Network.disable"]);
    expect(page.state.listeners).toEqual([]);
    expect(watch.writes().map((write) => [write["method"], write["url"], write["statuses"]])).toEqual([
      ["POST", "http://x/api?token=…", [201]],
      ["POST", "http://x/form", [303, 200]],
    ]);
  });

  test("cancelled while enabling leaves no listener", async () => {
    const page = new WatchPage();
    page.send = async (method: string) => {
      page.sent.push(method);
      if (method === "Network.enable") await sleep(10);
      return {};
    };
    const watch = new NetworkWatch(page.page);
    expect(await cancelAfter((signal) => withSignal(signal, () => watch.start()), () => page.sent.length > 0, 0.05)).toBeInstanceOf(Cancelled);
    expect(page.state.listeners).toEqual([]);
    expect(page.sent).toEqual(["Network.enable", "Network.disable"]);
  });

  test("cancel during stop is not swallowed", async () => {
    const page = new WatchPage();
    page.send = async (method: string) => {
      page.sent.push(method);
      if (method === "Network.disable") await sleep(0.5);
      return {};
    };
    const watch = new NetworkWatch(page.page);
    await watch.start();
    expect(await cancelAfter((signal) => withSignal(signal, () => watch.stop()), () => page.sent.length > 1, 0.05)).toBeInstanceOf(Cancelled);
  });

  test("a cancelled stop finishes its disable before the next command", async () => {
    const page = new WatchPage();
    page.send = async (method: string) => {
      page.sent.push(method);
      if (method === "Network.enable") page.enabled = true;
      if (method === "Network.disable") {
        await sleep(0.3);
        page.enabled = false;
      }
      return {};
    };
    const watch = new NetworkWatch(page.page);
    await watch.start();
    expect(await cancelAfter((signal) => withSignal(signal, () => watch.stop()), () => page.sent.length > 1, 0.05)).toBeInstanceOf(Cancelled);
    page.networkOn = true;
    await page.send("Network.enable");
    await sleep(0.5);
    expect(page.enabled).toBe(true);
  });

  test("an unconfirmed disable keeps the CDP session for the rest of the command", async () => {
    const page = new WatchPage();
    page.send = async (method: string) => {
      page.sent.push(method);
      if (method === "Network.disable") throw new BrowseError("Network.disable got no answer in 2s");
      return {};
    };
    const watch = new NetworkWatch(page.page);
    await watch.start();
    await watch.stop();
    expect(page.sessionId).toBe("S");
    expect(page.sent).toEqual(["Network.enable", "Network.disable"]);
  });

  test("a request from before the watch enabled capture is not its own", async () => {
    const page = new WatchPage();
    page.send = async (method: string) => {
      page.sent.push(method);
      if (method === "Network.enable") {
        for (const listener of [...page.state.listeners] as ((p: Page, m: string, x: Record<string, unknown>) => void)[]) {
          listener(page.page, "Network.requestWillBeSent", { requestId: "old", type: "XHR", request: { method: "POST", url: "http://x/earlier" } });
        }
      }
      return {};
    };
    const watch = new NetworkWatch(page.page);
    await watch.start();
    watch.listener(page.page, "Network.responseReceived", { requestId: "old", response: { status: 200 } });
    watch.listener(page.page, "Network.requestWillBeSent", { requestId: "new", type: "Fetch", request: { method: "PUT", url: "http://x/mine" } });
    await watch.stop();
    expect(watch.writes().map((write) => [write["method"], write["url"]])).toEqual([["PUT", "http://x/mine"]]);
  });

  test("capture already on is left on", async () => {
    const page = new WatchPage(true);
    const watch = new NetworkWatch(page.page);
    await watch.start();
    await watch.stop();
    expect(page.sent).toEqual([]);
  });

  test("settles fast when nothing happens and gives up at the bound", async () => {
    const page = new WatchPage();
    const watch = new NetworkWatch(page.page);
    await watch.start();
    let started = performance.now();
    expect(await watch.settle()).toBe(true);
    expect(performance.now() - started).toBeLessThan(300);
    watch.listener(page.page, "Network.requestWillBeSent", { requestId: "1", type: "Fetch", request: { method: "POST", url: "http://x/" } });
    started = performance.now();
    expect(await watch.settle()).toBe(false);
    expect(performance.now() - started).toBeLessThan(SETTLE_LIMIT * 1000 + 400);
    await watch.stop();
  });

  test("refused network capture still runs the action", async () => {
    const page = new WatchPage();
    page.send = async (method: string) => {
      page.sent.push(method);
      throw new Gated(method);
    };
    const watch = new NetworkWatch(page.page);
    await watch.start();
    expect(watch.watching).toBe(false);
    expect(page.state.listeners).toEqual([]);
    expect(page.sent).toEqual(["Network.enable"]);
  });
});

describe("EditingShortcuts (ardia#2812 row 20)", () => {
  test("every macOS editing shortcut carries its command", () => {
    const META = 4;
    const SHIFT = 8;
    const ALT = 1;
    expect(editingCommands(META, "a", "darwin")).toEqual(["selectAll"]);
    expect(editingCommands(META, "c", "darwin")).toEqual(["copy"]);
    expect(editingCommands(META, "x", "darwin")).toEqual(["cut"]);
    expect(editingCommands(META, "v", "darwin")).toEqual(["paste"]);
    expect(editingCommands(META, "Z", "darwin")).toEqual(["undo"]);
    expect(editingCommands(META | SHIFT, "z", "darwin")).toEqual(["redo"]);
    expect(editingCommands(META, "ArrowLeft", "darwin")).toEqual(["moveToLeftEndOfLine"]);
    expect(editingCommands(ALT | SHIFT, "ArrowRight", "darwin")).toEqual(["moveWordRightAndModifySelection"]);
    expect(editingCommands(ALT, "Backspace", "darwin")).toEqual(["deleteWordBackward"]);
    expect(editingCommands(META, "Backspace", "darwin")).toEqual(["deleteToBeginningOfLine"]);
  });

  test("0.4.0's selectAll, undo and redo go with Control or Meta on every platform; the rest of the macOS set is Meta and Alt on macOS only", () => {
    for (const platform of ["linux", "win32", "darwin"]) {
      for (const modifier of [2, 4, 4 | 1, 2 | 1]) {
        expect(editingCommands(modifier, "a", platform)).toEqual(["selectAll"]);
        expect(editingCommands(modifier, "Z", platform)).toEqual(["undo"]);
        expect(editingCommands(modifier, "y", platform)).toEqual(["redo"]);
        expect(editingCommands(modifier | 8, "z", platform)).toEqual(["redo"]);
      }
    }
    for (const platform of ["linux", "win32"]) {
      expect(editingCommands(4, "c", platform)).toBeNull();
      expect(editingCommands(4, "ArrowLeft", platform)).toBeNull();
    }
    expect(editingCommands(2, "c", "darwin")).toBeNull();
    expect(editingCommands(2, "ArrowLeft", "darwin")).toBeNull();
    expect(editingCommands(0, "a", "darwin")).toBeNull();
    expect(editingCommands(1, "a", "darwin")).toBeNull();
  });

  test("press sends the command on the key down only", async () => {
    const page = new FakeRenderer();
    await page.input.pressCombo("Meta+Shift+z", false);
    const keys = page.params.filter(([method]) => method === "Input.dispatchKeyEvent").map(([, params]) => params);
    const down = keys.find((params) => params["key"] === "z" && params["type"] === "rawKeyDown") as Record<string, unknown>;
    expect(down["commands"]).toEqual(process.platform === "darwin" ? ["redo"] : undefined);
    expect(keys.filter((params) => params["commands"]).length).toBe(process.platform === "darwin" ? 1 : 0);
  });
});

describe("ReviewFixes", () => {
  test("an interrupted tap lifts the finger with touchCancel", async () => {
    const page = new FakeRenderer({ touch: true, delays: { "Input.dispatchTouchEvent touchEnd": 5 } });
    const target = new Element("F", "S", 1, "@e1");
    const outcome = await cancelAfter(
      (signal) => withSignal(signal, () => tap(page.page, target, false)),
      () => page.sent.some(([method, kind]) => method === "Input.dispatchTouchEvent" && kind === "touchStart"),
    );
    expect(outcome).toBeInstanceOf(Cancelled);
    const touches = page.calls().filter(([method]) => method === "Input.dispatchTouchEvent").map(([, kind]) => kind);
    expect(touches).toEqual(["touchStart", "touchCancel"]);
    expect(page.input.holding).toBe(false);
  });

  test("a release that runs out of time is cancelled, so no old key up is still in flight", async () => {
    const page = new FakeRenderer({ delays: { "Input.dispatchKeyEvent keyUp": 5 } });
    const input = page.input;
    await input.gesture("keydown", () => input.pressCombo("Shift", false, true), { keepHeld: true });
    const started = performance.now();
    expect(await input.releaseAll()).toBe(false);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(input.holding).toBe(false);
    await sleep(0.5, null);
    expect(page.params.filter(([, params]) => params["type"] === "keyUp")).toEqual([]);
    expect(page.inFlight).toBe(0);
  });

  test("mouse events go through the page, one answered move at a time", async () => {
    const page = new FakeRenderer();
    let routed = 0;
    const send = page.send.bind(page);
    page.send = async (method: string, params: Record<string, unknown> | null = null) => {
      if (method === "Input.dispatchMouseEvent") routed += 1;
      return send(method, params);
    };
    (page.browser as { send: unknown }).send = async () => {
      throw new Error("a mouse event went around the page");
    };
    await page.input.pointer.move(200, 200, true);
    expect(routed).toBeGreaterThan(2);
  });

  test("nested out-of-process frames add their owners' offsets up, each measured in its parent's session", async () => {
    const page = new FakeRenderer();
    const owners: Record<string, [string, number]> = { CHILD: ["S", 11], INNER: ["S2", 12], GRAND: ["S2", 13] };
    const corners: Record<number, [number, number]> = { 11: [100, 50], 12: [7, 9], 13: [20, 30] };
    const asked: string[] = [];
    page.frames.set("CHILD", { id: "CHILD", url: "", loader: "L2", parent: "F", name: "", origin: "" });
    page.frames.set("INNER", { id: "INNER", url: "", loader: "L3", parent: "CHILD", name: "", origin: "" });
    page.frames.set("GRAND", { id: "GRAND", url: "", loader: "L4", parent: "INNER", name: "", origin: "" });
    for (const [frame, session] of [["CHILD", "S2"], ["INNER", "S2"], ["GRAND", "S3"]] as const) page.frameSessions.set(frame, session);
    page.oopifs.set("S2", { root: "CHILD", parentSession: "S" });
    page.oopifs.set("S3", { root: "GRAND", parentSession: "S2" });
    page.send = async (method: string, params: Record<string, unknown> | null = null, options: { session?: string | null } = {}) => {
      const session = options.session ?? "S";
      if (method === "DOM.getFrameOwner") {
        const [where, backend] = owners[String(params?.["frameId"])] as [string, number];
        asked.push(`${params?.["frameId"]}@${session}`);
        expect(session).toBe(where);
        return { backendNodeId: backend };
      }
      if (method === "DOM.getContentQuads") {
        const [x, y] = corners[Number(params?.["backendNodeId"])] as [number, number];
        return { quads: [[x, y, x + 50, y, x + 50, y + 40, x, y + 40]] };
      }
      return {};
    };
    expect(await frameOffset(page.page, "CHILD")).toEqual([100, 50]);
    expect(await frameOffset(page.page, "INNER")).toEqual([107, 59]);
    expect(await frameOffset(page.page, "GRAND")).toEqual([127, 89]);
    expect(await localRootOffset(page.page, "GRAND")).toEqual([127, 89]);
    expect(await localRootOffset(page.page, "INNER")).toEqual([100, 50]);
    expect(await localRootOffset(page.page, "F")).toEqual([0, 0]);
    expect(asked).toContain("GRAND@S2");
    expect(asked).toContain("INNER@S2");
    expect(asked).toContain("CHILD@S");
  });

  test("shutdown waits for a drag cleanup, but only so long", async () => {
    let finish = () => {};
    const slow = new Promise<void>((resolve) => {
      finish = resolve;
    });
    CLEANUPS.add(slow);
    try {
      expect(await drainCleanups(0.1)).toBe(false);
      setTimeout(finish, 50);
      expect(await drainCleanups(1)).toBe(true);
    } finally {
      CLEANUPS.delete(slow);
    }
    expect(await drainCleanups(0.1)).toBe(true);
  });
});
