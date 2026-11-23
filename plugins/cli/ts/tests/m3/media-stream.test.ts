import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { closeCaptures } from "../../src/browse/capture/close.ts";
import { Screencast } from "../../src/browse/capture/screencast.ts";
import { bindCommandLock, captureOf } from "../../src/browse/capture/store.ts";
import { cmdStream, startStreamServer, STREAM_INPUT_BACKLOG, type Stream, streamInput } from "../../src/browse/capture/stream.ts";
import { FifoLock } from "../../src/browse/daemon/lock.ts";
import { Float } from "../../src/json.ts";
import { cmdHighlight, cmdPdf, cmdScreenshot, comparison, comparisonText, diffScreenshot, inImage, unchanged } from "../../src/browse/media/commands.ts";
import { encodePng, Image } from "../../src/browse/media/png.ts";
import { cleanup, cleanups, emit, rig, tick } from "./capture-helpers.ts";

afterEach(cleanup);

function png(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([...rgb, 255], i);
  return encodePng(new Image(width, height, pixels));
}

const visibleScript = (method: string, params: Record<string, unknown>) =>
  method === "Runtime.callFunctionOn" && String(params["functionDeclaration"]).includes("visibilityState") ? { result: { type: "boolean", value: false } } : undefined;

function fakeStream(input = false): Stream {
  const cast = { latest: null, seq: 0, watchers: new Set() } as unknown as Screencast;
  return { cast, clients: new Set(), input, token: "tok", page: null as never, server: null, port: 0, url: "", watcher: () => {} };
}

async function connect(port: number, headers: Record<string, string> = {}, token = "tok"): Promise<{ status: number | "open"; socket?: WebSocket; first?: string }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`, { headers } as never);
    socket.addEventListener("message", (event) => resolve({ status: "open", socket, first: String(event.data) }), { once: true });
    socket.addEventListener("error", () => resolve({ status: 0 }), { once: true });
  });
}

async function refusal(port: number, headers: Record<string, string>, token = "tok"): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/?token=${token}`, { headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers } });
  return response.status;
}

