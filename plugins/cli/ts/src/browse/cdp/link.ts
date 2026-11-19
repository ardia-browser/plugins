import { isIP } from "node:net";
import { reprStr } from "../../py.ts";
import { formatG } from "../../pylib/format.ts";
import { Cancelled, checkCancelled, currentSignal, later, untilCancelled } from "./cancel.ts";
import { ATTACH_METHODS, checkCommand, checkMessage, ForbiddenCommand } from "./guard.ts";
import { pyText, pyTruthy } from "./pyvalue.ts";

export type Message = Record<string, unknown>;
export type Command = { method?: unknown; params?: unknown; sessionId?: unknown; [key: string]: unknown };
export type EventCallback = (method: string, params: unknown, session: unknown) => void;

const OPEN = 1;
const CLOSE_WAIT = 3;

export const linkLog: { problem(what: string, error: unknown): void } = { problem() {} };

export class ConnectionLost extends Error {
  override readonly name = "ConnectionLost";

  constructor() {
    super("");
  }
}

export class OpenFailed extends Error {
  endpoint = "";

  constructor(
    readonly pythonType: string,
    message: string,
  ) {
    super(message);
  }

  override get name(): string {
    return this.pythonType;
  }
}

export class CdpFailure extends Error {}

export class CommandTimeout extends CdpFailure {
  constructor(
    readonly method: unknown,
    readonly timeout: number,
  ) {
    super(`${pyText(method)} got no answer in ${formatG(timeout)}s`);
  }
}

export class CommandFailed extends CdpFailure {
  readonly code: unknown;
  readonly detail: unknown;

  constructor(
    readonly method: unknown,
    error: unknown,
  ) {
    const fields = isObject(error) ? error : null;
    const code = fields === null ? 0 : Object.hasOwn(fields, "code") ? fields["code"] : 0;
    const said = fields === null ? null : fields["message"];
    const detail = pyTruthy(said) ? said : "";
    super(pyTruthy(detail) ? pyText(detail) : `${pyText(method)} failed`);
    this.code = code;
    this.detail = detail;
  }
}

