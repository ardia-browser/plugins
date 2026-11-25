import { describe, expect, test } from "bun:test";
import "./libc-loaded.ts";
import "../src/browse/commands/all.ts";
import { cleanMetrics } from "../src/browse/answer.ts";
import { click, hover, mouseClickAt, PREPARE_ACTION, PREPARE_POSITIONED_ACTION } from "../src/browse/act/pointer.ts";
import { Ctx } from "../src/browse/commands/ctx.ts";
import { dispatch } from "../src/browse/commands/index.ts";
import { Usage } from "../src/browse/daemon-errors.ts";
import { installInput } from "../src/browse/input/input.ts";
import { begin } from "../src/browse/metrics.ts";
import { begin as beginFlowStep } from "../src/browse/flows/flowlog.ts";
import { dropRepl } from "../src/browse/script/host.ts";
import { cmdScript } from "../src/browse/script/script.ts";
import { Element, Page } from "../src/browse/state/page.ts";
import { State } from "../src/browse/state/state.ts";

installInput();

function makeMockPage(box: [number, number, number, number] = [43, 298, 803, 738]) {
  const state = new State({ session: "pos", key: "", browseFd: null, noAutoDialog: false, pinTab: false }, () => Promise.reject(new Error("unused")));
  const page = new Page(state, "T1");
  page.sessionId = "S1";
  page.url = "https://example.test/";
  page.mainFrame = "F1";
  const cdpCalls: { method: string; params: Record<string, unknown> }[] = [];
  const prepareArgs: unknown[][] = [];
  const counts = { mousedown: 0, pointerdown: 0, mouseup: 0, pointerup: 0, mousemove: 0, wheel: 0 };
  page.send = (async (method: string, params?: Record<string, unknown>) => {
    const given = params ?? {};
    cdpCalls.push({ method, params: given });
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "F1", url: "https://example.test/", loaderId: "L1" } } };
    }
    if (method === "Input.dispatchMouseEvent") {
      if (given["type"] === "mousePressed") {
        counts.mousedown += 1;
        counts.pointerdown += 1;
      } else if (given["type"] === "mouseReleased") {
        counts.mouseup += 1;
        counts.pointerup += 1;
      } else if (given["type"] === "mouseMoved") {
        counts.mousemove += 1;
      } else if (given["type"] === "mouseWheel") {
        counts.wheel += 1;
      }
    }
    return {};
  }) as Page["send"];
  page.call = (async (fn: string, args: unknown[] = []) => {
    if (fn === PREPARE_ACTION || fn === PREPARE_POSITIONED_ACTION) {
      prepareArgs.push(args);
      const fx = Number(args[1]);
      const fy = Number(args[2]);
      const offset = args[5] as [number, number] | null | undefined;
      const x = offset ? box[0] + offset[0] : box[0] + fx * (box[2] - box[0]);
      const y = offset ? box[1] + offset[1] : box[1] + fy * (box[3] - box[1]);
      return {
        connected: true,
        native: false,
        aria: false,
        shown: true,
        width: 1280,
        height: 800,
        moved: false,
        animating: false,
        box: true,
        cover: null,
        x,
        y,
        top: [x, y],
        counts: { ...counts },
      };
    }
    if (fn.includes("__ardiaInputWatch") || fn.includes("pointerdown") || fn.includes("mousemove")) {
      return { ...counts };
    }
    if (fn.includes("innerWidth")) {
      return { width: 1280, height: 800 };
    }
    return false;
  }) as Page["call"];
  page.hidden = async () => false;
  state.page = async () => page;
  state.pages.set("T1", page);
  state.current = "T1";
  state.hadTab = true;
  const element = new Element("F1", "obj-1", 42, "#floorplan");
  state.locate = async () => [page, element];
  return { state, page, element, cdpCalls, prepareArgs };
}

