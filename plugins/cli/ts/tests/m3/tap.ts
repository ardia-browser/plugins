import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import type { ServerWebSocket } from "bun";
import { type Entry, parse, readTranscript } from "./canon.ts";
import { type Elastic, ReplayConn } from "./replay.ts";
import { actingStep } from "../../src/browse/plugin/acting.ts";
import { refusalMessage } from "../../src/browse/plugin/engine-codes.ts";

type Fault = { at: number; kind: "kill" | "stop" | "close" | "drop" | "error" | "hold"; seconds?: number; code?: number; method?: string; message?: string };
type Link = { conn: number; upstream: WebSocket | null; queue: string[]; replay: ReplayConn | null; dropId: number | null };

const MAX_PAYLOAD = 512 * 1024 * 1024;
const BURST_QUIET_MS = 3;
const BURST_MAX_MS = 250;
const options = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) options.set(process.argv[index] ?? "", process.argv[index + 1] ?? "");
const listen = Number(options.get("--listen"));
const out = options.get("--out") ?? "";
const upstreamPort = options.get("--upstream");
const replayPath = options.get("--replay");
const chromePid = Number(options.get("--chrome-pid") ?? 0);
const emulateClicks = options.get("--emulate-dispatch-click") === "1";
const emulateHold = options.get("--emulate-act-hold") === "1";
const emulateHiddenWheels = options.get("--emulate-hidden-wheel-refusal") === "1";
const EMULATED_IDS = 2_000_000_000;
let emulatedId = EMULATED_IDS;
type Asked = { link: Link; then: (answer: { result?: Record<string, unknown>; error?: { code?: number; message?: string } }) => void };
const emulations = new Map<number, Asked>();
const scratch = options.get("--scratch");
if (!listen || !out || (!upstreamPort && !replayPath)) {
  process.stderr.write("tap.ts: --listen, --out and one of --upstream or --replay are required\n");
  process.exit(64);
}

const started = performance.now();
const now = () => Math.round((performance.now() - started) * 1000) / 1000;
writeFileSync(out, "");
const record = (entry: Entry) => appendFileSync(out, `${JSON.stringify(entry)}\n`);
record({ k: "meta", scratch: scratch ?? "", listen, mode: replayPath ? "replay" : "live" });

const fixtureFrom = options.get("--fixture-from");
const fixtureTo = options.get("--fixture-to");
const fixturePort = fixtureFrom && fixtureTo && fixtureFrom !== fixtureTo ? new RegExp(`(?<=(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):)${fixtureFrom}\\b`, "g") : null;
const recording = (replayPath ? readTranscript(replayPath) : []).map((entry) =>
  fixturePort && entry.m !== undefined ? { ...entry, m: entry.m.replace(fixturePort, fixtureTo as string) } : entry,
);
const recordedScratch = recording.find((entry) => entry.k === "meta")?.scratch;
const recordedVersion = recording.find((entry) => entry.k === "version")?.body;
const elasticRules = JSON.parse(readFileSync(new URL("../../../tests/m3/elastic.json", import.meta.url), "utf8")) as { lookahead: number; methods: string[]; probes: string[] };
const elastic: Elastic = {
  lookahead: elasticRules.lookahead,
  repeats(form) {
    const message = parse(form) as { method?: string; params?: { functionDeclaration?: string; expression?: string } } | null;
    if (!message?.method) return false;
    if (elasticRules.methods.includes(message.method)) return true;
    const source = message.params?.functionDeclaration ?? message.params?.expression;
    return (message.method === "Runtime.callFunctionOn" || message.method === "Runtime.evaluate") && source !== undefined && elasticRules.probes.includes(source);
  },
};
const elasticCounts: Record<string, number> = {};
let connections = 0;
let requests = 0;
let fault: Fault | null = null;
let faultBase = 0;
let matched = 0;
let fired = false;
let held: { link: Link; text: string } | null = null;
const failures: string[] = [];
const links = new Set<Link>();
let version: string | null = null;

function browserUrl(): string {
  return `ws://127.0.0.1:${listen}/devtools/browser/tap`;
}

async function versionBody(): Promise<string> {
  if (replayPath) return recordedVersion ?? JSON.stringify({ Browser: "replay" });
  const response = await fetch(`http://127.0.0.1:${upstreamPort}/json/version`);
  const body = await response.text();
  if (version === null) {
    version = body;
    record({ k: "version", body });
  }
  return body;
}

