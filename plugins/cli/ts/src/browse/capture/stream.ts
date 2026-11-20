import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import { dumps, type Value } from "../../json.ts";
import { Cancelled, shield } from "../cdp/cancel.ts";
import type { Ctx } from "../commands/ctx.ts";
import { register } from "../commands/index.ts";
import { parse } from "../commands/parse.ts";
import { BrowseError, Gated, Usage } from "../daemon-errors.ts";
import { log } from "../daemon/log.ts";
import { pyValue, Result } from "../daemon/render.ts";
import { pyError, pyIntArg } from "../pyerror.ts";
import type { Page } from "../state/page.ts";
import { type Json } from "../state/records.ts";
import { Screencast } from "./screencast.ts";
import { activate, captureOf, commandLockOf, releaseClaim } from "./store.ts";

export const STREAM_CLIENTS = 4;
export const STREAM_MESSAGE_LIMIT = 64 * 1024;
export const STREAM_INPUT_BACKLOG = 32;

type Client = { sent: number; pending: boolean; queue: Promise<void>; backlog: number; stop: AbortController };
type Socket = ServerWebSocket<Client>;
export type Stream = {
  cast: Screencast;
  clients: Set<Socket>;
  input: boolean;
  token: string;
  page: Page;
  server: Server<Client> | null;
  port: number;
  url: string;
  watcher: () => void;
};

type StreamInput = {
  readonly holding: boolean;
  trackStreamEvent?: (method: string, params: Json) => void;
  releaseAll?: () => Promise<boolean>;
};

const ALLOWED: Readonly<Record<string, [string, readonly string[]]>> = {
  input_mouse: ["Input.dispatchMouseEvent", ["type", "x", "y", "button", "clickCount", "deltaX", "deltaY", "modifiers"]],
  input_keyboard: ["Input.dispatchKeyEvent", ["type", "key", "code", "text", "modifiers", "windowsVirtualKeyCode"]],
  input_touch: ["Input.dispatchTouchEvent", ["type", "touchPoints", "modifiers"]],
};

function json(value: Record<string, unknown>): string {
  return dumps(pyValue(value) as Value, "spaced", true);
}

function refuse(status: number, text: string): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/plain" } });
}

function tokenUrlsafe(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function unquote(text: string): string {
  const spaced = text.replaceAll("+", " ");
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

function queryToken(url: string): string {
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1).split("#")[0] : "";
  for (const part of (query ?? "").split("&")) {
    const cut = part.indexOf("=");
    if (cut < 0) continue;
    const name = unquote(part.slice(0, cut));
    const value = unquote(part.slice(cut + 1));
    if (name === "token" && value !== "") return value;
  }
  return "";
}

function isMove(message: Json): boolean {
  return message["type"] === "input_mouse" && (message["eventType"] ?? message["type"]) === "mouseMoved";
}

function inputOf(page: Page): StreamInput {
  return page.input as unknown as StreamInput;
}

export async function streamInput(ctx: Ctx, page: Page, message: Json, signal: AbortSignal | null = null): Promise<void> {
  const kind = message["type"];
  if (typeof kind !== "string" || !Object.hasOwn(ALLOWED, kind)) return;
  const [method, keys] = ALLOWED[kind] as [string, readonly string[]];
  const params: Json = {};
  for (const key of keys) if (Object.hasOwn(message, key)) params[key] = message[key];
  if (Object.hasOwn(message, "eventType")) params["type"] = message["eventType"];
  const lock = commandLockOf(ctx.state);
  if (lock !== null) await lock.acquire(null, signal);
  try {
    const input = inputOf(page);
    input.trackStreamEvent?.(method, params);
    try {
      await page.send(method, params, { inputEvent: true });
    } catch (error) {
      if (!(error instanceof BrowseError)) throw error;
      await input.releaseAll?.();
    }
  } finally {
    lock?.release();
  }
}

async function releaseStreamInput(ctx: Ctx, page: Page | null): Promise<void> {
  if (page === null || !inputOf(page).holding) return;
  const lock = commandLockOf(ctx.state);
  if (lock !== null) await lock.acquire();
  try {
    await inputOf(page).releaseAll?.();
  } finally {
    lock?.release();
  }
}

function parsed(raw: string | Buffer): unknown {
  try {
    return JSON.parse(typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return undefined;
  }
}

function sendFrame(stream: Stream, socket: Socket): void {
  const latest = stream.cast.latest;
  if (latest === null || latest[0] === socket.data.sent) return;
  if (socket.getBufferedAmount() > 0) {
    socket.data.pending = true;
    return;
  }
  socket.data.pending = false;
  socket.data.sent = latest[0];
  socket.send(json({ type: "frame", seq: latest[0], data: latest[1], metadata: latest[2] }));
}

function bindError(error: unknown, port: number): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "EADDRINUSE") return pyError("OSError", `[Errno 48] error while attempting to bind on address ('127.0.0.1', ${port}): address already in use`);
  return error;
}

