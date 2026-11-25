// @effect-diagnostics globalTimers:off globalDate:off
import type { SelfClient } from "./selfClient.ts";
import { Assembler, HELPER_TO_PAGE_LIMIT, INSTANCE, sentSize, split, type Frame } from "./frames.ts";

export const PAGE_CALLS = new Set([
  "orchestration.dispatchCommand",
  "orchestration.getThreadProjection",
  "orchestration.launchThread",
  "projects.mutate",
  "server.getConfig",
  "server.refreshProviders",
]);
export const PAGE_STREAMS = new Set(["orchestration.subscribeShell", "orchestration.subscribeThread"]);
export const OUTBOX_BYTES = 4 * 1024 * 1024;
export const INSTANCE_IDLE_MS = 60_000;
export const FORGOTTEN_LIMIT = 1_000;
const BACKOFF_FIRST_MS = 100;
const BACKOFF_MAX_MS = 2_000;
const BATCH_MS = 16;
const MAX_STREAMS = 32;

export type Posted = "ok" | "overloaded" | "gone";


export type BridgeDeps = {
  rpc: SelfClient;
  api: (method: "GET" | "POST", path: string, body: unknown, signal: AbortSignal) => Promise<{ status: number; body: unknown }>;
  open: (url: string) => Promise<void>;
  post: (message: unknown, view: string) => Promise<Posted>;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
};

type Instance = {
  id: string;
  view: string;
  moved: boolean;
  lastSeen: number;
  streams: Map<number, () => void>;
  apis: Map<number, AbortController>;
  batches: Map<number, unknown[]>;
  batchTimer: ReturnType<typeof setTimeout> | null;
  outbox: { frame: Frame; bytes: number }[];
  outboxBytes: number;
  pumping: boolean;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : typeof error === "string" ? error : "The assistant's runtime failed.").slice(0, 2000);

function frameOf(data: unknown): Frame | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const f = data as { t?: unknown; p?: unknown; id?: unknown };
  if (typeof f.t !== "string" || typeof f.p !== "string" || !INSTANCE.test(f.p)) return null;
  return data as Frame;
}

export class PageBridge {
  private readonly instances = new Map<string, Instance>();
  private readonly forgotten = new Set<string>();
  private readonly assembler = new Assembler();
  private readonly deps: BridgeDeps;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.wait = deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get instanceCount() {
    return this.instances.size;
  }

  receive(data: unknown, view: string) {
    if (typeof view !== "string" || !view) return;
    this.forgetIdle();
    const raw = frameOf(data);
    if (!raw) return;
    const instance = this.instanceFor(raw.p, view);
    const frame = this.assembler.take(raw);
    if (!frame || frame.p !== instance.id) return;
    switch (frame.t) {
      case "ping":
        this.send(instance, { t: "pong", p: instance.id, moved: instance.moved });
        instance.moved = false;
        return;
      case "call":
        return void this.answerCall(instance, frame.id, frame.method, frame.payload);
      case "stream":
        return this.startStream(instance, frame.id, frame.method, frame.payload);
      case "cancel": {
        instance.streams.get(frame.id)?.();
        instance.streams.delete(frame.id);
        instance.batches.delete(frame.id);
        instance.apis.get(frame.id)?.abort();
        instance.apis.delete(frame.id);
        return;
      }
      case "api":
        return void this.answerApi(instance, frame.id, frame.method, frame.path, frame.body);
      case "open":
        if (typeof frame.url === "string") void this.deps.open(frame.url).catch(() => undefined);
        return;
    }
  }

  close() {
    for (const instance of this.instances.values()) this.forget(instance);
    this.instances.clear();
  }

  private instanceFor(id: string, view: string): Instance {
    let instance = this.instances.get(id);
    if (!instance) {
      const moved = this.forgotten.delete(id);
      instance = { id, view, moved, lastSeen: this.now(), streams: new Map(), apis: new Map(), batches: new Map(), batchTimer: null, outbox: [], outboxBytes: 0, pumping: false };
      this.instances.set(id, instance);
      return instance;
    }
    instance.lastSeen = this.now();
    if (instance.view !== view) {
      instance.view = view;
      this.resync(instance);
    }
    return instance;
  }

  private resync(instance: Instance) {
    for (const stop of instance.streams.values()) stop();
    instance.streams.clear();
    instance.batches.clear();
    instance.outbox = [];
    instance.outboxBytes = 0;
    instance.moved = true;
  }

  private forget(instance: Instance) {
    for (const stop of instance.streams.values()) stop();
    for (const controller of instance.apis.values()) controller.abort();
    if (instance.batchTimer) clearTimeout(instance.batchTimer);
    instance.streams.clear();
    instance.apis.clear();
    instance.outbox = [];
    this.assembler.drop(instance.id);
  }

  private forgetIdle() {
    const now = this.now();
    for (const [id, instance] of this.instances) {
      if (now - instance.lastSeen <= INSTANCE_IDLE_MS) continue;
      this.forget(instance);
      this.instances.delete(id);
      this.forgotten.add(id);
      if (this.forgotten.size > FORGOTTEN_LIMIT) this.forgotten.delete(this.forgotten.values().next().value!);
    }
  }