function rewriteVersion(body: string): string {
  const info = JSON.parse(body) as Record<string, unknown>;
  info["webSocketDebuggerUrl"] = browserUrl();
  return JSON.stringify(info);
}

function deliver(link: Link, text: string): void {
  if (link.replay) link.replay.request(text);
  else if (link.upstream && link.upstream.readyState === WebSocket.OPEN) link.upstream.send(text);
  else link.queue.push(text);
}

function injected(link: Link, text: string, socket: ServerWebSocket<Link>): boolean {
  const message = parse(text);
  if (!message || message.id === undefined || !message.method) return false;
  requests += 1;
  if (!fault || fired) return false;
  if (fault.method) {
    if (message.method !== fault.method) return false;
    matched += 1;
    if (matched !== fault.at) return false;
  } else if (requests - faultBase !== fault.at) return false;
  fired = true;
  record({ k: "fault", c: link.conn, t: now(), fault, request: requests });
  switch (fault.kind) {
    case "hold":
      held = { link, text };
      return true;
    case "error": {
      const answer = JSON.stringify({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), error: { code: -32000, message: fault.message ?? "Injected by the harness" } });
      record({ k: "in", c: link.conn, t: now(), m: answer, injected: true });
      socket.send(answer);
      return true;
    }
    case "close":
      socket.close(fault.code ?? 1011, "injected");
      return true;
    case "drop":
      link.dropId = message.id;
      return false;
    case "kill":
      deliver(link, text);
      if (chromePid) process.kill(chromePid, "SIGKILL");
      return true;
    case "stop":
      deliver(link, text);
      if (chromePid) {
        process.kill(chromePid, "SIGSTOP");
        setTimeout(() => process.kill(chromePid, "SIGCONT"), (fault.seconds ?? 1) * 1000);
      }
      return true;
  }
  return false;
}

function askChromium(link: Link, sessionId: string | undefined, method: string, params: Record<string, unknown>, then: Asked["then"]): void {
  emulatedId += 1;
  const text = JSON.stringify({ id: emulatedId, method, params, ...(sessionId ? { sessionId } : {}) });
  emulations.set(emulatedId, { link, then });
  record({ k: "emulated", c: link.conn, t: now(), m: text });
  deliver(link, text);
}

function answerDaemon(link: Link, socket: ServerWebSocket<Link>, id: number, sessionId: string | undefined, error?: unknown): void {
  const reply = JSON.stringify({ id, ...(sessionId ? { sessionId } : {}), ...(error === undefined ? { result: {} } : { error }) });
  record({ k: "in", c: link.conn, t: now(), m: reply, emulated: true });
  socket.send(reply);
}

type Asking = { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown> };

function emulateClick(link: Link, socket: ServerWebSocket<Link>, message: Asking): void {
  const params = message.params ?? {};
  const button = params["button"] === "right" ? "right" : "left";
  const event = (type: string, buttons: number) => ({ type, x: params["x"], y: params["y"], button, buttons, clickCount: params["clickCount"], modifiers: params["modifiers"] });
  askChromium(link, message.sessionId, "Input.dispatchMouseEvent", event("mousePressed", button === "right" ? 2 : 1), (pressed) => {
    if (pressed.error) return answerDaemon(link, socket, message.id as number, message.sessionId, pressed.error);
    askChromium(link, message.sessionId, "Input.dispatchMouseEvent", event("mouseReleased", 0), (released) => answerDaemon(link, socket, message.id as number, message.sessionId, released.error));
  });
}

function emulateHiddenWheel(link: Link, socket: ServerWebSocket<Link>, message: Asking, text: string): void {
  askChromium(link, message.sessionId, "Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }, (answer) => {
    const state = String((answer.result?.["result"] as { value?: unknown } | undefined)?.value ?? "unknown");
    record({ k: "visibility", c: link.conn, t: now(), wheel: message.id, state });
    if (state === "hidden") answerDaemon(link, socket, message.id as number, message.sessionId, { code: -32000, message: refusalMessage("page_hidden") });
    else deliver(link, text);
  });
}