export function startStreamServer(ctx: Ctx, stream: Stream, port: number): Server<Client> {
  const allowedHosts = (bound: number) => [`127.0.0.1:${bound}`, `localhost:${bound}`];
  const allowedOrigins = (bound: number) => [`http://127.0.0.1:${bound}`, `http://localhost:${bound}`];
  try {
    return Bun.serve<Client>({
      hostname: "127.0.0.1",
      port,
      fetch(request, server) {
        const bound = server.port as number;
        const host = request.headers.get("host") ?? "";
        if (!allowedHosts(bound).includes(host)) return refuse(403, "Forbidden host");
        const origin = request.headers.get("origin");
        if (origin !== null && !allowedOrigins(bound).includes(origin)) return refuse(403, "Forbidden origin");
        if (!sameToken(queryToken(request.url), stream.token)) return refuse(401, "Missing or wrong token");
        if (stream.clients.size >= STREAM_CLIENTS) return refuse(503, "Too many clients");
        if (server.upgrade(request, { data: { sent: 0, pending: false, queue: Promise.resolve(), backlog: 0, stop: new AbortController() } })) return undefined;
        return refuse(426, "Failed to open a WebSocket connection: this endpoint only speaks WebSocket");
      },
      websocket: {
        perMessageDeflate: false,
        maxPayloadLength: STREAM_MESSAGE_LIMIT,
        open(socket) {
          stream.clients.add(socket);
          socket.send(json({ type: "status", connected: true, screencasting: true, input: stream.input }));
          sendFrame(stream, socket);
        },
        drain(socket) {
          if (socket.data.pending) sendFrame(stream, socket);
        },
        message(socket, raw) {
          const message = parsed(raw);
          if (message === null || typeof message !== "object" || Array.isArray(message)) return;
          const fields = message as Json;
          const kind = fields["type"] === undefined ? "" : fields["type"];
          if (!String(kind).startsWith("input_")) return;
          const client = socket.data;
          if (client.stop.signal.aborted) return;
          if (client.backlog > STREAM_INPUT_BACKLOG) {
            if (!isMove(fields)) socket.close(1008, "too much input queued");
            return;
          }
          client.backlog += 1;
          client.queue = client.queue
            .then(() =>
              shield(async () => {
                if (!stream.input) {
                  socket.send(json({ type: "error", error: "this stream is view only; restart it with `stream enable --input`" }));
                  return;
                }
                await streamInput(ctx, stream.page, fields, client.stop.signal);
              }),
            )
            .catch((error: unknown) => {
              if (error instanceof Cancelled) return;
              log.info(`stream client ended: ${String(error)}`);
              socket.close();
            })
            .finally(() => {
              client.backlog -= 1;
            });
        },
        close(socket) {
          socket.data.stop.abort(new Cancelled());
          stream.clients.delete(socket);
          if (stream.input) {
            socket.data.queue = socket.data.queue.then(() => shield(() => releaseStreamInput(ctx, stream.page)).catch(() => {}));
          }
        },
      },
    });
  } catch (error) {
    throw bindError(error, port);
  }
}

