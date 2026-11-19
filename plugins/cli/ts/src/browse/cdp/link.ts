import { formatG } from "../../pylib/format.ts";
import { Cancelled, checkCancelled, currentSignal, later, untilCancelled } from "./cancel.ts";
import { checkCommand } from "./guard.ts";
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

function checkedUrl(url: string): string {
  const split = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/su.exec(url);
  const scheme = split === null ? "" : (split[1] as string).toLowerCase();
  const rest = split === null ? url : (split[2] as string);
  const authority = rest.startsWith("//") ? (rest.slice(2).split(/[/?#]/u)[0] as string) : "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (authority.includes("[") !== authority.includes("]")) throw new OpenFailed("ValueError", "Invalid IPv6 URL");
  const host = hostPort.startsWith("[") ? hostPort.slice(1, hostPort.indexOf("]")) : (hostPort.split(":")[0] as string);
  if ((scheme !== "ws" && scheme !== "wss") || host === "") throw new OpenFailed("HandshakeError", `not a ws:// URL: ${scheme}://`);
  return url;
}

function openFailure(said: string): OpenFailed {
  const reason = said.includes("failed: ") ? said.slice(said.lastIndexOf("failed: ") + 8) : said;
  if (/\b101\b/.test(reason)) return new OpenFailed("HandshakeError", `server rejected WebSocket connection (${reason})`);
  return new OpenFailed("ConnectionError", reason || "the connection failed");
}

const decoder = new TextDecoder("utf-8", { fatal: true });

type Pending = { settle(reply: Message): void; fail(error: Error): void };

export class CdpLink {
  readonly pending = new Map<number, Pending>();
  readonly attaching = new Set<number>();
  readonly listeners: EventCallback[] = [];
  closedWith: { code: number; reason: string } | null = null;
  private readonly handlers = new Map<string, EventCallback[]>();
  private socket: WebSocket | null = null;
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

  whenLost(): Promise<void> {
    return this.lostPromise;
  }

  get extensions(): string | null {
    return this.socket === null ? null : this.socket.extensions;
  }

  async open(timeout: number | null = null, signal: AbortSignal | null = currentSignal()): Promise<void> {
    if (this.socket !== null || this.isLost) throw new ConnectionLost();
    checkCancelled(signal);
    const url = checkedUrl(this.url);
    const socket = new WebSocket(url, { perMessageDeflate: false } as unknown as ConstructorParameters<typeof WebSocket>[1]);
    socket.binaryType = "arraybuffer";
    let said = "";
    let stopTimer = () => {};
    const opened = new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = (event) => {
        said = String((event as { message?: unknown }).message ?? "");
      };
      socket.onclose = (event) => reject(openFailure(said || event.reason));
      const ms = timerMs(timeout);
      if (ms !== null) stopTimer = later(ms, () => reject(new OpenFailed("TimeoutError", "")));
    });
    try {
      await untilCancelled(opened, signal);
    } catch (error) {
      socket.onopen = socket.onclose = socket.onerror = null;
      abandon(socket);
      throw error;
    } finally {
      stopTimer();
    }
    this.socket = socket;
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
    checkCommand(command);
    const socket = this.usable();
    const method = command.method;
    const id = ident ?? this.nextId++;
    if (signal?.aborted) {
      this.attaching.delete(id);
      throw new Cancelled();
    }
    if (timeout !== null && timeout <= 0) {
      this.attaching.delete(id);
      throw new CommandTimeout(method, timeout);
    }
    let text: string;
    try {
      text = JSON.stringify({ ...command, id });
    } catch (error) {
      this.attaching.delete(id);
      throw error;
    }
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
      if (socket.readyState !== OPEN || this.isLost) {
        fail(new ConnectionLost());
        return;
      }
      socket.send(text);
    });
  }

  async executeNoWait(command: Command): Promise<void> {
    checkCommand(command);
    const socket = this.usable();
    if (socket.readyState !== OPEN) throw new ConnectionLost();
    socket.send(JSON.stringify({ ...command, id: this.nextId++ }));
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (socket !== null && !this.isLost && socket.readyState === OPEN) {
      try {
        socket.close(1000);
      } catch (error) {
        linkLog.problem("closing the CDP connection failed", error);
      }
      let stopTimer = () => {};
      await Promise.race([this.lostPromise, new Promise<void>((resolve) => (stopTimer = later(CLOSE_WAIT * 1000, resolve)))]);
      stopTimer();
    }
    if (socket !== null) abandon(socket);
    this.lose();
  }

  private usable(): WebSocket {
    if (this.socket === null || this.isLost) throw new ConnectionLost();
    return this.socket;
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
      linkLog.problem("closing the CDP connection failed", error);
    }
    abandon(socket);
  }

  private lose(): void {
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
    linkLog.problem("dropping the CDP connection failed", error);
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