  private async answerCall(instance: Instance, id: number, method: string, payload: unknown) {
    if (!Number.isInteger(id)) return;
    if (typeof method !== "string" || !PAGE_CALLS.has(method)) return this.send(instance, { t: "result", p: instance.id, id, ok: false, error: `The page can't call ${String(method).slice(0, 80)}.` });
    try {
      const value = await this.deps.rpc.call(method, payload);
      this.send(instance, { t: "result", p: instance.id, id, ok: true, value });
    } catch (error) {
      this.send(instance, { t: "result", p: instance.id, id, ok: false, error: errorText(error) });
    }
  }

  private async answerApi(instance: Instance, id: number, method: "GET" | "POST", path: string, body: unknown) {
    if (!Number.isInteger(id)) return;
    if ((method !== "GET" && method !== "POST") || typeof path !== "string" || !path.startsWith("/ardia/") || path.length > 2048)
      return this.send(instance, { t: "result", p: instance.id, id, ok: false, error: "Bad request." });
    const controller = new AbortController();
    instance.apis.set(id, controller);
    try {
      const reply = await this.deps.api(method, path, body, controller.signal);
      if (controller.signal.aborted) return;
      const error = reply.status >= 400 ? String((reply.body as { error?: unknown } | null)?.error ?? `The assistant answered ${reply.status}.`) : undefined;
      this.send(instance, error === undefined ? { t: "result", p: instance.id, id, ok: true, value: reply.body } : { t: "result", p: instance.id, id, ok: false, error });
    } catch (error) {
      if (!controller.signal.aborted) this.send(instance, { t: "result", p: instance.id, id, ok: false, error: errorText(error) });
    } finally {
      instance.apis.delete(id);
    }
  }

  private startStream(instance: Instance, id: number, method: string, payload: unknown) {
    if (!Number.isInteger(id)) return;
    if (typeof method !== "string" || !PAGE_STREAMS.has(method)) return this.send(instance, { t: "end", p: instance.id, id, error: `The page can't subscribe to ${String(method).slice(0, 80)}.` });
    instance.streams.get(id)?.();
    if (!instance.streams.has(id) && instance.streams.size >= MAX_STREAMS) return this.send(instance, { t: "end", p: instance.id, id, error: "Too many subscriptions from this page." });
    const stop = this.deps.rpc.stream(
      method,
      payload,
      (item) => this.queueItem(instance, id, item),
      (error) => {
        if (instance.streams.get(id) !== stop) return;
        this.flushBatches(instance);
        instance.streams.delete(id);
        this.send(instance, error ? { t: "end", p: instance.id, id, error: errorText(error) } : { t: "end", p: instance.id, id });
      },
    );
    instance.streams.set(id, stop);
  }

  private queueItem(instance: Instance, id: number, item: unknown) {
    if (!instance.streams.has(id)) return;
    const batch = instance.batches.get(id) ?? [];
    batch.push(item);
    instance.batches.set(id, batch);
    instance.batchTimer ??= setTimeout(() => {
      instance.batchTimer = null;
      this.flushBatches(instance);
    }, BATCH_MS);
  }

  private flushBatches(instance: Instance) {
    if (instance.batchTimer) clearTimeout(instance.batchTimer);
    instance.batchTimer = null;
    const batches = [...instance.batches];
    instance.batches.clear();
    for (const [id, items] of batches) if (items.length && instance.streams.has(id)) this.send(instance, { t: "items", p: instance.id, id, items });
  }

  private send(instance: Instance, frame: Frame) {
    let n = 0;
    for (const part of split(frame, HELPER_TO_PAGE_LIMIT, () => `${instance.id}-h${++n}-${this.now()}`)) {
      const bytes = sentSize(part);
      instance.outbox.push({ frame: part, bytes });
      instance.outboxBytes += bytes;
    }
    if (instance.outboxBytes > OUTBOX_BYTES) {
      this.resync(instance);
      return;
    }
    void this.pump(instance);
  }

  private async pump(instance: Instance) {
    if (instance.pumping) return;
    instance.pumping = true;
    let backoff = BACKOFF_FIRST_MS;
    try {
      while (instance.outbox.length && this.instances.get(instance.id) === instance) {
        const next = instance.outbox[0]!;
        const view = instance.view;
        const posted = await this.deps.post(next.frame, view).catch((): Posted => "gone");
        if (instance.view !== view) continue;
        if (posted === "ok") {
          if (instance.outbox[0] === next) {
            instance.outbox.shift();
            instance.outboxBytes -= next.bytes;
          }
          backoff = BACKOFF_FIRST_MS;
        } else if (posted === "overloaded") {
          await this.wait(backoff);
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        } else {
          this.resync(instance);
          break;
        }
      }
    } finally {
      instance.pumping = false;
    }
  }
}
