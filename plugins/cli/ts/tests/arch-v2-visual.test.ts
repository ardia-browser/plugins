import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { navHealable, navSuccessor, noteOrigins, originOf, rebound, type NavOrigins } from "../src/browse/commands/batch.ts";
import { StaleRef, SUPERSEDED } from "../src/browse/daemon-errors.ts";
import { cmdScreenshot } from "../src/browse/media/commands.ts";
import { frameLines, frameOf, imageSize, markOf, parseRegion, parseScale } from "../src/browse/media/marks.ts";
import { LABEL } from "../src/browse/media/draw.ts";
import { decodePng, encodePng, Image } from "../src/browse/media/png.ts";
import type { Ref } from "../src/browse/state/refs.ts";
import { cleanup, rig } from "./m3/capture-helpers.ts";

afterEach(cleanup);

function png(width: number, height: number): Uint8Array {
  return encodePng(new Image(width, height, new Uint8Array(width * height * 4).fill(240)));
}

function jpegHeader(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, ...new Array(9).fill(0)];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}

type Metrics = { width: number; height: number; deviceWidth?: number; pageX?: number; pageY?: number };

function shotRig(image: Uint8Array, metrics: Metrics, ax: unknown[] = [], quads: Record<number, number[]> = {}) {
  return rig((method, params) => {
    if (method === "Page.captureScreenshot") return { data: Buffer.from(image).toString("base64") };
    if (method === "Page.getLayoutMetrics") {
      return {
        cssContentSize: { width: metrics.width, height: metrics.height * 4 },
        cssVisualViewport: { clientWidth: metrics.width, clientHeight: metrics.height, pageX: metrics.pageX ?? 0, pageY: metrics.pageY ?? 0 },
        visualViewport: { clientWidth: metrics.deviceWidth ?? metrics.width },
      };
    }
    if (method === "Accessibility.getFullAXTree") return { nodes: ax };
    if (method === "DOM.getContentQuads") {
      const quad = quads[Number(params["backendNodeId"])];
      return { quads: quad ? [quad] : [] };
    }
    return undefined;
  });
}

function captures(browser: { sent: { method: string; params: Record<string, unknown> }[] }) {
  return browser.sent.filter((entry) => entry.method === "Page.captureScreenshot").map((entry) => JSON.parse(JSON.stringify(entry.params)) as Record<string, unknown>);
}

const MUTATING = ["DOM.setAttributeValue", "DOM.setAttributesAsText", "DOM.setOuterHTML", "DOM.removeNode", "DOM.setNodeValue", "Overlay.highlightNode", "Overlay.enable", "CSS.addRule", "CSS.setStyleTexts"];

function axButton(id: string, backend: number, name: string) {
  return { nodeId: id, parentId: "1", role: { value: "button" }, name: { value: name }, childIds: [], backendDOMNodeId: backend };
}

