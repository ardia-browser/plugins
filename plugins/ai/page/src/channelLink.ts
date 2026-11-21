import { Assembler, CALL_TIMEOUT_MS, LOST_MS, PAGE_TO_HELPER_LIMIT, PING_MS, SENDS_PER_SECOND, split, type Frame } from "../../runtime/src/frames.ts";

export { Assembler, HELPER_TO_PAGE_LIMIT, PAGE_TO_HELPER_LIMIT, SENDS_PER_SECOND, split, type Frame } from "../../runtime/src/frames.ts";

export type ArdiaBridge = {
  send(value: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
};

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> | null; cleanup: (() => void) | null };
type Stream = { method: string; payload: unknown; onItem(item: unknown): void; onEnd(error: unknown): void };

export type LinkTimers = {
  now(): number;
  setTimeout(run: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  setInterval(run: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
};

const realTimers: LinkTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer),
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (timer) => clearInterval(timer),
};

export function newInstanceId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class ChannelLink {
  readonly instance: string;
  private nextId = 1;
  private nextPart = 1;
  private readonly calls = new Map<number, Pending>();
  private readonly streams = new Map<number, Stream>();
  private readonly assembler = new Assembler();
  private readonly queue: Frame[] = [];
  private sentAt: number[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private lastPong: number;
  private healthy = true;
  private readonly healthListeners = new Set<(healthy: boolean) => void>();
  private readonly listener = (event: { data: unknown }) => this.receive(event.data);
  private readonly bridge: ArdiaBridge;
  private readonly timers: LinkTimers;

  constructor(bridge: ArdiaBridge, timers: LinkTimers = realTimers, instance = newInstanceId()) {
    this.bridge = bridge;
    this.timers = timers;
    this.instance = instance;
    this.lastPong = timers.now();
    bridge.addEventListener("message", this.listener);
    this.pinger = timers.setInterval(() => this.ping(), PING_MS);
    this.ping();
  }

  onHealth(listener: (healthy: boolean) => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  get isHealthy() {
    return this.healthy;
  }

  close() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    if (this.pinger) this.timers.clearInterval(this.pinger);
    this.timer = null;
    this.pinger = null;
    this.queue.length = 0;
    this.bridge.removeEventListener?.("message", this.listener);
    for (const p of this.calls.values()) {
      if (p.timer) this.timers.clearTimeout(p.timer);
      p.cleanup?.();
      p.reject(new Error("The assistant's page link closed."));
    }
    for (const s of this.streams.values()) s.onEnd(new Error("closed"));
    this.calls.clear();
    this.streams.clear();
    this.healthListeners.clear();
  }

  call(method: string, payload: unknown): Promise<unknown> {
    const id = this.nextId++;
    return this.pending(id, CALL_TIMEOUT_MS, () => this.enqueue({ t: "call", p: this.instance, id, method, payload }));
  }

  api(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error("aborted"));
    const id = this.nextId++;
    const onAbort = () => {
      const waiting = this.calls.get(id);
      if (!waiting) return;
      this.calls.delete(id);
      if (waiting.timer) this.timers.clearTimeout(waiting.timer);
      waiting.cleanup?.();
      this.enqueue({ t: "cancel", p: this.instance, id });
      waiting.reject(new Error("aborted"));
    };
    const cleanup = signal ? () => signal.removeEventListener("abort", onAbort) : null;
    signal?.addEventListener("abort", onAbort, { once: true });
    return this.pending(
      id,
      CALL_TIMEOUT_MS,
      () => this.enqueue(body === undefined ? { t: "api", p: this.instance, id, method, path } : { t: "api", p: this.instance, id, method, path, body }),
      cleanup,
    );
  }

  stream(method: string, payload: unknown, onItem: (item: unknown) => void, onEnd: (error: unknown) => void): () => void {
    const id = this.nextId++;
    this.streams.set(id, { method, payload, onItem, onEnd });
    this.enqueue({ t: "stream", p: this.instance, id, method, payload });
    return () => {
      if (!this.streams.delete(id)) return;
      this.enqueue({ t: "cancel", p: this.instance, id });
    };
  }

  open(url: string) {
    this.enqueue({ t: "open", p: this.instance, url });
  }

  private pending(id: number, timeoutMs: number, send: () => void, cleanup: (() => void) | null = null): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        if (!this.calls.delete(id)) return;
        cleanup?.();
        reject(new Error("The assistant didn't answer in time."));
      }, timeoutMs);
      this.calls.set(id, { resolve, reject, timer, cleanup });
      send();
    });
  }

  private ping() {
    if (this.timers.now() - this.lastPong > LOST_MS) this.setHealthy(false);
    this.enqueue({ t: "ping", p: this.instance });
  }

  private setHealthy(healthy: boolean) {
    if (this.healthy === healthy) return;
    this.healthy = healthy;
    for (const listener of this.healthListeners) listener(healthy);
  }

  private resubscribe() {
    for (const [id, s] of this.streams) this.enqueue({ t: "stream", p: this.instance, id, method: s.method, payload: s.payload });
  }

  private enqueue(frame: Frame) {
    this.queue.push(...split(frame, PAGE_TO_HELPER_LIMIT, () => `${this.instance}-${this.nextPart++}`));
    this.drain();
  }

  private drain() {
    if (this.timer) return;
    while (this.queue.length) {
      const now = this.timers.now();
      this.sentAt = this.sentAt.filter((t) => now - t < 1000);
      if (this.sentAt.length >= SENDS_PER_SECOND) {
        this.timer = this.timers.setTimeout(() => {
          this.timer = null;
          this.drain();
        }, 1000 - (now - this.sentAt[0]!));
        return;
      }
      this.sentAt.push(now);
      this.bridge.send(this.queue.shift());
    }
  }

  private receive(data: unknown) {
    if (!data || typeof data !== "object" || typeof (data as { t?: unknown }).t !== "string" || (data as { p?: unknown }).p !== this.instance) return;
    const frame = this.assembler.take(data as Frame);
    if (!frame || frame.p !== this.instance) return;
    if (frame.t === "pong") {
      this.lastPong = this.timers.now();
      this.setHealthy(true);
      if (frame.moved) this.resubscribe();
    } else if (frame.t === "result") {
      const pending = this.calls.get(frame.id);
      if (!pending) return;
      this.calls.delete(frame.id);
      if (pending.timer) this.timers.clearTimeout(pending.timer);
      pending.cleanup?.();
      if (frame.ok) pending.resolve(frame.value);
      else pending.reject(new Error(frame.error ?? "The assistant refused that."));
    } else if (frame.t === "items") {
      const stream = this.streams.get(frame.id);
      if (stream) for (const item of frame.items) stream.onItem(item);
    } else if (frame.t === "end") {
      const stream = this.streams.get(frame.id);
      if (!stream) return;
      this.streams.delete(frame.id);
      stream.onEnd(frame.error ? new Error(frame.error) : null);
    }
  }
}

export function ardiaBridge(): ArdiaBridge | null {
  const bridge = (globalThis as { ardia?: Partial<ArdiaBridge> }).ardia;
  return bridge && typeof bridge.send === "function" && typeof bridge.addEventListener === "function" ? (bridge as ArdiaBridge) : null;
}