describe("element-relative --position and mouse click", () => {
  test("click and hover with position target box top-left plus offset and set telemetry flag", async () => {
    const { page, element, cdpCalls, prepareArgs } = makeMockPage([43, 298, 803, 738]);
    let posFlag: unknown;
    await begin({ argv: ["click"] }, async (m) => {
      await click(page, element, false, 1, "left", null, [694, 124]);
      posFlag = m.values.get("click_with_position");
    });
    expect(posFlag).toBe(true);
    expect(prepareArgs[0]?.[5]).toEqual([694, 124]);
    const pressed = cdpCalls.find((c) => c.method === "Input.dispatchMouseEvent" && c.params["type"] === "mousePressed");
    expect(pressed?.params["x"]).toBe(737);
    expect(pressed?.params["y"]).toBe(422);

    cdpCalls.length = 0;
    await hover(page, element, false, [50, 60]);
    const moved = cdpCalls.find((c) => c.method === "Input.dispatchMouseEvent" && c.params["type"] === "mouseMoved");
    expect(moved?.params["x"]).toBe(93);
    expect(moved?.params["y"]).toBe(358);

    const cleaned = cleanMetrics(new Map<string, boolean>([["click_with_position", true], ["mouse_click", true]]));
    expect(cleaned.get("click_with_position")).toBe(true);
    expect(cleaned.get("mouse_click")).toBe(true);
  });

  test("cmdClick validates --position and rejects incompatible flags; cmdMouse supports click and dblclick", async () => {
    const { state, cdpCalls } = makeMockPage([43, 298, 803, 738]);
    const ctx = new Ctx(state, { settle_only: true }, process.cwd(), {}, null, "click");
    await expect(dispatch(ctx, "click", ["#floorplan", "--position", "bad"])).rejects.toBeInstanceOf(Usage);
    await expect(dispatch(ctx, "click", ["#floorplan", "--position", "bad,10"])).rejects.toBeInstanceOf(Usage);
    await expect(dispatch(ctx, "click", ["#floorplan", "--position", "10,20", "--new-tab"])).rejects.toBeInstanceOf(Usage);
    await expect(dispatch(ctx, "click", ["#floorplan", "--position", "10,20", "--touch"])).rejects.toBeInstanceOf(Usage);
    const negRes = await dispatch(new Ctx(state, { settle_only: true }, process.cwd(), {}, null, "mouse"), "mouse", ["move", "-.5", "10"]);
    expect(negRes.data).toEqual({ moved: true });

    const res = await dispatch(ctx, "click", ["#floorplan", "--position", "694,124"]);
    expect(res.data).toMatchObject({ clicked: "#floorplan", position: [694, 124] });

    cdpCalls.length = 0;
    let mouseFlag: unknown;
    const mres = await begin({ argv: ["mouse", "click", "737", "422"] }, async (m) => {
      const r = await dispatch(new Ctx(state, { settle_only: true }, process.cwd(), {}, null, "mouse"), "mouse", ["click", "737", "422"]);
      mouseFlag = m.values.get("mouse_click");
      return r;
    });
    expect(mouseFlag).toBe(true);
    expect(mres.data).toMatchObject({ clicked: [737, 422], button: "left", count: 1 });
    const pressed = cdpCalls.find((c) => c.method === "Input.dispatchMouseEvent" && c.params["type"] === "mousePressed");
    expect(pressed?.params["x"]).toBe(737);
    expect(pressed?.params["y"]).toBe(422);

    cdpCalls.length = 0;
    const dres = await dispatch(new Ctx(state, { settle_only: true }, process.cwd(), {}, null, "mouse"), "mouse", ["dblclick", "100", "200"]);
    expect(dres.data).toMatchObject({ clicked: [100, 200], button: "left", count: 2 });
    const presses = cdpCalls.filter((c) => c.method === "Input.dispatchMouseEvent" && c.params["type"] === "mousePressed");
    expect(presses.map((p) => p.params["clickCount"])).toEqual([1, 2]);

    await expect(dispatch(new Ctx(state, { settle_only: true }, process.cwd(), {}, null, "mouse"), "mouse", ["click", "10", "20", "--count", "4"])).rejects.toBeInstanceOf(Usage);
    await expect(dispatch(new Ctx(state, { settle_only: true }, process.cwd(), {}, null, "mouse"), "mouse", ["click", "NaN", "20"])).rejects.toBeInstanceOf(Usage);
  });

  test("mouseClickAt still requires visibility when hidden and native input is unavailable", async () => {
    const { page } = makeMockPage();
    page.hidden = async () => true;
    await expect(mouseClickAt(page, 100, 100, "left", 1, false)).rejects.toMatchObject({ code: "tab_hidden" });
  });

  test("PREPARE_ACTION rounds fractional top-window offsets before hitTest, uses instant scroll to requested point, keeps offset scroll when humanized, and preserves rotation in quad fallback", async () => {
    let scrollY = 0;
    const scrollCalls: unknown[] = [];
    const hitPoints: [number, number][] = [];
    const env = {
      innerWidth: 500,
      innerHeight: 500,
      scrollBy: (arg: { left?: number; top?: number; behavior?: string }) => {
        scrollCalls.push(arg);
        scrollY += arg.top ?? 0;
      },
      top: null as unknown,
      parent: null as unknown,
    };
    env.top = env;
    env.parent = env;
    const el = {
      isConnected: true,
      matches: () => false,
      closest: () => null,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ left: 0.25, top: -scrollY, width: 400, height: 2000, right: 400.25, bottom: 2000 - scrollY }),
      getClientRects: () => [{ left: 0.25, top: -scrollY, width: 400, height: 2000 }],
      scrollIntoView: () => {},
      parentElement: null,
      parentNode: null,
      getRootNode: () => ({}),
    };
    const fn = new Function("window", "document", "innerWidth", "innerHeight", "getComputedStyle", "ardiaBrowse", `return (${PREPARE_POSITIONED_ACTION});`)(
      env,
      { visibilityState: "visible", getAnimations: () => [] },
      500,
      500,
      () => ({ overflowX: "visible", overflowY: "visible" }),
      {
        hitTest: (_el: unknown, x: number, y: number) => {
          hitPoints.push([x, y]);
          return null;
        },
      },
    ) as (el: unknown, fx: number, fy: number, scroll: boolean, watch: boolean, offset: [number, number]) => Record<string, unknown>;
    const facts = fn(el, 0.5, 0.5, true, false, [99.5, 1800]);
    expect(scrollCalls).toEqual([{ left: 0, top: 1550, behavior: "instant" }]);
    expect(scrollY).toBe(1550);
    expect(hitPoints[0]).toEqual([100, 250]);
    expect(facts["elWidth"]).toBe(400);
    expect(facts["elHeight"]).toBe(2000);

    const { page: hPage, element: hEl, prepareArgs: hArgs } = makeMockPage([0, 0, 400, 2000]);
    await click(hPage, hEl, true, 1, "left", null, [10, 1800]);
    expect(hArgs[0]?.[3]).toBe(true);

    const { page, element, cdpCalls } = makeMockPage([10, 20, 410, 220]);
    const counts = { mousedown: 0, pointerdown: 0, mouseup: 0, pointerup: 0 };
    const origSend = page.send;
    page.send = (async (method: string, params?: Record<string, unknown>) => {
      if (method === "Input.dispatchMouseEvent") {
        if (params?.["type"] === "mousePressed") { counts.mousedown += 1; counts.pointerdown += 1; }
        if (params?.["type"] === "mouseReleased") { counts.mouseup += 1; counts.pointerup += 1; }
      }
      return origSend(method, params);
    }) as Page["send"];
    page.call = (async (fnStr: string) => {
      if (fnStr === PREPARE_ACTION || fnStr === PREPARE_POSITIONED_ACTION) {
        return { connected: true, native: false, aria: false, shown: true, width: 1280, height: 800, elWidth: 100, elHeight: 200, moved: false, animating: false, box: true, cover: null, x: 120, y: 110, top: null, counts: { ...counts } };
      }
      if (fnStr.includes("__ardiaInputWatch") || fnStr.includes("pointerdown")) return { ...counts };
      return false;
    }) as Page["call"];
    await click(page, element, false, 1, "left", null, [20, 10]);
    const pressed = cdpCalls.find((c) => c.method === "Input.dispatchMouseEvent" && c.params["type"] === "mousePressed");
    expect(pressed?.params["x"]).toBe(120);
    expect(pressed?.params["y"]).toBe(110);

    let scrollerScrollY = 0;
    const scrollerCalls: unknown[] = [];
    const scrollerHits: [number, number][] = [];
    const scroller = {
      getBoundingClientRect: () => ({ left: 0, top: 100, width: 300, height: 120, right: 300, bottom: 220 }),
      offsetWidth: 300,
      offsetHeight: 120,
      clientLeft: 0,
      clientTop: 10,
      clientWidth: 300,
      clientHeight: 100,
      scrollBy: (arg: { left?: number; top?: number; behavior?: string }) => {
        scrollerCalls.push(arg);
        scrollerScrollY += arg.top ?? 0;
      },
      parentElement: null,
      parentNode: null,
    };
    const childCanvas = {
      isConnected: true,
      matches: () => false,
      closest: () => null,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 110 - scrollerScrollY, width: 200, height: 200, right: 200, bottom: 310 - scrollerScrollY }),
      getClientRects: () => [{ left: 0, top: 110 - scrollerScrollY, width: 200, height: 200 }],
      scrollIntoView: () => {},
      parentElement: scroller,
      parentNode: scroller,
      getRootNode: () => ({}),
    };
    const fn2 = new Function("window", "document", "innerWidth", "innerHeight", "getComputedStyle", "ardiaBrowse", `return (${PREPARE_POSITIONED_ACTION});`)(
      env,
      { visibilityState: "visible", getAnimations: () => [] },
      500,
      500,
      (node: unknown) => (node === scroller ? { overflowX: "auto", overflowY: "auto" } : { overflowX: "visible", overflowY: "visible" }),
      {
        hitTest: (_el: unknown, x: number, y: number) => {
          scrollerHits.push([x, y]);
          return null;
        },
      },
    ) as (el: unknown, fx: number, fy: number, scroll: boolean, watch: boolean, offset: [number, number]) => Record<string, unknown>;
    fn2(childCanvas, 0.5, 0.5, true, false, [20, 105]);
    expect(scrollerCalls).toEqual([{ left: 0, top: 55, behavior: "instant" }]);
    expect(scrollerHits[0]).toEqual([20, 160]);

    const scaledCalls: unknown[] = [];
    const scaledScroller = {
      getBoundingClientRect: () => ({ left: 0, top: 100, width: 200, height: 200, right: 200, bottom: 300 }),
      offsetWidth: 100,
      offsetHeight: 100,
      clientLeft: 0,
      clientTop: 0,
      clientWidth: 100,
      clientHeight: 100,
      scrollBy: (arg: unknown) => { scaledCalls.push(arg); },
      parentElement: null,
      parentNode: null,
    };
    const scaledCanvas = {
      isConnected: true,
      matches: () => false,
      closest: () => null,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 100, width: 200, height: 200, right: 200, bottom: 300 }),
      getClientRects: () => [{ left: 0, top: 100, width: 200, height: 200 }],
      scrollIntoView: () => {},
      parentElement: scaledScroller,
      parentNode: scaledScroller,
      getRootNode: () => ({}),
    };
    const fn3 = new Function("window", "document", "innerWidth", "innerHeight", "getComputedStyle", "ardiaBrowse", `return (${PREPARE_POSITIONED_ACTION});`)(
      env,
      { visibilityState: "visible", getAnimations: () => [] },
      500,
      500,
      (node: unknown) => (node === scaledScroller ? { overflowX: "auto", overflowY: "auto" } : { overflowX: "visible", overflowY: "visible" }),
      { hitTest: () => null },
    ) as (el: unknown, fx: number, fy: number, scroll: boolean, watch: boolean, offset: [number, number]) => Record<string, unknown>;
    fn3(scaledCanvas, 0.5, 0.5, true, false, [20, 160]);
    expect(scaledCalls).toEqual([]);

    const oopif = makeMockPage([0, 0, 100, 200]);
    oopif.page.frames.set("F_OO", { id: "F_OO", parent: "F1", loader: "L_OO", url: "https://child.test/", name: "", origin: "https://child.test" });
    oopif.page.frameSessions.set("F_OO", "S_OO");
    oopif.page.oopifs.set("S_OO", { root: "F_OO", parentSession: "S1" });
    const ooCounts = { mousedown: 0, pointerdown: 0, mouseup: 0, pointerup: 0 };
    const ooOrigSend = oopif.page.send;
    oopif.page.send = (async (method: string, params?: Record<string, unknown>, opts?: { session?: string | null }) => {
      if (method === "DOM.getFrameOwner") return { backendNodeId: 999 };
      if (method === "DOM.getBoxModel") {
        return { model: { content: [102, 102, 202, 102, 202, 302, 102, 302] } };
      }
      if (method === "DOM.getContentQuads") {
        if (opts?.session === "S_OO") return { quads: [[0, 0, 100, 0, 100, 200, 0, 200]] };
        return { quads: [[100, 100, 204, 100, 204, 304, 100, 304]] };
      }
      if (method === "Input.dispatchMouseEvent") {
        if (params?.["type"] === "mousePressed") { ooCounts.mousedown += 1; ooCounts.pointerdown += 1; }
        if (params?.["type"] === "mouseReleased") { ooCounts.mouseup += 1; ooCounts.pointerup += 1; }
      }
      return ooOrigSend(method, params);
    }) as Page["send"];
    oopif.page.call = (async (fnStr: string) => {
      if (fnStr === PREPARE_ACTION || fnStr === PREPARE_POSITIONED_ACTION) {
        return { connected: true, native: false, aria: false, shown: true, width: 100, height: 200, elWidth: 100, elHeight: 200, moved: false, animating: false, box: true, cover: null, x: 20, y: 10, top: null, counts: { ...ooCounts } };
      }
      if (fnStr === "() => [innerWidth, innerHeight]") return [100, 200];
      if (fnStr.includes("viewport")) return { width: 1280, height: 800, scrollX: 0, scrollY: 0, docWidth: 1280, docHeight: 800 };
      if (fnStr.includes("__ardiaInputWatch") || fnStr.includes("pointerdown")) return { ...ooCounts };
      return false;
    }) as Page["call"];
    const ooEl = new Element("F_OO", "obj-oo", 77, "#oo-canvas");
    await click(oopif.page, ooEl, false, 1, "left", null, [20, 10]);
    const ooPressed = oopif.cdpCalls.find((c) => c.method === "Input.dispatchMouseEvent" && c.params["type"] === "mousePressed");
    expect(ooPressed?.params["x"]).toBe(122);
    expect(ooPressed?.params["y"]).toBe(112);

    let shadowScrollY = 0;
    const shadowHits: [number, number][] = [];
    const shadowHost = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 }),
      offsetWidth: 200,
      offsetHeight: 100,
      clientLeft: 0,
      clientTop: 0,
      clientWidth: 200,
      clientHeight: 100,
      scrollBy: (arg: { top?: number }) => { shadowScrollY += arg.top ?? 0; },
      parentElement: null,
      parentNode: null,
    };
    const shadowCanvas = {
      isConnected: true,
      matches: () => false,
      closest: () => null,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ left: 0, top: -shadowScrollY, width: 200, height: 300, right: 200, bottom: 300 - shadowScrollY }),
      getClientRects: () => [{ left: 0, top: -shadowScrollY, width: 200, height: 300 }],
      scrollIntoView: () => {},
      parentElement: null,
      parentNode: { host: shadowHost },
      getRootNode: () => ({ host: shadowHost }),
    };
    const fn4 = new Function("window", "document", "innerWidth", "innerHeight", "getComputedStyle", "ardiaBrowse", `return (${PREPARE_POSITIONED_ACTION});`)(
      env,
      { visibilityState: "visible", getAnimations: () => [] },
      500,
      500,
      (node: unknown) => (node === shadowHost ? { overflowX: "auto", overflowY: "auto" } : { overflowX: "visible", overflowY: "visible" }),
      { hitTest: (_el: unknown, x: number, y: number) => { shadowHits.push([x, y]); return null; } },
    ) as (el: unknown, fx: number, fy: number, scroll: boolean, watch: boolean, offset: [number, number]) => Record<string, unknown>;
    fn4(shadowCanvas, 0.5, 0.5, true, false, [20, 150]);
    expect(shadowScrollY).toBe(100);
    expect(shadowHits[0]).toEqual([20, 50]);

    const flowCtx = new Ctx(oopif.state, {}, process.cwd(), {}, null, "click");
    const step1 = await beginFlowStep(flowCtx, "click", ["#floorplan", "--position=694,124"]);
    expect(step1?.replay).toEqual(["click", "#floorplan", "--position=694,124"]);
    const step2 = await beginFlowStep(flowCtx, "dblclick", ["#floorplan", "--position", "10,20"]);
    expect(step2?.replay).toEqual(["dblclick", "#floorplan", "--position=10,20"]);
    const step3 = await beginFlowStep(flowCtx, "hover", ["#floorplan", "--position", "5,6"]);
    expect(step3?.replay).toEqual(["hover", "#floorplan", "--position=5,6"]);
  });

  test("script --repl exposes page.mouse.* and forwards { position: { x, y } } on click, locator.click, and hover", async () => {
    const { state, cdpCalls } = makeMockPage([43, 298, 803, 738]);
    try {
      const code = `
        await page.locator('#floorplan').click({ position: { x: 694, y: 124 } });
        await page.click('#floorplan', { position: { x: 10, y: 20 } });
        await page.hover('#floorplan', { position: { x: 5, y: 6 } });
        await page.mouse.click(737, 422);
        await page.mouse.dblclick(300, 400);
        await page.mouse.move(11, 22);
        await page.mouse.wheel(15, 240);
        let badPos = false;
        try { await page.click('#floorplan', { position: { x: 'bad', y: 1 } }); } catch (e) { badPos = e instanceof TypeError; }
        ({ badPos, hasMouse: typeof page.mouse.click === 'function' })
      `;
      const ctx = new Ctx(state, {}, process.cwd(), {}, code, "script");
      const out = await cmdScript(ctx, ["--repl"]);
      expect((out.data as { value: unknown }).value).toEqual({ badPos: true, hasMouse: true });
      const presses = cdpCalls.filter((c) => c.method === "Input.dispatchMouseEvent" && c.params["type"] === "mousePressed");
      expect(presses.map((p) => [p.params["x"], p.params["y"]])).toEqual([
        [737, 422],
        [53, 318],
        [737, 422],
        [300, 400],
        [300, 400],
      ]);
      const wheel = cdpCalls.find((c) => c.method === "Input.dispatchMouseEvent" && c.params["type"] === "mouseWheel");
      expect(wheel?.params["deltaX"]).toBe(15);
      expect(wheel?.params["deltaY"]).toBe(240);
    } finally {
      dropRepl(state);
    }
  });
});