function emulated(link: Link, socket: ServerWebSocket<Link>, text: string): boolean {
  if (!emulateClicks && !emulateHiddenWheels) return false;
  const message = parse(text) as Asking | null;
  if (!message || message.id === undefined) return false;
  if (emulateClicks && message.method === "Ardia.dispatchClick") emulateClick(link, socket, message);
  else if (emulateHiddenWheels && message.method === "Input.dispatchMouseEvent" && message.params?.["type"] === "mouseWheel") emulateHiddenWheel(link, socket, message, text);
  else return false;
  return true;
}

type Hold = { target: string; front: string; on: boolean };
let hold: Hold | null = null;
let ownerSocket: WebSocket | null = null;
let ownerId = 0;
const ownerWaiting = new Map<number, () => void>();

async function owner(): Promise<WebSocket> {
  if (ownerSocket !== null && ownerSocket.readyState === WebSocket.OPEN) return ownerSocket;
  const real = (JSON.parse(await versionBody()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
  const socket = new WebSocket(real, { perMessageDeflate: false } as unknown as string[]);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  socket.onmessage = (event) => {
    const id = (JSON.parse(String(event.data)) as { id?: number }).id;
    if (id !== undefined) ownerWaiting.get(id)?.();
  };
  ownerSocket = socket;
  return socket;
}

async function activate(targetId: string): Promise<void> {
  const socket = await owner();
  ownerId += 1;
  const id = ownerId;
  socket.send(JSON.stringify({ id, method: "Target.activateTarget", params: { targetId } }));
  await new Promise<void>((resolve) => ownerWaiting.set(id, resolve));
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function holdFor(argv: unknown): Promise<void> {
  if (!emulateHold || hold === null || !Array.isArray(argv) || !actingStep(argv)) return;
  await activate(hold.target);
  hold.on = true;
  record({ k: "hold", t: now(), state: "on", target: hold.target });
}

async function releaseHold(): Promise<void> {
  if (hold === null || !hold.on) return;
  await activate(hold.front);
  hold.on = false;
  record({ k: "hold", t: now(), state: "off", target: hold.target });
}

function emulatedAnswer(text: string): boolean {
  const id = Number(/^\{"id":(\d+)/u.exec(text)?.[1] ?? 0);
  if (id <= EMULATED_IDS) return false;
  const asked = emulations.get(id);
  if (asked === undefined) return false;
  emulations.delete(id);
  record({ k: "emulated", c: asked.link.conn, t: now(), m: text });
  asked.then(JSON.parse(text) as Parameters<Asked["then"]>[0]);
  return true;
}

function openUpstream(link: Link, socket: ServerWebSocket<Link>): void {
  void versionBody().then((body) => {
    const real = (JSON.parse(body) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
    const upstream = new WebSocket(real, { perMessageDeflate: false } as unknown as string[]);
    link.upstream = upstream;
    upstream.onopen = () => {
      for (const text of link.queue.splice(0)) upstream.send(text);
    };
    const pending: string[] = [];
    let quiet: ReturnType<typeof setTimeout> | null = null;
    let burstStarted = 0;
    const flush = () => {
      if (quiet) clearTimeout(quiet);
      quiet = null;
      const batch = pending.splice(0);
      socket.cork(() => {
        for (const text of batch) socket.send(text);
      });
    };
    upstream.onmessage = (event) => {
      const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      if (emulatedAnswer(text)) return;
      record({ k: "in", c: link.conn, t: now(), m: text });
      if (link.dropId !== null && text.startsWith(`{"id":${link.dropId},`)) {
        link.dropId = null;
        record({ k: "dropped", c: link.conn, t: now() });
        return;
      }
      if (pending.length > 0 && performance.now() - burstStarted >= BURST_MAX_MS) flush();
      if (pending.push(text) === 1) burstStarted = performance.now();
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(flush, BURST_QUIET_MS);
    };
    upstream.onclose = (event) => {
      flush();
      record({ k: "close", c: link.conn, t: now(), by: "browser", code: event.code });
      if (event.code === 1006 || event.code === 1005) socket.terminate();
      else socket.close(event.code);
    };
  }, (error: unknown) => {
    record({ k: "close", c: link.conn, t: now(), by: "browser", code: 1006, why: String(error) });
    socket.terminate();
  });
}

function startReplay(link: Link, socket: ServerWebSocket<Link>): void {
  const entries = recording.filter((entry) => entry.c === link.conn && (entry.k === "in" || entry.k === "out" || entry.k === "close"));
  if (entries.length === 0) {
    const report = `the daemon opened connection ${link.conn}, which the recording doesn't have`;
    failures.push(report);
    record({ k: "mismatch", c: link.conn, t: now(), report });
    socket.close(4000);
    return;
  }
  link.replay = new ReplayConn(entries, {
    batch: (work) => {
      socket.cork(work);
    },
    send: (text) => {
      record({ k: "in", c: link.conn, t: now(), m: text });
      socket.send(text);
    },
    close: (code) => {
      record({ k: "close", c: link.conn, t: now(), by: "browser", code });
      if (code === 1006 || code === 1005) socket.terminate();
      else socket.close(code);
    },
    note: (kind, form) => {
      elasticCounts[kind] = (elasticCounts[kind] ?? 0) + 1;
      record({ k: "elastic", c: link.conn, t: now(), kind, form });
    },
    fail: (report) => {
      failures.push(report);
      record({ k: "mismatch", c: link.conn, t: now(), report });
      process.stderr.write(`tap: ${report}\n`);
    },
  }, elastic, recordedScratch, scratch, options.get("--pace") === "recorded");
  link.replay.start();
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function control(request: Request, path: string): Promise<Response> {
  if (path === "/tap/state") {
    const remaining = [...links].flatMap((link) => link.replay?.remaining() ?? []);
    return json({ requests, connections, held: held !== null, fired, failures, elastic: elasticCounts, remaining: remaining.length, remainingForms: remaining.slice(0, 5) });
  }
  const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
  if (path === "/tap/fault") {
    fault = body["kind"] ? (body as unknown as Fault) : null;
    faultBase = requests;
    matched = 0;
    fired = false;
    return json({ ok: true, base: faultBase });
  }
  if (path === "/tap/release") {
    const was = held;
    held = null;
    if (was) {
      record({ k: "released", c: was.link.conn, t: now() });
      deliver(was.link, was.text);
    }
    return json({ ok: true, released: was !== null });
  }
  if (path === "/tap/mark") {
    record({ k: "mark", t: now(), step: body["step"] as number | string, ...(Array.isArray(body["argv"]) ? { argv: body["argv"] } : {}) });
    await holdFor(body["argv"]);
    return json({ ok: true });
  }
  if (path === "/tap/done") {
    record({ k: "done", t: now(), step: body["step"] as number | string });
    return json({ ok: true });
  }
  if (path === "/tap/hold") {
    hold = typeof body["target"] === "string" && typeof body["front"] === "string" ? { target: body["target"], front: body["front"], on: false } : null;
    return json({ ok: true });
  }
  if (path === "/tap/unhold") {
    await releaseHold();
    return json({ ok: true });
  }
  if (path === "/tap/quit") {
    setTimeout(() => process.exit(0), 10);
    return json({ ok: true });
  }
  return json({ error: "unknown" }, 404);
}

const server = Bun.serve<Link>({
  hostname: "127.0.0.1",
  port: listen,
  async fetch(request, srv) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/tap/")) return control(request, path);
    if (path === "/json/version") return new Response(rewriteVersion(await versionBody()), { headers: { "content-type": "application/json" } });
    if (path.startsWith("/devtools/browser/")) {
      const link: Link = { conn: connections, upstream: null, queue: [], replay: null, dropId: null };
      connections += 1;
      if (srv.upgrade(request, { data: link })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    }
    record({ k: "http", t: now(), path });
    return new Response("not found", { status: 404 });
  },
  websocket: {
    maxPayloadLength: MAX_PAYLOAD,
    perMessageDeflate: false,
    idleTimeout: 0,
    open(socket) {
      const link = socket.data;
      links.add(link);
      record({ k: "open", c: link.conn, t: now() });
      if (replayPath) startReplay(link, socket);
      else openUpstream(link, socket);
    },
    message(socket, data) {
      const link = socket.data;
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      record({ k: "out", c: link.conn, t: now(), m: text });
      if (injected(link, text, socket)) return;
      if (emulated(link, socket, text)) return;
      deliver(link, text);
    },
    close(socket, code) {
      const link = socket.data;
      record({ k: "close", c: link.conn, t: now(), by: "daemon", code });
      if (link.upstream && link.upstream.readyState <= WebSocket.OPEN) link.upstream.close();
    },
  },
});

process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});
process.stdout.write(`${JSON.stringify({ listening: server.port })}\n`);
