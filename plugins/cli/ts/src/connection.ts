import type { Socket } from "node:net";
import { dumps, field, object, parse, type Value } from "./json.ts";
import { errnoOf, strerror } from "./paths.ts";
import { MAX_LINE_BYTES } from "./protocol.ts";

const POLL_MS = 100;

type Pending = { reply?: Value; lost?: string };

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
  private pending = new Map<bigint, Pending>();
  private wake: (() => void) | undefined;

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
    if (this.lost !== undefined) return;
    this.lost = reason;
    for (const request of this.pending.values()) request.lost ??= reason;
    this.pending.clear();
    this.notify();
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
      const message = parse(line);
      if (message === undefined) return this.lose("Ardia sent a line that isn't JSON");
      const id = field(message, "id");
      if (typeof id !== "bigint") continue;
      const request = this.pending.get(id);
      if (request === undefined) continue;
      this.pending.delete(id);
      request.reply = message;
      this.notify();
    }
    if (this.buffer.length > MAX_LINE_BYTES + 2) this.lose("Ardia sent a line longer than 1 MB");
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
    const line = Buffer.from(`${dumps(request, "compact")}\n`, "utf8");
    if (line.length > MAX_LINE_BYTES) throw new Stop("the request is longer than 1 MB", "too_long");
    const waiting: Pending = {};
    this.pending.set(ident, waiting);
    this.socket.write(line);
    const answered = await this.until(() => waiting.reply !== undefined || waiting.lost !== undefined, performance.now() + timeout * 1000);
    if (waiting.reply !== undefined) return waiting.reply;
    if (waiting.lost !== undefined) throw new Stop(waiting.lost, "lost");
    if (!answered) this.pending.delete(ident);
    throw new Stop(`Ardia didn't answer ${method} in ${timeout} s`, "timeout");
  }

  close(): void {
    this.socket.destroy();
  }
}
