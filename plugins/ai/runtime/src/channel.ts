// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off effectFnOpportunity:off globalFetch:off
import * as Net from "node:net";

export type ChannelError = { code: string; message: string };
export type ChannelEvent = { event: string; time: number; data: Record<string, unknown> };
export type ToolCall = { call: string; tool: string; input: unknown; caller: { kind: string; plugin?: string }; deadline: number };

type Pending = { resolve: (value: unknown) => void; reject: (error: ChannelRequestError) => void; timer: ReturnType<typeof setTimeout> };

export class ChannelRequestError extends Error {
  readonly code: string;

  constructor(error: ChannelError) {
    super(error.message);
    this.code = error.code;
  }
}

export type Transport = {
  write: (line: string) => void;
  onLine: (handler: (line: string) => void) => void;
  onClose: (handler: () => void) => void;
  close: () => void;
};

export function socketTransport(socket: Net.Socket): Transport {
  let buffer = "";
  const lineHandlers: Array<(line: string) => void> = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) for (const handler of lineHandlers) handler(line);
      newline = buffer.indexOf("\n");
    }
  });
  return {
    write: (line) => void socket.write(`${line}\n`),
    onLine: (handler) => void lineHandlers.push(handler),
    onClose: (handler) => void socket.on("close", handler),
    close: () => socket.destroy(),
  };
}

export function fdTransport(fd: number): Transport {
  return socketTransport(new Net.Socket({ fd, readable: true, writable: true }));
}

export class Channel {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventHandlers = new Set<(event: ChannelEvent) => void>();
  private readonly pageHandlers = new Set<(message: unknown, view: string) => void>();
  private callHandler: ((call: ToolCall) => Promise<unknown>) | null = null;
  private closed = false;
  private readonly closeHandlers = new Set<() => void>();
  private readonly transport: Transport;
  private readonly timeoutMs: number;

  constructor(transport: Transport, timeoutMs = 30_000) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    transport.onLine((line) => this.receive(line));
    transport.onClose(() => this.shut());
  }

  get isClosed() {
    return this.closed;
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.timeoutMs, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new ChannelRequestError({ code: "closed", message: "Ardia's channel is closed." }));
    if (signal?.aborted) return Promise.reject(new ChannelRequestError({ code: "aborted", message: `${method} was cancelled before it was sent.` }));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const waiting = this.pending.get(id);
        if (!waiting) return;
        clearTimeout(waiting.timer);
        this.pending.delete(id);
        if (method !== "cancel") void this.request("cancel", { request: id }).catch(() => undefined);
        reject(new ChannelRequestError({ code: "aborted", message: `${method} was cancelled.` }));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        this.pending.delete(id);
        reject(new ChannelRequestError({ code: "timeout", message: `Ardia didn't answer ${method} in time.` }));
      }, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value: unknown) => {
          signal?.removeEventListener("abort", abort);
          (resolve as (value: unknown) => void)(value);
        },
        reject: (error: unknown) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
        timer,
      });
      this.transport.write(JSON.stringify({ id, method, params }));
    });
  }

  onEvent(handler: (event: ChannelEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onPageMessage(handler: (message: unknown, view: string) => void): () => void {
    this.pageHandlers.add(handler);
    return () => this.pageHandlers.delete(handler);
  }

  async postToPage(message: unknown, view: string): Promise<"ok" | "overloaded" | "gone"> {
    try {
      await this.request("page.post", { message, view });
      return "ok";
    } catch (error) {
      return error instanceof ChannelRequestError && error.code === "overloaded" ? "overloaded" : "gone";
    }
  }

  onClose(handler: () => void): () => void {
    if (this.closed) handler();
    else this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  serveTools(handler: (call: ToolCall) => Promise<unknown>) {
    this.callHandler = handler;
  }

  close() {
    this.transport.close();
    this.shut();
  }

  private shut() {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new ChannelRequestError({ code: "closed", message: "Ardia's channel closed." }));
    }
    this.pending.clear();
    for (const handler of this.closeHandlers) handler();
    this.closeHandlers.clear();
  }

  private receive(line: string) {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const p = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(p.timer);
      const error = message.error as ChannelError | undefined;
      if (error && typeof error === "object") p.reject(new ChannelRequestError({ code: String(error.code ?? "failed"), message: String(error.message ?? "failed") }));
      else p.resolve(message.result);
      return;
    }
    if ("pageMessage" in message && typeof message.view === "string") {
      for (const handler of this.pageHandlers) handler(message.pageMessage, message.view);
      return;
    }
    if (typeof message.event === "string") {
      const event = { event: message.event, time: Number(message.time ?? Date.now()), data: (message.data ?? {}) as Record<string, unknown> };
      for (const handler of this.eventHandlers) handler(event);
      return;
    }
    if (typeof message.call === "string" && typeof message.tool === "string") void this.answerCall(message as unknown as ToolCall);
  }

  private async answerCall(call: ToolCall) {
    if (!this.callHandler) {
      void this.request("result", { call: call.call, error: { code: "unknown_tool", message: "This plugin offers no tools." } }).catch(() => undefined);
      return;
    }
    try {
      const result = await this.callHandler(call);
      await this.request("result", { call: call.call, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.request("result", { call: call.call, error: { code: "failed", message } }).catch(() => undefined);
    }
  }
}
