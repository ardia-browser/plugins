import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import type { ServerWebSocket } from "bun";
import { type Entry, parse, readTranscript } from "./canon.ts";
import { type Elastic, ReplayConn } from "./replay.ts";

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
const EMULATED_IDS = 2_000_000_000;
let emulatedId = EMULATED_IDS;
type Emulation = { link: Link; socket: ServerWebSocket<Link>; id: number; sessionId: string | undefined; params: Record<string, unknown>; phase: "press" | "release" };
const emulations = new Map<number, Emulation>();
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

const recording = replayPath ? readTranscript(replayPath) : [];
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

function sendEmulated(emulation: Emulation): void {
  const { params } = emulation;
  const pressing = emulation.phase === "press";
  const button = params["button"] === "right" ? "right" : "left";
  emulatedId += 1;
  const text = JSON.stringify({
    id: emulatedId,
    method: "Input.dispatchMouseEvent",
    ...(emulation.sessionId ? { sessionId: emulation.sessionId } : {}),
    params: { type: pressing ? "mousePressed" : "mouseReleased", x: params["x"], y: params["y"], button, buttons: pressing ? (button === "right" ? 2 : 1) : 0, clickCount: params["clickCount"], modifiers: params["modifiers"] },
  });
  emulations.set(emulatedId, emulation);
  record({ k: "emulated", c: emulation.link.conn, t: now(), m: text });
  deliver(emulation.link, text);
}

function emulateClick(link: Link, socket: ServerWebSocket<Link>, text: string): boolean {
  const message = parse(text) as { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown> } | null;
  if (!message || message.method !== "Ardia.dispatchClick" || message.id === undefined) return false;
  sendEmulated({ link, socket, id: message.id, sessionId: message.sessionId, params: message.params ?? {}, phase: "press" });
  return true;
}

function emulatedAnswer(text: string): boolean {
  const id = Number(/^\{"id":(\d+)/u.exec(text)?.[1] ?? 0);
  if (id <= EMULATED_IDS) return false;
  const emulation = emulations.get(id);
  if (emulation === undefined) return false;
  emulations.delete(id);
  record({ k: "emulated", c: emulation.link.conn, t: now(), m: text });
  const answer = JSON.parse(text) as { error?: unknown };
  if (answer.error === undefined && emulation.phase === "press") {
    sendEmulated({ ...emulation, phase: "release" });
    return true;
  }
  const reply = JSON.stringify({ id: emulation.id, ...(emulation.sessionId ? { sessionId: emulation.sessionId } : {}), ...(answer.error === undefined ? { result: {} } : { error: answer.error }) });
  record({ k: "in", c: emulation.link.conn, t: now(), m: reply, emulated: true });
  emulation.socket.send(reply);
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
    record({ k: "mark", t: now(), step: body["step"] as number | string });
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
      if (emulateClicks && emulateClick(link, socket, text)) return;
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