export async function cmdStream(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--port": "value", "--input": "bool" });
  const action = args[0] ?? "status";
  const capture = captureOf(ctx.state);
  const stream = capture.stream;
  if (action === "status") {
    if (stream === null) return new Result({ enabled: false, connected: false, screencasting: false }, "Streaming disabled");
    const connected = stream.clients.size > 0;
    const data = { enabled: true, port: stream.port, url: stream.url, connected, clients: stream.clients.size, screencasting: true, input: stream.input, frames: stream.cast.seq };
    return new Result(
      data,
      `Streaming enabled on ${stream.url}\nConnected: ${connected}\nScreencasting: true\nInput: ${stream.input ? "on" : "off (view only)"}`,
    );
  }
  if (action === "disable") {
    if (stream !== null) await stopStream(ctx);
    return new Result({ enabled: false }, "✓ Streaming disabled");
  }
  if (action !== "enable") throw new Usage("Usage: ardia browse stream enable [--port N] [--input] | disable | status");
  if (stream !== null) throw new BrowseError(`Streaming is already on at ${stream.url}`);
  const page = await ctx.state.page();
  await page.requireVisible();
  const env = (name: string) => (ctx.env[name] as string | undefined) || "";
  const quality = pyIntArg(env("AGENT_BROWSER_STREAM_QUALITY") || "80");
  const cast = new Screencast(
    page,
    Math.max(0, Math.min(100, quality)),
    pyIntArg(env("AGENT_BROWSER_STREAM_MAX_WIDTH") || "0") || null,
    pyIntArg(env("AGENT_BROWSER_STREAM_MAX_HEIGHT") || "0") || null,
  );
  await activate(ctx, page, "stream", async () => {
    try {
      await cast.start(ctx.state);
    } catch (error) {
      if (error instanceof Gated) throw error.during("stream enable");
      throw error;
    }
  });
  const port = pyIntArg((options["port"] as string | undefined) || env("AGENT_BROWSER_STREAM_PORT") || "0");
  const fresh: Stream = { cast, clients: new Set(), input: Boolean(options["input"]), token: tokenUrlsafe(24), page, server: null, port: 0, url: "", watcher: () => {} };
  let server: Server<Client>;
  try {
    server = startStreamServer(ctx, fresh, port);
  } catch (error) {
    await cast.stop(ctx.state);
    releaseClaim(ctx, page.targetId, "stream");
    throw error;
  }
  fresh.server = server;
  fresh.port = server.port as number;
  fresh.url = `ws://127.0.0.1:${fresh.port}/?token=${fresh.token}`;
  fresh.watcher = () => {
    for (const socket of [...fresh.clients]) sendFrame(fresh, socket);
  };
  cast.watchers.add(fresh.watcher);
  capture.stream = fresh;
  ctx.state.leases.add("stream");
  return new Result(
    { enabled: true, port: fresh.port, url: fresh.url, input: fresh.input },
    `✓ Streaming on ${fresh.url} (${fresh.input ? "input enabled" : "view only"})`,
  );
}

export async function stopStream(ctx: Ctx): Promise<void> {
  const capture = captureOf(ctx.state);
  const stream = capture.stream;
  capture.stream = null;
  if (stream === null) return;
  ctx.state.leases.delete("stream");
  releaseClaim(ctx, stream.page.targetId, "stream");
  stream.cast.watchers.delete(stream.watcher);
  for (const socket of [...stream.clients]) {
    socket.data.stop.abort(new Cancelled());
    socket.close(1000);
  }
  stream.server?.stop(true);
  await stream.cast.stop(ctx.state);
}

register("stream", cmdStream);
