import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { auditLines, axeSource, AXE_MISSING } from "../../src/browse/capture/audit.ts";
import { closeCaptures } from "../../src/browse/capture/close.ts";
import { cmdConsole, cmdErrors } from "../../src/browse/capture/console.ts";
import { cmdNetwork, credentialsFor, handlePaused, requestRow, statusMatches } from "../../src/browse/capture/network.ts";
import { cmdRecord, encoderArgv } from "../../src/browse/capture/record.ts";
import { captureOf } from "../../src/browse/capture/store.ts";
import { tracing, traceConfig } from "../../src/browse/capture/trace.ts";
import { Gated } from "../../src/browse/daemon-errors.ts";
import { claimKinds, cleanup, cleanups, emit, rig, scratchDir, tick } from "./capture-helpers.ts";

afterEach(cleanup);

describe("console and errors (row 8: the one path that sends Runtime.enable)", () => {
  test("console starts capture with Runtime.enable once, says so, and keeps a console lease", async () => {
    const { browser, ctx, state } = rig();
    const first = await cmdConsole(ctx, []);
    expect(first.text).toBe("Console capture started; messages from now on are kept (Runtime is on for this tab until the session ends)");
    expect(first.pageContent).toBe(true);
    expect(browser.methods().filter((method) => method === "Runtime.enable")).toHaveLength(1);
    const page = await state.page();
    emit(state, page, "Runtime.consoleAPICalled", { type: "warn", args: [{ type: "string", value: "careful" }], timestamp: 5 });
    const second = await cmdConsole(ctx, []);
    expect(second.text).toBe("[warning] careful");
    expect(browser.methods().filter((method) => method === "Runtime.enable")).toHaveLength(1);
    expect([...state.leases]).toEqual(["console"]);
    expect(state.activeLeases().size).toBe(0);
    expect((await cmdConsole(ctx, ["--clear"])).text).toBe("✓ Console cleared");
    expect((await cmdConsole(ctx, [])).text).toBe("(no console messages)");
  });

  test("errors list uncaught errors and their drop count", async () => {
    const { ctx, state } = rig();
    expect((await cmdErrors(ctx, [])).text).toBe("Error capture started; uncaught errors from now on are kept");
    const page = await state.page();
    emit(state, page, "Runtime.exceptionThrown", { timestamp: 1, exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom\n    at x" } } });
    expect((await cmdErrors(ctx, [])).text).toBe("Error: boom\n    at x");
  });

  test("a page session never gets Runtime.enable from any other D6 command", async () => {
    const { browser, ctx } = rig((method) => (method === "Network.getResponseBody" ? { body: "", base64Encoded: false } : undefined));
    await cmdNetwork(ctx, ["requests"]);
    await tracing(ctx, ["start"], "trace");
    expect(browser.methods()).not.toContain("Runtime.enable");
  });
});

describe("network", () => {
  test("status filters match Python's status_matches", () => {
    expect(statusMatches(204, "2xx")).toBe(true);
    expect(statusMatches(404, " 4XX ")).toBe(true);
    expect(statusMatches(301, "300-399")).toBe(true);
    expect(statusMatches(200, "200")).toBe(true);
    expect(statusMatches(null, "200")).toBe(false);
    expect(() => statusMatches(200, "a-b")).toThrow("invalid literal for int() with base 10: 'a'");
  });

  test("request rows keep only the fields Python keeps, in its order", () => {
    expect(Object.keys(requestRow({ status: 200, url: "u", requestId: "1", postData: "x", failed: null, method: "GET" }))).toEqual(["requestId", "url", "method", "status"]);
  });

  test("requests lists, filters and says how to see what the page loaded", async () => {
    const { ctx, state } = rig();
    const started = await cmdNetwork(ctx, ["requests"]);
    expect(started.text).toContain("run `network requests --reload` (add `--type xhr,fetch` for its data calls)");
    const page = await state.page();
    emit(state, page, "Network.requestWillBeSent", { requestId: "R1", type: "Fetch", request: { url: "http://x/data.json", method: "GET", headers: {} }, wallTime: 1 });
    emit(state, page, "Network.responseReceived", { requestId: "R1", response: { status: 200, statusText: "OK", mimeType: "application/json", headers: {} } });
    emit(state, page, "Network.requestWillBeSent", { requestId: "R2", type: "Image", request: { url: "http://x/a.png", method: "GET", headers: {} }, wallTime: 1 });
    expect((await cmdNetwork(ctx, ["requests"])).text).toBe("[R1] GET http://x/data.json (Fetch) 200\n[R2] GET http://x/a.png (Image) pending");
    expect((await cmdNetwork(ctx, ["requests", "--type", "fetch, xhr"])).text).toBe("[R1] GET http://x/data.json (Fetch) 200");
    expect((await cmdNetwork(ctx, ["requests", "--filter", "a.png"])).text).toBe("[R2] GET http://x/a.png (Image) pending");
    expect((await cmdNetwork(ctx, ["requests", "--clear"])).text).toBe("✓ Request log cleared");
    expect((await cmdNetwork(ctx, ["requests"])).text).toBe("(no requests)");
  });

  test("a refused route leaves no claim, and unroute releases it", async () => {
    const refused = rig((method) => (method === "Fetch.enable" ? new Gated("Fetch.enable") : undefined), { claims: true });
    await expect(cmdNetwork(refused.ctx, ["route", "*", "--abort"])).rejects.toBeInstanceOf(Gated);
    expect(claimKinds(refused.root as string).has("route")).toBe(false);
    const allowed = rig(() => undefined, { claims: true });
    await cmdNetwork(allowed.ctx, ["route", "*", "--abort"]);
    expect(claimKinds(allowed.root as string).has("route")).toBe(true);
    expect([...allowed.state.leases]).toContain("route");
    expect((await cmdNetwork(allowed.ctx, ["unroute"])).text).toBe("✓ Done");
    expect(claimKinds(allowed.root as string).has("route")).toBe(false);
    expect(allowed.browser.methods()).toContain("Fetch.disable");
  });

  test("routes answer paused requests newest first, by type and glob", async () => {
    const { browser, ctx, state } = rig();
    await cmdNetwork(ctx, ["route", "**/api/*", "--body", ' {"ok": true}', "--status", "201"]);
    await cmdNetwork(ctx, ["route", "**.png", "--abort", "--resource-type", "image"]);
    const page = await state.page();
    await handlePaused(ctx, page, { requestId: "A", resourceType: "Image", request: { url: "http://x/a.png" } });
    await handlePaused(ctx, page, { requestId: "B", resourceType: "Fetch", request: { url: "http://x/api/list" } });
    await handlePaused(ctx, page, { requestId: "C", resourceType: "Document", request: { url: "http://x/" } });
    const answered = browser.sent.filter((entry) => entry.method.startsWith("Fetch.") && entry.method !== "Fetch.enable");
    expect(answered.map((entry) => entry.method)).toEqual(["Fetch.failRequest", "Fetch.fulfillRequest", "Fetch.continueRequest"]);
    const fulfilled = answered[1]?.params as Record<string, unknown>;
    expect(fulfilled["responseCode"]).toBe(201);
    expect(fulfilled["responseHeaders"]).toEqual([
      { name: "Content-Type", value: "application/json" },
      { name: "Access-Control-Allow-Origin", value: "*" },
    ]);
    expect(Buffer.from(String(fulfilled["body"]), "base64").toString()).toBe(' {"ok": true}');
  });

  test("credentials stay with the tab's own page at the first asking origin", () => {
    const { ctx, state } = rig();
    state.credentials = { username: "u", password: "p", origin: null };
    const page = { targetId: "T" } as never;
    const challenge = (origin: string, frame = "T", kind = "Document", source = "Server") => ({
      requestId: "r",
      frameId: frame,
      resourceType: kind,
      authChallenge: { source, origin, scheme: "basic" },
    });
    const given = [
      challenge("https://ads.example", "child"),
      challenge("https://site.example"),
      challenge("https://site.example", "T", "XHR"),
      challenge("https://other.example"),
      challenge("https://site.example", "T", "Document", "Proxy"),
      challenge("https://site.example"),
    ].map((params) => credentialsFor(ctx, page, params) !== null);
    expect(given).toEqual([false, true, false, false, false, true]);
  });

  test("HAR stop writes Python's JSON for the requests since start", async () => {
    const { ctx, state } = rig((method) => (method === "Network.getResponseBody" ? { body: "[1, 2]", base64Encoded: false } : undefined));
    const page = await state.page();
    page.networkOn = true;
    emit(state, page, "Network.requestWillBeSent", { requestId: "OLD", type: "Document", request: { url: "http://x/", method: "GET", headers: {} }, wallTime: 1 });
    expect((await cmdNetwork(ctx, ["har", "start"])).text).toBe("✓ HAR recording started");
    emit(state, page, "Network.requestWillBeSent", {
      requestId: "R",
      type: "Fetch",
      request: { url: "http://x/d.json", method: "POST", headers: { "Content-Type": "text/plain" }, postData: "hé" },
      wallTime: 1700000000.25,
      timestamp: 10,
    });
    emit(state, page, "Network.responseReceived", { requestId: "R", response: { status: 200, statusText: "OK", mimeType: "application/json", headers: { location: "/n" }, protocol: "h2" } });
    emit(state, page, "Network.loadingFinished", { requestId: "R", timestamp: 10.5, encodedDataLength: 6 });
    const out = path.join(ctx.cwd, "x.har");
    const result = await cmdNetwork(ctx, ["har", "stop", "x.har"]);
    expect(result.text).toBe("✓ HAR saved to x.har (1 entries)");
    const text = fs.readFileSync(out, "utf8");
    expect(text.startsWith('{"log": {"version": "1.2", "creator": {"name": "ardia browse", "version": "1"}, "pages": [], "entries": [{"startedDateTime": "2023-11-14T22:13:20.250Z", "time": 500.0, ')).toBe(true);
    expect(text).toContain('"bodySize": 2, "postData": {"mimeType": "text/plain", "text": "hé"}}');
    expect(text).toContain('"content": {"size": 6, "mimeType": "application/json", "text": "[1, 2]"}, "redirectURL": "/n", "headersSize": -1, "bodySize": 6}');
    expect(text.endsWith('"cache": {}, "timings": {"send": 0, "wait": 0, "receive": 0}, "_resourceType": "Fetch"}]}}')).toBe(true);
    await expect(cmdNetwork(ctx, ["har", "stop"])).rejects.toThrow("No HAR recording is running");
  });
});

describe("trace", () => {
  test("categories split into included and excluded like Python", () => {
    expect(traceConfig(["-*", "a", "-b"])).toEqual({ includedCategories: ["a"], excludedCategories: ["b"] });
  });

  test("stop waits for tracingComplete and writes ASCII-escaped spaced JSON", async () => {
    const { ctx, state } = rig();
    expect((await tracing(ctx, ["start", "--categories", "-*,x"], "profiler")).text).toBe("✓ Profiling started");
    const page = await state.page();
    emit(state, page, "Tracing.dataCollected", { value: [{ name: "é", ts: 1 }] });
    const stopping = tracing(ctx, ["stop", "t.json"], "profiler");
    await tick(5);
    emit(state, page, "Tracing.tracingComplete", {});
    expect((await stopping).text).toBe("✓ Profile saved to t.json (1 events)");
    expect(fs.readFileSync(path.join(ctx.cwd, "t.json"), "utf8")).toBe('{"traceEvents": [{"name": "\\u00e9", "ts": 1}]}');
    expect(state.leases.has("trace")).toBe(false);
    expect(state.listeners).toHaveLength(0);
  });
});

describe("record through a PATH stub (no real encode)", () => {
  function stub(exit: number, stderr = ""): string {
    const dir = scratchDir("ardia-d6-bin-");
    const script = `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat > "${dir}/frames"\nprintf '${stderr}' >&2\nexit ${exit}\n`;
    fs.writeFileSync(path.join(dir, "ffmpeg"), script, { mode: 0o755 });
    const saved = process.env["PATH"];
    process.env["PATH"] = `${dir}:/usr/bin:/bin`;
    cleanups.push(() => {
      process.env["PATH"] = saved;
    });
    return dir;
  }

  function visible(method: string, params: Record<string, unknown>) {
    if (method === "Runtime.callFunctionOn" && String(params["functionDeclaration"]).includes("visibilityState")) return { result: { type: "boolean", value: false } };
    return undefined;
  }

  test("start spawns ffmpeg with Python's argv and stop hands it the frames", async () => {
    const dir = stub(0);
    const { browser, ctx, state } = rig(visible);
    expect((await cmdRecord(ctx, ["start", "out.webm"])).text).toBe("✓ Recording started (out.webm)");
    const page = await state.page();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    emit(state, page, "Page.screencastFrame", { data: jpeg.toString("base64"), metadata: {}, sessionId: 3 });
    await tick(120);
    expect((await cmdRecord(ctx, ["stop"])).text).toBe("✓ Recording saved to out.webm");
    const argv = fs.readFileSync(path.join(dir, "argv"), "utf8").trimEnd().split("\n");
    expect(argv).toEqual(encoderArgv("ffmpeg", ctx.path("out.webm")).slice(1));
    expect(fs.readFileSync(path.join(dir, "frames")).subarray(0, 4)).toEqual(jpeg);
    expect(browser.methods()).toContain("Page.screencastFrameAck");
    expect(browser.methods()).toContain("Page.stopScreencast");
    expect(state.leases.has("record")).toBe(false);
  });

  test("an encoder that fails says what ffmpeg said", async () => {
    stub(1, "bad codec");
    const { ctx } = rig(visible);
    await cmdRecord(ctx, ["start", "out.webm"]);
    await expect(cmdRecord(ctx, ["stop"])).rejects.toThrow("ffmpeg failed: bad codec");
  });

  test("no ffmpeg on PATH is refused before anything starts", async () => {
    const saved = process.env["PATH"];
    process.env["PATH"] = scratchDir();
    cleanups.push(() => {
      process.env["PATH"] = saved;
    });
    const { browser, ctx } = rig(visible);
    await expect(cmdRecord(ctx, ["start", "out.webm"])).rejects.toThrow("record needs ffmpeg on PATH to encode WebM (brew install ffmpeg)");
    expect(browser.methods()).not.toContain("Page.startScreencast");
  });

  test("closing the daemon stops a running recording", async () => {
    stub(0);
    const { ctx, state } = rig(visible);
    await cmdRecord(ctx, ["start", "out.webm"]);
    await closeCaptures(state);
    expect(captureOf(state).recording).toBeNull();
  });
});

describe("a11y", () => {
  test("a missing axe-core gives Python's message", () => {
    expect(() => axeSource([path.join(scratchDir(), "nope.js")])).toThrow(AXE_MISSING);
  });

  test("lines match Python's, with list targets printed as Python lists", () => {
    const data = {
      counts: { violations: 1, incomplete: 0, passes: 3 },
      violations: [{ id: "x", impact: null, help: "Help", helpUrl: "http://h", nodeCount: 1, nodes: [{ target: ["#a", ["#host", "b"]] }] }],
      incomplete: [],
    };
    expect(auditLines(data)).toEqual(["violations: 1  incomplete: 0  passes: 3", "Violations:", "  [n/a] x: Help (1 node)", "    http://h", "    - #a > ['#host', 'b']"]);
  });
});
