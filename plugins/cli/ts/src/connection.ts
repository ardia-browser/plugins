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
const LOSSY_UTF8 = new TextDecoder("utf-8", { fatal: false });

type Pending = { reply?: Value; lost?: string };

export type EventLine = { message: Value; raw: string };

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
  private wake: (() => void) | undefined;
  private events: EventLine[] = [];
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
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private lose(reason: string): void {
    if (this.lost !== undefined || this.readerStopped) return;
    this.lost = reason;
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
    if (this.events.length >= EVENT_QUEUE_CAP) {
      this.events.shift();
      this.dropped += 1;
    }
    this.events.push({ message, raw: LOSSY_UTF8.decode(line).replace(/\n+$/, "") });
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
      if (queued !== undefined) return queued;
      if (this.lost !== undefined) throw new Stop(this.lost, "closed");
      await this.until(() => this.events.length > 0 || this.lost !== undefined, undefined);
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

  private async drain(): Promise<void> {
    if (this.writeFailure !== undefined) throw new Stop("the connection broke (Connection lost)", "lost");
    if (this.unsentBytes <= HIGH_WATER) return;
    await this.until(() => this.writeFailure !== undefined || this.unsentBytes <= LOW_WATER, undefined);
    if (this.writeFailure !== undefined) throw new Stop(this.writeFailure, "lost");
  }

  private async until(done: () => boolean, deadline: number | undefined): Promise<boolean> {
    for (;;) {
      if (done()) return true;
      if (this.interrupted()) throw new Stop("interrupted", "interrupted");
      const left = deadline === undefined ? POLL_MS : deadline - performance.now();
      if (left <= 0) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(1, Math.min(left, POLL_MS)));
        const finish = () => {
          clearTimeout(timer);
          resolve();
        };
        this.wake = finish;
        this.onWake(finish);
      });
      this.wake = undefined;
      this.onWake(undefined);
    }
  }

  async request(method: string, params: Value | undefined, timeout: number): Promise<Value> {
    if (this.lost !== undefined) throw new Stop(this.lost, "closed");
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
    this.pending.set(ident, waiting);
    try {
      this.send(line);
      await this.drain();
    } catch (error) {
      this.pending.delete(ident);
      throw error;
    }
    const answered = await this.until(() => waiting.reply !== undefined || waiting.lost !== undefined, performance.now() + timeout * 1000);
    if (waiting.reply !== undefined) return waiting.reply;
    if (waiting.lost !== undefined) throw new Stop(waiting.lost, "lost");
    if (!answered) this.pending.delete(ident);
    throw new Stop(`Ardia didn't answer ${method} in ${formatG(timeout)} s`, "timeout");
  }

  close(): void {
    if (this.pumpTimer !== undefined) clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    this.socket.destroy();
  }
}
