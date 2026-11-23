import { Cancelled } from "../cdp/cancel.ts";

export type Keys = () => readonly string[] | null;
export type Release = () => void;

type Waiter = {
  exclusive: boolean;
  keys: Keys;
  settled: boolean;
  deadline: number;
  grant: (taken: readonly string[] | null) => void;
  expire: (pumpAfter: boolean) => void;
};

export type Grant = { release: Release; parallel: boolean };

export class TabScheduler {
  private exclusiveHeld = false;
  private readonly held = new Map<string, number>();
  private sharedCount = 0;
  private readersCount = 0;
  private readonly waiters: Waiter[] = [];

  get locked(): boolean {
    return this.exclusiveHeld || this.sharedCount > 0;
  }

  get exclusive(): boolean {
    return this.exclusiveHeld;
  }

  get shared(): number {
    return this.sharedCount;
  }

  get readers(): number {
    return this.readersCount;
  }

  get queued(): number {
    return this.waiters.length;
  }

  holds(key: string): boolean {
    return this.held.has(key);
  }

  acquire(timeoutSeconds: number | null = null, signal: AbortSignal | null = null): Promise<boolean> {
    return this.wait(true, () => null, timeoutSeconds, signal).then((granted) => granted !== null);
  }

  release(): void {
    if (!this.exclusiveHeld) throw new Error("Lock is not acquired.");
    this.exclusiveHeld = false;
    this.pump();
  }

  async enter(keys: Keys, timeoutSeconds: number | null = null, signal: AbortSignal | null = null): Promise<Grant | null> {
    const granted = await this.wait(false, keys, timeoutSeconds, signal);
    if (granted === null) return null;
    if (granted.taken === null) return { release: () => this.release(), parallel: false };
    const taken = granted.taken;
    let released = false;
    return {
      parallel: granted.parallel || this.readersCount > 0,
      release: () => {
        if (released) return;
        released = true;
        this.sharedCount -= 1;
        for (const key of taken) {
          const left = (this.held.get(key) ?? 1) - 1;
          if (left <= 0) this.held.delete(key);
          else this.held.set(key, left);
        }
        this.pump();
      },
    };
  }

  async read<T>(work: () => Promise<T>): Promise<T> {
    this.readersCount += 1;
    try {
      return await work();
    } finally {
      this.readersCount -= 1;
    }
  }

  private wait(exclusive: boolean, keys: Keys, timeoutSeconds: number | null, signal: AbortSignal | null): Promise<{ taken: readonly string[] | null; parallel: boolean } | null> {
    if (signal?.aborted) return Promise.reject(new Cancelled());
    if (this.waiters.length === 0) {
      const now = this.tryGrant(exclusive, keys, new Set());
      if (now !== undefined) return Promise.resolve(now);
    }
    if (timeoutSeconds !== null && timeoutSeconds <= 0) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const leave = () => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
      };
      const aborted = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        leave();
        reject(new Cancelled());
        this.pump();
      };
      const waiter: Waiter = {
        exclusive,
        keys,
        settled: false,
        deadline: timeoutSeconds === null ? Number.POSITIVE_INFINITY : performance.now() + timeoutSeconds * 1000,
        grant: (taken) => {
          waiter.settled = true;
          leave();
          resolve({ taken, parallel: taken !== null && this.sharedCount > 1 });
        },
        expire: (pumpAfter) => {
          if (waiter.settled) return;
          waiter.settled = true;
          leave();
          resolve(null);
          if (pumpAfter) this.pump();
        },
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", aborted, { once: true });
      if (timeoutSeconds !== null) timer = setTimeout(() => waiter.expire(true), timeoutSeconds * 1000);
      this.pump();
    });
  }

  private tryGrant(exclusive: boolean, keys: Keys, ahead: ReadonlySet<string>): { taken: readonly string[] | null; parallel: boolean } | undefined {
    const wanted = exclusive ? null : keys();
    if (wanted === null) {
      if (this.exclusiveHeld || this.sharedCount > 0 || ahead.size > 0) return undefined;
      this.exclusiveHeld = true;
      return { taken: null, parallel: false };
    }
    if (this.exclusiveHeld || wanted.some((key) => this.held.has(key) || ahead.has(key))) return undefined;
    this.sharedCount += 1;
    for (const key of wanted) this.held.set(key, (this.held.get(key) ?? 0) + 1);
    return { taken: [...wanted], parallel: this.sharedCount > 1 };
  }

  private pump(): void {
    const ahead = new Set<string>();
    for (const waiter of [...this.waiters]) {
      if (waiter.settled) continue;
      if (performance.now() >= waiter.deadline) {
        waiter.expire(false);
        continue;
      }
      const wanted = waiter.exclusive ? null : waiter.keys();
      if (wanted === null) {
        const granted = this.tryGrant(true, () => null, ahead);
        if (granted !== undefined) waiter.grant(null);
        return;
      }
      const granted = this.tryGrant(false, () => wanted, ahead);
      if (granted !== undefined) waiter.grant(granted.taken);
      else for (const key of wanted) ahead.add(key);
    }
  }
}
