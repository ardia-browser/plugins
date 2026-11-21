import { writeSync } from "node:fs";
import type { Socket } from "node:net";
import { dumps, field, object, parse, TooDeep, type Value } from "./json.ts";
import { errnoOf, strerror } from "./paths.ts";
import { MAX_LINE_BYTES } from "./protocol.ts";
import { utf8 } from "./pystr.ts";
import { formatG } from "./py.ts";

const CONTROL_JSON_DEPTH = 9991;
const HIGH_WATER = 64 * 1024;
const LOW_WATER = 16 * 1024;
const POLL_MS = 100;
const RETRY_WRITE_MS = 1;
const EAGAIN = new Set(["EAGAIN", "EWOULDBLOCK"]);
const EPIPE = 32;
const EVENT_QUEUE_CAP = 1000;
export const EVENT_QUEUE_BYTES = 32 * 1024 * 1024;
export const UNREADABLE_LINE = "Ardia sent a line nested too deeply to read";
const LOSSY_UTF8 = new TextDecoder("utf-8", { fatal: false });

type Pending = { reply?: Value; lost?: string };

export type EventLine = { message: Value; raw: string };

type Queued = EventLine & { size: number };

function retainedSize(value: Value): number {
  let size = 0;
  const pending: Value[] = [value];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    size += 16;
    if (typeof item === "string") size += item.length * 2;
    else if (Array.isArray(item)) {
      for (const child of item) pending.push(child);
    }
    else if (item instanceof Map) {
      for (const [key, child] of item) {
        size += 16 + key.length * 2;
        pending.push(child);
      }
    }
  }
  return size;
}

export class Stop extends Error {
  constructor(
    readonly reason: string,
    readonly kind: "closed" | "lost" | "timeout" | "interrupted" | "too_long",
  ) {
    super(reason);
  }
}

export class Connection {
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 0n;
  private lost: string | undefined;
  private readerStopped = false;
  private pending = new Map<bigint, Pending>();
  private unsent: Buffer[] = [];
  private unsentBytes = 0;
  private writeFailure: string | undefined;
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;
  private waiters = new Set<() => void>();
  private readonly wakeOnInterrupt = (): void => this.notify();
  private events: Queued[] = [];
  private eventBytes = 0;
  private dropped = 0;

  constructor(
    readonly socket: Socket,
    private readonly fd: number,
    private readonly interrupted: () => boolean,
    private readonly onWake: (wake: (() => void) | undefined) => void,
  ) {
    socket.on("data", (chunk: Buffer) => this.received(chunk));
    socket.on("end", () => this.lose("Ardia closed the connection"));
    socket.on("close", () => this.lose("Ardia closed the connection"));
    socket.on("error", (error) => this.lose(`the connection broke (${strerror(errnoOf(error))})`));
  }

  private notify(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }

  private failWriter(reason: string): void {
    this.writeFailure ??= reason;
    if (this.pumpTimer !== undefined) clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    this.unsent = [];
    this.unsentBytes = 0;
  }

  private lose(reason: string): void {
    if (this.lost !== undefined || this.readerStopped) return;
    this.lost = reason;
    this.failWriter(reason);
    for (const request of this.pending.values()) request.lost ??= reason;
    this.pending.clear();
    this.notify();
  }

