import { describe, expect, test } from "bun:test";
import { background } from "../src/browse/changes/background.ts";
import { NetworkWatch } from "../src/browse/changes/observe.ts";
import type { Page } from "../src/browse/state/page.ts";

const CASES: [string, string, boolean][] = [
  ["Fetch", "https://www.google-analytics.com/g/collect?v=2", true],
  ["Fetch", "https://shop.example/g/collect?v=2", true],
  ["Fetch", "https://shop.example/api/collections", false],
  ["XHR", "https://api.shop.example/search?q=x", false],
  ["Ping", "https://shop.example/anything", true],
  ["CSPViolationReport", "https://shop.example/csp", true],
  ["Image", "https://shop.example/a.png", true],
  ["Font", "https://fonts.example/a.woff2", true],
  ["Other", "https://shop.example/favicon.ico", true],
  ["Other", "https://shop.example/static/favicon-32x32.png?v=1", true],
  ["Script", "https://cdn.shop.example/app.js", false],
  ["Stylesheet", "https://cdn.shop.example/app.css", false],
  ["XHR", "https://beacons-wbd.mediamelon.com/MultiStreamProducer", true],
  ["Fetch", "https://api.segment.io/v1/t", true],
  ["Fetch", "https://shop.example/v1/tasks", false],
  ["Document", "https://shop.example/", false],
  ["Fetch", "https://notdoubleclick.net/x", false],
  ["Fetch", "https://ad.doubleclick.net/x", true],
  ["WebSocket", "wss://live.shop.example/socket", true],
  ["EventSource", "https://shop.example/stream", true],
];

describe("background requests", () => {
  for (const [type, url, expected] of CASES) {
    test(`${type} ${url} is ${expected ? "background" : "waited for"}`, () => {
      expect(background(type, url)).toBe(expected);
    });
  }
});

function watched(): [NetworkWatch, Page] {
  const page = { state: { listeners: [] as unknown[] }, networkOn: true, networkWatched: false } as unknown as Page;
  const watch = new NetworkWatch(page);
  return [watch, page];
}

function sent(watch: NetworkWatch, page: Page, id: string, type: string, url: string, method = "GET"): void {
  watch.listener(page, "Network.requestWillBeSent", { requestId: id, type, request: { url, method } });
}

describe("settling waits only for requests the action caused", () => {
  test("pending beacons, pixels and analytics posts don't hold it", async () => {
    const [watch, page] = watched();
    await watch.start();
    sent(watch, page, "1", "Ping", "https://shop.example/beacon", "POST");
    sent(watch, page, "2", "Image", "https://shop.example/pixel.gif");
    sent(watch, page, "3", "Fetch", "https://www.google-analytics.com/g/collect", "POST");
    expect(watch.busy()).toBe(false);
    const started = performance.now();
    expect(await watch.settle()).toBe(true);
    expect(performance.now() - started).toBeLessThan(400);
    expect(watch.writes()).toEqual([]);
    await watch.stop();
  });

  test("a pending fetch the page made holds it until it answers", async () => {
    const [watch, page] = watched();
    await watch.start();
    sent(watch, page, "1", "Ping", "https://shop.example/beacon", "POST");
    sent(watch, page, "2", "Fetch", "https://shop.example/api/save", "POST");
    expect(watch.busy()).toBe(true);
    setTimeout(() => watch.listener(page, "Network.loadingFinished", { requestId: "2" }), 200);
    const started = performance.now();
    expect(await watch.settle()).toBe(true);
    expect(performance.now() - started).toBeGreaterThan(190);
    expect(watch.writes().map((write) => write.url)).toEqual(["https://shop.example/api/save"]);
    await watch.stop();
  });

  test("background traffic doesn't restart the quiet window", async () => {
    const [watch, page] = watched();
    await watch.start();
    const timer = setInterval(() => sent(watch, page, String(Math.random()), "Ping", "https://shop.example/beacon", "POST"), 20);
    const started = performance.now();
    try {
      expect(await watch.settle()).toBe(true);
    } finally {
      clearInterval(timer);
    }
    expect(performance.now() - started).toBeLessThan(400);
    await watch.stop();
  });
});

describe("review round 1: what settling must still wait for", () => {
  test("a first-party write to a collector-looking path is waited for and listed", async () => {
    const [watch, page] = watched();
    await watch.start();
    sent(watch, page, "1", "Fetch", "https://shop.example/v1/batch", "POST");
    sent(watch, page, "2", "Fetch", "https://shop.example/api/event", "POST");
    expect(watch.busy()).toBe(true);
    expect(watch.writes().map((write) => write.url)).toEqual(["https://shop.example/v1/batch", "https://shop.example/api/event"]);
    await watch.stop();
  });

  test("a redirect from a background address to the app's own is waited for", async () => {
    const [watch, page] = watched();
    await watch.start();
    sent(watch, page, "1", "Fetch", "https://www.google-analytics.com/g/collect", "POST");
    watch.listener(page, "Network.requestWillBeSent", { requestId: "1", type: "Fetch", request: { url: "https://shop.example/api/save", method: "POST" }, redirectResponse: { status: 307 } });
    expect(watch.busy()).toBe(true);
    await watch.stop();
  });

  test("a redirect of a request that began before the watch isn't the action's", async () => {
    const [watch, page] = watched();
    await watch.start();
    watch.listener(page, "Network.requestWillBeSent", { requestId: "old", type: "XHR", request: { url: "https://shop.example/next", method: "POST" }, redirectResponse: { status: 302 } });
    expect(watch.busy()).toBe(false);
    expect(watch.writes()).toEqual([]);
    await watch.stop();
  });

  test("background traffic alone keeps the longer quiet window, so a debounced save at 80 ms is caught", async () => {
    const [watch, page] = watched();
    await watch.start();
    sent(watch, page, "1", "Image", "https://shop.example/a.png");
    watch.listener(page, "Network.loadingFinished", { requestId: "1" });
    setTimeout(() => sent(watch, page, "2", "Fetch", "https://shop.example/api/save", "POST"), 80);
    setTimeout(() => watch.listener(page, "Network.loadingFinished", { requestId: "2" }), 140);
    await watch.settle();
    expect(watch.writes().map((write) => write.url)).toEqual(["https://shop.example/api/save"]);
    await watch.stop();
  });
});