describe("stream server", () => {
  test("a null or foreign origin, a wrong host or token, and a fifth viewer are refused", async () => {
    const stream = fakeStream();
    const { ctx } = rig();
    const server = startStreamServer(ctx, stream, 0);
    cleanups.push(() => server.stop(true));
    const port = server.port as number;
    expect(await refusal(port, { Origin: "null" })).toBe(403);
    expect(await refusal(port, { Origin: "http://evil.example" })).toBe(403);
    expect(await refusal(port, { Host: `example.com:${port}` })).toBe(403);
    expect(await refusal(port, {}, "nope")).toBe(401);
    expect(await refusal(port, {}, "")).toBe(401);
    const open = [];
    for (let i = 0; i < 4; i += 1) open.push(await connect(port));
    expect(open.map((viewer) => viewer.status)).toEqual(["open", "open", "open", "open"]);
    expect(open[0]?.first).toBe('{"type": "status", "connected": true, "screencasting": true, "input": false}');
    expect(await refusal(port, {})).toBe(503);
    for (const viewer of open) viewer.socket?.close();
  });

  test("closed viewers give back their slots", async () => {
    const stream = fakeStream();
    const { ctx } = rig();
    const server = startStreamServer(ctx, stream, 0);
    cleanups.push(() => server.stop(true));
    const outcomes = [];
    for (let i = 0; i < 6; i += 1) {
      const viewer = await connect(server.port as number);
      outcomes.push(viewer.status);
      viewer.socket?.close();
      for (let wait = 0; wait < 50 && stream.clients.size > 0; wait += 1) await tick(10);
    }
    expect(outcomes).toEqual(Array(6).fill("open"));
    expect(stream.clients.size).toBe(0);
  });

  test("enable streams screencast frames, status reports them, input is refused when view only, disable ends it all", async () => {
    const { browser, ctx, state } = rig((method, params) =>
      method === "Runtime.callFunctionOn" && String(params["functionDeclaration"]).includes("visibilityState") ? { result: { type: "boolean", value: false } } : undefined,
    );
    const enabled = await cmdStream(ctx, ["enable"]);
    const stream = captureOf(state).stream as Stream;
    expect(enabled.text).toBe(`✓ Streaming on ws://127.0.0.1:${stream.port}/?token=${stream.token} (view only)`);
    expect(stream.token).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(browser.sent.find((entry) => entry.method === "Page.startScreencast")?.params).toEqual({ format: "jpeg", quality: 80, everyNthFrame: 1 });
    const viewer = await connect(stream.port, {}, stream.token);
    const frames: string[] = [];
    viewer.socket?.addEventListener("message", (event) => frames.push(String(event.data)));
    const page = await state.page();
    emit(state, page, "Page.screencastFrame", { data: "AAAA", metadata: { offsetTop: 0, pageScaleFactor: 1.5 }, sessionId: 9 });
    for (let wait = 0; wait < 100 && frames.length === 0; wait += 1) await tick(10);
    expect(frames[0]).toBe('{"type": "frame", "seq": 1, "data": "AAAA", "metadata": {"offsetTop": 0, "pageScaleFactor": 1.5}}');
    viewer.socket?.send(JSON.stringify({ type: "input_mouse", eventType: "mousePressed", x: 1, y: 2 }));
    for (let wait = 0; wait < 100 && frames.length < 2; wait += 1) await tick(10);
    expect(frames[1]).toBe('{"type": "error", "error": "this stream is view only; restart it with `stream enable --input`"}');
    const status = await cmdStream(ctx, ["status"]);
    expect(status.text).toBe(`Streaming enabled on ${stream.url}\nConnected: true\nScreencasting: true\nInput: off (view only)`);
    await expect(cmdStream(ctx, ["enable"])).rejects.toThrow(`Streaming is already on at ${stream.url}`);
    expect((await cmdStream(ctx, ["disable"])).text).toBe("✓ Streaming disabled");
    expect((await cmdStream(ctx, ["status"])).text).toBe("Streaming disabled");
    expect(browser.methods()).toContain("Page.stopScreencast");
    expect(state.leases.has("stream")).toBe(false);
    await expect(cmdStream(ctx, ["sideways"])).rejects.toThrow("Usage: ardia browse stream enable [--port N] [--input] | disable | status");
  });

  test("input waits for the command lock, is tracked, and a failed send releases what is held", async () => {
    const { browser, ctx, state } = rig((method) => (method === "Input.dispatchMouseEvent" ? new Error("unexpected") : undefined));
    const lock = new FifoLock();
    bindCommandLock(state, lock);
    const page = await state.page();
    const tracked: string[] = [];
    let released = 0;
    Object.assign(page, {
      input: { holding: true, trackStreamEvent: (method: string, params: Record<string, unknown>) => tracked.push(`${method}:${params["type"]}`), releaseAll: async () => ((released += 1), true), bind() {} },
    });
    await lock.acquire();
    const pending = streamInput(ctx, page, { type: "input_keyboard", eventType: "keyDown", key: "Shift", code: "ShiftLeft", extra: 1 });
    await tick(5);
    expect(tracked).toEqual([]);
    lock.release();
    await pending;
    expect(tracked).toEqual(["Input.dispatchKeyEvent:keyDown"]);
    expect(browser.sent.find((entry) => entry.method === "Input.dispatchKeyEvent")?.params).toEqual({ key: "Shift", code: "ShiftLeft", type: "keyDown" });
    expect(lock.locked).toBe(false);
    await streamInput(ctx, page, { type: "input_wheel" });
    expect(released).toBe(0);
  });

  test("stream disable under the command lock returns while a viewer's input waits for that lock, and later commands run", async () => {
    const { browser, ctx, state } = rig(visibleScript);
    const lock = new FifoLock();
    bindCommandLock(state, lock);
    await cmdStream(ctx, ["enable", "--input"]);
    const stream = captureOf(state).stream as Stream;
    const viewer = await connect(stream.port, {}, stream.token);
    await lock.acquire();
    viewer.socket?.send(JSON.stringify({ type: "input_mouse", eventType: "mouseMoved", x: 1, y: 2 }));
    await tick(50);
    const disabled = await Promise.race([cmdStream(ctx, ["disable"]).then((result) => result.text), tick(3000).then(() => "deadlocked")]);
    expect(disabled).toBe("✓ Streaming disabled");
    lock.release();
    expect(await lock.acquire(2)).toBe(true);
    lock.release();
    await tick(50);
    expect(browser.methods()).not.toContain("Input.dispatchMouseEvent");
  });

  test("a viewer's queued input is bounded: moves past the backlog are dropped, other input closes it with 1008", async () => {
    const { browser, ctx, state } = rig(visibleScript);
    const lock = new FifoLock();
    bindCommandLock(state, lock);
    await cmdStream(ctx, ["enable", "--input"]);
    const stream = captureOf(state).stream as Stream;
    const viewer = await connect(stream.port, {}, stream.token);
    const seen: { code: number | null } = { code: null };
    viewer.socket?.addEventListener("close", (event) => (seen.code = event.code));
    await lock.acquire();
    for (let i = 0; i < 500; i += 1) viewer.socket?.send(JSON.stringify({ type: "input_mouse", eventType: "mouseMoved", x: i, y: 1 }));
    await tick(100);
    expect(seen.code).toBeNull();
    expect([...stream.clients][0]?.data.backlog).toBe(STREAM_INPUT_BACKLOG + 1);
    viewer.socket?.send(JSON.stringify({ type: "input_mouse", eventType: "mousePressed", x: 1, y: 1, button: "left", clickCount: 1 }));
    for (let wait = 0; wait < 100 && seen.code === null; wait += 1) await tick(10);
    expect(seen.code).toBe(1008);
    lock.release();
    await tick(100);
    expect(browser.methods().filter((method) => method === "Input.dispatchMouseEvent").length).toBeLessThanOrEqual(1);
    await cmdStream(ctx, ["disable"]);
  });

  test("closing the daemon stops the stream", async () => {
    const { ctx, state } = rig((method, params) =>
      method === "Runtime.callFunctionOn" && String(params["functionDeclaration"]).includes("visibilityState") ? { result: { type: "boolean", value: false } } : undefined,
    );
    await cmdStream(ctx, ["enable"]);
    await closeCaptures(state);
    expect(captureOf(state).stream).toBeNull();
  });
});

