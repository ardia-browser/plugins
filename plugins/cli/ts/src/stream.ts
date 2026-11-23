import { createConnection, type Socket } from "node:net";
import { checkSocket, ControlFailure, NOT_REACHABLE } from "./control.ts";
import { dumps, field, type JsonObject, object, parse, same, TooDeep, type Value } from "./json.ts";
import { peerUid } from "./libc.ts";
import { baseName, errnoOf, LINUX, strerror, uid } from "./paths.ts";
import { MAX_LINE_BYTES, MIN_APP_PROTOCOL, PROTOCOL } from "./protocol.ts";
import { strOf, truthy } from "./py.ts";
import { utf8 } from "./pystr.ts";

export const CONNECT_TIMEOUT = 5;
export const CALL_TIMEOUT = 30;
export const EVENT_QUEUE_CAP = 1000;
export const DECIDE_QUEUE_CAP = 256;
const CONTROL_JSON_DEPTH = 9991;
const ENOENT = 2;
const ECONNREFUSED = LINUX ? 111 : 61;

export class Unreachable extends Error {
  constructor(
    message: string,
    public sent = false,
  ) {
    super(message);
  }
}

export class Incompatible extends Unreachable {}

export class MethodError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function unreachable(detail?: string): Unreachable {
  return new Unreachable(detail === undefined ? NOT_REACHABLE : `${NOT_REACHABLE} (${detail})`);
}

export type EventLine = { event: JsonObject; raw: string };

type Waiter<T> = { resolve: (value: T) => void; reject: (error: unknown) => void };

class Queue<T> {
  items: T[] = [];
  waiters: Waiter<T>[] = [];
  closedWith: (() => unknown) | undefined;

  put(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter.resolve(item);
    else this.items.push(item);
  }

  get size(): number {
    return this.items.length;
  }

  shift(): T | undefined {
    return this.items.shift();
  }

  close(error: () => unknown): void {
    this.closedWith = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error());
  }

  get(): Promise<T> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift() as T);
    if (this.closedWith !== undefined) return Promise.reject(this.closedWith());
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  forget(waiter: Waiter<T>): void {
    this.waiters = this.waiters.filter((entry) => entry !== waiter);
  }
}

type Pending = { resolve: (reply: JsonObject) => void; reject: (error: unknown) => void };

export class StreamConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 0n;
  private pending = new Map<bigint, Pending>();
  private events = new Queue<EventLine>();
  private decides = new Queue<JsonObject>();
  private dropped = 0;
  private lost: string | undefined;
  eventCap = EVENT_QUEUE_CAP;
  info: JsonObject = new Map();

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => this.received(chunk));
    socket.on("end", () => this.lose("Ardia closed the connection"));
    socket.on("close", () => this.lose("Ardia closed the connection"));
    socket.on("error", (error) => this.lose(`the connection broke (${strerror(errnoOf(error))})`));
  }

  get closed(): boolean {
    return this.lost !== undefined;
  }

  private lose(reason: string): void {
    if (this.lost !== undefined) return;
    this.lost = reason;
    for (const request of this.pending.values()) request.reject(unreachable(reason));
    this.pending.clear();
    const error = () => unreachable(reason);
    this.events.close(error);
    this.decides.close(error);
    this.socket.destroy();
  }

  private received(chunk: Buffer): void {
    if (this.lost !== undefined) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf(0x0a);
      if (end < 0) break;
      const line = this.buffer.subarray(0, end + 1);
      this.buffer = this.buffer.subarray(end + 1);
      if (line.length > MAX_LINE_BYTES + 1) return this.lose("Ardia sent a line longer than 1 MB");
      let message: Value | undefined;
      try {
        message = parse(line, CONTROL_JSON_DEPTH);
      } catch (error) {
        if (!(error instanceof TooDeep)) throw error;
        message = undefined;
      }
      if (message === undefined) return this.lose("Ardia sent a line that isn't JSON");
      if (!(message instanceof Map)) continue;
      this.dispatch(message, line);
      if (this.lost !== undefined) return;
    }
    if (this.buffer.length > MAX_LINE_BYTES + 2) this.lose("Ardia sent a line longer than 1 MB");
  }

  private dispatch(message: JsonObject, line: Buffer): void {
    const ident = message.get("id");
    const waiting = typeof ident === "bigint" ? this.pending.get(ident) : undefined;
    if (waiting !== undefined && typeof ident === "bigint") {
      this.pending.delete(ident);
      waiting.resolve(message);
      return;
    }
    if (typeof message.get("decide") === "string") {
      if (this.decides.size >= DECIDE_QUEUE_CAP) this.decides.shift();
      this.decides.put(message);
      return;
    }
    if (typeof message.get("event") === "string") {
      if (this.events.size >= this.eventCap) {
        this.events.shift();
        this.dropped += 1;
      }
      const raw = Buffer.from(line).toString("utf8").replace(/\n+$/, "");
      this.events.put({ event: message, raw });
    }
  }

  call(method: string, params?: Value, timeout: number | null = CALL_TIMEOUT, requireOutcome = false): Promise<Value> {
    if (this.lost !== undefined) return Promise.reject(unreachable(this.lost));
    this.nextId += 1n;
    const ident = this.nextId;
    const request = object([
      ["id", ident],
      ["method", method],
    ]);
    if (params !== undefined) request.set("params", params);
    const line = utf8(`${dumps(request, "compact")}\n`);
    if (line.length > MAX_LINE_BYTES) return Promise.reject(new MethodError("bad_request", "the request is longer than 1 MB"));
    return new Promise<Value>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (timer !== undefined) clearTimeout(timer);
      };
      this.pending.set(ident, {
        resolve: (reply) => {
          finish();
          if (reply.has("error")) {
            const error = reply.get("error");
            const details = error instanceof Map ? error : new Map<string, Value>();
            const code = details.get("code");
            const message = details.get("message");
            reject(new MethodError(truthy(code) ? strOf(code) : "failed", truthy(message) ? strOf(message) : "failed"));
            return;
          }
          if (requireOutcome && !reply.has("result")) {
            reject(new Unreachable(`Ardia's answer to ${method} had neither a result nor an error`, true));
            return;
          }
          resolve(reply.get("result") ?? null);
        },
        reject: (error) => {
          finish();
          if (error instanceof Unreachable) error.sent = true;
          reject(error);
        },
      });
      if (timeout !== null) {
        timer = setTimeout(() => {
          this.pending.delete(ident);
          reject(new Unreachable(`${NOT_REACHABLE} (Ardia didn't answer ${method} in ${formatG(timeout)} s)`, true));
        }, timeout * 1000);
      }
      this.socket.write(line, (error) => {
        if (error === undefined || error === null) return;
        if (!this.pending.delete(ident)) return;
        finish();
        reject(new Unreachable(`${NOT_REACHABLE} (the connection broke (${strerror(errnoOf(error))}))`, true));
      });
    });
  }

  subscribe(names: readonly string[], extra?: JsonObject): Promise<Value> {
    const params: JsonObject = new Map([["events", [...names]]]);
    for (const [key, value] of extra ?? []) params.set(key, value);
    return this.call("subscribe", params);
  }

  nextDecide(): Promise<JsonObject> {
    return this.decides.get();
  }

  nextLine(): Promise<EventLine> {
    return this.events.get();
  }

  async nextEvent(): Promise<JsonObject> {
    return (await this.events.get()).event;
  }

  async answer(decide: string, answer: Value): Promise<boolean> {
    try {
      await this.call(
        "answer",
        object([
          ["decide", decide],
          ["answer", answer],
        ]),
        5,
      );
      return true;
    } catch (error) {
      if (error instanceof MethodError || error instanceof Unreachable) return false;
      throw error;
    }
  }

  takeDropped(): number {
    const dropped = this.dropped;
    this.dropped = 0;
    return dropped;
  }

  close(): void {
    this.lose("closed");
  }
}

