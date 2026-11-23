import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./libc-loaded.ts";
import { cascade, cascadeRank, cmdIssues } from "../src/browse/capture/devtools.ts";
import { cmdLogpoint } from "../src/browse/capture/logpoints.ts";
import { analyze, cmdPerf, EXPLICIT_ENDPOINT_SKIP, NO_LOAD_SKIP } from "../src/browse/capture/perf.ts";
import { matchingSource } from "../src/browse/capture/sourcemaps.ts";
import { Ctx } from "../src/browse/commands/ctx.ts";
import { announcePath } from "../src/browse/daemon/announce.ts";

type Listener = (page: unknown, method: string, params: Record<string, unknown>) => void;

function claimsOf(): Record<string, unknown> {
  const held = new Set<string>();
  return { has: (t: string, k: string) => held.has(`${t}/${k}`), add: (t: string, k: string) => held.add(`${t}/${k}`), delete: (t: string, k: string) => held.delete(`${t}/${k}`) };
}

function fakePage(sent: string[], listeners: Listener[], answers: Record<string, () => Record<string, unknown>> = {}): Record<string, unknown> {
  const page: Record<string, unknown> = {
    targetId: "T1",
    mainFrame: "F",
    url: "https://site.example/",
    runtimeOn: true,
    session: "S1",
    enableRuntime: async () => {},
    sessionFor: () => null,
  };
  page["send"] = (method: string) => {
    sent.push(method);
    if (method === "Tracing.end") {
      for (const listener of [...listeners]) listener(page, "Tracing.dataCollected", { value: [{ name: "RunTask", ph: "X", ts: 1000, dur: 10, pid: 1, tid: 1 }] });
      for (const listener of [...listeners]) listener(page, "Tracing.tracingComplete", {});
    }
    return Promise.resolve(answers[method]?.() ?? {});
  };
  return page;
}

function fakeState(page: Record<string, unknown>, listeners: Listener[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pages: new Map([["T1", page]]),
    leases: new Set<string>(),
    onForget: [],
    listeners,
    created: new Set(["T1"]),
    claims: claimsOf(),
    config: { browseFd: null, key: "k" },
    session: "s",
    endpoint: null,
    caller: null,
    dataDir: null,
    targetInfos: new Map(),
    appTabs: new Map(),
    appGenerations: new Map(),
    page: async () => page,
    tabId: () => "t1",
    appTabOf: () => undefined,
    attached: null,
    current: "T1",
    ...extra,
  };
}

test("--crux without --reload skips field data with no API key, and a cold session isn't taken for --port", async () => {
  for (const [explicit, reason] of [
    [false, NO_LOAD_SKIP],
    [true, EXPLICIT_ENDPOINT_SKIP],
  ] as const) {
    const sent: string[] = [];
    const listeners: Listener[] = [];
    const page = fakePage(sent, listeners);
    const state = fakeState(page, listeners);
    state["page"] = async () => {
      state["endpoint"] = { explicit };
      return page;
    };
    const ctx = new Ctx(state as never, {}, tmpdir(), {}, null, "perf");
    const result = await cmdPerf(ctx, ["insight", "--crux", "--duration", "250ms"]);
    assert.ok(String(result.text).includes(`field data: skipped: ${reason}`), String(result.text));
    assert.deepEqual((result.data as Record<string, unknown>)["fieldData"], { skipped: reason });
  }
});

test("a trace's FCP and LCP come from the main frame's navigation, never a child frame's paints", () => {
  const main = { pid: 7, tid: 1 };
  const insights = analyze([
    { name: "TracingStartedInBrowser", ph: "I", ts: 900_000, args: { data: { frames: [{ frame: "MAIN", processId: 7, isOutermostMainFrame: true }, { frame: "CHILD", parent: "MAIN", processId: 7 }] } } },
    { name: "thread_name", ph: "M", ...main, args: { name: "CrRendererMain" } },
    { name: "navigationStart", ph: "R", ts: 1_000_000, ...main, args: { frame: "MAIN", data: { isOutermostMainFrame: true, navigationId: "N1" } } },
    { name: "navigationStart", ph: "R", ts: 1_100_000, ...main, args: { frame: "CHILD", data: { isOutermostMainFrame: false, navigationId: "N2" } } },
    { name: "firstContentfulPaint", ph: "R", ts: 1_200_000, ...main, args: { frame: "CHILD", data: { navigationId: "N2" } } },
    { name: "largestContentfulPaint::Candidate", ph: "R", ts: 1_300_000, ...main, args: { frame: "CHILD", data: { navigationId: "N2" } } },
    { name: "firstContentfulPaint", ph: "R", ts: 1_500_000, ...main, args: { frame: "MAIN", data: { navigationId: "N1" } } },
    { name: "largestContentfulPaint::Candidate", ph: "R", ts: 1_700_000, ...main, args: { frame: "MAIN", data: { navigationId: "N1" } } },
  ]);
  const value = (name: string) => insights.metrics.find((item) => item.name === name)?.value;
  assert.equal(value("FCP"), 500);
  assert.equal(value("LCP"), 700);
});