  private received(chunk: Buffer): void {
    if (this.lost !== undefined || this.readerStopped) return;
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
        this.readerStopped = true;
        this.buffer = Buffer.alloc(0);
        this.failWriter(UNREADABLE_LINE);
        for (const request of this.pending.values()) request.lost ??= UNREADABLE_LINE;
        this.pending.clear();
        this.notify();
        return;
      }
      if (message === undefined) return this.lose("Ardia sent a line that isn't JSON");
      const id = field(message, "id");
      const request = typeof id === "bigint" ? this.pending.get(id) : undefined;
      if (request === undefined || typeof id !== "bigint") {
        this.queueEvent(message, line);
        continue;
      }
      this.pending.delete(id);
      request.reply = message;
      this.notify();
    }
    if (this.buffer.length > MAX_LINE_BYTES + 2) this.lose("Ardia sent a line longer than 1 MB");
  }

  private queueEvent(message: Value, line: Buffer): void {
    if (!(message instanceof Map) || typeof message.get("decide") === "string" || typeof message.get("event") !== "string") return;
    const raw = LOSSY_UTF8.decode(line).replace(/\n+$/, "");
    const size = line.length + raw.length * 2 + retainedSize(message);
    while (this.events.length > 0 && (this.events.length >= EVENT_QUEUE_CAP || this.eventBytes + size > EVENT_QUEUE_BYTES)) {
      this.eventBytes -= (this.events.shift() as Queued).size;
      this.dropped += 1;
    }
    this.events.push({ message, raw, size });
    this.eventBytes += size;
    this.notify();
  }

  takeDropped(): number {
    const dropped = this.dropped;
    this.dropped = 0;
    return dropped;
  }

  async nextEvent(): Promise<EventLine> {
    for (;;) {
      const queued = this.events.shift();
      if (queued !== undefined) {
        this.eventBytes -= queued.size;
        return { message: queued.message, raw: queued.raw };
      }
      if (this.lost !== undefined) throw new Stop(this.lost, "closed");
      if (this.readerStopped) throw new Stop(UNREADABLE_LINE, "closed");
      await this.until(() => this.events.length > 0 || this.lost !== undefined || this.readerStopped, undefined);
    }
  }

  private socketOpen(): boolean {
    return !this.socket.destroyed && (this.socket as unknown as { _handle?: { fd?: number } })._handle?.fd === this.fd;
  }

  private pump(): void {
    this.pumpTimer = undefined;
    while (this.unsent.length > 0 && this.writeFailure === undefined) {
      if (!this.socketOpen()) {
        this.writeFailure = `the connection broke (${strerror(EPIPE)})`;
        this.unsent = [];
        this.unsentBytes = 0;
        this.lose(this.writeFailure);
        break;
      }
      const head = this.unsent[0] as Buffer;
      let written: number;
      try {
        written = writeSync(this.fd, head);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (EAGAIN.has(code)) break;
        if (code === "EINTR") continue;
        this.writeFailure = `the connection broke (${strerror(errnoOf(error))})`;
        this.unsent = [];
        this.unsentBytes = 0;
        this.lose(this.writeFailure);
        this.notify();
        return;
      }
      this.unsentBytes -= written;
      if (written === head.length) this.unsent.shift();
      else this.unsent[0] = head.subarray(written);
    }
    if (this.unsent.length > 0 && this.writeFailure === undefined) this.pumpTimer = setTimeout(() => this.pump(), RETRY_WRITE_MS);
    this.notify();
  }

  private send(line: Buffer): void {
    if (this.writeFailure !== undefined || this.lost !== undefined) throw new Stop("the connection broke (Connection lost)", "lost");
    this.unsent.push(line);
    this.unsentBytes += line.length;
    if (this.pumpTimer === undefined) this.pump();
  }

  private async drain(deadline: number): Promise<boolean> {
    if (this.writeFailure !== undefined) throw new Stop("the connection broke (Connection lost)", "lost");
    if (this.unsentBytes <= HIGH_WATER) return true;
    const drained = await this.until(() => this.writeFailure !== undefined || this.unsentBytes <= LOW_WATER, deadline);
    if (this.writeFailure !== undefined) throw new Stop(this.writeFailure, "lost");
    return drained;
  }

  private async until(done: () => boolean, deadline: number | undefined): Promise<boolean> {
    for (;;) {
      if (done()) return true;
      if (this.interrupted()) throw new Stop("interrupted", "interrupted");
      const left = deadline === undefined ? POLL_MS : deadline - performance.now();
      if (left <= 0) return false;
      let finish: () => void = () => {};
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => finish(), Math.max(1, Math.min(left, POLL_MS)));
        finish = () => {
          clearTimeout(timer);
          resolve();
        };
        this.waiters.add(finish);
        this.onWake(this.wakeOnInterrupt);
      });
      this.waiters.delete(finish);
      if (this.waiters.size === 0) this.onWake(undefined);
    }
  }

  async request(method: string, params: Value | undefined, timeout: number): Promise<Value> {
    if (this.lost !== undefined) throw new Stop(this.lost, "closed");
    if (this.readerStopped) throw new Stop(UNREADABLE_LINE, "lost");
    this.nextId += 1n;
    const ident = this.nextId;
    const request = object([
      ["id", ident],
      ["method", method],
    ]);
    if (params !== undefined) request.set("params", params);
    const line = utf8(`${dumps(request, "compact")}\n`);
    if (line.length > MAX_LINE_BYTES) throw new Stop("the request is longer than 1 MB", "too_long");
    const waiting: Pending = {};
    const deadline = performance.now() + timeout * 1000;
    const timedOut = () => {
      this.pending.delete(ident);
      this.close();
      return new Stop(`Ardia didn't answer ${method} in ${formatG(timeout)} s`, "timeout");
    };
    this.pending.set(ident, waiting);
    let drained: boolean;
    try {
      this.send(line);
      drained = await this.drain(deadline);
    } catch (error) {
      this.pending.delete(ident);
      throw error;
    }
    if (!drained) throw timedOut();
    await this.until(() => waiting.reply !== undefined || waiting.lost !== undefined, deadline);
    if (waiting.reply !== undefined) return waiting.reply;
    if (waiting.lost !== undefined) throw new Stop(waiting.lost, "lost");
    throw timedOut();
  }

  close(): void {
    if (this.pumpTimer !== undefined) clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    this.unsent = [];
    this.unsentBytes = 0;
    this.socket.destroy();
  }
}