export function formatG(value: number): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const [mantissa, exponentText] = value.toExponential(5).split("e") as [string, string];
  const exponent = Number(exponentText);
  const trim = (text: string) => (text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text);
  if (exponent < -4 || exponent >= 6) return `${trim(mantissa)}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  return trim(value.toFixed(Math.max(0, 5 - exponent)));
}

function connectSocket(path: string, timeout: number): Promise<Socket> {
  const name = baseName(path);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path, allowHalfOpen: true });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(unreachable(`${name} didn't accept in ${formatG(timeout)} s`));
    }, timeout * 1000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      const errno = errnoOf(error);
      socket.destroy();
      reject(errno === ENOENT || errno === ECONNREFUSED ? unreachable() : unreachable(`${name}: ${strerror(errno)}`));
    });
  });
}

function socketFd(socket: Socket): number | undefined {
  const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
  return typeof fd === "number" ? fd : undefined;
}

function checked(path: string): void {
  try {
    checkSocket(path);
  } catch (error) {
    if (error instanceof ControlFailure && error.failure.kind === "unreachable") throw new Unreachable(error.failure.message);
    throw error;
  }
}

export async function connectStream(path: string, caller: Value, timeout = CONNECT_TIMEOUT): Promise<StreamConnection> {
  checked(path);
  const name = baseName(path);
  const socket = await connectSocket(path, timeout);
  const fd = socketFd(socket);
  let peer: number | undefined;
  try {
    peer = fd === undefined ? undefined : peerUid(fd);
  } catch {
    peer = undefined;
  }
  if (peer !== uid()) {
    socket.destroy();
    throw unreachable(`${name} ${peer === undefined ? "couldn't check who serves it" : "is served by another user"}`);
  }
  const connection = new StreamConnection(socket);
  let info: Value;
  try {
    info = await connection.call("hello", object([["caller", caller], ["protocol", BigInt(PROTOCOL)]]), timeout);
    if (!(info instanceof Map) || !same(field(info, "app"), "Ardia")) throw unreachable(`something other than Ardia answers on ${name}`);
    const spokenValue = info.get("protocol");
    const spoken = typeof spokenValue === "bigint" ? spokenValue : 1n;
    if (spoken < BigInt(MIN_APP_PROTOCOL)) {
      const version = info.get("version");
      throw new Incompatible(`Ardia ${version === undefined ? "" : strOf(version)} speaks control protocol ${spoken}, and this ardia needs ${MIN_APP_PROTOCOL} or later: update Ardia`);
    }
  } catch (error) {
    connection.close();
    if (error instanceof MethodError) {
      if (error.code === "unsupported_protocol") throw new Incompatible(error.message);
      throw unreachable(`hello failed: ${error.message}`);
    }
    if (error instanceof Unreachable) error.sent = false;
    throw error;
  }
  connection.info = info;
  return connection;
}
