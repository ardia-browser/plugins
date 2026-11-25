import { describe, expect, test } from "bun:test";
import "./libc-loaded.ts";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { cleanMetrics as cleanBrowseMetrics } from "../src/browse/answer.ts";
import { cmdConsole } from "../src/browse/capture/console.ts";
import { cmdNetwork } from "../src/browse/capture/network.ts";
import { closedMenu } from "../src/browse/act/pointer.ts";
import { Ctx } from "../src/browse/commands/ctx.ts";
import { SOCKET_FILE } from "../src/browse/daemon/announce.ts";
import { BrowseError, OutcomeUnknown } from "../src/browse/daemon-errors.ts";
import { Input, installInput } from "../src/browse/input/input.ts";
import { begin } from "../src/browse/metrics.ts";
import { Page } from "../src/browse/state/page.ts";
import { State } from "../src/browse/state/state.ts";
import { nativeKey, nativeMouseClick, nativeText, nativeWheel, tabCapabilities } from "../src/browse/state/tabtools.ts";

installInput();

type SocketCall = { method: string; params: Record<string, unknown> };
type SocketHandler = (method: string, params: Record<string, unknown>) => { result?: unknown; error?: { code: string; message: string } };

async function startControlSocket(handler: SocketHandler): Promise<{ dir: string; socketPath: string; calls: SocketCall[]; close: () => Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-tt-"));
  const socketPath = path.join(dir, SOCKET_FILE);
  const calls: SocketCall[] = [];
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> };
        if (msg.method === "hello") {
          conn.write(`${JSON.stringify({ id: msg.id, result: { app: "Ardia", version: "0.2.50", protocol: 4, minClientProtocol: 4 } })}\n`);
          continue;
        }
        calls.push({ method: msg.method, params: msg.params ?? {} });
        const reply = handler(msg.method, msg.params ?? {});
        conn.write(`${JSON.stringify({ id: msg.id, ...reply })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    dir,
    socketPath,
    calls,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeFakePage(dir: string | null, opts: { hidden?: boolean } = {}) {
  const state = new State({ session: "tt", key: "", browseFd: null, noAutoDialog: false, pinTab: false, dataDir: dir }, () => Promise.reject(new Error("unused")));
  if (dir !== null) {
    state.endpoint = { ws: "ws://127.0.0.1:9222/devtools/browser/1", source: "--port 9222", explicit: true, active: null, instance: "127.0.0.1:9222/devtools/browser/1" };
    state.appTabs.set("T1", "tab-1");
    state.targetInfos.set("T1", { targetId: "T1", type: "page", url: "https://example.test/", title: "Example" });
  }
  const page = new Page(state, "T1");
  page.sessionId = "S1";
  page.url = "https://example.test/";
  page.mainFrame = "F1";
  const cdpCalls: { method: string; params: unknown }[] = [];
  page.send = (async (method: string, params?: unknown) => {
    cdpCalls.push({ method, params });
    return {};
  }) as Page["send"];
  page.call = (async () => 1) as Page["call"];
  page.hidden = async () => opts.hidden === true;
  state.page = async () => page;
  state.pages.set("T1", page);
  state.current = "T1";
  state.hadTab = true;
  return { state, page, cdpCalls };
}

describe("tabs.diagnostics CLI integration", () => {
  test("console and network requests page through more:true, preserve durationMs/cached, stay cleared after runtimeOn, and pass daemon telemetry allowlist", async () => {
    const sock = await startControlSocket((method, params) => {
      if (method === "methods") return { result: [{ name: "tabs.diagnostics" }, { name: "tabs.input" }] };
      if (method === "tabs.diagnostics") {
        const since = typeof params["since"] === "number" ? params["since"] : 0;
        const kind = params["kind"];
        if (kind === "console") {
          if (since <= 1) {
            return {
              result: {
                tab: "tab-1",
                nextSeq: 2,
                console: [{ seq: 1, time: 1000, level: "log", kind: "console", message: "booted", source: "app.js", line: 10, frame: "F1" }],
                network: [],
                dropped: 1,
                more: true,
              },
            };
          }
          if (since === 2) {
            return {
              result: {
                tab: "tab-1",
                nextSeq: 5,
                console: [{ seq: 2, time: 1001, level: "error", kind: "exception", message: "TypeError: boom", source: "app.js", line: 42, frame: "F1" }],
                network: [],
                dropped: 0,
                more: false,
              },
            };
          }
          return { result: { tab: "tab-1", nextSeq: 5, console: [], network: [], dropped: 0, more: false } };
        }
        const networkRows = [
          { seq: 3, time: 1002, method: "GET", url: "https://example.test/api/items", status: 200, type: "fetch", frame: "F1", durationMs: 14, failed: false, cached: true },
          { seq: 4, time: 1003, method: "POST", url: "https://example.test/api/save", status: 500, type: "fetch", frame: "F1", durationMs: 22, failed: true },
        ].filter((row) => row.seq >= since);
        return { result: { tab: "tab-1", nextSeq: 5, console: [], network: networkRows, dropped: 0, more: false } };
      }
      return { error: { code: "unknown_method", message: "unknown" } };
    });
    try {
      const { state, page, cdpCalls } = makeFakePage(sock.dir);
      const ctx = new Ctx(state, {}, process.cwd(), {}, null, "console");
      let usedFlag: unknown;
      const con = await begin({ argv: ["console"] }, async (m) => {
        const r = await cmdConsole(ctx, []);
        usedFlag = m.values.get("tab_diagnostics_used");
        return r;
      });
      expect(usedFlag).toBe(true);
      expect(con.text).toBe("(1 older tab diagnostic entries dropped)\n[log] booted\n[error] TypeError: boom");
      expect(page.runtimeOn).toBe(false);
      expect(cdpCalls).toHaveLength(0);

      expect((await cmdConsole(ctx, ["--clear"])).text).toBe("✓ Console cleared");
      page.runtimeOn = true;
      page.console.add({ type: "log", text: "replayed-by-runtime" });
      expect((await cmdConsole(ctx, [])).text).toBe("(no console messages)");

      const net = await cmdNetwork(ctx, ["requests", "--status", "200"]);
      expect(net.text).toBe("[diag-3] GET https://example.test/api/items (fetch) 200");
      expect((net.data as { requests: Record<string, unknown>[] }).requests[0]).toMatchObject({ durationMs: 14, cached: true });
      expect(page.networkOn).toBe(false);
      expect(cdpCalls).toHaveLength(0);

      await expect(cmdNetwork(ctx, ["request", "diag-4"])).rejects.toThrow("network requests --reload");

      expect((await cmdNetwork(ctx, ["requests", "--clear"])).text).toBe("✓ Request log cleared");
      expect((await cmdNetwork(ctx, ["requests"])).text).toBe("(no requests)");

      const cleaned = cleanBrowseMetrics(new Map<string, boolean>([["tab_diagnostics_used", true], ["tab_input_used", true]]));
      expect(cleaned.get("tab_diagnostics_used")).toBe(true);
      expect(cleaned.get("tab_input_used")).toBe(true);
    } finally {
      await sock.close();
    }
  });
});

describe("tabs.input CLI integration", () => {
  test("stateless clicks, wheel, unmodified keys, and text route natively while down/up, chords, allowNative=false, and OOPIFs stay on CDP", async () => {
    const sock = await startControlSocket((method, params) => {
      if (method === "methods") return { result: [{ name: "tabs.diagnostics" }, { name: "tabs.input" }] };
      if (method === "tabs.input") {
        if (params["action"] === "text") return { result: { tab: "tab-1", action: "text", acked: false, sent: true } };
        return { result: { tab: "tab-1", action: params["action"], acked: true } };
      }
      return { error: { code: "unknown_method", message: "unknown" } };
    });
    try {
      const { page, cdpCalls } = makeFakePage(sock.dir, { hidden: true });
      expect(await page.takesInput()).toBe(false);
      await expect(page.requireVisible()).rejects.toMatchObject({ code: "tab_hidden" });

      const input = page.input as Input;
      let inputFlag: unknown;
      await begin({ argv: ["click"] }, async (m) => {
        await input.pointer.click(120, 80, "left", 1, false);
        inputFlag = m.values.get("tab_input_used");
      });
      expect(inputFlag).toBe(true);
      expect(cdpCalls).toHaveLength(0);

      expect(await nativeMouseClick(page, 120, 80, "left", 2)).toBe(true);
      expect(await nativeWheel(page, 120, 80, 0, 240)).toBe(true);
      expect(await nativeText(page, "hello world")).toBe(true);
      expect(await nativeText(page, "bad\0text")).toBe(false);
      expect(await nativeKey(page, "ContextMenu")).toBe(false);

      await input.pressCombo("Enter", false);
      expect(cdpCalls).toHaveLength(0);

      await input.keyboard().typeText("a", false, false);
      expect(cdpCalls.some((c) => c.method === "Input.dispatchKeyEvent")).toBe(true);

      const beforeChord = cdpCalls.length;
      await input.pressCombo("Shift+a", false);
      expect(cdpCalls.length).toBeGreaterThan(beforeChord);

      const beforeHold = cdpCalls.length;
      await input.pointer.down("left");
      await input.pointer.move(150, 90, false);
      await input.releaseHeld();
      expect(cdpCalls.length).toBeGreaterThan(beforeHold);

      page.frameSessions.set("F_OOPIF", "S_OOPIF");
      expect(await nativeMouseClick(page, 120, 80, "left", 1)).toBe(false);
      expect(await nativeWheel(page, 120, 80, 0, 100)).toBe(false);
      page.frameSessions.clear();

      const actions = sock.calls.filter((c) => c.method === "tabs.input").map((c) => c.params["action"]);
      expect(actions).toEqual(["click", "dblclick", "wheel", "text", "key"]);
    } finally {
      await sock.close();
    }
  });

  test("unacknowledged or ambiguous native failures throw OutcomeUnknown and never replay over CDP", async () => {
    let mode = "unacked";
    const sock = await startControlSocket((method) => {
      if (method === "methods") return { result: [{ name: "tabs.input" }] };
      if (method === "tabs.input") {
        if (mode === "ambiguous_busy") return { error: { code: "failed", message: "Renderer became busy before acknowledging input" } };
        if (mode === "ambiguous_engine") return { error: { code: "failed", message: "Post-dispatch failure: engine can't do that for ack" } };
        return { result: { tab: "tab-1", action: "click", acked: false } };
      }
      return { error: { code: "unknown_method", message: "unknown" } };
    });
    try {
      const { page, cdpCalls } = makeFakePage(sock.dir);
      const input = page.input as Input;
      await expect(input.pointer.click(50, 50, "left", 1, false)).rejects.toBeInstanceOf(OutcomeUnknown);
      await expect(closedMenu(page, "menu")).rejects.toBeInstanceOf(OutcomeUnknown);
      mode = "ambiguous_busy";
      await expect(input.pointer.click(50, 50, "left", 1, false)).rejects.toBeInstanceOf(OutcomeUnknown);
      mode = "ambiguous_engine";
      await expect(input.pointer.click(50, 50, "left", 1, false)).rejects.toBeInstanceOf(OutcomeUnknown);
      expect((await tabCapabilities(page.state)).input).toBe(true);
      expect(cdpCalls).toHaveLength(0);
    } finally {
      await sock.close();
    }
  });

  test("console --clear does not resurface pre-clear messages on transient diagnostics fallback or recovery", async () => {
    let failDiag = false;
    const preClearTime = Date.now() - 500;
    const sock = await startControlSocket((method) => {
      if (method === "methods") return { result: [{ name: "tabs.diagnostics" }] };
      if (method === "tabs.diagnostics") {
        if (failDiag) return { error: { code: "failed", message: "transient diagnostics timeout" } };
        return {
          result: {
            tab: "tab-1",
            nextSeq: 3,
            console: [{ seq: 2, time: preClearTime, level: "log", kind: "console", message: "old-diag-entry", source: "app.js", line: 1, frame: "F1" }],
            network: [],
            dropped: 0,
            more: false,
          },
        };
      }
      return { error: { code: "unknown_method", message: "unknown" } };
    });
    try {
      const { state, page } = makeFakePage(sock.dir);
      const ctx = new Ctx(state, {}, process.cwd(), {}, null, "console");
      const beforeClear = Date.now() - 500;
      page.console.add({ type: "log", text: "pre-clear-buffered", timestamp: beforeClear });
      expect((await cmdConsole(ctx, ["--clear"])).text).toBe("✓ Console cleared");
      expect(page.console.items).toHaveLength(0);

      failDiag = true;
      page.enableRuntime = async () => {
        page.runtimeOn = true;
        page.console.add({ type: "log", text: "replayed-old", timestamp: beforeClear });
        page.console.add({ type: "log", text: "fresh-after-clear", timestamp: Date.now() + 100 });
      };
      const fallback = await cmdConsole(ctx, []);
      expect(fallback.text).toBe("[log] fresh-after-clear");

      const oldDiagTime = Date.now() - 1000;
      expect((await cmdConsole(ctx, ["--clear"])).text).toBe("✓ Console cleared");
      failDiag = false;
      const recovered = await cmdConsole(ctx, []);
      expect(recovered.text).toBe("(no console messages)");
      expect(oldDiagTime).toBeLessThan(Date.now());
    } finally {
      await sock.close();
    }
  });

  test("mouse drag stays on CDP and network requests --type xhr falls back to CDP", async () => {
    const sock = await startControlSocket((method) => {
      if (method === "methods") return { result: [{ name: "tabs.diagnostics" }, { name: "tabs.input" }] };
      if (method === "tabs.diagnostics") {
        return {
          result: {
            tab: "tab-1",
            nextSeq: 2,
            console: [],
            network: [{ seq: 1, time: Date.now(), method: "GET", url: "https://example.test/api/xhr", status: 200, type: "fetch", frame: "F1", failed: false }],
            dropped: 0,
            more: false,
          },
        };
      }
      if (method === "tabs.input") return { result: { tab: "tab-1", action: "move", acked: true } };
      return { error: { code: "unknown_method", message: "unknown" } };
    });
    try {
      const { state, page, cdpCalls } = makeFakePage(sock.dir);
      const input = page.input as Input;
      await input.pointer.drag(10, 10, 80, 80, false);
      expect(sock.calls.filter((c) => c.method === "tabs.input")).toHaveLength(0);
      expect(cdpCalls.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(true);

      const ctx = new Ctx(state, {}, process.cwd(), {}, null, "network");
      const xhrRes = await cmdNetwork(ctx, ["requests", "--type", "xhr"]);
      expect(page.networkOn).toBe(true);
      expect((xhrRes.data as Record<string, unknown>)["source"]).toBeUndefined();
    } finally {
      await sock.close();
    }
  });

  test("page_changed propagates document_changed including in closedMenu, exact pre-dispatch refusals fall back, and non-unit or unreadable scale stays on CDP", async () => {
    let mode = "page_changed";
    const sock = await startControlSocket((method) => {
      if (method === "methods") return { result: [{ name: "tabs.input" }] };
      if (method === "tabs.input") {
        if (mode === "page_changed") return { error: { code: "failed", message: "The tab's page or focused frame changed after prime, so nothing was sent." } };
        if (mode === "not_painting") return { error: { code: "failed", message: "The tab's page stopped drawing after prime, so nothing was sent; try again." } };
        return { result: { tab: "tab-1", action: "click", acked: true } };
      }
      return { error: { code: "unknown_method", message: "unknown" } };
    });
    try {
      const { page } = makeFakePage(sock.dir);
      for (const run of [() => nativeMouseClick(page, 20, 20, "left", 1), () => closedMenu(page, "menu")]) {
        try {
          await run();
          throw new Error("expected document_changed");
        } catch (error) {
          expect(error).toBeInstanceOf(BrowseError);
          expect((error as BrowseError).code).toBe("document_changed");
        }
      }
      mode = "not_painting";
      expect(await nativeMouseClick(page, 20, 20, "left", 1)).toBe(false);

      mode = "ok";
      page.call = (async () => 1.0005) as Page["call"];
      expect(await nativeMouseClick(page, 20, 20, "left", 1)).toBe(false);
      page.call = (async () => null) as Page["call"];
      expect(await nativeMouseClick(page, 20, 20, "left", 1)).toBe(false);
      page.call = (async () => 1) as Page["call"];
      page.sessionId = null;
      expect(await nativeMouseClick(page, 20, 20, "left", 1)).toBe(false);
      page.sessionId = "S1";
      expect(await nativeMouseClick(page, 20, 20, "left", 1)).toBe(true);
    } finally {
      await sock.close();
    }
  });

  test("capped console --clear retains progress and throws until finished", async () => {
    let pageCalls = 0;
    const sock = await startControlSocket((method, params) => {
      if (method === "methods") return { result: [{ name: "tabs.diagnostics" }] };
      if (method === "tabs.diagnostics") {
        pageCalls += 1;
        const since = typeof params["since"] === "number" ? params["since"] : 0;
        const nextSeq = since + 1;
        return { result: { tab: "tab-1", nextSeq, console: [], network: [], dropped: 0, more: pageCalls < 12 } };
      }
      return { error: { code: "unknown_method", message: "unknown" } };
    });
    try {
      const { state } = makeFakePage(sock.dir);
      const ctx = new Ctx(state, {}, process.cwd(), {}, null, "console");
      await expect(cmdConsole(ctx, ["--clear"])).rejects.toThrow("console --clear");
      const second = await cmdConsole(ctx, ["--clear"]);
      expect(second.text).toBe("✓ Console cleared");
      expect(pageCalls).toBe(12);
    } finally {
      await sock.close();
    }
  });

  test("transient socket absence is not permanently cached, and engine-missing disables cleanly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-tt-late-"));
    try {
      const { state, page } = makeFakePage(dir);
      expect(await tabCapabilities(state)).toEqual({ diagnostics: false, input: false });

      const socketPath = path.join(dir, SOCKET_FILE);
      let inputCalls = 0;
      const server = net.createServer((conn) => {
        let buf = "";
        conn.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
            const msg = JSON.parse(buf.slice(0, nl)) as { id: number; method: string };
            buf = buf.slice(nl + 1);
            if (msg.method === "hello") {
              conn.write(`${JSON.stringify({ id: msg.id, result: { app: "Ardia", version: "0.2.50", protocol: 4, minClientProtocol: 4 } })}\n`);
            } else if (msg.method === "methods") {
              conn.write(`${JSON.stringify({ id: msg.id, result: [{ name: "tabs.input" }] })}\n`);
            } else if (msg.method === "tabs.input") {
              inputCalls += 1;
              conn.write(`${JSON.stringify({ id: msg.id, error: { code: "failed", message: "This Ardia's engine can't do that yet; update Ardia." } })}\n`);
            }
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      try {
        expect((await tabCapabilities(state)).input).toBe(true);
        expect(await nativeMouseClick(page, 10, 10, "left", 1)).toBe(false);
        expect((await tabCapabilities(state)).input).toBe(false);
        expect(await nativeMouseClick(page, 10, 10, "left", 1)).toBe(false);
        expect(inputCalls).toBe(1);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
