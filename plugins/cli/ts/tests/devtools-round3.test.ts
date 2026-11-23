import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./libc-loaded.ts";
import { Cancelled, currentSignal, withSignal } from "../src/browse/cdp/cancel.ts";
import { issueFingerprint } from "../src/browse/capture/devtools.ts";
import { cmdLogpoint } from "../src/browse/capture/logpoints.ts";
import { EXPLICIT_ENDPOINT_SKIP, explicitEndpoint, fieldDataDecision, hasNavigation, NAVIGATED_SKIP, recordTrace } from "../src/browse/capture/perf.ts";
import { Ctx } from "../src/browse/commands/ctx.ts";
import { BrowseError } from "../src/browse/daemon-errors.ts";
import { ControlRefused } from "../src/browse/state/apptabs.ts";
import { ControlLink } from "../src/browse/state/controllink.ts";
import { announcePath } from "../src/browse/daemon/announce.ts";

type Answer = (request: Record<string, unknown>, socket: Socket) => void;

function serve(file: string, answer: Answer): Promise<{ server: Server; closed: () => number }> {
  let closed = 0;
  const server = createServer((socket) => {
    socket.on("close", () => {
      closed += 1;
    });
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
  return new Promise((resolve) => server.listen(file, () => resolve({ server, closed: () => closed })));
}

const reply = (socket: Socket, id: unknown, body: Record<string, unknown>) => socket.write(`${JSON.stringify({ id, ...body })}\n`);

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("an error answer to hello rejects the open and closes the socket", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "r3-"));
  const file = path.join(root, "ArdiaControl.sock");
  const { server, closed } = await serve(file, (request, socket) => reply(socket, request["id"], { error: { code: "refused", message: "not you" } }));
  try {
    await assert.rejects(ControlLink.open(file, null, 5), (error: Error) => error instanceof ControlRefused);
    await until(() => closed() === 1);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("field data is never asked over --port or --ws, nor without a page load in the trace", () => {
  const ctxWith = (endpoint: unknown) => ({ state: { endpoint } }) as unknown as Ctx;
  assert.equal(explicitEndpoint(ctxWith({ explicit: true })), true);
  assert.equal(explicitEndpoint(ctxWith(null)), true);
  assert.equal(explicitEndpoint(ctxWith({ explicit: false })), false);
  assert.equal(hasNavigation([{ name: "RunTask" }]), false);
  assert.equal(hasNavigation([{ name: "navigationStart" }]), true);
});

test("cleared issues stay apart from a later issue on the same cookie with other reasons", () => {
  const lax = { code: "CookieIssue", kind: "cookie", title: "Cookie excluded", reasons: ["ExcludeSameSiteLax"], explanation: "Lax", affected: { cookie: { name: "sid", domain: "site" } } };
  const strict = { ...lax, reasons: ["ExcludeSameSiteStrict"], explanation: "Strict" };
  assert.notEqual(issueFingerprint(lax), issueFingerprint(strict));
  assert.equal(issueFingerprint(lax), issueFingerprint({ ...lax }));
});

type FakeState = Record<string, unknown> & { pages: Map<string, unknown>; leases: Set<string>; onForget: ((target: string, page: unknown) => void)[] };

function controlFileIn(root: string): string {
  return path.join(root, "Profile", "control.json");
}

function socketFor(root: string): string {
  const file = announcePath(controlFileIn(root));
  mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function fakeWorld(root: string): { ctx: Ctx; state: FakeState; page: Record<string, unknown>; forget: () => void } {
  const page: Record<string, unknown> = { targetId: "T1", runtimeOn: true, mainFrame: "F", url: "https://site/", enableRuntime: async () => {}, send: async () => ({}) };
  const claims = new Set<string>();
  const state: FakeState = {
    pages: new Map([["T1", page]]),
    leases: new Set<string>(),
    onForget: [],
    listeners: [],
    created: new Set(["T1"]),
    claims: { has: (t: string, k: string) => claims.has(`${t}/${k}`), add: (t: string, k: string) => claims.add(`${t}/${k}`), delete: (t: string, k: string) => claims.delete(`${t}/${k}`) },
    config: { browseFd: null, key: "k" },
    session: "s",
    endpoint: { source: controlFileIn(root), explicit: false },
    caller: null,
    dataDir: null,
    targetInfos: new Map(),
    appTabs: new Map([["T1", "tab-1"]]),
    appGenerations: new Map(),
    page: async () => page,
    tabId: () => "t1",
    appTabOf: () => "tab-1",
  };
  const forget = () => {
    state.pages.delete("T1");
    for (const hook of state.onForget) hook("T1", page);
  };
  return { ctx: new Ctx(state as never, {}, root, {}, null, "logpoint"), state, page, forget };
}

test("a logpoint Ardia matched by script address isn't reported as source-mapped", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "r3-"));
  mkdirSync(path.join(root, "Profile"), { recursive: true });
  const file = socketFor(root);
  const methods: unknown[] = [];
  const { server } = await serve(file, (request, socket) => {
    methods.push(request["method"]);
    if (request["method"] === "hello") reply(socket, request["id"], { result: { app: "Ardia" } });
    else if (request["method"] === "devtools.logpoint") reply(socket, request["id"], { result: { id: "lp-1", url: "https://site/a.js", line: 3, column: null, original: null, matchedScript: true, label: "[ardia logpoint lp-1]" } });
    else reply(socket, request["id"], { result: { cleared: true } });
  });
  try {
    const { ctx } = fakeWorld(root);
    const added = await cmdLogpoint(ctx, ["add", "https://site/a.js:3", "x"]);
    assert.ok(methods.includes("devtools.logpoint"));
    assert.equal((added.data as Record<string, unknown>)["via"], "ardia");
    assert.equal((added.data as Record<string, unknown>)["mapped"], false);
    assert.equal((added.data as Record<string, unknown>)["generated"], "https://site/a.js:3");
    await cmdLogpoint(ctx, ["clear"]);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tab that closes while a logpoint is being set leaves no logpoint and no lease", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "r3-"));
  mkdirSync(path.join(root, "Profile"), { recursive: true });
  const file = socketFor(root);
  const cleared: unknown[] = [];
  let pending: (() => void) | null = null;
  const { server } = await serve(file, (request, socket) => {
    if (request["method"] === "hello") reply(socket, request["id"], { result: { app: "Ardia" } });
    else if (request["method"] === "devtools.logpoint") pending = () => reply(socket, request["id"], { result: { id: "lp-2", url: "https://site/a.js", line: 3, original: null, matchedScript: true } });
    else if (request["method"] === "devtools.clearLogpoint") {
      cleared.push(record(request["params"])["id"]);
      reply(socket, request["id"], { result: { cleared: 1 } });
    }
  });
  try {
    const { ctx, state, forget } = fakeWorld(root);
    const adding = cmdLogpoint(ctx, ["add", "https://site/a.js:3", "x"]);
    await until(() => pending !== null);
    assert.equal(typeof pending, "function");
    forget();
    (pending as unknown as () => void)();
    await assert.rejects(adding, (error: Error) => error instanceof BrowseError && error.code === "tab_gone");
    assert.equal(state.leases.has("logpoint"), false);
    assert.deepEqual((await cmdLogpoint(ctx, ["list"])).data, { logpoints: [] });
    assert.ok(cleared.length <= 1);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

test("cancelling while Tracing.start is in flight still sends Tracing.end", async () => {
  const sent: string[] = [];
  const listeners: ((page: unknown, method: string, params: Record<string, unknown>) => void)[] = [];
  const page: Record<string, unknown> = {
    targetId: "T1",
    mainFrame: "F",
    send: (method: string) => {
      sent.push(method);
      if (method === "Tracing.start") {
        const signal = currentSignal();
        return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Cancelled()), { once: true }));
      }
      if (method === "Tracing.end") for (const listener of [...listeners]) listener(page, "Tracing.tracingComplete", {});
      return Promise.resolve({});
    },
  };
  const claims = new Set<string>();
  const state = {
    listeners,
    claims: { has: (t: string, k: string) => claims.has(`${t}/${k}`), add: (t: string, k: string) => claims.add(`${t}/${k}`), delete: (t: string, k: string) => claims.delete(`${t}/${k}`) },
    config: { browseFd: null, key: "k" },
    session: "s",
    leases: new Set<string>(),
  };
  const ctx = new Ctx(state as never, {}, tmpdir(), {}, null, "perf");
  const controller = new AbortController();
  const tracing = withSignal(controller.signal, () => recordTrace(ctx, page as never, false, 5));
  await until(() => sent.includes("Tracing.start"));
  controller.abort(new Cancelled());
  await assert.rejects(tracing);
  assert.deepEqual(sent, ["Tracing.start", "Tracing.end"]);
  assert.equal(listeners.length, 0);
});

test("a trace whose claim is refused sends neither Tracing.start nor Tracing.end", async () => {
  const sent: string[] = [];
  const page: Record<string, unknown> = { targetId: "T1", mainFrame: "F", send: (method: string) => (sent.push(method), Promise.resolve({})) };
  const state = {
    listeners: [] as unknown[],
    claims: {
      has: () => false,
      add: () => {
        throw new BrowseError("another session holds this tab's trace", null, "tab_owned");
      },
      delete: () => {},
    },
    config: { browseFd: null, key: "k" },
    session: "s",
    leases: new Set<string>(),
  };
  const ctx = new Ctx(state as never, {}, tmpdir(), {}, null, "perf");
  await assert.rejects(recordTrace(ctx, page as never, false, 1), (error: Error) => error instanceof BrowseError && error.code === "tab_owned");
  assert.deepEqual(sent, []);
  assert.equal(state.listeners.length, 0);
});

test("field data is tied to the traced origin, rechecked after Ardia's tab list answers", async () => {
  const navigation = [{ name: "navigationStart" }];
  const page = { targetId: "T1", url: "https://shop.example/cart" };
  const ctx = { state: { endpoint: { explicit: false } } } as unknown as Ctx;
  const moving = async () => {
    page.url = "https://elsewhere.example/";
    return "tab-1";
  };
  assert.deepEqual(await fieldDataDecision(ctx, page as never, true, "https://shop.example/", navigation, moving), { skipped: NAVIGATED_SKIP });
  page.url = "https://shop.example/cart";
  const staying = async () => {
    page.url = "https://shop.example/checkout";
    return "tab-1";
  };
  assert.deepEqual(await fieldDataDecision(ctx, page as never, true, "https://shop.example/", navigation, staying), { origin: "https://shop.example" });
  assert.equal("skipped" in (await fieldDataDecision(ctx, page as never, true, "https://shop.example/", navigation, async () => null)), true);
  assert.equal("skipped" in (await fieldDataDecision(ctx, page as never, true, "https://shop.example/", [], async () => "tab-1")), true);
  const explicit = { state: { endpoint: { explicit: true } } } as unknown as Ctx;
  let asked = false;
  const decision = await fieldDataDecision(explicit, page as never, true, "https://shop.example/", navigation, async () => {
    asked = true;
    return "tab-1";
  });
  assert.deepEqual(decision, { skipped: EXPLICIT_ENDPOINT_SKIP });
  assert.equal(asked, false);
});