describe("marks helpers", () => {
  test("--scale takes 0.25 to 1, as a fraction or a percent", () => {
    expect(parseScale(undefined)).toBeNull();
    expect(parseScale("0.5")).toBe(0.5);
    expect(parseScale("25%")).toBe(0.25);
    expect(parseScale("1")).toBe(1);
    for (const bad of ["0.1", "2", "x", ""]) expect(() => parseScale(bad)).toThrow("--scale takes a number from 0.25 to 1");
  });

  test("--region takes x,y,w,h with a positive size", () => {
    expect(parseRegion(undefined)).toBeNull();
    expect(parseRegion("10,20,300,200")).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    expect(parseRegion("10 20 300 200")).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    expect(() => parseRegion("1,2,3")).toThrow("--region takes x,y,w,h");
    expect(() => parseRegion("0,0,0,10")).toThrow("width and height above 0");
    expect(() => parseRegion("-5,0,10,10")).toThrow("x and y of 0 or more");
  });

  test("imageSize reads PNG and JPEG headers", () => {
    expect(imageSize(png(37, 21))).toEqual({ width: 37, height: 21 });
    expect(imageSize(jpegHeader(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  test("the frame maps image pixels back to viewport CSS pixels", () => {
    const frame = frameOf({ width: 1280, height: 800 }, { x: 100, y: 50, width: 400, height: 200 }, { width: 200, height: 100 }, 2);
    expect(frame.scale).toBe(0.5);
    expect(frameLines(frame, false)).toEqual([
      "   viewport: 1280×800, image: 200×100, scale: 0.5 (use viewport CSS coordinates for click --xy)",
      "   region: 100,50,400,200 (viewport x = 100 + image x / 0.5, y = 50 + image y / 0.5)",
    ]);
    const mark = markOf({ number: 7, ref: "e7", role: "button", name: "Apply", box: { x: 140, y: 90, width: 60, height: 20 } }, frame);
    expect(mark.center).toEqual({ x: 170, y: 100 });
    expect(mark.image).toEqual({ x: 20, y: 20, width: 30, height: 10 });
  });
});

describe("screenshot --scale / --region / --marks", () => {
  test("--scale divides by the device pixel ratio so the image is the asked fraction of the viewport", async () => {
    const { browser, ctx } = shotRig(png(400, 300), { width: 800, height: 600, deviceWidth: 1600 });
    const result = await cmdScreenshot(ctx, ["half.png", "--scale", "0.5"]);
    expect(captures(browser).at(-1)).toEqual({ format: "png", fromSurface: true, clip: { x: 0, y: 0, width: 800, height: 600, scale: 0.25 }, captureBeyondViewport: false });
    expect(result.text).toBe("✓ Screenshot saved to half.png\n   viewport: 800×600, image: 400×300, scale: 0.5 (use viewport CSS coordinates for click --xy)");
    const data = result.data as Record<string, unknown>;
    expect(data["viewport"]).toEqual({ width: 800, height: 600 });
    expect(data["image"]).toEqual({ width: 400, height: 300 });
    expect(fs.existsSync(ctx.path("half.png"))).toBe(true);
  });

  test("the reported scale is measured from the image, not assumed", async () => {
    const { ctx } = shotRig(png(800, 600), { width: 800, height: 600 });
    const result = await cmdScreenshot(ctx, ["a.png", "--scale", "0.5"]);
    expect(result.text).toContain("image: 800×600, scale: 1 ");
  });

  test("--region clips in page coordinates and states the mapping", async () => {
    const { browser, ctx } = shotRig(png(200, 100), { width: 800, height: 600, pageY: 1000 });
    const result = await cmdScreenshot(ctx, ["r.png", "--region", "100,50,200,100"]);
    expect(captures(browser).at(-1)).toEqual({ format: "png", fromSurface: true, clip: { x: 100, y: 1050, width: 200, height: 100, scale: 1 }, captureBeyondViewport: true });
    expect(result.text).toContain("   region: 100,50,200,100 (viewport x = 100 + image x / 1, y = 50 + image y / 1)");
  });

  test("--marks draws numbered badges on the PNG, returns the ref table, and never touches the DOM", async () => {
    const ax = [
      { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Shop" }, childIds: ["2", "3", "4"], backendDOMNodeId: 1 },
      axButton("2", 42, "Apply"),
      axButton("3", 43, "Reset"),
      axButton("4", 44, "Far away"),
    ];
    const quads = { 42: [100, 200, 160, 200, 160, 230, 100, 230], 43: [300, 40, 380, 40, 380, 70, 300, 70], 44: [100, 900, 160, 900, 160, 930, 100, 930] };
    const { browser, ctx } = shotRig(png(400, 300), { width: 800, height: 600, deviceWidth: 800 }, ax, quads);
    const result = await cmdScreenshot(ctx, ["m.png", "--marks", "--scale", "0.5"]);
    const data = result.data as { marks: { ref: string; name: string; center: { x: number; y: number }; image: { x: number; y: number } }[] };
    expect(data.marks.map((mark) => mark.name)).toEqual(["Apply", "Reset"]);
    expect(data.marks[0]?.center).toEqual({ x: 130, y: 215 });
    expect(data.marks[0]?.image).toMatchObject({ x: 50, y: 100 });
    const lines = (result.text ?? "").split("\n");
    expect(lines[2]).toStartWith("   marks: 2");
    expect(lines[3]).toMatch(/^ {3}\[\d+\] @e\d+ button "Apply" at 130,215 \(box 100,200 60×30\)$/u);
    const drawn = decodePng(fs.readFileSync(ctx.path("m.png")));
    const pixel = new Uint32Array(drawn.pixels.buffer, drawn.pixels.byteOffset, drawn.width * drawn.height)[100 * drawn.width + 50] as number;
    expect([pixel & 0xff, (pixel >> 8) & 0xff, (pixel >> 16) & 0xff]).toEqual([...LABEL]);
    expect(browser.sent.filter((entry) => MUTATING.includes(entry.method))).toEqual([]);
  });

  test("--marks with nothing interactive says so", async () => {
    const { ctx } = shotRig(png(80, 60), { width: 80, height: 60 });
    const result = await cmdScreenshot(ctx, ["e.png", "--marks"]);
    expect(result.text).toContain("marks: none");
    expect((result.data as { marks: unknown[] }).marks).toEqual([]);
  });

  test("conflicting flags are refused before anything is captured", async () => {
    const { browser, ctx } = shotRig(png(10, 10), { width: 10, height: 10 });
    await expect(cmdScreenshot(ctx, ["--marks", "--annotate"])).rejects.toThrow("give --marks or --annotate, not both");
    await expect(cmdScreenshot(ctx, ["--region", "0,0,5,5", "--full"])).rejects.toThrow("--region crops the viewport");
    await expect(cmdScreenshot(ctx, ["--scale", "3"])).rejects.toThrow("--scale takes a number");
    await expect(cmdScreenshot(ctx, ["--with-snapshot", "--marks"])).rejects.toThrow("takes only a path");
    await expect(cmdScreenshot(ctx, ["--marks", "--screenshot-format", "jpeg"])).rejects.toThrow("--marks draws on a PNG");
    expect(captures(browser)).toEqual([]);
  });

  test("a plain screenshot keeps its old output", async () => {
    const { browser, ctx } = shotRig(png(10, 10), { width: 10, height: 10 });
    expect((await cmdScreenshot(ctx, ["p.png"])).text).toBe("✓ Screenshot saved to p.png");
    expect(captures(browser)).toEqual([{ format: "png", fromSurface: true }]);
  });
});

function ref(id: string, extra: Partial<Ref> = {}): Ref {
  return { id, instance: "i", target: "T", frame: "MAIN", loader: "L1", generation: 1, backend: 1, role: "button", name: "Apply", unique: true, context: [], ...extra };
}

function navState(old: Ref, found: { unique: Ref | null; same: string[] }, url = "http://127.0.0.1:8821/shop?sort=price") {
  const page = { url, mainFrame: "MAIN" };
  return {
    navigatedRefs: new Map([[old.id, old]]),
    pages: new Map([["T", page]]),
    redrawnAll: async () => found,
    page,
  };
}

function superseded(id: string): StaleRef {
  return new StaleRef(id, "the page navigated since that snapshot", null, SUPERSEDED);
}

describe("batch follows a ref across a same-site reload", () => {
  test("the HC3 case: select reloads, then click @e65 finds the one Apply as @e131", async () => {
    const old = ref("e65");
    const fresh = ref("e131", { loader: "L2", backend: 9 });
    const state = navState(old, { unique: fresh, same: ["e131"] });
    const origins: NavOrigins = new Map();
    noteOrigins({ pages: new Map([["T", { url: "http://127.0.0.1:8821/shop", mainFrame: "MAIN" }]]) }, origins);
    noteOrigins(state, origins);
    const found = await navSuccessor(state, superseded("e65"), "click", origins, new Set(["e65"]));
    expect(found?.id).toBe("e131");
    expect(rebound(["click", "@e65"], "e65", "e131")).toEqual(["click", "@e131"]);
  });

  test("nothing is followed when the site changed, the name repeats, or the action is risky", async () => {
    const old = ref("e65");
    const fresh = ref("e131", { loader: "L2" });
    const live = new Set(["e65"]);
    const sameSite: NavOrigins = new Map([["T", new Set(["http://127.0.0.1:8821"])]]);
    const crossSite: NavOrigins = new Map([["T", new Set(["http://127.0.0.1:8821", "http://127.0.0.1:8822"])]]);
    expect(await navSuccessor(navState(old, { unique: fresh, same: ["e131"] }), superseded("e65"), "click", crossSite, live)).toBeNull();
    expect(await navSuccessor(navState(old, { unique: null, same: ["e131", "e140"] }), superseded("e65"), "click", sameSite, live)).toBeNull();
    expect(await navSuccessor(navState(old, { unique: fresh, same: ["e131"] }, "http://127.0.0.1:9999/"), superseded("e65"), "click", sameSite, live)).toBeNull();
    expect(await navSuccessor(navState(old, { unique: fresh, same: ["e131"] }), superseded("e65"), "click", sameSite, new Set())).toBeNull();
    expect(await navSuccessor(navState(old, { unique: fresh, same: ["e131"] }), superseded("e65"), "eval", sameSite, live)).toBeNull();
    const plainStale = new StaleRef("e65", "the element was removed from the page");
    expect(await navSuccessor(navState(old, { unique: fresh, same: ["e131"] }), plainStale, "click", sameSite, live)).toBeNull();
    const page = { url: "http://127.0.0.1:8821/x", mainFrame: "MAIN" };
    for (const name of ["Place order", "Delete account", "Pay now", "Confirm purchase", "Submit"]) {
      expect(navHealable("click", ref("e1", { name }), ref("e2", { name, loader: "L2" }), page, sameSite, new Set(["e1"]))).toBe(false);
    }
    expect(navHealable("click", old, ref("e2", { role: "link", loader: "L2" }), page, sameSite, live)).toBe(false);
    expect(navHealable("click", old, ref("e2", { frame: "CHILD", loader: "L2" }), page, sameSite, live)).toBe(false);
    expect(navHealable("click", old, ref("e2", { loader: "L2" }), page, sameSite, live)).toBe(true);
  });

  test("origins come from each page's URL, and opaque ones are skipped", () => {
    expect(originOf("https://shop.example/a?b")).toBe("https://shop.example");
    expect(originOf("about:blank")).toBe("");
    expect(originOf("data:text/html,hi")).toBe("");
    const origins: NavOrigins = new Map();
    noteOrigins({ pages: new Map([["T", { url: "about:blank", mainFrame: "MAIN" }]]) }, origins);
    expect(origins.size).toBe(0);
  });
});