test("a browser default's !important beats the page's inline !important, and an exact source path beats a longer one", () => {
  assert.ok(cascadeRank({ important: true, agent: true }) > cascadeRank({ important: true, agent: false }));
  const { winners } = cascade({
    matchedCSSRules: [{ rule: { selectorList: { text: "input" }, origin: "user-agent", style: { cssProperties: [{ name: "appearance", value: "auto !important", important: true }] } } }],
    inlineStyle: { cssProperties: [{ name: "appearance", value: "none !important", important: true }] },
  });
  assert.equal(winners.get("appearance")?.value, "auto");
  assert.equal(matchingSource(["vendor/src/app.ts", "src/app.ts"], "src/app.ts"), 1);
  assert.equal(matchingSource(["vendor/src/app.ts"], "src/app.ts"), 0);
});

test("issues turns Audits on again after the tab's DevTools session is replaced", async () => {
  const sent: string[] = [];
  const listeners: Listener[] = [];
  const page = fakePage(sent, listeners);
  const ctx = new Ctx(fakeState(page, listeners, { endpoint: { explicit: true } }) as never, {}, tmpdir(), {}, null, "issues");
  await cmdIssues(ctx, []);
  await cmdIssues(ctx, []);
  assert.equal(sent.filter((method) => method === "Audits.enable").length, 1);
  page["session"] = "S2";
  await cmdIssues(ctx, []);
  assert.equal(sent.filter((method) => method === "Audits.enable").length, 2);
});

test("local logpoints are placed again in a replaced DevTools session, and removed by their new id", async () => {
  const sent: string[] = [];
  const listeners: Listener[] = [];
  let breakpoints = 0;
  const page = fakePage(sent, listeners, { "Debugger.setBreakpointByUrl": () => ({ breakpointId: `bp-${(breakpoints += 1)}` }) });
  const removed: unknown[] = [];
  const send = page["send"] as (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  page["send"] = (method: string, params?: Record<string, unknown>) => {
    if (method === "Debugger.removeBreakpoint") removed.push(params?.["breakpointId"]);
    return send(method, params);
  };
  const ctx = new Ctx(fakeState(page, listeners, { endpoint: { explicit: true } }) as never, {}, tmpdir(), {}, null, "logpoint");
  await cmdLogpoint(ctx, ["add", "https://site.example/a.js:3", "x"]);
  assert.equal(sent.filter((method) => method === "Debugger.enable").length, 1);
  page["session"] = "S2";
  const listed = await cmdLogpoint(ctx, ["list"]);
  assert.equal(((listed.data as Record<string, unknown>)["logpoints"] as unknown[]).length, 1);
  assert.equal(sent.filter((method) => method === "Debugger.enable").length, 2);
  assert.equal(sent.filter((method) => method === "Debugger.setBreakpointByUrl").length, 2);
  await cmdLogpoint(ctx, ["clear"]);
  assert.deepEqual(removed, ["bp-2"]);
});

function serve(file: string, answer: (request: Record<string, unknown>, socket: Socket) => void): Promise<Server> {
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const request = JSON.parse(buffer.slice(0, at)) as Record<string, unknown>;
        buffer = buffer.slice(at + 1);
        answer(request, socket);
      }
    });
  });
  return new Promise((resolve) => server.listen(file, () => resolve(server)));
}

test("when Ardia's socket drops while a logpoint is placed, the fallback logpoint is the one the list shows", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "r5-"));
  const control = path.join(root, "Profile", "control.json");
  const file = announcePath(control);
  mkdirSync(path.dirname(control), { recursive: true });
  mkdirSync(path.dirname(file), { recursive: true });
  let placements = 0;
  const server = await serve(file, (request, socket) => {
    const id = request["id"];
    if (request["method"] === "hello") socket.write(`${JSON.stringify({ id, result: { app: "Ardia" } })}\n`);
    else if (request["method"] === "devtools.logpoint") {
      placements += 1;
      if (placements === 1) socket.write(`${JSON.stringify({ id, result: { id: "lp-ardia", url: "https://site.example/a.js", line: 3, original: null, matchedScript: true } })}\n`);
      else socket.destroy();
    }
  });
  try {
    const sent: string[] = [];
    const listeners: Listener[] = [];
    const page = fakePage(sent, listeners, { "Debugger.setBreakpointByUrl": () => ({ breakpointId: "bp-1" }) });
    const state = fakeState(page, listeners, { endpoint: { source: control, explicit: false }, appTabOf: () => "tab-1" });
    const ctx = new Ctx(state as never, {}, root, {}, null, "logpoint");
    await cmdLogpoint(ctx, ["add", "https://site.example/a.js:3", "x"]);
    const second = await cmdLogpoint(ctx, ["add", "https://site.example/a.js:4", "y"]);
    assert.equal(placements, 2);
    assert.equal((second.data as Record<string, unknown>)["via"], "cdp");
    const listed = (await cmdLogpoint(ctx, ["list"])).data as Record<string, unknown>;
    assert.deepEqual((listed["logpoints"] as Record<string, unknown>[]).map((point) => point["via"]), ["cdp"]);
    await cmdLogpoint(ctx, ["clear"]);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