describe("screenshot, pdf, diff, highlight", () => {
  const red = png(4, 3, [255, 0, 0]);
  const blue = png(4, 3, [0, 0, 255]);

  test("annotate keeps only boxes inside the image", () => {
    const region = [0, 0, 1280, 577] as const;
    expect(inImage({ x: 8, y: 21, width: 100, height: 37 }, region)).toBe(true);
    expect(inImage({ x: 8, y: 570, width: 100, height: 20 }, region)).toBe(true);
    expect(inImage({ x: 8, y: 10317, width: 58, height: 21 }, region)).toBe(false);
    expect(inImage({ x: 8, y: -1979, width: 58, height: 21 }, region)).toBe(false);
    expect(inImage({ x: 8, y: 40, width: 0, height: 0 }, region)).toBe(false);
  });

  test("unchanged compares bytes, then pixels only for PNG with a positive threshold", () => {
    expect(unchanged(red, red, "jpeg", 0)).toBe(true);
    expect(unchanged(red, blue, "png", 0.5)).toBe(false);
    expect(unchanged(red, blue, "png", 100)).toBe(true);
    expect(unchanged(red, blue, "jpeg", 100)).toBe(false);
  });

  test("comparison text prints the percent as Python's float", () => {
    const result = comparison(red, blue, 0.1, null);
    expect(result["diffPercent"]).toEqual(new Float(100));
    expect(comparisonText({ ...result, diffPath: "/d.png" })).toBe("✗ 12 of 12 pixels differ (100.0%)\n  diff image: /d.png");
    expect(comparisonText(comparison(red, png(2, 2, [0, 0, 0]), 0.1, null))).toBe("✗ Screenshots differ: size differs: 4x3 vs 2x2");
    expect(comparisonText(comparison(red, red, 0.1, null))).toBe("✓ Screenshots match");
  });

  test("screenshot saves, then --if-changed skips the same view and saves a changed one", async () => {
    let shot = red;
    const { browser, ctx } = rig((method) => (method === "Page.captureScreenshot" ? { data: Buffer.from(shot).toString("base64") } : undefined));
    expect((await cmdScreenshot(ctx, ["a.png", "--if-changed"])).text).toBe("✓ Screenshot saved to a.png");
    expect(fs.readFileSync(ctx.path("a.png"))).toEqual(Buffer.from(red));
    const same = await cmdScreenshot(ctx, ["b.png", "--if-changed"]);
    expect(same.text).toBe("= Unchanged since the last screenshot of this view, so nothing was saved");
    expect(fs.existsSync(ctx.path("b.png"))).toBe(false);
    shot = blue;
    expect((await cmdScreenshot(ctx, ["c.png", "--if-changed"])).text).toBe("✓ Screenshot saved to c.png");
    expect(browser.sent.filter((entry) => entry.method === "Page.captureScreenshot").map((entry) => entry.params)).toEqual(Array(3).fill({ format: "png", fromSurface: true }));
    await expect(cmdScreenshot(ctx, ["--screenshot-format", "gif"])).rejects.toThrow("--screenshot-format takes png or jpeg");
    await expect(cmdScreenshot(ctx, ["--annotate", "--screenshot-format", "jpg"])).rejects.toThrow("--annotate draws on a PNG; drop --screenshot-format jpeg");
  });

  test("screenshot with no path goes to the screenshot folder, full page clips to the content size", async () => {
    const { browser, ctx } = rig((method) => {
      if (method === "Page.captureScreenshot") return { data: Buffer.from(red).toString("base64") };
      if (method === "Page.getLayoutMetrics") return { cssContentSize: { width: 800, height: 2400 }, cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
      return undefined;
    }, { env: { AGENT_BROWSER_SCREENSHOT_FORMAT: "JPG", AGENT_BROWSER_SCREENSHOT_QUALITY: "40" } });
    const saved = await cmdScreenshot(ctx, ["--full", "--screenshot-dir", "shots"]);
    expect(saved.text).toMatch(/^✓ Screenshot saved to .*\/shots\/screenshot-\d+\.jpg$/u);
    expect((fs.statSync(ctx.path("shots")).mode & 0o777).toString(8)).toBe("700");
    expect(browser.sent.filter((entry) => entry.method === "Page.captureScreenshot").at(-1)?.params).toEqual({
      format: "jpeg",
      fromSurface: true,
      quality: 40,
      clip: { x: 0, y: 0, width: 800, height: 2400, scale: 1 },
      captureBeyondViewport: true,
    });
  });

  test("pdf prints with backgrounds and writes the file", async () => {
    const { browser, ctx } = rig((method) => (method === "Page.printToPDF" ? { data: Buffer.from("%PDF-1.4").toString("base64") } : undefined));
    expect((await cmdPdf(ctx, ["out/page.pdf", "--landscape"])).text).toBe("✓ PDF saved to out/page.pdf");
    expect(fs.readFileSync(ctx.path("out/page.pdf"), "utf8")).toBe("%PDF-1.4");
    expect(browser.sent.find((entry) => entry.method === "Page.printToPDF")?.params).toEqual({ printBackground: true, landscape: true });
    await expect(cmdPdf(ctx, [])).rejects.toThrow("Usage: ardia browse pdf <path>");
  });

  test("diff screenshot compares with the baseline and writes the diff image", async () => {
    const { ctx } = rig((method) => (method === "Page.captureScreenshot" ? { data: Buffer.from(blue).toString("base64") } : undefined));
    fs.writeFileSync(ctx.path("base.png"), red);
    const result = await diffScreenshot(ctx, ["-b", "base.png", "-o", "d.png"]);
    expect(result.text).toBe(`✗ 12 of 12 pixels differ (100.0%)\n  diff image: ${ctx.path("d.png")}`);
    expect(fs.existsSync(ctx.path("d.png"))).toBe(true);
    await expect(diffScreenshot(ctx, ["--baseline", "missing.png"])).rejects.toThrow(`[Errno 2] No such file or directory: '${ctx.path("missing.png")}'`);
    await expect(diffScreenshot(ctx, [])).rejects.toThrow("Usage: ardia browse diff screenshot --baseline <file> [--output <file>] [--threshold 0.1]");
    await expect(diffScreenshot(ctx, ["-b", "base.png", "-t", "x"])).rejects.toThrow("could not convert string to float: 'x'");
  });

  test("highlight sends the overlay with Python's colours", async () => {
    const { browser, ctx } = rig((method) => {
      if (method === "Runtime.callFunctionOn") return { result: { type: "object", objectId: "EL" } };
      if (method === "DOM.describeNode") return { node: { backendNodeId: 42 } };
      return undefined;
    });
    expect((await cmdHighlight(ctx, ["#x"])).text).toBe("✓ Done");
    expect(browser.methods().slice(-3)).toEqual(["DOM.enable", "Overlay.enable", "Overlay.highlightNode"]);
    expect(browser.sent.at(-1)?.params).toEqual({
      backendNodeId: 42,
      highlightConfig: { contentColor: { r: 111, g: 168, b: 220, a: 0.66 }, borderColor: { r: 255, g: 0, b: 0, a: 1 }, showInfo: true },
    });
  });

  test("the diff folder name swaps every screenshot- like Python's str.replace", () => {
    expect(path.join("/t/screenshot-dir", "screenshot-1.png").replaceAll("screenshot-", "diff-")).toBe("/t/diff-dir/diff-1.png");
  });
});