export function isObject(value: unknown): value is Message {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function timerMs(timeout: number | null): number | null {
  return timeout === null || Number.isNaN(timeout) || timeout === Number.POSITIVE_INFINITY ? null : Math.max(0, timeout * 1000);
}

export function safeEndpoint(url: string): string {
  const parts = /^([^:/?#]+:)?(\/\/[^/?#]*)?([^?#]*)/su.exec(url);
  const scheme = parts?.[1] ?? "";
  const authority = parts?.[2] ?? "";
  const host = authority === "" ? "" : `//${authority.slice(authority.lastIndexOf("@") + 1).replace(/^\/\//u, "")}`;
  return `${scheme}${host}${parts?.[3] ?? ""}`;
}

function checkedPort(port: string): void {
  if (port === "") return;
  if (!/^[0-9]+$/u.test(port)) throw new OpenFailed("ValueError", `Port could not be cast to integer value as ${reprStr(port)}`);
  if (Number(port) > 65535) throw new OpenFailed("ValueError", "Port out of range 0-65535");
}

function checkedBracketedHost(host: string): void {
  if (host.startsWith("v")) {
    if (!/^v[a-fA-F0-9]+\..+$/su.test(host)) throw new OpenFailed("ValueError", "IPvFuture address is invalid");
    return;
  }
  const kind = isIP(host);
  if (kind === 0) throw new OpenFailed("ValueError", `${reprStr(host)} does not appear to be an IPv4 or IPv6 address`);
  if (kind === 4) throw new OpenFailed("ValueError", "An IPv4 address cannot be in brackets");
}

function checkedUrl(url: string): void {
  const split = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/su.exec(url);
  const scheme = split === null ? "" : (split[1] as string).toLowerCase();
  const rest = split === null ? url : (split[2] as string);
  const authority = rest.startsWith("//") ? (rest.slice(2).split(/[/?#]/u)[0] as string) : "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (authority.includes("[") !== authority.includes("]")) throw new OpenFailed("ValueError", "Invalid IPv6 URL");
  let host: string;
  let port: string;
  if (hostPort.includes("[")) {
    const before = hostPort.slice(0, hostPort.indexOf("["));
    const bracketed = hostPort.slice(hostPort.indexOf("[") + 1);
    host = bracketed.slice(0, bracketed.indexOf("]"));
    const after = bracketed.slice(bracketed.indexOf("]") + 1);
    if (before !== "" || (after !== "" && !after.startsWith(":"))) throw new OpenFailed("ValueError", "Invalid IPv6 URL");
    checkedBracketedHost(host);
    port = after.slice(1);
  } else {
    const colon = hostPort.indexOf(":");
    host = colon < 0 ? hostPort : hostPort.slice(0, colon);
    port = colon < 0 ? "" : hostPort.slice(colon + 1);
  }
  if ((scheme !== "ws" && scheme !== "wss") || host === "") throw new OpenFailed("HandshakeError", `not a ws:// URL: ${scheme}://`);
  checkedPort(port);
}

function openFailure(said: string): OpenFailed {
  if (/\b101\b/u.test(said)) return new OpenFailed("HandshakeError", "server rejected WebSocket connection (Expected 101 status code)");
  if (said.includes("Failed to connect")) return new OpenFailed("ConnectionError", "Failed to connect");
  return new OpenFailed("ConnectionError", "the WebSocket connection failed");
}

function nameOnly(error: unknown): Error {
  return new Error(error instanceof Error ? error.name : typeof error);
}

const decoder = new TextDecoder("utf-8", { fatal: true });

type Pending = { settle(reply: Message): void; fail(error: Error): void };
type State = "idle" | "connecting" | "open" | "closing" | "closed";

export class CdpLink {
  readonly pending = new Map<number, Pending>();
  readonly attaching = new Set<number>();
  readonly listeners: EventCallback[] = [];
  closedWith: { code: number; reason: string } | null = null;
  private readonly handlers = new Map<string, EventCallback[]>();
  private socket: WebSocket | null = null;
  private state: State = "idle";
  private opening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private stopConnecting: (() => void) | null = null;
  private nextId = 1;
  private isLost = false;
  private readonly lostPromise: Promise<void>;
  private markLost: () => void = () => {};

  constructor(
    readonly url: string,
    readonly maxSize: number | null = null,
  ) {
    this.lostPromise = new Promise((resolve) => {
      this.markLost = resolve;
    });
  }

  get lost(): boolean {
    return this.isLost;
  }

  get connected(): boolean {
    return this.state === "open" && !this.isLost;
  }

  get endpoint(): string {
    return safeEndpoint(this.url);
  }

  whenLost(): Promise<void> {
    return this.lostPromise;
  }

  get extensions(): string | null {
    return this.socket === null ? null : this.socket.extensions;
  }

  open(timeout: number | null = null, signal: AbortSignal | null = currentSignal()): Promise<void> {
    if (this.opening !== null) return this.opening;
    if (this.state !== "idle" || this.isLost) return Promise.reject(new ConnectionLost());
    const endpoint = this.endpoint;
    const opening = this.connect(timeout, signal)
      .catch((error: unknown) => {
        if (error instanceof OpenFailed) error.endpoint = endpoint;
        throw error;
      })
      .finally(() => {
        this.opening = null;
      });
    this.opening = opening;
    return opening;
  }

  private async connect(timeout: number | null, signal: AbortSignal | null): Promise<void> {
    checkCancelled(signal);
    const endpoint = this.endpoint;
    checkedUrl(this.url);
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url, { perMessageDeflate: false } as unknown as ConstructorParameters<typeof WebSocket>[1]);
    } catch {
      throw new OpenFailed("ValueError", `the endpoint isn't a URL a WebSocket can open (${endpoint})`);
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.state = "connecting";
    let said = "";
    let stopTimer = () => {};
    const opened = new Promise<void>((resolve, reject) => {
      this.stopConnecting = () => reject(new ConnectionLost());
      socket.onopen = () => resolve();
      socket.onerror = (event) => {
        said = String((event as { message?: unknown }).message ?? "");
      };
      socket.onclose = (event) => reject(openFailure(`${said} ${event.reason}`));
      const ms = timerMs(timeout);
      if (ms !== null) stopTimer = later(ms, () => reject(new OpenFailed("TimeoutError", "")));
    });
    try {
      await untilCancelled(opened, signal);
    } catch (error) {
      socket.onopen = socket.onclose = socket.onerror = null;
      abandon(socket);
      if (this.state === "connecting") {
        this.state = "idle";
        this.socket = null;
      }
      throw error;
    } finally {
      stopTimer();
      this.stopConnecting = null;
    }
    if (this.state !== "connecting") {
      abandon(socket);
      throw new ConnectionLost();
    }
    this.state = "open";
    socket.onerror = null;
    socket.onmessage = (event) => this.received(event.data);
    socket.onclose = (event) => {
      this.closedWith ??= { code: event.code, reason: event.reason };
      this.lose();
    };
  }

  on(method: string, callback: EventCallback): void {
    const list = this.handlers.get(method);
    if (list === undefined) this.handlers.set(method, [callback]);
    else list.push(callback);
  }

  reserveAttach(limit: number): number | null {
    if (this.attaching.size >= limit) return null;
    const ident = this.nextId++;
    this.attaching.add(ident);
    return ident;
  }

  async execute(command: Command, timeout: number | null = 60, ident?: number, signal: AbortSignal | null = currentSignal()): Promise<Message> {
    const id = ident ?? this.nextId++;
    let text: string;
    let socket: WebSocket;
    try {
      checkCommand(command);
      socket = this.usable();
      if (signal?.aborted) throw new Cancelled();
      if (timeout !== null && timeout <= 0) throw new CommandTimeout(command.method, timeout);
      text = this.envelope(command, id, ident !== undefined && this.attaching.has(ident));
    } catch (error) {
      this.attaching.delete(id);
      throw error;
    }
    const method = command.method;
    return new Promise<Message>((resolve, reject) => {
      let stopTimer = () => {};
      const stop = () => fail(new Cancelled());
      const done = () => {
        this.pending.delete(id);
        this.attaching.delete(id);
        stopTimer();
        signal?.removeEventListener("abort", stop);
      };
      const fail = (error: Error) => {
        done();
        reject(error);
      };
      this.pending.set(id, {
        settle: (reply) => {
          done();
          setImmediate(() => {
            if (signal?.aborted) reject(new Cancelled());
            else if (Object.hasOwn(reply, "error")) reject(new CommandFailed(method, reply["error"]));
            else resolve(reply);
          });
        },
        fail,
      });
      signal?.addEventListener("abort", stop, { once: true });
      const ms = timerMs(timeout);
      if (ms !== null) stopTimer = later(ms, () => fail(new CommandTimeout(method, timeout as number)));
      if (socket.readyState !== OPEN || this.state !== "open") {
        fail(new ConnectionLost());
        return;
      }
      try {
        socket.send(text);
      } catch (error) {
        fail(new ConnectionLost());
        this.drop(error);
      }
    });
  }

  async executeNoWait(command: Command): Promise<void> {
    checkCommand(command);
    const socket = this.usable();
    const text = this.envelope(command, this.nextId++, false);
    if (socket.readyState !== OPEN) throw new ConnectionLost();
    try {
      socket.send(text);
    } catch (error) {
      this.drop(error);
      throw new ConnectionLost();
    }
  }

  close(): Promise<void> {
    if (this.closing === null) this.closing = this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    const socket = this.socket;
    const was = this.state;
    this.state = "closing";
    if (was === "connecting") this.stopConnecting?.();
    if (was === "open" && socket !== null && !this.isLost && socket.readyState === OPEN) {
      try {
        socket.close(1000);
      } catch (error) {
        linkLog.problem("closing the CDP connection failed", nameOnly(error));
      }
      let stopTimer = () => {};
      await Promise.race([this.lostPromise, new Promise<void>((resolve) => (stopTimer = later(CLOSE_WAIT * 1000, resolve)))]);
      stopTimer();
    }
    if (socket !== null) abandon(socket);
    this.lose();
  }

  private envelope(command: Command, id: number, reserved: boolean): string {
    const text = JSON.stringify({ ...command, id });
    const sent = checkMessage(text);
    const only = sent.length === 1 && isObject(sent[0]) ? sent[0] : null;
    if (only === null || only["id"] !== id) throw new ForbiddenCommand("ardia only sends one whole command at a time");
    const method = only["method"];
    if (typeof method === "string" && ATTACH_METHODS.has(method) && !reserved) {
      throw new ForbiddenCommand(`${method} goes through claimedAttach, which bounds the attaches left unanswered`);
    }
    return text;
  }

  private usable(): WebSocket {
    if (this.socket === null || this.isLost || this.state !== "open") throw new ConnectionLost();
    return this.socket;
  }

  private drop(error: unknown): void {
    linkLog.problem("sending on the CDP connection failed", nameOnly(error));
    const socket = this.socket;
    this.lose();
    if (socket !== null) abandon(socket);
  }

  private received(data: unknown): void {
    if (this.isLost) return;
    let text: string;
    if (typeof data === "string") {
      if (this.maxSize !== null && utf8Over(data, this.maxSize)) return this.refuse(1009, `a message over ${this.maxSize} bytes`);
      text = data;
    } else {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
      if (bytes === null) return;
      if (this.maxSize !== null && bytes.byteLength > this.maxSize) return this.refuse(1009, `a message over ${this.maxSize} bytes`);
      try {
        text = decoder.decode(bytes);
      } catch {
        return;
      }
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObject(message)) return;
    const ident = message["id"];
    const id = typeof ident === "boolean" ? Number(ident) : typeof ident === "number" && Number.isInteger(ident) ? ident : null;
    if (id !== null) {
      this.attaching.delete(id);
      const waiting = this.pending.get(id);
      this.pending.delete(id);
      waiting?.settle(message);
    } else if (typeof message["method"] === "string") {
      this.dispatch(message["method"], message);
    }
  }

  private dispatch(method: string, message: Message): void {
    const params = pyTruthy(message["params"]) ? message["params"] : {};
    const session = message["sessionId"] ?? null;
    for (const callback of [...(this.handlers.get(method) ?? []), ...this.listeners]) {
      try {
        callback(method, params, session);
      } catch (error) {
        linkLog.problem("CDP event handler failed", error);
      }
    }
  }

  private refuse(code: number, reason: string): void {
    this.closedWith = { code, reason };
    const socket = this.socket;
    this.lose();
    if (socket === null) return;
    try {
      socket.close(code, truncatedUtf8(reason, 120));
    } catch (error) {
      linkLog.problem("closing the CDP connection failed", nameOnly(error));
    }
    abandon(socket);
  }

  private lose(): void {
    this.state = "closed";
    if (this.isLost) return;
    this.isLost = true;
    this.attaching.clear();
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const one of waiting) one.fail(new ConnectionLost());
    this.markLost();
  }
}

function abandon(socket: WebSocket): void {
  socket.onmessage = null;
  const terminate = (socket as unknown as { terminate?: () => void }).terminate;
  try {
    if (typeof terminate === "function") terminate.call(socket);
    else socket.close();
  } catch (error) {
    linkLog.problem("dropping the CDP connection failed", nameOnly(error));
  }
}

function utf8Over(text: string, limit: number): boolean {
  if (text.length > limit) return true;
  if (text.length * 3 <= limit) return false;
  return Buffer.byteLength(text, "utf8") > limit;
}

function truncatedUtf8(text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= limit) return text;
  return new TextDecoder("utf-8").decode(bytes.subarray(0, limit)).replace(/�$/u, "");
}
